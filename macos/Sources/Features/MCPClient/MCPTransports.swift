import Darwin
import Foundation
import GlideCore

/// A client-side MCP transport: delivers JSON-RPC messages both ways. Everything is main-actor bound;
/// I/O happens on background queues and hops back in order.
@MainActor protocol MCPClientTransport: AnyObject {
    var onMessage: ((JSONValue) -> Void)? { get set }
    /// The transport closed (nil = graceful).
    var onClose: ((String?) -> Void)? { get set }
    func start() async throws
    func send(_ message: JSONValue) async throws
    func close() async
    /// Stdio only: the watchdog's pid.
    var pid: Int32? { get }
    /// Stdio only: recent stderr output, for error messages.
    var stderrTail: String { get }
    func setProtocolVersion(_ v: String)
}

extension MCPClientTransport {
    var pid: Int32? { nil }
    var stderrTail: String { "" }
    func setProtocolVersion(_ v: String) {}
}

// MARK: - stdio

/// Runs a stdio MCP server under a /bin/sh watchdog that kills the server when Glide disappears (crash, force
/// quit), so no server is ever orphaned. Closing sends EOF, then SIGTERM to the watchdog (forwarded), then SIGKILL.
@MainActor final class MCPStdioTransport: MCPClientTransport {
    /// mcp-transport.ts WATCHDOG_SCRIPT: runs "$@" with stdin/stdout inherited, polls the parent, forwards signals.
    nonisolated static let watchdogScript = [
        "glide=\"$1\"; shift",
        "\"$@\" <&0 &",
        "child=$!",
        "stop() { kill -TERM \"$child\" 2>/dev/null; sleep 1; kill -KILL \"$child\" 2>/dev/null; exit 143; }",
        "trap stop TERM INT HUP",
        "while kill -0 \"$child\" 2>/dev/null; do",
        "  if ! kill -0 \"$glide\" 2>/dev/null; then stop; fi",
        "  sleep 0.5",
        "done",
        "wait \"$child\"",
    ].joined(separator: "\n")

    /// GUI apps get a minimal PATH; add the usual places npx/uvx/node live.
    nonisolated static func serverPath(_ base: String = ProcessInfo.processInfo.environment["PATH"] ?? "") -> String {
        let home = NSHomeDirectory()
        var parts = base.split(separator: ":").map(String.init).filter { !$0.isEmpty }
        for p in ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.bun/bin", "\(home)/.cargo/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            where !parts.contains(p) { parts.append(p) }
        return parts.joined(separator: ":")
    }

    let command: String
    let args: [String]
    let env: [String: String]
    let cwd: String?
    let watchdog: Bool
    /// The process the watchdog follows (Glide; tests pass a stand-in).
    var parentPid: Int32 = getpid()
    var onMessage: ((JSONValue) -> Void)?
    var onClose: ((String?) -> Void)?
    private var process: Process?
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()
    private let writeQueue = DispatchQueue(label: "dev.glide.mcp.stdio.write")
    private var lines = MCPLineBuffer()
    private var tail = ""
    private var closed = false

    init(command: String, args: [String], env: [String: String] = [:], cwd: String? = nil, watchdog: Bool = true) {
        self.command = command
        self.args = args
        self.env = env
        self.cwd = cwd
        self.watchdog = watchdog
    }

    var pid: Int32? { process?.isRunning == true ? process?.processIdentifier : nil }
    var stderrTail: String { tail.trimmingCharacters(in: .whitespacesAndNewlines) }

    func start() async throws {
        let p = Process()
        if watchdog {
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = ["-c", Self.watchdogScript, "glide-mcp-watchdog", String(parentPid), command] + args
        } else {
            p.executableURL = URL(fileURLWithPath: command)
            p.arguments = args
        }
        // Like the SDK's getDefaultEnvironment(): a safe subset of Glide's env, plus the server's own.
        let parent = ProcessInfo.processInfo.environment
        var e: [String: String] = [:]
        for k in ["HOME", "LOGNAME", "SHELL", "TERM", "USER", "TMPDIR", "LANG"] { if let v = parent[k] { e[k] = v } }
        e["PATH"] = Self.serverPath()
        for (k, v) in env { e[k] = v }
        p.environment = e
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: (cwd as NSString).expandingTildeInPath) }
        p.standardInput = stdinPipe
        p.standardOutput = stdoutPipe
        p.standardError = stderrPipe
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.received(d) } }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.stderrData(d) } }
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.exited(status) } }
        }
        do { try p.run() } catch { throw MCPError(code: MCP.connectionClosed, message: "\(command) wasn't found or couldn't start: \(error.localizedDescription)") }
        process = p
    }

    private func received(_ d: Data) {
        if d.isEmpty {
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            return
        }
        for line in lines.feed(d) {
            if let m = MCP.decode(line) { onMessage?(m) } else { tail = String((tail + "\n[invalid JSON on stdout]").suffix(2000)) }
        }
    }

    private func stderrData(_ d: Data) { tail = String((tail + String(decoding: d, as: UTF8.self)).suffix(2000)) }

    private func exited(_ status: Int32) {
        guard !closed else { return }
        closed = true
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        onClose?(status == 0 ? nil : "exited with status \(status)")
    }

    func send(_ message: JSONValue) async throws {
        guard let p = process, p.isRunning, !closed else { throw MCPError.closed("The server process is not running") }
        var data = MCP.encode(message)
        data.append(0x0A)
        let handle = stdinPipe.fileHandleForWriting
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            writeQueue.async {
                do { try handle.write(contentsOf: data); c.resume() } catch { c.resume(throwing: MCPError.closed("Couldn't write to the server: \(error.localizedDescription)")) }
            }
        }
    }

    func close() async {
        let wasClosed = closed
        closed = true
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        guard let p = process else { return }
        try? stdinPipe.fileHandleForWriting.close()
        if p.isRunning {
            let pid = p.processIdentifier
            kill(pid, SIGTERM)
            for _ in 0..<40 where p.isRunning { try? await Task.sleep(for: .milliseconds(50)) }
            if p.isRunning { kill(pid, SIGKILL) }
        }
        process = nil
        if !wasClosed { onClose?(nil) }
    }

    /// Synchronous kill (app quit). The watchdog forwards SIGTERM to the server.
    func killNow() {
        closed = true
        if let p = process, p.isRunning { kill(p.processIdentifier, SIGTERM) }
    }
}

// MARK: - Streamable HTTP

/// MCP Streamable HTTP client transport: POST each message (JSON or SSE response), Mcp-Session-Id,
/// MCP-Protocol-Version, an optional GET SSE stream for server notifications, DELETE on close.
@MainActor final class MCPHTTPClientTransport: MCPClientTransport {
    let url: URL
    let headers: [String: String]
    var onMessage: ((JSONValue) -> Void)?
    var onClose: ((String?) -> Void)?
    private(set) var sessionId: String?
    private var protocolVersion: String?
    private let session: URLSession
    private var getTask: Task<Void, Never>?
    private var inflight: [UUID: Task<Void, Never>] = [:]
    private var closed = false
    /// Open the GET notification stream once initialized (servers may answer 405).
    var listenForNotifications = true

    init(url: URL, headers: [String: String] = [:]) {
        self.url = url
        self.headers = headers
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 600
        cfg.timeoutIntervalForResource = 24 * 3600
        cfg.httpShouldSetCookies = false
        cfg.urlCache = nil
        session = URLSession(configuration: cfg)
    }

    func start() async throws {}

    func setProtocolVersion(_ v: String) { protocolVersion = v }

    private func request(method: String, accept: String) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        r.setValue(accept, forHTTPHeaderField: "Accept")
        if let sessionId { r.setValue(sessionId, forHTTPHeaderField: "Mcp-Session-Id") }
        if let protocolVersion { r.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version") }
        return r
    }

    func send(_ message: JSONValue) async throws {
        guard !closed else { throw MCPError.closed() }
        var r = request(method: "POST", accept: "application/json, text/event-stream")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = MCP.encode(message)
        let isInitialize = message["method"]?.stringValue == "initialize"
        let (bytes, response) = try await session.bytes(for: r)
        guard let http = response as? HTTPURLResponse else { throw MCPError(code: MCP.internalError, message: "No HTTP response") }
        if let sid = http.value(forHTTPHeaderField: "Mcp-Session-Id"), !sid.isEmpty { sessionId = sid }
        let openStream = listenForNotifications && getTask == nil && message["method"]?.stringValue == "notifications/initialized"
        switch http.statusCode {
        case 202:
            if openStream, sessionId != nil { openNotificationStream() }
            return
        case 200..<300: break
        case 401: throw MCPError(code: 401, message: "401 Unauthorized")
        case 404 where sessionId != nil && !isInitialize:
            sessionId = nil
            onClose?("The server ended the session (404)")
            throw MCPError.closed("Session expired")
        default:
            var body = Data()
            for try await b in bytes { body.append(b); if body.count > 4000 { break } }
            let msg = MCP.decode(body)?["error"]?["message"]?.stringValue ?? String(decoding: body.prefix(300), as: UTF8.self)
            throw MCPError(code: http.statusCode, message: "HTTP \(http.statusCode)\(msg.isEmpty ? "" : ": \(msg)")")
        }
        let type = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        if type.contains("text/event-stream") {
            // Read the stream in the background; responses arrive as events (the caller waits on its id).
            let id = UUID()
            inflight[id] = Task { @MainActor [weak self] in
                await self?.consumeSSE(bytes)
                self?.inflight[id] = nil
            }
        } else {
            var body = Data()
            for try await b in bytes { body.append(b) }
            guard !body.isEmpty else { return }
            guard let v = MCP.decode(body) else { throw MCPError(code: MCP.parseError, message: "The server sent invalid JSON") }
            if case let .array(list) = v { list.forEach { onMessage?($0) } } else { onMessage?(v) }
        }
        if openStream, sessionId != nil { openNotificationStream() }
    }

    private func consumeSSE(_ bytes: URLSession.AsyncBytes) async {
        var parser = MCPSSEParser()
        var chunk = Data()
        do {
            for try await b in bytes {
                chunk.append(b)
                if b == 0x0A {
                    for ev in parser.feed(chunk) where ev.event == "message" {
                        if let m = MCP.decode(Data(ev.data.utf8)) { onMessage?(m) }
                    }
                    chunk.removeAll(keepingCapacity: true)
                }
            }
            _ = parser.feed(chunk + Data("\n\n".utf8)).map { ev in if let m = MCP.decode(Data(ev.data.utf8)) { onMessage?(m) } }
        } catch {}
    }

    private func openNotificationStream() {
        getTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let r = self.request(method: "GET", accept: "text/event-stream")
            guard let (bytes, response) = try? await self.session.bytes(for: r), let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            await self.consumeSSE(bytes)
        }
    }

    func close() async {
        guard !closed else { return }
        closed = true
        getTask?.cancel()
        for t in inflight.values { t.cancel() }
        if sessionId != nil {
            var r = request(method: "DELETE", accept: "application/json")
            r.timeoutInterval = 2
            _ = try? await session.data(for: r)
        }
        session.invalidateAndCancel()
        onClose?(nil)
    }
}

// MARK: - in-memory (tests and the in-process bridge)

@MainActor final class MCPInMemoryTransport: MCPClientTransport {
    var onMessage: ((JSONValue) -> Void)?
    var onClose: ((String?) -> Void)?
    /// Receives everything the client sends; reply through `deliver`.
    var handler: ((JSONValue) async -> JSONValue?)?
    private(set) var closed = false
    init(handler: ((JSONValue) async -> JSONValue?)? = nil) { self.handler = handler }
    func start() async throws {}
    func send(_ message: JSONValue) async throws {
        guard !closed else { throw MCPError.closed() }
        let h = handler
        Task { @MainActor [weak self] in
            if let reply = await h?(message) { self?.deliver(reply) }
        }
    }
    func deliver(_ m: JSONValue) { if !closed { onMessage?(m) } }
    func close() async {
        guard !closed else { return }
        closed = true
        onClose?(nil)
    }
    /// Simulates the server dropping the connection.
    func drop(_ reason: String) {
        guard !closed else { return }
        closed = true
        onClose?(reason)
    }
}
