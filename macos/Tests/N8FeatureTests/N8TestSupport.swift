import Foundation
import GlideCore
import GlideSystem

/// Scratch directories for N8 tests (removed by the caller).
func n8TempDir(_ name: String = "n8") -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("glide-n8-\(name)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

/// A FeatureContext over a real Store in a temp dir and the headless (side-effect recording) services.
@MainActor final class N8TestContext: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    let sideEffects = SideEffectLog(echo: false)
    var others: [String: any Feature] = [:]
    var refreshes = 0
    var pushed: [String] = []
    var shownLauncher = 0

    init(featureId: String, dir: URL = n8TempDir()) throws {
        self.featureId = featureId
        store = Store(directory: dir, debounce: 0.01)
        try store.load()
        services = SystemServicesFactory.headless(log: sideEffects)
    }

    func dataDirectory() -> URL {
        let d = GlidePaths.featureDirectory(featureId, root: store.directory)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue] { store.settings.featureSettings(featureId, defaults: defaults) }
    func setSettings(_ patch: [String: JSONValue]) { store.setFeatureSettings(featureId, patch) }
    func refreshCatalogue() { refreshes += 1 }
    func showLauncher() { shownLauncher += 1 }
    func hideLauncher() {}
    func push(_ view: ViewID, payload: JSONValue) { pushed.append(view.rawValue) }
    func openSettings(page: String?) {}
    func toast(_ message: String, style: ToastStyle) {}
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool { true }
    func executeItem(id: String, argument: String?) async -> ActionResult { .stay(message: nil) }
    func search(_ query: String) async -> [ScoredItem] { [] }
    func findItem(id: String) -> SearchItem? { nil }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue {
        guard let f = others[featureId] else { throw FeatureError.unknownFeature(featureId) }
        return try await f.invoke(method: method, args: args)
    }
    func log(_ message: String) {}
}
