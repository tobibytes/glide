import Foundation
import GlideCore

/// Sliding one-minute window per server (mcp-tools.ts ServerRateLimit).
final class MCPServerRateLimit {
    private var hits: [String: [Double]] = [:]
    let now: () -> Double
    init(now: @escaping () -> Double = agentNowMs) { self.now = now }

    func take(_ serverId: String, perMinute: Int) -> String? {
        if perMinute <= 0 { return nil }
        let t = now()
        var list = (hits[serverId] ?? []).filter { t - $0 < 60_000 }
        if list.count >= perMinute, let first = list.first {
            hits[serverId] = list
            return "Rate limited: at most \(perMinute) calls per minute to this MCP server. Try again in \(Int(((60_000 - (t - first)) / 1000).rounded(.up))) s."
        }
        list.append(t)
        hits[serverId] = list
        return nil
    }
}

@MainActor protocol MCPToolCaller: AnyObject {
    func callTool(_ name: String, arguments: [String: JSONValue]) async throws -> JSONValue
}

extension MCPConnection: MCPToolCaller {}

enum MCPAgentTools {
    static func title(_ t: MCPToolDef) -> String { String((t.title ?? t.annotationTitle ?? t.name).prefix(80)) }

    /// The settings view of a server's tools.
    static func views(_ c: MCPServerConfig, _ tools: [MCPToolDef], taken: inout Set<String>) -> [JSONValue] {
        tools.map { t in
            let ro = t.readOnlyHint == true
            return ["name": .string(t.name), "agentName": .string(MCPSchema.toolName(server: c.name, tool: t.name, taken: &taken)),
                    "title": .string(title(t)), "description": .string(String((t.description ?? "").prefix(400))), "readOnly": .bool(ro),
                    "destructive": .bool(!ro && t.destructiveHint != false), "enabled": .bool(!c.disabledTools.contains(t.name))]
        }
    }

    /// MCP tools → agent tools. readOnlyHint tools are not state-changing (offered in Read-only mode) and run
    /// directly only when the user trusts the server ("Run read-only tools without asking"); every other tool
    /// goes through the confirmation step unless allow-listed.
    @MainActor static func build(_ config: MCPServerConfig, _ tools: [MCPToolDef], caller: any MCPToolCaller, limiter: MCPServerRateLimit, taken: inout Set<String>) -> [AgentTool] {
        var out: [AgentTool] = []
        for t in tools {
            let agentName = MCPSchema.toolName(server: config.name, tool: t.name, taken: &taken)
            if config.disabledTools.contains(t.name) { continue }
            let readOnly = t.readOnlyHint == true
            // MCP's default destructiveHint (when not read-only) is true.
            let destructive = !readOnly && t.destructiveHint != false
            let schema = MCPSchema.inputSchema(t.inputSchema)
            let required = (schema["required"]?.arrayValue ?? []).compactMap(\.stringValue)
            let notes = [readOnly ? "read-only" : destructive ? "may change or delete data" : "changes data", t.openWorldHint == true ? "reaches outside services" : ""].filter { !$0.isEmpty }
            let serverName = config.name, serverId = config.id, perMinute = config.rateLimitPerMinute, toolName = t.name
            var tool = AgentTool(name: agentName, title: "\(serverName) › \(title(t))", description: MCPSchema.description(server: serverName, t.description, notes: notes),
                                 mutating: !readOnly, schema: schema) { input, _ in
                guard case let .object(args) = input else { return .invalid("Tool input must be a JSON object") }
                let missing = required.filter { args[$0] == nil }
                if !missing.isEmpty { return .invalid("missing required \(missing.map { "\"\($0)\"" }.joined(separator: ", "))") }
                return .ready(AgentPreparedCall(
                    describe: { "Run \(toolName) on \(serverName) with \(MCPSchema.argsSummary(args))\(destructive ? " — the server says this may change or delete data" : "")" },
                    run: {
                        if let limited = limiter.take(serverId, perMinute: perMinute) { throw AgentToolFailure(limited) }
                        let res: JSONValue
                        do { res = try await caller.callTool(toolName, arguments: args) } catch {
                            throw AgentToolFailure("MCP \(serverName): \((error as? MCPError)?.message ?? error.localizedDescription)")
                        }
                        let text = MCPSchema.resultText(res)
                        if res["isError"]?.boolValue == true { throw AgentToolFailure(text) }
                        return AgentToolOutput(text: text)
                    }))
            }
            if readOnly && !config.autoRunReadOnly { tool.askFirst = true }
            out.append(tool)
        }
        return out
    }
}

/// Glide Agent's MCP client (mcp-manager.ts): owns the configured servers and their connections. Connections
/// open lazily, stay up while Glide runs, reconnect with backoff, and are closed on disable, removal, edit and quit.
@MainActor final class MCPManager {
    let store: MCPConfigStore
    private var conns: [String: MCPConnection] = [:]
    let limiter = MCPServerRateLimit()
    var factory: MCPTransportFactory = MCPTransportFactories.live
    var onChange: () -> Void = {}
    var log: (String) -> Void = { _ in }
    var connectTimeout = MCPConnection.connectTimeout
    var backoffBase: Double = 1

    init(store: MCPConfigStore) { self.store = store }

    private func conn(_ c: MCPServerConfig) -> MCPConnection {
        if let x = conns[c.id] { x.config = c; return x }
        let x = MCPConnection(config: c, factory: factory)
        x.onChange = { [weak self] in self?.onChange() }
        x.log = log
        x.connectTimeout = connectTimeout
        x.backoffBase = backoffBase
        conns[c.id] = x
        return x
    }

    func connection(_ id: String) -> MCPConnection? { conns[id] }

    func list() -> [JSONValue] {
        var taken = Set<String>()
        return store.list().map { s in
            guard var o = s.masked.json.objectValue else { return .null }
            let c = conns[s.id]
            o["state"] = .string(c?.state ?? "idle")
            if let e = c?.error { o["error"] = .string(e) }
            if let i = c?.serverInfo { o["serverInfo"] = ["name": .string(i.name), "version": .string(i.version)] }
            o["tools"] = .array(c.map { MCPAgentTools.views(s, $0.tools, taken: &taken) } ?? [])
            if let pid = c?.pid { o["pid"] = .int(Int64(pid)) }
            return .object(o)
        }
    }

    /// Tools for one agent run: connects every enabled server in parallel, skipping the ones that fail.
    func agentTools() async -> (tools: [AgentTool], problems: [String]) {
        let servers = store.list().filter(\.enabled)
        var problems: [String] = []
        let pending = servers.map { s in
            let c = conn(s)
            return Task { @MainActor () -> String? in
                do { try await c.ensure(); return nil } catch {
                        return "MCP server “\(s.name)” is unavailable, so its tools can't be used: \(error.localizedDescription.split(separator: "\n").first.map(String.init) ?? "")"
                }
            }
        }
        for t in pending { if let p = await t.value { problems.append(p) } }
        var taken = Set<String>()
        var tools: [AgentTool] = []
        for s in servers {
            guard let c = conns[s.id], c.state == "ready" else { continue }
            tools += MCPAgentTools.build(s, c.tools, caller: c, limiter: limiter, taken: &taken)
        }
        return (tools, problems.sorted())
    }

    /// "Test connection": a saved server by id (keeps the connection), or an unsaved draft (temporary).
    func test(_ input: JSONValue) async -> JSONValue {
        let started = Date()
        func ms() -> JSONValue { .int(Int64(Date().timeIntervalSince(started) * 1000)) }
        var config: MCPServerConfig
        var temporary = false
        if let id = input.stringValue {
            guard let saved = store.get(id) else { return ["ok": false, "error": "Unknown server", "tools": [], "ms": 0] }
            config = saved
        } else {
            switch MCPServerConfig.normalize(input) {
            case let .failure(e): return ["ok": false, "error": .string(e.message), "tools": [], "ms": 0]
            case let .success(c): config = c.restoringSecrets(from: store.get(c.id))
            }
            temporary = true
        }
        let c: MCPConnection
        if temporary {
            c = MCPConnection(config: config, factory: factory)
            c.connectTimeout = connectTimeout
        } else { c = conn(config) }
        defer { onChange() }
        do {
            if !temporary, c.state == "error" { await c.close() }
            try await c.ensure()
            var taken = Set<String>()
            var r: JSONValue = ["ok": true, "tools": .array(MCPAgentTools.views(config, c.tools, taken: &taken)), "ms": ms()]
            if case var .object(o) = r, let i = c.serverInfo { o["serverInfo"] = ["name": .string(i.name), "version": .string(i.version)]; r = .object(o) }
            if temporary { await c.close() }
            return r
        } catch {
            if temporary { await c.close() }
            return ["ok": false, "error": .string(error.localizedDescription), "tools": [], "ms": ms()]
        }
    }

    func save(_ input: JSONValue) async -> JSONValue {
        let raw = input.objectValue ?? [:]
        let isNew = raw["id"]?.stringValue.flatMap { store.get($0) } == nil
        var draft = raw
        if isNew { draft["id"] = nil }
        let n: MCPServerConfig
        switch MCPServerConfig.normalize(.object(draft)) {
        case let .failure(e): return ["ok": false, "error": .string(e.message)]
        case let .success(c): n = c
        }
        let prev = isNew ? nil : store.get(n.id)
        let saved: MCPServerConfig
        do { saved = try store.upsert(n.restoringSecrets(from: prev), isNew: isNew) } catch { return ["ok": false, "error": .string(error.localizedDescription)] }
        if let c = conns[saved.id] {
            if !saved.enabled || prev == nil || prev?.connectionKey != saved.connectionKey {
                await c.close()
                conns[saved.id] = nil
            } else { c.config = saved }
        }
        onChange()
        return ["ok": true, "server": list().first { $0["id"]?.stringValue == saved.id } ?? .null]
    }

    func setEnabled(_ id: String, _ enabled: Bool) async -> JSONValue {
        guard let s = store.get(id), case var .object(o) = s.json else { return ["ok": false, "error": "Unknown server"] }
        o["enabled"] = .bool(enabled)
        return await save(.object(o))
    }

    func remove(_ id: String) async -> Bool {
        if let c = conns[id] {
            await c.close()
            conns[id] = nil
        }
        let ok = (try? store.remove(id)) ?? false
        onChange()
        return ok
    }

    func reconnect(_ id: String) async -> JSONValue {
        if let c = conns[id] { await c.close() }
        return await test(.string(id))
    }

    /// Parse (preview) or apply an import of a Claude Desktop / .mcp.json config.
    func importConfig(_ text: String, apply: Bool) -> JSONValue {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return ["ok": false, "error": "Paste a config or choose a file", "servers": []] }
        if text.utf8.count > 1_000_000 { return ["ok": false, "error": "That file is too large", "servers": []] }
        let parsed: MCPImport.Parsed
        switch MCPImport.parse(text) {
        case let .failure(e): return ["ok": false, "error": .string(e.message), "servers": []]
        case let .success(p): parsed = p
        }
        if !apply { return MCPImport.preview(parsed, existing: store.list()) }
        var imported = 0
        var errors = parsed.errors
        for s in parsed.servers {
            if store.list().contains(where: { $0.name.lowercased() == s.name.lowercased() }) {
                errors.append("“\(s.name)” already exists — skipped")
                continue
            }
            do { try store.upsert(s, isNew: true); imported += 1 } catch { errors.append(error.localizedDescription) }
        }
        onChange()
        guard case var .object(o) = MCPImport.preview(parsed, existing: store.list()) else { return .null }
        o["imported"] = .int(Int64(imported))
        o["error"] = errors.isEmpty ? nil : .string(errors.joined(separator: "\n"))
        return .object(o)
    }

    func closeAll() async {
        for c in conns.values { await c.close() }
        conns.removeAll()
    }

    /// App quit: signal every stdio child now.
    func killAll() {
        for c in conns.values { c.killNow() }
    }
}
