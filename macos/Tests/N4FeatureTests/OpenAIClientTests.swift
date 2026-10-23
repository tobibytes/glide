import Foundation
import GlideCore
@testable import GlideFeatures
import GlideTestHarness
import Testing

private func chunk(_ obj: Any) -> String {
    "data: " + String(decoding: try! JSONSerialization.data(withJSONObject: obj), as: UTF8.self) + "\n\n"
}

/// A Chat Completions SSE answer streamed in `pieces` (fake server, never the real API).
private func openAISSE(text: String, model: String = "gpt-5", pieces: Int = 3, finish: String = "stop",
                       toolCalls: [[String: Any]] = []) -> FakeAnthropicServer.Response {
    var parts: [String] = []
    let chars = Array(text)
    let size = max(1, Int((Double(chars.count) / Double(max(1, pieces))).rounded(.up)))
    var i = 0
    while i < chars.count {
        parts.append(String(chars[i..<min(chars.count, i + size)]))
        i += size
    }
    var out = parts.map { chunk(["model": model, "choices": [["index": 0, "delta": ["content": $0]]]]) }
    if !toolCalls.isEmpty { out.append(chunk(["model": model, "choices": [["index": 0, "delta": ["tool_calls": toolCalls]]]])) }
    out.append(chunk(["model": model, "choices": [["index": 0, "delta": [:], "finish_reason": finish]]]))
    out.append(chunk(["model": model, "choices": [], "usage": ["prompt_tokens": 7, "completion_tokens": 3]]))
    out.append("data: [DONE]\n\n")
    return FakeAnthropicServer.Response(status: 200, headers: ["content-type": "text/event-stream"],
                                        chunks: out.map { (Data($0.utf8), 0.01) })
}

@Suite("OpenAI format + stream")
struct OpenAIFormatTests {
    @Test func providerDetectionAndModels() {
        #expect(AIProvider.detect(key: "sk-ant-api03-x") == .anthropic)
        #expect(AIProvider.detect(key: " sk-proj-abc ") == .openai)
        #expect(AIProvider.detect(key: "gsk_x") == nil)
        #expect(OpenAIModels.isValid("gpt-5-mini") && OpenAIModels.isValid("openai/gpt-5") && OpenAIModels.isValid("llama3.2:3b"))
        #expect(!OpenAIModels.isValid("claude-opus-5-5") && !OpenAIModels.isValid("bad id") && !OpenAIModels.isValid(""))
        #expect(OpenAIModels.supportsEffort("gpt-5") && OpenAIModels.supportsEffort("openai/o3"))
        #expect(!OpenAIModels.supportsEffort("gpt-4.1"))
    }

    @Test func requestBodyTranslatesMessages() throws {
        let messages: [JSONValue] = [
            ["role": "user", "content": "arrange my windows"],
            ["role": "assistant", "content": [["type": "text", "text": "On it."],
                                              ["type": "tool_use", "id": "call_1", "name": "windows_layout", "input": ["layout": "left-half"]]]],
            ["role": "user", "content": [["type": "tool_result", "tool_use_id": "call_1", "content": "done"],
                                         ["type": "tool_result", "tool_use_id": "call_2", "content": "nope", "is_error": true]]],
        ]
        let tools: [JSONValue] = [["name": "windows_layout", "description": "Move windows", "input_schema": ["type": "object", "properties": [:]]]]
        let body = OpenAIFormat.body(model: "gpt-5", effort: "low", system: "SYS", messages: messages, tools: tools)
        let msgs = try #require(body["messages"]?.arrayValue)
        #expect(msgs.map { $0["role"]?.stringValue } == ["system", "user", "assistant", "tool", "tool"])
        #expect(msgs[0]["content"]?.stringValue == "SYS")
        #expect(msgs[2]["content"]?.stringValue == "On it.")
        #expect(msgs[2]["tool_calls"]?.arrayValue?.first?["function"]?["name"]?.stringValue == "windows_layout")
        #expect(msgs[2]["tool_calls"]?.arrayValue?.first?["function"]?["arguments"]?.stringValue == #"{"layout":"left-half"}"#)
        #expect(msgs[3]["tool_call_id"]?.stringValue == "call_1")
        #expect(msgs[4]["content"]?.stringValue == "Error: nope")
        #expect(body["tools"]?.arrayValue?.first?["function"]?["parameters"]?["type"]?.stringValue == "object")
        #expect(body["reasoning_effort"]?.stringValue == "low")
        #expect(body["stream"]?.boolValue == true)
        let old = OpenAIFormat.body(model: "gpt-4.1", effort: "low", system: "", messages: [["role": "user", "content": "x"]], tools: [])
        #expect(old["reasoning_effort"] == nil && old["tools"] == nil)
        #expect(old["messages"]?.arrayValue?.count == 1)
    }

    @Test func accumulatorBuildsTextAndToolCalls() throws {
        var a = OpenAIStreamAccumulator(requestedModel: "gpt-5")
        func ev(_ obj: Any) -> SSEParser.Event {
            SSEParser.Event(event: "message", data: String(decoding: try! JSONSerialization.data(withJSONObject: obj), as: UTF8.self))
        }
        var out = try a.consume(ev(["model": "gpt-5-2026", "choices": [["delta": ["content": "Hi"]]]]))
        #expect(out == [.started(model: "gpt-5-2026"), .textDelta("Hi")])
        _ = try a.consume(ev(["choices": [["delta": ["tool_calls": [["index": 0, "id": "call_9", "function": ["name": "timer", "arguments": "{\"min"]]]]]]]))
        _ = try a.consume(ev(["choices": [["delta": ["tool_calls": [["index": 0, "function": ["arguments": "utes\":5}"]]]]]]]))
        out = try a.consume(ev(["choices": [["delta": [:], "finish_reason": "tool_calls"]]]))
        #expect(out == [.toolUse(id: "call_9", name: "timer", input: ["minutes": 5])])
        _ = try a.consume(SSEParser.Event(event: "message", data: "[DONE]"))
        let o = a.outcome
        #expect(o.stopReason == "tool_use")
        #expect(o.content == [.text("Hi"), .toolUse(id: "call_9", name: "timer", input: ["minutes": 5])])
        #expect(o.model == "gpt-5-2026")
    }
}

@Suite("OpenAI client over loopback", .serialized)
struct OpenAIClientLoopbackTests {
    static let key = "sk-test-FAKE-openai"

    @Test func streamsTextWithBearerAuth() async throws {
        let server = try FakeAnthropicServer { _ in openAISSE(text: "Hello from fake OpenAI", pieces: 4) }
        defer { server.stop() }
        let client = OpenAIClient(apiKey: Self.key, baseURL: URL(string: server.baseURL + "/v1"))
        let out = try await client.complete(AIRequest(model: "gpt-5", messages: [AIAPIMessage(role: "user", text: "hi")], system: "be brief"))
        #expect(out.text == "Hello from fake OpenAI")
        #expect(out.stopReason == "end_turn")
        #expect(out.outputTokens == 3)
        let req = try #require(server.requests.first)
        #expect(req.method == "POST" && req.path == "/v1/chat/completions")
        #expect(req.headers["authorization"] == "Bearer \(Self.key)")
        #expect(req.headers["x-api-key"] == nil)
        let msgs = req.json?["messages"] as? [[String: Any]]
        #expect((msgs?.first?["content"] as? String)?.hasSuffix("be brief") == true)
    }

    @Test func authErrorMentionsNoKey() async throws {
        let server = try FakeAnthropicServer { _ in .json(401, ["error": ["message": "Incorrect API key provided", "type": "invalid_request_error"]]) }
        defer { server.stop() }
        let client = OpenAIClient(apiKey: Self.key, baseURL: URL(string: server.baseURL + "/v1"))
        do {
            _ = try await client.complete(AIRequest(model: "gpt-5", messages: [AIAPIMessage(role: "user", text: "x")]))
            Issue.record("expected an error")
        } catch let e as AIError {
            #expect(e.kind == .auth)
            #expect(!e.message.contains(Self.key))
        }
        #expect(server.requests.count == 1)
    }

    @Test func testKeyUsesModelsAPI() async throws {
        let server = try FakeAnthropicServer { r in r.path == "/v1/models/gpt-5" ? .json(200, ["id": "gpt-5", "object": "model"]) : .json(404, [:]) }
        defer { server.stop() }
        let client = OpenAIClient(apiKey: Self.key, baseURL: URL(string: server.baseURL + "/v1"))
        #expect(try await client.testKey(model: "gpt-5") == "gpt-5")
    }
}

@Suite("AI feature with OpenAI", .serialized)
@MainActor struct AIFeatureOpenAITests {
    @Test func pastingAnOpenAIKeySwitchesProviderAndStreams() async throws {
        let server = try FakeAnthropicServer { _ in openAISSE(text: "Fixed text.", model: "gpt-5-mini") }
        defer { server.stop() }
        let ctx = try N4TestContext(featureId: "ai")
        defer { ctx.cleanup() }
        let f = AIFeature(environment: ["GLIDE_AI_BASE_URL": server.baseURL])
        await f.start(context: ctx)
        #expect(f.provider == .anthropic)
        let r = try await f.invoke(method: "setApiKey", args: ["key": "sk-proj-test-FAKE"])
        #expect(r["provider"]?.stringValue == "openai")
        #expect(f.provider == .openai)
        #expect(f.anthropicKeys.status().hasKey == false)
        #expect(f.currentModel == OpenAIModels.defaultModel)
        _ = try await f.invoke(method: "setSettings", args: ["openaiModel": "gpt-5-mini", "openaiBaseURL": "http://example.com/v1"])
        #expect(f.openaiModel == "gpt-5-mini")
        #expect(f.openaiBaseURL.isEmpty) // http on a non-loopback host is rejected
        // Claude ids pinned by AI Commands fall back to the OpenAI default.
        #expect(f.resolveModel("claude-opus-5-5") == "gpt-5-mini")
        let a = try await f.invoke(method: "ask", args: ["prompt": "fix: helo"])
        #expect(a["ok"]?.boolValue == true)
        #expect(a["text"]?.stringValue == "Fixed text.")
        #expect(server.requests.first?.path == "/v1/chat/completions")
        #expect(server.requests.first?.json?["model"] as? String == "gpt-5-mini")
        // switching back keeps each provider's key separate
        _ = try await f.invoke(method: "setSettings", args: ["provider": "anthropic"])
        #expect(f.currentModel == AIModels.defaultModel)
        #expect(throws: AIError.self) { try f.makeClient() }
    }

    @Test func agentAdapterSpeaksChatCompletions() async throws {
        let server = try FakeAnthropicServer { _ in
            openAISSE(text: "", finish: "tool_calls",
                      toolCalls: [["index": 0, "id": "call_1", "type": "function", "function": ["name": "start_timer", "arguments": "{\"minutes\":5}"]]])
        }
        defer { server.stop() }
        let client = AgentOpenAIClient(client: OpenAIClient(apiKey: "sk-test-FAKE", baseURL: URL(string: server.baseURL + "/v1")))
        let req = AgentTurnRequest(model: "gpt-5", effort: "medium", system: "SYS", context: "Today is Friday",
                                   tools: [["name": "start_timer", "description": "Start a timer", "input_schema": ["type": "object"]]],
                                   messages: [["role": "user", "content": "5 minute timer"]])
        let r = try await client.turn(req) { _ in }
        #expect(r.stopReason == "tool_use")
        #expect(r.content.first?["type"]?.stringValue == "tool_use")
        #expect(r.content.first?["input"]?["minutes"]?.intValue == 5)
        let sys = (server.requests.first?.json?["messages"] as? [[String: Any]])?.first?["content"] as? String
        #expect(sys == "SYS\n\nToday is Friday")
    }
}
