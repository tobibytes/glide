import Foundation
import GlideCore
import Testing
@testable import GlideFeatures

@MainActor @Suite("MCP client: schema, config, stdio fixture server", .serialized)
struct MCPClientTests {
    @Test func toolNames() {
        var taken = Set<String>()
        #expect(MCPSchema.toolName(server: "My Server!", tool: "list notes!", taken: &taken) == "mcp__My_Server__list_notes")
        #expect(MCPSchema.toolName(server: "My Server!", tool: "list notes!", taken: &taken) == "mcp__My_Server__list_notes_2")
        let long = MCPSchema.toolName(server: String(repeating: "s", count: 50), tool: String(repeating: "t", count: 50), taken: &taken)
        #expect(long.count <= 64 && MCPSchema.isToolName(long))
        #expect(!MCPSchema.isToolName("open_app"))
    }

    @Test func inputSchemaMapping() {
        let s = MCPSchema.inputSchema(["$schema": "x", "anyOf": [["properties": ["a": ["type": "string"]]], ["properties": ["b": ["type": "number"]]]],
                                       "allOf": [["properties": ["c": ["type": "string"]], "required": ["c"]]]])
        #expect(s["type"] == "object")
        #expect(s["$schema"] == nil && s["anyOf"] == nil)
        #expect(Set((s["properties"]?.objectValue ?? [:]).keys) == ["a", "b", "c"])
        #expect(s["required"] == ["c"])
        let huge = MCPSchema.inputSchema(["type": "object", "properties": ["x": ["description": .string(String(repeating: "y", count: 40_000))]]])
        #expect(huge["additionalProperties"] == true)
    }

    @Test func resultMapping() {
        #expect(MCPSchema.resultText(["content": [["type": "text", "text": "hi"]]]) == "hi")
        #expect(MCPSchema.resultText(["content": [["type": "image", "mimeType": "image/png", "data": .string(String(repeating: "A", count: 4096))]]]).contains("~3 KB"))
        #expect(MCPSchema.resultText(["content": [], "structuredContent": ["n": 1]]) == #"{"n":1}"#)
        #expect(MCPSchema.resultText(["content": [["type": "text", "text": .string(String(repeating: "x", count: 6000))]]]).contains("[output truncated: 1000 more"))
        #expect(MCPSchema.resultText([:]) == "(the tool returned no content)")
    }

    @Test func configImportAndSecrets() throws {
        let desktop = #"{"mcpServers":{"files":{"command":"npx","args":["-y","@x/server",3],"env":{"TOKEN":"abc"}},"remote":{"type":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer t"}},"bad":{"url":"ftp://x"}}}"#
        guard case let .success(p) = MCPImport.parse(desktop) else { Issue.record("parse"); return }
        #expect(p.format == "mcp-json")
        #expect(p.servers.count == 2 && p.errors.count == 1)
        #expect(p.servers.allSatisfy { !$0.enabled }) // imported servers start off
        let files = try #require(p.servers.first { $0.name == "files" })
        #expect(files.args == ["-y", "@x/server", "3"])
        #expect(files.masked.env?["TOKEN"] == MCPServerConfig.secretKeep)
        #expect(files.masked.restoringSecrets(from: files).env?["TOKEN"] == "abc")
        guard case .failure = MCPImport.parse("{}") else { Issue.record("should fail"); return }
    }

    @Test func storeEncryptsSecrets() throws {
        let dir = n5TempDir()
        let file = dir.appendingPathComponent("mcp-servers.json")
        let store = MCPConfigStore(file: file, cipher: MCPFileKeyCipher(keyFile: dir.appendingPathComponent("key")))
        guard case let .success(c) = MCPServerConfig.normalize(["name": "Remote", "url": "https://x.example/mcp", "headers": ["Authorization": "Bearer SUPERSECRET"]]) else { return }
        let saved = try store.upsert(c, isNew: true)
        #expect(saved.id == "remote")
        let raw = try String(contentsOf: file, encoding: .utf8)
        #expect(!raw.contains("SUPERSECRET"))
        #expect(raw.contains("\"enc\""))
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        #expect((attrs[.posixPermissions] as? Int) == 0o600)
        let fresh = MCPConfigStore(file: file, cipher: MCPFileKeyCipher(keyFile: dir.appendingPathComponent("key")))
        #expect(fresh.get("remote")?.headers?["Authorization"] == "Bearer SUPERSECRET")
        #expect(throws: (any Error).self) { try store.upsert(c, isNew: true) } // same name
        let noCipher = MCPConfigStore(file: dir.appendingPathComponent("other.json"), cipher: MCPNoCipher())
        #expect(throws: (any Error).self) { try noCipher.upsert(c, isNew: true) } // never plain text
    }

    func fixtureConfig(_ extra: [String] = [], name: String = "fix") throws -> MCPServerConfig {
        let path = try #require(fixtureServerPath(), "mcp-fixture-server not built")
        guard case let .success(c) = MCPServerConfig.normalize(["name": .string(name), "command": .string(path), "args": .array(extra.map(JSONValue.string)), "timeoutMs": 1500]) else {
            throw MCPConfigError("bad config")
        }
        return c
    }

    @Test func stdioListCallAndErrors() async throws {
        let c = try fixtureConfig()
        let conn = MCPConnection(config: c, factory: MCPTransportFactories.live)
        try await conn.ensure()
        #expect(conn.state == "ready")
        #expect(conn.serverInfo?.name == "fixture")
        #expect(conn.tools.map(\.name).contains("echo"))
        let pid = try #require(conn.pid)
        let r = try await conn.callTool("echo", arguments: ["text": "hi"])
        #expect(MCPSchema.resultText(r) == "echo: hi")
        let f = try await conn.callTool("fail", arguments: [:])
        #expect(f["isError"] == true)
        await #expect(throws: (any Error).self) { _ = try await conn.callTool("slow", arguments: ["ms": 4000]) } // 1.5 s timeout
        await #expect(throws: (any Error).self) { _ = try await conn.callTool("nope", arguments: [:]) }
        // Still usable after a timeout.
        #expect(MCPSchema.resultText(try await conn.callTool("echo", arguments: ["text": "again"])) == "echo: again")
        await conn.close()
        #expect(await waitUntil(3) { !processAlive(pid) })
        #expect(conn.state == "closed")
    }

    @Test func listChangedRefreshesTools() async throws {
        let conn = MCPConnection(config: try fixtureConfig(["--list-changed"]), factory: MCPTransportFactories.live)
        try await conn.ensure()
        #expect(!conn.tools.contains { $0.name == "extra" })
        _ = try await conn.callTool("echo", arguments: ["text": "x"])
        #expect(await waitUntil(3) { conn.tools.contains { $0.name == "extra" } })
        await conn.close()
    }

    @Test func reconnectAfterCrashWithBackoff() async throws {
        let conn = MCPConnection(config: try fixtureConfig(["--crash-after", "1"]), factory: MCPTransportFactories.live)
        conn.backoffBase = 0.1
        try await conn.ensure()
        _ = try await conn.callTool("echo", arguments: ["text": "x"])
        #expect(await waitUntil(3) { conn.state == "error" })
        #expect(conn.error?.contains("Disconnected") == true)
        #expect(await waitUntil(5) { conn.state == "ready" })
        #expect(conn.attempts == 0)
        await conn.close()
    }

    @Test func unreachableAndBadServers() async throws {
        guard case let .success(missing) = MCPServerConfig.normalize(["name": "missing", "command": "/nonexistent/server-binary"]) else { return }
        let a = MCPConnection(config: missing, factory: MCPTransportFactories.live)
        await #expect(throws: (any Error).self) { try await a.ensure() }
        #expect(a.state == "error")
        let b = MCPConnection(config: try fixtureConfig(["--exit-now", "3", "--stderr", "boom on start"]), factory: MCPTransportFactories.live)
        b.connectTimeout = .seconds(3)
        await #expect(throws: (any Error).self) { try await b.ensure() }
        #expect(b.error?.contains("boom on start") == true)
        let v = MCPConnection(config: try fixtureConfig(["--bad-version"]), factory: MCPTransportFactories.live)
        await #expect(throws: (any Error).self) { try await v.ensure() }
        #expect(v.error?.contains("not supported") == true)
    }

    /// The /bin/sh watchdog stops the server when its parent (Glide) disappears.
    @Test func watchdogKillsOrphans() async throws {
        let parent = Process()
        parent.executableURL = URL(fileURLWithPath: "/bin/sleep")
        parent.arguments = ["30"]
        try parent.run()
        let pidFile = n5TempDir().appendingPathComponent("pid").path
        let t = MCPStdioTransport(command: try #require(fixtureServerPath()), args: ["--pid-file", pidFile])
        t.parentPid = parent.processIdentifier
        let s = MCPClientSession(transport: t)
        try await s.connect()
        let serverPid = try #require(await waitUntil(3) { FileManager.default.fileExists(atPath: pidFile) } ? Int32((try? String(contentsOfFile: pidFile, encoding: .utf8)) ?? "") : nil)
        #expect(processAlive(serverPid))
        kill(parent.processIdentifier, SIGKILL)
        #expect(await waitUntil(5) { !processAlive(serverPid) })
        await s.close()
    }

    @Test func agentToolsFromMCPAnnotations() async throws {
        let dir = n5TempDir()
        let m = MCPManager(store: MCPConfigStore(file: dir.appendingPathComponent("s.json"), cipher: MCPFileKeyCipher(keyFile: dir.appendingPathComponent("k"))))
        var cfg = try fixtureConfig()
        cfg.disabledTools = ["big"]
        _ = await m.save(cfg.json)
        let (tools, problems) = await m.agentTools()
        #expect(problems.isEmpty)
        let echo = try #require(tools.first { $0.name == "mcp__fix__echo" })
        #expect(!echo.mutating && echo.askFirst)
        let add = try #require(tools.first { $0.name == "mcp__fix__add_note" })
        #expect(add.mutating)
        #expect(add.description.contains("may change or delete data"))
        #expect(add.schema["$schema"] == nil)
        #expect(!tools.contains { $0.name == "mcp__fix__big" })
        // Through the agent loop: echo (untrusted read-only) and add_note both ask; one confirmation for the turn.
        let caps = FakeCaps()
        var l = loop(scripted([Turn(toolCalls: [call("mcp__fix__echo", ["text": "a"]), call("mcp__fix__add_note", ["text": "n"])]), Turn(text: "ok")]), caps, tools: tools)
        var asked = 0
        l.confirm = { c, snap in
            asked = c.stepIds.count
            #expect(snap.steps.last?.summary.contains("may change or delete data") == true)
            return true
        }
        let out = await l.run()
        #expect(asked == 2)
        #expect(out.snapshot.steps.map(\.result) == ["echo: a", "noted (1 total)"])
        // Missing required args are refused before calling the server.
        if case .ready = add.prepare([:], caps) { Issue.record("should be invalid") }
        // Trusting the server's read-only hints: echo no longer asks; read-only mode hides add_note.
        cfg.autoRunReadOnly = true
        cfg.disabledTools = []
        _ = await m.save(cfg.json)
        let trusted = await m.agentTools().tools
        #expect(trusted.first { $0.name == "mcp__fix__echo" }?.askFirst == false)
        // Rate limit per server.
        cfg.rateLimitPerMinute = 1
        _ = await m.save(cfg.json)
        let limited = await m.agentTools().tools
        let e = try #require(limited.first { $0.name == "mcp__fix__echo" })
        guard case let .ready(p1) = e.prepare(["text": "1"], caps), case let .ready(p2) = e.prepare(["text": "2"], caps) else { return }
        _ = try? await p1.run() // may already be limited by the calls above
        await #expect(throws: AgentToolFailure.self) { _ = try await p2.run() }
        // Test connection on a draft, then disable closes the connection and stops the process.
        let test = await m.test(cfg.json)
        #expect(test["ok"] == true)
        let pid = try #require(m.connection(cfg.id)?.pid)
        _ = await m.setEnabled(cfg.id, false)
        #expect(await waitUntil(3) { !processAlive(pid) })
        #expect(m.list().first?["state"] != "ready")
        #expect(await m.remove(cfg.id))
    }

    @Test func importThroughManager() async {
        let dir = n5TempDir()
        let m = MCPManager(store: MCPConfigStore(file: dir.appendingPathComponent("s.json"), cipher: MCPFileKeyCipher(keyFile: dir.appendingPathComponent("k"))))
        let text = #"{"mcpServers":{"a":{"command":"/bin/echo"},"b":{"command":"/bin/cat","env":{"K":"v"}}}}"#
        let preview = m.importConfig(text, apply: false)
        #expect(preview["servers"]?.arrayValue?.count == 2)
        #expect(m.store.list().isEmpty)
        let applied = m.importConfig(text, apply: true)
        #expect(applied["imported"] == 2)
        #expect(m.importConfig(text, apply: true)["imported"] == 0) // existing names skipped
        #expect(m.list().allSatisfy { $0["enabled"] == false })
        #expect(m.list().first { $0["name"] == "b" }?["env"]?["K"] == .string(MCPServerConfig.secretKeep))
    }
}
