import Foundation
import Network

/// Minimal HTTP/1.1 server on 127.0.0.1 (random port) for fetch / store tests. One request per connection.
final class LocalHTTPServer: @unchecked Sendable {
    typealias Handler = @Sendable (_ method: String, _ path: String, _ query: [String: String]) -> (status: Int, type: String, body: Data)
    private let listener: NWListener
    private let queue = DispatchQueue(label: "n9.http")
    private let lock = NSLock()
    private var _requests: [String] = []
    var requests: [String] { lock.lock(); defer { lock.unlock() }; return _requests }
    private(set) var port: UInt16 = 0

    init(handler: @escaping Handler) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { s in if case .ready = s { ready.signal() } }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            conn.start(queue: self.queue)
            self.read(conn, Data(), handler)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        port = listener.port?.rawValue ?? 0
    }

    var base: String { "http://127.0.0.1:\(port)" }

    private func read(_ conn: NWConnection, _ acc: Data, _ handler: @escaping Handler) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, _ in
            guard let self else { return }
            var buf = acc
            if let data { buf.append(data) }
            guard let end = buf.range(of: Data("\r\n\r\n".utf8)) else {
                if done { conn.cancel() } else { self.read(conn, buf, handler) }
                return
            }
            let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
            let first = head.split(separator: "\r\n").first.map(String.init) ?? ""
            let parts = first.split(separator: " ")
            let method = parts.first.map(String.init) ?? "GET"
            let target = parts.count > 1 ? String(parts[1]) : "/"
            let comps = URLComponents(string: target)
            var q: [String: String] = [:]
            for i in comps?.queryItems ?? [] { q[i.name] = i.value ?? "" }
            self.lock.lock(); self._requests.append(target); self.lock.unlock()
            let r = handler(method, comps?.path ?? target, q)
            var resp = Data("HTTP/1.1 \(r.status) OK\r\nContent-Type: \(r.type)\r\nContent-Length: \(r.body.count)\r\nConnection: close\r\n\r\n".utf8)
            resp.append(r.body)
            conn.send(content: resp, completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    func stop() { listener.cancel() }
}
