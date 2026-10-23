import AppKit
import GlideCore
import GlideUI
import Observation
import SwiftUI

/// Workflows (feature id "workflows"): catalogue items `workflow:<id>`, the native runtime, launcher prompts,
/// the Shortcuts-style editor in Settings and the run log. Supersedes the phase-0 listing in UserContent.
@MainActor public final class WorkflowEngineFeature: Feature, FeatureUI {
    public let id = "workflows"
    public let title = "Workflows"
    weak var context: FeatureContext?
    let registry: WorkflowActionRegistry
    let prompts = WorkflowPrompts()
    let history = WorkflowRunHistory()
    private(set) var environment: WorkflowEnvironment?
    /// Running workflows by id (the editor's Stop button / `cancel`).
    private(set) var running: [String: Task<WorkflowRunResult, Never>] = [:]
    /// Editor selection requested by "Edit Workflow" / openSettings("workflows/<id>") (settings sub-routes are not
    /// passed to pages; see docs/requests/n6.md).
    var requestedSelection: String?
    lazy var editorModel = WorkflowsEditorModel(feature: self)

    public init(registry: WorkflowActionRegistry = .shared) { self.registry = registry }

    /// Tests: inject an environment (fakes) instead of the services-backed one.
    public init(registry: WorkflowActionRegistry, environment: WorkflowEnvironment) {
        self.registry = registry
        self.environment = environment
    }

    public func start(context: FeatureContext) async {
        self.context = context
        prompts.context = context
        if environment == nil { environment = ServicesWorkflowEnvironment(context: context, prompts: prompts) }
        history.load(from: context.dataDirectory())
        BuiltinFeatureActions.registerAll(registry, context: context)
    }

    public func stop() async {
        for t in running.values { t.cancel() }
        prompts.cancelAll()
        history.flush()
    }

    var workflows: [Workflow] { context?.store.data.workflows ?? [] }
    func workflow(_ id: String) -> Workflow? { workflows.first { $0.id == id } }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        workflows.map { wf in
            SearchItem(id: "workflow:\(wf.id)", kind: .workflow, title: wf.name, subtitle: (wf.description?.isEmpty == false ? wf.description : nil) ?? Self.summary(wf),
                       icon: wf.icon, keywords: wf.keywords, alias: wf.alias, workflowId: wf.id, source: "workflows", acceptsArgument: wf.acceptsInput, feature: id)
        }
    }

    static func summary(_ wf: Workflow) -> String {
        let n = WorkflowTree.count(wf.actions)
        return n == 0 ? "Workflow · no actions" : "Workflow · \(n) action\(n == 1 ? "" : "s")"
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        [ItemAction(id: "run", title: "Run Workflow", shortcut: "↩", icon: "play.fill"),
         ItemAction(id: "edit", title: "Edit Workflow", shortcut: "⌘E", icon: "pencil"),
         ItemAction(id: "duplicate", title: "Duplicate Workflow", shortcut: "⌘D", icon: "plus.square.on.square"),
         ItemAction(id: "lastRun", title: "Show Last Run", shortcut: "⌘L", icon: "list.bullet.rectangle"),
         ItemAction(id: "delete", title: "Delete Workflow", shortcut: "⌃X", icon: "trash", destructive: true)]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let ctx = context, let wid = scored.item.workflowId, let wf = workflow(wid) else { return .error("Workflow not found") }
        switch action {
        case "run":
            let resultViewsBefore = prompts.resultsShown
            let r = await run(wf, input: scored.argument ?? "", source: "launcher")
            return launcherResult(r, wf, pushedResult: prompts.resultsShown != resultViewsBefore)
        case "edit":
            requestedSelection = wid
            return .openSettings(page: "workflows/\(wid)")
        case "duplicate":
            let copy = duplicate(wf)
            return .stay(message: "Duplicated as “\(copy.name)”")
        case "lastRun":
            guard history.last(wid) != nil else { return .stay(message: "“\(wf.name)” has not run yet") }
            return .pushView(ViewID(feature: id, name: "run"), payload: ["workflowId": .string(wid)])
        case "delete":
            ctx.store.deleteWorkflow(wid)
            return .stay(message: "Workflow deleted")
        default: return .error("Unknown action \(action)")
        }
    }

    /// Steps that bring another app forward: the launcher steps aside instead of re-showing a toast.
    static let switchingTypes: Set<String> = ["openApp", "openUrl", "openFile", "typeText"]

    func launcherResult(_ r: WorkflowRunResult, _ wf: Workflow, pushedResult: Bool) -> ActionResult {
        if r.cancelled == true || (!r.ok && r.firstError == "Cancelled") { return .stay(message: "Cancelled") }
        guard r.ok else {
            let failed = r.log.first { $0.status == .error }
            return .error("\(failed?.title ?? "Step") failed: \(failed?.error ?? "unknown error")")
        }
        if pushedResult { return .stay(message: nil) }
        if r.log.contains(where: { Self.switchingTypes.contains($0.type) && $0.status == .ok }) {
            context?.hideLauncher()
            return .stay(message: nil)
        }
        return .hide(message: "✓ \(wf.name)")
    }

    @discardableResult
    func duplicate(_ wf: Workflow) -> Workflow {
        var copy = wf
        copy.id = WorkflowIDs.newWorkflowId()
        copy.name = "\(wf.name) Copy"
        copy.actions = wf.actions.map(WorkflowTree.clone)
        copy.hotkey = nil
        copy.alias = nil
        copy.createdAt = 0
        return context?.store.saveWorkflow(copy) ?? copy
    }

    // MARK: running

    /// Run a workflow (launcher, hotkey, automation, editor). Concurrent runs of one workflow are allowed;
    /// `running[id]` tracks the latest for cancellation.
    func run(_ wf: Workflow, input: String, source: String, onStep: ((WorkflowRunLogEntry) -> Void)? = nil) async -> WorkflowRunResult {
        guard let env = environment else {
            return WorkflowRunResult(workflowId: wf.id, ok: false, log: [], variables: [:], result: nil)
        }
        let runtime = WorkflowRuntime(env: env, registry: registry)
        runtime.onStep = onStep
        let task = Task { @MainActor in await runtime.run(wf, input: input, source: source) }
        running[wf.id] = task
        let r = await task.value
        if running[wf.id] == task { running[wf.id] = nil }
        history.record(r, name: wf.name)
        context?.log("ran \(wf.name) [\(source)]: \(r.ok ? "ok" : (r.firstError ?? "failed")) in \(Int(r.durationMs ?? 0)) ms")
        return r
    }

    func cancel(_ workflowId: String) {
        running[workflowId]?.cancel()
        prompts.cancelAll()
    }

    // MARK: test channel / other features

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "run":
            let wf: Workflow
            if let obj = args["workflow"], obj.objectValue != nil {
                wf = try JSONDecoder().decode(Workflow.self, from: JSONEncoder.glide.encode(obj))
            } else {
                let wid = args["workflowId"]?.stringValue ?? args["id"]?.stringValue ?? ""
                guard let w = workflow(wid) else { throw FeatureError.invalidArguments("Workflow not found: \(wid)") }
                wf = w
            }
            let r = await run(wf, input: args["input"]?.stringValue ?? "", source: args["source"]?.stringValue ?? "invoke")
            return r.json
        case "specs":
            return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.glide.encode(registry.allSpecs))
        case "list":
            return .array(workflows.map { ["id": .string($0.id), "name": .string($0.name), "actions": .int(Int64(WorkflowTree.count($0.actions)))] })
        case "save":
            guard let obj = args["workflow"] else { throw FeatureError.invalidArguments("workflow missing") }
            let wf = try JSONDecoder().decode(Workflow.self, from: JSONEncoder.glide.encode(obj))
            let saved = context?.store.saveWorkflow(wf) ?? wf
            return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.glide.encode(saved))
        case "delete":
            context?.store.deleteWorkflow(args["id"]?.stringValue ?? "")
            return true
        case "pendingPrompt":
            guard let p = prompts.pending else { return .null }
            return ["prompt": .string(p.prompt), "placeholder": p.placeholder.map(JSONValue.string) ?? .null]
        case "answer":
            // Answer the open launcher prompt (nil/absent text = cancel).
            return .bool(prompts.answer(args["text"]?.stringValue))
        case "lastRun":
            return history.last(args["workflowId"]?.stringValue ?? "")?.json ?? .null
        case "history":
            return .array(history.runs.map(\.json))
        case "cancel":
            cancel(args["workflowId"]?.stringValue ?? "")
            return true
        case "editorSelection": // test hook: the Settings editor's workflow (after a `workflows/<id>` deep link)
            return ["requested": requestedSelection.map(JSONValue.string) ?? .null, "selectedId": editorModel.selectedId.map(JSONValue.string) ?? .null]
        case "snapshotEditor":
            let path = args["path"]?.stringValue ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-workflow-editor.png").path
            let size = try WorkflowSnapshots.renderEditor(self, workflowId: args["workflowId"]?.stringValue, selectPath: args["select"]?.stringValue,
                                                          libraryOpen: args["library"]?.boolValue ?? false, dark: args["dark"]?.boolValue ?? true, to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .int(Int64(size.width)), "height": .int(Int64(size.height))]
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    // MARK: UI

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Workflows", symbol: "square.stack.3d.up", order: 30, onRoute: { [weak self] r in self?.requestedSelection = r }) { [weak self] in
            guard let self else { return AnyView(EmptyView()) }
            self.editorModel.reload(select: self.requestedSelection)
            self.requestedSelection = nil
            return AnyView(WorkflowsSettingsView(model: self.editorModel))
        }
    }

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        switch vid.name {
        case "prompt":
            host.setPlaceholder(payload["placeholder"]?.stringValue ?? "Type your answer…")
            host.setFooter(primary: "Continue", hasActions: false)
            return AnyView(WorkflowPromptView(prompt: payload["prompt"]?.stringValue ?? "Input", workflow: payload["workflow"]?.stringValue, token: payload["token"]?.stringValue ?? "", prompts: prompts))
        case "result":
            host.setPlaceholder("")
            host.setFooter(primary: "Copy", hasActions: false)
            return AnyView(WorkflowResultView(title: payload["title"]?.stringValue ?? "Result", text: payload["text"]?.stringValue ?? ""))
        case "run":
            host.setPlaceholder("Filter steps…")
            host.setFooter(primary: "Run Again", hasActions: false)
            let wid = payload["workflowId"]?.stringValue ?? ""
            return AnyView(WorkflowRunLogLauncherView(name: workflow(wid)?.name ?? "Workflow", run: history.last(wid), filter: host.query))
        default: return nil
        }
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        let plain = !key.meta && !key.ctrl && !key.alt
        switch view.name {
        case "prompt":
            if key.key == "Enter" && plain {
                prompts.answer(LauncherHosts.current?.query ?? "")
                return true
            }
            if key.key == "Escape" && plain {
                prompts.answer(nil)
                return true
            }
            return false
        case "result":
            if (key.key == "Enter" && plain) || (key.meta && key.key.lowercased() == "c") {
                guard let text = prompts.lastResult?.text else { return true }
                context?.services.pasteboard.setString(text, html: nil, transient: false)
                LauncherHosts.current?.toast("Copied", style: .success)
                return true
            }
            return false
        case "run":
            if key.key == "Enter" && plain, let wid = history.lastViewed, let wf = workflow(wid) {
                Task { @MainActor in
                    LauncherHosts.current?.pop()
                    _ = await self.run(wf, input: "", source: "launcher")
                }
                return true
            }
            return false
        default: return false
        }
    }
}

/// Launcher prompts (askInput) and result views (showResult) for running workflows.
@MainActor final class WorkflowPrompts {
    struct Pending {
        var token: String
        var prompt: String
        var placeholder: String?
        var continuation: CheckedContinuation<String?, Never>
    }
    weak var context: FeatureContext?
    private(set) var pending: Pending?
    private(set) var lastResult: (title: String, text: String)?
    private(set) var resultsShown = 0
    static let timeout: Duration = .seconds(600)

    func ask(prompt: String, placeholder: String?) async -> String? {
        answer(nil) // only one prompt at a time
        let token = UUID().uuidString
        return await withCheckedContinuation { cont in
            pending = Pending(token: token, prompt: prompt, placeholder: placeholder, continuation: cont)
            context?.push(ViewID(feature: "workflows", name: "prompt"),
                          payload: ["prompt": .string(prompt), "placeholder": placeholder.map(JSONValue.string) ?? .null, "token": .string(token)])
            // Before the first render, so the search field already shows the hint.
            LauncherHosts.current?.setPlaceholder(placeholder ?? "Type your answer…")
            LauncherHosts.current?.setFooter(primary: "Continue", hasActions: false)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.timeout)
                if self?.pending?.token == token { self?.answer(nil) }
            }
        }
    }

    /// Resolve the open prompt (nil = cancelled) and pop its view. False when nothing was pending.
    @discardableResult
    func answer(_ text: String?) -> Bool {
        guard let p = pending else { return false }
        pending = nil
        if LauncherHosts.current != nil { LauncherHosts.current?.pop() }
        p.continuation.resume(returning: text)
        return true
    }

    /// The prompt view disappeared without an answer (popped some other way).
    func viewGone(token: String) {
        guard let p = pending, p.token == token else { return }
        pending = nil
        p.continuation.resume(returning: nil)
    }

    func cancelAll() { answer(nil) }

    func showResult(text: String, title: String?) {
        lastResult = (title ?? "Result", text)
        resultsShown += 1
        context?.push(ViewID(feature: "workflows", name: "result"), payload: ["text": .string(text), "title": .string(title ?? "Result")])
        LauncherHosts.current?.setPlaceholder("")
        LauncherHosts.current?.setFooter(primary: "Copy", hasActions: false)
    }
}

/// Recent runs (newest first), persisted to <userData>/features/workflows/runs.json.
@MainActor final class WorkflowRunHistory {
    struct Run: Codable {
        var name: String
        var result: WorkflowRunResult
        var json: JSONValue {
            var j = result.json
            if case var .object(o) = j { o["name"] = .string(name); j = .object(o) }
            return j
        }
    }
    static let limit = 100
    private(set) var runs: [Run] = []
    private var url: URL?
    private var saveTask: Task<Void, Never>?
    var lastViewed: String?
    /// Bumped on every record (the editor observes it).
    var onChange: (() -> Void)?

    func load(from dir: URL) {
        url = dir.appendingPathComponent("runs.json")
        guard let url, let data = try? Data(contentsOf: url), let list = try? JSONDecoder().decode([Run].self, from: data) else { return }
        runs = Array(list.prefix(Self.limit))
    }

    func record(_ r: WorkflowRunResult, name: String) {
        runs.insert(Run(name: name, result: r), at: 0)
        if runs.count > Self.limit { runs.removeLast(runs.count - Self.limit) }
        onChange?()
        saveTask?.cancel()
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    func last(_ workflowId: String) -> WorkflowRunResult? {
        lastViewed = workflowId
        return runs.first { $0.result.workflowId == workflowId }?.result
    }

    func flush() {
        guard let url else { return }
        // Variables can hold clipboard/selection text: keep only the run log and result on disk.
        let slim = runs.map { r -> Run in
            var c = r
            c.result.variables = [:]
            return c
        }
        if let data = try? JSONEncoder.glide.encode(slim) { try? data.write(to: url, options: .atomic) }
    }
}
