import Foundation
import GlideCore
import GlideSystem
import GlideTestHarness
@testable import GlideFeatures

/// Scratch dir for phone-notify tests (GLIDE_E2E_TMP when set, else $TMPDIR).
func notifyTempDir(_ name: String) -> URL {
    let root = ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
    let d = root.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

/// Several features in one process sharing one Store, with `callFeature` routed between them. Headless services:
/// nothing reaches the screen, pasteboard, network listeners on other interfaces or the user's Keychain.
@MainActor final class NotifyTestHost {
    let root: URL
    let store: Store
    let log = SideEffectLog(echo: false)
    let services: SystemServices
    var features: [String: any Feature] = [:]
    var contexts: [String: NotifyTestContext] = [:]

    init(_ name: String = "phone-notify") {
        root = notifyTempDir(name)
        store = Store(directory: root, debounce: 0)
        services = SystemServicesFactory.headless(log: log, environment: [:])
    }

    func add(_ f: any Feature) async {
        let c = NotifyTestContext(f.id, host: self)
        features[f.id] = f
        contexts[f.id] = c
        await f.start(context: c)
    }

    func stopAll() async {
        for f in features.values { await f.stop() }
        try? FileManager.default.removeItem(at: root)
    }

    func effects(_ kind: String) -> [JSONValue] { log.all.filter { $0.kind == kind }.map(\.detail) }
}

@MainActor final class NotifyTestContext: FeatureContext {
    let featureId: String
    weak var host: NotifyTestHost?
    let store: Store
    let services: SystemServices
    var logs: [String] = []

    init(_ id: String, host: NotifyTestHost) {
        featureId = id
        self.host = host
        store = host.store
        services = host.services
    }

    func dataDirectory() -> URL {
        let d = GlidePaths.featureDirectory(featureId, root: host?.root ?? FileManager.default.temporaryDirectory)
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
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue {
        guard let f = host?.features[featureId] else { throw FeatureError.unknownFeature(featureId) }
        return try await f.invoke(method: method, args: args)
    }
    func log(_ message: String) { logs.append(message) }
    func recordEffect(kind: String, detail: JSONValue) { host?.log.record(kind, detail) }
}

/// A fake ntfy server: records every POST and answers with the scripted statuses (then 200).
final class FakeNtfy: @unchecked Sendable {
    let server: FakeAnthropicServer
    private let lock = NSLock()
    private var statuses: [Int]

    init(statuses: [Int] = []) throws {
        self.statuses = statuses
        let box = WeakBox()
        server = try FakeAnthropicServer { _ in
            let st = box.ref?.nextStatus() ?? 200
            return .json(st, st == 200 ? ["id": "msg1", "event": "message"] : ["error": "nope"], headers: st == 429 ? ["Retry-After": "0"] : [:])
        }
        box.ref = self
    }

    final class WeakBox: @unchecked Sendable { weak var ref: FakeNtfy? }

    func nextStatus() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return statuses.isEmpty ? 200 : statuses.removeFirst()
    }

    var baseURL: String { server.baseURL }
    var posts: [FakeAnthropicServer.Request] { server.requests.filter { $0.method == "POST" } }
    func stop() { server.stop() }
}

/// Wait (polling) for a condition; the main actor keeps running in between.
@MainActor func notifyWait(_ timeout: Double = 5, _ cond: @MainActor () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if cond() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return cond()
}

/// Messages API SSE for one tool_use block (the Glide Agent calling a tool), for the fake Anthropic server.
func sseToolUse(id: String, name: String, input: [String: Any], text: String? = nil) -> FakeAnthropicServer.Response {
    typealias R = FakeAnthropicServer.Response
    var events: [String] = []
    events.append(R.event("message_start", ["type": "message_start", "message": ["id": "msg_fake", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                                                                               "content": [], "usage": ["input_tokens": 12, "output_tokens": 1]]]))
    var index = 0
    if let text {
        events.append(R.event("content_block_start", ["type": "content_block_start", "index": index, "content_block": ["type": "text", "text": ""]]))
        events.append(R.event("content_block_delta", ["type": "content_block_delta", "index": index, "delta": ["type": "text_delta", "text": text]]))
        events.append(R.event("content_block_stop", ["type": "content_block_stop", "index": index]))
        index += 1
    }
    let json = (try? JSONSerialization.data(withJSONObject: input)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    events.append(R.event("content_block_start", ["type": "content_block_start", "index": index, "content_block": ["type": "tool_use", "id": id, "name": name, "input": [String: Any]()]]))
    events.append(R.event("content_block_delta", ["type": "content_block_delta", "index": index, "delta": ["type": "input_json_delta", "partial_json": json]]))
    events.append(R.event("content_block_stop", ["type": "content_block_stop", "index": index]))
    events.append(R.event("message_delta", ["type": "message_delta", "delta": ["stop_reason": "tool_use", "stop_sequence": NSNull()], "usage": ["output_tokens": 20]]))
    events.append(R.event("message_stop", ["type": "message_stop"]))
    return R(status: 200, headers: ["content-type": "text/event-stream"], chunks: events.map { (Data($0.utf8), 0.0) })
}
