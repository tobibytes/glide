import Foundation
import GlideCore
import GlideSystem

/// A FeatureContext over a temp Store and the headless services (fake pasteboard / paste / selection).
@MainActor final class N4TestContext: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    let root: URL
    let sideLog = SideEffectLog(echo: false)
    var toasts: [(String, ToastStyle)] = []
    var hidden = 0
    var openedSettings: [String?] = []
    var refreshes = 0

    init(featureId: String, selection: String? = nil, clipboard: String? = nil) throws {
        self.featureId = featureId
        root = FileManager.default.temporaryDirectory.appendingPathComponent("n4-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = Store(directory: root, debounce: 0)
        try store.load()
        services = SystemServicesFactory.headless(log: sideLog, environment: selection.map { ["GLIDE_HEADLESS_SELECTION": $0] } ?? [:])
        if let clipboard { services.pasteboard.setString(clipboard, html: nil, transient: false) }
        sideLog.clear()
    }

    func cleanup() { try? FileManager.default.removeItem(at: root) }

    func dataDirectory() -> URL {
        let d = GlidePaths.featureDirectory(featureId, root: root)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue] { store.settings.featureSettings(featureId, defaults: defaults) }
    func setSettings(_ patch: [String: JSONValue]) { store.setFeatureSettings(featureId, patch) }
    func refreshCatalogue() { refreshes += 1 }
    func showLauncher() {}
    func hideLauncher() { hidden += 1 }
    func push(_ view: ViewID, payload: JSONValue) {}
    func openSettings(page: String?) { openedSettings.append(page) }
    func toast(_ message: String, style: ToastStyle) { toasts.append((message, style)) }
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool { true }
    func executeItem(id: String, argument: String?) async -> ActionResult { .stay(message: nil) }
    func search(_ query: String) async -> [ScoredItem] { [] }
    func findItem(id: String) -> SearchItem? { nil }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue { .null }
    func log(_ message: String) {}

    func effects(_ kind: String) -> [JSONValue] { sideLog.all.filter { $0.kind == kind }.map(\.detail) }
}
