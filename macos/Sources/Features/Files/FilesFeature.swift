import AppKit
import Foundation
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// File search (feature id "fileindex", like Electron): Spotlight-backed live search by name and content
/// (`content:` prefix or ⌘T in the Search Files view), `~/…` and `/…` folder browsing, recents opened from Glide
/// (`<data>/features/fileindex/opened.json`), and file actions (open, reveal, open with…, copy path / file, Quick
/// Look pane, move to Trash with confirmation). Root-search rows land in the Files section.
///
/// Backends: Spotlight (NSMetadataQuery) in the app; headless runs use a deterministic directory walk of the
/// configured scopes and only when `settings.features.fileindex.scopes` was set explicitly (never the user's home).
/// `GLIDE_FILES_BACKEND=scan|spotlight` overrides.
@MainActor public final class FilesFeature: Feature, FeatureUI {
    public let id = "fileindex"
    public let title = "File Search"
    static let searchView: ViewID = "fileindex.search"
    static let openWithView: ViewID = "fileindex.openWith"
    static let rootLimit = 15
    static let fileScore: Double = 25

    private weak var context: FeatureContext?
    public private(set) var recents: FilesRecents?
    var backendKind = "spotlight"
    private var rootBackend: (any FilesBackend)?
    private var rootKey = ""
    private var rootCache: [String: [String]] = [:]
    private var rootMissed: Set<String> = []
    let session = FilesSearchModel()
    let openWith = FilesOpenWithModel()
    public init() {}

    public var dynamicItemsBudget: Duration { .milliseconds(250) }

    public func start(context: FeatureContext) async {
        self.context = context
        recents = FilesRecents(file: context.dataDirectory().appendingPathComponent("opened.json"))
        let env = ProcessInfo.processInfo.environment["GLIDE_FILES_BACKEND"]
        backendKind = env ?? (context.services.isHeadless ? "scan" : "spotlight")
        rootBackend = makeBackend()
        session.feature = self
        openWith.feature = self
    }

    public func stop() async {
        rootBackend?.stop()
        session.backend?.stop()
    }

    func makeBackend() -> any FilesBackend {
        backendKind == "scan" ? ScanFilesBackend { [weak self] in self?.exclusions ?? FilesExclusions(settings: FilesSettings()) } : SpotlightFilesBackend()
    }

    public var prefs: FilesSettings { FilesSettings(bag: context?.settings(defaults: [:]) ?? [:]) }
    var exclusions: FilesExclusions { FilesExclusions(settings: prefs) }
    var isHeadless: Bool { context?.services.isHeadless ?? true }

    /// Scopes to search; headless runs never fall back to the user's home folder.
    var scopes: [String] {
        if isHeadless && backendKind == "scan" && context?.store.settings.features[id]?["scopes"] == nil { return [] }
        return prefs.expandedScopes()
    }

    var rootEnabled: Bool {
        guard let s = context?.store.settings else { return false }
        return s.fileSearch && prefs.showInRootSearch && !s.disabledSources.contains("files")
    }

    // MARK: items

    nonisolated static func displayFolder(_ p: String, home: String = NSHomeDirectory()) -> String {
        let dir = (p as NSString).deletingLastPathComponent
        if dir == home { return "~" }
        return dir.hasPrefix(home + "/") ? "~" + dir.dropFirst(home.count) : dir
    }

    func fileItem(_ p: String) -> SearchItem {
        SearchItem(id: "file:\(p)", kind: .file, title: (p as NSString).lastPathComponent.isEmpty ? p : (p as NSString).lastPathComponent, subtitle: Self.displayFolder(p),
                   icon: .file(p), path: p, source: "files", feature: id)
    }

    func scored(_ paths: [String]) -> [ScoredItem] {
        paths.enumerated().map { i, p in ScoredItem(item: fileItem(p), score: Self.fileScore - Double(i) * 0.1, matchScore: Self.fileScore, matchKind: .fuzzy) }
    }

    public func items() -> [SearchItem] {
        [SearchItem(id: "fileindex:search", kind: .command, title: "Search Files", subtitle: "Spotlight file search with Quick Look", icon: .symbol("doc.text.magnifyingglass"),
                    keywords: ["find", "files", "folders", "documents", "finder", "spotlight"], feature: id, kindLabel: "File Search"),
         SearchItem(id: "fileindex:recent", kind: .command, title: "Recent Files", subtitle: "Files opened from Glide", icon: .symbol("clock.arrow.circlepath"),
                    keywords: ["recent", "files", "history", "opened"], feature: id, kindLabel: "File Search")]
    }

    /// `~/Doc` or `/Users/x/D` → matching entries of the parent directory.
    nonisolated static func browse(_ query: String, includeHidden: Bool, limit: Int = 20) -> [String] {
        let expanded = (query as NSString).expandingTildeInPath
        let endsWithSep = expanded.hasSuffix("/")
        let dir = endsWithSep ? expanded : (expanded as NSString).deletingLastPathComponent
        let prefix = endsWithSep ? "" : (expanded as NSString).lastPathComponent.lowercased()
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        return names.filter { prefix.isEmpty ? (includeHidden || !$0.hasPrefix(".")) : $0.lowercased().hasPrefix(prefix) }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }.prefix(limit).map { (dir as NSString).appendingPathComponent($0) }
    }

    nonisolated static func parse(_ text: String) -> (String, FilesSearchMode) {
        if let r = text.range(of: "^content:\\s*", options: [.regularExpression, .caseInsensitive]) {
            return (String(text[r.upperBound...]).trimmingCharacters(in: .whitespaces), .content)
        }
        return (text, .name)
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        guard rootEnabled, let backend = rootBackend else { return [] }
        let text = query.trimmed
        if text.hasPrefix("~") || text.hasPrefix("/") { return scored(Self.browse(text, includeHidden: prefs.includeHidden)) }
        let (q, mode) = Self.parse(text)
        guard q.count >= 3 else { backend.stop(); rootKey = ""; return [] }
        let key = "\(mode.rawValue):\(q.lowercased())"
        if let hit = rootCache[key] { return scored(hit) }
        if rootKey != key {
            rootKey = key
            let scopes = self.scopes
            if scopes.isEmpty { return [] }
            backend.start(text: q, mode: mode, scopes: scopes, limit: Self.rootLimit) { [weak self] paths, used, finished in
                guard let self, finished else { return }
                let ex = self.exclusions
                let kept = paths.filter { !ex.excludes(path: $0, scopes: scopes) }
                let ranked = Array(FilesRanking.rank(kept, query: q, opened: self.recents?.opened ?? [:], lastUsed: used).prefix(Self.rootLimit))
                let had = self.rootCache[key] != nil
                let changed = self.rootCache[key] != ranked
                self.rootCache = [key: ranked]
                // Live: refresh when a gather finished after the budget, or Spotlight reported a change later.
                if changed && self.rootKey == key && (had || self.rootMissed.contains(key)) {
                    self.rootMissed.remove(key)
                    self.context?.refreshCatalogue()
                }
            }
        }
        // Wait for the first gather within the budget; late (and live) results refresh the list.
        let deadline = query.deadline - .milliseconds(20)
        while ContinuousClock.now < deadline, rootCache[key] == nil, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(15))
        }
        if let hit = rootCache[key] { rootMissed.remove(key); return scored(hit) }
        rootMissed.insert(key)
        return []
    }

    // MARK: actions

    public func actions(for item: SearchItem) -> [ItemAction] {
        if item.kind == .file {
            return [ItemAction(id: "open", title: "Open", shortcut: "↩", icon: "arrow.up.forward.app"),
                    ItemAction(id: "reveal", title: "Show in Finder", shortcut: "⌘↩", icon: "folder"),
                    ItemAction(id: "openWith", title: "Open With…", shortcut: "⌘O", icon: "square.grid.2x2"),
                    ItemAction(id: "copyPath", title: "Copy Path", shortcut: "⇧⌘C", icon: "doc.on.doc"),
                    ItemAction(id: "copyFile", title: "Copy File", shortcut: "⇧⌘.", icon: "doc.on.clipboard"),
                    ItemAction(id: "quickLook", title: "Quick Look", shortcut: "⌘Y", icon: "eye"),
                    ItemAction(id: "trash", title: "Move to Trash", shortcut: "⌃X", icon: "trash", destructive: true)]
        }
        return [ItemAction(id: "open", title: "Open", shortcut: "↩", icon: "arrow.up.forward")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let item = scored.item
        if item.kind != .file {
            switch item.id {
            case "fileindex:recent":
                session.reset(initial: "", mode: .name, recentsOnly: true)
                return .pushView(Self.searchView, payload: ["recent": true])
            default:
                session.reset(initial: scored.argument ?? "", mode: .name)
                return .pushView(Self.searchView, payload: ["query": .string(scored.argument ?? "")])
            }
        }
        return await fileAction(action, path: item.path ?? "", appPath: nil)
    }

    /// Side effects that have no SystemServices API are recorded (not performed) in headless runs.
    func headlessEffect(_ kind: String, _ detail: [String: JSONValue]) {
        SideEffectLog.recordShared(kind, .object(detail)) // integration: also lands in headless/effects
    }

    public func fileAction(_ action: String, path p: String, appPath: String?) async -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        guard !p.isEmpty else { return .error("Item has no path") }
        switch action {
        case "open":
            let r = ctx.services.workspace.open(path: p)
            guard r.ok else { return .error(r.error ?? "Could not open") }
            recents?.record(p)
            return .hide()
        case "reveal":
            ctx.services.workspace.reveal(path: p)
            recents?.record(p)
            return .hide()
        case "openWith":
            if let appPath {
                let r = ctx.services.workspace.open(url: URL(fileURLWithPath: p), withApp: appPath)
                guard r.ok else { return .error(r.error ?? "Could not open") }
                recents?.record(p)
                return .hide()
            }
            openWith.load(path: p)
            return .pushView(Self.openWithView, payload: ["path": .string(p)])
        case "copyPath":
            ctx.services.pasteboard.setString(p, html: nil, transient: false)
            return .hide(message: "Path copied")
        case "copyFile":
            ctx.services.pasteboard.setFileURLs([URL(fileURLWithPath: p)]) // integration: shared API (headless: pasteboard-files effect)
            return .hide(message: "File copied")
        case "quickLook":
            session.reset(initial: (p as NSString).lastPathComponent, mode: .name, select: p, preview: true)
            return .pushView(Self.searchView, payload: ["query": .string((p as NSString).lastPathComponent), "select": .string(p)])
        case "trash":
            let name = (p as NSString).lastPathComponent
            if !isHeadless { ctx.hideLauncher() }
            guard await ctx.services.confirmation.confirm(title: "Move “\(name)” to the Trash?", message: p, confirmButton: "Move to Trash") else { return .stay(message: nil) }
            if isHeadless {
                headlessEffect("trash", ["path": .string(p)])
            } else {
                do { try FileManager.default.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: nil) } catch { return .error("Could not move to Trash: \(error.localizedDescription)") }
            }
            recents?.forget(p)
            rootCache = [:]
            session.remove(p)
            return .stay(message: "Moved “\(name)” to the Trash")
        default:
            return .error("Unknown action \(action)")
        }
    }

    // MARK: views

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        switch vid {
        case Self.searchView:
            session.host = host
            host.setPlaceholder(session.mode == .content ? "Search file contents…" : "Search files…  (⌘T: name ⇄ content)")
            host.setFooter(primary: "Open", hasActions: true)
            session.update(query: host.query)
            return AnyView(FilesSearchView(model: session, headless: isHeadless))
        case Self.openWithView:
            openWith.host = host
            host.setPlaceholder("Open “\((openWith.path as NSString).lastPathComponent)” with…")
            host.setFooter(primary: "Open", hasActions: false)
            return AnyView(FilesOpenWithView(model: openWith, filter: host.query))
        default: return nil
        }
    }

    public func handleKey(_ k: VimKey, view: ViewID) -> Bool {
        switch view {
        case Self.searchView: return session.handleKey(k)
        case Self.openWithView: return openWith.handleKey(k)
        default: return false
        }
    }

    func perform(_ result: ActionResult, host: LauncherViewHost?) {
        switch result {
        case let .hide(message):
            if let message { host?.toast(message, style: .success) }
            host?.close()
        case let .stay(message): if let message { host?.toast(message, style: .info) }
        case let .pushView(v, payload): host?.push(v, payload: payload)
        case let .error(m): host?.toast(m, style: .error)
        case let .openSettings(page): context?.openSettings(page: page)
        @unknown default: break
        }
    }

    // MARK: test channel

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "search":
            let text = args.stringValue ?? args["query"]?.stringValue ?? ""
            let (q, mode) = Self.parse(text)
            await session.run(query: q, mode: args["mode"]?.stringValue.flatMap(FilesSearchMode.init(rawValue:)) ?? mode)
            return session.json
        case "view": return session.json
        case "action":
            let r = await fileAction(args["action"]?.stringValue ?? "", path: args["path"]?.stringValue ?? "", appPath: args["app"]?.stringValue)
            return .string("\(r)")
        case "recent": return .array((recents?.recent() ?? []).map(JSONValue.string))
        case "recordOpen":
            recents?.record(args.stringValue ?? "")
            return true
        case "preview": return FilesPreviewInfo.read(args.stringValue ?? "").json
        case "openWithApps":
            openWith.load(path: args.stringValue ?? "")
            return .array(openWith.apps.map { .string($0.name) })
        case "settings": return .object(prefs.bag)
        case "setSettings":
            var b = prefs.bag
            for (k, v) in args.objectValue ?? [:] { b[k] = v }
            context?.setSettings(FilesSettings(bag: b).bag)
            rootCache = [:]
            rootKey = ""
            return .object(prefs.bag)
        case "backend": return .string(backendKind)
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "File Search", symbol: "doc.text.magnifyingglass", order: 25) { [weak self] in AnyView(FilesSettingsView(feature: self)) }
    }
}

// MARK: - Search Files view model

@MainActor @Observable final class FilesSearchModel {
    var query = ""
    var mode: FilesSearchMode = .name
    var results: [String] = []
    var selected = 0
    var loading = false
    var previewShown = true
    var recentsOnly = false
    @ObservationIgnored var pendingSelect: String?
    @ObservationIgnored weak var feature: FilesFeature?
    @ObservationIgnored weak var boundHost: LauncherViewHost?
    @ObservationIgnored var backend: (any FilesBackend)?
    @ObservationIgnored var initial = ""
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var lastKey = "\u{0}"

    var host: LauncherViewHost? {
        get { boundHost ?? LauncherHosts.current }
        set { boundHost = newValue }
    }

    var selectedPath: String? { results.indices.contains(selected) ? results[selected] : nil }

    func reset(initial: String, mode: FilesSearchMode, select: String? = nil, preview: Bool = true, recentsOnly: Bool = false) {
        self.initial = initial
        self.mode = mode
        self.recentsOnly = recentsOnly
        pendingSelect = select
        previewShown = preview || previewShown
        results = []
        selected = 0
        lastKey = "\u{0}"
    }

    /// The query typed in the launcher field (falls back to the argument the view was opened with).
    func update(query raw: String) {
        let text = raw.isEmpty ? initial : raw
        let (q, m) = FilesFeature.parse(text)
        let mode = text.lowercased().hasPrefix("content:") ? m : self.mode
        let key = "\(mode.rawValue):\(q)"
        guard key != lastKey else { return }
        lastKey = key
        Task { await run(query: q, mode: mode) }
    }

    func run(query q: String, mode m: FilesSearchMode) async {
        guard let f = feature else { return }
        query = q
        mode = m
        lastKey = "\(m.rawValue):\(q)"
        generation += 1
        let gen = generation
        if q.trimmingCharacters(in: .whitespaces).count < 2 || recentsOnly && q.isEmpty {
            backend?.stop()
            results = f.recents?.recent(limit: 30) ?? []
            if !q.isEmpty { results = results.filter { ($0 as NSString).lastPathComponent.localizedCaseInsensitiveContains(q) } }
            applySelect()
            loading = false
            return
        }
        if q.hasPrefix("~") || q.hasPrefix("/") {
            results = FilesFeature.browse(q, includeHidden: f.prefs.includeHidden, limit: 100)
            applySelect()
            return
        }
        let scopes = f.scopes
        if backend == nil { backend = f.makeBackend() }
        loading = true
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            var resumed = false
            backend?.start(text: q, mode: m, scopes: scopes, limit: 100) { [weak self] paths, used, finished in
                guard let self, gen == self.generation else {
                    if !resumed { resumed = true; cont.resume() }
                    return
                }
                let ex = f.exclusions
                let kept = paths.filter { !ex.excludes(path: $0, scopes: scopes) }
                let prev = self.selectedPath
                self.results = Array(FilesRanking.rank(kept, query: q, opened: f.recents?.opened ?? [:], lastUsed: used).prefix(100))
                if let prev, let i = self.results.firstIndex(of: prev) { self.selected = i } else { self.selected = min(self.selected, max(0, self.results.count - 1)) }
                self.applySelect()
                if finished {
                    self.loading = false
                    if !resumed { resumed = true; cont.resume() }
                }
            }
            if scopes.isEmpty {
                loading = false
                results = []
                if !resumed { resumed = true; cont.resume() }
            }
        }
    }

    private func applySelect() {
        if let p = pendingSelect, let i = results.firstIndex(of: p) { selected = i; pendingSelect = nil }
        if selected >= results.count { selected = max(0, results.count - 1) }
    }

    func remove(_ p: String) {
        results.removeAll { $0 == p }
        if selected >= results.count { selected = max(0, results.count - 1) }
    }

    func handleKey(_ k: VimKey) -> Bool {
        // Typed characters reach the query after this handler: re-read it on the next turn.
        defer { if let h = host { Task { @MainActor in self.update(query: h.query) } } }
        let shortcut = Self.shortcut(k)
        switch shortcut {
        case "ArrowDown", "⌃J", "⌃N": selected = min(results.count - 1, selected + 1); return true
        case "ArrowUp", "⌃K", "⌃P": selected = max(0, selected - 1); return true
        case "⌘Y": previewShown.toggle(); return true
        case "⌘T":
            mode = mode == .name ? .content : .name
            host?.setPlaceholder(mode == .content ? "Search file contents…" : "Search files…  (⌘T: name ⇄ content)")
            let q = query
            Task { await run(query: q, mode: mode) }
            return true
        default: break
        }
        let actions: [String: String] = ["Enter": "open", "⌘Enter": "reveal", "⌘O": "openWith", "⇧⌘C": "copyPath", "⇧⌘.": "copyFile", "⌃X": "trash"]
        guard let action = actions[shortcut] else { return false }
        guard let p = selectedPath, let f = feature else { return true }
        let h = host
        Task { @MainActor in f.perform(await f.fileAction(action, path: p, appPath: nil), host: h) }
        return true
    }

    static func shortcut(_ k: VimKey) -> String {
        var s = ""
        if k.ctrl { s += "⌃" }
        if k.alt { s += "⌥" }
        if k.shift { s += "⇧" }
        if k.meta { s += "⌘" }
        if k.key == "Enter" || k.key.hasPrefix("Arrow") { return s + k.key }
        return s + k.key.uppercased()
    }

    var json: JSONValue {
        ["query": .string(query), "mode": .string(mode.rawValue), "results": .array(results.map(JSONValue.string)), "selected": selectedPath.map(JSONValue.string) ?? .null,
         "preview": .bool(previewShown), "loading": .bool(loading)]
    }
}

// MARK: - Open With

@MainActor @Observable final class FilesOpenWithModel {
    struct App: Equatable { var name: String; var path: String }
    var path = ""
    var apps: [App] = []
    var selected = 0
    @ObservationIgnored weak var feature: FilesFeature?
    @ObservationIgnored weak var boundHost: LauncherViewHost?
    var host: LauncherViewHost? {
        get { boundHost ?? LauncherHosts.current }
        set { boundHost = newValue }
    }

    func load(path p: String) {
        path = p
        selected = 0
        let url = URL(fileURLWithPath: p)
        var seen = Set<String>()
        var list: [App] = []
        let def = NSWorkspace.shared.urlForApplication(toOpen: url)
        for u in ([def].compactMap { $0 } + NSWorkspace.shared.urlsForApplications(toOpen: url)) where seen.insert(u.path).inserted {
            list.append(App(name: FileManager.default.displayName(atPath: u.path).replacingOccurrences(of: ".app", with: ""), path: u.path))
        }
        apps = list
    }

    func filtered(_ filter: String) -> [App] { filter.isEmpty ? apps : apps.filter { $0.name.localizedCaseInsensitiveContains(filter) } }

    func handleKey(_ k: VimKey) -> Bool {
        let list = filtered(host?.query ?? "")
        switch FilesSearchModel.shortcut(k) {
        case "ArrowDown", "⌃J", "⌃N": selected = min(list.count - 1, selected + 1); return true
        case "ArrowUp", "⌃K", "⌃P": selected = max(0, selected - 1); return true
        case "Enter":
            guard list.indices.contains(selected), let f = feature else { return true }
            let app = list[selected].path, p = path, h = host
            Task { @MainActor in f.perform(await f.fileAction("openWith", path: p, appPath: app), host: h) }
            return true
        default: return false
        }
    }
}
