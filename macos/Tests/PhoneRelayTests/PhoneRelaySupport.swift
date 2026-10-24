import Foundation
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem

/// Scratch root for every relay test. Never the real iCloud Drive: tests always point GLIDE_PHONE_RELAY_DIR here.
enum RelayScratch {
    static let base: URL = {
        let env = ProcessInfo.processInfo.environment
        let root = env["GLIDE_E2E_TMP"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
        let u = root.appendingPathComponent("phone-relay-tests-\(getpid())", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }()

    static func fresh(_ name: String) -> URL {
        let u = base.appendingPathComponent("\(name)-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    /// Any code path that computes the default roots inside the test process lands in scratch.
    static func pinEnvironment() {
        setenv(PhoneRelayPaths.envOverride, base.appendingPathComponent("default-relay").path, 1)
    }
}

@MainActor final class RelayTestContext: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    var logs: [String] = []
    var effects: [(String, JSONValue)] = []
    init(featureId: String, store: Store, services: SystemServices) {
        self.featureId = featureId
        self.store = store
        self.services = services
    }
    func dataDirectory() -> URL {
        let d = GlidePaths.featureDirectory(featureId, root: store.directory)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue] { store.settings.featureSettings(featureId, defaults: defaults) }
    func setSettings(_ patch: [String: JSONValue]) { store.setFeatureSettings(featureId, patch) }
    func refreshCatalogue() {}
    func showLauncher() {}
    func hideLauncher() {}
    func push(_ view: ViewID, payload: JSONValue) {}
    func openSettings(page: String?) {}
    func toast(_ message: String, style: ToastStyle) {}
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool { true }
    func executeItem(id: String, argument: String?) async -> ActionResult { .stay(message: nil) }
    func search(_ query: String) async -> [ScoredItem] { [] }
    func findItem(id: String) -> SearchItem? { nil }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue { .null }
    func log(_ message: String) { logs.append(message) }
    func recordEffect(kind: String, detail: JSONValue) { effects.append((kind, detail)) }
}

/// A started PhoneFeature on headless services and a temp store (no LAN server, no Keychain).
@MainActor final class RelayEnv {
    let dir: URL
    let store: Store
    let log = SideEffectLog(echo: false)
    let services: SystemServices
    let feature = PhoneFeature()
    private var contexts: [RelayTestContext] = []

    init(phoneSettings: [String: JSONValue] = [:]) async throws {
        RelayScratch.pinEnvironment()
        dir = RelayScratch.fresh("store")
        store = Store(directory: dir)
        _ = try store.load()
        services = SystemServicesFactory.headless(log: log, environment: [:])
        if !phoneSettings.isEmpty { store.setFeatureSettings("phone", phoneSettings) }
        let c = context("phone")
        await feature.start(context: c)
    }

    func context(_ id: String) -> RelayTestContext {
        let c = RelayTestContext(featureId: id, store: store, services: services)
        contexts.append(c)
        return c
    }

    func stop() async {
        await feature.stop()
        try? FileManager.default.removeItem(at: dir)
    }
}

extension JSONValue {
    static func parse(_ d: Data) -> JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: d) }
}

func writeRequest(_ root: URL, _ name: String, _ json: String, modified: Date? = nil) throws {
    let inbox = PhoneRelayPaths.inbox(root)
    try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
    let u = inbox.appendingPathComponent(name)
    try Data(json.utf8).write(to: u)
    if let modified { try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: u.path) }
}

func readReply(_ root: URL, _ id: String) -> JSONValue? {
    (try? Data(contentsOf: PhoneRelayPaths.outbox(root).appendingPathComponent("\(id).json"))).flatMap(JSONValue.parse)
}

func inboxNames(_ root: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: PhoneRelayPaths.inbox(root).path)) ?? []).sorted()
}
