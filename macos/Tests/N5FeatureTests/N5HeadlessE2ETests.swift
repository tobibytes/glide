import Foundation
import GlideCore
import GlideTestHarness
import Testing
@testable import GlideFeatures

/// Headless driver checks: the real Glide binary (GLIDE_HEADLESS, test channel), a scripted model
/// (GLIDE_AGENT_MOCK) and Glide's own MCP client against the app's MCP server. Nothing reaches the screen.
let n5SnapshotDir = ProcessInfo.processInfo.environment["GLIDE_SNAPSHOT_DIR"] ?? (ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"] ?? NSTemporaryDirectory()) + "/n5-snapshots"

@MainActor @Suite("N5 headless end-to-end", .serialized)
struct N5HeadlessE2ETests {
    func viewState(_ d: GlideDriver) throws -> [String: Any] { (try d.invoke("agent", "viewState")["result"] as? [String: Any]) ?? [:] }

    func poll(_ d: GlideDriver, _ timeout: Double = 8, _ cond: ([String: Any]) -> Bool) throws -> [String: Any] {
        let end = Date().addingTimeInterval(timeout)
        var last: [String: Any] = [:]
        while Date() < end {
            last = try viewState(d)
            if cond(last) { return last }
            usleep(50_000)
        }
        return last
    }

    func writeScript(_ obj: Any) throws -> String {
        let path = n5TempDir("n5-mock").appendingPathComponent("mock.json").path
        try JSONSerialization.data(withJSONObject: obj).write(to: URL(fileURLWithPath: path))
        return path
    }

    @Test func agentConfirmRunUndoSaveAndHistory() throws {
        let script = try writeScript(["model": "mock-model", "turns": [
            ["text": "Opening it.", "delay_ms": 1, "tool_calls": [["name": "open_url", "input": ["url": "https://example.com/agent"]], ["name": "copy_to_clipboard", "input": ["text": "agent text"]]]],
            ["text": "Opened example.com and copied the text.", "delay_ms": 1],
        ]])
        let d = try GlideDriver(environment: ["GLIDE_AGENT_MOCK": script])
        defer { d.stop() }
        _ = try d.show()
        let opened = try d.invoke("agent", "open", ["prompt": "open example and copy", "fresh": true])
        #expect(opened["ok"] as? Bool == true)
        var s = try poll(d) { $0["status"] as? String == "confirming" }
        #expect(s["status"] as? String == "confirming")
        let st = try d.state()
        #expect(st["view"] as? String == "agent.run")
        #expect(st["primaryAction"] as? String == "Run")
        try FileManager.default.createDirectory(atPath: n5SnapshotDir, withIntermediateDirectories: true)
        let snap1 = try d.snapshot("\(n5SnapshotDir)/agent-confirm.png")
        #expect((snap1["width"] as? Int ?? 0) > 0)
        // Nothing ran yet.
        #expect(!d.sideEffects.contains { $0.kind == "open-url" })
        // ⌘⏎: run and allow these tools from now on.
        try d.key("cmdEnter")
        s = try poll(d) { $0["status"] as? String == "done" }
        #expect(s["status"] as? String == "done")
        #expect(d.sideEffects.contains { $0.kind == "open-url" && $0.detail.contains("example.com/agent") })
        #expect((try d.invoke("headless", "pasteboard")["result"] as? String) == "agent text")
        let allow = ((try d.invoke("agent", "getSettings")["result"] as? [String: Any])?["allow"] as? [String: Any]) ?? [:]
        #expect(allow["open_url"] as? Bool == true && allow["copy_to_clipboard"] as? Bool == true)
        _ = try d.snapshot("\(n5SnapshotDir)/agent-done.png")
        // ⌘Z puts the clipboard back.
        try d.key("cmd+z")
        usleep(300_000)
        #expect((try d.invoke("headless", "pasteboard")["result"] as? String) != "agent text")
        // History is saved compatibly.
        try d.invoke("agent", "flushHistory")
        let file = d.dataDirectory.appendingPathComponent("features/agent/conversations.json")
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        #expect(saved?["version"] as? Int == 1)
        let convs = (try d.invoke("agent", "listConversations", "")["result"] as? [[String: Any]]) ?? []
        #expect(convs.count == 1)
        // History view lists it.
        try d.key("cmd+y")
        #expect(try d.state()["view"] as? String == "agent.history")
        _ = try d.snapshot("\(n5SnapshotDir)/agent-history.png")
    }

    @Test func escapeDeclinesAndSaveAsWorkflow() throws {
        let script = try writeScript(["turns": [
            ["tool_calls": [["name": "open_app", "input": ["name": "Notes"]]], "delay_ms": 1],
            ["text": "Skipped.", "delay_ms": 1],
            ["tool_calls": [["name": "open_url", "input": ["url": "https://example.org"]]], "delay_ms": 1],
            ["text": "Done.", "delay_ms": 1],
        ]])
        let d = try GlideDriver(environment: ["GLIDE_AGENT_MOCK": script])
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("agent", "open", ["prompt": "open notes", "fresh": true])
        _ = try poll(d) { $0["status"] as? String == "confirming" }
        try d.key("esc")
        let s = try poll(d) { $0["status"] as? String == "done" }
        let run = s["run"] as? [String: Any]
        let step = ((run?["entries"] as? [[String: Any]]) ?? []).compactMap { $0["step"] as? [String: Any] }.first
        #expect(step?["status"] as? String == "declined")
        #expect(!d.sideEffects.contains { $0.kind == "launch-app" })
        // Follow-up in the same conversation: typed in the field, sent with ⏎.
        try d.type("now open the site")
        try d.key("enter")
        _ = try poll(d) { ($0["run"] as? [String: Any])?["prompt"] as? String == "now open the site" && $0["status"] as? String == "confirming" }
        try d.key("enter")
        let s2 = try poll(d) { $0["status"] as? String == "done" && ($0["run"] as? [String: Any])?["prompt"] as? String == "now open the site" }
        #expect(s2["runs"] as? Int == 2)
        #expect(try d.state()["query"] as? String == "")
        try d.key("cmd+s")
        let wfs = ((try d.invoke("store", "data")["result"] as? [String: Any])?["workflows"] as? [[String: Any]]) ?? []
        let wf = wfs.first { ($0["id"] as? String)?.hasPrefix("wf-agent-") == true }
        #expect(wf?["name"] as? String == "now open the site")
        #expect(((wf?["actions"] as? [[String: Any]])?.first)?["type"] as? String == "openUrl")
    }

    @Test func mcpServerOverHTTPWithConfirmationAndStdioBridge() async throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        let st = (try d.invoke("mcp-server", "setSettings", ["enabled": true, "port": 0, "tools": ["run_command": "ask"]])["result"] as? [String: Any]) ?? [:]
        #expect(st["running"] as? Bool == true)
        let urlString = try #require(st["url"] as? String)
        let dir = d.dataDirectory.appendingPathComponent("features/mcp-server")
        let token = try #require(MCPServerAuth.readToken(dir))
        #expect(MCPServerAuth.readDiscovery(dir)?.url == urlString)

        let client = MCPClientSession(transport: MCPHTTPClientTransport(url: try #require(URL(string: urlString)), headers: ["Authorization": "Bearer \(token)"]), clientName: "E2E Agent")
        try await client.connect()
        let tools = try await client.listTools()
        #expect(tools.contains { $0.name == "search_glide" })
        #expect(tools.contains { $0.name == "run_command" }) // set to Ask
        #expect(!tools.contains { $0.name == "clipboard_history_search" }) // off by default
        let search = try await client.callTool("search_glide", arguments: ["query": "Calculator"], timeout: .seconds(10))
        let hits = MCP.decode(Data(MCPSchema.resultText(search).utf8))?.arrayValue ?? []
        let id = try #require(hits.first { ($0["id"]?.stringValue ?? "").hasPrefix("app:") }?["id"]?.stringValue)

        let pending = Task { @MainActor in try await client.callTool("run_command", arguments: ["id": .string(id)], timeout: .seconds(20)) }
        try await Task.sleep(for: .milliseconds(400))
        var waiting: [[String: Any]] = []
        for _ in 0..<40 {
            waiting = (try d.invoke("mcp-server", "pending")["result"] as? [[String: Any]]) ?? []
            if !waiting.isEmpty { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(waiting.first?["client"] as? String == "E2E Agent")
        #expect(try d.state()["view"] as? String == "mcp-server.confirm")
        try FileManager.default.createDirectory(atPath: n5SnapshotDir, withIntermediateDirectories: true)
        _ = try d.snapshot("\(n5SnapshotDir)/mcp-confirm.png")
        try d.key("enter") // Allow Once
        let result = try await pending.value
        #expect(result["isError"] == nil)
        #expect(d.sideEffects.contains { $0.kind == "open-path" && $0.detail.contains(".app") })
        let log = (try d.invoke("mcp-server", "log")["result"] as? [[String: Any]]) ?? []
        #expect(log.first?["outcome"] as? String == "ok" && log.first?["approval"] as? String == "user")
        await client.close()
        _ = try d.invoke("mcp-server", "snapshotSettings", ["path": "\(n5SnapshotDir)/mcp-settings.png"])
        _ = try d.invoke("agent", "snapshotSettings", ["path": "\(n5SnapshotDir)/agent-settings.png"])

        // The stdio bridge: `Glide --mcp-stdio --data-dir <userData>` relays to the running server.
        let bridge = Process()
        bridge.executableURL = d.process.executableURL
        bridge.arguments = ["--mcp-stdio", "--data-dir", d.dataDirectory.path]
        let inPipe = Pipe(), outPipe = Pipe()
        bridge.standardInput = inPipe
        bridge.standardOutput = outPipe
        bridge.standardError = FileHandle.nullDevice
        try bridge.run()
        defer { if bridge.isRunning { bridge.terminate() } }
        let lines = [#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bridge"}}}"#,
                     #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, #"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#]
        try inPipe.fileHandleForWriting.write(contentsOf: Data((lines.joined(separator: "\n") + "\n").utf8))
        try inPipe.fileHandleForWriting.close()
        let deadline = Date().addingTimeInterval(10)
        while bridge.isRunning && Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        #expect(!bridge.isRunning)
        let output = String(decoding: outPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").compactMap { MCP.decode(Data($0.utf8)) }
        #expect(output.first { $0["id"] == 1 }?["result"]?["serverInfo"]?["name"] == "glide")
        #expect((output.first { $0["id"] == 2 }?["result"]?["tools"]?.arrayValue?.count ?? 0) > 5)

        // Turning the server off removes the discovery file; the bridge then reports it clearly.
        _ = try d.invoke("mcp-server", "setEnabled", false)
        #expect(MCPServerAuth.readDiscovery(dir) == nil)
        let off = Process()
        off.executableURL = d.process.executableURL
        off.arguments = ["--mcp-stdio", "--data-dir", d.dataDirectory.path]
        let errPipe = Pipe()
        off.standardInput = Pipe()
        off.standardOutput = FileHandle.nullDevice
        off.standardError = errPipe
        try off.run()
        off.waitUntilExit()
        #expect(off.terminationStatus == 1)
        #expect(String(decoding: errPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).contains("not running"))
    }

    @Test func mcpClientSettingsInTheApp() async throws {
        let fixture = try #require(fixtureServerPath())
        let d = try GlideDriver()
        defer { d.stop() }
        let saved = (try d.invoke("agent", "mcpSave", ["name": "fixture", "command": fixture, "env": ["SECRET_TOKEN": "hunter2"]])["result"] as? [String: Any]) ?? [:]
        #expect(saved["ok"] as? Bool == true)
        let server = saved["server"] as? [String: Any]
        #expect((server?["env"] as? [String: Any])?["SECRET_TOKEN"] as? String == MCPServerConfig.secretKeep)
        let raw = try String(contentsOf: d.dataDirectory.appendingPathComponent("features/agent/mcp-servers.json"), encoding: .utf8)
        #expect(!raw.contains("hunter2"))
        let test = (try d.invoke("agent", "mcpTest", ["id": "fixture"])["result"] as? [String: Any]) ?? [:]
        #expect(test["ok"] as? Bool == true)
        let list = (try d.invoke("agent", "mcpList")["result"] as? [[String: Any]]) ?? []
        let pid = try #require(list.first?["pid"] as? Int)
        #expect(processAlive(Int32(pid)))
        let tools = (try d.invoke("agent", "mcpAgentTools")["result"] as? [String: Any])?["tools"] as? [[String: Any]] ?? []
        #expect(tools.contains { $0["name"] as? String == "mcp__fixture__echo" && $0["askFirst"] as? Bool == true })
        d.stop() // quit: the stdio server must not be left behind
        #expect(await waitUntil(5) { !processAlive(Int32(pid)) })
    }
}
