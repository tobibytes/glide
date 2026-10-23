import Foundation
import GlideCore

/// Where the agent gets its model client: the AI feature (N4) registers itself here in its start
/// (`AgentAIBridge.provider = self`), so the agent never touches the API key itself.
@MainActor enum AgentAIBridge {
    static weak var provider: (any AIClientProvider)?
}

/// Adapts the AI feature's `AnthropicClient` (Sources/Features/AI) to the agent loop. The agent builds its own
/// request body (its frozen system prompt, raw message JSON with tool_use/tool_result blocks, its tools) and
/// reuses the AI client's authenticated request + SSE stream accumulation.
@MainActor final class AgentAnthropicClient: AIModelClient {
    let client: AnthropicClient
    init(client: AnthropicClient) { self.client = client }

    static func body(_ req: AgentTurnRequest) -> (JSONValue, [String]) {
        guard case var .object(o) = req.body() else { return (req.body(), []) }
        // Second breakpoint: caches the growing transcript between tool-loop turns.
        o["cache_control"] = ["type": "ephemeral"]
        if req.tools.isEmpty { o["tools"] = nil }
        if AIModels.supportsEffort(req.model) { o["output_config"] = ["effort": .string(req.effort)] }
        var betas: [String] = []
        if AIModels.supportsDefaultFallback(req.model) {
            betas.append(AIRequestBuilder.fallbackBeta)
            o["fallbacks"] = "default"
        }
        return (.object(o), betas)
    }

    func turn(_ req: AgentTurnRequest, onText: @escaping @MainActor (String) -> Void) async throws -> AgentTurnResult {
        let (body, betas) = Self.body(req)
        let data = (try? JSONEncoder.glideCompact.encode(body)) ?? Data()
        let request = client.request(path: "v1/messages", method: "POST", body: data, betas: betas)
        let session = client.session
        let model = req.model
        let stream = AsyncThrowingStream<AIStreamEvent, Error> { continuation in
            let task = Task {
                do {
                    try await AnthropicClient.runStream(session: session, request: request, model: model, continuation: continuation)
                    continuation.finish()
                } catch let e as AnthropicClient.RetryableBeforeOutput {
                    continuation.finish(throwing: e.error)
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        do {
            for try await e in stream {
                switch e {
                case let .textDelta(t): onText(t)
                case let .finished(out):
                    return AgentTurnResult(content: out.content.map(\.json), stopReason: out.stopReason, model: out.model)
                default: break
                }
            }
        } catch let e as AIError {
            if e.kind == .refusal { return AgentTurnResult(content: [], stopReason: "refusal", model: model) }
            throw AgentClientError(message: e.message, kind: e.kind.rawValue)
        }
        try Task.checkCancellation()
        throw AgentClientError(message: "The answer was cut off (connection closed early).", kind: "network")
    }
}

extension AIFeature {
    /// Registers the AI feature as the agent's client provider (used in AllFeatures; no change inside AI/).
    public func servingGlideAgent() -> AIFeature {
        AgentAIBridge.provider = self
        return self
    }
}

/// Adapts `OpenAIClient` to the agent loop: the agent's Anthropic-shaped messages and tools are translated to
/// Chat Completions, and the answer comes back as Anthropic-shaped content blocks (text, tool_use) to replay.
@MainActor final class AgentOpenAIClient: AIModelClient {
    let client: OpenAIClient
    init(client: OpenAIClient) { self.client = client }

    static func body(_ req: AgentTurnRequest) -> JSONValue {
        let system = req.context.isEmpty ? req.system : req.system + "\n\n" + req.context
        return OpenAIFormat.body(model: req.model, effort: req.effort, system: system, messages: req.messages, tools: req.tools)
    }

    func turn(_ req: AgentTurnRequest, onText: @escaping @MainActor (String) -> Void) async throws -> AgentTurnResult {
        let stream = client.stream(request: client.request(body: Self.body(req)), model: req.model)
        do {
            for try await e in stream {
                switch e {
                case let .textDelta(t): onText(t)
                case let .finished(out):
                    return AgentTurnResult(content: out.content.map(\.json), stopReason: out.stopReason, model: out.model)
                default: break
                }
            }
        } catch let e as AIError {
            if e.kind == .refusal { return AgentTurnResult(content: [], stopReason: "refusal", model: req.model) }
            throw AgentClientError(message: e.message, kind: e.kind.rawValue)
        }
        try Task.checkCancellation()
        throw AgentClientError(message: "The answer was cut off (connection closed early).", kind: "network")
    }
}
