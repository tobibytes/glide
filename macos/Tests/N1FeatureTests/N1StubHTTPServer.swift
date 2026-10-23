import Darwin
import Foundation

/// A tiny HTTP/1.1 server on 127.0.0.1 (random port) serving canned exchange-rate responses, so tests never touch
/// the network. `/v6/latest/USD` mimics open.er-api.com, `/frankfurter/latest` mimics api.frankfurter.app.
final class N1StubHTTPServer: @unchecked Sendable {
    let port: UInt16
    private let fd: Int32
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    private var running = true
    let failER: Bool

    var baseURL: String { "http://127.0.0.1:\(port)" }

    init(failER: Bool = false) throws {
        self.failER = failER
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { throw URLError(.cannotCreateFile) }
        var yes: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0, listen(sock, 16) == 0 else { close(sock); throw URLError(.cannotConnectToHost) }
        var out = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &out) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &len) } }
        port = UInt16(bigEndian: out.sin_port)
        fd = sock
        let t = Thread { [weak self] in self?.loop() }
        t.start()
    }

    func hits(_ prefix: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return counts.filter { $0.key.hasPrefix(prefix) }.values.reduce(0, +)
    }

    func stop() {
        lock.lock()
        running = false
        lock.unlock()
        shutdown(fd, SHUT_RDWR)
        close(fd)
    }

    private func loop() {
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 {
                lock.lock()
                let r = running
                lock.unlock()
                if !r { return }
                continue
            }
            handle(c)
        }
    }

    private func handle(_ c: Int32) {
        var buf = [UInt8](repeating: 0, count: 8192)
        let n = read(c, &buf, buf.count)
        let req = n > 0 ? String(decoding: buf[0..<n], as: UTF8.self) : ""
        let path = req.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        lock.lock()
        counts[path, default: 0] += 1
        lock.unlock()
        var status = "200 OK"
        var body = "{}"
        if path.hasPrefix("/v6/latest/USD") {
            if failER { status = "500 Internal Server Error"; body = #"{"result":"error"}"# } else {
                body = #"{"result":"success","time_last_update_unix":1792454400,"base_code":"USD","rates":{"USD":1,"EUR":0.9,"GBP":0.8,"JPY":150,"NGN":1500}}"#
            }
        } else if path.hasPrefix("/frankfurter/latest") {
            body = #"{"amount":1,"base":"USD","date":"2026-10-17","rates":{"EUR":0.86,"GBP":0.75,"bad":"x"}}"#
        } else { status = "404 Not Found" }
        let resp = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        _ = resp.withCString { write(c, $0, strlen($0)) }
        close(c)
    }
}
