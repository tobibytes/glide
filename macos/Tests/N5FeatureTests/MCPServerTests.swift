import Foundation
import GlideCore
import Testing
@testable import GlideFeatures

@MainActor final class FakeServerBackend: MCPServerBackend {
    var ran: [String] = []
    var unavailable: Set<String> = []
    func available(_ t: MCPServerToolDef) -> Bool { !unavailable.contains(t.name) }
    func prepare(_ t: MCPServerToolDef, _ args: [String: JSONValue]) -> Result<MCPServerPrepared, MCPConfigError> {
        if args["bad"] != nil { return .failure(MCPConfigError("bad input")) }
        let name = t.name
        return .success(MCPServerPrepared(describe: { "Do \(name) \(AgentText.json(.object(args)))" }, run: {
            self.ran.append(name)
            if args["boom"] != nil { throw AgentToolFailure("boom") }
            return "ran \(name)"
        }))
    }
    func notes() async -> [JSONValue] { [["id": "n1", "title": "Groceries"]] }
    func note(_ id: String) async -> String? { id == "n1" ? "# Groceries\nmilk" : nil }
    func clipboardRecent(_ limit: Int) async -> [JSONValue] { [["title": "copied"]] }
}

@MainActor final class ServerRig {
    var settings = MCPServerSettings()
    let backend = FakeServerBackend()
    let confirmations = MCPConfirmations()
    let log = MCPRequestLog(file: nil)
    var answer: String? = "allow"
    lazy var handler = MCPCallHandler(tools: MCPServerTools.all(), settings: { [unowned self] in self.settings }, backend: backend, confirmations: confirmations,
                                      limiter: MCPKeyedRateLimiter(), log: log, grantAlways: { [unowned self] c, t in self.settings.always[c, default: []].append(t) })
    init() {
        confirmations.onRequest = { [unowned self] r in
            guard let a = self.answer else { return }
            Task { @MainActor in self.confirmations.respond(r.id, a) }
        }
    }
    func text(_ r: JSONValue) -> String { r["content"]?.arrayValue?.first?["text"]?.stringValue ?? "" }
}

@MainActor @Suite("MCP server: policy, pipeline, protocol, HTTP, bridge", .serialized)
struct MCPServerTests {
    @Test func catalogueHas23ToolsWithAnnotations() {
        let tools = MCPServerTools.all()
        #expect(tools.count == 24) // + delete_reminder (fix round)
        #expect(Set(tools.map(\.name)).count == 24)
        let run = tools.first { $0.name == "run_command" }
        #expect(run?.listEntry["annotations"]?["destructiveHint"] == true)
        #expect(tools.first { $0.name == "search_glide" }?.listEntry["annotations"]?["readOnlyHint"] == true)
        #expect(tools.first { $0.name == "create_note" }?.defaults["open"] == false)
        #expect(tools.filter { $0.agentTool != nil }.allSatisfy { $0.inputSchema["type"] == "object" })
    }

    @Test func policyDefaultsAndGates() {
        let tools = MCPServerTools.all()
        func t(_ n: String) -> MCPServerToolDef { tools.first { $0.name == n }! }
        var s = MCPServerSettings()
        #expect(MCPPolicy.policy(t("search_glide"), s) == .allow)
        #expect(MCPPolicy.policy(t("clipboard_history_search"), s) == .off) // sensitive
        #expect(MCPPolicy.policy(t("run_command"), s) == .off)
        s.tools["run_command"] = "allow" // state-changing tools can never be plain allow
        #expect(MCPPolicy.policy(t("run_command"), s) == .ask)
        #expect(MCPPolicy.gate(t("run_command"), s, client: "c") == .confirm)
        s.always["c"] = ["run_command"]
        #expect(MCPPolicy.gate(t("run_command"), s, client: "c") == .run)
        #expect(MCPPolicy.gate(t("run_command"), s, client: "other") == .confirm)
        let patch = MCPPolicy.cleanPatch(["port": 80, "tools": ["run_command": "ask", "bogus": "allow", "list_timers": "weird"], "always": ["c": ["run_command", "nope"]],
                                          "confirmTimeoutSec": 2, "enabled": true], knownTools: Set(tools.map(\.name)))
        #expect(patch["port"] == nil && patch["confirmTimeoutSec"] == nil)
        #expect(patch["tools"] == ["run_command": "ask"])
        #expect(patch["always"] == ["c": ["run_command"]])
        #expect(patch["enabled"] == true)
    }

    @Test func callPipeline() async {
        let rig = ServerRig()
        let h = rig.handler
        // off → hidden and refused
        #expect(!h.visibleTools(client: "c").contains { $0.name == "run_command" })
        var r = await h.call(client: "c", name: "run_command", args: ["id": "x"])
        #expect(r["isError"] == true && rig.text(r).contains("turned off"))
        // allow → runs without asking
        r = await h.call(client: "c", name: "search_glide", args: ["query": "x"])
        #expect(rig.text(r) == "ran search_glide")
        // ask → confirmation
        rig.settings.tools["run_command"] = "ask"
        r = await h.call(client: "c", name: "run_command", args: ["id": "x"])
        #expect(rig.text(r) == "ran run_command")
        rig.answer = "deny"
        r = await h.call(client: "c", name: "run_command", args: ["id": "x"])
        #expect(rig.text(r) == "The user denied this request in Glide.")
        rig.answer = "always"
        _ = await h.call(client: "c", name: "run_command", args: ["id": "x"])
        #expect(rig.settings.always["c"] == ["run_command"])
        rig.answer = nil // nobody answers now — must not be needed
        r = await h.call(client: "c", name: "run_command", args: ["id": "y"])
        #expect(rig.text(r) == "ran run_command")
        // timeout
        rig.confirmations.timeoutMs = { 1000 }
        r = await h.call(client: "other", name: "run_command", args: ["id": "z"])
        #expect(rig.text(r).contains("timed out"))
        // defaults merged, invalid input, run error, unknown tool
        r = await h.call(client: "c", name: "search_glide", args: ["bad": true])
        #expect(rig.text(r) == "bad input")
        r = await h.call(client: "c", name: "search_glide", args: ["boom": true])
        #expect(rig.text(r) == "boom" && r["isError"] == true)
        r = await h.call(client: "c", name: "nope", args: [:])
        #expect(rig.text(r) == "Unknown tool nope")
        // request log: newest first, outcomes, private summaries
        let outcomes = rig.log.list.map(\.outcome)
        #expect(outcomes.contains("denied") && outcomes.contains("timeout") && outcomes.contains("off") && outcomes.contains("invalid") && outcomes.contains("error"))
        #expect(rig.log.list.contains { $0.approval == "always" })
        rig.settings.tools["transform_text"] = "allow"
        _ = await h.call(client: "c", name: "transform_text", args: ["transform": "upper", "text": "very private"])
        #expect(rig.log.list.first?.summary == "Transform Text")
    }

    @Test func rateLimitsAndPendingCap() async {
        let rig = ServerRig()
        rig.settings.rateLimitPerMin = 2
        _ = await rig.handler.call(client: "c", name: "search_glide", args: [:])
        _ = await rig.handler.call(client: "c", name: "search_glide", args: [:])
        let r = await rig.handler.call(client: "c", name: "search_glide", args: [:])
        #expect(rig.text(r).contains("rate limit"))
        #expect(rig.log.list.first?.outcome == "rate-limited")
        let c = MCPConfirmations()
        c.maxPending = 1
        let first = Task { @MainActor in await c.request(client: "a", tool: "t", toolTitle: "T", summary: "s") }
        _ = await waitUntil { c.pending.count == 1 }
        #expect(await c.request(client: "a", tool: "t", toolTitle: "T", summary: "s") == .deny)
        c.denyAll()
        #expect(await first.value == .deny)
    }

    @Test func protocolSessionAndResources() async {
        let rig = ServerRig()
        let s = MCPServerSession(handler: rig.handler, version: "1.0.0")
        let init0 = await s.handle(MCP.request(id: 1, method: "initialize", params: ["protocolVersion": "2025-03-26", "clientInfo": ["name": "Claude Code\u{7}"], "capabilities": [:]]))
        #expect(init0?["result"]?["protocolVersion"] == "2025-03-26")
        #expect(init0?["result"]?["serverInfo"]?["name"] == "glide")
        #expect(s.clientName == "Claude Code")
        #expect(await s.handle(MCP.notification("notifications/initialized")) == nil)
        let list = await s.handle(MCP.request(id: 2, method: "tools/list"))
        let names = list?["result"]?["tools"]?.arrayValue?.compactMap { $0["name"]?.stringValue } ?? []
        #expect(names.contains("search_glide") && !names.contains("run_command"))
        let call = await s.handle(MCP.request(id: 3, method: "tools/call", params: ["name": "convert", "arguments": ["query": "1+1"]]))
        #expect(call?["result"]?["content"]?.arrayValue?.first?["text"] == "ran convert")
        #expect(await s.handle(MCP.request(id: "x", method: "nope"))?["error"]?["code"] == .int(Int64(MCP.methodNotFound)))
        let res = await s.handle(MCP.request(id: 4, method: "resources/list"))
        #expect(res?["result"]?["resources"]?.arrayValue?.first?["uri"] == "glide://notes/n1")
        let read = await s.handle(MCP.request(id: 5, method: "resources/read", params: ["uri": "glide://notes/n1"]))
        #expect(read?["result"]?["contents"]?.arrayValue?.first?["text"]?.stringValue?.contains("milk") == true)
        let clip = await s.handle(MCP.request(id: 6, method: "resources/read", params: ["uri": "glide://clipboard/recent"]))
        #expect(clip?["error"] != nil) // clipboard tool is off by default
        #expect(await s.handle(MCP.request(id: 7, method: "ping"))?["result"] == [:])
    }

    @Test func protocolErrorsAndCancellation() async throws {
        let rig = ServerRig()
        rig.answer = nil // leave confirmations pending
        rig.settings.tools["start_timer"] = "ask"
        let s = MCPServerSession(handler: rig.handler, version: "1.0.0")
        let init0 = await s.handle(MCP.request(id: 1, method: "initialize", params: ["protocolVersion": "2025-11-25", "clientInfo": ["name": "c"], "capabilities": [:]]))
        #expect(init0?["result"]?["protocolVersion"] == "2025-11-25")
        // Unknown tool: JSON-RPC -32602 (not an isError result); unknown resource: -32002.
        #expect(await s.handle(MCP.request(id: 2, method: "tools/call", params: ["name": "nope", "arguments": [:]]))?["error"]?["code"] == .int(Int64(MCP.invalidParams)))
        let missing = await s.handle(MCP.request(id: 3, method: "resources/read", params: ["uri": "glide://notes/zzz"]))
        #expect(missing?["error"]?["code"] == .int(Int64(MCP.resourceNotFound)))
        #expect(missing?["error"]?["data"]?["uri"] == "glide://notes/zzz")
        // notifications/cancelled withdraws the pending confirmation and the call answers "cancelled".
        let call = Task { @MainActor in await s.handle(MCP.request(id: 9, method: "tools/call", params: ["name": "start_timer", "arguments": ["minutes": 1]])) }
        #expect(await waitUntil(3) { rig.confirmations.pending.count == 1 })
        _ = await s.handle(MCP.notification("notifications/cancelled", params: ["requestId": 9, "reason": "user"]))
        let r = await call.value
        #expect(rig.confirmations.pending.isEmpty)
        #expect(r?["result"]?["isError"] == true)
        #expect(rig.log.list.first?.outcome == "cancelled")
        #expect(!rig.backend.ran.contains("start_timer"))
        // The user can't answer a cancelled prompt with "cancelled"/"timeout" from the UI.
        #expect(!rig.confirmations.respond("x", "cancelled"))
    }

    @Test func authTokenAndHostChecks() throws {
        let dir = n5TempDir()
        let t = try MCPServerAuth.loadOrCreateToken(dir)
        #expect(t.count >= 43 && MCPServerAuth.valid(t))
        #expect(try MCPServerAuth.loadOrCreateToken(dir) == t)
        let attrs = try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent("token").path)
        #expect((attrs[.posixPermissions] as? Int) == 0o600)
        #expect(MCPServerAuth.authorized("Bearer \(t)", token: t))
        #expect(MCPServerAuth.authorized("bearer   \(t)", token: t))
        #expect(!MCPServerAuth.authorized("Bearer \(t)x", token: t))
        #expect(!MCPServerAuth.authorized("Basic \(t)", token: t))
        #expect(!MCPServerAuth.authorized(nil, token: t))
        #expect(try MCPServerAuth.regenerateToken(dir) != t)
        #expect(MCPServerAuth.checkHostOrigin(host: "127.0.0.1:5000", origin: nil, port: 5000))
        #expect(MCPServerAuth.checkHostOrigin(host: "localhost:5000", origin: "http://localhost:5000", port: 5000))
        #expect(!MCPServerAuth.checkHostOrigin(host: "evil.com:5000", origin: nil, port: 5000))
        #expect(!MCPServerAuth.checkHostOrigin(host: "127.0.0.1:5000", origin: "https://evil.com", port: 5000))
        try MCPServerAuth.writeDiscovery(dir, .init(port: 5000, pid: 42, url: "http://127.0.0.1:5000/mcp", version: "1", startedAt: 1))
        #expect(MCPServerAuth.readDiscovery(dir)?.port == 5000)
        MCPServerAuth.removeDiscovery(dir, pid: 41) // not ours: kept
        #expect(MCPServerAuth.readDiscovery(dir) != nil)
        MCPServerAuth.removeDiscovery(dir, pid: 42)
        #expect(MCPServerAuth.readDiscovery(dir) == nil)
    }

    @Test func httpParser() {
        var p = MCPHTTPParser(maxBody: 100)
        p.buffer = Data("POST /mcp HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\nGET /mcp HTTP/1.1\r\nContent-Length: 0\r\n\r\n".utf8)
        guard case let .request(r1) = p.next() else { Issue.record("r1"); return }
        #expect(String(decoding: r1.body, as: UTF8.self) == "abcde")
        guard case let .request(r2) = p.next() else { Issue.record("r2"); return }
        #expect(r2.method == "GET")
        p.buffer = Data("POST / HTTP/1.1\r\nContent-Length: 500\r\n\r\n".utf8)
        guard case .error(413, _) = p.next() else { Issue.record("413"); return }
    }

    @Test func snippets() {
        let s = MCPServerSnippets.build(command: "/Applications/Glide.app/Contents/MacOS/Glide", args: ["--mcp-stdio"], url: "http://127.0.0.1:1/mcp", token: "TOK")
        #expect(s.map { $0["id"]?.stringValue ?? "" } == ["claude-code", "claude-desktop", "goose", "cursor", "claude-code-http"])
        #expect(s[0]["text"] == "claude mcp add --scope user glide -- /Applications/Glide.app/Contents/MacOS/Glide --mcp-stdio")
        #expect(s[4]["secret"] == true && s[4]["text"]?.stringValue?.contains("'Authorization: Bearer TOK'") == true)
        #expect(s[1]["text"]?.stringValue?.contains("\"mcpServers\"") == true)
    }

    /// The HTTP listener on 127.0.0.1, exercised by raw URLSession requests and by Glide's own MCP client.
    @Test func httpServerEndToEnd() async throws {
        let rig = ServerRig()
        let token = "t0k3n-t0k3n-t0k3n-t0k3n-t0k3n-t0k3n-xx"
        let srv = MCPHTTPServer(token: { token }, makeSession: { MCPServerSession(handler: rig.handler, version: "1.0.0") })
        try await srv.start(preferredPort: 0)
        #expect(srv.port > 0)
        let url = try #require(URL(string: srv.url))
        func raw(_ headers: [String: String], body: String = #"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, method: String = "POST") async throws -> Int {
            var r = URLRequest(url: url)
            r.httpMethod = method
            r.httpBody = Data(body.utf8)
            for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
            let (_, resp) = try await URLSession.shared.data(for: r)
            return (resp as? HTTPURLResponse)?.statusCode ?? 0
        }
        #expect(try await raw([:]) == 401)
        #expect(try await raw(["Authorization": "Bearer nope"]) == 401)
        #expect(try await raw(["Authorization": "Bearer \(token)", "Origin": "https://evil.example"]) == 403)
        #expect(try await raw(["Authorization": "Bearer \(token)"]) == 400) // first request must be initialize
        #expect(try await raw(["Authorization": "Bearer \(token)", "Mcp-Session-Id": "unknown"]) == 404)

        let transport = MCPHTTPClientTransport(url: url, headers: ["Authorization": "Bearer \(token)"])
        let client = MCPClientSession(transport: transport, clientName: "TestClient")
        var notes: [String] = []
        client.onNotification = { m, _ in notes.append(m) }
        try await client.connect()
        #expect(client.serverInfo?.name == "glide")
        #expect(transport.sessionId != nil)
        #expect(srv.sessionCount == 1)
        let tools = try await client.listTools()
        #expect(tools.contains { $0.name == "search_glide" && $0.readOnlyHint == true })
        let r = try await client.callTool("search_glide", arguments: ["query": "x"], timeout: .seconds(5))
        #expect(r["content"]?.arrayValue?.first?["text"] == "ran search_glide")
        #expect(rig.log.list.first?.client == "TestClient")
        // Server → client notification over the GET event stream.
        try? await Task.sleep(for: .milliseconds(300))
        srv.notifyListChanged()
        #expect(await waitUntil(3) { notes.contains("notifications/tools/list_changed") })
        await client.close()
        #expect(await waitUntil(2) { srv.sessionCount == 0 })
        await srv.close()
    }

    @Test func busyPortFallsBackToFreePort() async throws {
        let rig = ServerRig()
        let a = MCPHTTPServer(token: { "x" }, makeSession: { MCPServerSession(handler: rig.handler, version: "1") })
        try await a.start(preferredPort: 0)
        let b = MCPHTTPServer(token: { "x" }, makeSession: { MCPServerSession(handler: rig.handler, version: "1") })
        try await b.start(preferredPort: a.port)
        #expect(b.port != a.port && b.port > 0)
        await a.close()
        await b.close()
    }

    @Test func bridgeRelaysLinesAndReportsDeadServer() async throws {
        let rig = ServerRig()
        let token = "bridge-token-bridge-token-bridge-token"
        let srv = MCPHTTPServer(token: { token }, makeSession: { MCPServerSession(handler: rig.handler, version: "1.0.0") })
        try await srv.start(preferredPort: 0)
        let relay = MCPBridgeRelay(remote: MCPHTTPClientTransport(url: try #require(URL(string: srv.url)), headers: ["Authorization": "Bearer \(token)"]))
        var out: [JSONValue] = []
        var exitCode: Int32?
        relay.write = { out.append($0) }
        relay.exitProcess = { exitCode = $0 }
        relay.start()
        FileHandle.standardInput.readabilityHandler = nil // the test feeds input directly
        relay.input(Data(#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bridge-test"}}}"#.utf8 + [0x0A]))
        relay.input(Data((#"{"jsonrpc":"2.0","method":"notifications/initialized"}"# + "\n" + #"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"# + "\nnot json\n").utf8))
        #expect(await waitUntil(5) { out.contains { $0["id"] == 2 } })
        #expect(out.contains { $0["error"]?["code"] == .int(Int64(MCP.parseError)) })
        #expect(out.first { $0["id"] == 1 }?["result"]?["serverInfo"]?["name"] == "glide")
        relay.input(Data())
        #expect(await waitUntil(3) { exitCode == 0 })
        await srv.close()

        let dead = MCPBridgeRelay(remote: MCPHTTPClientTransport(url: try #require(URL(string: "http://127.0.0.1:9/mcp")), headers: [:]))
        var deadOut: [JSONValue] = []
        dead.write = { deadOut.append($0) }
        dead.exitProcess = { _ in }
        dead.start()
        FileHandle.standardInput.readabilityHandler = nil
        dead.input(Data(#"{"jsonrpc":"2.0","id":9,"method":"initialize","params":{}}"#.utf8 + [0x0A]))
        #expect(await waitUntil(5) { !deadOut.isEmpty })
        #expect(deadOut.first?["error"]?["message"]?.stringValue?.contains("not running") == true)
    }
}
