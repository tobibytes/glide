import Foundation
import GlideCore
import GlideSystem
import GlideUI
import Observation
import SwiftUI

/// The real backend: agent-backed tools run through the Glide Agent's validated tool implementations over
/// LiveAgentCapabilities (ctx.search, ctx.executeItem, other features' methods); the MCP-only tools are here.
@MainActor final class MCPLiveBackend: MCPServerBackend {
    let ctx: FeatureContext
    let caps: LiveAgentCapabilities
    let agentTools: [AgentTool]
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "gif", "bmp", "webp"]

    init(ctx: FeatureContext) {
        self.ctx = ctx
        caps = LiveAgentCapabilities(ctx: ctx)
        agentTools = AgentTools.all()
    }

    func refreshFeatures() async { await caps.refreshFeatures(AgentFeature.probedFeatures) }

    func available(_ t: MCPServerToolDef) -> Bool { t.requires.map { caps.hasFeature($0) } ?? true }

    static func q(_ s: String) -> String { AgentText.quote(s) }

    func timers() async throws -> [JSONValue] { (try await caps.call("timers", "state", .null))["timers"]?.arrayValue ?? [] }

    static func remaining(_ t: JSONValue, now: Double) -> Double {
        if let r = t["remainingMs"]?.doubleValue { return max(0, r) }
        let duration = t["durationMs"]?.doubleValue ?? 0
        let started = t["startedAt"]?.doubleValue ?? now
        let pausedAt = t["pausedAt"]?.doubleValue
        let pausedMs = t["pausedMs"]?.doubleValue ?? 0
        return max(0, duration - ((pausedAt ?? now) - started - pausedMs))
    }

    func prepare(_ t: MCPServerToolDef, _ args: [String: JSONValue]) -> Result<MCPServerPrepared, MCPConfigError> {
        if let name = t.agentTool {
            guard let at = agentTools.first(where: { $0.name == name }) else { return .failure(MCPConfigError("\(t.name) is not available in this Glide build")) }
            if t.name == "run_command", let id = args["id"]?.stringValue, id.hasPrefix("mcp-server:") || id.hasPrefix("agent:") {
                return .failure(MCPConfigError("MCP clients cannot run Glide Agent or the MCP server's own commands"))
            }
            switch at.prepare(.object(args), caps) {
            case let .invalid(m): return .failure(MCPConfigError(m))
            case let .ready(p): return .success(MCPServerPrepared(describe: p.describe, run: { try await p.run().text }))
            }
        }
        switch t.name {
        case "list_timers":
            return .success(MCPServerPrepared(describe: { "List timers" }, run: {
                let st = try await self.caps.call("timers", "state", .null)
                let now = agentNowMs()
                let list: [JSONValue] = (st["timers"]?.arrayValue ?? []).map { tm in
                    ["id": tm["id"] ?? .null, "name": .string(tm["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Timer"), "durationMs": tm["durationMs"] ?? .null,
                     "remainingMs": .double(Self.remaining(tm, now: now)), "paused": .bool(!(tm["pausedAt"]?.isNull ?? true))]
                }
                let sw: [JSONValue] = (st["stopwatches"]?.arrayValue ?? []).map { s in
                    let started = s["startedAt"]?.doubleValue ?? now, pausedAt = s["pausedAt"]?.doubleValue
                    return ["id": s["id"] ?? .null, "name": .string(s["name"]?.stringValue ?? "Stopwatch"),
                            "elapsedMs": .double(max(0, (pausedAt ?? now) - started - (s["pausedMs"]?.doubleValue ?? 0))), "paused": .bool(pausedAt != nil)]
                }
                return list.isEmpty && sw.isEmpty ? "No timers are running." : AgentText.json(["timers": .array(list), "stopwatches": .array(sw)])
            }))
        case "stop_timer":
            guard let id = args["id"]?.stringValue?.trimmingCharacters(in: .whitespaces), !id.isEmpty else { return .failure(MCPConfigError("\"id\" is required")) }
            return .success(MCPServerPrepared(describe: {
                if let tm = (try? await self.timers())?.first(where: { $0["id"]?.stringValue == id }) {
                    return "Stop the timer \(Self.q(tm["name"]?.stringValue ?? "Timer")) (\(AgentTools.formatDuration(Self.remaining(tm, now: agentNowMs()))) left)"
                }
                return "Stop timer \(id)"
            }, run: {
                guard try await self.timers().contains(where: { $0["id"]?.stringValue == id }) else { throw AgentToolFailure("No timer with id \(id). Use list_timers.") }
                return try AgentOp.from(try await self.caps.call("timers", "stop", ["id": .string(id)]), fallback: "Timer stopped").text("Timer stopped")
            }))
        case "list_reminders":
            let query = args["query"]?.stringValue?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
            let limit = max(1, min(100, args["limit"]?.intValue ?? 30))
            return .success(MCPServerPrepared(describe: { query.isEmpty ? "List reminders" : "List reminders matching \(Self.q(query))" }, run: {
                let st = try await self.caps.call("reminders", "state", .null)
                if let status = st["status"]?.stringValue, status != "ok" {
                    throw AgentToolFailure(st["message"]?.stringValue ?? "Reminders unavailable (\(status)). Grant access in Glide → Reminders.")
                }
                let rows: [JSONValue] = (st["reminders"]?.arrayValue ?? []).filter { query.isEmpty || ($0["title"]?.stringValue ?? "").lowercased().contains(query) }.prefix(limit).map { r in
                    ["id": r["id"] ?? .null, "title": r["title"] ?? .null, "due": r["due"] ?? .null, "list": r["listTitle"] ?? .null, "completed": .bool(r["completed"]?.boolValue == true)]
                }
                return rows.isEmpty ? "No reminders." : AgentText.clip(AgentText.json(.array(rows)))
            }))
        case "capture_text_from_image":
            let raw = args["path"]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
            guard raw.hasPrefix("/") || raw.hasPrefix("~/") else { return .failure(MCPConfigError("\"path\" must be an absolute path or start with ~/")) }
            let file = URL(fileURLWithPath: (raw as NSString).expandingTildeInPath).standardizedFileURL
            guard Self.imageExtensions.contains(file.pathExtension.lowercased()) else { return .failure(MCPConfigError("Only image files (png, jpg, heic, tiff, gif, bmp, webp) can be read")) }
            return .success(MCPServerPrepared(describe: { "Recognize text in \(raw)" }, run: {
                var isDir: ObjCBool = false
                guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue else { throw AgentToolFailure("No image file at \(raw)") }
                // Called directly (not the OCR feature) so its "auto copy" setting never touches the clipboard.
                let r = try await self.ctx.services.ocr.recognize(path: file.path, languages: [], fast: false, languageCorrection: true)
                let text = r.lines.map(\.text).joined(separator: "\n")
                return text.isEmpty ? "No text found in the image." : AgentText.clip(text, 20_000)
            }))
        default: return .failure(MCPConfigError("No implementation for \(t.name)"))
        }
    }

    func notes() async -> [JSONValue] { (try? await AgentTools.notesList(caps, "")) ?? [] }

    func note(_ id: String) async -> String? {
        guard let n = try? await caps.call("notes", "get", ["id": .string(id)]), (n["id"]?.description ?? "") == id else { return nil }
        return n["body"]?.stringValue ?? n["text"]?.stringValue
    }

    func clipboardRecent(_ limit: Int) async -> [JSONValue] { (try? await AgentToolsExtra.clipboardEntries(caps, "", limit)) ?? [] }
}

@MainActor @Observable final class MCPServerViewModel {
    var revision = 0
    var pendingSelected = 0
    var revealToken = false
    var copied: String?
}

/// Glide as an MCP server (mcp-server/index.ts): external agents call Glide's tools over Streamable HTTP on
/// 127.0.0.1 (bearer token) or through `Glide --mcp-stdio`. Off by default; Settings → MCP Server turns it on,
/// sets Off/Ask/Allow per tool and shows the request log. State-changing calls wait for Allow / Always / Deny in
/// the launcher view `mcp-server.confirm`.
@MainActor public final class MCPServerFeature: Feature, FeatureUI {
    public let id = "mcp-server"
    public let title = "MCP Server"
    nonisolated static let confirmView = ViewID(rawValue: "mcp-server.confirm")
    static let version = "1.0.0"

    private(set) weak var context: FeatureContext?
    let tools = MCPServerTools.all()
    private(set) var server: MCPHTTPServer?
    private var starting: Task<Void, Never>?
    private(set) var lastError: String?
    let confirmations = MCPConfirmations()
    let limiter = MCPKeyedRateLimiter()
    private(set) var requestLog = MCPRequestLog(file: nil)
    private(set) var handler: MCPCallHandler?
    private(set) var backend: MCPLiveBackend?
    let viewModel = MCPServerViewModel()
    var toolNames: Set<String> { Set(tools.map(\.name)) }

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        let dir = context.dataDirectory()
        requestLog = MCPRequestLog(file: dir.appendingPathComponent("requests.json"))
        requestLog.onChange = { [weak self] in self?.viewModel.revision += 1 }
        let b = MCPLiveBackend(ctx: context)
        backend = b
        confirmations.timeoutMs = { [weak self] in Double((self?.settings.confirmTimeoutSec ?? 60) * 1000) }
        confirmations.onChange = { [weak self] _ in self?.viewModel.revision += 1 }
        confirmations.onRequest = { [weak self] r in
            guard let self, let ctx = self.context else { return }
            ctx.log("confirmation requested: \(r.client) → \(r.tool)")
            ctx.push(Self.confirmView, payload: ["requestId": .string(r.id)])
            ctx.services.notifications.notify(title: "MCP request from \(r.client)", body: r.summary)
            GlideFeatureEvents.post(GlideFeatureEvents.mcpConfirmation, ["id": r.id, "client": r.client, "tool": r.toolTitle]) // phone-notify
        }
        handler = MCPCallHandler(tools: tools, settings: { [weak self] in self?.settings ?? MCPServerSettings() }, backend: b, confirmations: confirmations,
                                 limiter: limiter, log: requestLog, grantAlways: { [weak self] c, t in self?.grantAlways(client: c, tool: t) })
        Task { @MainActor [weak self] in
            await b.refreshFeatures()
            if self?.settings.enabled == true { await self?.startServer() }
        }
    }

    public func stop() async { await stopServer() }

    var settings: MCPServerSettings { MCPServerSettings(bag: context?.settings(defaults: MCPServerSettings.defaultsBag) ?? MCPServerSettings.defaultsBag) }

    // MARK: lifecycle

    var dataDir: URL? { context?.dataDirectory() }

    func startServer() async {
        if server != nil { return }
        if let s = starting { return await s.value }
        guard let ctx = context, let handler else { return }
        let t = Task { @MainActor in
            do {
                let dir = ctx.dataDirectory()
                _ = try MCPServerAuth.loadOrCreateToken(dir)
                let srv = MCPHTTPServer(token: { MCPServerAuth.readToken(dir) ?? "" }, makeSession: { MCPServerSession(handler: handler, version: Self.version) })
                srv.log = { ctx.log($0) }
                srv.onSessionsChanged = { [weak self] _ in self?.viewModel.revision += 1 }
                try await srv.start(preferredPort: settings.port)
                server = srv
                try MCPServerAuth.writeDiscovery(dir, .init(port: srv.port, pid: Int(getpid()), url: srv.url, version: Self.version, startedAt: agentNowMs()))
                lastError = nil
                ctx.log("listening on \(srv.url)")
            } catch {
                lastError = error.localizedDescription
                ctx.log("could not start: \(error.localizedDescription)")
            }
            viewModel.revision += 1
        }
        starting = t
        await t.value
        starting = nil
    }

    func stopServer() async {
        if let s = starting { await s.value }
        confirmations.denyAll()
        let s = server
        server = nil
        if let s { await s.close() }
        if let dir = dataDir { MCPServerAuth.removeDiscovery(dir, pid: Int(getpid())) }
        viewModel.revision += 1
    }

    @discardableResult func applySettings(_ patch: JSONValue) async -> JSONValue {
        let before = settings
        let clean = MCPPolicy.cleanPatch(patch, knownTools: toolNames)
        if !clean.isEmpty { context?.setSettings(clean) }
        let after = settings
        if before.enabled && !after.enabled { await stopServer() } else if after.enabled && (!before.enabled || server == nil) { await startServer() } else if after.enabled && before.port != after.port {
            await stopServer()
            await startServer()
        }
        if clean["tools"] != nil || clean["always"] != nil { server?.notifyListChanged() }
        viewModel.revision += 1
        return state()
    }

    func grantAlways(client: String, tool: String) {
        var always = settings.always
        var list = always[client] ?? []
        if !list.contains(tool) { list.append(tool) }
        always[client] = list
        context?.setSettings(["always": .object(always.mapValues { .array($0.map(JSONValue.string)) })])
        viewModel.revision += 1
    }

    /// The stdio bridge command for client configs: this binary in --mcp-stdio mode.
    var shim: (command: String, args: [String]) {
        let exe = Bundle.main.executablePath ?? CommandLine.arguments.first ?? "Glide"
        var args = [MCPStdioBridge.flag]
        if let root = context?.store.directory, root.standardizedFileURL != GlidePaths.userDataDirectory(environment: [:]).standardizedFileURL {
            args += ["--data-dir", root.path]
        }
        return (exe, args)
    }

    func toolRows() -> [JSONValue] {
        let s = settings
        return tools.map { t in
            ["name": .string(t.name), "title": .string(t.title), "description": .string(t.description), "readOnly": .bool(t.readOnly), "destructive": .bool(t.destructive),
             "sensitive": .bool(t.sensitive), "policy": .string(MCPPolicy.policy(t, s).rawValue), "defaultPolicy": .string(MCPPolicy.defaultPolicy(t).rawValue),
             "available": .bool(backend?.available(t) ?? true)]
        }
    }

    func state() -> JSONValue {
        let dir = dataDir
        return ["settings": settings.json, "running": .bool(server != nil), "starting": .bool(starting != nil),
                "url": server.map { .string($0.url) } ?? .null, "port": server.map { .int(Int64($0.port)) } ?? .null,
                "error": lastError.map(JSONValue.string) ?? .null, "sessions": .int(Int64(server?.sessionCount ?? 0)), "tools": .array(toolRows()),
                "pending": .array(confirmations.pending.map(\.json)), "shim": ["command": .string(shim.command), "args": .array(shim.args.map(JSONValue.string))],
                "dataDir": .string(dir?.path ?? ""), "hasToken": .bool(dir.flatMap(MCPServerAuth.readToken) != nil)]
    }

    func snippets(reveal: Bool) -> [JSONValue] {
        let token = reveal ? (dataDir.flatMap(MCPServerAuth.readToken) ?? "") : "<token>"
        return MCPServerSnippets.build(command: shim.command, args: shim.args, url: server?.url, token: token)
    }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        [SearchItem(id: "\(id):settings", kind: .command, title: "MCP Server Settings", subtitle: "Let AI agents use Glide's tools", icon: .symbol("point.3.connected.trianglepath.dotted"),
                    keywords: ["mcp", "agent", "claude", "goose", "cursor", "server", "tools"], feature: id, data: ["action": "settings"], kindLabel: "MCP"),
         SearchItem(id: "\(id):requests", kind: .command, title: "MCP Requests", subtitle: "Pending requests from AI agents", icon: .symbol("hand.raised"),
                    keywords: ["mcp", "requests", "approve", "allow", "deny"], feature: id, data: ["action": "requests"], kindLabel: "MCP")]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        item.data?["action"]?.stringValue == "requests" ? [ItemAction(id: "requests", title: "Show MCP Requests", shortcut: "↩", icon: "hand.raised")]
            : [ItemAction(id: "settings", title: "Open MCP Server Settings", shortcut: "↩", icon: "gearshape")]
    }

    public func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        action == "requests" ? .pushView(Self.confirmView) : .openSettings(page: id)
    }

    // MARK: methods

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "state": return state()
        case "setSettings": return await applySettings(args)
        case "setEnabled": return await applySettings(["enabled": .bool(args.boolValue ?? args["enabled"]?.boolValue ?? false)])
        case "setToolPolicy":
            guard let name = args["name"]?.stringValue, toolNames.contains(name), let p = args["policy"]?.stringValue else { return state() }
            var t = settings.tools
            t[name] = p
            return await applySettings(["tools": .object(t.mapValues(JSONValue.string))])
        case "resetToolPolicies": return await applySettings(["tools": [:]])
        case "revokeAlways":
            var always = settings.always
            if let client = args["client"]?.stringValue {
                if let tool = args["tool"]?.stringValue { always[client] = (always[client] ?? []).filter { $0 != tool } } else { always[client] = nil }
            }
            return await applySettings(["always": .object(always.mapValues { .array($0.map(JSONValue.string)) })])
        case "pending": return .array(confirmations.pending.map(\.json))
        case "respond": return .bool(confirmations.respond(args["id"]?.stringValue ?? confirmations.pending.first?.id ?? "", args["decision"]?.stringValue ?? ""))
        case "log": return agentJSON(requestLog.list)
        case "clearLog":
            requestLog.clear()
            return []
        case "regenerateToken":
            guard let dir = dataDir else { throw FeatureError.failed("not started") }
            _ = try MCPServerAuth.regenerateToken(dir)
            viewModel.revision += 1
            return state()
        case "snippets": return .array(snippets(reveal: args.boolValue == true || args["reveal"]?.boolValue == true))
        case "copy":
            guard let text = args["text"]?.stringValue ?? args.stringValue else { return false }
            context?.services.pasteboard.setString(text, html: nil, transient: false)
            return true
        case "snapshotSettings":
            let path = args["path"]?.stringValue ?? NSTemporaryDirectory() + "mcp-server-settings.png"
            let size = try AgentSnapshot.render(AnyView(MCPServerSettingsView(feature: self)), size: NSSize(width: 680, height: 1000), to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .double(size.width), "height": .double(size.height)]
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    // MARK: UI

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "MCP Server", symbol: "point.3.connected.trianglepath.dotted", order: 46) { [weak self] in
            guard let self else { return AnyView(EmptyView()) }
            return AnyView(MCPServerSettingsView(feature: self))
        }
    }

    public func launcherView(_ view: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard view == Self.confirmView else { return nil }
        host.setPlaceholder("MCP requests")
        host.setFooter(primary: confirmations.pending.isEmpty ? nil : "Allow Once", hasActions: false)
        return AnyView(MCPConfirmView(feature: self, model: viewModel))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        guard view == Self.confirmView else { return false }
        let list = confirmations.pending
        guard !list.isEmpty else { return false }
        let i = min(viewModel.pendingSelected, list.count - 1)
        switch (key.key, key.meta) {
        case ("ArrowDown", false): viewModel.pendingSelected = min(list.count - 1, i + 1); return true
        case ("ArrowUp", false): viewModel.pendingSelected = max(0, i - 1); return true
        case ("Enter", let meta) where !key.ctrl:
            confirmations.respond(list[i].id, meta ? "always" : "allow")
            afterAnswer()
            return true
        case ("Backspace", true):
            confirmations.respond(list[i].id, "deny")
            afterAnswer()
            return true
        default: return false
        }
    }

    private func afterAnswer() {
        viewModel.pendingSelected = 0
        if confirmations.pending.isEmpty { LauncherHosts.current?.pop() }
    }
}

// MARK: - views

struct MCPConfirmView: View {
    @Environment(\.glideTheme) private var theme
    let feature: MCPServerFeature
    let model: MCPServerViewModel

    var body: some View {
        let _ = model.revision
        let list = feature.confirmations.pending
        if list.isEmpty {
            EmptyState(symbol: "checkmark.shield", title: "No pending MCP requests", subtitle: "Requests from AI agents that need your approval show up here")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, r in
                        VStack(alignment: .leading, spacing: 6) {
                            Label("MCP request: \(r.client) wants to…", systemImage: "point.3.connected.trianglepath.dotted")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.text2)
                            Text(r.summary).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
                            Text("\(r.toolTitle) · \(r.tool) · expires \(Self.time(r.expiresAt))").font(.system(size: 11)).foregroundStyle(theme.text3)
                            HStack(spacing: 14) {
                                HStack(spacing: 4) { Kbd("↩"); Text("Allow Once").font(.system(size: 11.5, weight: .medium)) }
                                HStack(spacing: 4) { Kbd("⌘↩"); Text("Always for \(r.client)").font(.system(size: 11.5)) }
                                HStack(spacing: 4) { Kbd("⌘⌫"); Text("Deny").font(.system(size: 11.5)) }
                            }
                            .foregroundStyle(theme.text2)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(i == min(model.pendingSelected, list.count - 1) ? theme.selected : theme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.border, lineWidth: 1))
                    }
                }
                .padding(14)
            }
        }
    }

    static func time(_ ms: Double) -> String {
        let f = DateFormatter()
        f.timeStyle = .medium
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}

struct MCPServerSettingsView: View {
    let feature: MCPServerFeature
    @State private var portText = ""

    var body: some View {
        let _ = feature.viewModel.revision
        let st = feature.state()
        let s = feature.settings
        Form {
            Section {
                Toggle("Enable MCP server", isOn: Binding(get: { s.enabled }, set: { on in Task { @MainActor in await feature.applySettings(["enabled": .bool(on)]) } }))
                LabeledContent("Status") {
                    if st["running"]?.boolValue == true {
                        Text("Listening on \(st["url"]?.stringValue ?? "") · \(st["sessions"]?.intValue ?? 0) session(s)").textSelection(.enabled)
                    } else if let e = st["error"]?.stringValue {
                        Text(e).foregroundStyle(.red)
                    } else {
                        Text("Off").foregroundStyle(.secondary)
                    }
                }
                HStack {
                    TextField("Port", text: $portText, prompt: Text(String(s.port))).frame(width: 90)
                    Button("Apply Port") {
                        if let p = Int(portText) { Task { @MainActor in await feature.applySettings(["port": .int(Int64(p))]) } }
                    }
                    Text("0 = any free port").font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    Button(feature.viewModel.revealToken ? "Hide Token" : "Reveal Token") { feature.viewModel.revealToken.toggle() }
                    Button("Regenerate Token") { Task { @MainActor in _ = try? await feature.invoke(method: "regenerateToken", args: .null) } }
                    if feature.viewModel.revealToken, let t = feature.dataDir.flatMap(MCPServerAuth.readToken) {
                        Text(t).font(.caption.monospaced()).textSelection(.enabled).lineLimit(1)
                    }
                }
            } header: { Text("MCP Server") } footer: {
                Text("Off by default. Binds 127.0.0.1 only; every request needs the bearer token. State-changing tools always ask in Glide unless you chose Always for that client.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Connect a client") {
                ForEach(feature.snippets(reveal: feature.viewModel.revealToken).indices, id: \.self) { i in
                    let sn = feature.snippets(reveal: feature.viewModel.revealToken)[i]
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(sn["title"]?.stringValue ?? "").font(.headline)
                            Spacer()
                            Button(feature.viewModel.copied == sn["id"]?.stringValue ? "Copied" : "Copy") {
                                feature.context?.services.pasteboard.setString(sn["text"]?.stringValue ?? "", html: nil, transient: false)
                                feature.viewModel.copied = sn["id"]?.stringValue
                            }
                        }
                        Text(sn["hint"]?.stringValue ?? "").font(.caption).foregroundStyle(.secondary)
                        Text(sn["text"]?.stringValue ?? "").font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                            .padding(6).frame(maxWidth: .infinity, alignment: .leading).background(Color.secondary.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
            Section("Tools") {
                ForEach(feature.tools, id: \.name) { t in
                    let policy = MCPPolicy.policy(t, s)
                    Picker(selection: Binding(get: { policy.rawValue }, set: { v in
                        Task { @MainActor in _ = try? await feature.invoke(method: "setToolPolicy", args: ["name": .string(t.name), "policy": .string(v)]) }
                    })) {
                        Text("Off").tag("off")
                        Text("Ask").tag("ask")
                        if t.readOnly { Text("Allow").tag("allow") }
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(t.title)
                            Text("\(t.name) · \(t.readOnly ? "read-only" : t.destructive ? "destructive" : "changes state")\(t.sensitive ? " · clipboard" : "")\(feature.backend?.available(t) == false ? " · unavailable" : "")")
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
                Button("Reset to Defaults") { Task { @MainActor in _ = try? await feature.invoke(method: "resetToolPolicies", args: .null) } }
            }
            if !s.always.isEmpty {
                Section("Always allowed") {
                    ForEach(s.always.keys.sorted(), id: \.self) { client in
                        ForEach(s.always[client] ?? [], id: \.self) { tool in
                            HStack {
                                Text("\(client) → \(tool)")
                                Spacer()
                                Button("Revoke") { Task { @MainActor in _ = try? await feature.invoke(method: "revokeAlways", args: ["client": .string(client), "tool": .string(tool)]) } }
                            }
                        }
                    }
                }
            }
            Section("Request log") {
                let log = feature.requestLog.list.prefix(50)
                if log.isEmpty { Text("No requests yet").foregroundStyle(.secondary) }
                ForEach(Array(log), id: \.id) { e in
                    HStack {
                        Text(MCPConfirmView.time(e.at)).font(.caption.monospaced()).foregroundStyle(.secondary)
                        Text(e.client).font(.caption)
                        Text(e.summary).lineLimit(1)
                        Spacer()
                        Text(e.outcome + (e.approval.map { " (\($0))" } ?? "")).font(.caption).foregroundStyle(e.outcome == "ok" ? Color.green : Color.orange)
                    }
                }
                if !log.isEmpty { Button("Clear Log") { feature.requestLog.clear() } }
            }
        }
        .formStyle(.grouped)
    }
}
