import Foundation
import GlideCore

/// How to put back what a step changed. Memory only (never persisted).
struct AgentUndo {
    var summary: String
    var run: @MainActor () async throws -> String
    init(summary: String, run: @escaping @MainActor () async throws -> String) {
        self.summary = summary
        self.run = run
    }
}

struct AgentToolOutput {
    var text: String
    var undo: AgentUndo?
    /// Workflow equivalent of what this call did (Save as Workflow).
    var workflow: [AgentWorkflowStep]?
    init(text: String, undo: AgentUndo? = nil, workflow: [AgentWorkflowStep]? = nil) {
        self.text = text
        self.undo = undo
        self.workflow = workflow
    }
}

/// Thrown by a tool's run to produce an is_error tool result.
struct AgentToolFailure: Error, LocalizedError, Equatable {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct AgentPreparedCall {
    var describe: @MainActor () async -> String
    var run: @MainActor () async throws -> AgentToolOutput
    init(describe: @escaping @MainActor () async -> String, run: @escaping @MainActor () async throws -> AgentToolOutput) {
        self.describe = describe
        self.run = run
    }
}

enum AgentPrepared {
    case ready(AgentPreparedCall)
    case invalid(String)
}

/// One tool offered to the model (built-in or MCP). Definition + safety metadata + prepare (validate) step.
struct AgentTool {
    var name: String
    var title: String
    var description: String
    var mutating: Bool
    /// Ask every time, even if "allow without asking" is on (kill a process, run a shortcut).
    var alwaysConfirm = false
    /// Counted by the destructive-tool rate limit.
    var destructive = false
    /// Not state-changing, but still confirmed unless allow-listed (read-only MCP tools of an untrusted server).
    var askFirst = false
    var sensitiveResult = false
    var sensitiveArgs: [String] = []
    /// Feature id this tool needs; hidden when that feature isn't installed.
    var requires: String?
    /// JSON Schema (input_schema).
    var schema: JSONValue
    var prepare: @MainActor (_ input: JSONValue, _ caps: any AgentCapabilities) -> AgentPrepared

    init(name: String, title: String, description: String, mutating: Bool, schema: JSONValue,
                prepare: @escaping @MainActor (_ input: JSONValue, _ caps: any AgentCapabilities) -> AgentPrepared) {
        self.name = name
        self.title = title
        self.description = description
        self.mutating = mutating
        self.schema = schema
        self.prepare = prepare
    }
}

/// Argument parsing helpers (tooling.ts).
struct AgentArgs {
    let input: [String: JSONValue]
    init(_ input: [String: JSONValue]) { self.input = input }

    struct Bad: Error { let message: String }

    /// Optional string; error on wrong type / too long.
    func str(_ key: String, max: Int) throws -> String? {
        guard let v = input[key] else { return nil }
        switch v {
        case .null: return nil
        case let .string(s):
            if s.isEmpty { return nil }
            if s.count > max { throw Bad(message: "\"\(key)\" is too long (max \(max) characters)") }
            return s
        default: throw Bad(message: "\"\(key)\" must be a string")
        }
    }

    func req(_ key: String, max: Int) throws -> String {
        guard let s = try str(key, max: max), !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Bad(message: "\"\(key)\" is required") }
        return s
    }

    func int(_ key: String, _ def: Int, _ lo: Int, _ hi: Int) -> Int {
        guard let d = input[key]?.doubleValue, d.isFinite else { return def }
        return Swift.max(lo, Swift.min(hi, Int(d.rounded())))
    }

    func num(_ key: String) -> Double {
        guard let d = input[key]?.doubleValue, d.isFinite else { return 0 }
        return d
    }

    func bool(_ key: String) -> Bool? { input[key]?.boolValue }
}

enum AgentText {
    static let maxResult = 6000

    static func clip(_ text: String, _ max: Int = maxResult) -> String {
        text.count > max ? "\(text.prefix(max))… [truncated \(text.count - max) characters]" : text
    }

    static func quote(_ s: String) -> String { "“\(s.count > 80 ? "\(s.prefix(80))…" : s)”" }

    static func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }

    /// Compact JSON for tool results.
    static func json(_ v: JSONValue) -> String {
        (try? String(decoding: JSONEncoder.glideCompact.encode(v), as: UTF8.self)) ?? "null"
    }
}

/// Object schema shorthand.
func agentSchema(_ properties: [String: JSONValue] = [:], required: [String] = []) -> JSONValue {
    var o: [String: JSONValue] = ["type": "object", "properties": .object(properties), "additionalProperties": false]
    if !required.isEmpty { o["required"] = .array(required.map(JSONValue.string)) }
    return .object(o)
}

func agentProp(_ type: String, _ description: String? = nil, enumValues: [String]? = nil) -> JSONValue {
    var o: [String: JSONValue] = ["type": .string(type)]
    if let description { o["description"] = .string(description) }
    if let enumValues { o["enum"] = .array(enumValues.map(JSONValue.string)) }
    return .object(o)
}

/// Builds a tool from parse/describe/run closures (defineTool).
@MainActor func agentDefine<A>(
    name: String, title: String, description: String, mutating: Bool, schema: JSONValue,
    alwaysConfirm: Bool = false, destructive: Bool = false, sensitiveResult: Bool = false, sensitiveArgs: [String] = [], requires: String? = nil,
    parse: @escaping @MainActor (AgentArgs) throws -> A,
    describe: @escaping @MainActor (A, any AgentCapabilities) async -> String,
    run: @escaping @MainActor (A, any AgentCapabilities) async throws -> AgentToolOutput
) -> AgentTool {
    var t = AgentTool(name: name, title: title, description: description, mutating: mutating, schema: schema) { input, caps in
        guard case let .object(o) = input else { return .invalid("Tool input must be a JSON object") }
        let parsed: A
        do { parsed = try parse(AgentArgs(o)) } catch let e as AgentArgs.Bad { return .invalid(e.message) } catch { return .invalid(error.localizedDescription) }
        return .ready(AgentPreparedCall(describe: { await describe(parsed, caps) }, run: { try await run(parsed, caps) }))
    }
    t.alwaysConfirm = alwaysConfirm
    t.destructive = destructive
    t.sensitiveResult = sensitiveResult
    t.sensitiveArgs = sensitiveArgs
    t.requires = requires
    return t
}

/// Result of an operation in another feature (`{ok, message, error}`, a bool, or anything).
struct AgentOp {
    var ok: Bool
    var message: String?
    var error: String?

    static func from(_ v: JSONValue, fallback: String = "Done") -> AgentOp {
        switch v {
        case let .bool(b): return AgentOp(ok: b, message: fallback, error: b ? nil : "Failed")
        case let .object(o):
            return AgentOp(ok: o["ok"]?.boolValue != false, message: o["message"]?.stringValue ?? fallback, error: o["error"]?.stringValue)
        default: return AgentOp(ok: true, message: fallback)
        }
    }

    /// The message, or throws the error.
    func text(_ fallback: String) throws -> String {
        if !ok { throw AgentToolFailure(error ?? "Failed") }
        return message ?? fallback
    }
}

/// The agent's own workflow action: run any catalogue item.
enum AgentWorkflow {
    static let runItemAction = "runItem"
    static func runItem(_ itemId: String, argument: String? = nil, label: String? = nil) -> AgentWorkflowStep {
        AgentWorkflowStep(type: "feature", params: ["feature": "agent", "action": runItemAction, "item": itemId, "argument": argument ?? ""], label: label)
    }
    static func feature(_ feature: String, _ action: String, _ params: [String: String], label: String? = nil) -> AgentWorkflowStep {
        var p = params
        p["feature"] = feature
        p["action"] = action
        return AgentWorkflowStep(type: "feature", params: p, label: label)
    }
}
