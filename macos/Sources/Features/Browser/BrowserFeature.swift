import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Browser bookmarks & history search (src/main/features/browser): Chromium (Bookmarks JSON + History SQLite),
/// Firefox/Zen (places.sqlite) and Safari (only when Full Disk Access already exists; never prompts). History is
/// off by default. Everything stays in memory; a background refresh rebuilds the index. Logs carry counts only,
/// never titles or URLs. Headless runs read nothing unless GLIDE_BROWSER_HOME points at a fixture home.
@MainActor public final class BrowserFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "browser"
    public let title = "Browser"
    private weak var context: FeatureContext?
    private(set) var index: [IndexedEntry] = []
    private(set) var profiles: [BrowserProfile] = []
    private(set) var statuses: [ProfileStatus] = []
    private(set) var lastRefresh: Double = 0
    private var refreshing: Task<Void, Never>?
    private var timer: Timer?
    private var appPaths: [String: String] = [:]
    /// Explicit home (tests); else GLIDE_BROWSER_HOME (headless) or the real home (not headless).
    var homeOverride: String?

    struct ProfileStatus: Codable, Sendable {
        var key: String
        var browserId: String
        var browserName: String
        var name: String
        var enabled: Bool
        var bookmarks: Int
        var history: Int
        var error: String?
    }

    lazy var bookmarksModel = N7ListModel(placeholder: "Search bookmarks…", emptyTitle: "No bookmarks found",
                                          emptySubtitle: "Chrome, Arc, Brave, Edge, Vivaldi, Firefox, Safari (with Full Disk Access)") { [weak self] q in self?.rows(q, type: "bookmark") ?? [] }
    lazy var historyModel = N7ListModel(placeholder: "Search browser history…", emptyTitle: "No history",
                                        emptySubtitle: "History search is off — enable it in Settings → Browser") { [weak self] q in self?.rows(q, type: "history") ?? [] }

    public init() {}

    var home: String? {
        if let homeOverride { return homeOverride }
        if context?.services.isHeadless ?? true { return ProcessInfo.processInfo.environment["GLIDE_BROWSER_HOME"] }
        return NSHomeDirectory()
    }

    struct Settings: Equatable {
        var bookmarks = true
        var history = false
        var historyDays = 90
        var refreshMinutes = 10
        var rootSearch = true
        var disabledProfiles: [String] = []
    }

    var settings: Settings {
        let s = context?.settings(defaults: [:]) ?? [:]
        func num(_ k: String, _ d: Int, _ lo: Int, _ hi: Int) -> Int { s[k]?.number.map { min(hi, max(lo, Int($0.rounded()))) } ?? d }
        return Settings(bookmarks: s["bookmarks"]?.boolValue != false, history: s["history"]?.boolValue == true, historyDays: num("historyDays", 90, 1, 3650),
                        refreshMinutes: num("refreshMinutes", 10, 1, 1440), rootSearch: s["rootSearch"]?.boolValue != false,
                        disabledProfiles: (s["disabledProfiles"]?.arrayValue ?? []).compactMap(\.stringValue))
    }

    public func start(context: FeatureContext) async {
        self.context = context
        // Let the launcher come up first.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(context.services.isHeadless ? 50 : 1500))
            await self?.refresh()
        }
        schedule()
    }

    public func stop() async { timer?.invalidate() }

    private func schedule() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Double(settings.refreshMinutes) * 60, repeats: true) { [weak self] _ in Task { @MainActor in await self?.refresh() } }
    }

    struct Snapshot: Sendable {
        var index: [IndexedEntry]
        var statuses: [ProfileStatus]
        var profiles: [BrowserProfile]
        var apps: [String: String]
    }

    /// Reads every enabled profile off the main thread.
    nonisolated static func read(home: String, settings s: Settings, now: Double) -> Snapshot {
        let profiles = BrowserData.discoverProfiles(home: home)
        let safari = BrowserData.safariAccess(home: home)
        var apps: [String: String] = [:]
        for b in BrowserDef.all { if let p = BrowserData.findApp(home: home, b) { apps[b.id] = p } }
        var all: [IndexedEntry] = []
        var statuses: [ProfileStatus] = []
        let since = ((now - Double(s.historyDays) * 86_400_000) / 86_400_000).rounded(.down) * 86_400_000
        for p in profiles {
            let enabled = !s.disabledProfiles.contains(p.key)
            var st = ProfileStatus(key: p.key, browserId: p.browser.id, browserName: p.browser.name, name: p.name, enabled: enabled, bookmarks: 0, history: 0)
            defer { statuses.append(st) }
            guard enabled else { continue }
            if p.browser.engine == .safari && safari != "ok" {
                st.error = safari == "denied" ? "Needs Full Disk Access" : "No Safari data"
                continue
            }
            var entries: [BrowserEntry] = []
            var errors: [String] = []
            if s.bookmarks, let f = p.bookmarksFile {
                do {
                    let bm: [BrowserEntry]
                    switch p.browser.engine {
                    case .chromium: bm = BrowserData.parseChromiumBookmarks(try Data(contentsOf: URL(fileURLWithPath: f)))
                    case .firefox: bm = BrowserData.firefoxBookmarks(try BrowserSQLite.queryCopy(f, [BrowserData.firefoxBookmarksSQL]).first ?? [])
                    case .safari: bm = BrowserData.parseSafariBookmarks(try Data(contentsOf: URL(fileURLWithPath: f)))
                    }
                    st.bookmarks = bm.count
                    entries += bm
                } catch {
                    errors.append("Bookmarks: \(errText(error))")
                }
            }
            if s.history, let f = p.historyFile {
                do {
                    let sql = BrowserData.historyQuery(p.browser.engine, limit: 5000, sinceMs: since)
                    let hi = BrowserData.historyEntries(p.browser.engine, rows: try BrowserSQLite.queryCopy(f, [sql]).first ?? [])
                    st.history = hi.count
                    entries += hi
                } catch {
                    errors.append("History: \(errText(error))")
                }
            }
            all += BrowserSearch.index(entries, profile: p.key, browser: p.browser.id)
            if !errors.isEmpty { st.error = errors.joined(separator: " · ") }
        }
        return Snapshot(index: BrowserSearch.dedupe(all), statuses: statuses, profiles: profiles, apps: apps)
    }

    nonisolated static func errText(_ e: Error) -> String {
        let ns = e as NSError
        if ns.domain == NSCocoaErrorDomain && (ns.code == NSFileReadNoPermissionError) || (ns.underlyingErrors.first as NSError?)?.code == Int(EPERM) { return "No access (needs Full Disk Access)" }
        if ns.code == NSFileReadNoSuchFileError { return "Not found" }
        return e.localizedDescription.components(separatedBy: "\n").first ?? "Error"
    }

    func refresh() async {
        if let r = refreshing { return await r.value }
        let task = Task { @MainActor in
            guard let home = self.home else {
                self.index = []
                self.statuses = []
                self.context?.log("browser data not read (headless run without GLIDE_BROWSER_HOME)")
                return
            }
            let s = self.settings
            let now = Date().timeIntervalSince1970 * 1000
            let snap = await Task.detached(priority: .utility) { BrowserFeature.read(home: home, settings: s, now: now) }.value
            self.index = snap.index
            self.statuses = snap.statuses
            self.profiles = snap.profiles
            self.appPaths = snap.apps
            self.lastRefresh = now
            let bm = snap.index.filter { $0.entry.type == "bookmark" }.count
            self.context?.log("indexed \(bm) bookmarks, \(snap.index.count - bm) history entries from \(snap.statuses.filter(\.enabled).count) profiles")
            self.bookmarksModel.changed()
            self.historyModel.changed()
        }
        refreshing = task
        await task.value
        refreshing = nil
    }

    // MARK: rows / search

    struct Row {
        var type: String
        var title: String
        var url: String
        var host: String
        var folder: String?
        var visitCount: Int?
        var lastVisit: Double?
        var profile: String
        var browserName: String
        var profileName: String
        var appPath: String?
    }

    func toRow(_ e: IndexedEntry) -> Row {
        let p = profiles.first { $0.key == e.profile }
        return Row(type: e.entry.type, title: e.entry.title, url: e.entry.url, host: e.host, folder: e.entry.folder, visitCount: e.entry.visitCount, lastVisit: e.entry.lastVisit,
                   profile: e.profile, browserName: p?.browser.name ?? e.browser, profileName: p.map { $0.name != $0.browser.name ? $0.name : "" } ?? "", appPath: appPaths[e.browser])
    }

    func search(_ query: String, type: String?, limit: Int) -> [Row] {
        if type == "history" && !settings.history { return [] }
        return BrowserSearch.search(index, query, limit: limit, type: type).map { toRow($0.0) }
    }

    func rowItem(_ r: Row, score: Double) -> ScoredItem {
        let where_ = [r.host, r.folder, "\(r.browserName)\(r.profileName.isEmpty ? "" : " (\(r.profileName))")"].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        let item = SearchItem(id: "browser:\(r.type):\(r.url)", kind: .command, title: r.title, subtitle: where_,
                              icon: r.appPath.map { .app($0) } ?? .symbol(r.type == "bookmark" ? "bookmark" : "clock.arrow.circlepath", tint: "#0A84FF"),
                              keywords: [r.host] + r.host.split(separator: ".").map(String.init), feature: id,
                              data: ["action": "entry", "url": .string(r.url), "profile": .string(r.profile), "browserName": .string(r.browserName), "noUsage": true],
                              kindLabel: r.type == "bookmark" ? "Bookmark" : "History")
        return ScoredItem(item: item, score: score, matchScore: score, matchKind: .keyword)
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        let s = settings
        if let hist = BrowserSearch.historyPrefix(query.text) {
            guard s.history, !hist.isEmpty else { return [] }
            return BrowserSearch.search(index, hist, limit: 8, type: "history").enumerated().map { i, r in rowItem(toRow(r.0), score: 300 - Double(i)) }
        }
        let q = query.trimmed
        guard s.rootSearch, q.count >= 2 else { return [] }
        return BrowserSearch.search(index, q, limit: 5, type: "bookmark").filter { $0.1 >= 40 }.enumerated().map { i, r in rowItem(toRow(r.0), score: 200 - Double(i)) }
    }

    public func items() -> [SearchItem] {
        [SearchItem(id: "browser:bookmarks", kind: .command, title: "Search Bookmarks", subtitle: "Chrome, Arc, Brave, Edge, Firefox, Safari…", icon: .symbol("bookmark", tint: "#0A84FF"),
                    keywords: ["bookmarks", "browser", "favorites", "links", "chrome", "arc", "safari", "firefox"], acceptsArgument: true, feature: id,
                    data: ["action": "view", "view": "browser.bookmarks"], kindLabel: "Command"),
         SearchItem(id: "browser:history", kind: .command, title: "Search Browser History", subtitle: settings.history ? "Recently visited pages" : "Off · enable in Settings → Browser",
                    icon: .symbol("clock.arrow.circlepath", tint: "#0A84FF"), keywords: ["history", "browser", "visited", "recent pages"], acceptsArgument: true, feature: id,
                    data: ["action": "view", "view": "browser.history"], kindLabel: "Command")]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        if item.data?["action"]?.stringValue == "view" {
            return [.init(id: "view", title: "Open", shortcut: "↩", icon: "magnifyingglass"), .init(id: "settings", title: "Browser Settings", shortcut: "⌘,", icon: "gearshape")]
        }
        let name = item.data?["browserName"]?.stringValue ?? "Browser"
        return [.init(id: "open", title: "Open in \(name)", shortcut: "↩", icon: "safari"), .init(id: "openDefault", title: "Open in Default Browser", shortcut: "⌘↩", icon: "globe"),
                .init(id: "copy", title: "Copy URL", shortcut: "⇧⌘C", icon: "doc.on.doc"), .init(id: "copyMd", title: "Copy as Markdown Link", shortcut: "⇧⌘M", icon: "link")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let d = scored.item.data ?? [:]
        let url = d["url"]?.stringValue ?? ""
        switch action {
        case "view":
            let v = ViewID(rawValue: d["view"]?.stringValue ?? "browser.bookmarks")
            let m = v.name == "history" ? historyModel : bookmarksModel
            n7AfterUpdate { m.syncHost() }
            return .pushView(v)
        case "settings": return .openSettings(page: id)
        case "open": return open(url, profile: d["profile"]?.stringValue, mode: "browser")
        case "openDefault": return open(url, profile: nil, mode: "default")
        case "copy":
            context?.services.pasteboard.setString(url, html: nil, transient: false)
            return .hide(message: "URL copied")
        case "copyMd":
            context?.services.pasteboard.setString(Self.markdown(scored.item.title, url), html: nil, transient: false)
            return .hide(message: "Markdown link copied")
        default: return .error("Unknown action \(action)")
        }
    }

    static func markdown(_ title: String, _ url: String) -> String { "[\(title.replacingOccurrences(of: "[", with: "").replacingOccurrences(of: "]", with: ""))](\(url))" }

    /// In the entry's browser (and profile, for Chromium browsers that honour --profile-directory) or the default one.
    func open(_ url: String, profile: String?, mode: String) -> ActionResult {
        guard let u = URL(string: url) else { return .error("Invalid URL") }
        if mode == "default" && url.range(of: "^(https?|file|ftp):", options: [.regularExpression, .caseInsensitive]) == nil {
            return .error("Only web and file URLs can open in the default browser")
        }
        guard let ctx = context else { return .error("Not ready") }
        guard mode == "browser", let p = profiles.first(where: { $0.key == profile }) else {
            let r = ctx.services.workspace.open(url: u)
            return r.ok ? .hide() : .error(r.error ?? "Could not open")
        }
        if p.browser.profileArg && !ctx.services.isHeadless, let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: p.browser.bundleId) {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.arguments = ["--profile-directory=\(p.dir)", url]
            cfg.createsNewApplicationInstance = false
            NSWorkspace.shared.openApplication(at: app, configuration: cfg) { _, _ in }
            return .hide()
        }
        let r = ctx.services.workspace.open(url: u, withApp: p.browser.bundleId)
        return r.ok ? .hide() : .error(r.error ?? "Could not open \(p.browser.name)")
    }

    func rows(_ query: String, type: String) -> [N7Row] {
        search(query, type: type, limit: 80).map { r in
            let sub = [r.host, r.folder, r.type == "history" ? r.lastVisit.map { N7Format.relative($0, now: Date().timeIntervalSince1970 * 1000) } : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            return N7Row(id: "\(r.type):\(r.profile):\(r.url)", section: type == "bookmark" ? "Bookmarks" : "History", icon: r.appPath.map { .app($0) } ?? .symbol("globe"),
                         title: r.title, subtitle: sub, trailing: "\(r.browserName)\(r.profileName.isEmpty ? "" : " (\(r.profileName))")", actions: [
                             N7Action("open", "Open in \(r.browserName)", shortcut: "↩", icon: "safari") { [weak self] in self?.finish(self?.open(r.url, profile: r.profile, mode: "browser")) },
                             N7Action("openDefault", "Open in Default Browser", shortcut: "⌘↩", icon: "globe") { [weak self] in self?.finish(self?.open(r.url, profile: nil, mode: "default")) },
                             N7Action("copy", "Copy URL", shortcut: "⇧⌘C", icon: "doc.on.doc") { [weak self] in
                                 self?.context?.services.pasteboard.setString(r.url, html: nil, transient: false)
                                 LauncherHosts.current?.toast("URL copied", style: .success)
                             },
                             N7Action("copyMd", "Copy as Markdown Link", shortcut: "⇧⌘M", icon: "link") { [weak self] in
                                 self?.context?.services.pasteboard.setString(Self.markdown(r.title, r.url), html: nil, transient: false)
                                 LauncherHosts.current?.toast("Markdown link copied", style: .success)
                             },
                         ])
        }
    }

    private func finish(_ r: ActionResult?) {
        switch r {
        case .hide?: LauncherHosts.current?.close()
        case let .error(e)?: LauncherHosts.current?.toast(e, style: .error)
        default: break
        }
    }

    private func model(_ v: ViewID) -> N7ListModel? { v.name == "bookmarks" ? bookmarksModel : v.name == "history" ? historyModel : nil }

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard let m = model(id) else { return nil }
        n7AfterUpdate { m.syncHost() }
        return AnyView(N7ListView(model: m))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { model(view)?.handleKey(key) ?? false }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { model(view)?.handle(command) ?? false }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Browser", symbol: "safari", order: 122) { [weak self] in
            AnyView(BrowserSettingsView(settings: self?.settings ?? Settings(), profiles: self?.statuses ?? [], safari: self?.home.map(BrowserData.safariAccess) ?? "missing") { patch in
                Task { await self?.setSettings(patch) }
            } openFDA: {
                if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") { _ = self?.context?.services.workspace.open(url: u) }
            })
        }
    }

    func setSettings(_ p: [String: JSONValue]) async {
        let before = settings
        var clean: [String: JSONValue] = [:]
        for k in ["bookmarks", "history", "favicons", "rootSearch"] { if let b = p[k]?.boolValue { clean[k] = .bool(b) } }
        if let v = p["historyDays"]?.number, v >= 1 { clean["historyDays"] = .int(Int64(min(3650, v.rounded()))) }
        if let v = p["refreshMinutes"]?.number, v >= 1 { clean["refreshMinutes"] = .int(Int64(min(1440, v.rounded()))) }
        if let a = p["disabledProfiles"]?.arrayValue { clean["disabledProfiles"] = .array(a.filter { $0.stringValue != nil }) }
        context?.setSettings(clean)
        let after = settings
        if before.refreshMinutes != after.refreshMinutes { schedule() }
        if before.history != after.history { context?.refreshCatalogue() }
        if before != after {
            // Drop history from memory immediately when it is turned off.
            if !after.history { index.removeAll { $0.entry.type == "history" } }
            await refreshing?.value
            await refresh()
        }
    }

    func status() -> JSONValue {
        let bm = index.filter { $0.entry.type == "bookmark" }.count
        let s = settings
        return ["settings": ["bookmarks": .bool(s.bookmarks), "history": .bool(s.history), "historyDays": .int(Int64(s.historyDays)), "refreshMinutes": .int(Int64(s.refreshMinutes)),
                             "rootSearch": .bool(s.rootSearch), "disabledProfiles": .array(s.disabledProfiles.map(JSONValue.string))],
                "profiles": N7JSON.value(statuses), "safari": .string(home.map(BrowserData.safariAccess) ?? "missing"), "lastRefresh": .double(lastRefresh),
                "refreshing": .bool(refreshing != nil), "backend": "sqlite3-c", "totals": ["bookmarks": .int(Int64(bm)), "history": .int(Int64(index.count - bm)), "favicons": 0]]
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "status": return status()
        case "search":
            let t = args["type"]?.stringValue ?? args["kind"]?.stringValue
            let limit = min(500, max(1, args["limit"]?.intValue ?? 80))
            return .array(search(args["query"]?.stringValue ?? args.stringValue ?? "", type: t == "history" || t == "bookmark" ? t : nil, limit: limit).map { r in
                ["type": .string(r.type), "title": .string(r.title), "url": .string(r.url), "host": .string(r.host), "folder": r.folder.map(JSONValue.string) ?? .null,
                 "profile": .string(r.profile), "browserName": .string(r.browserName), "profileName": .string(r.profileName)]
            })
        case "refresh":
            await refresh()
            return status()
        case "setSettings":
            await setSettings(args.objectValue ?? [:])
            return status()
        case "open":
            let r = open(args["url"]?.stringValue ?? "", profile: args["profile"]?.stringValue, mode: args["mode"]?.stringValue == "default" ? "default" : "browser")
            if case let .error(e) = r { return ["ok": false, "error": .string(e)] }
            return ["ok": true]
        case "copy":
            context?.services.pasteboard.setString(args["text"]?.stringValue ?? args.stringValue ?? "", html: nil, transient: false)
            return true
        case "viewState": return model(ViewID(feature: id, name: args["view"]?.stringValue ?? "bookmarks"))?.snapshot() ?? .null
        case "viewAction": return .bool(await model(ViewID(feature: id, name: args["view"]?.stringValue ?? "bookmarks"))?.run(actionId: args["id"]?.stringValue ?? "") ?? false)
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

struct BrowserSettingsView: View {
    @State var settings: BrowserFeature.Settings
    let profiles: [BrowserFeature.ProfileStatus]
    let safari: String
    let onChange: ([String: JSONValue]) -> Void
    let openFDA: () -> Void
    var body: some View {
        Form {
            Section("Search") {
                Toggle("Bookmarks", isOn: $settings.bookmarks).onChange(of: settings.bookmarks) { _, v in onChange(["bookmarks": .bool(v)]) }
                Toggle("Show bookmarks in the root search", isOn: $settings.rootSearch).onChange(of: settings.rootSearch) { _, v in onChange(["rootSearch": .bool(v)]) }
                Toggle("Browser history (kept in memory only)", isOn: $settings.history).onChange(of: settings.history) { _, v in onChange(["history": .bool(v)]) }
                Stepper("History: last \(settings.historyDays) days", value: $settings.historyDays, in: 1...3650, step: 30).onChange(of: settings.historyDays) { _, v in onChange(["historyDays": .int(Int64(v))]) }
                Stepper("Refresh every \(settings.refreshMinutes) min", value: $settings.refreshMinutes, in: 1...1440).onChange(of: settings.refreshMinutes) { _, v in onChange(["refreshMinutes": .int(Int64(v))]) }
            }
            Section("Profiles") {
                if profiles.isEmpty { N7SettingsNote(text: "No browser profiles found.") }
                ForEach(profiles, id: \.key) { p in
                    Toggle(isOn: Binding(get: { !settings.disabledProfiles.contains(p.key) }, set: { on in
                        if on { settings.disabledProfiles.removeAll { $0 == p.key } } else { settings.disabledProfiles.append(p.key) }
                        onChange(["disabledProfiles": .array(settings.disabledProfiles.map(JSONValue.string))])
                    })) {
                        VStack(alignment: .leading) {
                            Text("\(p.browserName)\(p.name != p.browserName ? " — \(p.name)" : "")")
                            Text(p.error ?? "\(p.bookmarks) bookmarks · \(p.history) history").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section("Safari") {
                LabeledContent("Access", value: safari == "ok" ? "Readable" : safari == "denied" ? "Needs Full Disk Access" : "No Safari data")
                if safari == "denied" { Button("Open Full Disk Access Settings…", action: openFDA) }
            }
        }
        .formStyle(.grouped)
    }
}
