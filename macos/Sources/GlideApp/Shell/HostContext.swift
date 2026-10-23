import AppKit
import GlideCore
import GlideSystem
import GlideUI

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

/// Glide's own commands (feature id "glide"): keyboard cheat sheet (a pushed view), reload, quit.
@MainActor final class GlideAppFeature: Feature, FeatureUI {
    let id = "glide"
    let title = "Glide"
    private weak var context: FeatureContext?
    var onQuit: () -> Void = {}
    func start(context: FeatureContext) async { self.context = context }

    func items() -> [SearchItem] {
        [SearchItem(id: "glide:shortcuts", kind: .setting, title: "Keyboard Shortcuts", subtitle: "Glide", icon: .symbol("keyboard"), keywords: ["vim", "keys", "help", "cheat sheet"], source: "settings", feature: id),
         SearchItem(id: "glide:reload", kind: .setting, title: "Reload Catalogue", subtitle: "Glide", icon: .symbol("arrow.triangle.2.circlepath"), keywords: ["refresh", "rescan"], source: "settings", feature: id),
         SearchItem(id: "glide:quit", kind: .setting, title: "Quit Glide", subtitle: "Glide", icon: .symbol("power"), keywords: ["exit", "close"], source: "settings", feature: id)]
    }

    func actions(for item: SearchItem) -> [ItemAction] { [ItemAction(id: "open", title: item.id == "glide:quit" ? "Quit" : "Open", shortcut: "↩")] }

    func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        switch item.item.id {
        case "glide:shortcuts": return .pushView("glide.shortcuts")
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
}
