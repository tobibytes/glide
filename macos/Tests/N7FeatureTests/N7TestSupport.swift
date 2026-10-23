import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem
import GlideUI

/// FeatureContext for unit tests: temp user data, headless services (nothing reaches the screen,
/// pasteboard, notifications or other apps — side effects land in `log`).
@MainActor final class N7TestContext: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    let log = SideEffectLog(echo: false)
    let root: URL
    var toasts: [String] = []
    var pushes: [String] = []

    init(_ featureId: String, root: URL? = nil) {
        self.featureId = featureId
        self.root = root ?? FileManager.default.temporaryDirectory.appendingPathComponent("n7-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
        store = Store(directory: self.root, debounce: 0)
        services = SystemServicesFactory.headless(log: log, environment: [:])
    }

    func dataDirectory() -> URL {
        let d = GlidePaths.featureDirectory(featureId, root: root)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue] { store.settings.featureSettings(featureId, defaults: defaults) }
    func setSettings(_ patch: [String: JSONValue]) { store.setFeatureSettings(featureId, patch) }
    func refreshCatalogue() {}
    func showLauncher() {}
    func hideLauncher() {}
    func push(_ view: ViewID, payload: JSONValue) { pushes.append(view.rawValue) }
    func openSettings(page: String?) {}
    func toast(_ message: String, style: ToastStyle) { toasts.append(message) }
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool { true }
    func executeItem(id: String, argument: String?) async -> ActionResult { .stay(message: nil) }
    func search(_ query: String) async -> [ScoredItem] { [] }
    func findItem(id: String) -> SearchItem? { nil }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue { .null }
    func log(_ message: String) {}

    func effects(_ kind: String) -> [JSONValue] { log.all.filter { $0.kind == kind }.map(\.detail) }
    func cleanup() { try? FileManager.default.removeItem(at: root) }
}

/// Minimal LauncherViewHost so list models can be driven without the app.
@MainActor final class N7TestHost: LauncherViewHost {
    var query = ""
    var placeholder = ""
    var footer: String?
    var toasts: [String] = []
    var closed = false
    func setPlaceholder(_ text: String) { placeholder = text }
    func push(_ view: ViewID, payload: JSONValue) {}
    func pop() {}
    func close() { closed = true }
    func toast(_ message: String, style: ToastStyle) { toasts.append(message) }
    func setFooter(primary: String?, hasActions: Bool) { footer = primary }
}

/// Local-time date helper.
func localDate(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0) -> Date {
    Calendar.current.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min)) ?? Date()
}
