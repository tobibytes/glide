import Foundation
import GlideCore

/// One step of a run (RunLogEntry in src/shared/types.ts, plus the step's display title and nesting depth).
public struct WorkflowRunLogEntry: Hashable, Sendable, Codable {
    /// "ok" | "error" | "skipped"
    public enum Status: String, Hashable, Sendable, Codable { case ok, error, skipped }
    public var actionId: String
    public var type: String
    public var status: Status
    public var startedAt: Double
    public var endedAt: Double
    public var output: String?
    public var error: String?
    public var title: String?
    /// 0 = top level; nested workflow runs and branches are deeper.
    public var depth: Int?
}

/// RunResult in src/shared/types.ts.
public struct WorkflowRunResult: Hashable, Sendable, Codable {
    public var workflowId: String
    public var ok: Bool
    public var log: [WorkflowRunLogEntry]
    public var variables: [String: String]
    public var result: String?
    /// Native extras: wall time, how it was started and whether the run was cancelled.
    public var startedAt: Double?
    public var durationMs: Double?
    public var cancelled: Bool?
    public var source: String?

    public var firstError: String? { log.first { $0.status == .error }?.error }

    public var json: JSONValue {
        (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder.glide.encode(self))) ?? .null
    }
}

/// Everything a run touches outside the runtime. The app uses `ServicesWorkflowEnvironment`; tests use fakes.
@MainActor public protocol WorkflowEnvironment: AnyObject {
    func workflow(id: String) -> Workflow?
    func openApp(_ app: String) async throws
    func openURL(_ url: URL) async throws
    func openFile(_ path: String) async throws
    /// Runs `command` in `shell` as a login shell (`-l -c`); throws only when it could not start.
    func runShell(_ command: String, shell: String, timeout: TimeInterval) async throws -> ShellResult
    func runAppleScript(_ source: String) async throws -> String
    /// Paste into the frontmost app (the launcher steps aside first).
    func typeText(_ text: String) async throws
    func readClipboard() -> String
    func writeClipboard(_ text: String)
    func notify(title: String, body: String) async throws
    func sleep(seconds: Double) async throws
    /// Ask in the launcher; nil = cancelled.
    func askInput(prompt: String, placeholder: String?) async -> String?
    func showResult(text: String, title: String?)
    func http(method: String, url: URL, headers: [String: String], body: String?, timeout: TimeInterval) async throws -> (status: Int, body: String)
    func playSound(_ name: String) async throws
    /// Text selected in the user's app ({{selection}}), read only when a step references it.
    func selectedText() async -> String
    func now() -> Date
}

/// Executes the data.json workflow format unchanged (src/main/workflows/runtime.ts).
@MainActor public final class WorkflowRuntime {
    public static let maxDepth = 5
    public static let shellTimeout: TimeInterval = 30
    public static let httpTimeout: TimeInterval = 20
    public static let maxWaitSeconds: Double = 600

    public let env: WorkflowEnvironment
    public let registry: WorkflowActionRegistry
    /// Called after each finished step (live run log in the editor).
    public var onStep: ((WorkflowRunLogEntry) -> Void)?

    public init(env: WorkflowEnvironment, registry: WorkflowActionRegistry = .shared) {
        self.env = env
        self.registry = registry
    }

    final class Ctx {
        var vars: [String: String]
        var log: [WorkflowRunLogEntry] = []
        let depth: Int
        var selectionLoaded = false
        init(vars: [String: String], depth: Int) {
            self.vars = vars
            self.depth = depth
        }
    }

    public func run(_ wf: Workflow, input: String = "", source: String? = nil) async -> WorkflowRunResult {
        var r = await run(wf, input: input, depth: 0)
        r.source = source
        return r
    }

    func run(_ stored: Workflow, input: String, depth: Int) async -> WorkflowRunResult {
        let wf = WorkflowMigration.migrate(stored)
        let started = env.now()
        var vars = WorkflowTemplate.builtinVariables(now: started)
        vars["input"] = input
        vars["clipboard"] = env.readClipboard()
        vars["selection"] = ""
        vars["result"] = ""
        let ctx = Ctx(vars: vars, depth: depth)
        var ok = true
        var cancelled = false
        do {
            try await runActions(wf.actions, ctx, nest: 0)
        } catch is CancellationError {
            ok = false
            cancelled = true
        } catch {
            ok = false // the failing entry is already in the log
        }
        let ended = env.now()
        return WorkflowRunResult(workflowId: wf.id, ok: ok, log: ctx.log, variables: ctx.vars, result: ctx.vars["result"],
                                 startedAt: ms(started), durationMs: (ended.timeIntervalSince(started) * 1000).rounded(), cancelled: cancelled ? true : nil)
    }

    private func ms(_ d: Date) -> Double { (d.timeIntervalSince1970 * 1000).rounded() }

    private func title(_ a: WorkflowAction) -> String {
        if let l = a.label, !l.isEmpty { return l }
        return WorkflowSpecs.spec(for: a, in: registry.allSpecs)?.title ?? (a.type == "feature" ? "\(a.param("feature") ?? "?").\(a.param("action") ?? "?")" : a.type)
    }

    func runActions(_ actions: [WorkflowAction], _ ctx: Ctx, nest: Int) async throws {
        for action in actions {
            try Task.checkCancellation()
            let startedAt = ms(env.now())
            let depth = ctx.depth + nest
            if action.disabled == true {
                append(ctx, WorkflowRunLogEntry(actionId: action.id, type: action.type, status: .skipped, startedAt: startedAt, endedAt: startedAt, title: title(action), depth: depth))
                continue
            }
            if !ctx.selectionLoaded, action.params.values.contains(where: { WorkflowTemplate.references($0.description).contains("selection") }) {
                ctx.selectionLoaded = true
                ctx.vars["selection"] = await env.selectedText()
            }
            let params = WorkflowTemplate.substituteParams(action.params, ctx.vars)
            do {
                let output = try await perform(action, params, ctx, nest: nest)
                if let output { ctx.vars["result"] = output }
                // A condition logs its branch steps itself; keep its own entry after them like Electron.
                append(ctx, WorkflowRunLogEntry(actionId: action.id, type: action.type, status: .ok, startedAt: startedAt, endedAt: ms(env.now()), output: output, title: title(action), depth: depth))
            } catch let e as CancellationError {
                append(ctx, WorkflowRunLogEntry(actionId: action.id, type: action.type, status: .error, startedAt: startedAt, endedAt: ms(env.now()), error: "Cancelled", title: title(action), depth: depth))
                throw e
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                append(ctx, WorkflowRunLogEntry(actionId: action.id, type: action.type, status: .error, startedAt: startedAt, endedAt: ms(env.now()), error: message, title: title(action), depth: depth))
                if action.param("continueOnError") != "true" { throw error }
            }
        }
    }

    private func append(_ ctx: Ctx, _ e: WorkflowRunLogEntry) {
        ctx.log.append(e)
        onStep?(e)
    }

    // Each action returns the text that becomes {{result}} (and its outputVar).
    func perform(_ action: WorkflowAction, _ p: [String: String], _ ctx: Ctx, nest: Int) async throws -> String? {
        switch action.type {
        case "openApp":
            guard let app = p["app"]?.trimmingCharacters(in: .whitespaces), !app.isEmpty else { throw WorkflowStepError("No application selected") }
            try await env.openApp(app)
            return nil
        case "openUrl":
            let raw = (p["url"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard Self.hasScheme(raw), let url = URL(string: raw) ?? URL(string: raw.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "") else {
                throw WorkflowStepError("Invalid URL: \(raw)")
            }
            try await env.openURL(url)
            return nil
        case "runShell":
            let shell = (p["shell"].map { $0.hasPrefix("/") ? $0 : "/bin/zsh" }) ?? "/bin/zsh"
            let res = try await env.runShell(p["command"] ?? "", shell: shell, timeout: Self.shellTimeout)
            if res.status != 0 {
                let msg = (res.stderr.isEmpty ? res.stdout : res.stderr).trimmingCharacters(in: .whitespacesAndNewlines)
                throw WorkflowStepError(msg.isEmpty ? "exit code \(res.status)" : msg)
            }
            var out = res.stdout
            if out.hasSuffix("\n") { out.removeLast() }
            ctx.vars["stdout"] = out
            return out
        case "runAppleScript":
            let out = try await env.runAppleScript(p["script"] ?? "")
            ctx.vars["scriptResult"] = out
            return out
        case "typeText":
            try await env.typeText(p["text"] ?? "")
            return nil
        case "setClipboard":
            let t = p["text"] ?? ""
            env.writeClipboard(t)
            ctx.vars["clipboard"] = t
            return t
        case "getClipboard":
            let t = env.readClipboard()
            ctx.vars["clipboard"] = t
            return t
        case "notify":
            let t = p["title"].flatMap { $0.isEmpty ? nil : $0 } ?? "Glide"
            try await env.notify(title: t, body: p["body"] ?? "")
            return nil
        case "wait":
            let seconds = min(max(WorkflowTemplate.jsNumber(p["seconds"] ?? "") ?? 0, 0), Self.maxWaitSeconds)
            try await env.sleep(seconds: seconds)
            return nil
        case "askInput":
            let prompt = p["prompt"].flatMap { $0.isEmpty ? nil : $0 } ?? "Input"
            guard let answer = await env.askInput(prompt: prompt, placeholder: p["placeholder"].flatMap { $0.isEmpty ? nil : $0 }) else {
                throw WorkflowStepError("Cancelled")
            }
            ctx.vars["input"] = answer
            return answer
        case "setVariable":
            let name = (p["name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard WorkflowTemplate.isValidName(name) else { throw WorkflowStepError("Invalid variable name \"\(name)\"") }
            let v = p["value"] ?? ""
            ctx.vars[name] = v
            return v
        case "condition":
            let yes = WorkflowTemplate.evaluateCondition(p["left"] ?? "", p["operator"] ?? "equals", p["right"] ?? "")
            try await runActions((yes ? action.then : action.else) ?? [], ctx, nest: nest + 1)
            return nil
        case "httpRequest":
            let method = (p["method"].flatMap { $0.isEmpty ? nil : $0 } ?? "GET").uppercased()
            let raw = (p["url"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard Self.hasScheme(raw), let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
                throw WorkflowStepError("Invalid URL: \(raw)")
            }
            let body = method == "GET" || method == "HEAD" || (p["body"] ?? "").isEmpty ? nil : p["body"]
            let res = try await env.http(method: method, url: url, headers: Self.parseHeaders(p["headers"] ?? ""), body: body, timeout: Self.httpTimeout)
            ctx.vars["response"] = res.body
            ctx.vars["status"] = String(res.status)
            if !(200..<300).contains(res.status) { throw WorkflowStepError("HTTP \(res.status): \(String(res.body.prefix(200)))") }
            return res.body
        case "runWorkflow":
            if ctx.depth >= Self.maxDepth { throw WorkflowStepError("Workflow nesting deeper than \(Self.maxDepth)") }
            let wid = p["workflowId"] ?? ""
            guard let target = env.workflow(id: wid) else { throw WorkflowStepError("Workflow not found: \(wid)") }
            let input = p["input"] ?? ctx.vars["result"] ?? ""
            let sub = await run(target, input: input, depth: ctx.depth + 1)
            for var e in sub.log {
                e.depth = (e.depth ?? 0) + nest
                ctx.log.append(e)
            }
            if sub.cancelled == true { throw CancellationError() }
            if !sub.ok { throw WorkflowStepError("“\(target.name)” failed: \(sub.firstError ?? "unknown error")") }
            ctx.vars["workflowResult"] = sub.result ?? ""
            return sub.result ?? ""
        case "showResult":
            let t = p["text"] ?? ""
            env.showResult(text: t, title: p["title"].flatMap { $0.isEmpty ? nil : $0 })
            return t
        case "openFile":
            let path = Self.expandHome(p["path"] ?? "")
            guard !path.isEmpty else { throw WorkflowStepError("No file chosen") }
            try await env.openFile(path)
            return nil
        case "playSound":
            let name = (p["name"].flatMap { $0.isEmpty ? nil : $0 } ?? "Glass").filter { $0.isASCII && $0.isLetter }
            try await env.playSound(name.isEmpty ? "Glass" : name)
            return nil
        case "feature":
            let out = try await registry.run(params: p, vars: ctx.vars)
            for (k, v) in out.vars { ctx.vars[k] = v }
            if let ov = out.outputVar, let r = out.result { ctx.vars[ov] = r }
            return out.result
        default:
            throw WorkflowStepError("Unknown action type “\(action.type)”")
        }
    }

    static func hasScheme(_ s: String) -> Bool {
        guard let colon = s.firstIndex(of: ":"), colon != s.startIndex else { return false }
        let scheme = s[s.startIndex..<colon]
        guard let first = scheme.unicodeScalars.first, first.isASCII, CharacterSet.letters.contains(first) else { return false }
        return scheme.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "+.-".unicodeScalars.contains($0)) }
    }

    public static func parseHeaders(_ raw: String) -> [String: String] {
        var h: [String: String] = [:]
        for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let i = line.firstIndex(of: ":"), i != line.startIndex else { continue }
            h[line[line.startIndex..<i].trimmingCharacters(in: .whitespaces)] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        return h
    }

    public static func expandHome(_ p: String, home: String = NSHomeDirectory()) -> String {
        let t = p.trimmingCharacters(in: .whitespacesAndNewlines)
        if t == "~" { return home }
        if t.hasPrefix("~/") { return home + t.dropFirst() }
        return t
    }
}

/// Variables available to a step in the editor (availableVariables in lib/workflowTree.ts): built-ins, then
/// the outputs and setVariable names of every step that runs before `path`.
public enum WorkflowVariables {
    public struct Variable: Hashable, Sendable, Identifiable {
        public var name: String
        public var hint: String
        public var id: String { name }
    }

    public static let builtins: [Variable] = [
        .init(name: "input", hint: "Launcher argument or answer"), .init(name: "result", hint: "Previous step's output"),
        .init(name: "clipboard", hint: "Clipboard text"), .init(name: "selection", hint: "Selected text in your app"),
        .init(name: "date", hint: "Today's date"), .init(name: "time", hint: "Current time"), .init(name: "timestamp", hint: "Unix ms"),
    ]

    public static func available(before path: WorkflowPath, in root: [WorkflowAction], specs: [WorkflowActionSpec]) -> [Variable] {
        var out = builtins
        var seen = Set(out.map(\.name))
        func add(_ name: String, _ hint: String) {
            guard !name.isEmpty, seen.insert(name).inserted else { return }
            out.append(Variable(name: name, hint: hint))
        }
        var reached = false
        WorkflowTree.walk(root) { a, p in
            if p == path { reached = true }
            if reached || a.disabled == true { return }
            let spec = WorkflowSpecs.spec(for: a, in: specs)
            if let ov = spec?.outputVar { add(ov, spec?.title ?? a.type) }
            switch a.type {
            case "setVariable": if let n = a.param("name")?.trimmingCharacters(in: .whitespaces), WorkflowTemplate.isValidName(n) { add(n, "Set Variable") }
            case "httpRequest": add("status", "HTTP status")
            default: break
            }
        }
        return out
    }
}
