import Foundation
import GlideCore

// Types of the agent transcript, mirroring src/main/features/agent/types.ts field for field so a
// conversations.json written by the Electron app loads here (and the other way round).

public enum AgentStepStatus: String, Codable, Sendable { case queued, awaiting, running, ok, error, declined, skipped }

public struct AgentStepUndo: Codable, Sendable, Equatable {
    /// "available" | "done" | "failed"
    public var summary: String
    public var state: String
    public var error: String?
    public init(summary: String, state: String, error: String? = nil) {
        self.summary = summary
        self.state = state
        self.error = error
    }
}

/// A Glide workflow action equivalent of a step (Save as Workflow).
public struct AgentWorkflowStep: Codable, Sendable, Equatable {
    /// openApp | openUrl | openFile | setClipboard | runWorkflow | runShell | wait | notify | feature
    public var type: String
    public var params: [String: String]
    public var label: String?
    public init(type: String, params: [String: String], label: String? = nil) {
        self.type = type
        self.params = params
        self.label = label
    }
}

public struct AgentStep: Codable, Sendable, Equatable {
    public var id: String
    public var tool: String
    public var title: String
    public var args: [String: JSONValue]
    public var summary: String
    public var mutating: Bool
    public var autoApproved: Bool?
    public var status: AgentStepStatus
    public var result: String?
    public var undo: AgentStepUndo?
    public var sensitive: Bool?
    public var workflow: [AgentWorkflowStep]?

    public init(id: String, tool: String, title: String, args: [String: JSONValue], summary: String, mutating: Bool, status: AgentStepStatus) {
        self.id = id
        self.tool = tool
        self.title = title
        self.args = args
        self.summary = summary
        self.mutating = mutating
        self.status = status
    }
}

public struct AgentPlanItem: Codable, Sendable, Equatable {
    public var text: String
    public var stepId: String?
    public init(text: String, stepId: String? = nil) {
        self.text = text
        self.stepId = stepId
    }
}

/// `TranscriptEntry` (discriminated by "kind").
public enum AgentEntry: Codable, Sendable, Equatable {
    case prompt(id: String, text: String)
    case text(id: String, text: String)
    case step(id: String, step: AgentStep)
    case plan(id: String, title: String, items: [AgentPlanItem])
    case summary(id: String, text: String, undoable: Int, saveable: Bool)
    case notice(id: String, text: String, tone: String)

    public var id: String {
        switch self {
        case let .prompt(id, _), let .text(id, _), let .step(id, _), let .plan(id, _, _), let .summary(id, _, _, _), let .notice(id, _, _): return id
        }
    }

    public var step: AgentStep? { if case let .step(_, s) = self { return s }; return nil }

    enum K: String, CodingKey { case kind, id, text, step, title, items, undoable, saveable, tone }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        switch try c.decode(String.self, forKey: .kind) {
        case "prompt": self = .prompt(id: id, text: (try? c.decode(String.self, forKey: .text)) ?? "")
        case "text": self = .text(id: id, text: (try? c.decode(String.self, forKey: .text)) ?? "")
        case "step": self = .step(id: id, step: try c.decode(AgentStep.self, forKey: .step))
        case "plan": self = .plan(id: id, title: (try? c.decode(String.self, forKey: .title)) ?? "", items: (try? c.decode([AgentPlanItem].self, forKey: .items)) ?? [])
        case "summary":
            self = .summary(id: id, text: (try? c.decode(String.self, forKey: .text)) ?? "", undoable: (try? c.decode(Int.self, forKey: .undoable)) ?? 0,
                            saveable: (try? c.decode(Bool.self, forKey: .saveable)) ?? false)
        case "notice": self = .notice(id: id, text: (try? c.decode(String.self, forKey: .text)) ?? "", tone: (try? c.decode(String.self, forKey: .tone)) ?? "info")
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown transcript entry")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(id, forKey: .id)
        switch self {
        case let .prompt(_, t): try c.encode("prompt", forKey: .kind); try c.encode(t, forKey: .text)
        case let .text(_, t): try c.encode("text", forKey: .kind); try c.encode(t, forKey: .text)
        case let .step(_, s): try c.encode("step", forKey: .kind); try c.encode(s, forKey: .step)
        case let .plan(_, title, items): try c.encode("plan", forKey: .kind); try c.encode(title, forKey: .title); try c.encode(items, forKey: .items)
        case let .summary(_, t, u, s):
            try c.encode("summary", forKey: .kind); try c.encode(t, forKey: .text); try c.encode(u, forKey: .undoable); try c.encode(s, forKey: .saveable)
        case let .notice(_, t, tone): try c.encode("notice", forKey: .kind); try c.encode(t, forKey: .text); try c.encode(tone, forKey: .tone)
        }
    }
}

public enum AgentRunStatus: String, Codable, Sendable { case running, confirming, done, error, cancelled }

public struct AgentConfirmation: Codable, Sendable, Equatable {
    public var id: String
    public var stepIds: [String]
}

public struct AgentRunError: Codable, Sendable, Equatable {
    public var message: String
    /// no-key | auth | permission | rate-limit | overloaded | network | refusal | bad-request | limit | other
    public var kind: String
}

public struct AgentRunSnapshot: Codable, Sendable, Equatable {
    public var runId: String
    public var conversationId: String?
    public var prompt: String
    public var status: AgentRunStatus
    public var entries: [AgentEntry]
    public var confirmation: AgentConfirmation?
    public var toolCalls: Int
    public var maxToolCalls: Int
    public var model: String
    public var readOnly: Bool?
    public var error: AgentRunError?
    public var startedAt: Double
    public var endedAt: Double?

    public var steps: [AgentStep] { entries.compactMap(\.step) }

    mutating func updateStep(_ id: String, _ fn: (inout AgentStep) -> Void) {
        for i in entries.indices {
            if case .step(let eid, var s) = entries[i], s.id == id {
                fn(&s)
                entries[i] = .step(id: eid, step: s)
                return
            }
        }
    }
}

public struct AgentConversationSummary: Codable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var createdAt: Double
    public var updatedAt: Double
    public var runs: Int
    public var preview: String
}

/// An encode/decode round trip through JSONValue (for the test channel and invoke results).
func agentJSON<T: Encodable>(_ v: T) -> JSONValue {
    guard let d = try? JSONEncoder.glideCompact.encode(v), let j = try? JSONDecoder().decode(JSONValue.self, from: d) else { return .null }
    return j
}

func agentDecode<T: Decodable>(_ type: T.Type, _ v: JSONValue) -> T? {
    guard let d = try? JSONEncoder.glideCompact.encode(v) else { return nil }
    return try? JSONDecoder().decode(T.self, from: d)
}

func agentNowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
