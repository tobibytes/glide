import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Window Layouts & Workspaces (port of src/main/features/layouts). A layout snapshots every visible standard
/// window; restoring matches live windows by app + title, then order (LayoutsLogic). A workspace bundles a
/// layout with apps to launch, apps to quit (always confirmed in the launcher first), links, a Focus session,
/// a Shortcut and a note. Data: <userData>/features/layouts/layouts.json (shared with the Electron app).
@MainActor public final class LayoutsFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "layouts"
    public let title = "Window Layouts"
    private weak var context: FeatureContext?
    private(set) var store: LayoutStore?
    private weak var host: (any LauncherViewHost)?
    let nav = SysListNav()
    let model = LayoutsViewModel()
    var hideDelay: Duration = .milliseconds(80)
    /// Overridable in tests.
    var runner: (any StepRunning)?

    public init() {}

    static let defaults: [String: JSONValue] = ["relaunchMissingApps": false, "launchTimeoutSec": 10]
    var relaunchMissing: Bool { context?.settings(defaults: Self.defaults)["relaunchMissingApps"]?.boolValue == true }
    var launchTimeoutSec: Int { min(60, max(2, context?.settings(defaults: Self.defaults)["launchTimeoutSec"]?.intValue ?? 10)) }

    public func start(context: FeatureContext) async {
        self.context = context
        store = LayoutStore(directory: context.dataDirectory())
        runner = StepRunners.make(headless: context.services.isHeadless)
    }

    func engine() -> LayoutsEngine? {
        guard let ctx = context else { return nil }
        return LayoutsEngine(service: ctx.services.layouts) { [weak ctx] app in
            guard let ctx else { return .failure("Not ready") }
            if let p = app.path, FileManager.default.fileExists(atPath: p) { return ctx.services.workspace.launchApplication(p) }
            return ctx.services.workspace.launchApplication(app.bundleId)
        }
    }

    static func layoutItemId(_ id: String) -> String { "layouts.layout.\(id)" }
    static func workspaceItemId(_ id: String) -> String { "layouts.workspace.\(id)" }

    public func items() -> [SearchItem] {
        var out = [
            SearchItem(id: "layouts.save", kind: .command, title: "Save Window Layout", subtitle: "Window Layouts", icon: .symbol("square.and.arrow.down.on.square"),
                       keywords: ["layout", "windows", "snapshot", "arrangement"], feature: id, data: ["action": "save"], kindLabel: "Layouts"),
            SearchItem(id: "layouts.list", kind: .command, title: "Window Layouts", subtitle: "Restore, update and manage layouts & workspaces", icon: .symbol("rectangle.3.group"),
                       keywords: ["workspaces", "restore", "layout"], feature: id, data: ["action": "list"], kindLabel: "Layouts"),
            SearchItem(id: "layouts.new-workspace", kind: .command, title: "Create Workspace", subtitle: "Window Layouts", icon: .symbol("briefcase"),
                       keywords: ["workspace", "layout", "project", "context"], feature: id, data: ["action": "new-workspace"], kindLabel: "Layouts"),
        ]
        guard let s = store else { return out }
        out += s.layouts.map { l in
            SearchItem(id: Self.layoutItemId(l.id), kind: .command, title: "Restore Layout \(l.name)", subtitle: LayoutsLogic.describe(l), icon: .symbol("macwindow.on.rectangle"),
                       keywords: ["layout", "windows", l.name] + LayoutsLogic.apps(l).map(\.name), feature: id,
                       data: ["action": "restore", "layoutId": .string(l.id)], kindLabel: "Layout")
        }
        out += s.workspaces.map { w in
            SearchItem(id: Self.workspaceItemId(w.id), kind: .command, title: "Open Workspace \(w.name)", subtitle: LayoutsLogic.workspaceSubtitle(w, layouts: s.layouts),
                       icon: .symbol("briefcase.fill"), keywords: ["workspace", w.name], feature: id,
                       data: ["action": "workspace", "workspaceId": .string(w.id)], kindLabel: "Workspace")
        }
        return out
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "save": return [ItemAction(id: "save", title: "Save Window Layout", shortcut: "↩", icon: "square.and.arrow.down"),
                             ItemAction(id: "settings", title: "Window Layout Settings…", icon: "gearshape")]
        case "list": return [ItemAction(id: "list", title: "Show Layouts", shortcut: "↩", icon: "rectangle.3.group")]
        case "new-workspace": return [ItemAction(id: "new-workspace", title: "Create Workspace", shortcut: "↩", icon: "briefcase")]
        case "restore": return [
            ItemAction(id: "restore", title: "Restore Layout", shortcut: "↩", icon: "macwindow"),
            ItemAction(id: "restore-relaunch", title: "Restore & Launch Missing Apps", shortcut: "⌘↩", icon: "arrow.up.forward.app"),
            ItemAction(id: "update", title: "Update with Current Windows", icon: "square.and.arrow.down"),
            ItemAction(id: "list", title: "Show Layouts", icon: "rectangle.3.group"),
            ItemAction(id: "open-accessibility", title: "Open Accessibility Settings", icon: "lock.shield"),
        ]
        case "workspace": return [ItemAction(id: "workspace", title: "Open Workspace", shortcut: "↩", icon: "briefcase"),
                                  ItemAction(id: "edit-workspace", title: "Edit Workspace…", shortcut: "⌘↩", icon: "pencil")]
        default: return []
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let d = scored.item.data ?? [:]
        switch action {
        case "save":
            nav.reset()
            model.preview = nil
            return .pushView("layouts.save")
        case "list":
            nav.reset()
            return .pushView("layouts.list")
        case "settings", "new-workspace", "edit-workspace":
            model.pendingEdit = action == "new-workspace" ? "new" : (action == "edit-workspace" ? d["workspaceId"]?.stringValue : nil)
            return .openSettings(page: id)
        case "open-accessibility": return SettingsPanes.open(SettingsPanes.accessibility, context)
        case "restore", "restore-relaunch":
            return await restore(d["layoutId"]?.stringValue ?? "", relaunch: action == "restore-relaunch" ? true : nil)
        case "update":
            await hideFirst()
            do {
                let l = try await saveLayout(name: nil, overwriteId: d["layoutId"]?.stringValue)
                return .hide(message: "Updated \(l.name): \(LayoutsLogic.describe(l))")
            } catch { return .error(error.localizedDescription) }
        case "workspace": return await openWorkspace(d["workspaceId"]?.stringValue ?? "")
        default: return .error("Unknown layout action")
        }
    }

    // MARK: operations

    func hideFirst() async {
        context?.hideLauncher()
        if hideDelay > .zero { try? await Task.sleep(for: hideDelay) }
    }

    func changed() { context?.refreshCatalogue() }

    @discardableResult
    func saveLayout(name: String?, overwriteId: String?) async throws -> WindowLayout {
        guard let s = store, let e = engine() else { throw FeatureError.failed("Window layouts are not ready") }
        let existing = overwriteId.flatMap { s.layout($0) }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = !trimmed.isEmpty ? trimmed : (existing?.name ?? "Layout \(s.layouts.count + 1)")
        var l = try await e.captureLayout(name: title, id: existing?.id)
        if let existing { l.createdAt = existing.createdAt }
        s.put(l)
        changed()
        return l
    }

    func restore(_ layoutId: String, relaunch: Bool?) async -> ActionResult {
        guard let l = store?.layout(layoutId), let e = engine() else { return .error("That layout no longer exists") }
        await hideFirst()
        let r = await e.restore(l, relaunch: relaunch ?? relaunchMissing, launchTimeout: .seconds(launchTimeoutSec))
        return r.ok ? .hide(message: r.summary(l.name)) : .error(r.summary(l.name))
    }

    func quitCandidates(_ ws: Workspace) -> [AppRef] {
        guard let e = engine() else { return [] }
        let running = e.runningBundleIds()
        return ws.quitApps.filter { running.contains($0.bundleId) }
    }

    /// Entry point for items and hotkeys: quitting apps is confirmed in the launcher first.
    func openWorkspace(_ id: String) async -> ActionResult {
        guard let ws = store?.workspace(id) else { return .error("That workspace no longer exists") }
        if !quitCandidates(ws).isEmpty {
            nav.reset()
            model.confirmWorkspace = ws.id
            return .pushView("layouts.confirm", payload: ["workspaceId": .string(ws.id)])
        }
        return await finishWorkspace(ws, quit: false)
    }

    struct WorkspaceReport { var steps: [String] = []; var errors: [String] = [] }

    func runWorkspace(_ ws: Workspace, quit: Bool) async -> WorkspaceReport {
        var report = WorkspaceReport()
        guard let ctx = context, let e = engine() else { report.errors.append("Not ready"); return report }
        await hideFirst()
        if quit {
            let ids = quitCandidates(ws).map(\.bundleId)
            if !ids.isEmpty {
                let r = ctx.services.layouts.quit(bundleIds: ids)
                let n = r["asked"]?.arrayValue?.count ?? 0
                report.steps.append("asked \(n) app\(n == 1 ? "" : "s") to quit")
            }
        }
        let running = e.runningBundleIds()
        var launched: [String] = []
        for app in ws.launchApps {
            let r = e.launch(app)
            if r.ok { if !running.contains(app.bundleId) { launched.append(app.bundleId) } } else { report.errors.append("\(app.name): \(r.error ?? "could not open")") }
        }
        if !ws.launchApps.isEmpty { report.steps.append("opened \(ws.launchApps.count) app\(ws.launchApps.count == 1 ? "" : "s")") }
        for u in ws.urls {
            let r: ServiceResult
            if u.hasPrefix("/") || u.hasPrefix("~/") { r = ctx.services.workspace.open(path: (u as NSString).expandingTildeInPath) }
            else if let url = URL(string: u) { r = ctx.services.workspace.open(url: url) } else { r = .failure("Invalid link") }
            if !r.ok { report.errors.append("\(u): \(r.error ?? "could not open")") }
        }
        if !ws.urls.isEmpty { report.steps.append("opened \(ws.urls.count) link\(ws.urls.count == 1 ? "" : "s")") }
        if let sc = ws.shortcut, let runner {
            do {
                try await runner.runAll([CommandStep(cmd: "/usr/bin/shortcuts", args: ["run", sc])])
                report.steps.append("ran “\(sc)”")
            } catch { report.errors.append("Shortcut “\(sc)”: \(error.localizedDescription)") }
        }
        if let f = ws.focus {
            do {
                let r = try await ctx.callFeature("focus", method: "start", args: ["goal": .string(f.goal), "minutes": .int(Int64(f.minutes))])
                if r["ok"]?.boolValue == false { report.errors.append("Focus: \(r["error"]?.stringValue ?? "could not start")") } else { report.steps.append("focus \(f.minutes) min") }
            } catch { report.errors.append("Focus: \(error.localizedDescription)") }
        }
        if let lid = ws.layoutId, let l = store?.layout(lid) {
            let apps = Set(LayoutsLogic.apps(l).map(\.bundleId))
            let r = await e.restore(l, relaunch: ws.relaunchLayoutApps, launchTimeout: .seconds(launchTimeoutSec), alsoWaitFor: launched.filter { apps.contains($0) })
            if r.ok { report.steps.append("\(r.moved)/\(r.total) windows placed") } else { report.errors.append(r.error ?? "Layout failed") }
        }
        if let n = ws.noteId {
            do { _ = try await ctx.callFeature("notes", method: "open", args: ["id": .string(n)]) } catch { report.errors.append("Note: \(error.localizedDescription)") }
        }
        return report
    }

    func finishWorkspace(_ ws: Workspace, quit: Bool) async -> ActionResult {
        let r = await runWorkspace(ws, quit: quit)
        let text = "\(ws.name): \(r.steps.isEmpty ? "nothing to do" : r.steps.joined(separator: " · "))"
        if !r.errors.isEmpty { return .error("\(text). Problems: \(r.errors.joined(separator: "; "))") }
        return .hide(message: text)
    }

    func saveWorkspace(_ raw: JSONValue) throws -> Workspace {
        guard let s = store else { throw FeatureError.failed("Not ready") }
        let now = Date().timeIntervalSince1970 * 1000
        var o = raw.objectValue ?? [:]
        let wid = o["id"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? LayoutsLogic.newId("ws", now: now)
        o["id"] = .string(wid)
        o["createdAt"] = .double(s.workspace(wid)?.createdAt ?? now)
        o["updatedAt"] = .double(now)
        guard var ws = LayoutsCodec.workspace(.object(o)) else { throw FeatureError.invalidArguments("A workspace needs a name") }
        if let l = ws.layoutId, s.layout(l) == nil { ws.layoutId = nil }
        s.put(ws)
        changed()
        return ws
    }

    /// Feed an ActionResult produced inside a pushed view back to the launcher.
    func deliver(_ r: ActionResult) {
        guard let ctx = context else { return }
        switch r {
        case let .hide(m):
            n3Host(host)?.pop() // done: back to root for the next show
            ctx.hideLauncher()
            if let m { ctx.toast(m, style: .success) }
        case let .stay(m): if let m { ctx.toast(m, style: .info) }
        case let .error(m): ctx.toast(m, style: .error)
        case let .pushView(v, p): ctx.push(v, payload: p)
        case let .openSettings(p): ctx.openSettings(page: p)
        }
    }

    // MARK: test channel

    func state() -> JSONValue {
        let s = store ?? LayoutStore(directory: URL(fileURLWithPath: "/nonexistent"))
        return [
            "layouts": .array(s.layouts.sorted { $0.updatedAt > $1.updatedAt }.map { l in
                var o = LayoutsCodec.json(l).objectValue ?? [:]
                o["summary"] = .string(LayoutsLogic.describe(l))
                o["itemId"] = .string(Self.layoutItemId(l.id))
                return .object(o)
            }),
            "workspaces": .array(s.workspaces.sorted { $0.name < $1.name }.map { w in
                var o = LayoutsCodec.json(w).objectValue ?? [:]
                o["summary"] = .string(LayoutsLogic.workspaceSubtitle(w, layouts: s.layouts))
                o["itemId"] = .string(Self.workspaceItemId(w.id))
                return .object(o)
            }),
            "settings": ["relaunchMissingApps": .bool(relaunchMissing), "launchTimeoutSec": .int(Int64(launchTimeoutSec))],
        ]
    }

    func result(_ r: ActionResult) -> JSONValue {
        switch r {
        case let .error(m): return ["ok": false, "error": .string(m)]
        case let .hide(m), let .stay(m): return ["ok": true, "message": m.map(JSONValue.string) ?? .null]
        case let .pushView(v, p): return ["ok": true, "view": .string(v.rawValue), "payload": p]
        case .openSettings: return ["ok": true]
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        let str = args.stringValue ?? args["id"]?.stringValue ?? ""
        switch method {
        case "state": return state()
        case "save":
            let l = try await saveLayout(name: args["name"]?.stringValue, overwriteId: args["overwriteId"]?.stringValue)
            return LayoutsCodec.json(l)
        case "restore": return result(await restore(str, relaunch: args["relaunch"]?.boolValue))
        case "rename":
            guard var l = store?.layout(str), let n = args["name"]?.stringValue?.trimmingCharacters(in: .whitespaces), !n.isEmpty else { return false }
            l.name = n
            l.updatedAt = Date().timeIntervalSince1970 * 1000
            store?.put(l)
            changed()
            return true
        case "deleteLayout":
            store?.deleteLayout(str)
            changed()
            return true
        case "saveWorkspace": return LayoutsCodec.json(try saveWorkspace(args))
        case "deleteWorkspace":
            store?.deleteWorkspace(str)
            changed()
            return true
        case "quitCandidates":
            guard let ws = store?.workspace(str) else { return [] }
            return .array(quitCandidates(ws).map(LayoutsCodec.json))
        case "openWorkspace": return result(await openWorkspace(str))
        case "runWorkspace":
            guard let ws = store?.workspace(str) else { return ["ok": false, "error": "That workspace no longer exists"] }
            return result(await finishWorkspace(ws, quit: args["quit"]?.boolValue == true))
        case "setSettings":
            var clean: [String: JSONValue] = [:]
            if let b = args["relaunchMissingApps"]?.boolValue { clean["relaunchMissingApps"] = .bool(b) }
            if let n = args["launchTimeoutSec"]?.doubleValue, n.isFinite { clean["launchTimeoutSec"] = .int(Int64(min(60, max(2, n.rounded())))) }
            context?.setSettings(clean)
            return state()
        case "runningApps": return context?.services.layouts.runningApps() ?? []
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    // MARK: launcher views

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        self.host = host
        switch vid.name {
        case "save": return AnyView(LayoutSaveView(feature: self, query: host.query, host: host))
        case "list":
            let rows = listRows(query: host.query)
            nav.sync(query: host.query, count: rows.count)
            return AnyView(SysRowsView(header: "Layouts & Workspaces", rows: rows, selected: nav.index, emptySymbol: "rectangle.3.group",
                                       emptyTitle: store?.layouts.isEmpty == false || store?.workspaces.isEmpty == false ? "No matches" : "No layouts yet",
                                       emptySubtitle: "Save one with “Save Window Layout”") { [weak self] i in self?.activateList(i, mods: []) }
                .onAppear {
                    host.setPlaceholder("Search layouts and workspaces…")
                    host.setFooter(primary: "Restore", hasActions: true)
                })
        case "confirm":
            let wsId = payload["workspaceId"]?.stringValue ?? model.confirmWorkspace ?? ""
            let ws = store?.workspace(wsId)
            let apps = ws.map(quitCandidates) ?? []
            return AnyView(WorkspaceConfirmView(name: ws?.name ?? "Workspace", apps: apps)
                .onAppear {
                    host.setPlaceholder("Open \(ws?.name ?? "workspace")?")
                    host.setFooter(primary: "Quit Apps & Open", hasActions: false)
                })
        default: return nil
        }
    }

    func listRows(query: String) -> [ScoredItem] {
        guard let s = store else { return [] }
        let all = items().filter { $0.id.hasPrefix("layouts.layout.") || $0.id.hasPrefix("layouts.workspace.") }
        return sysFilter(all, query: query, text: \.title, keywords: { $0.keywords ?? [] }).map { ScoredItem.row($0.0, ranges: $0.1) }
            .filter { _ in !s.layouts.isEmpty || !s.workspaces.isEmpty }
    }

    func activateList(_ i: Int, mods: ActionModifiers) {
        let rows = listRows(query: n3Host(host)?.query ?? "")
        guard i < rows.count else { return }
        let item = rows[i]
        let actionId: String
        switch item.item.data?["action"]?.stringValue {
        case "restore": actionId = mods.contains(.command) ? "restore-relaunch" : "restore"
        default: actionId = mods.contains(.command) ? "edit-workspace" : "workspace"
        }
        Task { @MainActor in deliver(await run(action: actionId, on: item, modifiers: mods)) }
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        let q = n3Host(host)?.query ?? ""
        switch view.name {
        case "list":
            let rows = listRows(query: q)
            nav.sync(query: q, count: rows.count)
            switch nav.apply(command, count: rows.count) {
            case .moved: return true
            case let .activate(m): activateList(nav.index, mods: m); return true
            case .secondary: activateList(nav.index, mods: .command); return true
            case .delete:
                guard nav.index < rows.count else { return true }
                let row = rows[nav.index]
                Task { @MainActor in await self.deleteRow(row) }
                return true
            case .actions, .copy: return true
            case nil: return false
            }
        case "save":
            if case .activate = command {
                Task { @MainActor in
                    await hideFirst()
                    do {
                        let l = try await saveLayout(name: q, overwriteId: nil)
                        deliver(.hide(message: "Saved \(l.name): \(LayoutsLogic.describe(l))"))
                    } catch { context?.showLauncher(); deliver(.error(error.localizedDescription)) }
                }
                return true
            }
            return command.isNavigation
        case "confirm":
            return confirmCommand(command)
        default: return false
        }
    }

    func confirmCommand(_ command: VimCommand) -> Bool {
        guard let wsId = model.confirmWorkspace, let ws = store?.workspace(wsId) else { return false }
        switch command {
        case .activate:
            Task { @MainActor in deliver(await finishWorkspace(ws, quit: true)) }
            return true
        case .secondary:
            Task { @MainActor in deliver(await finishWorkspace(ws, quit: false)) }
            return true
        default: return command.isNavigation
        }
    }

    func deleteRow(_ row: ScoredItem) async {
        guard let ctx = context else { return }
        let isLayout = row.item.data?["action"]?.stringValue == "restore"
        let name = row.item.title
        guard await ctx.services.confirmation.confirm(title: "Delete", message: "Delete “\(name)”?", confirmButton: "Delete") else { return }
        if isLayout { store?.deleteLayout(row.item.data?["layoutId"]?.stringValue ?? "") } else { store?.deleteWorkspace(row.item.data?["workspaceId"]?.stringValue ?? "") }
        changed()
        ctx.toast("Deleted \(name)", style: .success)
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Window Layouts", symbol: "rectangle.3.group", order: 41) { [weak self] in
            AnyView(LayoutsSettingsView(feature: self))
        }
    }
}

/// Small state shared by the views (not persisted).
@MainActor @Observable final class LayoutsViewModel {
    var preview: [LiveWindow]?
    var pendingEdit: String?
    var confirmWorkspace: String?
}

struct LayoutSaveView: View {
    @Environment(\.glideTheme) private var theme
    let feature: LayoutsFeature?
    let query: String
    let host: LauncherViewHost
    @State private var preview: [LiveWindow] = []
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader("Windows that will be saved", trailing: preview.isEmpty ? nil : "\(preview.count)")
            if let error {
                EmptyState(symbol: "exclamationmark.triangle", title: "Nothing to save", subtitle: error)
            } else if preview.isEmpty {
                EmptyState(symbol: "macwindow", title: "No windows", subtitle: "Open some app windows, then save")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(preview, id: \.ref) { w in
                            ResultRow(.row(SearchItem(id: "w\(w.ref)", kind: .command, title: w.title.isEmpty ? w.appName : w.title, subtitle: w.appName,
                                                      icon: w.appPath.map(ItemIcon.app) ?? .symbol("macwindow"), kindLabel: "\(Int(w.frame.width))×\(Int(w.frame.height))")),
                                      selected: false)
                        }
                    }
                    .padding(.horizontal, 8)
                }
            }
            Spacer(minLength: 0)
            Text(query.isEmpty ? "Type a name, then ↩ to save" : "↩ saves “\(query)”").font(.system(size: 12)).foregroundStyle(theme.text3).padding(10)
        }
        .onAppear {
            host.setPlaceholder("Name this layout…")
            host.setFooter(primary: "Save Layout", hasActions: false)
        }
        .task {
            guard let e = feature?.engine() else { return }
            do { preview = try await e.captureLayout(name: "Preview").windows.enumerated().map { i, w in
                LiveWindow(ref: i, bundleId: w.bundleId, appName: w.appName, appPath: w.appPath, title: w.title, frame: w.frame, display: w.display, order: w.order)
            } } catch { self.error = error.localizedDescription }
        }
    }
}

struct WorkspaceConfirmView: View {
    @Environment(\.glideTheme) private var theme
    let name: String
    let apps: [AppRef]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader("\(name) will ask these apps to quit")
            ForEach(apps, id: \.bundleId) { a in
                ResultRow(.row(SearchItem(id: a.bundleId, kind: .app, title: a.name, subtitle: a.bundleId,
                                          icon: (a.path ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: a.bundleId)?.path).map(ItemIcon.app) ?? .symbol("app"), kindLabel: "Quit")), selected: false)
                    .padding(.horizontal, 8)
            }
            Spacer(minLength: 0)
            HStack(spacing: 14) {
                HStack(spacing: 5) { Kbd("↩"); Text("Quit & open") }
                HStack(spacing: 5) { Kbd("⌘↩"); Text("Open without quitting") }
                HStack(spacing: 5) { Kbd("Esc"); Text("Cancel") }
            }
            .font(.system(size: 12)).foregroundStyle(theme.text2).padding(12)
        }
    }
}

// MARK: - settings

struct LayoutsSettingsView: View {
    weak var feature: LayoutsFeature?
    @State private var layouts: [WindowLayout] = []
    @State private var workspaces: [Workspace] = []
    @State private var relaunch = false
    @State private var timeout = 10
    @State private var editing: Workspace?
    @State private var running: [AppRef] = []

    var body: some View {
        Form {
            Section("Restoring") {
                Toggle("Launch apps that aren’t running", isOn: $relaunch).onChange(of: relaunch) { _, v in set(["relaunchMissingApps": .bool(v)]) }
                Stepper("Wait up to \(timeout) s for launched apps", value: $timeout, in: 2...60).onChange(of: timeout) { _, v in set(["launchTimeoutSec": .int(Int64(v))]) }
            }
            Section("Layouts") {
                if layouts.isEmpty { Text("No layouts yet — use “Save Window Layout” in the launcher.").foregroundStyle(.secondary) }
                ForEach(layouts) { l in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(l.name)
                            Text(LayoutsLogic.describe(l)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Delete", role: .destructive) { call("deleteLayout", .string(l.id)) }
                    }
                }
            }
            Section {
                ForEach(workspaces) { w in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(w.name)
                            Text(LayoutsLogic.workspaceSubtitle(w, layouts: layouts)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Edit") { editing = w }
                        Button("Delete", role: .destructive) { call("deleteWorkspace", .string(w.id)) }
                    }
                }
                Button("New Workspace…") { editing = .blank(id: "", now: 0) }
            } header: { Text("Workspaces") }
        }
        .formStyle(.grouped)
        .onAppear(perform: reload)
        .sheet(item: $editing) { ws in
            WorkspaceEditor(workspace: ws, layouts: layouts, running: running) { saved in
                call("saveWorkspace", LayoutsCodec.json(saved))
                editing = nil
            } cancel: { editing = nil }
        }
    }

    private func reload() {
        guard let f = feature, let s = f.store else { return }
        layouts = s.layouts
        workspaces = s.workspaces.sorted { $0.name < $1.name }
        relaunch = f.relaunchMissing
        timeout = f.launchTimeoutSec
        running = (f.engine()?.service.runningApps().arrayValue ?? []).compactMap(LayoutsCodec.appRef)
        if let p = f.model.pendingEdit {
            f.model.pendingEdit = nil
            editing = p == "new" ? .blank(id: "", now: 0) : s.workspace(p)
        }
    }

    private func set(_ patch: [String: JSONValue]) { call("setSettings", .object(patch)) }
    private func call(_ m: String, _ a: JSONValue) {
        Task { @MainActor in
            _ = try? await feature?.invoke(method: m, args: a)
            reload()
        }
    }
}

struct WorkspaceEditor: View {
    @State var workspace: Workspace
    let layouts: [WindowLayout]
    let running: [AppRef]
    let save: (Workspace) -> Void
    let cancel: () -> Void
    @State private var urls = ""
    @State private var focusOn = false
    @State private var focusGoal = ""
    @State private var focusMinutes = 25
    @State private var shortcut = ""

    var body: some View {
        VStack(spacing: 0) {
            Form {
                TextField("Name", text: $workspace.name)
                Picker("Layout", selection: $workspace.layoutId) {
                    Text("None").tag(String?.none)
                    ForEach(layouts) { Text($0.name).tag(Optional($0.id)) }
                }
                Toggle("Launch the layout’s apps when needed", isOn: $workspace.relaunchLayoutApps)
                Section("Open apps") { appPicker($workspace.launchApps) }
                Section("Quit apps (asks first)") { appPicker($workspace.quitApps) }
                Section("Links and folders (one per line)") { TextEditor(text: $urls).frame(minHeight: 60).font(.system(.body, design: .monospaced)) }
                Section("Extras") {
                    Toggle("Start a Focus session", isOn: $focusOn)
                    if focusOn {
                        TextField("Goal", text: $focusGoal)
                        Stepper("\(focusMinutes) minutes", value: $focusMinutes, in: 5...240, step: 5)
                    }
                    TextField("Run Shortcut (name)", text: $shortcut)
                }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                Button("Save") {
                    var w = workspace
                    w.urls = urls.split(whereSeparator: \.isNewline).compactMap { LayoutsCodec.normalizeURL(String($0)) }
                    w.focus = focusOn ? .init(goal: focusGoal, minutes: focusMinutes) : nil
                    w.shortcut = shortcut.trimmingCharacters(in: .whitespaces).isEmpty ? nil : shortcut
                    save(w)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(workspace.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
        }
        .frame(width: 520, height: 600)
        .onAppear {
            urls = workspace.urls.joined(separator: "\n")
            focusOn = workspace.focus != nil
            focusGoal = workspace.focus?.goal ?? ""
            focusMinutes = workspace.focus?.minutes ?? 25
            shortcut = workspace.shortcut ?? ""
        }
    }

    @ViewBuilder private func appPicker(_ list: Binding<[AppRef]>) -> some View {
        ForEach(list.wrappedValue, id: \.bundleId) { a in
            HStack {
                Text(a.name)
                Spacer()
                Button { list.wrappedValue.removeAll { $0.bundleId == a.bundleId } } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
            }
        }
        Menu("Add Running App") {
            ForEach(running.filter { r in !list.wrappedValue.contains { $0.bundleId == r.bundleId } }, id: \.bundleId) { a in
                Button(a.name) { list.wrappedValue.append(a) }
            }
        }
    }
}
