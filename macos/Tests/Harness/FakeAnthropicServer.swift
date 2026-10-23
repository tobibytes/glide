import Foundation

/// A tiny HTTP/1.1 server on 127.0.0.1 (random port) that impersonates the Anthropic API for tests — so no test
/// ever reaches the real API or needs a real key. Responses are scripted per request; streaming bodies are
/// written chunk by chunk with optional delays. Every request (method, path, headers, body) is recorded.
public final class FakeAnthropicServer: @unchecked Sendable {
    public struct Request: Sendable {
        public var method: String
        public var path: String
        public var headers: [String: String]
        public var body: Data
        public var json: [String: Any]? { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] }
    }

    public struct Response: Sendable {
        public var status: Int
        public var headers: [String: String]
        /// Written in order; `delay` before each chunk.
        public var chunks: [(data: Data, delay: TimeInterval)]
        public init(status: Int = 200, headers: [String: String] = [:], chunks: [(data: Data, delay: TimeInterval)]) {
            self.status = status
            self.headers = headers
            self.chunks = chunks
        }

        public static func json(_ status: Int, _ obj: Any, headers: [String: String] = [:]) -> Response {
            let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
            return Response(status: status, headers: ["content-type": "application/json"].merging(headers) { $1 }, chunks: [(data, 0)])
        }

        /// A Messages API SSE stream that streams `text` in `pieces` text deltas.
        public static func sse(text: String, model: String = "claude-opus-5-5", pieces: Int = 3, delay: TimeInterval = 0.02,
                               stopReason: String = "end_turn", extraBlocks: [String] = []) -> Response {
            var events: [String] = []
            events.append(event("message_start", ["type": "message_start", "message": ["id": "msg_fake", "type": "message", "role": "assistant", "model": model,
                                                                                     "content": [], "usage": ["input_tokens": 12, "output_tokens": 1]]]))
            events.append(event("ping", ["type": "ping"]))
            var index = 0
            // thinking block (display omitted → empty), like Opus 5.5
            events.append(event("content_block_start", ["type": "content_block_start", "index": index, "content_block": ["type": "thinking", "thinking": ""]]))
            events.append(event("content_block_delta", ["type": "content_block_delta", "index": index, "delta": ["type": "signature_delta", "signature": "sig"]]))
            events.append(event("content_block_stop", ["type": "content_block_stop", "index": index]))
            index += 1
            events.append(contentsOf: extraBlocks)
            events.append(event("content_block_start", ["type": "content_block_start", "index": index, "content_block": ["type": "text", "text": ""]]))
            let chars = Array(text)
            let size = max(1, Int((Double(chars.count) / Double(max(1, pieces))).rounded(.up)))
            var i = 0
            while i < chars.count {
                let piece = String(chars[i..<min(chars.count, i + size)])
                events.append(event("content_block_delta", ["type": "content_block_delta", "index": index, "delta": ["type": "text_delta", "text": piece]]))
                i += size
            }
            events.append(event("content_block_stop", ["type": "content_block_stop", "index": index]))
            events.append(event("message_delta", ["type": "message_delta", "delta": ["stop_reason": stopReason, "stop_sequence": NSNull()], "usage": ["output_tokens": 42]]))
            events.append(event("message_stop", ["type": "message_stop"]))
            return Response(status: 200, headers: ["content-type": "text/event-stream", "cache-control": "no-cache"],
                            chunks: events.map { (Data($0.utf8), delay) })
        }

        public static func event(_ name: String, _ obj: Any) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: obj)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
            return "event: \(name)\ndata: \(data)\n\n"
        }
    }

    public private(set) var port: UInt16 = 0
    public var baseURL: String { "http://127.0.0.1:\(port)" }
    private var listenFD: Int32 = -1
    private let lock = NSLock()
    private var _requests: [Request] = []
    private var handler: @Sendable (Request) -> Response
    private var stopped = false

    public init(handler: @escaping @Sendable (Request) -> Response) throws {
        self.handler = handler
        listenFD = socket(AF_INET, SOCK_STREAM, 0)
        guard listenFD >= 0 else { throw POSIXError(.EIO) }
        var yes: Int32 = 1
        setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0, listen(listenFD, 16) == 0 else { close(listenFD); throw POSIXError(.EADDRINUSE) }
        var out = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &out) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listenFD, $0, &len) } }
        port = UInt16(bigEndian: out.sin_port)
        let fd = listenFD
        Thread.detachNewThread { [weak self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { return }
                guard let self else { close(client); return }
                Thread.detachNewThread { self.serve(client) }
            }
        }
    }

    deinit { stop() }

    public func setHandler(_ h: @escaping @Sendable (Request) -> Response) { lock.lock(); handler = h; lock.unlock() }
    public var requests: [Request] { lock.lock(); defer { lock.unlock() }; return _requests }

    public func stop() {
        lock.lock()
        let wasStopped = stopped
        stopped = true
        lock.unlock()
        if !wasStopped { shutdown(listenFD, SHUT_RDWR); close(listenFD) }
    }

    private func serve(_ fd: Int32) {
        var nosigpipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosigpipe, socklen_t(MemoryLayout<Int32>.size))
        defer { close(fd) }
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        var headerEnd: Range<Data.Index>?
        while headerEnd == nil {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return }
            buffer.append(contentsOf: chunk[0..<n])
            headerEnd = buffer.range(of: Data("\r\n\r\n".utf8))
        }
        guard let he = headerEnd else { return }
        let head = String(decoding: buffer[buffer.startIndex..<he.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        var headers: [String: String] = [:]
        for l in lines {
            guard let c = l.firstIndex(of: ":") else { continue }
            headers[l[..<c].lowercased()] = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
        }
        var body = Data(buffer[he.upperBound...])
        let length = Int(headers["content-length"] ?? "0") ?? 0
        while body.count < length {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            body.append(contentsOf: chunk[0..<n])
        }
        let req = Request(method: requestLine.first.map(String.init) ?? "", path: requestLine.count > 1 ? String(requestLine[1]) : "/", headers: headers, body: body)
        lock.lock()
        _requests.append(req)
        let h = handler
        lock.unlock()
        let resp = h(req)
        let streaming = resp.chunks.count > 1
        var headText = "HTTP/1.1 \(resp.status) \(resp.status == 200 ? "OK" : "Status")\r\nconnection: close\r\n"
        for (k, v) in resp.headers { headText += "\(k): \(v)\r\n" }
        if !streaming { headText += "content-length: \(resp.chunks.first?.data.count ?? 0)\r\n" }
        headText += "\r\n"
        guard write(fd, Data(headText.utf8)) else { return }
        for c in resp.chunks {
            if c.delay > 0 { Thread.sleep(forTimeInterval: c.delay) }
            guard write(fd, c.data) else { return } // client went away (cancelled)
        }
    }

    private func write(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            guard var p = raw.baseAddress else { return true }
            var left = raw.count
            while left > 0 {
                let n = Darwin.write(fd, p, left)
                if n <= 0 { return false }
                left -= n
                p = p.advanced(by: n)
            }
            return true
        }
    }
}
