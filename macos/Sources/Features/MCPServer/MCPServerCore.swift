import Foundation
import GlideCore

// Glide as an MCP server: the tool catalogue, permission policy, confirmations, rate limits, request log,
// resources and the call pipeline (src/main/features/mcp-server/{tools,policy,calls,confirm,ratelimit,requestlog,resources}.ts).

struct MCPServerToolDef {
    var name: String
    var title: String
    var description: String
    /// Never changes anything (readOnlyHint).
    var readOnly: Bool
    /// May delete or irreversibly change data or run arbitrary commands (destructiveHint).
    var destructive: Bool
    /// Returns clipboard contents: off by default.
    var sensitive = false
    /// Feature id this tool needs; hidden when it isn't installed.
    var requires: String?
    var inputSchema: JSONValue
    /// Agent tool that implements this one.
    var agentTool: String?
    /// Arguments merged under the client's (create_note does not pop the note window open).
    var defaults: [String: JSONValue] = [:]

    /// tools/list entry (annotations per the 2025-06 spec).
    var listEntry: JSONValue {
        ["name": .string(name), "title": .string(title), "description": .string(description), "inputSchema": inputSchema,
         "annotations": ["title": .string(title), "readOnlyHint": .bool(readOnly), "destructiveHint": .bool(readOnly ? false : destructive),
                         "idempotentHint": .bool(readOnly), "openWorldHint": false]]
    }
}

@MainActor enum MCPServerTools {
    static func wrap(_ name: String, _ title: String, agent: String, readOnly: Bool, destructive: Bool, sensitive: Bool = false,
                     defaults: [String: JSONValue] = [:], _ description: String) -> MCPServerToolDef {
        let t = AgentTools.all().first { $0.name == agent }
        return MCPServerToolDef(name: name, title: title, description: description, readOnly: readOnly, destructive: destructive, sensitive: sensitive,
                                requires: t?.requires, inputSchema: t?.schema ?? agentSchema(), agentTool: agent, defaults: defaults)
    }

    static let none = agentSchema()

    /// The 24 tools (docs/MCP.md + delete_reminder), in catalogue order.
    static func all() -> [MCPServerToolDef] {
        [
            wrap("search_glide", "Search Glide", agent: "search_catalogue", readOnly: true, destructive: false,
                 "Search everything the Glide launcher can run on this Mac: apps, built-in commands (timers, window management, notes, system commands), workflows, quicklinks and snippets. Returns item ids for run_command. Use short keyword queries such as \"timer\", \"safari\" or \"lock screen\"."),
            wrap("run_command", "Run Glide Command", agent: "execute_item", readOnly: false, destructive: true,
                 "Run one Glide launcher item by the id returned from search_glide, exactly as if the user chose it (opens an app, runs a command, workflow or quicklink). Pass argument only for items with acceptsArgument. The user confirms every call in Glide."),
            wrap("list_workflows", "List Workflows", agent: "list_workflows", readOnly: true, destructive: false, "List the user's Glide workflows (Shortcuts-style automations) with their ids."),
            wrap("run_workflow", "Run Workflow", agent: "run_workflow", readOnly: false, destructive: true, "Run one of the user's Glide workflows by id (from list_workflows), optionally with input text. Returns the workflow's result."),
            wrap("window_action", "Move Window", agent: "window_action", readOnly: false, destructive: false, "Resize or move the front window of an app (left half, maximize, center, next display…). Give app to bring that app to the front first."),
            wrap("list_layouts", "List Window Layouts", agent: "list_layouts", readOnly: true, destructive: false, "List the user's saved Glide window layouts with their ids."),
            wrap("restore_layout", "Restore Window Layout", agent: "restore_layout", readOnly: false, destructive: false, "Restore a saved window layout by id (from list_layouts): opens its apps and moves their windows back."),
            wrap("save_layout", "Save Window Layout", agent: "save_layout", readOnly: false, destructive: false, "Save the current position of every window as a named Glide window layout."),
            MCPServerToolDef(name: "list_timers", title: "List Timers", description: "List Glide's running and paused countdown timers and stopwatches with their ids and remaining time.",
                             readOnly: true, destructive: false, requires: "timers", inputSchema: none),
            wrap("start_timer", "Start Timer", agent: "start_timer", readOnly: false, destructive: false, "Start a Glide countdown timer (shown in the menu bar, notifies when done). Give minutes and/or seconds and an optional name."),
            MCPServerToolDef(name: "stop_timer", title: "Stop Timer", description: "Cancel a running Glide timer by id (from list_timers).", readOnly: false, destructive: true, requires: "timers",
                             inputSchema: agentSchema(["id": agentProp("string", "Timer id from list_timers")], required: ["id"])),
            wrap("clipboard_history_search", "Search Clipboard History", agent: "clipboard_history_search", readOnly: true, destructive: false, sensitive: true,
                 "Search the user's Glide clipboard history (text previews of recently copied items). Off unless the user allows it."),
            wrap("create_note", "Create Note", agent: "create_note", readOnly: false, destructive: false, defaults: ["open": false],
                 "Create a Glide floating note (Markdown). The first line becomes its title. Set open to true to show it on screen."),
            wrap("search_notes", "Search Notes", agent: "search_notes", readOnly: true, destructive: false, "Search the user's Glide floating notes by text. Returns note ids; read a note with the glide://notes/<id> resource."),
            wrap("convert", "Convert", agent: "convert", readOnly: true, destructive: false, "Convert units, currencies, time zones and dates, or evaluate math, with Glide's converter, e.g. \"5 km in miles\", \"100 usd to eur\", \"3pm london in tokyo\"."),
            wrap("transform_text", "Transform Text", agent: "transform_text", readOnly: true, destructive: false, "Apply one of Glide's text transforms (case changes, slugify, base64, URL encode, JSON format, sort lines…) to text and return the result."),
            MCPServerToolDef(name: "list_reminders", title: "List Reminders", description: "List the user's Apple Reminders (title, due date, list, completed) through Glide. Needs Reminders access granted to Glide.",
                             readOnly: true, destructive: false, requires: "reminders",
                             inputSchema: agentSchema(["query": agentProp("string", "Only reminders whose title contains this text"), "limit": agentProp("integer", "1-100, default 30")])),
            wrap("create_reminder", "Create Reminder", agent: "create_reminder", readOnly: false, destructive: false, "Create an Apple Reminder through Glide with an optional due date (ISO 8601) and notes."),
            wrap("delete_reminder", "Delete Reminder", agent: "delete_reminder", readOnly: false, destructive: true,
                 "Permanently delete one of the user's Apple Reminders by id (from list_reminders) or exact title. Off unless the user enables it; the user confirms every call in Glide."),
            wrap("list_automations", "List Automations", agent: "list_automations", readOnly: true, destructive: false, "List the user's Glide automations (trigger → action rules) with their ids."),
            wrap("run_automation", "Run Automation", agent: "run_automation", readOnly: false, destructive: true, "Run one of the user's Glide automations now by id (from list_automations), ignoring its trigger."),
            MCPServerToolDef(name: "capture_text_from_image", title: "Text from Image File",
                             description: "Recognize the text in an image file on this Mac with Glide's on-device OCR (Apple Vision). Files only: it never captures the screen.",
                             readOnly: true, destructive: false, requires: nil,
                             inputSchema: agentSchema(["path": agentProp("string", "Absolute path (or ~/path) of a PNG, JPEG, HEIC, TIFF, GIF, BMP or WebP image")], required: ["path"])),
            wrap("system_status", "System Status", agent: "system_status", readOnly: true, destructive: false, "Current CPU, memory, disk, battery, network and uptime of this Mac, from Glide's system monitor."),
            wrap("search_bookmarks", "Search Bookmarks", agent: "search_bookmarks", readOnly: true, destructive: false, "Search the user's browser bookmarks (Safari, Chrome, Arc, Firefox…) indexed by Glide. Read-only."),
        ]
    }
}

// MARK: - policy

enum MCPToolPolicy: String { case off, ask, allow }

struct MCPServerSettings: Equatable {
    static let defaultPort = 47811
    var enabled = false
    /// Preferred 127.0.0.1 port; 0 = any free port. Falls back to a free port when taken.
    var port = MCPServerSettings.defaultPort
    var tools: [String: String] = [:]
    /// "Always allow" grants from the confirmation prompt: client name → tool names.
    var always: [String: [String]] = [:]
    var confirmTimeoutSec = 60
    var rateLimitPerMin = 120
    var mutatingPerMin = 20

    static let defaultsBag: [String: JSONValue] = ["enabled": false, "port": .int(Int64(defaultPort)), "tools": [:], "always": [:],
                                                   "confirmTimeoutSec": 60, "rateLimitPerMin": 120, "mutatingPerMin": 20]

    init() {}
    init(bag b: [String: JSONValue]) {
        enabled = b["enabled"]?.boolValue == true
        port = b["port"]?.intValue ?? Self.defaultPort
        tools = (b["tools"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
        always = (b["always"]?.objectValue ?? [:]).mapValues { ($0.arrayValue ?? []).compactMap(\.stringValue) }
        confirmTimeoutSec = b["confirmTimeoutSec"]?.intValue ?? 60
        rateLimitPerMin = b["rateLimitPerMin"]?.intValue ?? 120
        mutatingPerMin = b["mutatingPerMin"]?.intValue ?? 20
    }

    var json: JSONValue {
        ["enabled": .bool(enabled), "port": .int(Int64(port)), "tools": .object(tools.mapValues(JSONValue.string)),
         "always": .object(always.mapValues { .array($0.map(JSONValue.string)) }), "confirmTimeoutSec": .int(Int64(confirmTimeoutSec)),
         "rateLimitPerMin": .int(Int64(rateLimitPerMin)), "mutatingPerMin": .int(Int64(mutatingPerMin))]
    }
}

enum MCPPolicy {
    static func defaultPolicy(_ t: MCPServerToolDef) -> MCPToolPolicy { t.readOnly && !t.sensitive ? .allow : .off }

    /// A state-changing tool is never silently "allow"ed from settings: it asks unless the user granted Always per client.
    static func policy(_ t: MCPServerToolDef, _ s: MCPServerSettings) -> MCPToolPolicy {
        guard let raw = s.tools[t.name], let p = MCPToolPolicy(rawValue: raw) else { return defaultPolicy(t) }
        if p == .allow && !t.readOnly { return .ask }
        return p
    }

    enum Gate: Equatable { case deny(String), run, confirm }

    static func gate(_ t: MCPServerToolDef, _ s: MCPServerSettings, client: String) -> Gate {
        switch policy(t, s) {
        case .off: return .deny("The Glide tool \(t.name) is turned off. The user can enable it in Glide Settings → MCP Server.")
        case .allow: return .run
        case .ask: return (s.always[client] ?? []).contains(t.name) ? .run : .confirm
        }
    }

    /// Sanitise a settings patch from the UI / test channel.
    static func cleanPatch(_ patch: JSONValue, knownTools: Set<String>) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        if let b = patch["enabled"]?.boolValue { out["enabled"] = .bool(b) }
        if let p = patch["port"]?.intValue, p == 0 || (1024...65535).contains(p) { out["port"] = .int(Int64(p)) }
        if let v = patch["confirmTimeoutSec"]?.intValue, (5...600).contains(v) { out["confirmTimeoutSec"] = .int(Int64(v)) }
        if let v = patch["rateLimitPerMin"]?.intValue, (1...10_000).contains(v) { out["rateLimitPerMin"] = .int(Int64(v)) }
        if let v = patch["mutatingPerMin"]?.intValue, (1...1000).contains(v) { out["mutatingPerMin"] = .int(Int64(v)) }
        if let tools = patch["tools"]?.objectValue {
            var t: [String: JSONValue] = [:]
            for (k, v) in tools where knownTools.contains(k) { if let s = v.stringValue, MCPToolPolicy(rawValue: s) != nil { t[k] = .string(s) } }
            out["tools"] = .object(t)
        }
        if let always = patch["always"]?.objectValue {
            var a: [String: JSONValue] = [:]
            for (k, v) in always {
                var seen = Set<String>()
                let names = (v.arrayValue ?? []).compactMap(\.stringValue).filter { knownTools.contains($0) && seen.insert($0).inserted }
                if !names.isEmpty { a[String(k.prefix(200))] = .array(names.map(JSONValue.string)) }
            }
            out["always"] = .object(a)
        }
        return out
    }
}

/// Sliding-window limiter keyed by client.
final class MCPKeyedRateLimiter {
    private var hits: [String: [Double]] = [:]
    let now: () -> Double
    init(now: @escaping () -> Double = agentNowMs) { self.now = now }
    func take(_ key: String, limit: Int, windowMs: Double = 60_000) -> Bool {
        let t = now()
        var list = (hits[key] ?? []).filter { t - $0 < windowMs }
        if list.count >= limit { hits[key] = list; return false }
        list.append(t)
        hits[key] = list
        return true
    }
    func reset() { hits.removeAll() }
}

// MARK: - confirmations

struct MCPPendingRequest: Equatable {
    var id: String
    var client: String
    var tool: String
    var toolTitle: String
    /// Plain-English description of exactly what the call will do.
    var summary: String
    var createdAt: Double
    var expiresAt: Double
    var json: JSONValue {
        ["id": .string(id), "client": .string(client), "tool": .string(tool), "toolTitle": .string(toolTitle), "summary": .string(summary),
         "createdAt": .double(createdAt), "expiresAt": .double(expiresAt)]
    }
}

enum MCPDecision: String { case allow, deny, always, timeout, cancelled }

/// Pending confirmations: each waits for Allow / Deny / Always in Glide; denied on timeout, when too many
/// already wait (5), or when the server stops.
@MainActor final class MCPConfirmations {
    var timeoutMs: () -> Double = { 60_000 }
    var onChange: ([MCPPendingRequest]) -> Void = { _ in }
    var onRequest: (MCPPendingRequest) -> Void = { _ in }
    var maxPending = 5
    var now: () -> Double = agentNowMs
    private var waiting: [String: (req: MCPPendingRequest, resume: (MCPDecision) -> Void)] = [:]
    /// Caller tag (session + JSON-RPC id) → pending id, for notifications/cancelled.
    private var tags: [String: String] = [:]
    private var order: [String] = []
    private var seq = 0

    var pending: [MCPPendingRequest] { order.compactMap { waiting[$0]?.req } }

    func request(client: String, tool: String, toolTitle: String, summary: String, tag: String? = nil) async -> MCPDecision {
        if waiting.count >= maxPending { return .deny }
        let t = now()
        let ms = max(1000, timeoutMs())
        seq += 1
        let req = MCPPendingRequest(id: "req-\(String(Int64(t), radix: 36))-\(String(seq, radix: 36))", client: client, tool: tool, toolTitle: toolTitle,
                                    summary: summary, createdAt: t, expiresAt: t + ms)
        return await withCheckedContinuation { (c: CheckedContinuation<MCPDecision, Never>) in
            var done = false
            waiting[req.id] = (req, { d in
                guard !done else { return }
                done = true
                c.resume(returning: d)
            })
            order.append(req.id)
            if let tag { tags[tag] = req.id }
            onChange(pending)
            onRequest(req)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(Int(ms)))
                self?.settle(req.id, .timeout)
            }
        }
    }

    @discardableResult func settle(_ id: String, _ d: MCPDecision) -> Bool {
        guard let w = waiting.removeValue(forKey: id) else { return false }
        order.removeAll { $0 == id }
        tags = tags.filter { $0.value != id }
        w.resume(d)
        onChange(pending)
        return true
    }

    @discardableResult func respond(_ id: String, _ decision: String) -> Bool {
        guard let d = MCPDecision(rawValue: decision), d != .timeout, d != .cancelled else { return false }
        return settle(id, d)
    }

    func denyAll() { for id in order { settle(id, .deny) } }

    /// The client cancelled the request that is waiting on this prompt.
    @discardableResult func cancel(tag: String) -> Bool {
        guard let id = tags[tag] else { return false }
        return settle(id, .cancelled)
    }
}

// MARK: - request log (<dataDir>/requests.json; never arguments or results)

struct MCPLogEntry: Codable, Equatable {
    var id: String
    var at: Double
    var client: String
    var tool: String
    var summary: String
    /// ok | error | denied | timeout | cancelled | off | rate-limited | invalid
    var outcome: String
    var ms: Double
    var error: String?
    /// auto | user | always
    var approval: String?
}

@MainActor final class MCPRequestLog {
    static let max = 300
    let file: URL?
    private(set) var entries: [MCPLogEntry] = []
    private var seq = 0
    private var writeTask: Task<Void, Never>?
    var onChange: () -> Void = {}

    init(file: URL?) {
        self.file = file
        if let file, let d = try? Data(contentsOf: file), let list = try? JSONDecoder().decode([MCPLogEntry].self, from: d) { entries = Array(list.suffix(Self.max)) }
    }

    @discardableResult func add(at: Double, client: String, tool: String, summary: String, outcome: String, ms: Double, error: String? = nil, approval: String? = nil) -> MCPLogEntry {
        seq += 1
        let e = MCPLogEntry(id: "\(String(Int64(at), radix: 36))-\(String(seq, radix: 36))", at: at, client: client, tool: tool, summary: summary, outcome: outcome, ms: ms, error: error, approval: approval)
        entries.append(e)
        if entries.count > Self.max { entries.removeFirst(entries.count - Self.max) }
        persist()
        onChange()
        return e
    }

    /// Newest first.
    var list: [MCPLogEntry] { entries.reversed() }

    func clear() {
        entries = []
        persist()
        onChange()
    }

    private func persist() {
        guard let file, writeTask == nil else { return }
        writeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self else { return }
            self.writeTask = nil
            self.flush()
        }
    }

    func flush() {
        guard let file else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONEncoder.glideCompact.encode(entries) { try? d.write(to: file, options: .atomic) }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

// MARK: - backend + call pipeline

struct MCPServerPrepared {
    var describe: @MainActor () async -> String
    var run: @MainActor () async throws -> String
}

@MainActor protocol MCPServerBackend: AnyObject {
    func available(_ t: MCPServerToolDef) -> Bool
    func prepare(_ t: MCPServerToolDef, _ args: [String: JSONValue]) -> Result<MCPServerPrepared, MCPConfigError>
    func notes() async -> [JSONValue]
    func note(_ id: String) async -> String?
    func clipboardRecent(_ limit: Int) async -> [JSONValue]
}

/// policy → rate limit → validation → in-Glide confirmation → run → request log.
@MainActor final class MCPCallHandler {
    /// Clipboard-like or free-text tools: the log keeps only the tool title.
    static let privateSummary: Set<String> = ["clipboard_history_search", "transform_text", "create_note", "capture_text_from_image"]

    let tools: [MCPServerToolDef]
    let settings: () -> MCPServerSettings
    let backend: any MCPServerBackend
    let confirmations: MCPConfirmations
    let limiter: MCPKeyedRateLimiter
    let log: MCPRequestLog
    let grantAlways: (String, String) -> Void
    var now: () -> Double = agentNowMs

    init(tools: [MCPServerToolDef], settings: @escaping () -> MCPServerSettings, backend: any MCPServerBackend, confirmations: MCPConfirmations,
         limiter: MCPKeyedRateLimiter, log: MCPRequestLog, grantAlways: @escaping (String, String) -> Void) {
        self.tools = tools
        self.settings = settings
        self.backend = backend
        self.confirmations = confirmations
        self.limiter = limiter
        self.log = log
        self.grantAlways = grantAlways
    }

    func visibleTools(client: String) -> [MCPServerToolDef] {
        let s = settings()
        return tools.filter { t in
            guard backend.available(t) else { return false }
            if case .deny = MCPPolicy.gate(t, s, client: client) { return false }
            return true
        }
    }

    static func text(_ t: String, isError: Bool = false) -> JSONValue {
        var o: [String: JSONValue] = ["content": [["type": "text", "text": .string(t)]]]
        if isError { o["isError"] = true }
        return .object(o)
    }

    func isKnownTool(_ name: String) -> Bool { tools.contains { $0.name == name && backend.available($0) } }

    func recordUnknown(client: String, name: String) {
        log.add(at: now(), client: client, tool: name, summary: "Unknown tool \(name)", outcome: "invalid", ms: 0)
    }

    /// notifications/cancelled for a call that may be waiting on a confirmation.
    func cancel(requestKey: String) { confirmations.cancel(tag: requestKey) }

    func call(client: String, name: String, args raw: JSONValue, requestKey: String? = nil) async -> JSONValue {
        let t0 = now()
        let s = settings()
        let tool = tools.first { $0.name == name && backend.available($0) }
        func record(_ summary: String, _ outcome: String, error: String? = nil, approval: String? = nil) {
            let shown = tool.map { Self.privateSummary.contains($0.name) ? $0.title : summary } ?? summary
            log.add(at: t0, client: client, tool: name, summary: shown, outcome: outcome, ms: now() - t0, error: error, approval: approval)
        }
        guard let tool else {
            record("Unknown tool \(name)", "invalid")
            return Self.text("Unknown tool \(name)", isError: true)
        }
        let gate = MCPPolicy.gate(tool, s, client: client)
        if case let .deny(reason) = gate {
            record(tool.title, "off")
            return Self.text(reason, isError: true)
        }
        if !limiter.take("all:\(client)", limit: s.rateLimitPerMin) || (!tool.readOnly && !limiter.take("mut:\(client)", limit: s.mutatingPerMin)) {
            record(tool.title, "rate-limited")
            return Self.text("Too many Glide requests: rate limit reached. Wait a minute and try again.", isError: true)
        }
        var args = tool.defaults
        for (k, v) in raw.objectValue ?? [:] { args[k] = v }
        let prepared: MCPServerPrepared
        switch backend.prepare(tool, args) {
        case let .failure(e):
            record(tool.title, "invalid", error: e.message)
            return Self.text(e.message, isError: true)
        case let .success(p): prepared = p
        }
        let summary = await prepared.describe()
        var approval = "auto"
        if gate == .confirm {
            let d = await confirmations.request(client: client, tool: tool.name, toolTitle: tool.title, summary: summary, tag: requestKey)
            switch d {
            case .cancelled:
                record(summary, "cancelled")
                return Self.text("The request was cancelled before the user answered.", isError: true)
            case .deny, .timeout:
                record(summary, d == .deny ? "denied" : "timeout")
                return Self.text(d == .deny ? "The user denied this request in Glide." : "No answer in Glide before the confirmation timed out, so the request was denied.", isError: true)
            case .always:
                grantAlways(client, tool.name)
                approval = "always"
            case .allow: approval = "user"
            }
        } else if (s.always[client] ?? []).contains(tool.name) { approval = "always" }
        do {
            let out = try await prepared.run()
            record(summary, "ok", approval: approval)
            return Self.text(out)
        } catch {
            let m = (error as? AgentToolFailure)?.message ?? error.localizedDescription
            record(summary, "error", error: m, approval: approval)
            return Self.text(m, isError: true)
        }
    }

    // MARK: resources: glide://notes/<id> (search_notes runs without asking), glide://clipboard/recent (clipboard tool on Allow)

    static let notePrefix = "glide://notes/"
    static let clipboardURI = "glide://clipboard/recent"

    private func allowed(_ tool: String, _ client: String) -> Bool {
        guard let t = tools.first(where: { $0.name == tool }), backend.available(t) else { return false }
        return MCPPolicy.gate(t, settings(), client: client) == .run
    }

    func listResources(client: String) async -> [JSONValue] {
        var out: [JSONValue] = []
        if allowed("search_notes", client) {
            for n in await backend.notes().prefix(100) {
                let id = n["id"]?.description ?? ""
                let title = n["title"]?.stringValue ?? ""
                out.append(["uri": .string(Self.notePrefix + (id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)), "name": .string(title.isEmpty ? id : title),
                            "title": .string(title.isEmpty ? "Untitled note" : title), "mimeType": "text/markdown"])
            }
        }
        if allowed("clipboard_history_search", client) {
            out.append(["uri": .string(Self.clipboardURI), "name": "clipboard-recent", "title": "Recent clipboard history", "mimeType": "application/json",
                        "description": "The 20 most recent Glide clipboard history entries (text previews)"])
        }
        return out
    }

    func resourceTemplates(client: String) -> [JSONValue] {
        allowed("search_notes", client) ? [["uriTemplate": .string("\(Self.notePrefix){id}"), "name": "note", "title": "Glide note", "mimeType": "text/markdown",
                                           "description": "A Glide floating note by id (ids from search_notes)"]] : []
    }

    func readResource(uri: String, client: String) async throws -> JSONValue {
        if uri.hasPrefix(Self.notePrefix) {
            guard allowed("search_notes", client) else { throw MCPError(code: MCP.invalidParams, message: "Reading notes is turned off in Glide Settings → MCP Server (search_notes).") }
            let id = String(uri.dropFirst(Self.notePrefix.count)).removingPercentEncoding ?? ""
            guard let body = await backend.note(id) else { throw MCPError(code: MCP.resourceNotFound, message: "No note with id \(id)", data: ["uri": .string(uri)]) }
            return ["uri": .string(uri), "mimeType": "text/markdown", "text": .string(body)]
        }
        if uri == Self.clipboardURI {
            guard allowed("clipboard_history_search", client) else {
                throw MCPError(code: MCP.invalidParams, message: "Clipboard history is turned off in Glide Settings → MCP Server (clipboard_history_search).")
            }
            return ["uri": .string(uri), "mimeType": "application/json", "text": .string(AgentText.json(.array(await backend.clipboardRecent(20))))]
        }
        throw MCPError(code: MCP.resourceNotFound, message: "Resource not found: \(uri)", data: ["uri": .string(uri)])
    }
}
