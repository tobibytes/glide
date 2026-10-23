import Foundation
import GlideTestHarness
import GlideCore
@testable import GlideFeatures

/// Scratch dir for N5 tests (under $TMPDIR, which scripts point at the session scratchpad).
func n5TempDir(_ name: String = "n5") -> URL {
    let root = ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
    let d = root.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

/// The fixture MCP server binary (built next to the test bundle).
func fixtureServerPath() -> String? {
    for b in Bundle.allBundles where b.bundlePath.hasSuffix(".xctest") {
        let c = b.bundleURL.deletingLastPathComponent().appendingPathComponent("mcp-fixture-server")
        if FileManager.default.isExecutableFile(atPath: c.path) { return c.path }
    }
    if let p = ProcessInfo.processInfo.environment["N5_FIXTURE_SERVER"] { return p }
    // GLIDE_BINARY, else the build dir of the loaded test bundle (GlideDriver.defaultBinary handles swift-testing).
    if let g = GlideDriver.defaultBinary() {
        let c = g.deletingLastPathComponent().appendingPathComponent("mcp-fixture-server").path
        if FileManager.default.isExecutableFile(atPath: c) { return c }
    }
    return nil
}

func processAlive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

func waitUntil(_ timeout: Double = 5, _ cond: @MainActor () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if await cond() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return await cond()
}

/// Fake capabilities: records calls; feature methods answered from `features`.
@MainActor final class FakeCaps: AgentCapabilities {
    var log: [String] = []
    var installed: Set<String> = ["timers", "notes", "automations", "layouts", "transforms", "processes", "sysmon", "reminders", "clipboard", "browser"]
    var features: [String: (JSONValue) throws -> JSONValue] = [:]
    var catalogue: [AgentHit] = [AgentHit(id: "app:/Applications/Safari.app", title: "Safari", kind: "app"),
                                 AgentHit(id: "windows.left-half", title: "Left Half", subtitle: "Window", kind: "Window")]
    var clipboard = "old clipboard"
    var workflows: [Workflow] = [Workflow(id: "wf1", name: "Standup", actions: [])]
    var snippetList: [Snippet] = []
    var quicklinks: [Quicklink] = []
    var processes: [AgentProcessRow] = [AgentProcessRow(pid: 123, name: "Slack", cpu: 12, rssKb: 204_800, user: "me", command: "/Applications/Slack.app/Contents/MacOS/Slack"),
                                        AgentProcessRow(pid: 88, name: "WindowServer", cpu: 30, rssKb: 100, user: "_windowserver", command: "/System/WindowServer")]
    var appearanceState = AgentAppearance(mode: "system", darkTheme: "glide-dark", lightTheme: "glide-light", presets: [("glide-dark", "Glide Dark", "dark"), ("nord", "Nord", "dark")])
    var nowMs: Double = 1_760_000_000_000

    init() {
        var timers: [JSONValue] = []
        features["timers.state"] = { _ in ["timers": .array(timers)] }
        features["timers.start"] = { a in
            timers.append(["id": .string("t\(timers.count + 1)"), "name": a["name"] ?? ""])
            return ["ok": true]
        }
        features["timers.stop"] = { a in
            timers.removeAll { $0["id"] == a["id"] }
            return ["ok": true]
        }
        var notes: [JSONValue] = []
        features["notes.create"] = { a in
            let n: JSONValue = ["id": .string("n\(notes.count + 1)"), "title": .string(a["text"]?.stringValue?.components(separatedBy: "\n").first ?? ""), "body": a["text"] ?? ""]
            notes.append(n)
            return n
        }
        features["notes.search"] = { _ in .array(notes) }
        features["notes.remove"] = { a in
            let before = notes.count
            notes.removeAll { $0["id"] == a["id"] }
            return .bool(notes.count < before)
        }
        features["notes.open"] = { _ in true }
        features["notes.get"] = { a in notes.first { $0["id"] == a["id"] } ?? .null }
        features["transforms.list"] = { _ in [["id": "upper", "title": "UPPER CASE", "category": "case"]] }
        features["transforms.apply"] = { a in ["ok": true, "output": .string((a["input"]?.stringValue ?? "").uppercased())] }
        features["clipboard.list"] = { _ in [["type": "text", "title": "secret", "preview": "secret text", "lastCopiedAt": 1]] }
    }

    func now() -> Double { nowMs }
    func hasFeature(_ id: String) -> Bool { installed.contains(id) }
    func call(_ feature: String, _ method: String, _ args: JSONValue) async throws -> JSONValue {
        log.append("\(feature).\(method)")
        guard installed.contains(feature) || feature == "convert" else { throw AgentToolFailure("The \(feature) feature is not available") }
        guard let f = features["\(feature).\(method)"] else { throw AgentToolFailure("The \(feature) feature does not support \(method) yet") }
        return try f(args)
    }
    func search(_ query: String, limit: Int) async -> [AgentHit] {
        log.append("search \(query)")
        return Array(catalogue.filter { $0.title.lowercased().contains(query.lowercased()) }.prefix(limit))
    }
    func findItem(_ id: String) -> AgentHit? { catalogue.first { $0.id == id } }
    func executeItem(_ id: String, argument: String?) async -> AgentOp { log.append("execute \(id)"); return AgentOp(ok: true, message: "Ran \(id)") }
    func workflowForItem(_ id: String, argument: String?, title: String?) -> AgentWorkflowStep? {
        AgentWorkflowPlanner.itemToWorkflowStep(id, argument: argument, data: UserData(), title: title)
    }
    func listWorkflows() -> [Workflow] { workflows }
    func runWorkflow(_ id: String, input: String?) async -> (ok: Bool, result: String?, error: String?) { log.append("workflow \(id)"); return (true, "done", nil) }
    func windowAction(_ action: String, app: String?) async -> AgentOp { log.append("window \(action) \(app ?? "-")"); return AgentOp(ok: true, message: "Window moved") }
    func windowSnapshot() async -> JSONValue? { [["pid": 1, "title": "w", "order": 0, "frame": ["x": 0, "y": 0, "width": 10, "height": 10]]] }
    func restoreWindows(_ snapshot: JSONValue) async -> AgentOp { log.append("restoreWindows"); return AgentOp(ok: true, message: "Windows restored") }
    func openURL(_ url: String) -> AgentOp { log.append("open \(url)"); return AgentOp(ok: true, message: "Opened \(url)") }
    func openApp(_ name: String) async -> AgentOp { log.append("app \(name)"); return AgentOp(ok: true, message: "Opened \(name)") }
    func openFile(_ path: String) -> AgentOp { AgentOp(ok: false, error: "No file at \(path)") }
    func clipboardText() -> String { clipboard }
    func copyText(_ text: String) -> AgentOp { clipboard = text; log.append("copy"); return AgentOp(ok: true, message: "Copied") }
    func selectedText() async -> (text: String?, error: String?) { ("selected words", nil) }
    func calendarEvents(from: Date, to: Date) async -> (events: JSONValue?, error: String?) { (nil, "Glide doesn't have calendar access.") }
    func snippets() -> [Snippet] { snippetList }
    func saveSnippet(_ s: Snippet) { snippetList.append(s) }
    func deleteSnippet(_ id: String) -> Bool { let n = snippetList.count; snippetList.removeAll { $0.id == id }; return snippetList.count < n }
    func saveQuicklink(_ q: Quicklink) { quicklinks.append(q) }
    func deleteQuicklink(_ id: String) -> Bool { let n = quicklinks.count; quicklinks.removeAll { $0.id == id }; return quicklinks.count < n }
    func listProcesses() async throws -> [AgentProcessRow] { processes }
    func killProcess(pid: Int, force: Bool, expectedCommand: String) async -> AgentOp { log.append("kill \(pid) \(force)"); return AgentOp(ok: true, message: "Quit") }
    func runShortcut(_ name: String, input: String?) async -> (ok: Bool, output: String?, error: String?) { log.append("shortcut \(name)"); return (true, "out", nil) }
    func appearance() -> AgentAppearance { appearanceState }
    func setAppearance(mode: String?, preset: String?) -> AgentOp {
        if let mode { appearanceState.mode = mode }
        if let preset { appearanceState.darkTheme = preset }
        return AgentOp(ok: true, message: "Theme changed")
    }
    func restoreAppearance(_ prev: AgentAppearance) -> AgentOp { appearanceState = prev; return AgentOp(ok: true, message: "Theme restored") }
}

typealias Turn = AgentScriptedClient.Turn

@MainActor func scripted(_ turns: [Turn]) -> AgentScriptedClient { AgentScriptedClient(turns: turns.map { var t = $0; t.delayMs = 0; return t }) }

@MainActor func loop(_ client: AgentScriptedClient, _ caps: FakeCaps, prompt: String = "do it", tools: [AgentTool]? = nil) -> AgentLoop {
    AgentLoop(runId: "r1", prompt: prompt, client: client, tools: tools ?? AgentTools.all(), caps: caps, model: "test-model")
}

func call(_ name: String, _ input: JSONValue = [:]) -> (name: String, input: JSONValue) { (name, input) }
