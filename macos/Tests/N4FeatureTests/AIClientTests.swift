import Foundation
import GlideCore
@testable import GlideFeatures
import GlideTestHarness
import Testing

@Suite("AI models / templates")
struct AITemplateTests {
    @Test func modelIdsMatchElectron() {
        #expect(AIModels.defaultModel == "claude-opus-5-5")
        #expect(AIModels.all.map(\.id) == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1"])
        #expect(!AIModels.supportsEffort("claude-haiku-4-5"))
        #expect(AIModels.supportsDefaultFallback("claude-fable-5-1"))
        #expect(!AIModels.supportsDefaultFallback("claude-haiku-4-5"))
    }

    @Test func builtinsMatchTemplatesTs() {
        #expect(AITemplates.builtins.map(\.id) == ["fix-spelling", "improve-writing", "make-shorter", "make-longer", "tone-friendly", "tone-professional",
                                                   "summarize", "explain-simply", "translate", "explain-code", "find-bugs"])
        let tr = AITemplates.builtins.first { $0.id == "translate" }
        #expect(tr?.acceptsArgument == true && tr?.replaces == true)
        #expect(AITemplates.builtins.first { $0.id == "fix-spelling" }?.prompt.hasSuffix("<text>\n{selection}\n</text>") == true)
    }

    @Test func fillIsSinglePass() {
        #expect(AITemplates.fill("Translate {selection} into {argument}", selection: "say {argument}", argument: "French") == "Translate say {argument} into French")
        #expect(AITemplates.fill("{x} {selection}", selection: nil, argument: nil) == "{x} ")
    }

    @Test func sanitizeCustomCommands() {
        let c = AITemplates.sanitize(["name": "  My Cmd!! ", "prompt": "Do {argument} to {selection}", "icon": "🦊🦊🦊🦊🦊", "replaces": true])
        #expect(c?.id == "custom-my-cmd")
        #expect(c?.acceptsArgument == true)
        #expect(c?.replaces == true)
        #expect(c?.icon.unicodeScalars.count == 4)
        #expect(AITemplates.sanitize(["name": "x", "prompt": "  "]) == nil)
        #expect(AITemplates.sanitize(["id": "Bad Id", "name": "Okay", "prompt": "p"])?.id == "custom-okay")
        let list = AITemplates.sanitizeList([["id": "summarize", "name": "Summarize", "prompt": "p"], ["name": "Okay", "prompt": "p"], ["name": "Okay", "prompt": "q"]])
        #expect(list.map(\.id) == ["summarize-2", "custom-okay", "custom-okay-2"])
    }
}

@Suite("AI request building / SSE")
struct AIStreamParsingTests {
    @Test func bodyMatchesBuildParams() throws {
        let msgs = try AIRequestBuilder.apiMessages([AIChatMessage(role: "assistant", content: "hi"), AIChatMessage(role: "user", content: "Q"), AIChatMessage(role: "assistant", content: " "), AIChatMessage(role: "user", content: "Q2")])
        #expect(msgs.map(\.role) == ["user", "user"])
        let (body, betas) = AIRequestBuilder.body(AIRequest(model: "claude-opus-5-5", effort: "high", messages: msgs, system: "Be brief"))
        #expect(body["model"]?.stringValue == "claude-opus-5-5")
        #expect(body["max_tokens"]?.intValue == 64000)
        #expect(body["stream"]?.boolValue == true)
        #expect(body["output_config"]?["effort"]?.stringValue == "high")
        #expect(body["fallbacks"]?.stringValue == "default")
        #expect(betas == ["server-side-fallback-2026-07-01"])
        #expect(body["system"]?.arrayValue?.count == 2)
        #expect(body["system"]?.arrayValue?.first?["cache_control"]?["type"]?.stringValue == "ephemeral")
        #expect(body["cache_control"]?["type"]?.stringValue == "ephemeral")
        #expect(body["messages"]?.arrayValue?.first?["content"]?.stringValue == "Q")
        let haiku = AIRequestBuilder.body(AIRequest(model: "claude-haiku-4-5", messages: msgs))
        #expect(haiku.body["output_config"] == nil && haiku.body["fallbacks"] == nil && haiku.betas.isEmpty)
        #expect(throws: AIError.self) { try AIRequestBuilder.apiMessages([AIChatMessage(role: "user", content: "q"), AIChatMessage(role: "assistant", content: "a")]) }
    }

    @Test func toolUseReadyTypes() {
        let tool = AITool(name: "get_weather", description: "Weather", inputSchema: ["type": "object", "properties": [:], "required": [], "additionalProperties": false])
        let msg = AIAPIMessage(role: "user", content: [.toolResult(toolUseId: "tu_1", content: "sunny", isError: false), .text("thanks")])
        let (body, _) = AIRequestBuilder.body(AIRequest(messages: [msg], tools: [tool]))
        #expect(body["tools"]?.arrayValue?.first?["eager_input_streaming"]?.boolValue == true)
        #expect(body["tools"]?.arrayValue?.first?["strict"]?.boolValue == true)
        #expect(body["tool_choice"]?["type"]?.stringValue == "auto")
        #expect(body["messages"]?.arrayValue?.first?["content"]?.arrayValue?.first?["type"]?.stringValue == "tool_result")
    }

    @Test func sseParser() {
        var p = SSEParser()
        #expect(p.feed(line: ": comment") == nil)
        #expect(p.feed(line: "event: content_block_delta") == nil)
        #expect(p.feed(line: "data: {\"a\":1}\r") == nil)
        #expect(p.feed(line: "") == SSEParser.Event(event: "content_block_delta", data: "{\"a\":1}"))
        #expect(p.feed(line: "data: x") == nil)
        #expect(p.feed(line: "data: y") == nil)
        #expect(p.flush() == SSEParser.Event(event: "message", data: "x\ny"))
    }

    private func ev(_ name: String, _ json: String) -> SSEParser.Event { SSEParser.Event(event: name, data: json) }

    @Test func accumulatorTextToolUseFallback() throws {
        var a = AIMessageAccumulator(requestedModel: "claude-opus-5-5")
        var out: [AIStreamEvent] = []
        out += try a.consume(ev("message_start", #"{"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":9}}}"#))
        out += try a.consume(ev("content_block_start", #"{"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"claude-opus-5-5"},"to":{"model":"claude-opus-5"}}}"#))
        out += try a.consume(ev("content_block_start", #"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#))
        out += try a.consume(ev("content_block_delta", #"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}"#))
        out += try a.consume(ev("content_block_delta", #"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}"#))
        out += try a.consume(ev("content_block_start", #"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}"#))
        out += try a.consume(ev("content_block_delta", #"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}"#))
        out += try a.consume(ev("content_block_delta", #"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"Paris\"}"}}"#))
        out += try a.consume(ev("content_block_stop", #"{"type":"content_block_stop","index":2}"#))
        out += try a.consume(ev("message_delta", #"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}"#))
        out += try a.consume(ev("message_stop", #"{"type":"message_stop"}"#))
        #expect(out.contains(.fallback(from: "claude-opus-5-5", to: "claude-opus-5")))
        #expect(out.filter { if case .textDelta = $0 { return true }; return false }.count == 2)
        #expect(out.contains(.toolUse(id: "tu_1", name: "get_weather", input: ["city": "Paris"])))
        let o = a.outcome
        #expect(o.text == "Hello" && o.stopReason == "tool_use" && o.outputTokens == 7 && o.inputTokens == 9)
        #expect(o.content == [.text("Hello"), .toolUse(id: "tu_1", name: "get_weather", input: ["city": "Paris"])])
        #expect(a.finished)
    }

    @Test func streamErrorEventMapsToKind() {
        var a = AIMessageAccumulator(requestedModel: "m")
        #expect(throws: AIError(.overloaded, "Anthropic is overloaded or unavailable right now. Try again shortly.")) {
            _ = try a.consume(ev("error", #"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#))
        }
    }

    @Test func httpErrorMapping() {
        let body = Data(#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens too big"}}"#.utf8)
        #expect(AIError.from(status: 400, body: body) == AIError(.badRequest, "Request rejected: max_tokens too big", status: 400))
        #expect(AIError.from(status: 401, body: Data()).kind == .auth)
        #expect(AIError.from(status: 403, body: Data()).kind == .permission)
        #expect(AIError.from(status: 404, body: Data()).kind == .badRequest)
        #expect(AIError.from(status: 429, body: Data()).kind == .rateLimit)
        #expect(AIError.from(status: 529, body: Data()).kind == .overloaded)
        #expect(AIError.from(status: 418, body: body).message == "Anthropic API error 418: max_tokens too big")
        #expect(AIError.from(URLError(.notConnectedToInternet)).kind == .network)
    }
}

/// Real URLSession against the 127.0.0.1 fake server (never the real API, never a real key).
@Suite("AI client over loopback", .serialized)
struct AIClientLoopbackTests {
    static let key = "sk-ant-test-FAKE"

    @Test func streamsTextAndSendsHeaders() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "Hello from the fake server", pieces: 4) }
        defer { server.stop() }
        let client = AnthropicClient(apiKey: Self.key, baseURL: URL(string: server.baseURL))
        let deltas = DeltaBox()
        let out = try await client.complete(AIRequest(messages: [AIAPIMessage(role: "user", text: "hi")])) { deltas.append($0) }
        #expect(out.text == "Hello from the fake server")
        #expect(out.stopReason == "end_turn")
        #expect(out.model == "claude-opus-5-5")
        #expect(deltas.count == 4)
        let req = try #require(server.requests.first)
        #expect(req.method == "POST" && req.path == "/v1/messages")
        #expect(req.headers["x-api-key"] == Self.key)
        #expect(req.headers["anthropic-version"] == "2023-06-01")
        #expect(req.headers["anthropic-beta"] == "server-side-fallback-2026-07-01")
        #expect(req.json?["stream"] as? Bool == true)
    }

    @Test func refusalThrows() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "I can't", stopReason: "refusal") }
        defer { server.stop() }
        let client = AnthropicClient(apiKey: Self.key, baseURL: URL(string: server.baseURL))
        await #expect(throws: AIError.refused) { _ = try await client.complete(AIRequest(messages: [AIAPIMessage(role: "user", text: "x")])) }
    }

    @Test func authErrorIsNotRetried() async throws {
        let server = try FakeAnthropicServer { _ in .json(401, ["type": "error", "error": ["type": "authentication_error", "message": "invalid x-api-key"]]) }
        defer { server.stop() }
        let client = AnthropicClient(apiKey: Self.key, baseURL: URL(string: server.baseURL))
        do {
            _ = try await client.complete(AIRequest(messages: [AIAPIMessage(role: "user", text: "x")]))
            Issue.record("expected an error")
        } catch let e as AIError {
            #expect(e.kind == .auth)
            #expect(!e.message.contains(Self.key))
        }
        #expect(server.requests.count == 1)
    }

    @Test func overloadedIsRetriedOnce() async throws {
        let counter = DeltaBox()
        let server = try FakeAnthropicServer { _ in
            counter.append("x")
            return counter.count == 1 ? .json(529, ["type": "error", "error": ["type": "overloaded_error", "message": "Overloaded"]], headers: ["retry-after": "0"]) : .sse(text: "ok")
        }
        defer { server.stop() }
        let client = AnthropicClient(apiKey: Self.key, baseURL: URL(string: server.baseURL))
        let out = try await client.complete(AIRequest(messages: [AIAPIMessage(role: "user", text: "x")]))
        #expect(out.text == "ok")
        #expect(server.requests.count == 2)
    }

    @Test func connectionRefusedIsNetworkError() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "unused") }
        let url = URL(string: server.baseURL)
        server.stop()
        let client = AnthropicClient(apiKey: Self.key, baseURL: url, maxRetries: 0)
        await #expect(throws: AIError.self) { _ = try await client.complete(AIRequest(messages: [AIAPIMessage(role: "user", text: "x")])) }
    }

    @Test func cancellingStopsTheStream() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: String(repeating: "word ", count: 200), pieces: 100, delay: 0.03) }
        defer { server.stop() }
        let client = AnthropicClient(apiKey: Self.key, baseURL: URL(string: server.baseURL))
        let deltas = DeltaBox()
        let task = Task {
            for try await e in client.stream(AIRequest(messages: [AIAPIMessage(role: "user", text: "x")])) { if case let .textDelta(t) = e { deltas.append(t) } }
        }
        while deltas.count < 3 { try await Task.sleep(for: .milliseconds(10)) }
        task.cancel()
        _ = await task.result
        let n = deltas.count
        try await Task.sleep(for: .milliseconds(200))
        #expect(deltas.count == n)
        #expect(n < 100)
    }

    @Test func testKeyUsesModelsAPI() async throws {
        let server = try FakeAnthropicServer { r in
            r.path.hasPrefix("/v1/models/") ? .json(200, ["id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "type": "model"]) : .json(404, [:])
        }
        defer { server.stop() }
        let client = AnthropicClient(apiKey: Self.key, baseURL: URL(string: server.baseURL))
        #expect(try await client.testKey(model: "claude-opus-5-5") == "Claude Opus 5.5")
        #expect(server.requests.first?.method == "GET")
    }
}

final class DeltaBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func append(_ s: String) { lock.lock(); items.append(s); lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return items.count }
    var joined: String { lock.lock(); defer { lock.unlock() }; return items.joined() }
}
