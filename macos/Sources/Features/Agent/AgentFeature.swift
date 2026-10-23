import Foundation
import GlideCore
import GlideSystem
import GlideUI
import Observation
import SwiftUI

/// State the agent's launcher views observe.
@MainActor @Observable final class AgentViewModel {
    /// Runs of the conversation shown in agent.run (earlier ones first, the live one last).
    var runs: [AgentRunSnapshot] = []
    var conversationId: String?
    var conversationTitle: String?
    /// Inline error (no key, busy…).
    var error: String?
    var historyQuery = ""
    var history: [AgentConversationSummary] = []
    var historySelected = 0
    /// Bumped on every transcript change (scroll to bottom).
    var revision = 0
    var current: AgentRunSnapshot? { runs.last }
}

/// Glide Agent: a natural-language "do it for me" bar with follow-up conversations (agent/index.ts). The
/// launcher view `agent.run` sends requests to the tool-use loop (AgentLoop) with the AI feature's model,
/// confirms state-changing steps in an in-launcher card (⏎ run, ⌘⏎ always, esc cancel), streams the transcript,
/// keeps conversations (saved redacted to <userData>/features/agent/conversations.json), undoes steps (⌘Z) and
/// saves a run as a workflow (⌘S). Also hosts the MCP client (Settings → Agent → MCP Servers).
@MainActor public final class AgentFeature: Feature, FeatureUI {
    public let id = "agent"
    public let title = "Glide Agent"
    nonisolated static let runView = ViewID(rawValue: "agent.run")
    nonisolated static let historyView = ViewID(rawValue: "agent.history")
    static let defaults: [String: JSONValue] = ["allow": [:], "readOnly": false, "keepSensitive": false, "launcherShortcut": true, "saveHistory": true]
    static let confirmTimeout: Duration = .seconds(300)
    static let keepRuns = 20
    /// Feature ids tools may need (probed at each run).
    static let probedFeatures = ["timers", "notes", "automations", "layouts", "transforms", "browser", "clipboard", "processes", "sysmon", "reminders", "convert"]

    @MainActor final class Run {
        let id: String
        let conversationId: String
        var snapshot: AgentRunSnapshot
        var task: Task<Void, Never>?
        var pending: (id: String, resume: (Bool) -> Void)?
        /// A tool hid the launcher; bring the view back for the next confirmation or the summary.
        var hidden = false
        init(id: String, conversationId: String, snapshot: AgentRunSnapshot) {
            self.id = id
            self.conversationId = conversationId
            self.snapshot = snapshot
        }
        var active: Bool { snapshot.status == .running || snapshot.status == .confirming }
    }

    private(set) weak var context: FeatureContext?
    let model = AgentViewModel()
    private(set) var sessions: AgentSessions?
    private(set) var mcp: MCPManager?
    private var runs: [String: Run] = [:]
    private var runOrder: [String] = []
    let limiter = AgentRateLimiter()
    private var seq = 0
    let mcpSettingsModel = MCPSettingsModel()
    /// Test seam: overrides the model client (scripted turns).
    var clientOverride: (@MainActor () throws -> any AIModelClient)?
    /// Test seam: overrides the capabilities.
    var capabilitiesOverride: (@MainActor (FeatureContext) -> any AgentCapabilities)?

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        let dir = context.dataDirectory()
        let store = AgentConversationStore(file: dir.appendingPathComponent("conversations.json"))
        let sensitivity = AgentSafety.Sensitivity(AgentTools.all())
        sessions = AgentSessions(store: store, sensitivity: { sensitivity }, keepSensitive: { [weak self] in self?.settings.keepSensitive ?? false },
                                 saveHistory: { [weak self] in self?.settings.saveHistory ?? true })
        let headless = context.services.isHeadless || ProcessInfo.processInfo.environment["GLIDE_HEADLESS"] == "1"
        let cipher: any MCPSecretCipher = headless ? MCPFileKeyCipher(keyFile: dir.appendingPathComponent(".mcp-secrets-key")) : MCPKeychainCipher()
        let cfg = MCPConfigStore(file: dir.appendingPathComponent("mcp-servers.json"), cipher: cipher)
        cfg.log = { [weak context] in context?.log($0) }
        let m = MCPManager(store: cfg)
        m.log = { [weak context] in context?.log($0) }
        m.onChange = { [weak self] in self?.mcpSettingsModel.reload(self?.mcp) }
        mcp = m
        mcpSettingsModel.reload(m)
        AgentIntegrations.registerWorkflowActions(self)
        if let p = mockPath { context.log("using scripted mock client from \(p)") }
    }

    public func stop() async {
        for r in runs.values { r.task?.cancel(); r.pending?.resume(false) }
        sessions?.store.flush()
        mcp?.killAll()
        await mcp?.closeAll()
    }

    // MARK: settings

    struct Settings {
        var allow: [String: Bool]
        var readOnly: Bool
        var keepSensitive: Bool
        var launcherShortcut: Bool
        var saveHistory: Bool
    }

    /// Tools the user may run without being asked (never kill_process / run_shortcut).
    var allowable: Set<String> { Set(AgentTools.all().filter { $0.mutating && !$0.alwaysConfirm }.map(\.name)) }

    func cleanAllow(_ raw: JSONValue?) -> [String: Bool] {
        var out: [String: Bool] = [:]
        let ok = allowable
        for (k, v) in raw?.objectValue ?? [:] where v.boolValue == true && (ok.contains(k) || MCPSchema.isToolName(k)) { out[k] = true }
        return out
    }

    var settings: Settings {
        let s = context?.settings(defaults: Self.defaults) ?? Self.defaults
        return Settings(allow: cleanAllow(s["allow"]), readOnly: s["readOnly"]?.boolValue == true, keepSensitive: s["keepSensitive"]?.boolValue == true,
                        launcherShortcut: s["launcherShortcut"]?.boolValue != false, saveHistory: s["saveHistory"]?.boolValue != false)
    }

    var settingsJSON: JSONValue {
        let s = settings
        return ["allow": .object(s.allow.mapValues(JSONValue.bool)), "readOnly": .bool(s.readOnly), "keepSensitive": .bool(s.keepSensitive),
                "launcherShortcut": .bool(s.launcherShortcut), "saveHistory": .bool(s.saveHistory)]
    }

    @discardableResult func setSettings(_ patch: JSONValue) -> JSONValue {
        var out: [String: JSONValue] = [:]
        if patch["allow"]?.objectValue != nil { out["allow"] = .object(cleanAllow(patch["allow"]).mapValues(JSONValue.bool)) }
        for k in ["readOnly", "keepSensitive", "launcherShortcut", "saveHistory"] { if let b = patch[k]?.boolValue { out[k] = .bool(b) } }
        if !out.isEmpty { context?.setSettings(out) }
        return settingsJSON
    }

    func setAllowed(_ tool: String, _ on: Bool) {
        var a = settings.allow
        a[tool] = on ? true : nil
        // The bag merge replaces the whole "allow" object.
        context?.setSettings(["allow": .object(a.mapValues(JSONValue.bool))])
    }

    var mockPath: String? {
        let p = ProcessInfo.processInfo.environment["GLIDE_AGENT_MOCK"]
        return p?.isEmpty == false ? p : nil
    }

    var aiModel: (model: String, effort: String) {
        let ai = context?.store.settings.features["ai"] ?? [:]
        let m = AgentAIBridge.provider?.currentModel ?? ai["model"]?.stringValue.flatMap { AIModels.isKnown($0) ? $0 : nil } ?? AIModels.defaultModel
        let e = ai["effort"]?.stringValue.flatMap { ["low", "medium", "high"].contains($0) ? $0 : nil } ?? "medium"
        return (m, e)
    }

    func makeClient() throws -> any AIModelClient {
        if let o = clientOverride { return try o() }
        if let p = mockPath { return try AgentScriptedClient.load(path: p) }
        return try AgentIntegrations.liveClient()
    }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        [SearchItem(id: "agent:ask", kind: .command, title: "Ask Glide Agent", subtitle: "Do it for me — arrange windows, start timers, open things…",
                    icon: .symbol("wand.and.stars"), keywords: ["agent", "ai", "do", "automate", "claude", "assistant", "command"], acceptsArgument: true,
                    feature: id, data: ["type": "ask"], kindLabel: "Agent"),
         SearchItem(id: "agent:history", kind: .command, title: "Glide Agent History", subtitle: "Search, resume or delete past agent conversations",
                    icon: .symbol("clock.arrow.circlepath"), keywords: ["agent", "history", "conversations", "resume"], feature: id, data: ["type": "history"], kindLabel: "Agent")]
        // The "Ask Glide Agent" fallback row is owned by the Fallbacks feature (fallbacks:agent), so it follows the
        // user's fallback order and enable switches; it calls `agent/open {prompt, fresh}`.
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        if item.data?["type"]?.stringValue == "history" { return [ItemAction(id: "history", title: "Open Agent History", shortcut: "↩", icon: "clock.arrow.circlepath")] }
        return [ItemAction(id: "ask", title: "Ask Glide Agent", shortcut: "↩", icon: "wand.and.stars"),
                ItemAction(id: "settings", title: "Agent Settings…", shortcut: "⌘↩", icon: "gearshape"),
                ItemAction(id: "history", title: "Agent History", icon: "clock.arrow.circlepath")]
    }

    public func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        switch action {
        case "settings": return .openSettings(page: id)
        case "history":
            reloadHistory()
            return .pushView(Self.historyView)
        case "ask":
            let prompt = item.argument?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            prepareView(conversationId: nil, fresh: !prompt.isEmpty)
            if !prompt.isEmpty { _ = await startRun(prompt: prompt, conversationId: nil) }
            return .pushView(Self.runView)
        default: return .error("Unknown action \(action)")
        }
    }

    // MARK: runs

    private func newRunId() -> String {
        seq += 1
        return "r\(String(Int64(agentNowMs()), radix: 36))\(seq)"
    }

    /// Points agent.run at a conversation (nil + !fresh: keep the latest one of this session).
    func prepareView(conversationId: String?, fresh: Bool) {
        model.error = nil
        if fresh {
            model.conversationId = nil
            model.conversationTitle = nil
            model.runs = []
        } else if let cid = conversationId, let c = sessions?.get(cid) {
            show(c)
        } else if model.conversationId == nil, let c = sessions?.latest(), !c.runs.isEmpty {
            show(c)
        }
        model.revision += 1
    }

    private func show(_ c: AgentLiveConversation) {
        model.conversationId = c.id
        model.conversationTitle = c.title
        model.runs = c.runs.map { r in runs[r.runId]?.snapshot ?? r }
    }

    func isBusy(_ conversationId: String) -> Bool { runs.values.contains { $0.conversationId == conversationId && $0.active } }

    /// Starts a request (a follow-up when `conversationId` or the view's conversation is set). Returns the run id.
    @discardableResult
    func startRun(prompt raw: String, conversationId: String?) async -> (ok: Bool, runId: String?, error: String?) {
        guard let ctx = context, let sessions else { return (false, nil, "Agent not started") }
        let prompt = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000))
        if prompt.isEmpty { return fail("Type what you want Glide to do") }
        let client: any AIModelClient
        do { client = try makeClient() } catch {
            let m = (error as? AgentClientError)?.message ?? error.localizedDescription
            return fail(m.isEmpty ? "Add an Anthropic or OpenAI API key in Settings → AI to use Glide Agent." : m)
        }
        let runId = newRunId()
        let cid = conversationId ?? model.conversationId
        let conv = cid.flatMap { sessions.get($0) } ?? sessions.create(cid ?? "c\(runId)", prompt: prompt)
        if isBusy(conv.id) { return fail("Glide Agent is still working on this conversation — press esc to stop it first") }
        let (aiModel, effort) = aiModel
        let s = settings
        let snap = AgentRunSnapshot(runId: runId, conversationId: conv.id, prompt: prompt, status: .running, entries: [.prompt(id: "\(runId)-p", text: prompt)],
                                    toolCalls: 0, maxToolCalls: AgentLoop.maxToolCalls, model: aiModel, readOnly: s.readOnly ? true : nil, startedAt: agentNowMs())
        let run = Run(id: runId, conversationId: conv.id, snapshot: snap)
        runs[runId] = run
        runOrder.append(runId)
        trimRuns()
        sessions.putRun(conv, snap)
        if model.conversationId == conv.id || model.conversationId == nil { show(conv) }
        model.error = nil
        model.revision += 1

        let caps: any AgentCapabilities
        if let o = capabilitiesOverride { caps = o(ctx) } else {
            let live = LiveAgentCapabilities(ctx: ctx)
            live.onLauncherHidden = { [weak run] in run?.hidden = true }
            await live.refreshFeatures(Self.probedFeatures)
            caps = live
        }
        let builtin = AgentTools.all().filter { $0.requires == nil || caps.hasFeature($0.requires ?? "") }
        let context = [AgentPrompt.context(), s.readOnly ? "Read-only mode is on: only look things up; you can't change anything." : ""].filter { !$0.isEmpty }.joined(separator: "\n")
        let history = conv.messages
        run.task = Task { @MainActor [weak self] in
            guard let self else { return }
            let extra = await self.mcp?.agentTools() ?? (tools: [], problems: [])
            var loop = AgentLoop(runId: runId, conversationId: conv.id, prompt: prompt, history: history, client: client, tools: builtin + extra.tools, caps: caps, model: aiModel)
            loop.effort = effort
            loop.context = context
            loop.notices = extra.problems
            loop.readOnly = s.readOnly
            loop.isAllowed = { [weak self] tool in self?.settings.allow[tool] == true }
            loop.takeRateLimit = { [weak self] _ in self?.limiter.take() }
            loop.confirm = { [weak self, weak run] confirmation, _ in
                guard let self, let run else { return false }
                return await self.awaitConfirmation(run, confirmation)
            }
            loop.onChange = { [weak self, weak run] snap in
                guard let self, let run else { return }
                run.snapshot = snap
                self.sessions?.putRun(conv, snap)
                self.publish(snap)
            }
            let out = await loop.run()
            run.snapshot = out.snapshot
            run.pending = nil
            conv.messages = out.messages
            conv.undos[runId] = out.undos
            self.sessions?.putRun(conv, out.snapshot)
            self.sessions?.persist(conv)
            self.publish(out.snapshot)
            if out.snapshot.status != .cancelled { self.reopen(run) }
        }
        return (true, runId, nil)

        func fail(_ m: String) -> (ok: Bool, runId: String?, error: String?) {
            model.error = m
            model.revision += 1
            return (false, nil, m)
        }
    }

    private func trimRuns() {
        while runOrder.count > Self.keepRuns, let oldest = runOrder.first(where: { runs[$0]?.active == false }) {
            runs[oldest] = nil
            runOrder.removeAll { $0 == oldest }
        }
    }

    private func publish(_ snap: AgentRunSnapshot) {
        guard model.conversationId == snap.conversationId else { return }
        if let i = model.runs.firstIndex(where: { $0.runId == snap.runId }) { model.runs[i] = snap } else { model.runs.append(snap) }
        model.revision += 1
    }

    /// A tool hid the launcher: bring agent.run back (for a confirmation or the summary).
    private func reopen(_ run: Run) {
        guard run.hidden, let ctx = context else { return }
        run.hidden = false
        if let c = sessions?.get(run.conversationId) { show(c) }
        // integration: LauncherViewHost.viewStack — don't stack a second agent.run when it is still on top.
        if LauncherHosts.current?.viewStack.last == Self.runView { ctx.showLauncher() } else { ctx.push(Self.runView, payload: ["runId": .string(run.id)]) }
        LauncherHosts.current?.setPlaceholder("Follow up… (⌘N new conversation)")
    }

    private func awaitConfirmation(_ run: Run, _ c: AgentConfirmation) async -> Bool {
        if Task.isCancelled { return false }
        reopen(run)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                var done = false
                let resume: (Bool) -> Void = { ok in
                    guard !done else { return }
                    done = true
                    cont.resume(returning: ok)
                }
                run.pending = (c.id, resume)
                // An unanswered confirmation (launcher dismissed and never reopened) declines itself.
                Task { @MainActor [weak run] in
                    try? await Task.sleep(for: Self.confirmTimeout)
                    if let run, run.pending?.id == c.id { run.pending = nil; resume(false) }
                }
            }
        } onCancel: {
            Task { @MainActor [weak run] in
                let p = run?.pending
                run?.pending = nil
                p?.resume(false)
            }
        }
    }

    /// Answer the pending confirmation. `always` also allow-lists every allowable tool of the confirmation.
    @discardableResult func respond(runId: String, confirmationId: String?, approve: Bool, always: Bool = false) -> Bool {
        guard let run = runs[runId], let p = run.pending, confirmationId == nil || p.id == confirmationId else { return false }
        if approve && always, let ids = run.snapshot.confirmation?.stepIds {
            let ok = allowable
            for s in run.snapshot.steps where ids.contains(s.id) && (ok.contains(s.tool) || MCPSchema.isToolName(s.tool)) { setAllowed(s.tool, true) }
        }
        run.pending = nil
        p.resume(approve)
        return true
    }

    @discardableResult func cancel(runId: String) -> Bool {
        guard let run = runs[runId] else { return false }
        run.task?.cancel()
        let p = run.pending
        run.pending = nil
        p?.resume(false)
        return true
    }

    var activeRun: Run? { runOrder.reversed().compactMap { runs[$0] }.first { $0.active } }

    func waitForRun(_ runId: String) async { await runs[runId]?.task?.value }

    func findRun(_ runId: String) -> (AgentLiveConversation?, AgentRunSnapshot?) {
        let conv = sessions?.ofRun(runId)
        return (conv, runs[runId]?.snapshot ?? conv?.runs.first { $0.runId == runId })
    }

    // MARK: undo & save as workflow

    func undo(runId: String, stepId: String? = nil) async -> JSONValue {
        func res(_ ok: Bool, _ undone: Int, _ failed: Int, _ m: String) -> JSONValue {
            ["ok": .bool(ok), "undone": .int(Int64(undone)), "failed": .int(Int64(failed)), "message": .string(m)]
        }
        let (convOpt, found) = findRun(runId)
        guard let conv = convOpt, var snap = found else { return res(false, 0, 0, "That request is no longer available") }
        if snap.status == .running || snap.status == .confirming { return res(false, 0, 0, "Wait until the request finishes (or press esc to stop it)") }
        let steps = snap.steps.filter { $0.undo?.state == "available" && (stepId == nil || $0.id == stepId) }
        if steps.isEmpty { return res(false, 0, 0, "Nothing to undo") }
        var undone = 0, failed = 0
        var notes: [String] = []
        // Newest first, like a stack.
        for st in steps.reversed() {
            guard let fn = conv.undos[runId]?[st.id] else {
                failed += 1
                snap.updateStep(st.id) { $0.undo?.state = "failed"; $0.undo?.error = "Undo is only available until Glide restarts" }
                continue
            }
            do {
                notes.append(try await fn.run())
                snap.updateStep(st.id) { $0.undo?.state = "done" }
                conv.undos[runId]?[st.id] = nil
                undone += 1
            } catch {
                snap.updateStep(st.id) { $0.undo?.state = "failed"; $0.undo?.error = (error as? AgentToolFailure)?.message ?? error.localizedDescription }
                failed += 1
            }
        }
        let after = snap.steps
        for i in snap.entries.indices {
            if case let .summary(eid, text, _, _) = snap.entries[i] {
                let saveable = AgentWorkflowPlanner.plan(after.map { AgentExecutedStep(step: $0, workflow: $0.workflow) }).isOK
                snap.entries[i] = .summary(id: eid, text: text, undoable: after.filter { $0.undo?.state == "available" }.count, saveable: saveable)
            }
        }
        let message = failed > 0 ? "Undid \(undone), \(failed) couldn't be undone" : "Undid \(undone) change\(undone == 1 ? "" : "s")"
        snap.entries.append(.notice(id: "\(runId)-u\(String(Int64(agentNowMs()), radix: 36))", text: "↶ \(message)\(notes.isEmpty ? "" : " — \(notes.joined(separator: "; "))")", tone: failed > 0 ? "warning" : "info"))
        sessions?.putRun(conv, snap)
        runs[runId]?.snapshot = snap
        publish(snap)
        sessions?.persist(conv)
        return res(undone > 0, undone, failed, message)
    }

    func saveAsWorkflow(runId: String, name: String) -> JSONValue {
        guard let ctx = context else { return ["ok": false, "error": "Agent not started"] }
        guard let snap = findRun(runId).1 else { return ["ok": false, "error": "That request is no longer available"] }
        switch AgentWorkflowPlanner.plan(snap.steps.map { AgentExecutedStep(step: $0, workflow: $0.workflow) }) {
        case let .failed(error, unmapped): return ["ok": false, "error": .string(error), "unmapped": .array(unmapped.map(JSONValue.string))]
        case let .ok(actions):
            let wf = AgentWorkflowPlanner.buildWorkflow(name: String(name.prefix(100)), prompt: snap.prompt, actions: actions, now: agentNowMs())
            ctx.store.saveWorkflow(wf)
            ctx.refreshCatalogue()
            return ["ok": true, "workflowId": .string(wf.id), "name": .string(wf.name), "actions": .int(Int64(wf.actions.count))]
        }
    }

    // MARK: history

    func reloadHistory() {
        model.history = sessions?.list(model.historyQuery) ?? []
        model.historySelected = min(model.historySelected, max(0, model.history.count - 1))
    }

    func deleteConversation(_ id: String) -> Bool {
        for r in runs.values where r.conversationId == id { cancel(runId: r.id) }
        let ok = sessions?.delete(id) ?? false
        if model.conversationId == id { prepareView(conversationId: nil, fresh: true) }
        reloadHistory()
        return ok
    }

    // MARK: test channel / other features

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "start":
            if args["fresh"]?.boolValue == true { prepareView(conversationId: nil, fresh: true) }
            let r = await startRun(prompt: args["prompt"]?.stringValue ?? "", conversationId: args["conversationId"]?.stringValue)
            return ["ok": .bool(r.ok), "runId": r.runId.map(JSONValue.string) ?? .null, "error": r.error.map(JSONValue.string) ?? .null,
                    "conversationId": r.runId.flatMap { runs[$0]?.conversationId }.map(JSONValue.string) ?? .null]
        case "open":
            prepareView(conversationId: args["conversationId"]?.stringValue, fresh: args["fresh"]?.boolValue == true)
            context?.push(Self.runView, payload: args)
            if let p = args["prompt"]?.stringValue, !p.isEmpty { _ = await startRun(prompt: p, conversationId: args["conversationId"]?.stringValue) }
            return viewState()
        case "wait":
            if let id = args["runId"]?.stringValue { await waitForRun(id) }
            return viewState()
        case "respond":
            return .bool(respond(runId: args["runId"]?.stringValue ?? activeRun?.id ?? "", confirmationId: args["confirmationId"]?.stringValue,
                                 approve: args["approve"]?.boolValue == true, always: args["always"]?.boolValue == true))
        case "cancel": return .bool(cancel(runId: args["runId"]?.stringValue ?? args.stringValue ?? activeRun?.id ?? "")) // menubar sends a bare runId
        case "activeRun": return activeRun.map { agentJSON($0.snapshot) } ?? .null
        case "getRun": return findRun(args["runId"]?.stringValue ?? "").1.map(agentJSON) ?? .null
        case "viewState": return viewState()
        case "listConversations":
            return agentJSON(sessions?.list(args["query"]?.stringValue ?? args.stringValue ?? "") ?? [])
        case "getConversation":
            guard let c = sessions?.get(args["id"]?.stringValue ?? args.stringValue ?? "") else { return .null }
            return ["id": .string(c.id), "title": .string(c.title), "createdAt": .double(c.createdAt), "updatedAt": .double(c.updatedAt), "runs": agentJSON(c.runs)]
        case "deleteConversation": return .bool(deleteConversation(args["id"]?.stringValue ?? args.stringValue ?? ""))
        case "clearHistory":
            let n = sessions?.clear() ?? 0
            reloadHistory()
            return .int(Int64(n))
        case "flushHistory":
            sessions?.store.flush()
            return true
        case "undo": return await undo(runId: args["runId"]?.stringValue ?? model.current?.runId ?? "", stepId: args["stepId"]?.stringValue)
        case "saveAsWorkflow": return saveAsWorkflow(runId: args["runId"]?.stringValue ?? model.current?.runId ?? "", name: args["name"]?.stringValue ?? "")
        case "getSettings": return settingsJSON
        case "setSettings": return setSettings(args)
        case "listTools":
            let caps = LiveAgentCapabilities(ctx: try need())
            await caps.refreshFeatures(Self.probedFeatures)
            return .array(AgentTools.all().map { t in
                ["name": .string(t.name), "title": .string(t.title), "description": .string(t.description), "mutating": .bool(t.mutating),
                 "alwaysConfirm": .bool(t.alwaysConfirm), "destructive": .bool(t.destructive), "available": .bool(t.requires.map { caps.hasFeature($0) } ?? true)]
            })
        case "status":
            let hasClient = (try? makeClient()) != nil
            return ["hasKey": .bool(hasClient), "mock": .bool(mockPath != nil), "model": .string(aiModel.model), "readOnly": .bool(settings.readOnly)]
        case "openFromLauncher":
            guard let q = args["query"]?.stringValue ?? args.stringValue, !q.trimmingCharacters(in: .whitespaces).isEmpty, settings.launcherShortcut else { return false }
            return try await invoke(method: "open", args: ["prompt": .string(q), "fresh": true])
        case "runItem":
            // The "Run Glide Command" workflow action (also reachable from other features).
            let id = args["item"]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
            if id.isEmpty { throw FeatureError.invalidArguments("Choose a Glide command") }
            if id.hasPrefix("agent:") { throw FeatureError.invalidArguments("A workflow can't run Glide Agent") }
            let r = await (try need()).executeItem(id: id, argument: args["argument"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 })
            if case let .error(m) = r { throw FeatureError.failed(m) }
            return ["ok": true]
        // MCP servers (Settings → Agent → MCP Servers). Secrets never come back.
        case "mcpList": return .array(mcp?.list() ?? [])
        case "mcpSave": return await mcp?.save(args) ?? .null
        case "mcpSetEnabled": return await mcp?.setEnabled(args["id"]?.stringValue ?? "", args["enabled"]?.boolValue == true) ?? .null
        case "mcpRemove": return .bool(await mcp?.remove(args["id"]?.stringValue ?? args.stringValue ?? "") ?? false)
        case "mcpTest": return await mcp?.test(args["id"] ?? args) ?? .null
        case "mcpReconnect": return await mcp?.reconnect(args["id"]?.stringValue ?? args.stringValue ?? "") ?? .null
        case "mcpImport": return mcp?.importConfig(args["text"]?.stringValue ?? "", apply: args["apply"]?.boolValue == true) ?? .null
        case "mcpAgentTools":
            let t = await mcp?.agentTools() ?? (tools: [], problems: [])
            return ["tools": .array(t.tools.map { ["name": .string($0.name), "title": .string($0.title), "mutating": .bool($0.mutating), "askFirst": .bool($0.askFirst)] }),
                    "problems": .array(t.problems.map(JSONValue.string))]
        case "snapshotSettings":
            let path = args["path"]?.stringValue ?? NSTemporaryDirectory() + "agent-settings.png"
            let size = try AgentSnapshot.render(AnyView(AgentSettingsView(feature: self)), size: NSSize(width: 680, height: 900), to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .double(size.width), "height": .double(size.height)]
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    private func need() throws -> FeatureContext {
        guard let c = context else { throw FeatureError.failed("Agent feature not started") }
        return c
    }

    func viewState() -> JSONValue {
        let cur = model.current
        var o: [String: JSONValue] = ["conversationId": model.conversationId.map(JSONValue.string) ?? .null, "runs": .int(Int64(model.runs.count)),
                                      "error": model.error.map(JSONValue.string) ?? .null]
        if let cur {
            o["run"] = agentJSON(cur)
            o["status"] = .string(cur.status.rawValue)
            o["confirming"] = .bool(cur.status == .confirming)
        }
        return .object(o)
    }

    // MARK: UI

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Agent", symbol: "wand.and.stars", order: 45) { [weak self] in
            guard let self else { return AnyView(EmptyView()) }
            return AnyView(AgentSettingsView(feature: self))
        }
    }

    public func launcherView(_ view: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        switch view {
        case Self.runView:
            host.setPlaceholder(model.runs.isEmpty ? "What should Glide do? e.g. “Safari left, Notes right”" : "Follow up… (⌘N new conversation)")
            host.setFooter(primary: footerPrimary, hasActions: false)
            return AnyView(AgentRunView(model: model, query: host.query))
        case Self.historyView:
            host.setPlaceholder("Search agent conversations…")
            host.setFooter(primary: model.history.isEmpty ? nil : "Resume", hasActions: false)
            if model.historyQuery != host.query {
                model.historyQuery = host.query
                reloadHistory()
            }
            return AnyView(AgentHistoryView(model: model))
        default: return nil
        }
    }

    var footerPrimary: String? {
        guard let cur = model.current else { return "Ask" }
        switch cur.status {
        case .confirming: return "Run"
        case .running: return nil
        default: return "Send"
        }
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        let host = LauncherHosts.current
        let plainMods = !key.meta && !key.ctrl && !key.alt
        if view == Self.historyView {
            switch (key.key, key.meta, key.ctrl) {
            case ("ArrowDown", false, false), ("n", false, true), ("j", false, true): moveHistory(1); return true
            case ("ArrowUp", false, false), ("p", false, true), ("k", false, true): moveHistory(-1); return true
            case ("Enter", _, false):
                guard model.historySelected < model.history.count else { return true }
                let c = model.history[model.historySelected]
                prepareView(conversationId: c.id, fresh: false)
                host?.push(Self.runView, payload: ["conversationId": .string(c.id)])
                return true
            case ("Backspace", true, false), ("x", false, true):
                guard model.historySelected < model.history.count else { return true }
                _ = deleteConversation(model.history[model.historySelected].id)
                host?.toast("Conversation deleted", style: .info)
                return true
            default: return false
            }
        }
        guard view == Self.runView else { return false }
        let cur = model.current
        if cur?.status == .confirming, let run = cur.flatMap({ runs[$0.runId] }) {
            switch key.key {
            case "Enter" where !key.ctrl && !key.alt:
                respond(runId: run.id, confirmationId: nil, approve: true, always: key.meta)
                return true
            case "Escape" where plainMods:
                respond(runId: run.id, confirmationId: nil, approve: false)
                return true
            default: break
            }
        }
        if cur?.status == .running, key.key == "Escape", plainMods, let id = cur?.runId {
            cancel(runId: id)
            host?.toast("Stopping…", style: .info)
            return true
        }
        if key.key == "Enter" && plainMods {
            let q = host?.query ?? ""
            guard !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
            Task { @MainActor in
                let r = await self.startRun(prompt: q, conversationId: self.model.conversationId)
                if r.ok { LauncherHosts.current?.setQuery("") }
            }
            return true
        }
        if key.meta && !key.ctrl {
            switch key.key.lowercased() {
            case "z":
                guard let id = cur?.runId else { return true }
                Task { @MainActor in
                    let r = await self.undo(runId: id)
                    host?.toast(r["message"]?.stringValue ?? "", style: r["ok"]?.boolValue == true ? .success : .info)
                }
                return true
            case "s":
                guard let id = cur?.runId else { return true }
                let r = saveAsWorkflow(runId: id, name: "")
                host?.toast(r["ok"]?.boolValue == true ? "Saved workflow “\(r["name"]?.stringValue ?? "")”" : (r["error"]?.stringValue ?? "Couldn't save"),
                            style: r["ok"]?.boolValue == true ? .success : .error)
                return true
            case "n":
                if let c = cur, c.status == .running || c.status == .confirming { cancel(runId: c.runId) }
                prepareView(conversationId: nil, fresh: true)
                return true
            case "y":
                reloadHistory()
                host?.push(Self.historyView, payload: .null)
                return true
            default: break
            }
        }
        return false
    }

    private func moveHistory(_ d: Int) {
        guard !model.history.isEmpty else { return }
        model.historySelected = max(0, min(model.history.count - 1, model.historySelected + d))
    }

}
