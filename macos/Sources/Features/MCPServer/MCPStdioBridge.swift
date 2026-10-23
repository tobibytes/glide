import Darwin
import Foundation
import GlideCore
import GlideSystem

/// `Glide --mcp-stdio`: a stdio ⇄ Streamable HTTP proxy for MCP clients that launch servers as commands
/// (Claude Desktop, Goose, Cursor…) — bridge.ts. Reads the running server's URL from server.json and the bearer
/// token from Glide's data dir, then relays JSON-RPC messages unchanged both ways. No UI, no NSApplication.
///
/// Options: `--data-dir <Glide userData or the mcp-server dir>`, `--url <endpoint>`; env GLIDE_MCP_DIR, GLIDE_USER_DATA.
@MainActor public enum MCPStdioBridge {
    public static let flag = "--mcp-stdio"
    static let notRunning = "Glide's MCP server is not running. Open Glide → Settings → MCP Server and turn on “Enable MCP server”, then restart this MCP connection."

    static func serverDir(arguments: [String], environment: [String: String]) -> URL {
        if let i = arguments.firstIndex(of: "--data-dir"), i + 1 < arguments.count {
            let d = URL(fileURLWithPath: (arguments[i + 1] as NSString).expandingTildeInPath)
            // Either the userData dir or the mcp-server dir itself.
            if FileManager.default.fileExists(atPath: d.appendingPathComponent(MCPServerAuth.tokenFile).path) { return d }
            return GlidePaths.featureDirectory("mcp-server", root: d)
        }
        return MCPServerAuth.defaultServerDir(environment: environment)
    }

    /// Runs until stdin closes, then exits the process.
    public static func runAndExit(arguments: [String] = CommandLine.arguments, environment: [String: String] = ProcessInfo.processInfo.environment) -> Never {
        let dir = serverDir(arguments: arguments, environment: environment)
        var urlString = MCPServerAuth.readDiscovery(dir)?.url
        if let i = arguments.firstIndex(of: "--url"), i + 1 < arguments.count { urlString = arguments[i + 1] }
        guard let urlString, let url = URL(string: urlString), let token = MCPServerAuth.readToken(dir) else {
            FileHandle.standardError.write(Data("\(notRunning)\n(looked in \(dir.path))\n".utf8))
            exit(1)
        }
        let relay = MCPBridgeRelay(remote: MCPHTTPClientTransport(url: url, headers: ["Authorization": "Bearer \(token)"]))
        relay.start()
        withExtendedLifetime(relay) { dispatchMain() }
    }
}

/// The relay state of `Glide --mcp-stdio` (main actor).
@MainActor final class MCPBridgeRelay {
    let remote: MCPHTTPClientTransport
    private var pendingInit = Set<String>()
    private var lines = MCPLineBuffer()
    private var queue: [JSONValue] = []
    private var sending = false
    /// Messages sent concurrently once the session exists (a call waiting on a confirmation in Glide must not
    /// hold back pings, other calls or its own notifications/cancelled).
    private var inflight = 0
    private var finishing = false
    var write: (JSONValue) -> Void = { m in StdoutWriter.shared.line(String(decoding: MCP.encode(m), as: UTF8.self)) }
    var exitProcess: (Int32) -> Void = { exit($0) }

    init(remote: MCPHTTPClientTransport) { self.remote = remote }

    func err(_ s: String) { FileHandle.standardError.write(Data("glide-mcp: \(s)\n".utf8)) }

    func start() {
        remote.listenForNotifications = true
        remote.onMessage = { [weak self] m in
            guard let self else { return }
            if MCP.kind(m) == .response, self.pendingInit.remove(MCP.idKey(m["id"])) != nil, let v = m["result"]?["protocolVersion"]?.stringValue {
                self.remote.setProtocolVersion(v)
            }
            self.write(m)
        }
        remote.onClose = { [weak self] reason in if let reason { self?.err(reason) } }
        FileHandle.standardInput.readabilityHandler = { [weak self] h in
            let d = h.availableData
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.input(d) } }
        }
    }

    func input(_ d: Data) {
        if d.isEmpty {
            FileHandle.standardInput.readabilityHandler = nil
            // Let in-flight requests finish before closing the session.
            Task { @MainActor in
                while self.sending || !self.queue.isEmpty || self.inflight > 0 { try? await Task.sleep(for: .milliseconds(20)) }
                self.finish(0)
            }
            return
        }
        for line in lines.feed(d) {
            guard let m = MCP.decode(line) else {
                write(MCP.error(id: .null, code: MCP.parseError, message: "Parse error"))
                continue
            }
            if MCP.kind(m) == .request, m["method"]?.stringValue == "initialize" { pendingInit.insert(MCP.idKey(m["id"])) }
            queue.append(m)
        }
        pump()
    }

    /// Until the session exists (initialize answered), sends are serialised so initialize goes first; after that
    /// every message is sent as soon as it arrives, in stdin order, without waiting for earlier responses.
    private func pump() {
        while !sending, !queue.isEmpty {
            let m = queue.removeFirst()
            if remote.sessionId != nil {
                inflight += 1
                Task { @MainActor in
                    await self.forward(m)
                    self.inflight -= 1
                }
                continue
            }
            sending = true
            Task { @MainActor in
                await self.forward(m)
                self.sending = false
                self.pump()
            }
        }
    }

    private func forward(_ m: JSONValue) async {
        do { try await remote.send(m) } catch {
            let message = (error as? MCPError)?.message ?? error.localizedDescription
            err(message)
            if MCP.kind(m) == .request {
                let refused = (error as? URLError)?.code == .cannotConnectToHost || message.localizedCaseInsensitiveContains("could not connect")
                write(MCP.error(id: m["id"] ?? .null, code: -32000, message: refused ? MCPStdioBridge.notRunning : "Glide MCP request failed: \(message)"))
            }
        }
    }

    func finish(_ code: Int32) {
        guard !finishing else { return }
        finishing = true
        Task { @MainActor in
            await self.remote.close()
            self.exitProcess(code)
        }
    }
}
