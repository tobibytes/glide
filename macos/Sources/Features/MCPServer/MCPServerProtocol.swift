import CryptoKit
import Darwin
import Foundation
import GlideCore

/// One MCP protocol session on the server side (mcp.ts): initialize, ping, tools/list, tools/call,
/// resources/list, resources/templates/list, resources/read, notifications. Transport-agnostic.
@MainActor final class MCPServerSession {
    static let instructions = "Glide is the user's macOS launcher. Use search_glide to find apps, commands, workflows and quicklinks, then run_command with an item id. "
        + "State-changing tools ask the user to confirm in Glide and may be turned off; a denied call is final, so do not retry it. Read-only tools answer immediately."

    let id: String
    let handler: MCPCallHandler
    let version: String
    private(set) var clientName = "MCP client"
    private(set) var protocolVersion: String?
    private(set) var initialized = false
    var lastSeen = Date()
    /// Server → client messages (notifications) for transports that can push (SSE stream / stdio).
    var push: ((JSONValue) -> Void)?
    /// tools/call requests still running (idKey), so notifications/cancelled can withdraw their confirmation.
    private var inFlight = Set<String>()

    init(id: String = UUID().uuidString, handler: MCPCallHandler, version: String) {
        self.id = id
        self.handler = handler
        self.version = version
    }

    static func label(_ info: JSONValue?) -> String {
        let raw = info?["title"]?.stringValue ?? info?["name"]?.stringValue ?? ""
        let clean = String(raw.unicodeScalars.filter { $0.value >= 0x20 }.map(Character.init)).prefix(80)
        return clean.isEmpty ? "MCP client" : String(clean)
    }

    /// Handles one incoming message; returns the response (nil for notifications and responses).
    func handle(_ m: JSONValue) async -> JSONValue? {
        lastSeen = Date()
        switch MCP.kind(m) {
        case .notification:
            // The client gave up on a request (timeout / abort): withdraw its confirmation prompt, if any.
            if m["method"]?.stringValue == "notifications/cancelled", let rid = m["params"]?["requestId"] {
                let key = MCP.idKey(rid)
                if inFlight.contains(key) { handler.cancel(requestKey: "\(id)/\(key)") }
            }
            return nil
        case .response: return nil
        case .invalid: return MCP.error(id: m["id"] ?? .null, code: MCP.invalidRequest, message: "Invalid JSON-RPC message")
        case .request: break
        }
        let id = m["id"] ?? .null
        let params = m["params"] ?? [:]
        do {
            return MCP.result(id: id, try await dispatch(m["method"]?.stringValue ?? "", params, requestId: id))
        } catch let e as MCPError {
            return MCP.error(id: id, code: e.code, message: e.message, data: e.data)
        } catch {
            return MCP.error(id: id, code: MCP.internalError, message: error.localizedDescription)
        }
    }

    private func dispatch(_ method: String, _ p: JSONValue, requestId: JSONValue) async throws -> JSONValue {
        switch method {
        case "initialize":
            clientName = Self.label(p["clientInfo"])
            let requested = p["protocolVersion"]?.stringValue ?? MCP.latestProtocolVersion
            let v = MCP.supportedProtocolVersions.contains(requested) ? requested : MCP.latestProtocolVersion
            protocolVersion = v
            initialized = true
            return ["protocolVersion": .string(v),
                    "capabilities": ["tools": ["listChanged": true], "resources": ["listChanged": true]],
                    "serverInfo": ["name": "glide", "title": "Glide", "version": .string(version)],
                    "instructions": .string(Self.instructions)]
        case "ping": return [:]
        case "tools/list": return ["tools": .array(handler.visibleTools(client: clientName).map(\.listEntry))]
        case "tools/call":
            guard let name = p["name"]?.stringValue else { throw MCPError(code: MCP.invalidParams, message: "tools/call needs a name") }
            // Spec (tools → error handling): an unknown tool is a protocol error (-32602); failures of a known tool
            // (bad arguments, denied, turned off) are results with isError so the model can read them.
            guard handler.isKnownTool(name) else {
                handler.recordUnknown(client: clientName, name: name)
                throw MCPError(code: MCP.invalidParams, message: "Unknown tool: \(name)")
            }
            let key = MCP.idKey(requestId)
            inFlight.insert(key)
            defer { inFlight.remove(key) }
            return await handler.call(client: clientName, name: name, args: p["arguments"] ?? [:], requestKey: "\(id)/\(key)")
        case "resources/list": return ["resources": .array(await handler.listResources(client: clientName))]
        case "resources/templates/list": return ["resourceTemplates": .array(handler.resourceTemplates(client: clientName))]
        case "resources/read":
            guard let uri = p["uri"]?.stringValue else { throw MCPError(code: MCP.invalidParams, message: "resources/read needs a uri") }
            return ["contents": [try await handler.readResource(uri: uri, client: clientName)]]
        case "prompts/list": return ["prompts": []]
        default: throw MCPError(code: MCP.methodNotFound, message: "Method not found: \(method)")
        }
    }

    func notifyListChanged() {
        push?(MCP.notification("notifications/tools/list_changed"))
        push?(MCP.notification("notifications/resources/list_changed"))
    }
}

// MARK: - token + discovery (auth.ts): <userData>/features/mcp-server/{token,server.json}, mode 0600

enum MCPServerAuth {
    static let tokenFile = "token"
    static let discoveryFile = "server.json"
    static let path = "/mcp"

    static func writePrivate(_ url: URL, _ content: String) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let tmp = url.deletingLastPathComponent().appendingPathComponent("\(url.lastPathComponent).\(getpid()).tmp")
        guard FileManager.default.createFile(atPath: tmp.path, contents: Data(content.utf8), attributes: [.posixPermissions: 0o600]) else {
            throw MCPConfigError("Couldn't write \(url.lastPathComponent)")
        }
        if rename(tmp.path, url.path) != 0 { try? FileManager.default.removeItem(at: tmp); throw MCPConfigError("Couldn't write \(url.lastPathComponent)") }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    static func valid(_ t: String) -> Bool { t.count >= 32 && t.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") } }

    static func readToken(_ dir: URL) -> String? {
        guard let t = try? String(contentsOf: dir.appendingPathComponent(tokenFile), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), valid(t) else { return nil }
        return t
    }

    static func loadOrCreateToken(_ dir: URL) throws -> String {
        if let t = readToken(dir) {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dir.appendingPathComponent(tokenFile).path)
            return t
        }
        return try regenerateToken(dir)
    }

    /// 256 random bits, base64url.
    static func regenerateToken(_ dir: URL) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, 32, &bytes) == errSecSuccess else { throw MCPConfigError("No randomness") }
        let t = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        try writePrivate(dir.appendingPathComponent(tokenFile), t + "\n")
        return t
    }

    /// Constant-time check of an Authorization header against the token.
    static func authorized(_ header: String?, token: String) -> Bool {
        guard let h = header?.trimmingCharacters(in: .whitespaces), !token.isEmpty else { return false }
        let parts = h.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2, parts[0].lowercased() == "bearer" else { return false }
        let given = parts[1].trimmingCharacters(in: .whitespaces)
        if given.contains(" ") { return false }
        let a = Array(SHA256.hash(data: Data(given.utf8))), b = Array(SHA256.hash(data: Data(token.utf8)))
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    /// Host must name this loopback server; Origin (browsers) must be the same loopback origin (DNS-rebinding guard).
    static func checkHostOrigin(host: String?, origin: String?, port: Int) -> Bool {
        guard let host = host?.lowercased(), ["127.0.0.1:\(port)", "localhost:\(port)"].contains(host) else { return false }
        guard let origin else { return true }
        return origin == "http://127.0.0.1:\(port)" || origin == "http://localhost:\(port)"
    }

    struct Discovery: Equatable {
        var port: Int
        var pid: Int
        var url: String
        var version: String
        var startedAt: Double
        var json: JSONValue { ["port": .int(Int64(port)), "pid": .int(Int64(pid)), "url": .string(url), "version": .string(version), "startedAt": .double(startedAt)] }
    }

    static func writeDiscovery(_ dir: URL, _ d: Discovery) throws {
        let text = (try? String(decoding: JSONEncoder.glide.encode(d.json), as: UTF8.self)) ?? "{}"
        try writePrivate(dir.appendingPathComponent(discoveryFile), text + "\n")
    }

    static func readDiscovery(_ dir: URL) -> Discovery? {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent(discoveryFile)), let v = MCP.decode(d),
              let port = v["port"]?.intValue, let url = v["url"]?.stringValue else { return nil }
        return Discovery(port: port, pid: v["pid"]?.intValue ?? 0, url: url, version: v["version"]?.stringValue ?? "", startedAt: v["startedAt"]?.doubleValue ?? 0)
    }

    /// Remove server.json, but only if it still describes this process.
    static func removeDiscovery(_ dir: URL, pid: Int) {
        if let d = readDiscovery(dir), d.pid != pid { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(discoveryFile))
    }

    /// Where the stdio bridge looks (mirrors userData + features/mcp-server).
    static func defaultServerDir(environment env: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let d = env["GLIDE_MCP_DIR"], !d.isEmpty { return URL(fileURLWithPath: (d as NSString).expandingTildeInPath) }
        return GlidePaths.featureDirectory("mcp-server", root: GlidePaths.userDataDirectory(environment: env))
    }
}

// MARK: - client config snippets (snippets.ts)

enum MCPServerSnippets {
    static func shq(_ s: String) -> String {
        let safe = s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "@%+=:,./-_".contains($0)) }
        return safe && !s.isEmpty ? s : "'\(s.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    static func jsonString(_ s: String) -> String { AgentText.json(.string(s)) }

    /// id, title, hint, text, secret
    static func build(command: String, args: [String], url: String?, token: String, name: String = "glide") -> [JSONValue] {
        let stdioJSON = (try? String(decoding: JSONEncoder.glide.encode(JSONValue.object(["mcpServers": .object([name: ["command": .string(command), "args": .array(args.map(JSONValue.string))]])])), as: UTF8.self)) ?? ""
        var out: [JSONValue] = [
            ["id": "claude-code", "title": "Claude Code", "hint": "Run in a terminal. Uses the stdio bridge, so it keeps working when Glide picks a new port.",
             "text": .string("claude mcp add --scope user \(name) -- \(([command] + args).map(shq).joined(separator: " "))")],
            ["id": "claude-desktop", "title": "Claude Desktop", "hint": "Merge into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop.", "text": .string(stdioJSON)],
            ["id": "goose", "title": "Goose", "hint": "Add to ~/.config/goose/config.yaml (or goose configure → Add Extension → Command-line Extension).",
             "text": .string(["extensions:", "  \(name):", "    name: \(name)", "    type: stdio", "    enabled: true", "    cmd: \(jsonString(command))",
                              "    args: [\(args.map(jsonString).joined(separator: ", "))]", "    timeout: 300"].joined(separator: "\n"))],
            ["id": "cursor", "title": "Cursor", "hint": "Merge into ~/.cursor/mcp.json.", "text": .string(stdioJSON)],
        ]
        if let url {
            out.append(["id": "claude-code-http", "title": "Claude Code (direct HTTP)", "hint": "No bridge process, but contains the token and the current port; re-add it if the port changes.",
                        "text": .string("claude mcp add --scope user --transport http \(name) \(url) --header \(shq("Authorization: Bearer \(token)"))"), "secret": true])
        }
        return out
    }
}
