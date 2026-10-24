import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Clipboard History + Paste Stack (feature id "clipboard", like src/main/features/clipboard). Session N2.
///
/// - Capture: `PasteboardWatching` (changeCount poll every 0.4 s on a background queue; fake in headless mode):
///   text (with HTML/RTF), links, colors, files, images (PNG + ≤256 px thumbnail, OCR text via `services.ocr`).
///   Concealed/transient types, ignored apps (frontmost bundle id), pause / timed pause are skipped.
/// - Data: <userData>/features/clipboard/{history.json, stack.json, images/} in the Electron format.
/// - Paste Stack: while items wait, the shared keyboard tap turns a plain ⌘V into "paste next" (KeyboardTapComposer
///   part "clipboard"); the tap's 500 ms watchdog lets the original ⌘V through, and an empty/off stack never
///   intercepts.
@MainActor public final class ClipboardFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "clipboard"
    public let title = "Clipboard History"

    weak var context: FeatureContext?
    private(set) var settings = ClipSettings()
    private(set) var entries: [ClipEntry] = []
    private(set) var stack = PasteStack()
    var storage: ClipStorage?
    var watcher: (any PasteboardWatching)?
    private var composer: KeyboardTapComposer?
    private var hayCache: [String: String] = [:]
    private var saveTask: Task<Void, Never>?
    private var pauseTask: Task<Void, Never>?
    var ocrQueue: [String] = []
    private var ocrTried = Set<String>()
    var ocrBusy = false
    var ocrQueueIdle: Bool { ocrQueue.isEmpty && !ocrBusy }
    /// Headless tests: source app reported for the next capture.
    var debugSource: SourceApp?
    private(set) var hotkeyOk = true
    private(set) var stackHotkeyOk = true
    /// Bumped on every data change (views observe it).
    let changes = ClipChanges()
    lazy var history = ClipHistoryModel(feature: self)
    lazy var stackModel = ClipStackModel(feature: self)
    lazy var editModel = ClipEditModel(feature: self)

    static let pollInterval: TimeInterval = 0.4
    static let maxText = 5 * 1024 * 1024
    static let maxRTF = 2 * 1024 * 1024

    public init() {}

    var now: Double { Date().timeIntervalSince1970 * 1000 }
    var isHeadless: Bool { context?.services.isHeadless ?? true }

    // MARK: lifecycle

    public func start(context: FeatureContext) async {
        self.context = context
        settings = ClipSettings(bag: context.settings(defaults: ClipSettings.defaultsBag))
        let st = ClipStorage(directory: context.dataDirectory())
        storage = st
        entries = st.loadHistory()
        stack = st.loadStack() ?? PasteStack(order: settings.stackOrder)
        applyRetention()
        registerHotkeys()
        schedulePauseEnd()
        let w = PasteboardWatcherFactory.watcher(for: context.services)
        watcher = w
        w.onChange = { [weak self] snap in
            self?.capture(snap)
            PasteboardChangeObservers.notify(snap) // phone-relay: iPhone clipboard mirror follows the same watcher
        }
        let c = KeyboardTapComposer.shared(for: context.services)
        composer = c
        c.subscribe(id) { [weak self] e in
            if case let .stackNext(reqId) = e { self?.answerStackPaste(reqId: reqId) }
        }
        updateTap()
        if settings.enabled { w.start(interval: Self.pollInterval) }
        // Backfill OCR for images captured before OCR existed.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self else { return }
            for e in self.entries.filter({ $0.type == .image && $0.ocrText == nil }).prefix(50) { self.queueOCR(e.id) }
        }
    }

    public func stop() async {
        watcher?.stop()
        pauseTask?.cancel()
        flush()
        sendIntercept(false)
        composer?.subscribe(id, nil)
    }

    // MARK: persistence

    func changed(history: Bool = true) {
        if history { scheduleSave() }
        changes.bump()
        context?.refreshCatalogue()
    }

    private func scheduleSave() {
        guard saveTask == nil else { return }
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            self?.flush()
        }
    }

    func flush() {
        saveTask?.cancel()
        saveTask = nil
        do { try storage?.saveHistory(entries) } catch { context?.log("could not save history: \(error.localizedDescription)") }
    }

    func saveStack() {
        do { try storage?.saveStack(stack) } catch { context?.log("could not save paste stack: \(error.localizedDescription)") }
        updateTap()
        changes.bump()
        context?.refreshCatalogue()
    }

    private func updateTap() {
        sendIntercept(settings.stackInterceptPaste && stack.interceptsPaste)
    }

    /// The Keyboard feature owns the tap config; we only contribute the ⌘V intercept flag (sent when it changes).
    private(set) var sentIntercept: Bool?
    private func sendIntercept(_ on: Bool) {
        guard on != sentIntercept, let ctx = context else { return }
        sentIntercept = on
        Task { _ = try? await ctx.callFeature("keyboard", method: "setPasteStack", args: .bool(on)) }
    }

    func hay(_ e: ClipEntry) -> String {
        if let h = hayCache[e.id] { return h }
        let h = ClipModel.haystack(e)
        hayCache[e.id] = h
        return h
    }

    private func applyRetention() {
        let r = ClipModel.prune(entries, settings, now: now)
        guard !r.removed.isEmpty else { return }
        entries = r.kept
        forget(r.removed)
    }

    /// Drop caches, stack references and image files of removed entries (images may be shared, so check).
    private func forget(_ removed: [ClipEntry]) {
        var stackChanged = false
        for e in removed {
            hayCache[e.id] = nil
            if stack.items.contains(e.id) { stack = stack.removing(e.id); stackChanged = true }
            if let img = e.image, !entries.contains(where: { $0.image?.sha1 == img.sha1 }) { storage?.deleteImage(img.sha1) }
        }
        if stackChanged { saveStack() }
    }

    func entry(_ id: String?) -> ClipEntry? { id.flatMap { i in entries.first { $0.id == i } } }

    // MARK: capture

    func capture(_ snap: PasteboardSnapshot) {
        guard settings.enabled, !settings.isPaused(now: now) else { return }
        if ClipModel.isConcealed(snap.types) { return }
        let source: SourceApp? = debugSource ?? snap.source.map { SourceApp(name: $0.name, bundleId: $0.bundleId) }
        debugSource = nil
        if ClipModel.isIgnoredApp(source?.bundleId, settings.ignoredApps) { return }
        if !snap.files.isEmpty {
            insert(ClipCandidate(type: .file, key: "f:" + snap.files.joined(separator: "\n"), files: snap.files, source: source))
        } else if let text = snap.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= Self.maxText {
            let rtf = snap.rtf.flatMap { $0.count <= Self.maxRTF ? $0.base64EncodedString() : nil }
            let html = snap.html.flatMap { $0.utf8.count <= Self.maxRTF ? $0 : nil }
            insert(ClipCandidate(type: ClipModel.classifyText(text), key: ClipStorage.textKey(text), text: text, html: html, rtf: rtf, source: source))
        } else if let hex = snap.color {
            insert(ClipCandidate(type: .color, key: ClipStorage.textKey(hex), text: hex, source: source))
        } else if let png = snap.png, let storage {
            Task { [weak self] in
                let image = await Task.detached(priority: .utility) { storage.saveImage(png: png) }.value
                guard let self, let image else { return }
                self.insert(ClipCandidate(type: .image, key: "i:\(image.sha1)", image: image, source: source))
            }
        }
    }

    @discardableResult
    private func insert(_ c: ClipCandidate) -> ClipEntry {
        let r = ClipModel.upsert(entries, c, now: now, newId: { UUID().uuidString.lowercased() })
        entries = r.entries
        hayCache[r.entry.id] = nil
        applyRetention()
        changed()
        if stack.collecting {
            stack = stack.pushed(r.entry.id)
            saveStack()
            if !stack.collecting { context?.toast("Paste Stack ready: \(stack.items.count) \(stack.items.count == 1 ? "item" : "items")", style: .success) }
        }
        if r.entry.type == .image { queueOCR(r.entry.id) }
        return r.entry
    }

    // MARK: OCR (search inside images)

    func queueOCR(_ id: String) {
        guard settings.ocrImages, !ocrTried.contains(id), !ocrQueue.contains(id) else { return }
        ocrQueue.append(id)
        Task { await drainOCR() }
    }

    private func drainOCR() async {
        guard !ocrBusy, let ctx = context, let storage else { return }
        ocrBusy = true
        defer { ocrBusy = false }
        while !ocrQueue.isEmpty {
            let id = ocrQueue.removeFirst()
            ocrTried.insert(id)
            guard let e = entry(id), let img = e.image, e.ocrText == nil, settings.ocrImages else { continue }
            guard let r = try? await ctx.services.ocr.recognize(path: storage.imageURL(img.sha1).path, languages: [], fast: false, languageCorrection: true) else { continue }
            let text = r.lines.map(\.text).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if let i = entries.firstIndex(where: { $0.id == id }) {
                entries[i].ocrText = text
                hayCache[id] = nil
                changed()
            }
        }
    }

    // MARK: writing back

    func content(_ e: ClipEntry, plain: Bool) -> PasteboardContent {
        switch e.type {
        case .image:
            let png = e.image.flatMap { img in storage.flatMap { st in try? Data(contentsOf: st.imageURL(img.sha1)) } }
            return PasteboardContent(png: png)
        case .file:
            return plain ? PasteboardContent(text: (e.files ?? []).joined(separator: "\n")) : PasteboardContent(text: (e.files ?? []).joined(separator: "\n"), files: e.files ?? [])
        default:
            return plain ? PasteboardContent(text: e.text ?? "") : PasteboardContent(text: e.text ?? "", html: e.html, rtf: e.rtf.flatMap { Data(base64Encoded: $0) })
        }
    }

    /// Put an entry on the pasteboard (never re-captured) and move it to the top.
    func putOnClipboard(_ e: ClipEntry, plain: Bool) {
        watcher?.write(content(e, plain: plain))
        entries = ClipModel.touch(entries, id: e.id, now: now)
        changed()
    }

    func pasteEntry(_ e: ClipEntry, plain: Bool) -> ActionResult {
        // Non-activating panel: hiding it hands key focus back to the user's app, which is still active.
        context?.hideLauncher()
        watcher?.paste(content(e, plain: plain))
        entries = ClipModel.touch(entries, id: e.id, now: now)
        changed()
        return .hide(message: "Pasted")
    }

    func copyEntry(_ e: ClipEntry) -> ActionResult {
        putOnClipboard(e, plain: false)
        return .hide(message: "Copied to clipboard")
    }

    /// Text produced inside Glide (edited / merged) joins the history.
    @discardableResult
    func recordText(_ text: String) -> ClipEntry {
        insert(ClipCandidate(type: ClipModel.classifyText(text), key: ClipStorage.textKey(text), text: text, source: SourceApp(name: "Glide", bundleId: nil)))
    }

    // MARK: settings / pause

    func patchSettings(_ patch: [String: JSONValue]) {
        var bag = settings.bag
        bag.merge(patch) { $1 }
        let next = ClipSettings(bag: bag)
        let hotkeysChanged = next.hotkey != settings.hotkey || next.stackHotkey != settings.stackHotkey
        let orderChanged = next.stackOrder != stack.order
        settings = next
        context?.setSettings(next.bag)
        if hotkeysChanged { registerHotkeys() }
        if orderChanged { stack = stack.withOrder(next.stackOrder); saveStack() }
        schedulePauseEnd()
        if settings.enabled { watcher?.start(interval: Self.pollInterval) } else { watcher?.stop() }
        applyRetention()
        updateTap()
        changed()
    }

    func setPaused(_ paused: Bool) -> ActionResult {
        patchSettings(["paused": .bool(paused), "pausedUntil": 0])
        return .hide(message: paused ? "Clipboard history paused" : "Clipboard history resumed")
    }

    func pauseFor(minutes: Int) -> ActionResult {
        let m = max(1, minutes)
        patchSettings(["paused": false, "pausedUntil": .double(now + Double(m) * 60_000)])
        return .hide(message: "Clipboard history paused for \(m) minutes")
    }

    private func schedulePauseEnd() {
        pauseTask?.cancel()
        pauseTask = nil
        guard settings.pausedUntil > 0 else { return }
        let left = settings.pausedUntil - now
        if left <= 0 {
            settings.pausedUntil = 0
            context?.setSettings(["pausedUntil": 0])
            return
        }
        pauseTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(min(left, 2_000_000_000))))
            guard !Task.isCancelled, let self else { return }
            self.settings.pausedUntil = 0
            self.context?.setSettings(["pausedUntil": 0])
            self.changed(history: false)
        }
    }

    private func registerHotkeys() {
        guard let ctx = context else { return }
        hotkeyOk = ctx.registerHotkey(key: "open", accelerator: settings.hotkey.isEmpty ? nil : settings.hotkey) { [weak self] in
            self?.context?.push(ViewID(rawValue: "clipboard.history"), payload: Self.freshPayload())
        }
        stackHotkeyOk = ctx.registerHotkey(key: "stack-next", accelerator: settings.stackHotkey.isEmpty ? nil : settings.stackHotkey) { [weak self] in
            guard let self else { return }
            let r = self.pasteNextFromStack()
            if case let .error(m) = r { self.context?.toast(m, style: .error) }
        }
    }

    @discardableResult
    func clearHistory(keepPinned: Bool) -> Int {
        let removed = entries.filter { !keepPinned || !$0.pinned }
        entries = keepPinned ? entries.filter(\.pinned) : []
        forget(removed)
        changed()
        return removed.count
    }

    func togglePin(_ id: String) -> Bool {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return false }
        entries[i].pinned.toggle()
        changed()
        return entries[i].pinned
    }

    @discardableResult
    func delete(_ ids: [String]) -> Int {
        let set = Set(ids)
        let removed = entries.filter { set.contains($0.id) }
        guard !removed.isEmpty else { return 0 }
        entries.removeAll { set.contains($0.id) }
        forget(removed)
        changed()
        return removed.count
    }

    /// Replace a text entry's content. A clash with another entry's content merges into this one.
    @discardableResult
    func update(_ id: String, text: String) -> ClipEntry? {
        guard let i = entries.firstIndex(where: { $0.id == id }), !text.isEmpty, entries[i].type != .image, entries[i].type != .file else { return nil }
        let key = ClipStorage.textKey(text)
        let clash = entries.first { $0.key == key && $0.id != id }
        var next = entries[i]
        next.text = text
        next.key = key
        next.type = ClipModel.classifyText(text)
        next.html = nil
        next.rtf = nil
        next.pinned = next.pinned || (clash?.pinned ?? false)
        next.count += clash?.count ?? 0
        entries[i] = next
        if let clash { entries.removeAll { $0.id == clash.id }; forget([clash]) }
        hayCache[id] = nil
        changed()
        return next
    }

    /// Merge in copy order (oldest first), whatever order rows were marked in.
    func merge(_ ids: [String], separator: String = "\n") -> ClipEntry? {
        let picked = ids.compactMap(entry).sorted { $0.lastCopiedAt < $1.lastCopiedAt }
        guard let text = ClipModel.mergeTexts(picked, separator: separator) else { return nil }
        return recordText(text)
    }

    func saveAsSnippet(_ id: String, name: String? = nil) -> ActionResult {
        guard let e = entry(id), let text = ClipModel.entryText(e), let ctx = context else { return .error("Only text entries can be saved as snippets") }
        let title = name?.trimmingCharacters(in: .whitespaces).isEmpty == false ? name!.trimmingCharacters(in: .whitespaces) : String(ClipModel.title(e).prefix(60))
        ctx.store.saveSnippet(Snippet(id: "sn-\(UUID().uuidString.prefix(8).lowercased())", name: title, text: text, html: e.html))
        ctx.refreshCatalogue()
        return .stay(message: "Saved snippet “\(title)”")
    }

    func ignoreSourceApp(_ id: String) -> ActionResult {
        guard let e = entry(id), let b = e.source?.bundleId else { return .error("The source app of this entry is unknown") }
        if !settings.ignoredApps.contains(b) { patchSettings(["ignoredApps": .array((settings.ignoredApps + [b]).map(JSONValue.string))]) }
        return .stay(message: "Ignoring copies from \(e.source?.name ?? b)")
    }

    // MARK: Paste Stack

    func startPasteStack(limit: Int) -> ActionResult {
        stack = PasteStack.start(order: settings.stackOrder, limit: limit)
        saveStack()
        return .hide(message: limit > 0 ? "Paste Stack: copy \(limit) items" : "Paste Stack started — copy items, then ⌘V pastes them in order")
    }

    func stopPasteStack() {
        stack = stack.stopped()
        saveStack()
    }

    func stackAdd(_ ids: [String]) {
        for id in ids where entry(id) != nil { stack = stack.added(id) }
        saveStack()
    }

    func setStack(_ s: PasteStack) { stack = s; saveStack() }
    func stackRemove(_ id: String) { stack = stack.removing(id); saveStack() }
    func stackMove(_ id: String, by dir: Int) { stack = stack.moving(id, by: dir); saveStack() }
    func stackClear() { stack = stack.cleared(); saveStack() }
    func stackSetOrder(_ o: StackOrder) { patchSettings(["stackOrder": .string(o.rawValue)]) }

    func pasteNextFromStack() -> ActionResult {
        let r = stack.takeNext { [entries] id in entries.contains { $0.id == id } }
        stack = r.stack
        guard let id = r.id, let e = entry(id) else {
            saveStack()
            return .error(stack.collecting ? "Paste Stack is empty — copy something first" : "Paste Stack is empty")
        }
        saveStack()
        _ = pasteEntry(e, plain: false)
        let left = stack.items.count
        return .hide(message: left > 0 ? "Pasted — \(left) left in Paste Stack" : "Pasted the last Paste Stack item")
    }

    /// ⌘V with a non-empty stack: take the next item for the tap. `undo` = id to put back if the tap gave up.
    func nextForNativePaste() -> (reply: StackReply, taken: String?) {
        let r = stack.takeNext { [entries] id in entries.contains { $0.id == id } }
        stack = r.stack
        guard let id = r.id, let e = entry(id) else {
            saveStack()
            return (.empty, nil)
        }
        saveStack()
        if e.type == .image || e.type == .file {
            // The tap pastes text only: put the entry on the pasteboard and let the original ⌘V through.
            putOnClipboard(e, plain: false)
            return (.passthrough, id)
        }
        entries = ClipModel.touch(entries, id: id, now: now)
        changed()
        return (.text(e.text ?? "", html: e.html), id)
    }

    private func answerStackPaste(reqId: Int) {
        guard let tap = composer?.tap else { return }
        let (reply, taken) = nextForNativePaste()
        let active = stack.interceptsPaste
        let applied: Bool
        switch reply {
        case let .text(t, html): applied = tap.applyStackReply(reqId: reqId, text: t, html: html, passthrough: false, empty: false, active: active)
        case .passthrough: applied = tap.applyStackReply(reqId: reqId, text: nil, html: nil, passthrough: true, empty: false, active: active)
        case .empty: applied = tap.applyStackReply(reqId: reqId, text: nil, html: nil, passthrough: false, empty: true, active: false)
        }
        if !applied, let taken {
            stack = stack.restoringHead(taken)
            saveStack()
        }
    }

    // MARK: catalogue

    static func freshPayload(_ extra: [String: JSONValue] = [:]) -> JSONValue {
        var o = extra
        o["nonce"] = .string(UUID().uuidString)
        return .object(o)
    }

    private func command(_ id: String, _ title: String, subtitle: String? = nil, symbol: String, keywords: [String], hotkey: String? = nil, argument: Bool? = nil) -> SearchItem {
        SearchItem(id: id, kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol), keywords: keywords, hotkey: hotkey, acceptsArgument: argument, feature: self.id, kindLabel: "Clipboard")
    }

    public func items() -> [SearchItem] {
        let paused = settings.isPaused(now: now)
        let n = stack.items.count
        var out = [
            command("clipboard.history", "Clipboard History", subtitle: "Search and paste what you copied", symbol: "clipboard", keywords: ["clipboard", "history", "paste", "copy"],
                    hotkey: settings.hotkey.isEmpty ? nil : settings.hotkey, argument: true),
            command("clipboard.clear", "Clear Clipboard History", symbol: "trash", keywords: ["clipboard", "delete", "erase"]),
            paused ? command("clipboard.toggle-pause", "Resume Clipboard History", symbol: "play", keywords: ["clipboard", "unpause"])
                : command("clipboard.toggle-pause", "Pause Clipboard History", symbol: "pause", keywords: ["clipboard", "stop", "private"]),
            command("clipboard.paste-stack", "Paste Stack", subtitle: n > 0 ? "\(n) waiting\(stack.collecting ? " · collecting" : "")" : stack.collecting ? "Collecting copies" : "Collect copies, paste them in order",
                    symbol: "square.stack.3d.up", keywords: ["clipboard", "stack", "queue", "multi"]),
            stack.collecting ? command("clipboard.stack-toggle", "Stop Paste Stack", subtitle: "\(n) collected", symbol: "stop.circle", keywords: ["clipboard", "stack"])
                : command("clipboard.stack-toggle", "Start Paste Stack", subtitle: "Collect the next copies (type a number for N)", symbol: "square.stack.3d.down.right", keywords: ["clipboard", "stack", "collect"], argument: true),
            command("clipboard.stack-next", "Paste Next from Stack", subtitle: n > 0 ? "\(n) left" : "Paste Stack is empty", symbol: "arrow.down.doc", keywords: ["clipboard", "stack", "paste"],
                    hotkey: settings.stackHotkey.isEmpty ? nil : settings.stackHotkey),
        ]
        if !paused { out.append(command("clipboard.pause-5", "Pause Clipboard History for 5 Minutes", symbol: "timer", keywords: ["clipboard", "private", "incognito", "temporarily"])) }
        return out
    }

    func entryItem(_ e: ClipEntry) -> SearchItem {
        let icon: ItemIcon = e.type == .color ? ItemIcon(kind: "color", value: (e.text ?? "").trimmingCharacters(in: .whitespaces)) : .symbol(e.type.symbol)
        return SearchItem(id: "clipboard.entry.\(e.id)", kind: .command, title: ClipModel.title(e), subtitle: e.source.map { "Copied from \($0.name)" } ?? "Clipboard History",
                          icon: icon, feature: id, data: ["entryId": .string(e.id), "noUsage": true], kindLabel: "Clipboard")
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        let q = query.trimmed.lowercased()
        guard q.count >= 3, settings.enabled else { return [] }
        var out: [ScoredItem] = []
        for e in entries where e.type != .image && e.type != .file {
            guard (e.text ?? "").lowercased().contains(q) else { continue }
            out.append(ScoredItem(item: entryItem(e), score: 20 - Double(out.count) * 0.1, matchScore: 20, matchKind: .fuzzy))
            if out.count >= 3 { break }
        }
        return out
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.id {
        case "clipboard.history": return [ItemAction(id: "open", title: "Open Clipboard History", shortcut: "↩", icon: "clipboard")]
        case "clipboard.clear": return [ItemAction(id: "clear", title: "Clear Clipboard History…", shortcut: "↩", icon: "trash", destructive: true)]
        case "clipboard.toggle-pause":
            return [ItemAction(id: "toggle", title: settings.isPaused(now: now) ? "Resume" : "Pause", shortcut: "↩", icon: "pause"), ItemAction(id: "pause-5", title: "Pause for 5 Minutes", shortcut: "⌘↩", icon: "timer")]
        case "clipboard.pause-5": return [ItemAction(id: "pause-5", title: "Pause for 5 Minutes", shortcut: "↩", icon: "timer")]
        case "clipboard.paste-stack": return [ItemAction(id: "open", title: "Open Paste Stack", shortcut: "↩", icon: "square.stack.3d.up")]
        case "clipboard.stack-toggle":
            return [ItemAction(id: "toggle", title: stack.collecting ? "Stop Paste Stack" : "Start Paste Stack", shortcut: "↩", icon: "square.stack.3d.down.right"),
                    ItemAction(id: "open", title: "Open Paste Stack", shortcut: "⌘↩", icon: "square.stack.3d.up")]
        case "clipboard.stack-next":
            return [ItemAction(id: "paste", title: "Paste Next from Stack", shortcut: "↩", icon: "arrow.down.doc"), ItemAction(id: "open", title: "Open Paste Stack", shortcut: "⌘↩", icon: "square.stack.3d.up")]
        default: break
        }
        if item.data?["entryId"] != nil {
            return [ItemAction(id: "paste", title: "Paste", shortcut: "↩", icon: "doc.on.clipboard"), ItemAction(id: "copy", title: "Copy to Clipboard", shortcut: "⌘↩", icon: "doc.on.doc"),
                    ItemAction(id: "plain", title: "Paste as Plain Text", shortcut: "⇧⌘↩", icon: "textformat"), ItemAction(id: "open", title: "Show in Clipboard History", icon: "clipboard")]
        }
        return []
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let item = scored.item
        switch item.id {
        case "clipboard.history": return .pushView("clipboard.history", payload: Self.freshPayload(scored.argument.map { ["query": .string($0)] } ?? [:]))
        case "clipboard.clear": return .pushView("clipboard.history", payload: Self.freshPayload(["confirmClear": true]))
        case "clipboard.toggle-pause": return action == "pause-5" ? pauseFor(minutes: 5) : setPaused(!settings.isPaused(now: now))
        case "clipboard.pause-5": return pauseFor(minutes: 5)
        case "clipboard.paste-stack": return .pushView("clipboard.stack", payload: Self.freshPayload())
        case "clipboard.stack-toggle":
            if action == "open" { return .pushView("clipboard.stack", payload: Self.freshPayload()) }
            if stack.collecting { stopPasteStack(); return .pushView("clipboard.stack", payload: Self.freshPayload()) }
            return startPasteStack(limit: Int(scored.argument?.trimmingCharacters(in: .whitespaces) ?? "") ?? 0)
        case "clipboard.stack-next": return action == "open" ? .pushView("clipboard.stack", payload: Self.freshPayload()) : pasteNextFromStack()
        default: break
        }
        guard let e = entry(item.data?["entryId"]?.stringValue) else { return .error("That clipboard entry no longer exists") }
        switch action {
        case "copy": return copyEntry(e)
        case "plain": return pasteEntry(e, plain: true)
        case "open": return .pushView("clipboard.history", payload: Self.freshPayload(["selectId": .string(e.id)]))
        default: return pasteEntry(e, plain: modifiers.contains(.shift))
        }
    }

    // MARK: UI

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        switch id.name {
        case "history":
            history.prepare(payload: payload, host: host)
            return AnyView(ClipHistoryView(model: history, changes: changes, query: host.query))
        case "stack":
            stackModel.prepare(payload: payload, host: host)
            return AnyView(ClipStackView(model: stackModel, changes: changes))
        case "edit":
            editModel.prepare(payload: payload, host: host)
            return AnyView(ClipEditView(model: editModel))
        default: return nil
        }
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        switch view.name {
        case "history": return history.handleKey(key)
        case "stack": return stackModel.handleKey(key)
        case "edit": return editModel.handleKey(key)
        default: return false
        }
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        switch view.name {
        case "history": return history.handleCommand(command)
        case "stack": return stackModel.handleCommand(command)
        default: return false
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Clipboard History", symbol: "clipboard", order: 60) { [weak self] in
            guard let self else { return AnyView(EmptyView()) }
            return AnyView(ClipSettingsView(model: ClipSettingsModel(feature: self)))
        }
    }
}

/// Change counter the SwiftUI views observe (the feature itself is not Observable).
@MainActor @Observable final class ClipChanges {
    private(set) var version = 0
    func bump() { version &+= 1 }
}
