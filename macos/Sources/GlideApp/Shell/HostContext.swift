import AppKit
import GlideCore
import GlideFeatures
import GlideSystem
import GlideUI
import SwiftUI

/// The FeatureContext each feature receives.
@MainActor final class HostContext: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    private unowned let app: AppCore

    init(featureId: String, app: AppCore) {
        self.featureId = featureId
        self.app = app
        store = app.store
        services = app.services
    }

    func dataDirectory() -> URL {
        let dir = GlidePaths.featureDirectory(featureId, root: store.directory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue] { store.settings.featureSettings(featureId, defaults: defaults) }
    func setSettings(_ patch: [String: JSONValue]) { store.setFeatureSettings(featureId, patch) }
    func refreshCatalogue() { app.launcher.scheduleCatalogueRebuild() }
    func showLauncher() { app.launcher.show() }
    func hideLauncher() { app.launcher.hide() }
    func push(_ view: ViewID, payload: JSONValue) {
        if app.window.isVisible == false { app.launcher.show() }
        app.launcher.push(view, payload: payload)
    }
    func openSettings(page: String?) { app.openSettings(page: page) }
    func toast(_ message: String, style: ToastStyle) { app.launcher.showToast(message, style) }

    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool {
        let id = "feature:\(featureId):\(key)"
        if let accelerator, !accelerator.isEmpty {
            guard case .success = HotkeyParser.parse(accelerator) else { return false }
            app.launcher.featureHotkeys[id] = handler
            app.launcher.featureHotkeyAccelerators[id] = accelerator
        } else {
            app.launcher.featureHotkeys[id] = nil
            app.launcher.featureHotkeyAccelerators[id] = nil
        }
        app.launcher.registerHotkeys()
        return true
    }

    func executeItem(id: String, argument: String?) async -> ActionResult {
        guard let item = app.launcher.engine.item(id) else { return .error("No item \(id)") }
        return await app.launcher.execute(ScoredItem(item: item, score: 0, argument: argument)) // the real result (integration)
    }

    func search(_ query: String) async -> [ScoredItem] {
        let dynamic = await app.registry.dynamicItems(for: query)
        return app.launcher.engine.search(query, dynamicItems: dynamic).sections.filter { $0.id != .fallbacks }.flatMap(\.items)
    }

    func findItem(id: String) -> SearchItem? { app.launcher.engine.item(id) }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue {
        try await app.registry.invoke(feature: featureId, method: method, args: args)
    }
    func log(_ message: String) { app.log("[\(featureId)] \(message)") }
    func recordEffect(kind: String, detail: JSONValue) {
        if let log = app.sideEffects { log.record(kind, detail) } else { app.log("[\(featureId)] effect \(kind)") }
    }
    func setStatusTitle(_ title: String) {
        let claimed = !title.isEmpty && (StatusTitleRouting.claim?(featureId, title) ?? false)
        app.setStatusTitle(feature: featureId, claimed ? "" : title)
        app.sideEffects?.record("status-title", ["feature": .string(featureId), "title": .string(title), "claimed": .bool(claimed)])
    }
}

/// Glide's own commands (feature id "glide"): keyboard cheat sheet and the command directory (pushed views),
/// reload, quit.
@MainActor final class GlideAppFeature: Feature, FeatureUI, FeatureCommandHandling {
    let id = "glide"
    let title = "Glide"
    private weak var context: FeatureContext?
    var onQuit: () -> Void = {}
    /// Wired by AppCore: the launcher's catalogue, feature titles, and opening an item from the root search.
    var catalogue: () -> [SearchItem] = { [] }
    var featureTitle: (String) -> String? = { _ in nil }
    var openItem: (SearchItem) -> Void = { _ in }
    var tryQuery: (String) -> Void = { _ in }

    /// Things that work by typing them straight into the search field (no command to pick first).
    static let typeExamples: [(text: String, what: String, symbol: String)] = [
        ("25 * 4 + 10%", "Calculator", "plus.forwardslash.minus"),
        ("5 ft 10 in to cm", "Unit conversion", "ruler"),
        ("100 usd in eur", "Currency conversion", "dollarsign.circle"),
        ("5pm london in tokyo", "Time zones", "globe"),
        ("days until dec 25", "Date math", "calendar"),
        ("timer 25m tea", "Start a named timer", "timer"),
        ("remind call mom tomorrow 9am", "Create a reminder", "checklist"),
        ("port 3000", "What is using a port", "network"),
        ("#ff8800", "Color preview and formats", "paintpalette"),
        ("cpu", "One-line system summary", "cpu"),
    ]
    func start(context: FeatureContext) async { self.context = context }

    /// Kinds that are things on the Mac, not things Glide does.
    static let directoryExcluded: Set<String> = ["app", "file", "calculator", "fallback"]

    lazy var directory = N7ListModel(placeholder: "Filter commands…", emptyTitle: "No commands match") { [weak self] q in self?.directoryRows(q) ?? [] }

    /// Every command in the catalogue, grouped by the feature that owns it (catalogue order), filtered by `query`.
    func directoryRows(_ query: String) -> [N7Row] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        var order: [String] = []
        var groups: [String: [N7Row]] = [:]
        var seen = Set<String>()
        for ex in Self.typeExamples {
            let section = "Just Type It"
            if !q.isEmpty, !q.split(separator: " ").allSatisfy({ "\(ex.text) \(ex.what) \(section)".lowercased().contains($0) }) { continue }
            if groups[section] == nil { order.append(section) }
            groups[section, default: []].append(N7Row(id: "type:\(ex.text)", section: section, icon: .symbol(ex.symbol), title: ex.text, subtitle: ex.what,
                                                      actions: [N7Action("try", "Try It", shortcut: "↩", icon: "text.cursor") { [weak self] in self?.tryQuery(ex.text) }]))
        }
        for item in catalogue() where !Self.directoryExcluded.contains(item.kind.rawValue) && !seen.contains(item.id) {
            seen.insert(item.id)
            let section = item.feature.flatMap(featureTitle) ?? item.displayKind
            if !q.isEmpty {
                let hay = ([item.title, item.subtitle ?? "", section, item.alias ?? ""] + (item.keywords ?? [])).joined(separator: " ").lowercased()
                guard q.split(separator: " ").allSatisfy({ hay.contains($0) }) else { continue }
            }
            var actions = [N7Action("open", "Open Command", shortcut: "↩", icon: "arrow.right.circle") { [weak self] in self?.openItem(item) }]
            if let f = item.feature, f != id {
                actions.append(N7Action("settings", "Open \(section) Settings", shortcut: "⌘↩", icon: "gearshape") { [weak self] in self?.context?.openSettings(page: f) })
            }
            let trailing = item.hotkey.map(Accelerator.display) ?? (item.acceptsArgument == true ? "takes input" : nil)
            if groups[section] == nil { order.append(section) }
            groups[section, default: []].append(N7Row(id: item.id, section: section, icon: item.icon, title: item.title, subtitle: item.subtitle,
                                                      tag: item.alias, trailing: trailing, actions: actions))
        }
        return order.flatMap { groups[$0] ?? [] }
    }

    func items() -> [SearchItem] {
        [SearchItem(id: "glide:commands", kind: .setting, title: "What Can Glide Do?", subtitle: "Every command, grouped by feature", icon: .symbol("square.grid.2x2"),
                    keywords: ["help", "all commands", "features", "list", "browse", "discover", "commands", "guide"], source: "settings", feature: id),
         SearchItem(id: "glide:shortcuts", kind: .setting, title: "Keyboard Shortcuts", subtitle: "Glide", icon: .symbol("keyboard"), keywords: ["vim", "keys", "help", "cheat sheet"], source: "settings", feature: id),
         SearchItem(id: "glide:reload", kind: .setting, title: "Reload Catalogue", subtitle: "Glide", icon: .symbol("arrow.triangle.2.circlepath"), keywords: ["refresh", "rescan"], source: "settings", feature: id),
         SearchItem(id: "glide:quit", kind: .setting, title: "Quit Glide", subtitle: "Glide", icon: .symbol("power"), keywords: ["exit", "close"], source: "settings", feature: id)]
    }

    func actions(for item: SearchItem) -> [ItemAction] { [ItemAction(id: "open", title: item.id == "glide:quit" ? "Quit" : "Open", shortcut: "↩")] }

    func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        switch item.item.id {
        case "glide:shortcuts": return .pushView("glide.shortcuts")
        case "glide:commands": return .pushView("glide.commands")
        case "glide:reload":
            _ = try? await context?.callFeature("apps", method: "rescan", args: .null)
            context?.refreshCatalogue()
            return .stay(message: "Catalogue reloaded")
        case "glide:quit":
            onQuit()
            return .hide()
        default: return .error("Unknown")
        }
    }

    func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        guard method == "viewState" else { throw FeatureError.unknownMethod(feature: id, method: method) }
        return directory.snapshot()
    }

    func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard id.name == "commands" else { return nil }
        DispatchQueue.main.async { MainActor.assumeIsolated { [weak self] in self?.directory.syncHost() } }
        return AnyView(N7ListView(model: directory))
    }
    func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { id.name == "commands" ? "What Can Glide Do?" : nil }
    func viewPlaceholder(_ id: ViewID, payload: JSONValue) -> String? { id.name == "commands" ? "Filter commands…" : nil }
    func handleKey(_ key: VimKey, view: ViewID) -> Bool { view.name == "commands" && directory.handleKey(key) }
    func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { view.name == "commands" && directory.handle(command) }
}
