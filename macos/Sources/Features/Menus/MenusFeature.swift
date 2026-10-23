import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Menu search (port of src/main/features/menus): the target app's menu bar via Accessibility (MenuService,
/// cached 5 s per pid), filtered with the launcher matcher; ↩ presses the item in the app behind the launcher.
@MainActor public final class MenusFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "menus"
    public let title = "Menu Search"
    private weak var context: FeatureContext?
    private weak var host: (any LauncherViewHost)?
    let nav = SysListNav()
    let model = MenusModel()
    var hideDelay: Duration = .milliseconds(80)

    public init() {}
    public func start(context: FeatureContext) async { self.context = context }

    public func items() -> [SearchItem] {
        [SearchItem(id: "menus.search", kind: .command, title: "Search Menu Items", subtitle: "Menu Bar", icon: .symbol("filemenu.and.selection"),
                    keywords: ["menu", "menu bar", "menubar", "commands", "actions", "shortcuts"], feature: id, kindLabel: "Menu")]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        [ItemAction(id: "open", title: "Search Menu Items", shortcut: "↩", icon: "filemenu.and.selection"),
         ItemAction(id: "open-accessibility", title: "Open Accessibility Settings", icon: "lock.shield")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        if action == "open-accessibility" { return SettingsPanes.open(SettingsPanes.accessibility, context) }
        // Capture the target now: the launcher panel is non-activating, so this is the user's app.
        let front = context?.services.frontmost.targetApp()
        nav.reset()
        await load(pid: front?.pid, appName: front?.name)
        return .pushView("menus.search", payload: front.map { ["pid": .int(Int64($0.pid)), "appName": .string($0.name)] } ?? .null)
    }

    func load(pid: Int32?, appName: String?) async {
        guard let ctx = context else { return }
        model.app = appName
        model.pid = pid
        if !ctx.services.isHeadless && !ctx.services.permissions.status().accessibility {
            model.items = []
            model.error = "Glide needs Accessibility permission to read other apps' menus."
            return
        }
        guard pid != nil || ctx.services.isHeadless else {
            model.items = []
            model.error = "No application to read menus from."
            return
        }
        model.error = nil
        model.items = await ctx.services.menus.list(pid: pid)
        if model.items.isEmpty { model.error = "\(appName ?? "This app") has no menu items Glide can read." }
    }

    /// Visible rows: enabled first, title = leaf, subtitle = the path to it.
    static func rows(_ items: [MenuItemInfo], query: String) -> [ScoredItem] {
        let matched = sysFilter(items, query: query, text: { $0.path.last ?? "" }, keywords: { [$0.path.joined(separator: " ")] })
        let ordered = matched.filter { $0.0.enabled } + matched.filter { !$0.0.enabled }
        return ordered.map { m, ranges in
            let leaf = m.path.last ?? ""
            return ScoredItem.row(SearchItem(id: "menu:" + m.path.joined(separator: "\u{1F}"), kind: .command, title: leaf,
                                             subtitle: m.path.dropLast().joined(separator: " › "), icon: .symbol(m.enabled ? "filemenu.and.selection" : "nosign"),
                                             hotkey: m.shortcut, feature: "menus", data: ["path": .array(m.path.map(JSONValue.string)), "enabled": .bool(m.enabled)],
                                             kindLabel: m.shortcut ?? (m.enabled ? "Menu" : "Disabled")), ranges: ranges)
        }
    }

    func press(path: [String]) async -> ActionResult {
        guard let ctx = context else { return .error("Menu search is not ready") }
        guard path.count >= 2 else { return .error("Invalid menu item") }
        ctx.hideLauncher()
        if hideDelay > .zero { try? await Task.sleep(for: hideDelay) }
        let r = await ctx.services.menus.press(pid: model.pid, path: path)
        return r.ok ? .hide() : .error(r.error ?? "Could not press the menu item")
    }

    func activate(_ i: Int) {
        let rows = Self.rows(model.items, query: n3Host(host)?.query ?? "")
        guard i < rows.count, let path = rows[i].item.data?["path"]?.arrayValue?.compactMap(\.stringValue) else { return }
        Task { @MainActor in
            let r = await press(path: path)
            if case let .error(m) = r { context?.toast(m, style: .error) } else { n3Host(host)?.pop() }
        }
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        guard view.rawValue == "menus.search" else { return false }
        let rows = Self.rows(model.items, query: n3Host(host)?.query ?? "")
        nav.sync(query: n3Host(host)?.query ?? "", count: rows.count)
        switch nav.apply(command, count: rows.count) {
        case .moved: return true
        case .activate, .secondary: activate(nav.index); return true
        case .actions, .delete: return true
        case .copy:
            if nav.index < rows.count, let p = rows[nav.index].item.data?["path"]?.arrayValue?.compactMap(\.stringValue) {
                context?.services.pasteboard.setString(p.joined(separator: " › "), html: nil, transient: false)
                context?.toast("Copied menu path", style: .success)
            }
            return true
        case nil: return false
        }
    }

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard vid.name == "search" else { return nil }
        self.host = host
        if model.pid == nil, let pid = payload["pid"]?.intValue, model.items.isEmpty { Task { await load(pid: Int32(pid), appName: payload["appName"]?.stringValue) } }
        let rows = Self.rows(model.items, query: host.query)
        nav.sync(query: host.query, count: rows.count)
        return AnyView(SysRowsView(header: model.app.map { "\($0) Menus" }, rows: rows, selected: nav.index, emptySymbol: model.error == nil ? "magnifyingglass" : "exclamationmark.triangle",
                                   emptyTitle: model.error == nil ? "No matching menu items" : "Menus unavailable", emptySubtitle: model.error) { [weak self] i in self?.activate(i) }
            .onAppear {
                host.setPlaceholder("Search \(self.model.app ?? "app") menus…")
                host.setFooter(primary: "Press Menu Item", hasActions: false)
            })
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "list":
            await load(pid: args["pid"]?.intValue.map(Int32.init), appName: args["appName"]?.stringValue)
            return ["app": model.app.map(JSONValue.string) ?? .null, "error": model.error.map(JSONValue.string) ?? .null,
                    "items": .array(model.items.map { ["path": .array($0.path.map(JSONValue.string)), "enabled": .bool($0.enabled), "shortcut": $0.shortcut.map(JSONValue.string) ?? .null] })]
        case "press":
            let path = args["path"]?.arrayValue?.compactMap(\.stringValue) ?? []
            switch await press(path: path) {
            case let .error(m): return ["ok": false, "error": .string(m)]
            default: return ["ok": true]
            }
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

@MainActor @Observable final class MenusModel {
    var app: String?
    var pid: Int32?
    var items: [MenuItemInfo] = []
    var error: String?
}
