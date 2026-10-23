import CryptoKit
import Foundation
import GlideCore

/// Mapping between MCP and the Messages API (mcp-schema.ts): namespaced tool names, input schemas trimmed to
/// what `input_schema` accepts, and tool results flattened into tool_result text.
enum MCPSchema {
    static let prefix = "mcp__"
    static let maxToolName = 64
    static let maxResultChars = 5000
    static let maxSchemaBytes = 32_000
    static let maxSchemaDepth = 12
    static let maxDescription = 1500

    static func clean(_ s: String) -> String {
        var out = ""
        var lastUnderscoreRun = 0
        var pendingBad = false
        for ch in s {
            let ok = ch.isASCII && (ch.isLetter || ch.isNumber || ch == "_" || ch == "-")
            if !ok { pendingBad = true; continue }
            if pendingBad { out.append("_"); pendingBad = false }
            out.append(ch)
        }
        if pendingBad { out.append("_") }
        // Collapse runs of 3+ underscores to "__", trim leading/trailing underscores.
        var collapsed = ""
        for ch in out {
            if ch == "_" { lastUnderscoreRun += 1; if lastUnderscoreRun <= 2 { collapsed.append(ch) } } else { lastUnderscoreRun = 0; collapsed.append(ch) }
        }
        while collapsed.hasPrefix("_") { collapsed.removeFirst() }
        while collapsed.hasSuffix("_") { collapsed.removeLast() }
        return collapsed
    }

    static func hash6(_ s: String) -> String {
        Insecure.SHA1.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined().prefix(6).description
    }

    static func isToolName(_ name: String) -> Bool {
        name.hasPrefix(prefix) && name.count <= 64 && !name.isEmpty && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    /// `mcp__<server>__<tool>`, sanitized, ≤ 64 chars, unique within `taken` (which it updates).
    static func toolName(server: String, tool: String, taken: inout Set<String>) -> String {
        let s = clean(server).isEmpty ? "server" : clean(server)
        let t = clean(tool).isEmpty ? "tool" : clean(tool)
        var name = "\(prefix)\(s)__\(t)"
        if name.count > maxToolName {
            let h = hash6("\(server)\0\(tool)")
            let room = maxToolName - prefix.count - 2 - 1 - h.count
            let sPart = String(s.prefix(min(s.count, max(8, room / 3))))
            let tPart = String(t.prefix(room - sPart.count))
            name = "\(prefix)\(sPart)__\(tPart)_\(h)"
        }
        var candidate = name
        var i = 2
        while taken.contains(candidate) {
            candidate = "\(name.prefix(maxToolName - String(i).count - 1))_\(i)"
            i += 1
        }
        taken.insert(candidate)
        return candidate
    }

    private static func depthTrim(_ v: JSONValue, _ depth: Int) -> JSONValue? {
        switch v {
        case let .double(d): return d.isFinite ? v : nil
        case let .array(a): return depth > maxSchemaDepth ? nil : .array(a.compactMap { depthTrim($0, depth + 1) })
        case let .object(o):
            if depth > maxSchemaDepth { return nil }
            var out: [String: JSONValue] = [:]
            for (k, x) in o { if let j = depthTrim(x, depth + 1) { out[k] = j } }
            return .object(out)
        default: return v
        }
    }

    /// The top level must be `type: "object"` without oneOf/anyOf/allOf (their object branches are merged into
    /// optional properties; allOf keeps required keys), `$schema`/`$id` dropped, oversized → free-form object.
    static func inputSchema(_ schema: JSONValue) -> JSONValue {
        let fallback: JSONValue = ["type": "object", "properties": [:], "additionalProperties": true]
        guard case var .object(rest) = depthTrim(schema, 0) ?? .null else { return fallback }
        let oneOf = rest.removeValue(forKey: "oneOf"), anyOf = rest.removeValue(forKey: "anyOf"), allOf = rest.removeValue(forKey: "allOf")
        rest["$schema"] = nil
        rest["$id"] = nil
        rest["type"] = "object"
        var props = rest["properties"]?.objectValue ?? [:]
        var required: [String] = (rest["required"]?.arrayValue ?? []).compactMap(\.stringValue)
        let branches = [oneOf, anyOf, allOf].flatMap { ($0?.arrayValue ?? []).filter { $0.objectValue != nil } }
        for b in branches { for (k, v) in b["properties"]?.objectValue ?? [:] where props[k] == nil { props[k] = v } }
        for b in allOf?.arrayValue ?? [] { for r in (b["required"]?.arrayValue ?? []).compactMap(\.stringValue) where !required.contains(r) { required.append(r) } }
        rest["properties"] = .object(props)
        let req = required.filter { props[$0] != nil || branches.isEmpty }
        rest["required"] = req.isEmpty ? nil : .array(req.map(JSONValue.string))
        let out = JSONValue.object(rest)
        if MCP.encode(out).count > maxSchemaBytes { return fallback }
        return out
    }

    static func description(server: String, _ d: String?, notes: [String]) -> String {
        let text = (d ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let body = text.isEmpty ? "(no description)" : text.count > maxDescription ? "\(text.prefix(maxDescription))…" : text
        return "[MCP server “\(server)”\(notes.isEmpty ? "" : "; \(notes.joined(separator: ", "))")] \(body)"
    }

    private static func kb(_ base64: JSONValue?) -> Int {
        guard let s = base64?.stringValue else { return 0 }
        return max(1, Int((Double(s.count) * 3 / 4 / 1024).rounded()))
    }

    static func contentText(_ c: JSONValue) -> String {
        switch c["type"]?.stringValue ?? "" {
        case "text": return c["text"]?.stringValue ?? ""
        case "image": return "[image \(c["mimeType"]?.stringValue ?? ""), ~\(kb(c["data"])) KB — returned by the tool but not shown to the model]"
        case "audio": return "[audio \(c["mimeType"]?.stringValue ?? ""), ~\(kb(c["data"])) KB — not shown to the model]"
        case "resource_link":
            let name = c["name"]?.stringValue ?? c["title"]?.stringValue ?? ""
            return "[resource link: \(name) <\(c["uri"]?.stringValue ?? "")>\(c["mimeType"]?.stringValue.map { " (\($0))" } ?? "")\(c["description"]?.stringValue.map { " — \($0)" } ?? "")]"
        case "resource":
            let r = c["resource"] ?? [:]
            if let t = r["text"]?.stringValue { return "[resource <\(r["uri"]?.stringValue ?? "")>]\n\(t)" }
            return "[binary resource <\(r["uri"]?.stringValue ?? "")>\(r["mimeType"]?.stringValue.map { " (\($0))" } ?? ""), ~\(kb(r["blob"])) KB — not shown to the model]"
        case let t: return "[\(t) content not supported]"
        }
    }

    static func truncate(_ text: String, max: Int = maxResultChars) -> String {
        text.count <= max ? text : "\(text.prefix(max))\n[output truncated: \(text.count - max) more characters were not included]"
    }

    /// Flattens a CallToolResult into the text of one tool_result.
    static func resultText(_ result: JSONValue) -> String {
        var parts = (result["content"]?.arrayValue ?? []).filter { $0["type"]?.stringValue != nil }.map(contentText).filter { !$0.isEmpty }
        if parts.isEmpty, let sc = result["structuredContent"] { parts.append(AgentText.json(sc)) }
        if parts.isEmpty, let tr = result["toolResult"] { parts.append(tr.stringValue ?? AgentText.json(tr)) }
        return truncate(parts.isEmpty ? "(the tool returned no content)" : parts.joined(separator: "\n"))
    }

    static func argsSummary(_ args: [String: JSONValue], max: Int = 200) -> String {
        if args.isEmpty { return "no arguments" }
        let s = AgentText.json(.object(args))
        return s.count > max ? "\(s.prefix(max))…}" : s
    }
}
