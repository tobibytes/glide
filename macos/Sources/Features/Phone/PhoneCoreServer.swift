import Darwin
import Foundation
import GlideCore
import Network
import SystemConfiguration

// phone-core: the LAN server (docs/PHONE.md "Transport 1"). NWListener on TCP 7470 (or a free port), all
// interfaces unless GLIDE_PHONE_HOST pins one, Bonjour `_glide._tcp` when on all interfaces. GET serves the
// static web app (PhoneWebAssets, code only); POST /api carries one encrypted call. HTTP parsing reuses the MCP
// server's `MCPHTTPParser`.

struct PhoneHTTPResponse: Sendable {
    var status: Int
    var headers: [String: String] = [:]
    var body: Data
}

@MainActor final class PhoneLANServer {
    static let defaultPort = 7470
    static let maxBody = 32 * 1024 * 1024
    static let maxConnections = 48
    /// A connection that makes no progress for this long is closed (slow-loris guard).
    var idleTimeout: Duration = .seconds(30)

    /// Bind address (nil = all interfaces).
    let host: String?
    let api: @MainActor (Data) async -> PhoneHTTPResponse
    var log: (String) -> Void = { _ in }
    private(set) var port = 0
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: PhoneHTTPConnection] = [:]
    private(set) var advertised = false

    init(host: String?, api: @escaping @MainActor (Data) async -> PhoneHTTPResponse) {
        self.host = host
        self.api = api
    }

    /// The URL the phone opens: the pinned host, else this Mac's LAN IPv4.
    var baseURL: String? {
        guard port > 0 else { return nil }
        let h = host.flatMap { $0 == "0.0.0.0" || $0 == "::" ? nil : $0 } ?? PhoneNetwork.lanIPv4() ?? "127.0.0.1"
        return "http://\(h.contains(":") ? "[\(h)]" : h):\(port)"
    }

    /// `http://<name>.local:<port>` (Bonjour host name), when known.
    var localURL: String? {
        guard port > 0, host == nil, let n = PhoneNetwork.localHostName() else { return nil }
        return "http://\(n):\(port)"
    }

    func start(preferredPort: Int, bonjourName: String?) async throws {
        do { try await listen(preferredPort, bonjourName: bonjourName) } catch {
            if preferredPort == 0 { throw error }
            log("port \(preferredPort) unavailable; using a free port")
            try await listen(0, bonjourName: bonjourName)
        }
    }

    private func listen(_ p: Int, bonjourName: String?) async throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = false
        let nwPort = p == 0 ? NWEndpoint.Port.any : (NWEndpoint.Port(rawValue: UInt16(clamping: p)) ?? .any)
        let l: NWListener
        if let host {
            params.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: nwPort)
            l = try NWListener(using: params)
        } else {
            l = try NWListener(using: params, on: nwPort)
            if let bonjourName {
                l.service = NWListener.Service(name: bonjourName, type: "_glide._tcp")
                advertised = true
            }
        }
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
        guard connections.count < Self.maxConnections else { c.cancel(); return }
        let conn = PhoneHTTPConnection(connection: c, maxBody: Self.maxBody, idleTimeout: idleTimeout)
        connections[ObjectIdentifier(conn)] = conn
        conn.onRequest = { [weak self, weak conn] req in
            guard let self, let conn else { return }
            Task { @MainActor in conn.send(await self.handle(req)) }
        }
        conn.onClose = { [weak self, weak conn] in
            guard let self, let conn else { return }
            self.connections[ObjectIdentifier(conn)] = nil
        }
        conn.start()
    }

    static let securityHeaders: [String: String] = [
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Cache-Control": "no-store",
    ]

    static func text(_ status: Int, _ s: String) -> PhoneHTTPResponse {
        PhoneHTTPResponse(status: status, headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data(s.utf8))
    }

    func handle(_ req: MCPHTTPRequest) async -> PhoneHTTPResponse {
        var r: PhoneHTTPResponse
        switch (req.method, req.path) {
        case ("POST", "/api"):
            r = await api(req.body)
        case (_, "/api"):
            r = Self.text(405, "Use POST")
            r.headers["Allow"] = "POST"
        case ("GET", _), ("HEAD", _):
            if let f = PhoneWebAssets.asset(req.path) {
                r = PhoneHTTPResponse(status: 200, headers: ["Content-Type": f.type], body: req.method == "HEAD" ? Data() : f.data)
            } else {
                r = Self.text(404, "Not found")
            }
        default:
            r = Self.text(404, "Not found")
        }
        for (k, v) in Self.securityHeaders where r.headers[k] == nil { r.headers[k] = v }
        return r
    }

    func close() async {
        for c in connections.values { c.close() }
        connections.removeAll()
        listener?.service = nil
        listener?.cancel()
        listener = nil
        port = 0
    }
}

/// One TCP connection: keep-alive request loop with an idle timeout.
@MainActor final class PhoneHTTPConnection {
    let connection: NWConnection
    private var parser: MCPHTTPParser
    let idleTimeout: Duration
    var onRequest: (MCPHTTPRequest) -> Void = { _ in }
    var onClose: () -> Void = {}
    private var busy = false
    private var closed = false
    private var lastProgress = ContinuousClock.now
    private var watchdog: Task<Void, Never>?

    init(connection: NWConnection, maxBody: Int, idleTimeout: Duration) {
        self.connection = connection
        self.idleTimeout = idleTimeout
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
        watchdog = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                try? await Task.sleep(for: .seconds(1))
                // While a request is being handled (e.g. waiting on a confirmation) the phone is just waiting.
                if !self.busy, ContinuousClock.now - self.lastProgress > self.idleTimeout { self.close(); return }
            }
        }
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1024 * 1024) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let data, !data.isEmpty {
                    self.lastProgress = .now
                    self.parser.buffer.append(data)
                    self.pump()
                }
                if complete || error != nil { if !self.busy { self.close() }; return }
                self.receive()
            }
        }
    }

    private func pump() {
        guard !busy, !closed else { return }
        switch parser.next() {
        case .need: return
        case let .error(status, message):
            busy = true
            send(PhoneLANServer.text(status, message), keepAlive: false)
        case let .request(r):
            busy = true
            onRequest(r)
        }
    }

    func send(_ r: PhoneHTTPResponse, keepAlive: Bool = true) {
        guard !closed else { return }
        var h = "HTTP/1.1 \(r.status) \(MCPHTTPConnection.reason(r.status))\r\n"
        var all = r.headers
        if all["Content-Type"] == nil && !r.body.isEmpty { all["Content-Type"] = "application/json" }
        all["Content-Length"] = String(r.body.count)
        all["Connection"] = keepAlive ? "keep-alive" : "close"
        for (k, v) in all.sorted(by: { $0.key < $1.key }) { h += "\(k): \(v)\r\n" }
        h += "\r\n"
        var out = Data(h.utf8)
        out.append(r.body)
        connection.send(content: out, completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if !keepAlive { self.close(); return }
                self.busy = false
                self.lastProgress = .now
                self.pump()
            }
        })
    }

    func close() {
        guard !closed else { return }
        closed = true
        watchdog?.cancel()
        connection.cancel()
        onClose()
    }

    private func finish() {
        if !closed {
            closed = true
            watchdog?.cancel()
            onClose()
        }
    }
}

enum PhoneNetwork {
    /// The Mac's LAN IPv4 (Wi-Fi / Ethernet first, private ranges preferred).
    static func lanIPv4() -> String? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(head) }
        var found: [(name: String, ip: String)] = []
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = p {
            defer { p = cur.pointee.ifa_next }
            let flags = Int32(cur.pointee.ifa_flags)
            guard let sa = cur.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  flags & IFF_UP != 0, flags & IFF_RUNNING != 0, flags & IFF_LOOPBACK == 0 else { continue }
            var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: buf)
            if ip.hasPrefix("169.254.") { continue }
            found.append((String(cString: cur.pointee.ifa_name), ip))
        }
        func rank(_ e: (name: String, ip: String)) -> Int {
            let isPrivate = e.ip.hasPrefix("192.168.") || e.ip.hasPrefix("10.") || (e.ip.hasPrefix("172.") && (16...31).contains(Int(e.ip.split(separator: ".")[1]) ?? 0))
            return (e.name.hasPrefix("en") ? 0 : 2) + (isPrivate ? 0 : 1)
        }
        return found.min { rank($0) < rank($1) }?.ip
    }

    /// "<name>.local" from the Bonjour local host name (System Settings → General → Sharing).
    static func localHostName() -> String? {
        guard let n = SCDynamicStoreCopyLocalHostName(nil) as String?, !n.isEmpty else { return nil }
        return "\(n).local"
    }

    /// The computer name ("Tobi's MacBook Pro"), without a DNS lookup.
    static func computerName() -> String {
        (SCDynamicStoreCopyComputerName(nil, nil) as String?).flatMap { $0.isEmpty ? nil : $0 } ?? "Mac"
    }
}
