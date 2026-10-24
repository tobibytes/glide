import AppKit
import Foundation
import GlideCore
import GlideSystem
import GlideUI
import Observation
import SwiftUI

/// Extensions (Glide + Raycast-compatible) on JavaScriptCore, the Store and Manage Extensions.
/// Feature id "extensions" and data dir `<userData>/features/extensions/` match the Electron app.
@MainActor public final class ExtensionsFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "extensions"
    public let title = "Extensions"
    static let defaults: [String: JSONValue] = ["storeUrl": ""]

    private(set) weak var context: FeatureContext?
    private(set) var registry: ExtensionRegistry?
    private(set) var store: StoreService?
    private var sessions: [String: ExtensionSession] = [:]
    private var runModels: [String: RunModel] = [:]
    private var formModels: [String: FieldsFormModel] = [:]
    private var listModels: [String: SimpleListModel] = [:]
    /// Tokens of the views this feature pushed, bottom → top.
    private(set) var tokenStack: [String] = []
    /// HUDs, toasts and other effects (inspected by tests and the test channel).
    private(set) var effects: [JSONValue] = []
    private var seq = 0
    private var sweeper: Task<Void, Never>?
    private var hud: HUDWindow?
    /// Overrides for tests (fetch transport, exec policy).
    var hostOptions: JSHost.Options?
    var examplesDirOverride: URL?
    /// Raycast menu-bar commands on the shared status-item API (MenuBar/ExtensionMenuBarHost.swift).
    lazy var menuBar = ExtensionMenuBarHost(feature: self)
    /// OAuth sign-ins waiting for glide://oauth (PKCEClient.authorize) and the tokens extensions saved.
    let oauthFlows = OAuthFlows()
    private(set) var tokens = ExtensionTokenStore(backend: MemoryTokenBackend())
    /// Tests: where tokens go (default: Keychain, memory in headless runs).
    var tokenBackendOverride: ExtensionTokenBackend?
    /// AI streams (AIFeature askStream ids) per session, cancelled when the session ends.
    private var aiStreams: [String: Set<String>] = [:]

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        tokens = ExtensionTokenStore(backend: tokenBackendOverride ?? (context.services.isHeadless ? MemoryTokenBackend() : KeychainTokenBackend()))
        let base = context.dataDirectory()
        let reg = ExtensionRegistry(base: base)
        registry = reg
        store = StoreService(StoreService.Deps(
            registry: reg, dataDir: base, examplesDir: examplesDir(), localIndex: localIndex(), indexURL: { [weak self] in self?.indexURL() ?? StoreClient.defaultIndexURL },
            mayFetch: { [weak context] url in
                context?.services.isHeadless == true && url == StoreClient.defaultIndexURL ? "Headless runs never fetch the public store index" : nil
            },
            changed: { [weak self] in self?.changed() },
            beforeUninstall: { [weak self] name in
                self?.stopSessions(of: name)
                self?.tokens.clear(name)
            },
            log: { [weak context] in context?.log($0) }))
        observeQuery()
        menuBar.start()
        sweeper = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                self?.sweep()
            }
        }
    }

    public func stop() async {
        sweeper?.cancel()
        oauthFlows.cancelAll()
        menuBar.stopAll()
        for s in sessions.values { s.kill() }
        sessions = [:]
    }

    // MARK: paths

    func examplesDir() -> URL? {
        if let o = examplesDirOverride { return o }
        let fm = FileManager.default
        if let p = ProcessInfo.processInfo.environment["GLIDE_EXAMPLES_DIR"], fm.fileExists(atPath: p) { return URL(fileURLWithPath: p) }
        if let r = Bundle.main.resourceURL?.appendingPathComponent("extensions-examples"), fm.fileExists(atPath: r.path) { return r }
        return Self.devCheckout()?.appendingPathComponent("extensions-examples")
    }

    func localIndex() -> URL? {
        let fm = FileManager.default
        if let r = Bundle.main.resourceURL?.appendingPathComponent("store/index.json"), fm.fileExists(atPath: r.path) { return r }
        guard examplesDirOverride == nil else { return nil }
        return Self.devCheckout().map { $0.appendingPathComponent("store/index.json") }.flatMap { fm.fileExists(atPath: $0.path) ? $0 : nil }
    }

    /// The Electron checkout this native build lives in (development builds).
    static func devCheckout() -> URL? {
        var d = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            if FileManager.default.fileExists(atPath: d.appendingPathComponent("extensions-examples").path) { return d }
            d.deleteLastPathComponent()
        }
        return nil
    }

    func indexURL() -> String {
        let s = context?.settings(defaults: Self.defaults)["storeUrl"]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
        if !s.isEmpty { return s }
        if let e = ProcessInfo.processInfo.environment["GLIDE_STORE_URL"], !e.isEmpty { return e }
        return StoreClient.defaultIndexURL
    }

    private func changed() {
        registry?.invalidate()
        context?.refreshCatalogue()
        menuBar.sync() // installed / removed / disabled menu-bar commands
    }

    private func nextToken() -> String {
        seq += 1
        return "\(seq)"
    }

    // MARK: catalogue

    static let manageItem = SearchItem(id: "ext:manage", kind: .command, title: "Manage Extensions", subtitle: "Enable, disable, update or uninstall extensions",
                                       icon: .symbol("puzzlepiece.extension"), keywords: ["extensions", "plugins", "installed", "uninstall", "update"],
                                       feature: "extensions", data: ["type": "manage"], kindLabel: "Extensions")
    static let storeItem = SearchItem(id: "ext:store", kind: .command, title: "Store", subtitle: "Browse Extensions", icon: .symbol("bag"),
                                      keywords: ["browse extensions", "extension store", "install extension", "plugins"], feature: "extensions",
                                      data: ["type": "store"], kindLabel: "Extensions")

    public func items() -> [SearchItem] {
        var out = [Self.manageItem, Self.storeItem]
        for ext in registry?.list() ?? [] where ext.enabled {
            guard let m = ext.manifest else { continue }
            let assets = ext.dir.appendingPathComponent("assets").path
            for cmd in m.commands {
                out.append(SearchItem(id: "ext:\(ext.name):\(cmd.name)", kind: .command, title: cmd.title, subtitle: menuBar.subtitle(ext.name, cmd.name) ?? cmd.subtitle ?? m.title,
                                      icon: extIcon(cmd.icon ?? m.icon, assets: assets) ?? extIcon(m.icon, assets: assets) ?? .symbol("puzzlepiece.extension"),
                                      keywords: cmd.keywords + [m.title] + (cmd.description.map { [$0] } ?? []),
                                      acceptsArgument: cmd.arguments.isEmpty ? nil : true, feature: id,
                                      data: ["type": "command", "ext": .string(ext.name), "command": .string(cmd.name)], kindLabel: "Extension"))
            }
        }
        return out
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["type"]?.stringValue {
        case "command":
            var list = [ItemAction(id: "run", title: "Run Command", shortcut: "↩", icon: "play")]
            if let ext = registry?.get(item.data?["ext"]?.stringValue ?? ""), !(ext.manifest?.preferences.isEmpty ?? true) {
                list.append(ItemAction(id: "preferences", title: "Configure Extension", shortcut: "⌘,", icon: "gearshape"))
            }
            if let ext = registry?.get(item.data?["ext"]?.stringValue ?? ""), let cmd = ext.manifest?.commands.first(where: { $0.name == item.data?["command"]?.stringValue }),
               cmd.mode == "menu-bar" {
                let on = menuBar.isEnabled(ExtensionMenuBarHost.key(ext.name, cmd.name))
                list.append(ItemAction(id: on ? "background-off" : "background-on", title: on ? "Deactivate Menu Bar Item" : "Activate Menu Bar Item",
                                       icon: on ? "stop.circle" : "menubar.arrow.up.rectangle"))
            }
            list.append(ItemAction(id: "manage", title: "Manage Extensions", icon: "puzzlepiece.extension"))
            list.append(ItemAction(id: "disable", title: "Disable Extension", icon: "pause.circle", destructive: true))
            return list
        case "store": return [ItemAction(id: "open", title: "Browse Extensions", shortcut: "↩", icon: "bag")]
        default: return [ItemAction(id: "open", title: "Manage Extensions", shortcut: "↩", icon: "puzzlepiece.extension")]
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let item = scored.item
        let type = item.data?["type"]?.stringValue
        if type == "manage" || action == "manage" { return pushManage() }
        if type == "store" { return await pushStore() }
        let ext = item.data?["ext"]?.stringValue ?? ""
        let cmd = item.data?["command"]?.stringValue ?? ""
        switch action {
        case "preferences": return pushPreferences(ext, then: nil)
        case "background-on", "background-off":
            menuBar.setEnabled(ext, cmd, action == "background-on")
            return .stay(message: action == "background-on" ? "Menu bar item activated" : "Menu bar item deactivated")
        case "disable":
            do { try registry?.setEnabled(ext, false) } catch { return .error(error.localizedDescription) }
            changed()
            return .stay(message: "Extension disabled")
        default: return await runCommand(ext, cmd, argumentText: scored.argument)
        }
    }

    // MARK: running commands

    private func options() -> JSHost.Options {
        if let o = hostOptions { return o }
        var o = JSHost.Options()
        if context?.services.isHeadless == true { o.execDenied = "child_process is disabled in headless mode" }
        o.appleScript = { [weak self] source in
            guard let self else { return .failure(ExtensionError("Glide is shutting down")) }
            return await self.runAppleScript(source)
        }
        return o
    }

    private func runAppleScript(_ source: String) async -> Result<String, Error> {
        guard let scripts = context?.services.scripts else { return .failure(ExtensionError("AppleScript is not available")) }
        do { return .success(try await scripts.runAppleScript(source)) } catch { return .failure(error) }
    }

    /// Starts a command: preferences / arguments forms first when needed; view commands push their view.
    func runCommand(_ extName: String, _ cmdName: String, argumentText: String? = nil, arguments: [String: String]? = nil,
                    launchType: String = "userInitiated", launchContext: JSONValue = .null) async -> ActionResult {
        guard let reg = registry, let ext = reg.get(extName), let m = ext.manifest else { return .error("Extension \(extName) is not installed or is invalid") }
        guard ext.enabled else { return .error("\(m.title) is disabled (Manage Extensions to enable it)") }
        guard let cmd = m.commands.first(where: { $0.name == cmdName }) else { return .error("Unknown command \(cmdName)") }
        let saved = reg.preferences(extName)
        let background = launchType == "background"
        if !Manifest.missingPreferences(m, saved: saved, command: cmd.name).isEmpty {
            if background { return .error("\(cmd.title) needs its preferences set before it can run in the background") }
            return pushPreferences(extName, then: (cmdName, argumentText))
        }
        var args = arguments ?? Manifest.splitArguments(cmd.arguments, argumentText)
        for a in cmd.arguments where args[a.name] == nil { args[a.name] = "" }
        if cmd.arguments.contains(where: { $0.required && (args[$0.name] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }) {
            if background { return .error("\(cmd.title) needs arguments") }
            return pushArguments(ext: ext, cmd: cmd, values: args)
        }
        if background && cmd.mode == "view" { return .error("\(cmd.title) is a view command and cannot run in the background") }

        let info = SessionInfo(id: "s\(nextToken())", extName: m.name, extTitle: m.title, commandName: cmd.name, commandTitle: cmd.title,
                               mode: cmd.mode, runtime: m.runtime, launchType: launchType, assetsPath: ext.dir.appendingPathComponent("assets").path)
        let aiAvailable = await aiStatus().hasKey
        let s = ExtensionSession(info: info, delegate: self, options: options())
        sessions[info.id] = s
        s.start(initPayload: InitPayload.make(ext: ext, manifest: m, command: cmd, arguments: args,
                                              preferences: Manifest.resolvePreferences(m, saved: saved, command: cmd.name),
                                              supportPath: reg.supportDir(m.name).path, launchType: launchType, launchContext: launchContext,
                                              aiAvailable: aiAvailable))
        if cmd.mode == "menu-bar" { return menuBar.sessionStarted(s, command: cmd, background: background) }
        if cmd.mode == "view" {
            let model = makeRunModel(s, depth: 0)
            s.mount(0)
            Task { @MainActor [weak self] in self?.refreshChrome(model.token) }
            return .pushView(ViewID(feature: id, name: "run~\(model.token)"), payload: ["session": .string(info.id), "depth": 0])
        }
        let c = await s.waitForCompletion()
        if background { return c.ok ? .stay(message: nil) : .error("\(cmd.title): \(c.error ?? "failed")") }
        return c.ok ? .hide() : .error("\(cmd.title): \(c.error ?? "failed")")
    }

    private func makeRunModel(_ s: ExtensionSession, depth: Int) -> RunModel {
        let m = RunModel(token: nextToken(), session: s, depth: depth)
        m.owner = self
        runModels[m.token] = m
        tokenStack.append(m.token)
        return m
    }

    private func stopSessions(of extName: String) {
        for s in sessions.values where s.info.extName == extName { s.kill() }
    }

    /// Sessions nobody looks at (launcher reset after idle, abandoned views) stop after 10 minutes.
    private func sweep() {
        let now = Date()
        for s in sessions.values where s.info.mode != "menu-bar" && s.inFlight == 0 && now.timeIntervalSince(s.lastActivity) > 600 { s.kill() }
    }

    // MARK: pushing / popping Glide-owned views

    private func pushToken(_ kind: String, _ token: String) -> ActionResult {
        tokenStack.append(token)
        Task { @MainActor [weak self] in self?.refreshChrome(token) } // after the launcher pushed it
        return .pushView(ViewID(feature: id, name: "\(kind)~\(token)"), payload: .null)
    }

    /// Push from inside a view (not as an action result).
    private func hostPush(_ r: ActionResult) {
        if case let .pushView(v, payload) = r { LauncherHosts.current?.push(v, payload: payload) ?? context?.push(v, payload: payload) }
        else if case let .error(m) = r { LauncherHosts.current?.toast(m, style: .error) }
    }

    /// The launcher popped the view with `token` (key) or we pop it programmatically.
    private func didPop(_ token: String) {
        if let i = tokenStack.lastIndex(of: token) { tokenStack.remove(at: i) }
        if let m = runModels.removeValue(forKey: token) {
            m.resolveAlert(false)
            m.session.unmount(m.depth)
            if m.depth > 0 { m.session.mount(m.depth - 1) }
        }
        formModels[token] = nil
        listModels[token] = nil
        if let top = tokenStack.last { refreshChrome(top) }
    }

    private func popView(_ token: String) {
        guard tokenStack.last == token else { didPop(token); return }
        didPop(token)
        LauncherHosts.current?.pop()
    }

    private func token(of view: ViewID) -> String? { view.name.split(separator: "~", maxSplits: 1).dropFirst().first.map(String.init) }

    /// Placeholder + footer for the view on top.
    private func refreshChrome(_ token: String) {
        guard let host = LauncherHosts.current else { return }
        if let m = runModels[token] {
            host.setPlaceholder(m.placeholder)
            host.setFooter(primary: m.actions.first?.title ?? (m.type == "form" ? "Submit" : nil), hasActions: !m.actions.isEmpty)
            // integration: Raycast `navigationTitle` names the view; a controlled `searchText` drives the field.
            host.setContextTitle(m.title.isEmpty ? m.session.info.commandTitle : m.title) // fix round: navigationTitle, else the command title (nested pushes carry no item title)
            if let q = m.view["searchText"]?.stringValue, q != host.query { host.setQuery(q) }
        } else if let f = formModels[token] {
            host.setPlaceholder(f.title)
            host.setTitle(f.title)
            host.setFooter(primary: f.submitTitle, hasActions: false)
        } else if let l = listModels[token] {
            host.setTitle(l.kind == "store" ? "Extension Store" : "Manage Extensions")
            host.setPlaceholder(l.kind == "store" ? "Search extensions…" : "Search installed extensions…")
            host.setFooter(primary: l.current?.actions.first?.title, hasActions: !(l.current?.actions.isEmpty ?? true))
        }
    }

    /// The launcher query drives the top view (List/Grid filtering, onSearchTextChange, store/manage filter).
    private func observeQuery() {
        guard let host = LauncherHosts.current else {
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(200))
                self?.observeQuery()
            }
            return
        }
        let q = withObservationTracking { host.query } onChange: { [weak self] in
            Task { @MainActor in self?.observeQuery() }
        }
        guard let top = tokenStack.last else { return }
        runModels[top]?.setQuery(q)
        listModels[top]?.query = q
        refreshChrome(top)
    }

    // MARK: preferences / arguments forms

    func pushPreferences(_ extName: String, then: (String, String?)?) -> ActionResult {
        guard let reg = registry, let ext = reg.get(extName), let m = ext.manifest else { return .error("Unknown extension") }
        let values = Manifest.resolvePreferences(m, saved: reg.preferences(extName), command: nil)
        let fields = m.preferences.map { (p: ExtPreference) -> FieldsFormModel.Field in
            var title = p.title
            if let c = p.command { title += " (\(m.commands.first { $0.name == c }?.title ?? c))" }
            return FieldsFormModel.Field(id: p.key, title: title, type: p.type, required: p.required, placeholder: nil, info: p.description, options: p.data)
        }
        let model = FieldsFormModel(token: nextToken(), title: "\(m.title) Preferences", submitTitle: then == nil ? "Save Preferences" : "Save and Run", fields: fields, values: values)
        model.onSubmit = { [weak self, weak model] values in
            guard let self, let model else { return nil }
            do { try self.setPreferences(extName, values) } catch { return error.localizedDescription }
            self.popView(model.token)
            if let (cmd, arg) = then { self.hostPush(await self.runCommand(extName, cmd, argumentText: arg)) }
            else { LauncherHosts.current?.toast("Preferences saved", style: .success) }
            return nil
        }
        formModels[model.token] = model
        return pushToken("form", model.token)
    }

    func setPreferences(_ extName: String, _ input: [String: JSONValue]) throws {
        guard let reg = registry, let m = reg.get(extName)?.manifest else { throw ExtensionError("Unknown extension") }
        var clean: [String: JSONValue] = [:]
        for p in m.preferences {
            let v = input[p.key]
            if p.type == "checkbox" { clean[p.key] = .bool(v?.boolValue == true) } else if let s = v?.stringValue { clean[p.key] = .string(s) }
        }
        try reg.setPreferences(extName, clean)
        changed()
    }

    private func pushArguments(ext: InstalledExtension, cmd: ExtCommand, values: [String: String]) -> ActionResult {
        let fields = cmd.arguments.map {
            FieldsFormModel.Field(id: $0.name, title: $0.placeholder ?? $0.name, type: $0.type == "password" ? "password" : $0.type == "dropdown" ? "dropdown" : "textfield",
                                  required: $0.required, placeholder: $0.placeholder, options: $0.data)
        }
        let model = FieldsFormModel(token: nextToken(), title: cmd.title, submitTitle: "Run Command", fields: fields, values: values.mapValues(JSONValue.string))
        let extName = ext.name, cmdName = cmd.name
        model.onSubmit = { [weak self, weak model] values in
            guard let self, let model else { return nil }
            self.popView(model.token)
            self.hostPush(await self.runCommand(extName, cmdName, arguments: values.mapValues { $0.stringValue ?? $0.description }))
            return nil
        }
        formModels[model.token] = model
        return pushToken("form", model.token)
    }

    // MARK: manage / store views

    private func pushManage() -> ActionResult {
        let model = SimpleListModel(token: nextToken(), kind: "manage", title: "Manage Extensions")
        model.vimNav = { [weak self] in self?.vimEnabled ?? false }
        model.onRun = { [weak self, weak model] action, row in
            guard let self, let model else { return }
            await self.manageAction(action, row: row, model: model)
        }
        listModels[model.token] = model
        reloadManage(model)
        return pushToken("list", model.token)
    }

    private func reloadManage(_ model: SimpleListModel) {
        var rows: [SimpleListModel.Row] = []
        for e in registry?.list() ?? [] {
            let m = e.manifest
            var actions = [ItemAction(id: e.enabled ? "disable" : "enable", title: e.enabled ? "Disable Extension" : "Enable Extension", shortcut: "↩", icon: e.enabled ? "pause.circle" : "play.circle")]
            if m?.preferences.isEmpty == false { actions.append(ItemAction(id: "preferences", title: "Configure Extension", shortcut: "⌘,", icon: "gearshape")) }
            if let first = m?.commands.first, e.enabled { actions.append(ItemAction(id: "run:\(first.name)", title: "Run \(first.title)", shortcut: "⌘↩", icon: "play")) }
            actions += [ItemAction(id: "update", title: "Update (Re-copy)", shortcut: "⌘U", icon: "arrow.triangle.2.circlepath"),
                        ItemAction(id: "reveal", title: "Show in Finder", shortcut: "⇧⌘F", icon: "folder"),
                        ItemAction(id: "uninstall", title: "Uninstall", shortcut: "⌃X", icon: "trash", destructive: true)]
            var detail = e.errors.joined(separator: "\n")
            if let m {
                var lines: [String] = ["\(m.title) \(m.version)" + (m.author.map { " · \($0)" } ?? ""), m.description, "", "Commands:"]
                lines += m.commands.map { "• \($0.title) (\($0.mode))" }
                if !m.warnings.isEmpty { lines += ["", "Notes:"] + m.warnings }
                detail = lines.joined(separator: "\n")
            }
            rows.append(.init(id: e.name, title: m?.title ?? e.name, subtitle: m.map { "\($0.version) · \($0.commands.count) command\($0.commands.count == 1 ? "" : "s")" } ?? "Invalid",
                              icon: extIcon(m?.icon, assets: e.dir.appendingPathComponent("assets").path) ?? .symbol("puzzlepiece.extension"),
                              accessory: e.enabled ? (m?.runtime == "raycast" ? "Raycast" : "Glide") : "Disabled", section: e.enabled ? "Enabled" : "Disabled", detail: detail, actions: actions))
        }
        let installRows: [SimpleListModel.Row] = [
            .init(id: "#store", title: "Browse the Store", subtitle: "Install bundled and remote extensions", icon: .symbol("bag"), section: "Install",
                  actions: [ItemAction(id: "store", title: "Open Store", shortcut: "↩")]),
            .init(id: "#folder", title: "Install from Folder…", subtitle: "A Glide or Raycast extension folder", icon: .symbol("folder.badge.plus"), section: "Install",
                  actions: [ItemAction(id: "folder", title: "Choose Folder…", shortcut: "↩")]),
        ]
        model.rows = rows.sorted { ($0.section == "Enabled" ? 0 : 1, $0.title) < ($1.section == "Enabled" ? 0 : 1, $1.title) } + installRows
        model.banner = rows.isEmpty ? "No extensions installed yet." : nil
    }

    private func manageAction(_ action: String, row: SimpleListModel.Row, model: SimpleListModel) async {
        let host = LauncherHosts.current
        do {
            switch action {
            case "enable", "disable":
                try registry?.setEnabled(row.id, action == "enable")
                changed()
                host?.toast(action == "enable" ? "Enabled \(row.title)" : "Disabled \(row.title)", style: .success)
            case "preferences": hostPush(pushPreferences(row.id, then: nil))
            case "update":
                try registry?.update(row.id) { [weak self] n in self?.bundledDir(n) }
                changed()
                host?.toast("Updated \(row.title)", style: .success)
            case "reveal":
                if let e = registry?.get(row.id) { context?.services.workspace.reveal(path: e.dir.appendingPathComponent("package.json").path) }
            case "uninstall":
                let ok = await context?.services.confirmation.confirm(title: "Uninstall \(row.title)?", message: "Its files and preferences are removed.", confirmButton: "Uninstall") ?? false
                guard ok else { return }
                stopSessions(of: row.id)
                try registry?.uninstall(row.id)
                changed()
                host?.toast("Uninstalled \(row.title)", style: .success)
            case "store": hostPush(await pushStore())
            case "folder":
                guard context?.services.isHeadless == false else { host?.toast("Folder picker is not available in headless mode", style: .error); return }
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                panel.prompt = "Install"
                guard GlideWindows.shared.runModal({ panel.runModal() }) == .OK, let url = panel.url else { return }
                try installFolder(url)
                host?.toast("Installed \(url.lastPathComponent)", style: .success)
            default:
                if action.hasPrefix("run:") { hostPush(await runCommand(row.id, String(action.dropFirst(4)))) }
            }
        } catch {
            host?.toast(error.localizedDescription, style: .error)
        }
        reloadManage(model)
    }

    @discardableResult
    func installFolder(_ url: URL) throws -> InstalledExtension {
        guard let reg = registry else { throw ExtensionError("Extensions are not ready yet") }
        let e = try reg.install(folder: url, source: ["kind": "folder", "path": .string(url.standardizedFileURL.path)])
        changed()
        return e
    }

    private func bundledDir(_ name: String) -> URL? {
        guard let ex = examplesDir() else { return nil }
        for rel in [name, "raycast-fixtures/\(name)"] {
            let d = ex.appendingPathComponent(rel)
            if Manifest.read(dir: d).manifest?.name == name { return d }
        }
        return nil
    }

    private func pushStore() async -> ActionResult {
        let model = SimpleListModel(token: nextToken(), kind: "store", title: "Store")
        model.vimNav = { [weak self] in self?.vimEnabled ?? false }
        model.onRun = { [weak self, weak model] action, row in
            guard let self, let model else { return }
            await self.storeAction(action, row: row, model: model)
        }
        listModels[model.token] = model
        await reloadStore(model, refresh: false)
        return pushToken("list", model.token)
    }

    private func reloadStore(_ model: SimpleListModel, refresh: Bool) async {
        guard let store else { return }
        let st = await store.list(refresh: refresh)
        model.banner = st.error.map { "Remote index: \($0)" + (st.fromCache ? " (showing the cached copy)" : "") }
        model.rows = st.items.map { it in
            var actions: [ItemAction] = []
            if it.updateAvailable { actions.append(ItemAction(id: "update", title: "Update to \(it.version)", shortcut: "↩", icon: "arrow.down.circle")) }
            if it.installed, let first = it.entry.commands.first {
                actions.append(ItemAction(id: "run:\(first.name)", title: "Run \(first.title)", shortcut: it.updateAvailable ? "⌘↩" : "↩", icon: "play"))
            } else if !it.installed && it.unavailable == nil {
                actions.append(ItemAction(id: "install", title: "Install", shortcut: "↩", icon: "arrow.down.circle"))
            }
            if it.installed { actions.append(ItemAction(id: "uninstall", title: "Uninstall", shortcut: "⌃X", icon: "trash", destructive: true)) }
            if it.entry.homepage != nil { actions.append(ItemAction(id: "homepage", title: "Open Homepage", shortcut: "⌘O", icon: "safari")) }
            actions.append(ItemAction(id: "refresh", title: "Refresh Index", shortcut: "⌘R", icon: "arrow.clockwise"))
            actions.append(ItemAction(id: "manage", title: "Manage Extensions", shortcut: "⌘M", icon: "puzzlepiece.extension"))
            let status = it.unavailable ?? (it.updateAvailable ? "Update \(it.installedVersion ?? "") → \(it.version)" : it.installed ? "Installed \(it.installedVersion ?? "")" : it.via == "download" ? "\(ByteCountFormatter.string(fromByteCount: Int64(it.size ?? 0), countStyle: .file)) download" : "Bundled")
            let changes = it.entry.changelog.prefix(3).map { "• \($0.version): \($0.notes)" }
            let detail = ([it.entry.description, "", "By \(it.entry.author) · \(it.version) · \(it.entry.kind == "raycast" ? "Raycast" : "Glide") extension",
                           "Commands: " + it.entry.commands.map(\.title).joined(separator: ", ")] + (changes.isEmpty ? [] : ["", "What's New"] + changes)).joined(separator: "\n")
            return .init(id: it.entry.id, title: it.entry.title, subtitle: it.entry.description, icon: extIcon(it.entry.icon, assets: nil) ?? .symbol("puzzlepiece.extension"),
                         accessory: status, section: it.entry.categories.first ?? "Extensions", detail: detail, actions: actions)
        }
    }

    private func storeAction(_ action: String, row: SimpleListModel.Row, model: SimpleListModel) async {
        let host = LauncherHosts.current
        guard let store else { return }
        do {
            switch action {
            case "install", "update":
                let it = (await store.list()).items.first { $0.entry.id == row.id }
                let src = it?.via == "download" ? "It downloads \(ByteCountFormatter.string(fromByteCount: Int64(it?.size ?? 0), countStyle: .file)) and verifies its SHA-256." : "It is copied from the copy bundled with Glide (no network)."
                model.confirm = (row.id, action, "\(action == "update" ? "Update" : "Install") \(row.title)?",
                                 "Extensions are third-party code that runs with your privileges. \(src)")
                return
            case "confirmed:install", "confirmed:update":
                model.busy = row.id
                defer { model.busy = nil }
                let r = try await store.install(row.id, confirmed: true, update: action == "confirmed:update")
                host?.toast("\(action == "confirmed:update" ? "Updated" : "Installed") \(r.title) \(r.version)", style: .success)
            case "uninstall":
                let ok = await context?.services.confirmation.confirm(title: "Uninstall \(row.title)?", message: "Its files and preferences are removed.", confirmButton: "Uninstall") ?? false
                guard ok else { return }
                try store.uninstall(row.id)
                host?.toast("Uninstalled \(row.title)", style: .success)
            case "refresh": await reloadStore(model, refresh: true); return
            case "manage": hostPush(pushManage()); return
            case "homepage":
                if let st = await store.list().items.first(where: { $0.entry.id == row.id }), let h = st.entry.homepage, let u = URL(string: h), isSafeExtensionURL(h) {
                    _ = context?.services.workspace.open(url: u, withApp: nil)
                }
            default:
                if action.hasPrefix("run:"), let name = (await store.list()).items.first(where: { $0.entry.id == row.id })?.entry.name {
                    hostPush(await runCommand(name, String(action.dropFirst(4))))
                    return
                }
            }
        } catch {
            host?.toast(error.localizedDescription, style: .error)
        }
        await reloadStore(model, refresh: false)
    }

    // MARK: HUD

    func showHUD(_ text: String) {
        effects.append(["kind": "hud", "text": .string(text)])
        context?.hideLauncher()
        guard context?.services.isHeadless == false else { context?.log("hud: \(text)"); return }
        hud = HUDWindow.show(text, previous: hud)
    }

    func recordEffect(_ kind: String, _ detail: JSONValue) { effects.append(["kind": .string(kind), "detail": detail]) }

    // MARK: FeatureUI

    public var vimEnabled: Bool { context?.store.settings.vimMode ?? false }

    public func launcherView(_ view: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard let t = token(of: view) else { return nil }
        if let m = runModels[t] { return AnyView(RunView(model: m)) }
        if let f = formModels[t] { return AnyView(FieldsFormView(model: f)) }
        if let l = listModels[t] { return AnyView(SimpleListView(model: l)) }
        return AnyView(EmptyState(symbol: "puzzlepiece.extension", title: "This view has closed"))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        guard let t = token(of: view) else { return false }
        defer { refreshChrome(t) }
        if let m = runModels[t] { return m.handleKey(key) }
        if let f = formModels[t] { return f.handleKey(key) }
        if let l = listModels[t] { return l.handleKey(key) }
        return false
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        guard let t = token(of: view) else { return false }
        if command == .pop {
            if let m = runModels[t], !m.panels.isEmpty { m.panels.removeLast(); return true }
            if let l = listModels[t], l.panel != nil || l.confirm != nil { l.panel = nil; l.confirm = nil; return true }
            if let m = runModels[t], m.alert != nil { m.resolveAlert(false); return true }
            didPop(t)
            return false
        }
        defer { refreshChrome(t) }
        if let m = runModels[t] { return m.handle(command) }
        if let f = formModels[t] {
            if case let .move(d) = command, !f.fields.isEmpty { f.focused = min(f.fields.count - 1, max(0, f.focused + d)); return true }
            if case .activate = command { return f.handleKey(VimKey("Enter")) }
            return command.isNavigation
        }
        if let l = listModels[t] { return l.handle(command) }
        return false
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Extensions", symbol: "puzzlepiece.extension", order: 60) { [weak self] in
            AnyView(ExtensionsSettingsView(feature: self))
        }
    }

    // MARK: invoke (test channel / other features)

    func topRunModel() -> RunModel? { tokenStack.reversed().lazy.compactMap { self.runModels[$0] }.first }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "list":
            return .array((registry?.list() ?? []).map { e in
                ["name": .string(e.name), "enabled": .bool(e.enabled), "title": .string(e.manifest?.title ?? e.name), "version": .string(e.manifest?.version ?? "?"),
                 "runtime": .string(e.manifest?.runtime ?? "glide"), "commands": .array((e.manifest?.commands ?? []).map { .string($0.name) }),
                 "errors": .array(e.errors.map(JSONValue.string)), "source": e.source ?? .null]
            })
        case "installFolder":
            let e = try installFolder(URL(fileURLWithPath: args["path"]?.stringValue ?? ""))
            return ["name": .string(e.name)]
        case "installExample":
            guard let ex = examplesDir() else { throw ExtensionError("No examples folder") }
            let e = try installFolder(ex.appendingPathComponent(args["path"]?.stringValue ?? ""))
            return ["name": .string(e.name)]
        case "uninstall":
            let n = args["name"]?.stringValue ?? ""
            stopSessions(of: n)
            try registry?.uninstall(n)
            tokens.clear(n)
            changed()
            return true
        case "setEnabled":
            try registry?.setEnabled(args["name"]?.stringValue ?? "", args["enabled"]?.boolValue ?? true)
            changed()
            return true
        case "setPreferences":
            try setPreferences(args["name"]?.stringValue ?? "", args["values"]?.objectValue ?? [:])
            return true
        case "getPreferences":
            guard let n = args["name"]?.stringValue, let m = registry?.get(n)?.manifest else { return .null }
            return .object(Manifest.resolvePreferences(m, saved: registry?.preferences(n) ?? [:], command: nil))
        case "run":
            let r = await runCommand(args["name"]?.stringValue ?? "", args["command"]?.stringValue ?? "", argumentText: args["argument"]?.stringValue,
                                     arguments: args["arguments"]?.objectValue?.mapValues { $0.stringValue ?? "" })
            if case let .pushView(v, p) = r { LauncherHosts.current?.push(v, payload: p) }
            return Self.describe(r)
        case "view": return viewState()
        case "oauthRedirect":
            // glide://oauth?code=…&state=… (AppDelegate open-url, or a headless test simulating the browser).
            return ["handled": .bool(oauthRedirect(args["url"]?.stringValue ?? args.stringValue ?? ""))]
        case "oauthPending":
            return .array(oauthFlows.requests.map { ["id": .string($0.id), "extension": .string($0.extName), "provider": .string($0.providerName),
                                                     "url": .string($0.url), "state": .string($0.state)] })
        case "oauthCancel":
            oauthFlows.cancel(args["id"]?.stringValue ?? "")
            return true
        case "oauthTokens":
            return tokens.get(args["name"]?.stringValue ?? "", args["provider"]?.stringValue ?? "default") ?? .null
        case "flushSearch":
            topRunModel()?.flushSearch()
            return true
        case "setField":
            if let t = tokenStack.last, let f = formModels[t] { f.values[args["id"]?.stringValue ?? ""] = args["value"] ?? .null; return true }
            topRunModel()?.setField(args["id"]?.stringValue ?? "", args["value"] ?? .null)
            return true
        case "submit":
            if let t = tokenStack.last, let f = formModels[t] { f.submit(); return true }
            topRunModel()?.activate(secondary: false)
            return true
        case "runAction":
            guard let m = topRunModel() else { return false }
            let title = args["title"]?.stringValue
            func flat(_ l: [ExtAction]) -> [ExtAction] { l.flatMap { [$0] + flat($0.children) } }
            guard let a = flat(m.actions).first(where: { $0.title == title || $0.id == args["id"]?.stringValue }) else { return false }
            m.run(a)
            return true
        case "alert":
            guard let m = topRunModel() else { return false }
            m.resolveAlert(args["ok"]?.boolValue ?? true)
            return true
        case "effects": return .array(effects)
        case "clearEffects":
            effects = []
            return true
        case "sessions":
            return .array(sessions.values.map { ["id": .string($0.info.id), "ext": .string($0.info.extName), "command": .string($0.info.commandName), "alive": .bool($0.alive),
                                                  "depth": .int(Int64($0.depth)), "logs": .array($0.logs.suffix(30).map(JSONValue.string))] })
        case "storeList":
            guard let store else { return .null }
            let st = await store.list(refresh: args["refresh"]?.boolValue ?? false)
            return ["items": .array(st.items.map { ["id": .string($0.entry.id), "title": .string($0.entry.title), "version": .string($0.version), "via": $0.via.map(JSONValue.string) ?? .null,
                                                     "installed": .bool($0.installed), "updateAvailable": .bool($0.updateAvailable), "origin": .string($0.origin),
                                                     "unavailable": $0.unavailable.map(JSONValue.string) ?? .null] }),
                    "error": st.error.map(JSONValue.string) ?? .null, "indexUrl": .string(st.indexURL), "fromCache": .bool(st.fromCache)]
        case "storeInstall":
            guard let store else { return .null }
            let r = try await store.install(args["id"]?.stringValue ?? "", confirmed: args["confirmed"]?.boolValue == true, update: args["update"]?.boolValue == true)
            return ["name": .string(r.name), "version": .string(r.version)]
        case "storeUninstall":
            try store?.uninstall(args["id"]?.stringValue ?? "")
            return true
        default:
            if let r = await menuBar.invoke(method, args) { return r } // menuBarState / menuBarClick / menuBarOpen / menuBarRefresh / setBackground
            throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    static func describe(_ r: ActionResult) -> JSONValue {
        switch r {
        case let .hide(m): return ["result": "hide", "message": m.map(JSONValue.string) ?? .null]
        case let .stay(m): return ["result": "stay", "message": m.map(JSONValue.string) ?? .null]
        case let .pushView(v, _): return ["result": "push", "view": .string(v.rawValue)]
        case let .openSettings(p): return ["result": "settings", "page": p.map(JSONValue.string) ?? .null]
        case let .error(e): return ["result": "error", "error": .string(e)]
        }
    }

    /// The top view of this feature as JSON (rendered tree + launcher-side state) for headless assertions.
    func viewState() -> JSONValue {
        guard let t = tokenStack.last else { return .null }
        if let m = runModels[t] {
            var o: [String: JSONValue] = ["kind": "run", "token": .string(t), "type": .string(m.type), "depth": .int(Int64(m.depth)), "title": .string(m.title),
                                          "query": .string(m.query), "isLoading": .bool(m.isLoading), "selected": .int(Int64(m.selectedIndex)),
                                          "rows": .array(m.rows.map { ["id": .string($0.id), "title": .string($0.title), "section": $0.section.map(JSONValue.string) ?? .null] }),
                                          "actions": .array(m.actions.map { .string($0.title) }), "view": m.view, "panel": m.panels.last.map { .array($0.filtered.map { .string($0.title) }) } ?? .null,
                                          "formValues": .object(m.formValues), "focusedField": .int(Int64(m.focusedField))]
            if let a = m.alert { o["alert"] = ["title": .string(a.title), "primary": .string(a.primary)] }
            return .object(o)
        }
        if let f = formModels[t] {
            return ["kind": "form", "token": .string(t), "title": .string(f.title), "fields": .array(f.fields.map { .string($0.id) }), "values": .object(f.values),
                    "error": f.error.map(JSONValue.string) ?? .null, "focused": .int(Int64(f.focused))]
        }
        if let l = listModels[t] {
            return ["kind": .string(l.kind), "token": .string(t), "query": .string(l.query), "selected": .int(Int64(l.selected)), "banner": l.banner.map(JSONValue.string) ?? .null,
                    "rows": .array(l.filtered.map { ["id": .string($0.id), "title": .string($0.title), "accessory": $0.accessory.map(JSONValue.string) ?? .null,
                                                     "actions": .array($0.actions.map { .string($0.title) })] }),
                    "panel": l.panel.map { .array($0.filtered.map { .string($0.title) }) } ?? .null,
                    "confirm": l.confirm.map { .string($0.title) } ?? .null]
        }
        return .null
    }
}

// MARK: - session delegate (extension requests)

extension ExtensionsFeature: ExtensionSessionDelegate, RunModelOwner {
    private func models(of s: ExtensionSession) -> [RunModel] { runModels.values.filter { $0.session === s } }

    func sessionDidChange(_ s: ExtensionSession, _ event: ExtensionSession.Event) {
        if s.info.mode == "menu-bar" { // status items, never launcher views
            menuBar.sessionDidChange(s, event)
            if case .ended = event { sessions[s.info.id] = nil }
            return
        }
        switch event {
        case let .render(depth), let .push(depth):
            if let v = s.view(depth) {
                let existing = models(of: s).first { $0.depth == depth }
                if let existing { existing.apply(v); refreshChrome(existing.token) } else if case .push = event, s.info.mode == "view" {
                    s.mount(depth)
                    let m = makeRunModel(s, depth: depth)
                    LauncherHosts.current?.push(ViewID(feature: id, name: "run~\(m.token)"), payload: ["session": .string(s.info.id), "depth": .int(Int64(depth))])
                    refreshChrome(m.token)
                }
            }
        case let .pop(depth):
            if let m = models(of: s).first(where: { $0.depth == depth }) { popView(m.token) }
        case let .failureToast(msg):
            LauncherHosts.current?.toast(msg, style: .error)
            recordEffect("toast", ["style": "failure", "title": .string(msg)])
        case .ended:
            sessions[s.info.id] = nil
            oauthFlows.cancelSession(s.info.id)
            for sid in aiStreams.removeValue(forKey: s.info.id) ?? [] {
                Task { @MainActor [weak self] in _ = try? await self?.context?.callFeature("ai", method: "askStreamCancel", args: ["id": .string(sid)]) }
            }
            for m in models(of: s) where m.view.isNull { popView(m.token) }
        }
    }

    private func clipText(_ v: JSONValue?) -> (text: String, html: String?) {
        if let o = v?.objectValue {
            return (o["text"]?.stringValue ?? o["file"]?.stringValue ?? "", o["html"]?.stringValue)
        }
        return (v?.stringValue ?? v.map { $0.isNull ? "" : $0.description } ?? "", nil)
    }

    private func expand(_ p: String) -> String {
        if p.hasPrefix("file://") { return URL(string: p)?.path ?? String(p.dropFirst(7)) }
        return (p as NSString).expandingTildeInPath
    }

    private func open(_ target: String, application: String?) throws {
        guard let services = context?.services else { return }
        let t = target.trimmingCharacters(in: .whitespaces)
        if t.range(of: "^(javascript|data|vbscript):", options: [.regularExpression, .caseInsensitive]) != nil { throw ExtensionError("Refusing to open that URL scheme") }
        if t.range(of: "^[a-z][a-z0-9+.-]*:", options: [.regularExpression, .caseInsensitive]) != nil && !t.lowercased().hasPrefix("file:") {
            guard let u = URL(string: t) else { throw ExtensionError("Invalid URL \(t)") }
            let r = services.workspace.open(url: u, withApp: application)
            if !r.ok { throw ExtensionError(r.error ?? "Could not open") }
            return
        }
        let path = expand(t)
        let r = application.map { services.workspace.open(url: URL(fileURLWithPath: path), withApp: $0) } ?? services.workspace.open(path: path)
        if !r.ok { throw ExtensionError(r.error ?? "Could not open") }
    }

    private func trash(_ paths: [String]) throws {
        for p in paths where !p.isEmpty {
            recordEffect("trash", .string(expand(p)))
            if context?.services.isHeadless == false { try FileManager.default.trashItem(at: URL(fileURLWithPath: expand(p)), resultingItemURL: nil) }
        }
    }

    func session(_ s: ExtensionSession, request method: String, params: [JSONValue]) async throws -> JSONValue {
        try await session(s, request: method, params: params, stream: { _ in })
    }

    func session(_ s: ExtensionSession, request method: String, params: [JSONValue], stream: @escaping @MainActor (String) -> Void) async throws -> JSONValue {
        guard let ctx = context, let reg = registry else { throw ExtensionError("Extensions are not ready yet") }
        let services = ctx.services
        let p0 = params.first
        let s0 = p0?.stringValue ?? ""
        let name = s.info.extName
        if let r = menuBar.request(s, method: method, params: params) { return r } // updateCommandMetadata
        switch method {
        case "clipboard.copy":
            let c = clipText(p0)
            services.pasteboard.setString(c.text, html: c.html, transient: false)
            return .null
        case "clipboard.paste":
            let c = clipText(p0)
            ctx.hideLauncher()
            services.paste.paste(text: c.text, html: c.html)
            return .null
        case "clipboard.read": return services.pasteboard.string().map(JSONValue.string) ?? .null
        case "clipboard.clear":
            services.pasteboard.setString("", html: nil, transient: true)
            return .null
        case "open":
            try open(s0, application: params.count > 1 ? params[1].stringValue : nil)
            return .null
        case "showInFinder":
            services.workspace.reveal(path: expand(s0))
            return .null
        case "trash":
            try trash(params.compactMap(\.stringValue))
            return .null
        case "confirmAlert":
            let o = p0?.objectValue ?? [:]
            let title = o["title"]?.stringValue ?? "Are you sure?"
            if s.info.mode != "view" || models(of: s).isEmpty {
                return .bool(await services.confirmation.confirm(title: title, message: o["message"]?.stringValue ?? "", confirmButton: o["primaryTitle"]?.stringValue ?? "OK"))
            }
            guard let m = models(of: s).max(by: { $0.depth < $1.depth }) else { return false }
            return .bool(await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
                m.resolveAlert(false)
                m.alert = (Int.random(in: 0..<Int.max), title, o["message"]?.stringValue, o["primaryTitle"]?.stringValue ?? "OK",
                           o["dismissTitle"]?.stringValue ?? "Cancel", o["destructive"]?.boolValue == true)
                m.alertResolver = { c.resume(returning: $0) }
            })
        case "selection.text":
            let r = await services.selection.selectedText()
            return r.text.map(JSONValue.string) ?? .null
        case "app.frontmost":
            guard let a = services.frontmost.targetApp() else { return .null }
            return ["name": .string(a.name), "path": a.path.map(JSONValue.string) ?? "", "bundleId": a.bundleId.map(JSONValue.string) ?? .null]
        case "finder.selection":
            let r = await services.finder.selection()
            return .array(r.paths.map(JSONValue.string))
        case "launchCommand":
            let ext = params.count > 1 ? (params[1].stringValue ?? name) : name
            let argsIn = params.count > 2 ? params[2].objectValue ?? [:] : [:]
            let lt = params.count > 4 && params[4].stringValue == "background" ? "background" : "userInitiated"
            let r = await runCommand(ext.isEmpty ? name : ext, s0, arguments: argsIn.mapValues { $0.stringValue ?? $0.description }, launchType: lt,
                                     launchContext: params.count > 3 ? params[3] : .null)
            if case let .error(e) = r { throw ExtensionError(e) }
            if lt == "userInitiated" { hostPush(r) }
            return .null
        case "popToRoot":
            for m in models(of: s).sorted(by: { $0.depth > $1.depth }) { popView(m.token) }
            return .null
        case "clearSearchBar":
            LauncherHosts.current?.setQuery("") // integration: shared setQuery
            return .null
        case "openPreferences":
            hostPush(pushPreferences(name, then: nil))
            return .null
        case "toast.hide", "form.field", "toast.actions": return .null
        case "showHUD":
            if s.info.launchType != "background" { showHUD(s0) }
            return .null
        case "closeMainWindow":
            ctx.hideLauncher()
            return .null
        case "showToast":
            let style = p0?.stringValue ?? "success"
            let title = params.count > 1 ? params[1].stringValue ?? "" : ""
            let message = params.count > 2 ? params[2].stringValue : nil
            recordEffect("toast", ["style": .string(style), "title": .string(title), "message": message.map(JSONValue.string) ?? .null])
            if s.info.mode != "view" {
                if s.info.launchType != "background" && style != "animated" { showHUD(title) }
                return .null
            }
            let text = message.map { "\(title) — \($0)" } ?? title
            LauncherHosts.current?.toast(text, style: style == "failure" ? .error : style == "animated" ? .info : .success)
            return .null
        case "storage.get": return reg.storageAll(name)[s0] ?? .null
        case "storage.set":
            try reg.storageWrite(name) { $0[s0] = params.count > 1 ? params[1] : .null }
            return .null
        case "storage.remove":
            try reg.storageWrite(name) { $0[s0] = nil }
            return .null
        case "storage.all": return .object(reg.storageAll(name))
        case "storage.clear":
            try reg.storageWrite(name) { $0 = [:] }
            return .null
        case "ai.ask":
            let o = params.count > 1 ? params[1].objectValue ?? [:] : [:]
            return .string(try await aiAsk(s, prompt: s0, model: o["model"]?.stringValue, creativity: o["creativity"]?.stringValue, stream: stream))
        case "oauth.authorize":
            return ["code": .string(try await oauthAuthorize(s, p0?.objectValue ?? [:]))]
        case "oauth.getTokens": return tokens.get(name, s0.isEmpty ? "default" : s0) ?? .null
        case "oauth.setTokens":
            try tokens.set(name, s0.isEmpty ? "default" : s0, params.count > 1 ? params[1] : .null)
            return .null
        case "oauth.removeTokens":
            try tokens.remove(name, s0.isEmpty ? "default" : s0)
            return .null
        case "applications": return .array([])
        default: throw ExtensionError("Unknown request \(method)")
        }
    }

    /// An action chosen in an extension view (actions.ts dispatchAction).
    func perform(_ a: ExtAction, from m: RunModel, formValues: [String: JSONValue]?) async {
        guard let ctx = context else { return }
        let services = ctx.services
        let host = LauncherHosts.current
        var ok = true
        do {
            switch a.kind {
            case "openInBrowser":
                let url = a.url ?? ""
                guard isSafeExtensionURL(url), let u = URL(string: url) else { throw ExtensionError("Refusing to open \"\(url)\": only http, https and mailto links are allowed") }
                let r = services.workspace.open(url: u, withApp: nil)
                if !r.ok { throw ExtensionError(r.error ?? "Could not open") }
                ctx.hideLauncher()
            case "copy":
                services.pasteboard.setString(a.text ?? "", html: a.html, transient: false)
                showHUD("Copied to Clipboard")
            case "paste":
                ctx.hideLauncher()
                services.paste.paste(text: a.text ?? "", html: nil)
            case "push", "run":
                guard let h = a.handler else { throw ExtensionError("Action has no handler") }
                m.session.invoke(depth: m.depth, handler: h)
            case "submit":
                guard let h = a.handler else { throw ExtensionError("Action has no handler") }
                m.session.invoke(depth: m.depth, handler: h, args: [.object(formValues ?? m.submitValues)])
            case "open":
                guard let t = a.target, !t.isEmpty else { throw ExtensionError("Nothing to open") }
                try open(t, application: a.application)
                ctx.hideLauncher()
            case "showInFinder":
                guard let t = a.target else { throw ExtensionError("Nothing to show") }
                services.workspace.reveal(path: expand(t))
                ctx.hideLauncher()
            case "trash":
                guard !a.paths.isEmpty else { throw ExtensionError("Nothing to move to the Trash") }
                try trash(a.paths)
                showHUD(a.paths.count == 1 ? "Moved to Trash" : "Moved \(a.paths.count) items to Trash")
            case "pickDate":
                // No date-picker overlay yet: Today (date) / now (datetime), like choosing the default.
                guard let h = a.handler else { throw ExtensionError("Action has no handler") }
                m.session.invoke(depth: m.depth, handler: h, args: [.string(ISO8601DateFormatter().string(from: Date()))])
            default:
                throw ExtensionError("\(a.title) is not supported by the native runtime yet")
            }
        } catch {
            ok = false
            host?.toast(error.localizedDescription, style: .error)
            recordEffect("toast", ["style": "failure", "title": .string(error.localizedDescription)])
        }
        if ok, let cb = a.callback { m.session.invoke(depth: m.depth, handler: cb) }
    }
}

// MARK: - AI.ask and OAuth (Raycast compatibility)

extension ExtensionsFeature {
    /// Glide AI's key status (environment.canAccess(AI)) and active provider.
    func aiStatus() async -> (hasKey: Bool, provider: String) {
        guard let r = try? await context?.callFeature("ai", method: "hasApiKey", args: .null) else { return (false, "anthropic") }
        return ((r["ready"] ?? r["hasKey"])?.boolValue == true, r["provider"]?.stringValue ?? "anthropic")
    }

    /// AI.ask: streams Glide AI's answer as "data" chunks and resolves with the full text.
    func aiAsk(_ s: ExtensionSession, prompt: String, model: String?, creativity: String?, stream: @escaping @MainActor (String) -> Void) async throws -> String {
        guard let ctx = context else { throw ExtensionError("Extensions are not ready yet") }
        let status = await aiStatus()
        guard status.hasKey else { throw ExtensionError(ExtensionAI.notSetUp) }
        var args: [String: JSONValue] = ["prompt": .string(prompt)]
        if let m = ExtensionAI.mapModel(model, provider: status.provider) { args["model"] = .string(m) }
        if let note = ExtensionAI.creativityNote(creativity) { args["system"] = .string(note) }
        let start: JSONValue
        do {
            start = try await ctx.callFeature("ai", method: "askStream", args: .object(args))
        } catch {
            // An AI feature without streaming: one-shot answer, emitted as a single chunk.
            let r = try await ctx.callFeature("ai", method: "ask", args: .object(args))
            guard r["ok"]?.boolValue == true else { throw ExtensionError(r["error"]?.stringValue ?? "Glide AI failed") }
            let text = r["text"]?.stringValue ?? ""
            if !text.isEmpty { stream(text) }
            return text
        }
        guard let sid = start["id"]?.stringValue else { throw ExtensionError(start["error"]?.stringValue ?? "Glide AI failed") }
        aiStreams[s.info.id, default: []].insert(sid)
        defer { aiStreams[s.info.id]?.remove(sid) }
        var text = ""
        while true {
            guard s.alive else {
                _ = try? await ctx.callFeature("ai", method: "askStreamCancel", args: ["id": .string(sid)])
                throw ExtensionError("Aborted")
            }
            let r = try await ctx.callFeature("ai", method: "askStreamPoll", args: ["id": .string(sid), "wait": 500])
            if let d = r["delta"]?.stringValue, !d.isEmpty {
                text += d
                stream(d)
            }
            guard r["done"]?.boolValue == true else { continue }
            guard r["ok"]?.boolValue == true else {
                let kind = r["kind"]?.stringValue
                throw ExtensionError(kind == "noKey" ? ExtensionAI.notSetUp : r["error"]?.stringValue ?? "Glide AI failed")
            }
            return r["text"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? text
        }
    }

    /// OAuth.PKCEClient.authorize: opens the provider's page in the browser and waits for glide://oauth.
    func oauthAuthorize(_ s: ExtensionSession, _ o: [String: JSONValue]) async throws -> String {
        guard let ctx = context else { throw ExtensionError("Extensions are not ready yet") }
        let provider = o["providerName"]?.stringValue ?? "the provider"
        let services = ctx.services
        return try await oauthFlows.authorize(extName: s.info.extName, sessionId: s.info.id, url: o["url"]?.stringValue ?? "",
                                              state: o["state"]?.stringValue ?? "", providerName: provider) { [weak self] req, url in
            self?.recordEffect("oauth", ["id": .string(req.id), "extension": .string(req.extName), "provider": .string(provider), "url": .string(req.url)])
            let r = services.workspace.open(url: url, withApp: nil)
            if !r.ok { throw ExtensionError(r.error ?? "Could not open the sign-in page") }
            if s.info.mode == "view" { LauncherHosts.current?.toast("Sign in with \(provider) in your browser…", style: .info) }
        }
    }

    /// glide://oauth?… from the app delegate (or the test channel).
    @discardableResult func oauthRedirect(_ url: String) -> Bool {
        let id = oauthFlows.handleRedirect(url)
        if id == nil { context?.log("ignored OAuth redirect (no pending sign-in matches it)") }
        return id != nil
    }
}

/// Bottom-centre HUD that never takes focus (not used in headless runs).
@MainActor final class HUDWindow {
    let panel: NSPanel
    init(_ text: String) {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .white
        let width = min(520, max(180, label.intrinsicContentSize.width + 48))
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 40), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .transient]
        let bg = NSVisualEffectView(frame: panel.contentRect(forFrameRect: panel.frame))
        bg.material = .hudWindow
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 20
        label.frame = NSRect(x: 24, y: 11, width: width - 48, height: 18)
        label.alignment = .center
        bg.addSubview(label)
        panel.contentView = bg
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.midX - width / 2, y: f.minY + 120))
        }
    }

    static func show(_ text: String, previous: HUDWindow?) -> HUDWindow {
        previous?.panel.orderOut(nil)
        let h = HUDWindow(text)
        h.panel.orderFrontRegardless()
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.8))
            h.panel.orderOut(nil)
        }
        return h
    }
}
