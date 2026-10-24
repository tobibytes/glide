import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem
import GlideUI

/// FeatureContext for phone-core unit tests: temp user data, headless services (side effects land in `log`),
/// and scripted answers for `callFeature` / `executeItem` / `search`.
@MainActor final class PhoneTestContext: FeatureContext {
    let featureId = "phone"
    let store: Store
    let services: SystemServices
    let log = SideEffectLog(echo: false)
    let root: URL
    var toasts: [String] = []
    var pushes: [String] = []
    var calls: [(feature: String, method: String, args: JSONValue)] = []
    var executed: [(id: String, argument: String?)] = []
    var items: [SearchItem] = []
    var effects: [(kind: String, detail: JSONValue)] = []
    var featureHandler: (String, String, JSONValue) throws -> JSONValue = { _, _, _ in .null }

    init() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("phone-core-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = Store(directory: root, debounce: 0)
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
    func executeItem(id: String, argument: String?) async -> ActionResult {
        executed.append((id, argument))
        return .hide(message: nil)
    }
    func search(_ query: String) async -> [ScoredItem] {
        items.filter { query.isEmpty || $0.title.lowercased().contains(query.lowercased()) }.map { ScoredItem(item: $0, score: 1) }
    }
    func findItem(id: String) -> SearchItem? { items.first { $0.id == id } }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue {
        calls.append((featureId, method, args))
        return try featureHandler(featureId, method, args)
    }
    func log(_ message: String) {}
    func recordEffect(kind: String, detail: JSONValue) { effects.append((kind, detail)) }

    func sideEffects(_ kind: String) -> [JSONValue] { log.all.filter { $0.kind == kind }.map(\.detail) }
    func cleanup() { try? FileManager.default.removeItem(at: root) }
}

/// A started PhoneFeature on a test context, with an in-memory key store (never the real Keychain).
@MainActor func makePhone(_ ctx: PhoneTestContext = PhoneTestContext()) async -> (PhoneFeature, PhoneTestContext) {
    let f = PhoneFeature()
    await f.start(context: ctx)
    f.core.devices = PhoneDeviceRegistry(keys: PhoneMemoryKeyStore(), file: nil)
    return (f, ctx)
}

let lanCaller = PhoneCaller(deviceId: "dev1", deviceName: "Test iPhone", transport: .lan)
let relayCaller = PhoneCaller(deviceId: "icloud", deviceName: "Shortcuts", transport: .relay)

func hex(_ s: String) -> Data {
    var d = Data()
    var i = s.startIndex
    let clean = s.filter { !$0.isWhitespace && $0 != ":" }
    i = clean.startIndex
    while i < clean.endIndex {
        let j = clean.index(i, offsetBy: 2)
        d.append(UInt8(clean[i..<j], radix: 16) ?? 0)
        i = j
    }
    return d
}

extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}

/// Wait (polling the main actor) until `cond` holds or the timeout passes.
@MainActor func waitUntil(_ timeout: Duration = .seconds(3), _ cond: () -> Bool) async -> Bool {
    let end = ContinuousClock.now + timeout
    while ContinuousClock.now < end {
        if cond() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return cond()
}
