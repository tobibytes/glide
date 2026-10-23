import Foundation
import GlideCore

/// A tool as listed by an MCP server (tools/list).
struct MCPToolDef: Equatable, Sendable {
    var name: String
    var title: String?
    var description: String?
    var inputSchema: JSONValue
    var readOnlyHint: Bool?
    var destructiveHint: Bool?
    var idempotentHint: Bool?
    var openWorldHint: Bool?
    var annotationTitle: String?

    init(name: String, title: String? = nil, description: String? = nil, inputSchema: JSONValue = ["type": "object"],
         readOnlyHint: Bool? = nil, destructiveHint: Bool? = nil, openWorldHint: Bool? = nil) {
        self.name = name
        self.title = title
        self.description = description
        self.inputSchema = inputSchema
        self.readOnlyHint = readOnlyHint
        self.destructiveHint = destructiveHint
        self.openWorldHint = openWorldHint
    }

    init?(_ v: JSONValue) {
        guard let name = v["name"]?.stringValue else { return nil }
        self.name = name
        title = v["title"]?.stringValue
        description = v["description"]?.stringValue
        inputSchema = v["inputSchema"] ?? ["type": "object"]
        let a = v["annotations"]
        readOnlyHint = a?["readOnlyHint"]?.boolValue
        destructiveHint = a?["destructiveHint"]?.boolValue
        idempotentHint = a?["idempotentHint"]?.boolValue
        openWorldHint = a?["openWorldHint"]?.boolValue
        annotationTitle = a?["title"]?.stringValue
    }
}

/// One MCP client session over a transport: initialize handshake, request/response correlation with
/// timeouts, notifications, server→client requests (ping, roots/list), tools and resources.
@MainActor final class MCPClientSession {
    let transport: any MCPClientTransport
    let clientInfo: JSONValue
    private var nextId = 1
    private var pending: [String: CheckedContinuation<JSONValue, Error>] = [:]
    private(set) var serverInfo: (name: String, version: String)?
    private(set) var serverCapabilities: JSONValue = [:]
    private(set) var instructions: String?
    private(set) var protocolVersion: String?
    private(set) var isClosed = false
    /// (method, params) of every notification from the server.
    var onNotification: ((String, JSONValue?) -> Void)?
    /// Unexpected close (reason), after a successful connect or during it.
    var onClose: ((String?) -> Void)?

    init(transport: any MCPClientTransport, clientName: String = "Glide Agent", clientVersion: String = "1.0.0") {
        self.transport = transport
        clientInfo = ["name": .string(clientName), "version": .string(clientVersion)]
        transport.onMessage = { [weak self] m in self?.handle(m) }
        transport.onClose = { [weak self] reason in self?.closed(reason) }
    }

    /// initialize → notifications/initialized. Throws on version mismatch or timeout.
    func connect(timeout: Duration = .seconds(15)) async throws {
        try await transport.start()
        let res = try await request("initialize", ["protocolVersion": .string(MCP.latestProtocolVersion), "capabilities": [:], "clientInfo": clientInfo], timeout: timeout)
        guard let v = res["protocolVersion"]?.stringValue, MCP.supportedProtocolVersions.contains(v) else {
            throw MCPError(code: MCP.invalidRequest, message: "The server's protocol version \(res["protocolVersion"]?.description ?? "?") is not supported")
        }
        protocolVersion = v
        transport.setProtocolVersion(v)
        if let info = res["serverInfo"] { serverInfo = (info["name"]?.stringValue ?? "", info["version"]?.stringValue ?? "") }
        serverCapabilities = res["capabilities"] ?? [:]
        instructions = res["instructions"]?.stringValue
        try await transport.send(MCP.notification("notifications/initialized"))
    }

    func request(_ method: String, _ params: JSONValue? = nil, timeout: Duration = .seconds(30)) async throws -> JSONValue {
        if isClosed { throw MCPError.closed() }
        let id = nextId
        nextId += 1
        let key = MCP.idKey(.int(Int64(id)))
        let message = MCP.request(id: .int(Int64(id)), method: method, params: params)
        let timer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled, let self, let c = self.pending.removeValue(forKey: key) else { return }
            c.resume(throwing: MCPError(code: MCP.requestTimeout, message: "Request timed out"))
            // Tell the server we gave up (spec: notifications/cancelled).
            try? await self.transport.send(MCP.notification("notifications/cancelled", params: ["requestId": .int(Int64(id)), "reason": "timeout"]))
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<JSONValue, Error>) in
                pending[key] = c
                Task { @MainActor [weak self] in
                    do { try await self?.transport.send(message) } catch {
                        if let c = self?.pending.removeValue(forKey: key) { c.resume(throwing: error) }
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                if let c = self?.pending.removeValue(forKey: key) { c.resume(throwing: CancellationError()) }
            }
        }
    }

    func notify(_ method: String, _ params: JSONValue? = nil) async throws {
        try await transport.send(MCP.notification(method, params: params))
    }

    private func handle(_ m: JSONValue) {
        switch MCP.kind(m) {
        case .response:
            guard let c = pending.removeValue(forKey: MCP.idKey(m["id"])) else { return }
            if let e = m["error"] {
                c.resume(throwing: MCPError(code: e["code"]?.intValue ?? MCP.internalError, message: e["message"]?.stringValue ?? "Error", data: e["data"]))
            } else {
                c.resume(returning: m["result"] ?? .null)
            }
        case .notification:
            onNotification?(m["method"]?.stringValue ?? "", m["params"])
        case .request:
            let id = m["id"] ?? .null
            let reply: JSONValue
            switch m["method"]?.stringValue ?? "" {
            case "ping": reply = MCP.result(id: id, [:])
            case "roots/list": reply = MCP.result(id: id, ["roots": []])
            default: reply = MCP.error(id: id, code: MCP.methodNotFound, message: "Method not found")
            }
            Task { @MainActor [weak self] in try? await self?.transport.send(reply) }
        case .invalid: break
        }
    }

    private func closed(_ reason: String?) {
        guard !isClosed else { return }
        isClosed = true
        let waiting = pending
        pending = [:]
        for c in waiting.values { c.resume(throwing: MCPError.closed(reason ?? "Connection closed")) }
        onClose?(reason)
    }

    func close() async {
        if isClosed { return }
        onClose = nil
        await transport.close()
        closed(nil)
    }

    // MARK: high level

    func listTools(timeout: Duration = .seconds(15)) async throws -> [MCPToolDef] {
        var out: [MCPToolDef] = []
        var cursor: String?
        for _ in 0..<20 {
            let r = try await request("tools/list", cursor.map { ["cursor": .string($0)] }, timeout: timeout)
            out += (r["tools"]?.arrayValue ?? []).compactMap(MCPToolDef.init)
            cursor = r["nextCursor"]?.stringValue
            if cursor == nil { break }
        }
        return out
    }

    func callTool(_ name: String, arguments: JSONValue, timeout: Duration) async throws -> JSONValue {
        try await request("tools/call", ["name": .string(name), "arguments": arguments], timeout: timeout)
    }

    func listResources() async throws -> [JSONValue] { try await request("resources/list")["resources"]?.arrayValue ?? [] }

    func readResource(_ uri: String) async throws -> [JSONValue] {
        try await request("resources/read", ["uri": .string(uri)])["contents"]?.arrayValue ?? []
    }
}
