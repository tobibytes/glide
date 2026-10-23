import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem

/// Records every effect; nothing touches the system.
@MainActor final class FakeWorkflowEnv: WorkflowEnvironment {
    var workflows: [Workflow] = []
    var effects: [String] = []
    var clipboard = ""
    var answers: [String?] = []
    var shellResult = ShellResult(status: 0, stdout: "shell-out\n", stderr: "")
    var appleScriptResult = "as-out"
    var httpResult: (Int, String) = (200, "{\"ok\":true}")
    var selection = "selected text"
    var openFails = false
    var slept: [Double] = []
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    var sleepHook: (() async throws -> Void)?

    func workflow(id: String) -> Workflow? { workflows.first { $0.id == id } }
    func openApp(_ app: String) async throws {
        if openFails { throw WorkflowStepError("Could not open \(app)") }
        effects.append("openApp:\(app)")
    }
    func openURL(_ url: URL) async throws { effects.append("openUrl:\(url.absoluteString)") }
    func openFile(_ path: String) async throws { effects.append("openFile:\(path)") }
    func runShell(_ command: String, shell: String, timeout: TimeInterval) async throws -> ShellResult {
        effects.append("shell:\(shell):\(command)")
        return shellResult
    }
    func runAppleScript(_ source: String) async throws -> String {
        effects.append("applescript:\(source)")
        return appleScriptResult
    }
    func typeText(_ text: String) async throws { effects.append("type:\(text)") }
    func readClipboard() -> String { clipboard }
    func writeClipboard(_ text: String) {
        clipboard = text
        effects.append("clipboard:\(text)")
    }
    func notify(title: String, body: String) async throws { effects.append("notify:\(title)|\(body)") }
    func sleep(seconds: Double) async throws {
        slept.append(seconds)
        try await sleepHook?()
    }
    func askInput(prompt: String, placeholder: String?) async -> String? {
        effects.append("ask:\(prompt)")
        return answers.isEmpty ? nil : answers.removeFirst()
    }
    func showResult(text: String, title: String?) { effects.append("show:\(title ?? "")|\(text)") }
    func http(method: String, url: URL, headers: [String: String], body: String?, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        effects.append("http:\(method) \(url.absoluteString) \(headers.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ",")) \(body ?? "-")")
        return httpResult
    }
    func playSound(_ name: String) async throws { effects.append("sound:\(name)") }
    func selectedText() async -> String {
        effects.append("selection")
        return selection
    }
    func now() -> Date { clock }
}

/// A FeatureContext over a temp Store and the headless services (side effects recorded, never performed).
@MainActor final class FakeFeatureContext: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    let effectLog: SideEffectLog
    let root: URL
    var hotkeys: [String: String] = [:]
    var hotkeyHandlers: [String: @MainActor () -> Void] = [:]
    var refuseHotkeys = false
    var features: [String: any Feature] = [:]
    var executed: [(String, String?)] = []
    var items: [SearchItem] = []
    var logs: [String] = []
    var pushed: [(ViewID, JSONValue)] = []
    var hidden = 0
    /// Other contexts this test keeps alive (features hold contexts weakly).
    var retained: [AnyObject] = []

    init(featureId: String, root: URL? = nil, workflows: [Workflow] = []) throws {
        self.featureId = featureId
        self.root = root ?? FileManager.default.temporaryDirectory.appendingPathComponent("n6-tests-\(UUID().uuidString)", isDirectory: true)
        store = Store(directory: self.root, debounce: 0.01)
        try store.load()
        store.mutate { $0.workflows = workflows }
        effectLog = SideEffectLog(echo: false)
        services = SystemServicesFactory.headless(log: effectLog, environment: [:])
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
    func hideLauncher() { hidden += 1 }
    func push(_ view: ViewID, payload: JSONValue) { pushed.append((view, payload)) }
    func openSettings(page: String?) {}
    func toast(_ message: String, style: ToastStyle) {}
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool {
        if refuseHotkeys && accelerator != nil { return false }
        hotkeys[key] = accelerator
        hotkeyHandlers[key] = accelerator == nil ? nil : handler
        return true
    }
    func executeItem(id: String, argument: String?) async -> ActionResult {
        executed.append((id, argument))
        return .stay(message: "ran \(id)")
    }
    func search(_ query: String) async -> [ScoredItem] { items.filter { $0.title.localizedCaseInsensitiveContains(query) || query.contains($0.title) }.map { ScoredItem(item: $0, score: 1) } }
    func findItem(id: String) -> SearchItem? { items.first { $0.id == id } }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue {
        guard let f = features[featureId] else { throw FeatureError.unknownFeature(featureId) }
        return try await f.invoke(method: method, args: args)
    }
    func log(_ message: String) { logs.append(message) }
}

func wf(_ id: String, _ name: String, _ actions: [WorkflowAction], acceptsInput: Bool? = nil) -> Workflow {
    Workflow(id: id, name: name, acceptsInput: acceptsInput, actions: actions)
}

func wf(_ id: String, _ actions: [WorkflowAction]) -> Workflow { Workflow(id: id, name: "WF", actions: actions) }

func act(_ id: String, _ type: String, _ params: [String: JSONValue] = [:], then: [WorkflowAction]? = nil, else e: [WorkflowAction]? = nil, disabled: Bool? = nil) -> WorkflowAction {
    WorkflowAction(id: id, type: type, params: params, then: then, else: e, disabled: disabled)
}
