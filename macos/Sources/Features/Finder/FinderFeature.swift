import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Finder actions on the current selection (port of src/main/features/finder): Copy Path (POSIX / ~ / shell
/// arguments / file:// URL), Open Terminal Here, New File Here…, Move Selection to…, Compress Selection, Open
/// Selection With…. The selection comes from FinderService (Accessibility; Apple Events only when opted in).
/// Headless runs never touch files: plans are recorded as `[headless] finder.* / exec` lines.
@MainActor public final class FinderFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "finder"
    public let title = "Finder"
    private weak var context: FeatureContext?
    private weak var host: (any LauncherViewHost)?
    var runner: (any StepRunning)?
    let nav = SysListNav()
    let model = FinderModel()
    /// Headless test channel only (`setTestSelection`): replaces the Finder read.
    var testSelection: FinderSelectionResult?
    let home = NSHomeDirectory()
    static let appDirs = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
    static let defaults: [String: JSONValue] = ["terminal": "Terminal", "pathFormat": "posix", "automation": false, "recentDestinations": []]

    public init() {}

    var settings: [String: JSONValue] { context?.settings(defaults: Self.defaults) ?? Self.defaults }
    var terminal: String { settings["terminal"]?.stringValue.flatMap { FinderLogic.terminals.contains($0) ? $0 : nil } ?? "Terminal" }
    var pathFormat: FinderLogic.PathFormat { settings["pathFormat"]?.stringValue.flatMap(FinderLogic.PathFormat.init) ?? .posix }
    var recent: [String] { settings["recentDestinations"]?.arrayValue?.compactMap(\.stringValue) ?? [] }

    public func start(context: FeatureContext) async {
        self.context = context
        if runner == nil { runner = StepRunners.make(headless: context.services.isHeadless) }
    }

    struct Cmd { let id, title, symbol: String; let keywords: [String] }
    static let commands: [Cmd] = [
        Cmd(id: "copyPath", title: "Copy Path of Selection", symbol: "doc.on.clipboard", keywords: ["copy path", "finder", "file path", "selection", "pwd"]),
        Cmd(id: "terminal", title: "Open Terminal Here", symbol: "terminal", keywords: ["terminal", "iterm", "ghostty", "shell", "cd", "finder"]),
        Cmd(id: "newFile", title: "New File Here…", symbol: "doc.badge.plus", keywords: ["new file", "touch", "create file", "finder", "empty"]),
        Cmd(id: "move", title: "Move Selection to…", symbol: "folder.badge.gearshape", keywords: ["move", "mv", "relocate", "finder", "folder"]),
        Cmd(id: "compress", title: "Compress Selection", symbol: "doc.zipper", keywords: ["zip", "compress", "archive", "finder"]),
        Cmd(id: "openWith", title: "Open Selection With…", symbol: "arrow.up.forward.app", keywords: ["open with", "application", "finder"]),
    ]

    public func items() -> [SearchItem] {
        Self.commands.map { c in
            SearchItem(id: "finder:\(c.id)", kind: .command, title: c.title, subtitle: "Finder", icon: .symbol(c.symbol), keywords: c.keywords,
                       feature: id, data: ["command": .string(c.id)], kindLabel: "Finder")
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["command"]?.stringValue {
        case "copyPath":
            return [ItemAction(id: "run", title: "Copy Path", shortcut: "↩", icon: "doc.on.doc"),
                    ItemAction(id: "copy:tilde", title: "Copy Path with ~", shortcut: "⌘↩", icon: "house"),
                    ItemAction(id: "copy:quoted", title: "Copy as Shell Arguments", icon: "terminal"),
                    ItemAction(id: "copy:url", title: "Copy as file:// URL", icon: "link")]
        case "terminal":
            let others = FinderLogic.terminals.filter { $0 != terminal }
            return [ItemAction(id: "run", title: "Open in \(terminal)", shortcut: "↩", icon: "terminal")]
                + others.enumerated().map { i, t in ItemAction(id: "terminal:\(t)", title: "Open in \(t)", shortcut: i == 0 ? "⌘↩" : nil, icon: "terminal") }
        default: return [ItemAction(id: "run", title: "Run", shortcut: "↩", icon: "play.fill")]
        }
    }

    // MARK: selection

    func selection() async -> FinderSelectionResult {
        guard let ctx = context else { return .init(paths: [], folder: nil, source: "none", error: "Not ready") }
        if ctx.services.isHeadless, let t = testSelection { return t }
        var r = await ctx.services.finder.selection()
        if r.paths.isEmpty, settings["automation"]?.boolValue == true {
            let ae = await ctx.services.finder.selectionViaAutomation()
            if !ae.paths.isEmpty || ae.folder != nil { r = ae }
        }
        return r
    }

    func noSelection(_ s: FinderSelectionResult) -> ActionResult {
        .error(s.error.map { $0 == "headless" ? "Select one or more items in Finder first" : $0 } ?? "Select one or more items in Finder first")
    }

    func isDir(_ p: String) -> Bool {
        FinderLogic.isDir(p)
    }

    // MARK: commands

    func copyPaths(_ format: FinderLogic.PathFormat?) async -> ActionResult {
        let s = await selection()
        guard !s.paths.isEmpty else { return noSelection(s) }
        context?.services.pasteboard.setString(FinderLogic.formatPaths(s.paths, format ?? pathFormat, home: home), html: nil, transient: false)
        return .hide(message: s.paths.count == 1 ? "Copied path" : "Copied \(s.paths.count) paths")
    }

    func openTerminal(_ app: String?) async -> ActionResult {
        let s = await selection()
        guard let dir = FinderLogic.hereFolder(s.paths, folder: s.folder, isDir: isDir) else { return .error(s.error == "headless" ? "Open a Finder window first" : (s.error ?? "Open a Finder window first")) }
        let t = app ?? terminal
        do { try await runner?.runAll(FinderLogic.terminalSteps(t, dir: dir)) } catch { return .error("Could not open \(t): \(error.localizedDescription)") }
        return .hide()
    }

    func compress() async -> ActionResult {
        let s = await selection()
        guard !s.paths.isEmpty, let plan = FinderLogic.compressPlan(s.paths, taken: { FileManager.default.fileExists(atPath: $0) }) else { return noSelection(s) }
        do { try await runner?.runAll(plan.steps) } catch { return .error("Compression failed: \(error.localizedDescription)") }
        return .hide(message: "Created \((plan.output as NSString).lastPathComponent)")
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        if action.hasPrefix("copy:") { return await copyPaths(FinderLogic.PathFormat(rawValue: String(action.dropFirst(5)))) }
        if action.hasPrefix("terminal:") {
            let t = String(action.dropFirst(9))
            return FinderLogic.terminals.contains(t) ? await openTerminal(t) : .error("Unknown terminal")
        }
        guard action == "run" else { return .error("Unknown action \(action)") }
        switch scored.item.data?["command"]?.stringValue {
        case "copyPath": return await copyPaths(nil)
        case "terminal": return await openTerminal(nil)
        case "compress": return await compress()
        case "newFile":
            let s = await selection()
            guard let folder = FinderLogic.hereFolder(s.paths, folder: s.folder, isDir: isDir) else { return .error("Open a Finder window first") }
            model.folder = folder
            nav.reset()
            return .pushView("finder.newFile", payload: ["folder": .string(folder)])
        case "move":
            let s = await selection()
            guard !s.paths.isEmpty else { return noSelection(s) }
            model.paths = s.paths
            model.folder = s.folder
            nav.reset()
            return .pushView("finder.move", payload: ["paths": .array(s.paths.map(JSONValue.string))])
        case "openWith":
            let s = await selection()
            guard !s.paths.isEmpty else { return noSelection(s) }
            model.paths = s.paths
            nav.reset()
            return .pushView("finder.openWith", payload: ["paths": .array(s.paths.map(JSONValue.string))])
        default: return .error("Unknown command")
        }
    }

    func newFile(folder: String, name: String, open: Bool) -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        if let bad = FinderLogic.validateFileName(name) { return .error(bad) }
        if ctx.services.isHeadless {
            HeadlessRecord.line("finder.newFile", ["folder": .string(folder), "name": .string(name.trimmingCharacters(in: .whitespaces)), "open": .bool(open)])
            return .hide(message: "Created \(name)")
        }
        switch FinderLogic.createEmptyFile(folder: folder, name: name) {
        case let .failure(e): return .error(e.localizedDescription)
        case let .success(p):
            if open { _ = ctx.services.workspace.open(path: p) } else { ctx.services.workspace.reveal(path: p) }
            return .hide(message: "Created \((p as NSString).lastPathComponent)")
        }
    }

    func move(_ paths: [String], to dest: String) -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        ctx.setSettings(["recentDestinations": .array(([dest] + recent.filter { $0 != dest }).prefix(8).map(JSONValue.string))])
        if ctx.services.isHeadless {
            let plan = FinderLogic.movePlan(paths, dest: dest) { FileManager.default.fileExists(atPath: $0) }
            HeadlessRecord.line("finder.move", ["paths": .array(paths.map(JSONValue.string)), "dest": .string(dest),
                                                "moves": .array(plan.moves.map { ["from": .string($0.from), "to": .string($0.to)] }),
                                                "conflicts": .array(plan.conflicts.map(JSONValue.string))])
            return plan.conflicts.isEmpty ? .hide(message: "Moved \(plan.moves.count) item\(plan.moves.count == 1 ? "" : "s")") : .error(plan.conflicts.joined(separator: "; "))
        }
        let r = FinderLogic.moveItems(paths, dest: dest)
        return r.ok ? .hide(message: "Moved \(r.moved) item\(r.moved == 1 ? "" : "s") to \((dest as NSString).lastPathComponent)") : .error(r.error ?? "Move failed")
    }

    func openWith(app: String, paths: [String]) async -> ActionResult {
        do { try await runner?.runAll(FinderLogic.openWithSteps(app, paths: paths)) } catch { return .error(error.localizedDescription) }
        return .hide()
    }

    // MARK: pushed views

    private var appsCache: (at: Date, apps: [(name: String, path: String)])?
    func apps() -> [(name: String, path: String)] {
        if let c = appsCache, Date().timeIntervalSince(c.at) < 60 { return c.apps }
        let a = FinderLogic.listApps(Self.appDirs)
        appsCache = (Date(), a)
        return a
    }

    func rows(view: String, query: String) -> [ScoredItem] {
        switch view {
        case "move":
            return FinderLogic.destinations(query: query, base: model.folder, home: home, recent: recent).map { d in
                .row(SearchItem(id: "dest:\(d.path)", kind: .file, title: d.name, subtitle: d.path, icon: .file(d.path), path: d.path, feature: id,
                                kindLabel: ["typed": "Folder", "recent": "Recent", "place": "Place", "child": "Folder"][d.kind] ?? "Folder"))
            }
        case "openWith":
            return sysFilter(apps(), query: query, text: \.name).map { a, r in
                .row(SearchItem(id: "app:\(a.path)", kind: .app, title: a.name, icon: .app(a.path), path: a.path, feature: id, kindLabel: "Application"), ranges: r)
            }
        default: return []
        }
    }

    func activate(view: String, index: Int, mods: ActionModifiers) {
        let q = n3Host(host)?.query ?? ""
        let r: ActionResult
        switch view {
        case "newFile":
            r = newFile(folder: model.folder ?? home, name: q, open: mods.contains(.command))
        case "move":
            let list = rows(view: view, query: q)
            guard index < list.count, let p = list[index].item.path else { return }
            r = move(model.paths, to: p)
        case "openWith":
            let list = rows(view: view, query: q)
            guard index < list.count, let p = list[index].item.path else { return }
            let paths = model.paths
            Task { @MainActor in deliver(await openWith(app: p, paths: paths)) }
            return
        default: return
        }
        deliver(r)
    }

    func deliver(_ r: ActionResult) {
        guard let ctx = context else { return }
        switch r {
        case let .hide(m):
            n3Host(host)?.pop() // done: back to root for the next show
            ctx.hideLauncher()
            if let m { ctx.toast(m, style: .success) }
        case let .error(m): ctx.toast(m, style: .error)
        case let .stay(m): if let m { ctx.toast(m, style: .info) }
        default: break
        }
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        guard view.feature == id else { return false }
        let q = n3Host(host)?.query ?? ""
        let count = view.name == "newFile" ? 0 : rows(view: view.name, query: q).count
        nav.sync(query: q, count: count)
        switch nav.apply(command, count: count) {
        case .moved: return true
        case let .activate(m): activate(view: view.name, index: nav.index, mods: m); return true
        case .secondary: activate(view: view.name, index: nav.index, mods: .command); return true
        case .actions, .delete, .copy: return true
        case nil: return false
        }
    }

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        self.host = host
        if let f = payload["folder"]?.stringValue, model.folder == nil { model.folder = f }
        if let p = payload["paths"]?.arrayValue?.compactMap(\.stringValue), model.paths.isEmpty { model.paths = p }
        switch vid.name {
        case "newFile":
            let bad = host.query.isEmpty ? nil : FinderLogic.validateFileName(host.query)
            return AnyView(FinderNewFileView(folder: model.folder ?? home, name: host.query, problem: bad)
                .onAppear {
                    host.setPlaceholder("File name, e.g. notes.md")
                    host.setFooter(primary: "Create & Reveal", hasActions: false)
                })
        case "move", "openWith":
            let list = rows(view: vid.name, query: host.query)
            nav.sync(query: host.query, count: list.count)
            let header = vid.name == "move" ? "Move \(FinderLogic.describeSelection(model.paths)) to" : "Open \(FinderLogic.describeSelection(model.paths)) with"
            return AnyView(SysRowsView(header: header, rows: list, selected: nav.index, emptySymbol: "folder", emptyTitle: "No matches",
                                       emptySubtitle: vid.name == "move" ? "Type a path starting with / or ~" : nil) { [weak self] i in
                self?.activate(view: vid.name, index: i, mods: [])
            }
            .onAppear {
                host.setPlaceholder(vid.name == "move" ? "Destination folder (type / or ~ for a path)…" : "Search applications…")
                host.setFooter(primary: vid.name == "move" ? "Move Here" : "Open", hasActions: false)
            })
        default: return nil
        }
    }

    // MARK: test channel

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "selection":
            let s = await selection()
            return ["paths": .array(s.paths.map(JSONValue.string)), "folder": s.folder.map(JSONValue.string) ?? .null, "error": s.error.map(JSONValue.string) ?? .null]
        case "setTestSelection":
            guard context?.services.isHeadless == true else { return false }
            testSelection = .init(paths: args["paths"]?.arrayValue?.compactMap(\.stringValue) ?? [], folder: args["folder"]?.stringValue, source: "test", error: nil)
            return true
        case "destinations":
            return .array(FinderLogic.destinations(query: args["query"]?.stringValue ?? "", base: args["base"]?.stringValue, home: home, recent: recent)
                .map { ["path": .string($0.path), "name": .string($0.name), "kind": .string($0.kind)] })
        case "setSettings":
            var next: [String: JSONValue] = [:]
            if let t = args["terminal"]?.stringValue, FinderLogic.terminals.contains(t) { next["terminal"] = .string(t) }
            if let f = args["pathFormat"]?.stringValue, FinderLogic.PathFormat(rawValue: f) != nil { next["pathFormat"] = .string(f) }
            if let a = args["automation"]?.boolValue { next["automation"] = .bool(a) }
            context?.setSettings(next)
            return .object(settings)
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Finder", symbol: "folder", order: 45) { [weak self] in AnyView(FinderSettingsView(feature: self)) }
    }

    func setSetting(_ k: String, _ v: JSONValue) { context?.setSettings([k: v]) }
}

@MainActor @Observable final class FinderModel {
    var folder: String?
    var paths: [String] = []
}

struct FinderNewFileView: View {
    @Environment(\.glideTheme) private var theme
    let folder: String
    let name: String
    let problem: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("New file in")
            HStack(spacing: 10) {
                ItemIconView(.file(folder), size: 28)
                Text(folder).font(.system(size: 13)).foregroundStyle(theme.text).lineLimit(1).truncationMode(.middle)
            }
            .padding(.horizontal, 12)
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(theme.warning).padding(.horizontal, 12)
            } else if !name.isEmpty {
                Text("↩ creates “\(name)” and reveals it · ⌘↩ creates and opens it").font(.system(size: 12)).foregroundStyle(theme.text2).padding(.horizontal, 12)
            }
            Spacer()
        }
    }
}

struct FinderSettingsView: View {
    weak var feature: FinderFeature?
    @State private var terminal = "Terminal"
    @State private var format = "posix"
    @State private var automation = false
    var body: some View {
        Form {
            Picker("Terminal", selection: $terminal) { ForEach(FinderLogic.terminals, id: \.self) { Text($0) } }
                .onChange(of: terminal) { _, v in feature?.setSetting("terminal", .string(v)) }
            Picker("Copy Path format", selection: $format) {
                Text("/Users/me/file").tag("posix")
                Text("~/file").tag("tilde")
                Text("Shell arguments").tag("quoted")
                Text("file:// URL").tag("url")
            }
            .onChange(of: format) { _, v in feature?.setSetting("pathFormat", .string(v)) }
            Toggle("Ask Finder via Apple Events when Accessibility can’t read the selection", isOn: $automation)
                .onChange(of: automation) { _, v in feature?.setSetting("automation", .bool(v)) }
            Text("Apple Events shows a one-time Automation prompt the first time it is used.").font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .onAppear {
            terminal = feature?.terminal ?? "Terminal"
            format = feature?.pathFormat.rawValue ?? "posix"
            automation = feature?.settings["automation"]?.boolValue == true
        }
    }
}
