// A tiny stdio MCP server written for N5's tests (never a third-party server). Newline-delimited JSON-RPC 2.0.
// Tools: echo (read-only), add_note (state-changing, destructive), slow (sleeps `ms`), fail (isError result),
// big (long text), picture (image content), and after --list-changed's first call: extra (new tool).
// Flags: --pid-file <path> (writes its pid), --crash-after <n> (exits after n tools/call), --list-changed,
//        --stderr <text> (prints to stderr at start), --exit-now <code>, --bad-version.
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
func arg(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }

if let t = arg("--stderr") { FileHandle.standardError.write(Data((t + "\n").utf8)) }
if let c = arg("--exit-now").flatMap(Int32.init) { exit(c) }
if let p = arg("--pid-file") { try? String(getpid()).write(toFile: p, atomically: true, encoding: .utf8) }
let crashAfter = arg("--crash-after").flatMap(Int.init)
let listChanged = args.contains("--list-changed")
let badVersion = args.contains("--bad-version")
var calls = 0
var extra = false
var notes: [String] = []

@MainActor func send(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(d)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

@MainActor func tools() -> [[String: Any]] {
    var list: [[String: Any]] = [
        ["name": "echo", "title": "Echo", "description": "Echo the text back", "inputSchema": ["type": "object", "properties": ["text": ["type": "string"]], "required": ["text"]],
         "annotations": ["readOnlyHint": true]],
        ["name": "add_note", "description": "Add a note to the fixture's memory", "inputSchema": ["$schema": "http://json-schema.org/draft-07/schema#", "type": "object",
                                                                                                 "properties": ["text": ["type": "string"]], "required": ["text"]],
         "annotations": ["readOnlyHint": false, "destructiveHint": true]],
        ["name": "slow", "description": "Sleep ms milliseconds", "inputSchema": ["type": "object", "properties": ["ms": ["type": "integer"]]], "annotations": ["readOnlyHint": true]],
        ["name": "fail", "description": "Always returns an error result", "inputSchema": ["type": "object", "properties": [:]], "annotations": ["readOnlyHint": true]],
        ["name": "big", "description": "Returns a lot of text", "inputSchema": ["type": "object", "properties": [:]], "annotations": ["readOnlyHint": true]],
        ["name": "picture", "description": "Returns an image", "inputSchema": ["type": "object", "anyOf": [["properties": ["a": ["type": "string"]]], ["properties": ["b": ["type": "number"]]]]],
         "annotations": ["readOnlyHint": true]],
        ["name": "list notes!", "description": "Name with a space and punctuation", "inputSchema": ["type": "object"], "annotations": ["readOnlyHint": true, "openWorldHint": true]],
    ]
    if extra { list.append(["name": "extra", "description": "Appeared after list_changed", "inputSchema": ["type": "object"], "annotations": ["readOnlyHint": true]]) }
    return list
}

@MainActor func text(_ s: String, error: Bool = false) -> [String: Any] {
    var r: [String: Any] = ["content": [["type": "text", "text": s]]]
    if error { r["isError"] = true }
    return r
}

@MainActor func handle(_ m: [String: Any]) {
    let method = m["method"] as? String ?? ""
    guard let id = m["id"] else { return } // notifications: ignore
    let params = m["params"] as? [String: Any] ?? [:]
    switch method {
    case "initialize":
        send(["jsonrpc": "2.0", "id": id, "result": ["protocolVersion": badVersion ? "1999-01-01" : (params["protocolVersion"] as? String ?? "2025-06-18"),
                                                     "capabilities": ["tools": ["listChanged": true]], "serverInfo": ["name": "fixture", "version": "0.1.0"]]])
    case "ping": send(["jsonrpc": "2.0", "id": id, "result": [:]])
    case "tools/list": send(["jsonrpc": "2.0", "id": id, "result": ["tools": tools()]])
    case "tools/call":
        calls += 1
        let name = params["name"] as? String ?? ""
        let a = params["arguments"] as? [String: Any] ?? [:]
        var result: [String: Any]
        switch name {
        case "echo": result = text("echo: \(a["text"] as? String ?? "")")
        case "add_note":
            notes.append(a["text"] as? String ?? "")
            result = text("noted (\(notes.count) total)")
        case "slow":
            usleep(UInt32(max(0, a["ms"] as? Int ?? 100)) * 1000)
            result = text("slept")
        case "fail": result = text("fixture failure", error: true)
        case "big": result = text(String(repeating: "x", count: 12_000))
        case "picture": result = ["content": [["type": "image", "mimeType": "image/png", "data": String(repeating: "A", count: 4096)], ["type": "text", "text": "a picture"]]]
        case "list notes!": result = ["content": [], "structuredContent": ["notes": notes]]
        case "extra": result = text("extra tool")
        default:
            send(["jsonrpc": "2.0", "id": id, "error": ["code": -32602, "message": "Unknown tool \(name)"]])
            return
        }
        send(["jsonrpc": "2.0", "id": id, "result": result])
        if listChanged && !extra {
            extra = true
            send(["jsonrpc": "2.0", "method": "notifications/tools/list_changed"])
        }
        if let c = crashAfter, calls >= c { exit(7) }
    default:
        send(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found"]])
    }
}

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty, let d = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) else { continue }
    if let m = obj as? [String: Any] { handle(m) } else if let list = obj as? [[String: Any]] { list.forEach(handle) }
}
