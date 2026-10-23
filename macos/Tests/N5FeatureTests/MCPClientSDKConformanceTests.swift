import Foundation
import GlideCore
import Testing
@testable import GlideFeatures

/// Glide's MCP client (MCPConnection / transports) against REAL servers built with the official MCP TypeScript SDK
/// (Tests/Conformance/sdk-test-server.mjs, run with the local node and ../node_modules/@modelcontextprotocol/sdk).
/// Every transport Glide offers: stdio, Streamable HTTP (SSE responses and JSON responses), legacy HTTP+SSE.
/// Skipped when node or the SDK isn't on disk. Loopback only; every server process is killed by pid.
enum SDKServer {
    static let macosRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let script = macosRoot.appendingPathComponent("Tests/Conformance/sdk-test-server.mjs").path
    static let sdk = macosRoot.deletingLastPathComponent().appendingPathComponent("node_modules/@modelcontextprotocol/sdk/package.json").path

    static var node: String? {
        let env = ProcessInfo.processInfo.environment
        for p in [env["NODE_BINARY"], "/opt/homebrew/bin/node", "/usr/local/bin/node"].compactMap({ $0 }) where FileManager.default.isExecutableFile(atPath: p) { return p }
        return nil
    }

    static var available: Bool { node != nil && FileManager.default.fileExists(atPath: sdk) && FileManager.default.fileExists(atPath: script) }

    /// A running HTTP / SSE server: its URL and the process (killed in `stop`).
    final class Running: @unchecked Sendable {
        let process: Process
        let url: String
        init(process: Process, url: String) { self.process = process; self.url = url }
        var pid: Int32 { process.processIdentifier }
        func stop() {
            guard process.isRunning else { return }
            process.terminate()
            for _ in 0..<40 where process.isRunning { usleep(25_000) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
    }

    /// Starts `node sdk-test-server.mjs <mode…>` and reads the `{"port","url"}` line it prints.
    static func start(_ args: [String]) throws -> Running {
        guard let node else { throw MCPConfigError("node not found") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script] + args
        let out = Pipe(), input = Pipe()
        p.standardOutput = out
        p.standardInput = input // closing it (we never write) ends the server if we die
        p.standardError = FileHandle.standardError
        try p.run()
        var buf = Data()
        let end = Date().addingTimeInterval(15)
        while Date() < end, !buf.contains(0x0A) {
            let d = out.fileHandleForReading.availableData
            if d.isEmpty { break }
            buf.append(d)
        }
        guard let line = buf.split(separator: 0x0A).first, let v = MCP.decode(Data(line)), let url = v["url"]?.stringValue else {
            p.terminate()
            throw MCPConfigError("sdk-test-server did not start: \(String(decoding: buf, as: UTF8.self))")
        }
        _ = input // keep the pipe open for the server's lifetime
        return Running(process: p, url: url)
    }

    static func config(_ raw: JSONValue) throws -> MCPServerConfig {
        switch MCPServerConfig.normalize(raw) {
        case let .success(c): return c
        case let .failure(e): throw e
        }
    }
}

@MainActor @Suite("MCP client ⇄ official TypeScript SDK servers", .serialized, .enabled(if: SDKServer.available))
struct MCPClientSDKConformanceTests {
    func text(_ r: JSONValue) -> String { MCPSchema.resultText(r) }

    func stats(_ c: MCPConnection) async throws -> JSONValue {
        MCP.decode(Data(text(try await c.callTool("stats", arguments: [:])).utf8)) ?? [:]
    }

    /// The checks every transport must pass.
    func common(_ c: MCPConnection, label: String) async throws {
        try await c.ensure()
        #expect(c.state == "ready", "\(label)")
        #expect(c.serverInfo?.name == "sdk-test-server")
        // Paginated tools/list (3 per page → 4 pages).
        #expect(c.tools.count == 10, "\(label): \(c.tools.map(\.name))")
        let echo = try #require(c.tools.first { $0.name == "echo" })
        #expect(echo.readOnlyHint == true && echo.title == "Echo")
        #expect(text(try await c.callTool("echo", arguments: ["text": "héllo ✓"])) == "héllo ✓")
        let sum = try await c.callTool("add", arguments: ["a": 2, "b": 3.5])
        #expect(text(sum) == "5.5" && sum["structuredContent"]?["sum"] == .double(5.5))
        let failed = try await c.callTool("fail", arguments: [:])
        #expect(failed["isError"] == true && text(failed) == "it failed on purpose")
        // JSON-RPC errors surface as MCPError with the server's code.
        do {
            _ = try await c.callTool("throw", arguments: [:])
            Issue.record("\(label): throw should fail")
        } catch let e as MCPError {
            #expect(e.code == MCP.invalidParams && e.message.contains("bad params on purpose"), "\(label): \(e)")
        }
        do {
            _ = try await c.callTool("nope", arguments: [:])
            Issue.record("\(label): unknown tool should fail")
        } catch let e as MCPError { #expect(e.code == MCP.invalidParams) }
        // Server → client request (ping) in the middle of a call.
        #expect(text(try await c.callTool("ping_client", arguments: [:])).hasPrefix("client answered"), "\(label)")
        // Per-call timeout → error, notifications/cancelled reaches the server (it aborts the handler), and the
        // connection keeps working.
        let before = try await stats(c)["cancelled"]?.intValue ?? 0
        do {
            _ = try await c.callTool("slow", arguments: ["ms": 8000])
            Issue.record("\(label): slow should time out")
        } catch { #expect(error.localizedDescription.contains("timed out"), "\(label): \(error)") }
        var cancelled = 0
        for _ in 0..<50 {
            cancelled = try await stats(c)["cancelled"]?.intValue ?? 0
            if cancelled > before { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(cancelled > before, "\(label): server never saw notifications/cancelled")
        #expect(text(try await c.callTool("echo", arguments: ["text": "still alive"])) == "still alive")
        // notifications/tools/list_changed → the cached tool list refreshes.
        _ = try await c.callTool("toggle", arguments: [:])
        #expect(await waitUntil(5) { c.tools.contains { $0.name == "extra" } }, "\(label): list_changed not applied")
        #expect(text(try await c.callTool("extra", arguments: [:])) == "extra ran")
        _ = try await c.callTool("toggle", arguments: [:])
        #expect(await waitUntil(5) { !c.tools.contains { $0.name == "extra" } }, "\(label): second list_changed not applied")
    }

    @Test func stdio() async throws {
        let node = try #require(SDKServer.node)
        let c = MCPConnection(config: try SDKServer.config(["name": "sdk stdio", "command": .string(node), "args": [.string(SDKServer.script), "--stdio"], "timeoutMs": 1200]),
                              factory: MCPTransportFactories.live)
        c.backoffBase = 0.05
        try await common(c, label: "stdio")
        // Crash → unexpected close → automatic reconnect with backoff → a new server process.
        let pid1 = try #require(c.pid)
        _ = try await c.callTool("crash", arguments: [:])
        #expect(await waitUntil(5) { c.state == "error" || (c.state == "ready" && c.pid != pid1) })
        #expect(await waitUntil(8) { c.state == "ready" && c.pid != nil && c.pid != pid1 }, "state \(c.state) \(c.error ?? "")")
        #expect(text(try await c.callTool("echo", arguments: ["text": "reborn"])) == "reborn")
        let pid2 = try #require(c.pid)
        await c.close()
        #expect(await waitUntil(5) { !processAlive(pid1) && !processAlive(pid2) }, "stdio server left running")
    }

    func http(json: Bool) async throws {
        let token = "conformance-\(UUID().uuidString)"
        let srv = try SDKServer.start(["--http", "--token", token] + (json ? ["--json"] : []))
        defer { srv.stop() }
        let label = json ? "http-json" : "http-sse"
        let c = MCPConnection(config: try SDKServer.config(["name": .string(label), "url": .string(srv.url), "headers": ["Authorization": .string("Bearer \(token)")], "timeoutMs": 1200]),
                              factory: MCPTransportFactories.live)
        c.backoffBase = 0.05
        try await common(c, label: label)
        // The server forgets the session → 404 → Glide starts a new session and the call after works.
        _ = try await c.callTool("expire_session", arguments: [:])
        try await Task.sleep(for: .milliseconds(200))
        var recovered = false
        for _ in 0..<40 {
            if let r = try? await c.callTool("echo", arguments: ["text": "new session"]), text(r) == "new session" { recovered = true; break }
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(recovered, "\(label): no recovery after the session expired (\(c.state) \(c.error ?? ""))")
        #expect((try await stats(c)["initialized"]?.intValue ?? 0) >= 2)
        await c.close()
        // Wrong token → a clear 401 message.
        let bad = MCPConnection(config: try SDKServer.config(["name": "bad", "url": .string(srv.url), "headers": ["Authorization": "Bearer wrong"]]), factory: MCPTransportFactories.live)
        do {
            try await bad.ensure()
            Issue.record("connected with a wrong token")
        } catch { #expect(error.localizedDescription.contains("401"), "\(error)") }
        await bad.close()
        srv.stop()
        #expect(!processAlive(srv.pid))
    }

    @Test func streamableHTTPWithSSEResponses() async throws { try await http(json: false) }

    @Test func streamableHTTPWithJSONResponses() async throws { try await http(json: true) }

    @Test func legacySSE() async throws {
        let token = "conformance-\(UUID().uuidString)"
        let srv = try SDKServer.start(["--sse", "--token", token])
        defer { srv.stop() }
        let c = MCPConnection(config: try SDKServer.config(["name": "legacy", "transport": "sse", "url": .string(srv.url), "headers": ["Authorization": .string("Bearer \(token)")], "timeoutMs": 1200]),
                              factory: MCPTransportFactories.live)
        try await common(c, label: "sse")
        await c.close()
        srv.stop()
        #expect(!processAlive(srv.pid))
    }

    @Test func agentToolsFromAnSDKServer() async throws {
        let node = try #require(SDKServer.node)
        let c = MCPConnection(config: try SDKServer.config(["name": "sdk", "command": .string(node), "args": [.string(SDKServer.script), "--stdio"]]), factory: MCPTransportFactories.live)
        try await c.ensure()
        var taken = Set<String>()
        let tools = MCPAgentTools.build(c.config, c.tools, caller: c, limiter: MCPServerRateLimit(), taken: &taken)
        let echo = try #require(tools.first { $0.name == "mcp__sdk__echo" })
        #expect(!echo.mutating)
        #expect(tools.first { $0.name == "mcp__sdk__toggle" }?.mutating == true)
        guard case let .ready(p) = echo.prepare(["text": "via agent"], FakeCaps()) else { Issue.record("prepare"); return }
        #expect(try await p.run().text == "via agent")
        guard case let .ready(f) = try #require(tools.first { $0.name == "mcp__sdk__fail" }).prepare([:], FakeCaps()) else { Issue.record("prepare fail"); return }
        await #expect(throws: AgentToolFailure.self) { try await f.run() }
        let pid = try #require(c.pid)
        await c.close()
        #expect(await waitUntil(5) { !processAlive(pid) })
    }
}
