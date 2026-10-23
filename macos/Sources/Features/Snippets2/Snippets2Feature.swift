import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI
import UniformTypeIdentifiers

/// Snippets 2.0 (session N2): live keyword expansion through the shared keyboard tap with in-process rendering
/// ({clipboard} {time} {date offset=…} {selection} {uuid} {cursor} nested {snippet name=…}, rich text), keyword
/// prefix, case-adaptive variants, per-app exclusions, secure-input skip (in the tap), Search Snippets view with
/// preview, the snippet editor (Settings → Snippets) and Raycast JSON import.
///
/// The snippets themselves stay in data.json (`UserData.snippets`). Integration: this feature also owns the
/// `snippet:<id>` rows and the Settings "snippets" page (the phase-0 SnippetsFeature and its hooks are gone);
/// expansion settings live in `settings.features["snippets"]` and the on/off switch in
/// `settings.features["keyboard"].expandSnippets`, exactly like the Electron app.
@MainActor public final class Snippets2Feature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "snippets2"
    public let title = "Snippet Expansion"
    /// Electron feature ids whose settings bags this feature reads and writes.
    static let settingsBag = "snippets"
    static let keyboardBag = "keyboard"
    static let refreshInterval: Duration = .seconds(20)
    /// The tap waits ≤ 300 ms for a live render; slow reads are dropped after this budget.
    static let readBudget: Duration = .milliseconds(150)

    weak var context: FeatureContext?
    private var composer: KeyboardTapComposer?
    private var observation: StoreObservation?
    private var refreshTask: Task<Void, Never>?
    private var refreshScheduled = false
    private(set) var expansions = 0
    private(set) var lastError: String?
    let changes = ClipChanges()
    lazy var search = SnipSearchModel(feature: self)
    lazy var editor = SnipEditorModel(feature: self)

    public init() {}

    var snippets: [Snippet] { context?.store.data.snippets ?? [] }
    var settings: SnippetSettings { SnippetSettings(bag: context?.store.settings.featureSettings(Self.settingsBag) ?? [:]) }
    var expandEnabled: Bool {
        context?.store.settings.featureSettings(Self.keyboardBag, defaults: ["expandSnippets": true])["expandSnippets"]?.boolValue != false
    }

    // MARK: lifecycle

    public func start(context: FeatureContext) async {
        self.context = context
        let c = KeyboardTapComposer.shared(for: context.services)
        composer = c
        c.subscribe(id) { [weak self] e in self?.tapEvent(e) }
        observation = context.store.observe { [weak self] _ in
            Task { @MainActor in self?.scheduleRefresh() }
        }
        refreshTap()
    }

    public func stop() async {
        refreshTask?.cancel()
        observation?.cancel()
        composer?.subscribe(id, nil)
    }

    private func scheduleRefresh() {
        guard !refreshScheduled else { return }
        refreshScheduled = true
        Task { @MainActor in
            self.refreshScheduled = false
            self.refreshTap()
            self.changes.bump()
        }
    }

    func env(clipboard: String? = nil, selection: String? = nil) -> SnipTemplate.Env {
        SnipTemplate.Env(now: Date(), clipboard: clipboard, selection: selection, snippet: SnipRender.lookup(snippets))
    }

    /// Rebuild what the tap watches (keywords + fallbacks). Dynamic snippets re-render every 20 s.
    func refreshTap() {
        guard let ctx = context else { return }
        let list = snippets
        // The Keyboard feature owns the tap config (and gates it by expandSnippets / Accessibility); we hand it the
        // rendered keyword list. Global exclusions travel with each entry (the tap checks per-entry lists too).
        let global = settings.excludedApps
        let entries = SnipExpansion.tapEntries(list, settings: settings, env: env(clipboard: ctx.services.pasteboard.string())).map { e in
            var e = e
            for b in global where !e.excludedBundleIds.contains(where: { $0.lowercased() == b.lowercased() }) { e.excludedBundleIds.append(b) }
            return e
        }
        sendEntries(entries)
        lastError = composer?.lastError
        let dynamic = expandEnabled && SnipExpansion.needsRefresh(list)
        if dynamic && refreshTask == nil {
            refreshTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: Self.refreshInterval)
                    self?.refreshTap()
                }
            }
        } else if !dynamic {
            refreshTask?.cancel()
            refreshTask = nil
        }
    }

    private(set) var sentEntries: [KeyboardTapConfig.SnippetEntry]?
    private func sendEntries(_ entries: [KeyboardTapConfig.SnippetEntry]) {
        guard entries != sentEntries, let ctx = context else { return }
        sentEntries = entries
        let args: JSONValue = .array(entries.map { ["keyword": .string($0.keyword), "text": .string($0.text), "id": $0.id.map(JSONValue.string) ?? .null,
                                                     "excludedBundleIds": .array($0.excludedBundleIds.map(JSONValue.string))] })
        Task { _ = try? await ctx.callFeature("keyboard", method: "setSnippets", args: args) }
    }

    // MARK: live expansion

    private func tapEvent(_ e: KeyboardTapEvent) {
        switch e {
        case let .snippetMatched(reqId, keyword, sid, _):
            Task { [weak self] in
                guard let self else { return }
                let r = await self.liveRender(keyword: keyword, id: sid)
                _ = self.composer?.tap.finishExpansion(reqId: reqId, text: r?.text, html: r?.html, cursorLeft: r?.cursorLeft)
            }
        case .snippetExpanded:
            expansions += 1
            // A fresh {uuid}/{time}/{clipboard} fallback for the next expansion.
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(400))
                self?.refreshTap()
            }
        case let .tapFailed(reason):
            lastError = reason
        case .stackNext:
            break
        }
    }

    /// Current pasteboard text through the shared watcher (sees rich copies; the fake one in headless mode).
    func clipboardText() async -> String? {
        guard let ctx = context else { return nil }
        let t = await PasteboardWatcherFactory.watcher(for: ctx.services).read().text
        return t ?? ctx.services.pasteboard.string()
    }

    /// Selected text with a deadline (nil = too slow or nothing selected).
    private func selection(budget: Duration) async -> String? {
        guard let ctx = context else { return nil }
        let sel = ctx.services.selection
        let once = SnipOnce()
        return await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
            once.cont = cont
            Task { @MainActor in once.resume(await sel.selectedText().text) }
            Task { @MainActor in
                try? await Task.sleep(for: budget)
                once.resume(nil)
            }
        }
    }

    /// snippet.matched → what to paste (nil = let the tap paste its pre-rendered fallback).
    func liveRender(keyword: String, id sid: String) async -> RenderedSnippet? {
        let all = snippets
        guard let s = all.first(where: { $0.id == sid }) else { return nil }
        let src = "\(s.text)\n\(s.html ?? "")"
        let clip = SnipTemplate.uses(src, "clipboard") ? await clipboardText() : nil
        let sel = SnipTemplate.uses(src, "selection") ? await selection(budget: Self.readBudget) : nil
        let p = SnipExpansion.plan(typed: keyword, snippet: s, all: all, settings: settings, env: env(clipboard: clip, selection: sel))
        return RenderedSnippet(text: p.text, html: p.html.map(SnipRender.sanitizeHTML), cursorLeft: p.cursorLeft)
    }

    /// Render for the launcher's Paste/Copy (live clipboard + selection, nested snippets).
    func renderForUse(_ s: Snippet) async -> RenderedSnippet {
        let src = "\(s.text)\n\(s.html ?? "")"
        let clip = SnipTemplate.uses(src, "clipboard") ? await clipboardText() : nil
        let sel = SnipTemplate.uses(src, "selection") ? await selection(budget: .milliseconds(400)) : nil
        var r = SnipRender.render(text: s.text.isEmpty ? SnipRender.htmlToText(s.html ?? "") : s.text, html: s.html, env: env(clipboard: clip, selection: sel))
        r.html = r.html.map(SnipRender.sanitizeHTML)
        return r
    }

    /// Preview without reading the real clipboard or selection.
    func preview(text: String, html: String?) -> RenderedSnippet {
        SnipRender.render(text: text, html: html.map(SnipRender.sanitizeHTML), env: env(clipboard: "‹clipboard›", selection: "‹selection›"))
    }

    func paste(_ s: Snippet, plain: Bool = false) async -> ActionResult {
        let r = await renderForUse(s)
        guard let ctx = context else { return .error("Not started") }
        ctx.hideLauncher()
        SyntheticKeys.paste(text: r.text, html: plain ? nil : r.html, cursorLeft: r.cursorLeft, services: ctx.services)
        return .hide(message: "Pasted")
    }

    func copy(_ s: Snippet) async -> ActionResult {
        let r = await renderForUse(s)
        context?.services.pasteboard.setString(r.text, html: r.html, transient: false)
        return .hide(message: "Snippet copied")
    }

    /// Row actions of `snippet:<id>` (placeholders, rich text and {cursor} rendered in-process).
    func use(_ s: Snippet, action: String) async -> ActionResult? {
        switch action {
        case "paste": return await paste(s)
        case "copy": return await copy(s)
        case "edit":
            editor.select(s.id)
            return .openSettings(page: "\(Self.settingsBag)/\(s.id)")
        case "delete":
            delete(s.id)
            return .stay(message: "Snippet deleted")
        default: return nil
        }
    }

    // MARK: editing

    @discardableResult
    func save(_ raw: Snippet) throws -> Snippet {
        guard let ctx = context else { throw FeatureError.failed("Snippets are not ready yet") }
        let name = raw.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw FeatureError.invalidArguments("Name is required") }
        let html = (raw.html ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : SnipRender.sanitizeHTML(raw.html ?? "")
        let text = raw.text.isEmpty ? (html.map(SnipRender.htmlToText) ?? "") : raw.text
        guard !text.isEmpty else { throw FeatureError.invalidArguments("Text is required") }
        var s = raw
        s.id = raw.id.isEmpty ? SnipIO.newId() : raw.id
        s.name = name
        s.text = text
        s.html = html
        s.keyword = raw.keyword?.trimmingCharacters(in: .whitespacesAndNewlines).n2NilIfEmpty
        s.alias = raw.alias?.trimmingCharacters(in: .whitespacesAndNewlines).n2NilIfEmpty
        let apps = (raw.excludedApps ?? []).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        s.excludedApps = apps.isEmpty ? nil : apps
        ctx.store.saveSnippet(s)
        ctx.refreshCatalogue()
        refreshTap()
        return s
    }

    func delete(_ sid: String) {
        context?.store.deleteSnippet(sid)
        context?.refreshCatalogue()
        refreshTap()
    }

    func setSettings(_ patch: [String: JSONValue]) -> SnippetSettings {
        var bag = settings.bag
        bag.merge(patch) { $1 }
        let next = SnippetSettings(bag: bag)
        context?.store.setFeatureSettings(Self.settingsBag, next.bag)
        refreshTap()
        return next
    }

    func setExpansion(_ on: Bool) async {
        guard let ctx = context else { return }
        // The Keyboard feature reconfigures the tap; write the bag ourselves when it is not there.
        if (try? await ctx.callFeature("keyboard", method: "setExpandSnippets", args: .bool(on))) == nil {
            ctx.store.setFeatureSettings(Self.keyboardBag, ["expandSnippets": .bool(on)])
        }
        refreshTap()
    }

    struct ImportReport: Equatable { var added: Int; var duplicates: Int; var skipped: Int; var keywordConflicts: Int; var unsupported: [String] }

    func importJSON(_ json: String) throws -> ImportReport {
        guard let ctx = context else { throw FeatureError.failed("Snippets are not ready yet") }
        let parsed = try SnipIO.parse(json)
        let m = SnipIO.merge(parsed.snippets, existing: ctx.store.data.snippets)
        _ = ctx.store.mutate { d in for var s in m.add { s.id = SnipIO.newId(); d.snippets.append(s) } }
        ctx.refreshCatalogue()
        refreshTap()
        return ImportReport(added: m.add.count, duplicates: m.duplicates, skipped: parsed.skipped, keywordConflicts: m.keywordConflicts, unsupported: parsed.unsupported)
    }

    static func message(_ r: ImportReport) -> String {
        ["Imported \(r.added) snippet\(r.added == 1 ? "" : "s")", r.duplicates > 0 ? "\(r.duplicates) duplicates skipped" : "",
         r.keywordConflicts > 0 ? "\(r.keywordConflicts) keywords already in use" : "", r.unsupported.isEmpty ? "" : "unsupported: \(r.unsupported.joined(separator: " "))"]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    func exportJSON() -> String { SnipIO.export(snippets) }

    /// File dialogs (never in headless mode).
    func importFile() -> ActionResult {
        guard let ctx = context, !ctx.services.isHeadless else { return .error("File dialogs are disabled in headless mode") }
        let panel = NSOpenPanel()
        panel.title = "Import Snippets (Raycast or Glide JSON)"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url, let json = try? String(contentsOf: url, encoding: .utf8) else { return .stay(message: nil) }
        do { return .stay(message: Self.message(try importJSON(json))) } catch { return .error(error.localizedDescription) }
    }

    func exportFile() -> ActionResult {
        guard let ctx = context, !ctx.services.isHeadless else { return .error("File dialogs are disabled in headless mode") }
        let panel = NSSavePanel()
        panel.title = "Export Snippets"
        panel.nameFieldStringValue = "Glide Snippets.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return .stay(message: nil) }
        do {
            try exportJSON().write(to: url, atomically: true, encoding: .utf8)
            return .stay(message: "Exported to \(url.lastPathComponent)")
        } catch { return .error(error.localizedDescription) }
    }

    // MARK: catalogue

    private func command(_ id: String, _ title: String, _ subtitle: String, _ symbol: String, _ keywords: [String]) -> SearchItem {
        SearchItem(id: "snippets.\(id)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol), keywords: keywords,
                   acceptsArgument: id == "search" ? true : nil, feature: self.id, kindLabel: "Snippets")
    }

    /// The user's snippets (`snippet:<id>`, same ids as the Electron app and phase 0, so usage/favorites carry over).
    private func snippetRows() -> [SearchItem] {
        snippets.map { s in
            let first = s.text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
            return SearchItem(id: "snippet:\(s.id)", kind: .snippet, title: s.name, subtitle: first.count > 60 ? String(first.prefix(60)) + "…" : first,
                              icon: .symbol("text.quote"), keywords: s.keyword.map { [$0] } ?? [], alias: s.alias ?? s.keyword, text: s.text, source: "snippets", feature: id)
        }
    }

    public func items() -> [SearchItem] {
        snippetRows() + [command("search", "Search Snippets", "Browse, preview and paste snippets", "text.quote", ["snippet", "paste", "text", "expand", "template"]),
         command("create", "Create Snippet", "New snippet in Settings", "plus.square", ["snippet", "new", "add", "text replacement"]),
         command("import", "Import Snippets…", "From Raycast's snippet export or a Glide JSON file", "square.and.arrow.down", ["import", "raycast", "json", "snippets"]),
         command("export", "Export Snippets…", "Save all snippets as JSON", "square.and.arrow.up", ["export", "json", "backup", "snippets"])]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        if item.id.hasPrefix("snippet:") {
            return [ItemAction(id: "paste", title: "Paste", shortcut: "↩", icon: "doc.on.clipboard"), ItemAction(id: "copy", title: "Copy to Clipboard", shortcut: "⌘↩", icon: "doc.on.doc"),
                    ItemAction(id: "edit", title: "Edit Snippet", shortcut: "⌘E", icon: "pencil"), ItemAction(id: "delete", title: "Delete Snippet", shortcut: "⌃X", icon: "trash", destructive: true)]
        }
        switch item.id {
        case "snippets.import": return [ItemAction(id: "importFile", title: "Import from File…", shortcut: "↩", icon: "doc"), ItemAction(id: "importClipboard", title: "Import JSON from Clipboard", shortcut: "⌘↩", icon: "doc.on.clipboard")]
        case "snippets.export": return [ItemAction(id: "exportFile", title: "Export to File…", shortcut: "↩", icon: "doc"), ItemAction(id: "exportCopy", title: "Copy JSON", shortcut: "⌘↩", icon: "doc.on.doc")]
        case "snippets.toggle-expansion": return [ItemAction(id: "toggle", title: expandEnabled ? "Turn Expansion Off" : "Turn Expansion On", shortcut: "↩", icon: "keyboard")]
        case "snippets.create": return [ItemAction(id: "create", title: "Create Snippet", shortcut: "↩", icon: "plus")]
        default: return [ItemAction(id: "open", title: "Open", shortcut: "↩", icon: "text.quote"), ItemAction(id: "settings", title: "Open Snippets Settings", shortcut: "⌘↩", icon: "gearshape")]
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        if scored.item.id.hasPrefix("snippet:") {
            let sid = String(scored.item.id.dropFirst("snippet:".count))
            guard let s = snippets.first(where: { $0.id == sid }) else { return .error("Snippet not found") }
            return await use(s, action: action) ?? .error("Unknown action \(action)")
        }
        switch action {
        case "open":
            let p = ClipboardFeature.freshPayload(scored.argument.map { ["query": .string($0)] } ?? [:]) // payload query pre-fills the field
            search.prepare(payload: p, host: nil)
            return .pushView("snippets2.search", payload: p)
        case "settings": return .openSettings(page: Self.settingsBag)
        case "create":
            editor.startNew()
            return .openSettings(page: Self.settingsBag)
        case "importFile": return importFile()
        case "importClipboard":
            do { return .stay(message: Self.message(try importJSON(context?.services.pasteboard.string() ?? ""))) } catch { return .error(error.localizedDescription) }
        case "exportFile": return exportFile()
        case "exportCopy":
            context?.services.pasteboard.setString(exportJSON(), html: nil, transient: false)
            return .stay(message: "Snippets JSON copied")
        case "toggle":
            let on = !expandEnabled
            await setExpansion(on)
            if on, context?.services.permissions.status().accessibility == false {
                return .stay(message: "Snippet expansion is on — grant Accessibility for it to work")
            }
            return .stay(message: on ? "Snippet expansion turned on" : "Snippet expansion turned off")
        default: return .error("Unknown action \(action)")
        }
    }

    // MARK: UI

    /// Settings → Snippets (Electron page id "snippets"; `snippets/<id>` selects that snippet).
    public var settingsPage: SettingsPage? {
        SettingsPage(id: Self.settingsBag, title: "Snippets", symbol: "text.quote", order: 50,
                     onRoute: { [weak self] r in if r == "new" { self?.editor.startNew() } else { self?.editor.select(r) } }) { [weak self] in
            self.map { AnyView(SnipEditorView(model: $0.editor)) } ?? AnyView(EmptyView())
        }
    }

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard id.name == "search" else { return nil }
        search.prepare(payload: payload, host: host)
        return AnyView(SnipSearchView(model: search, changes: changes, query: host.query))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { view.name == "search" ? search.handleKey(key) : false }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { view.name == "search" ? search.handleCommand(command) : false }

    // MARK: methods

    private func snippetJSON(_ s: Snippet) -> JSONValue { (try? JSONEncoder().encode(s)).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null }

    private func rendered(_ r: RenderedSnippet) -> JSONValue {
        ["text": .string(r.text), "html": r.html.map(JSONValue.string) ?? .null, "cursorLeft": .int(Int64(r.cursorLeft))]
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        let sid = args["id"]?.stringValue ?? args.stringValue ?? ""
        let find = { (i: String) in self.snippets.first { $0.id == i || "snippet:\($0.id)" == i } }
        switch method {
        case "getSettings": return .object(settings.bag)
        case "setSettings": return .object(setSettings(args.objectValue ?? [:]).bag)
        case "setExpansion":
            await setExpansion(args["on"]?.boolValue ?? args.boolValue ?? true)
            return .bool(expandEnabled)
        case "list": return .array(snippets.map(snippetJSON))
        case "save":
            let s = try JSONDecoder().decode(Snippet.self, from: JSONEncoder().encode(args))
            var raw = s
            if args["id"] == nil { raw.id = "" }
            return snippetJSON(try save(raw))
        case "delete": delete(sid); return true
        case "preview": return rendered(preview(text: args["text"]?.stringValue ?? "", html: args["html"]?.stringValue))
        case "render":
            guard let s = find(sid) else { return .null }
            return rendered(await renderForUse(s))
        case "paste":
            guard let s = find(sid) else { return ["ok": false, "error": "Snippet not found"] }
            return ClipboardFeature.result(await paste(s))
        case "copy":
            guard let s = find(sid) else { return ["ok": false, "error": "Snippet not found"] }
            return ClipboardFeature.result(await copy(s))
        case "keywordWarning": return SnipExpansion.keywordWarning(args["keyword"]?.stringValue ?? args.stringValue ?? "", prefix: settings.keywordPrefix).map(JSONValue.string) ?? .null
        case "importJson":
            let r = try importJSON(args["json"]?.stringValue ?? args.stringValue ?? "")
            return ["added": .int(Int64(r.added)), "duplicates": .int(Int64(r.duplicates)), "skipped": .int(Int64(r.skipped)),
                    "keywordConflicts": .int(Int64(r.keywordConflicts)), "unsupported": .array(r.unsupported.map(JSONValue.string))]
        case "exportJson": return .string(exportJSON())
        case "tapEntries":
            let cfg = sentEntries ?? []
            return ["snippets": .array(cfg.map { ["keyword": .string($0.keyword), "text": .string($0.text), "id": $0.id.map(JSONValue.string) ?? .null,
                                                          "excludedBundleIds": .array($0.excludedBundleIds.map(JSONValue.string))] }),
                    "events": .int(Int64(composer?.dispatched ?? 0))]
        case "debugMatch":
            // What the tap would paste for a typed keyword (no tap involved).
            guard let r = await liveRender(keyword: args["keyword"]?.stringValue ?? "", id: sid) else { return .null }
            return rendered(r)
        case "stats": return ["expansions": .int(Int64(expansions)), "lastError": lastError.map(JSONValue.string) ?? .null, "enabled": .bool(expandEnabled)]
        case "viewState": return search.state()
        case "editorState": return editor.state()
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

fileprivate extension String {
    var n2NilIfEmpty: String? { isEmpty ? nil : self }
}

/// Resumes a continuation once (first of the read / the deadline wins).
@MainActor private final class SnipOnce {
    var cont: CheckedContinuation<String?, Never>?
    func resume(_ v: String?) {
        let c = cont
        cont = nil
        c?.resume(returning: v)
    }
}
