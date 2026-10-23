import Foundation
import GlideCore
import Network

/// A minimal HTTP/1.1 request (what the MCP endpoint needs).
struct MCPHTTPRequest {
    var method: String
    var path: String
    /// Lower-cased names.
    var headers: [String: String]
    var body: Data
}

/// Incremental HTTP/1.1 request parser (Content-Length and chunked bodies, size cap).
struct MCPHTTPParser {
    enum Outcome { case need, request(MCPHTTPRequest), error(Int, String) }
    var buffer = Data()
    let maxBody: Int

    init(maxBody: Int) { self.maxBody = maxBody }

    mutating func next() -> Outcome {
        guard let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            return buffer.count > 64 * 1024 ? .error(431, "Request headers too large") : .need
        }
        let head = String(decoding: buffer[buffer.startIndex..<headEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return .error(400, "Bad request line") }
        var headers: [String: String] = [:]
        for l in lines {
            guard let c = l.firstIndex(of: ":") else { continue }
            let k = l[..<c].trimmingCharacters(in: .whitespaces).lowercased()
            let v = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
            headers[k] = headers[k].map { "\($0), \(v)" } ?? v
        }
        let bodyStart = headEnd.upperBound
        var body = Data()
        var consumed = bodyStart
        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            var i = bodyStart
            while true {
                guard let lineEnd = buffer[i...].range(of: Data("\r\n".utf8)) else { return .need }
                let sizeText = String(decoding: buffer[i..<lineEnd.lowerBound], as: UTF8.self).split(separator: ";").first.map(String.init) ?? ""
                guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16) else { return .error(400, "Bad chunk") }
                let dataStart = lineEnd.upperBound
                if size == 0 {
                    // Skip trailers up to the final CRLF.
                    guard let end = buffer[dataStart...].range(of: Data("\r\n".utf8)) else { return .need }
                    consumed = end.upperBound
                    break
                }
                guard buffer.count >= dataStart + size + 2 else { return .need }
                body.append(buffer[dataStart..<(dataStart + size)])
                if body.count > maxBody { return .error(413, "Request body too large") }
                i = dataStart + size + 2
            }
        } else {
            let len = Int(headers["content-length"] ?? "0") ?? -1
            if len < 0 { return .error(400, "Bad Content-Length") }
            if len > maxBody { return .error(413, "Request body too large") }
            guard buffer.count >= bodyStart + len else { return .need }
            body = Data(buffer[bodyStart..<(bodyStart + len)])
            consumed = bodyStart + len
        }
        buffer.removeSubrange(buffer.startIndex..<consumed)
        let target = String(requestLine[1])
        let path = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? target
        return .request(MCPHTTPRequest(method: String(requestLine[0]).uppercased(), path: path, headers: headers, body: body))
    }
}

/// Streamable HTTP endpoint for MCP on 127.0.0.1 only (http.ts), on a Network.framework listener.
/// Every request needs `Authorization: Bearer <token>`; Host/Origin are checked (DNS-rebinding guard); each
/// initialize creates a session (Mcp-Session-Id); ≤ 32 sessions, idle ones dropped after 30 min; 4 MB bodies.
@MainActor final class MCPHTTPServer {
    static let host = "127.0.0.1"
    let token: () -> String
    let makeSession: () -> MCPServerSession
    var onSessionsChanged: (Int) -> Void = { _ in }
    var log: (String) -> Void = { _ in }
    var maxSessions = 32
    var idle: TimeInterval = 30 * 60
    var maxBody = 4 * 1024 * 1024
    private(set) var port = 0
    private var listener: NWListener?
    private var sessions: [String: MCPServerSession] = [:]
    private var streams: [String: [MCPHTTPConnection]] = [:]
    private var connections: [ObjectIdentifier: MCPHTTPConnection] = [:]
    private var sweep: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    /// SSE comment interval on open GET streams, so clients' idle-body timeouts (undici: 300 s) never fire.
    var heartbeatInterval: Duration = .seconds(20)

    init(token: @escaping () -> String, makeSession: @escaping () -> MCPServerSession) {
        self.token = token
        self.makeSession = makeSession
    }

    var url: String { "http://\(Self.host):\(port)\(MCPServerAuth.path)" }
    var sessionCount: Int { sessions.count }

    /// Binds 127.0.0.1:<preferred>; falls back to any free port when taken.
    func start(preferredPort: Int) async throws {
        do { try await listen(preferredPort) } catch {
            if preferredPort == 0 { throw error }
            log("port \(preferredPort) unavailable (\(error.localizedDescription)); using a free port")
            try await listen(0)
        }
        sweep = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard let self else { return }
                let cutoff = Date().addingTimeInterval(-self.idle)
                // A session with an open GET stream is a connected client even when it sends nothing.
                for (id, s) in self.sessions where s.lastSeen < cutoff && (self.streams[id] ?? []).isEmpty { self.drop(id) }
            }
        }
        heartbeat = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let interval = self?.heartbeatInterval else { return }
                try? await Task.sleep(for: interval)
                guard let self else { return }
                for list in self.streams.values { for c in list { c.sendComment("ping") } }
            }
        }
    }

    private func listen(_ p: Int) async throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = false
        let nwPort = p == 0 ? NWEndpoint.Port.any : (NWEndpoint.Port(rawValue: UInt16(clamping: p)) ?? .any)
        params.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(Self.host), port: nwPort)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] c in MainActor.assumeIsolated { self?.accept(c) } }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            var resumed = false
            l.stateUpdateHandler = { state in
                MainActor.assumeIsolated {
                    switch state {
                    case .ready:
                        if !resumed { resumed = true; cont.resume() }
                    case let .failed(e), let .waiting(e):
                        if !resumed { resumed = true; l.cancel(); cont.resume(throwing: e) }
                    default: break
                    }
                }
            }
            l.start(queue: .main)
        }
        listener = l
        port = Int(l.port?.rawValue ?? 0)
    }

    private func accept(_ c: NWConnection) {
        let conn = MCPHTTPConnection(connection: c, maxBody: maxBody)
        connections[ObjectIdentifier(conn)] = conn
        conn.onRequest = { [weak self, weak conn] req in
            guard let self, let conn else { return }
            Task { @MainActor in await self.handle(req, conn) }
        }
        conn.onClose = { [weak self, weak conn] in
            guard let self, let conn else { return }
            self.connections[ObjectIdentifier(conn)] = nil
            for (k, list) in self.streams { self.streams[k] = list.filter { $0 !== conn } }
        }
        conn.start()
    }

    static func rpcError(_ message: String, code: Int = -32000) -> Data { MCP.encode(MCP.error(id: .null, code: code, message: message)) }

    private func handle(_ req: MCPHTTPRequest, _ conn: MCPHTTPConnection) async {
        guard MCPServerAuth.checkHostOrigin(host: req.headers["host"], origin: req.headers["origin"], port: port) else {
            return conn.send(status: 403, body: Self.rpcError("Forbidden host or origin"))
        }
        guard req.path == MCPServerAuth.path else { return conn.send(status: 404, body: Self.rpcError("Not found")) }
        guard MCPServerAuth.authorized(req.headers["authorization"], token: token()) else {
            return conn.send(status: 401, headers: ["WWW-Authenticate": "Bearer realm=\"glide\""], body: Self.rpcError("Missing or invalid bearer token"))
        }
        if let sid = req.headers["mcp-session-id"], !sid.isEmpty {
            guard let s = sessions[sid] else { return conn.send(status: 404, body: Self.rpcError("Unknown or expired session")) }
            s.lastSeen = Date()
            // 2025-06-18 transport spec: an invalid or unsupported MCP-Protocol-Version is a 400.
            if let v = req.headers["mcp-protocol-version"], !MCP.supportedProtocolVersions.contains(v) {
                return conn.send(status: 400, body: Self.rpcError("Unsupported MCP-Protocol-Version: \(v.prefix(40))"))
            }
            switch req.method {
            case "DELETE":
                drop(sid)
                return conn.send(status: 200, body: Data())
            case "GET":
                guard (req.headers["accept"] ?? "").contains("text/event-stream") else { return conn.send(status: 406, body: Self.rpcError("Accept text/event-stream")) }
                streams[sid, default: []].append(conn)
                conn.openEventStream()
                return
            case "POST":
                return await post(req, conn, session: s, sid: sid)
            default:
                return conn.send(status: 405, headers: ["Allow": "GET, POST, DELETE"], body: Self.rpcError("Method not allowed"))
            }
        }
        guard req.method == "POST" else { return conn.send(status: 400, body: Self.rpcError("Missing Mcp-Session-Id")) }
        guard let body = MCP.decode(req.body) else { return conn.send(status: 400, body: Self.rpcError("Invalid JSON", code: MCP.parseError)) }
        let first = body.arrayValue?.first ?? body
        guard first["method"]?.stringValue == "initialize", MCP.kind(first) == .request else {
            return conn.send(status: 400, body: Self.rpcError("The first request of a session must be initialize"))
        }
        if sessions.count >= maxSessions, let oldest = sessions.min(by: { $0.value.lastSeen < $1.value.lastSeen })?.key { drop(oldest) }
        let s = makeSession()
        sessions[s.id] = s
        s.push = { [weak self] m in self?.pushEvent(m, to: s.id) }
        onSessionsChanged(sessions.count)
        await post(req, conn, session: s, sid: s.id, parsed: body)
    }

    private func post(_ req: MCPHTTPRequest, _ conn: MCPHTTPConnection, session s: MCPServerSession, sid: String, parsed: JSONValue? = nil) async {
        guard let body = parsed ?? MCP.decode(req.body) else { return conn.send(status: 400, body: Self.rpcError("Invalid JSON", code: MCP.parseError)) }
        let headers = ["Mcp-Session-Id": sid]
        if case let .array(list) = body {
            var out: [JSONValue] = []
            for m in list { if let r = await s.handle(m) { out.append(r) } }
            if out.isEmpty { return conn.send(status: 202, headers: headers, body: Data()) }
            return conn.send(status: 200, headers: headers.merging(["Content-Type": "application/json"]) { $1 }, body: MCP.encode(.array(out)))
        }
        guard let r = await s.handle(body) else { return conn.send(status: 202, headers: headers, body: Data()) }
        conn.send(status: 200, headers: headers.merging(["Content-Type": "application/json"]) { $1 }, body: MCP.encode(r))
    }

    private func pushEvent(_ m: JSONValue, to sid: String) {
        for c in streams[sid] ?? [] { c.sendEvent(MCP.encode(m)) }
    }

    private func drop(_ id: String) {
        guard sessions.removeValue(forKey: id) != nil else { return }
        for c in streams.removeValue(forKey: id) ?? [] { c.close() }
        onSessionsChanged(sessions.count)
    }

    /// Tell every session that tools/resources changed (policies were edited).
    func notifyListChanged() { for s in sessions.values { s.notifyListChanged() } }

    func close() async {
        sweep?.cancel()
        heartbeat?.cancel()
        for id in Array(sessions.keys) { drop(id) }
        for c in connections.values { c.close() }
        connections.removeAll()
        listener?.cancel()
        listener = nil
    }
}

/// One TCP connection: keep-alive request loop, JSON responses, an optional SSE stream.
@MainActor final class MCPHTTPConnection {
    let connection: NWConnection
    private var parser: MCPHTTPParser
    var onRequest: (MCPHTTPRequest) -> Void = { _ in }
    var onClose: () -> Void = {}
    private var busy = false
    private var streaming = false
    private var closed = false

    init(connection: NWConnection, maxBody: Int) {
        self.connection = connection
        parser = MCPHTTPParser(maxBody: maxBody)
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] st in
            MainActor.assumeIsolated {
                switch st {
                case .failed, .cancelled: self?.finish()
                default: break
                }
            }
        }
        connection.start(queue: .main)
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let data, !data.isEmpty {
                    self.parser.buffer.append(data)
                    self.pump()
                }
                if complete || error != nil { if !self.streaming { self.close() } ; return }
                self.receive()
            }
        }
    }

    private func pump() {
        guard !busy, !streaming else { return }
        switch parser.next() {
        case .need: return
        case let .error(status, message):
            send(status: status, body: MCPHTTPServer.rpcError(message), keepAlive: false)
        case let .request(r):
            busy = true
            onRequest(r)
        }
    }

    static func reason(_ s: Int) -> String {
        [200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
         406: "Not Acceptable", 413: "Payload Too Large", 431: "Request Header Fields Too Large", 500: "Internal Server Error"][s] ?? "Status"
    }

    func send(status: Int, headers: [String: String] = [:], body: Data, keepAlive: Bool = true) {
        guard !closed else { return }
        var h = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        var all = headers
        if all["Content-Type"] == nil && !body.isEmpty { all["Content-Type"] = "application/json" }
        all["Content-Length"] = String(body.count)
        all["Connection"] = keepAlive ? "keep-alive" : "close"
        all["Cache-Control"] = "no-store"
        for (k, v) in all.sorted(by: { $0.key < $1.key }) { h += "\(k): \(v)\r\n" }
        h += "\r\n"
        var out = Data(h.utf8)
        out.append(body)
        connection.send(content: out, completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if !keepAlive { self.close(); return }
                self.busy = false
                self.pump()
            }
        })
    }

    func openEventStream() {
        streaming = true
        busy = false
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: glide\n\n"
        connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
    }

    func sendComment(_ text: String) {
        guard streaming, !closed else { return }
        connection.send(content: Data(": \(text)\n\n".utf8), completion: .contentProcessed { _ in })
    }

    func sendEvent(_ data: Data) {
        guard streaming, !closed else { return }
        var out = Data("event: message\ndata: ".utf8)
        out.append(data)
        out.append(Data("\n\n".utf8))
        connection.send(content: out, completion: .contentProcessed { _ in })
    }

    func close() {
        guard !closed else { return }
        closed = true
        connection.cancel()
        onClose()
    }

    private func finish() {
        if !closed { closed = true; onClose() }
    }
}
