import Foundation
import GlideCore

typealias MCPTransportFactory = @MainActor (MCPServerConfig) throws -> any MCPClientTransport

enum MCPTransportFactories {
    /// Real transports: stdio under the watchdog, Streamable HTTP (legacy SSE servers are reached the same way;
    /// most of them also answer Streamable HTTP POSTs).
    @MainActor static func live(_ c: MCPServerConfig) throws -> any MCPClientTransport {
        if c.transport == "stdio" {
            guard let cmd = c.command else { throw MCPConfigError("No command configured") }
            return MCPStdioTransport(command: cmd, args: c.args, env: c.env ?? [:], cwd: c.cwd)
        }
        guard let s = c.url, let url = URL(string: s) else { throw MCPConfigError("No URL configured") }
        return MCPHTTPClientTransport(url: url, headers: c.headers ?? [:])
    }
}

/// One live MCP server connection (mcp-connection.ts): lazy connect, cached tool list (refreshed on
/// list_changed), per-call timeouts, reconnect with exponential backoff after an unexpected close, and a
/// close/kill that never leaves a stdio child behind.
@MainActor final class MCPConnection {
    static let connectTimeout: Duration = .seconds(15)
    static let backoffMax: Double = 30
    static let maxAutoReconnects = 5

    /// idle | connecting | ready | error | closed
    private(set) var state = "idle"
    private(set) var error: String?
    private(set) var tools: [MCPToolDef] = []
    private(set) var serverInfo: (name: String, version: String)?
    var config: MCPServerConfig
    let factory: MCPTransportFactory
    var onChange: () -> Void = {}
    var log: (String) -> Void = { _ in }
    var connectTimeout = MCPConnection.connectTimeout
    var backoffBase: Double = 1
    private var session: MCPClientSession?
    private var connecting: Task<Void, Error>?
    private var closing = false
    private(set) var attempts = 0
    private var retryTask: Task<Void, Never>?
    private var nextRetryAt: Date?

    init(config: MCPServerConfig, factory: @escaping MCPTransportFactory) {
        self.config = config
        self.factory = factory
    }

    var pid: Int32? { state == "ready" ? session?.transport.pid : nil }

    private func set(_ s: String, _ e: String? = nil) {
        state = s
        error = e
        onChange()
    }

    /// Connects if needed. During a backoff wait it fails fast with the last error.
    func ensure() async throws {
        if state == "ready", session != nil { return }
        if let c = connecting { return try await c.value }
        if retryTask != nil, let at = nextRetryAt, Date() < at {
            throw MCPConfigError("\(error ?? "Not connected") (retrying in \(Int(at.timeIntervalSinceNow.rounded(.up))) s)")
        }
        closing = false
        let t = Task { @MainActor in try await self.connect() }
        connecting = t
        defer { connecting = nil }
        try await t.value
    }

    private func connect() async throws {
        retryTask?.cancel()
        retryTask = nil
        set("connecting")
        let transport: any MCPClientTransport
        do { transport = try factory(config) } catch {
            set("error", error.localizedDescription)
            throw error
        }
        let s = MCPClientSession(transport: transport)
        do {
            try await s.connect(timeout: connectTimeout)
            let listed = try await s.listTools(timeout: connectTimeout)
            s.onClose = { [weak self, weak s] reason in
                guard let self, let s else { return }
                self.unexpectedClose(s, reason)
            }
            s.onNotification = { [weak self, weak s] method, _ in
                guard method == "notifications/tools/list_changed", let self, let s else { return }
                Task { @MainActor in
                    do {
                        self.tools = try await s.listTools(timeout: self.connectTimeout)
                        self.onChange()
                    } catch { self.log("mcp \(self.config.name): tool list refresh failed: \(error.localizedDescription)") }
                }
            }
            session = s
            tools = listed
            serverInfo = s.serverInfo
            attempts = 0
            set("ready")
        } catch {
            let stderr = transport.stderrTail
            await s.close()
            let msg = Self.describeConnectError(error, config, stderr: stderr)
            set("error", msg)
            throw MCPConfigError(msg)
        }
    }

    private func unexpectedClose(_ s: MCPClientSession, _ reason: String?) {
        guard session === s, !closing else { return }
        session = nil
        let tail = s.transport.stderrTail.split(separator: "\n").last.map(String.init)
        set("error", "Disconnected from “\(config.name)”\(tail.map { ": \($0)" } ?? reason.map { ": \($0)" } ?? "")")
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !closing, config.enabled, attempts < Self.maxAutoReconnects else { return }
        let delay = min(Self.backoffMax, backoffBase * pow(2, Double(attempts)))
        attempts += 1
        nextRetryAt = Date().addingTimeInterval(delay)
        retryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(delay * 1000)))
            guard let self, !Task.isCancelled, !self.closing else { return }
            self.retryTask = nil
            do { try await self.ensure() } catch { self.scheduleReconnect() }
        }
    }

    func callTool(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
        try await ensure()
        guard let s = session else { throw MCPConfigError("“\(config.name)” is not connected") }
        let timeoutMs = config.timeoutMs
        do {
            return try await s.callTool(name, arguments: .object(arguments), timeout: .milliseconds(timeoutMs))
        } catch let e as MCPError where e.code == MCP.requestTimeout {
            throw MCPConfigError("“\(name)” on \(config.name) timed out after \(Int((Double(timeoutMs) / 1000).rounded())) s")
        } catch let e as MCPError where e.code == MCP.connectionClosed {
            throw MCPConfigError("\(config.name) disconnected during the call")
        }
    }

    /// Graceful close (EOF, then SIGTERM/SIGKILL for stdio; DELETE for HTTP).
    func close() async {
        closing = true
        retryTask?.cancel()
        retryTask = nil
        let s = session
        session = nil
        if let s { await s.close() }
        if state != "idle" { set("closed") }
    }

    /// Synchronous kill for app quit; the watchdog forwards it to the server.
    func killNow() {
        closing = true
        retryTask?.cancel()
        (session?.transport as? MCPStdioTransport)?.killNow()
    }

    static func describeConnectError(_ err: Error, _ c: MCPServerConfig, stderr: String) -> String {
        let base = (err as? MCPError)?.message ?? err.localizedDescription
        let whereText = c.transport == "stdio" ? "`\(c.command ?? "")`" : (c.url ?? "")
        var msg = "Couldn't connect to “\(c.name)” (\(whereText)): \(base)"
        if (base + stderr).range(of: "ENOENT|not found|wasn't found|exit(ed)? with (code|status) 127", options: [.regularExpression, .caseInsensitive]) != nil {
            msg = "Couldn't start “\(c.name)”: \(c.command ?? "the command") wasn't found. Use the full path to the command."
        }
        if base.range(of: "\\b401\\b|unauthori[sz]ed", options: [.regularExpression, .caseInsensitive]) != nil {
            msg = "“\(c.name)” refused the connection (401 Unauthorized). Check the bearer token or headers."
        }
        if !stderr.isEmpty { msg += "\n" + stderr.split(separator: "\n").suffix(3).joined(separator: "\n") }
        return String(msg.prefix(1200))
    }
}
