import Foundation
import GlideCore

/// One Messages API turn for the agent loop (client.ts TurnRequest).
struct AgentTurnRequest {
    var model: String
    var effort: String
    /// Frozen instructions (cached prefix).
    var system: String
    /// Per-request context (date, time zone) after the cache breakpoint.
    var context: String
    /// `{name, description, input_schema}` tool definitions.
    var tools: [JSONValue]
    /// MessageParam JSON values.
    var messages: [JSONValue]

    /// The Messages API request body (streaming), as the Electron client built it.
    func body(maxTokens: Int = 16000) -> JSONValue {
        var system: [JSONValue] = [["type": "text", "text": .string(self.system), "cache_control": ["type": "ephemeral"]]]
        if !context.isEmpty { system.append(["type": "text", "text": .string(context)]) }
        return ["model": .string(model), "max_tokens": .int(Int64(maxTokens)), "system": .array(system), "tools": .array(tools),
                "messages": .array(messages), "stream": true]
    }
}

struct AgentTurnResult {
    /// Assistant content blocks (text, tool_use, thinking …) to replay unchanged.
    var content: [JSONValue]
    var stopReason: String?
    var model: String
}

struct AgentClientError: Error, LocalizedError {
    var message: String
    /// AgentRunError.kind
    var kind: String
    var errorDescription: String? { message }
}

/// The model the agent talks to. The live implementation adapts the AI feature's Anthropic client
/// (Sources/Features/AI, session N4); tests and GLIDE_AGENT_MOCK use `AgentScriptedClient`.
/// Never reads the API key itself.
@MainActor protocol AIModelClient: AnyObject {
    /// Streams text deltas through `onText`; honours Task cancellation.
    func turn(_ req: AgentTurnRequest, onText: @escaping @MainActor (String) -> Void) async throws -> AgentTurnResult
}

/// Scripted mock (client.ts createMockClient): replays turns by the number of assistant turns in the request.
/// Script shape: `{ "model": "...", "turns": [{ "text": "...", "tool_calls": [{"name","input"}], "stop_reason", "error", "delay_ms" }] }`.
@MainActor final class AgentScriptedClient: AIModelClient {
    struct Turn {
        var text: String?
        var toolCalls: [(name: String, input: JSONValue)] = []
        var stopReason: String?
        var error: String?
        var delayMs: Int = 12
    }

    var model: String
    var turns: [Turn]
    /// Every request seen (tests inspect offered tools and messages).
    private(set) var requests: [AgentTurnRequest] = []

    init(model: String = "mock-model", turns: [Turn]) {
        self.model = model
        self.turns = turns
    }

    convenience init(script: JSONValue) throws {
        guard let list = script["turns"]?.arrayValue else { throw AgentClientError(message: "Mock script needs a turns array", kind: "other") }
        let turns = list.map { t in
            Turn(text: t["text"]?.stringValue,
                 toolCalls: (t["tool_calls"]?.arrayValue ?? []).map { ($0["name"]?.stringValue ?? "", $0["input"] ?? [:]) },
                 stopReason: t["stop_reason"]?.stringValue, error: t["error"]?.stringValue, delayMs: t["delay_ms"]?.intValue ?? 12)
        }
        self.init(model: script["model"]?.stringValue ?? "mock-model", turns: turns)
    }

    static func load(path: String) throws -> AgentScriptedClient {
        guard let d = FileManager.default.contents(atPath: path) else { throw AgentClientError(message: "Mock script not found at \(path)", kind: "other") }
        return try AgentScriptedClient(script: try JSONDecoder().decode(JSONValue.self, from: d))
    }

    func turn(_ req: AgentTurnRequest, onText: @escaping @MainActor (String) -> Void) async throws -> AgentTurnResult {
        requests.append(req)
        let index = req.messages.filter { $0["role"]?.stringValue == "assistant" }.count
        let t = index < turns.count ? turns[index] : Turn(text: "(mock script has no more turns)")
        if let e = t.error { throw AgentClientError(message: e, kind: "other") }
        var content: [JSONValue] = []
        if let text = t.text {
            var word = ""
            for ch in text {
                word.append(ch)
                if ch.isWhitespace {
                    try await Self.sleep(t.delayMs)
                    onText(word)
                    word = ""
                }
            }
            if !word.isEmpty {
                try await Self.sleep(t.delayMs)
                onText(word)
            }
            content.append(["type": "text", "text": .string(text)])
        }
        for (i, c) in t.toolCalls.enumerated() {
            content.append(["type": "tool_use", "id": .string("toolu_mock_\(index)_\(i)"), "name": .string(c.name), "input": c.input])
        }
        return AgentTurnResult(content: content, stopReason: t.stopReason ?? (t.toolCalls.isEmpty ? "end_turn" : "tool_use"), model: model)
    }

    private static func sleep(_ ms: Int) async throws {
        if ms > 0 { try await Task.sleep(for: .milliseconds(ms)) } else { try Task.checkCancellation() }
    }
}
