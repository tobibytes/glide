import Foundation
import GlideCore

/// Model Context Protocol over JSON-RPC 2.0, implemented natively (no SDK). Shared by the agent's MCP client
/// (this folder) and Glide's MCP server (../MCPServer).
enum MCP {
    static let latestProtocolVersion = "2025-11-25"
    static let supportedProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

    // JSON-RPC error codes
    static let parseError = -32700
    static let invalidRequest = -32600
    static let methodNotFound = -32601
    static let invalidParams = -32602
    static let internalError = -32603
    static let connectionClosed = -32000
    static let requestTimeout = -32001
    /// MCP: resources/read for a URI the server doesn't have.
    static let resourceNotFound = -32002

    static func request(id: JSONValue, method: String, params: JSONValue? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["jsonrpc": "2.0", "id": id, "method": .string(method)]
        if let params { o["params"] = params }
        return .object(o)
    }

    static func notification(_ method: String, params: JSONValue? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["jsonrpc": "2.0", "method": .string(method)]
        if let params { o["params"] = params }
        return .object(o)
    }

    static func result(id: JSONValue, _ result: JSONValue) -> JSONValue { ["jsonrpc": "2.0", "id": id, "result": result] }

    static func error(id: JSONValue, code: Int, message: String, data: JSONValue? = nil) -> JSONValue {
        var e: [String: JSONValue] = ["code": .int(Int64(code)), "message": .string(message)]
        if let data { e["data"] = data }
        return ["jsonrpc": "2.0", "id": id, "error": .object(e)]
    }

    enum Kind { case request, notification, response, invalid }

    static func kind(_ m: JSONValue) -> Kind {
        guard case let .object(o) = m else { return .invalid }
        let hasId = o["id"] != nil && o["id"] != .null
        if o["method"]?.stringValue != nil { return hasId ? .request : .notification }
        if hasId && (o["result"] != nil || o["error"] != nil) { return .response }
        // An error response to an unparseable request carries id null.
        if o["error"] != nil { return .response }
        return .invalid
    }

    /// Key for correlating ids (numbers and strings both allowed).
    static func idKey(_ id: JSONValue?) -> String {
        switch id {
        case let .int(i)?: return "n:\(i)"
        case let .double(d)? where d == d.rounded(): return "n:\(Int64(d))"
        case let .string(s)?: return "s:\(s)"
        default: return "x:\(id?.description ?? "null")"
        }
    }

    static func encode(_ m: JSONValue) -> Data { (try? JSONEncoder.glideCompact.encode(m)) ?? Data("{}".utf8) }

    static func decode(_ d: Data) -> JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: d) }
}

struct MCPError: Error, LocalizedError, Equatable {
    var code: Int
    var message: String
    var data: JSONValue?
    init(code: Int, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
    var errorDescription: String? { message }
    static func closed(_ m: String = "Connection closed") -> MCPError { MCPError(code: MCP.connectionClosed, message: m) }
}

/// Incremental Server-Sent Events parser (text/event-stream): feed bytes, get `data` payloads per event.
struct MCPSSEParser {
    private var buffer = Data()
    private var dataLines: [String] = []
    private var event = ""
    var lastEventId: String?

    /// Returns complete events as (event name, data).
    mutating func feed(_ chunk: Data) -> [(event: String, data: String)] {
        buffer.append(chunk)
        var out: [(String, String)] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            var lineData = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            if lineData.last == 0x0D { lineData = lineData.dropLast() }
            let line = String(decoding: lineData, as: UTF8.self)
            if line.isEmpty {
                if !dataLines.isEmpty { out.append((event.isEmpty ? "message" : event, dataLines.joined(separator: "\n"))) }
                dataLines = []
                event = ""
                continue
            }
            if line.hasPrefix(":") { continue }
            let (field, value): (String, String) = {
                guard let c = line.firstIndex(of: ":") else { return (line, "") }
                var v = String(line[line.index(after: c)...])
                if v.hasPrefix(" ") { v.removeFirst() }
                return (String(line[..<c]), v)
            }()
            switch field {
            case "data": dataLines.append(value)
            case "event": event = value
            case "id": lastEventId = value
            default: break
            }
        }
        return out
    }
}

/// Newline-delimited JSON framing for stdio.
struct MCPLineBuffer {
    private var buffer = Data()
    mutating func feed(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var out: [Data] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            var line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            if line.last == 0x0D { line = line.dropLast() }
            if !line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { out.append(Data(line)) }
        }
        return out
    }
}
