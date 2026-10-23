import Foundation
import GlideCore
@testable import GlideFeatures
import GlideTestHarness
import Testing

// Recorded-shape fixtures for the Chat Completions stream (api.openai.com) and OpenAI-compatible servers
// (OpenRouter, Ollama /v1, LM Studio / llama.cpp). Each fixture is the raw SSE text such a server sends; they are
// fed through SSEParser + OpenAIStreamAccumulator exactly like OpenAIClient.runStream does, or served over loopback.

/// Feeds raw SSE text through the parser + accumulator; returns the events and the accumulator.
private func replay(_ sse: String, model: String = "gpt-5", vendor: String = "OpenAI") throws -> ([AIStreamEvent], OpenAIStreamAccumulator) {
    var parser = SSEParser()
    var acc = OpenAIStreamAccumulator(requestedModel: model, vendor: vendor)
    var events: [AIStreamEvent] = []
    for line in sse.components(separatedBy: "\n") {
        if let e = parser.feed(line: line) { events += try acc.consume(e) }
    }
    if let e = parser.flush() { events += try acc.consume(e) }
    return (events, acc)
}

private func toolEvents(_ ev: [AIStreamEvent]) -> [(String, String, JSONValue)] {
    ev.compactMap { if case let .toolUse(id, name, input) = $0 { return (id, name, input) } else { return nil } }
}

private func sseResponse(_ text: String, contentType: String = "text/event-stream") -> FakeAnthropicServer.Response {
    FakeAnthropicServer.Response(status: 200, headers: ["content-type": contentType], chunks: [(Data(text.utf8), 0.01)])
}

enum Fixtures {
    /// api.openai.com: role chunk, text, finish, then the usage chunk (stream_options.include_usage) and [DONE].
    static let openaiText = """
    data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5-2025-08-07","choices":[{"index":0,"delta":{"role":"assistant","content":"","refusal":null},"finish_reason":null}],"usage":null}

    data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5-2025-08-07","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}],"usage":null}

    data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5-2025-08-07","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}],"usage":null}

    data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5-2025-08-07","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}

    data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5-2025-08-07","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"completion_tokens_details":{"reasoning_tokens":0}}}

    data: [DONE]

    """

    /// api.openai.com: two parallel tool calls, ids/names once, argument fragments interleaved across chunks.
    static let openaiParallelTools = """
    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_A","type":"function","function":{"name":"start_timer","arguments":""}}]},"finish_reason":null}]}

    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"min"}}]},"finish_reason":null}]}

    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_B","type":"function","function":{"name":"open_url","arguments":""}}]},"finish_reason":null}]}

    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"utes\\": 5}"}}]},"finish_reason":null}]}

    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"url\\":\\"https://x.test\\"}"}}]},"finish_reason":null}]}

    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

    data: {"id":"c","model":"gpt-5","choices":[],"usage":{"prompt_tokens":40,"completion_tokens":22}}

    data: [DONE]

    """

    /// api.openai.com refusal (structured refusal deltas, no content).
    static let openaiRefusal = """
    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{"role":"assistant","content":null,"refusal":""},"finish_reason":null}]}

    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{"refusal":"I can't help with that."},"finish_reason":null}]}

    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

    data: [DONE]

    """

    /// Ollama /v1: whole tool call in one chunk, finish_reason "stop" (older builds), no usage chunk.
    static let ollamaToolStop = """
    data: {"id":"chatcmpl-9","object":"chat.completion.chunk","created":1,"model":"llama3.2:3b","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"id":"call_u1","index":0,"type":"function","function":{"name":"start_timer","arguments":"{\\"minutes\\":5}"}}]},"finish_reason":null}]}

    data: {"id":"chatcmpl-9","object":"chat.completion.chunk","created":1,"model":"llama3.2:3b","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}]}

    data: [DONE]

    """

    /// A compatible server that omits tool-call ids and indexes and repeats the full name in every chunk.
    static let noIdNoIndexRepeatedName = """
    data: {"model":"local","choices":[{"delta":{"tool_calls":[{"type":"function","function":{"name":"convert","arguments":"{\\"query\\":"}}]}}]}

    data: {"model":"local","choices":[{"delta":{"tool_calls":[{"type":"function","function":{"name":"convert","arguments":"\\"5 km in mi\\"}"}}]}}]}

    data: {"model":"local","choices":[{"delta":{},"finish_reason":"tool_calls"}]}

    data: {"model":"local","choices":[{"delta":{},"finish_reason":"tool_calls"}]}

    """

    /// Arguments sent as a JSON object instead of a string; finish_reason "" on intermediate chunks.
    static let objectArguments = """
    data: {"model":"local","choices":[{"index":0,"delta":{"content":"ok "},"finish_reason":""}]}

    data: {"model":"local","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"add","arguments":{"a":1,"b":2}}}]},"finish_reason":null}]}

    data: {"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

    """

    /// OpenRouter: keep-alive comments, provider model id, usage in the last content chunk, no [DONE] gap.
    static let openRouter = """
    : OPENROUTER PROCESSING

    : OPENROUTER PROCESSING

    data: {"id":"gen-1","provider":"OpenAI","model":"openai/gpt-5","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null,"native_finish_reason":null}]}

    data: {"id":"gen-1","provider":"OpenAI","model":"openai/gpt-5","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop","native_finish_reason":"completed"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

    data: [DONE]

    """

    /// LM Studio / llama.cpp style: reasoning deltas (ignored), text, finish, stream closes without [DONE].
    static let lmStudioNoDone = """
    data: {"id":"chatcmpl-x","object":"chat.completion.chunk","model":"qwen3-8b","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking…"},"logprobs":null,"finish_reason":null}]}

    data: {"id":"chatcmpl-x","object":"chat.completion.chunk","model":"qwen3-8b","choices":[{"index":0,"delta":{"content":"Answer."},"logprobs":null,"finish_reason":null}]}

    data: {"id":"chatcmpl-x","object":"chat.completion.chunk","model":"qwen3-8b","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}

    """

    /// Ollama mid-stream error (string, not an object).
    static let ollamaError = """
    data: {"error":"model requires more system memory (12 GiB) than is available (8 GiB)"}

    """

    /// OpenAI / OpenRouter mid-stream error object.
    static let streamErrorObject = """
    data: {"id":"c","model":"gpt-5","choices":[{"index":0,"delta":{"content":"par"},"finish_reason":null}]}

    data: {"error":{"message":"The server had an error while processing your request.","type":"server_error","code":null}}

    """

    /// A proxy that ignores stream:true and answers one chat.completion object.
    static let nonStreamed = #"{"id":"chatcmpl-2","object":"chat.completion","model":"gpt-4.1","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_9","type":"function","function":{"name":"start_timer","arguments":"{\"minutes\":2}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":9}}"#
}

@Suite("OpenAI Chat Completions fixtures (spec + compatible servers)")
struct OpenAICompatFixtureTests {
    @Test func openAITextWithUsageChunk() throws {
        let (ev, acc) = try replay(Fixtures.openaiText)
        #expect(ev.first == .started(model: "gpt-5-2025-08-07"))
        #expect(ev.compactMap { if case let .textDelta(t) = $0 { return t } else { return nil } } == ["Hel", "lo"])
        let out = acc.outcome
        #expect(out.text == "Hello" && out.stopReason == "end_turn" && acc.done)
        #expect(out.inputTokens == 12 && out.outputTokens == 5)
    }

    @Test func parallelToolCallsSplitAcrossChunks() throws {
        let (ev, acc) = try replay(Fixtures.openaiParallelTools)
        let calls = toolEvents(ev)
        #expect(calls.map(\.0) == ["call_A", "call_B"])
        #expect(calls.map(\.1) == ["start_timer", "open_url"])
        #expect(calls[0].2["minutes"]?.intValue == 5 && calls[1].2["url"]?.stringValue == "https://x.test")
        let out = acc.outcome
        #expect(out.stopReason == "tool_use" && out.text.isEmpty && out.content.count == 2)
        #expect(out.outputTokens == 22)
    }

    @Test func refusalDeltas() throws {
        let (_, acc) = try replay(Fixtures.openaiRefusal)
        #expect(acc.outcome.stopReason == "refusal")
        #expect(acc.refusalText == "I can't help with that.")
    }

    @Test func ollamaToolCallsEndingWithStopAndNoUsage() throws {
        let (ev, acc) = try replay(Fixtures.ollamaToolStop, model: "llama3.2:3b", vendor: "the AI server")
        #expect(toolEvents(ev).map(\.1) == ["start_timer"])
        let out = acc.outcome
        #expect(out.stopReason == "tool_use") // "stop" with tool calls
        #expect(out.inputTokens == nil && out.outputTokens == nil)
        #expect(out.content.first == .toolUse(id: "call_u1", name: "start_timer", input: ["minutes": 5]))
    }

    @Test func missingIdAndIndexAndRepeatedNames() throws {
        let (ev, acc) = try replay(Fixtures.noIdNoIndexRepeatedName, model: "local", vendor: "the AI server")
        let calls = toolEvents(ev)
        // One call (not one per chunk), name not doubled, a synthetic id shared by the event and the message,
        // and the duplicate finish chunk doesn't emit the call twice.
        #expect(calls.count == 1)
        #expect(calls.first?.1 == "convert" && calls.first?.2["query"]?.stringValue == "5 km in mi")
        #expect(calls.first?.0 == "call_0")
        #expect(acc.outcome.content == [.toolUse(id: "call_0", name: "convert", input: ["query": "5 km in mi"])])
    }

    @Test func objectArgumentsAndEmptyFinishReason() throws {
        let (ev, acc) = try replay(Fixtures.objectArguments, model: "local")
        #expect(toolEvents(ev).first?.2 == ["a": 1, "b": 2])
        #expect(acc.outcome.stopReason == "tool_use" && acc.outcome.text == "ok ")
    }

    @Test func openRouterCommentsAndUsage() throws {
        let (ev, acc) = try replay(Fixtures.openRouter, model: "openai/gpt-5")
        #expect(ev.first == .started(model: "openai/gpt-5"))
        #expect(acc.outcome.text == "Hi" && acc.outcome.outputTokens == 2 && acc.outcome.stopReason == "end_turn")
    }

    @Test func lmStudioReasoningIgnoredAndNoDone() throws {
        let (_, acc) = try replay(Fixtures.lmStudioNoDone, model: "qwen3-8b")
        #expect(acc.outcome.text == "Answer.")
        #expect(!acc.done && acc.finished)
    }

    @Test func streamErrors() throws {
        do { _ = try replay(Fixtures.ollamaError, vendor: "the AI server"); Issue.record("expected an error") } catch let e as AIError {
            #expect(e.message.contains("more system memory"))
        }
        do { _ = try replay(Fixtures.streamErrorObject); Issue.record("expected an error") } catch let e as AIError {
            #expect(e.message.contains("error while processing"))
        }
    }

    @Test func bodyAdaptsToServerAndModelFamily() throws {
        let msgs: [JSONValue] = [["role": "user", "content": "hi"]]
        // api.openai.com, reasoning model: developer role, effort, max_completion_tokens.
        var b = OpenAIFormat.body(model: "gpt-5", effort: "high", system: "SYS", messages: msgs, tools: [])
        if case var .object(o) = b { o["max_completion_tokens"] = 500; b = .object(o) }
        let official = OpenAIFormat.adapt(b, officialAPI: true)
        #expect(official["messages"]?.arrayValue?.first?["role"] == "developer")
        #expect(official["reasoning_effort"] == "high" && official["max_completion_tokens"] == 500 && official["max_tokens"] == nil)
        #expect(official["stream_options"]?["include_usage"] == true)
        // A compatible server: system stays, max_tokens.
        let compat = OpenAIFormat.adapt(b, officialAPI: false)
        #expect(compat["messages"]?.arrayValue?.first?["role"] == "system")
        #expect(compat["max_tokens"] == 500 && compat["max_completion_tokens"] == nil)
        // Chat models: no reasoning_effort, system stays system.
        let chat = OpenAIFormat.adapt(OpenAIFormat.body(model: "gpt-4.1", effort: "high", system: "SYS", messages: msgs, tools: []), officialAPI: true)
        #expect(chat["reasoning_effort"] == nil && chat["messages"]?.arrayValue?.first?["role"] == "system")
        #expect(OpenAIFormat.body(model: "gpt-5-chat-latest", effort: "low", system: "", messages: msgs, tools: [])["reasoning_effort"] == nil)
        #expect(OpenAIFormat.body(model: "o1-mini", effort: "low", system: "", messages: msgs, tools: [])["reasoning_effort"] == nil)
        #expect(OpenAIFormat.body(model: "o3-mini", effort: "low", system: "", messages: msgs, tools: [])["reasoning_effort"] == "low")
        // o1-mini takes neither system nor developer: folded into the first user message.
        let o1 = OpenAIFormat.adapt(OpenAIFormat.body(model: "o1-mini", effort: "low", system: "SYS", messages: msgs, tools: []), officialAPI: true)
        #expect(o1["messages"]?.arrayValue?.map { $0["role"]?.stringValue } == ["user"])
        #expect(o1["messages"]?.arrayValue?.first?["content"] == "SYS\n\nhi")
        // AIRequest: Glide's 64k default is not sent; a small explicit cap is.
        let big = OpenAIFormat.body(AIRequest(model: "gpt-5", messages: [AIAPIMessage(role: "user", text: "x")]))
        #expect(big["max_completion_tokens"] == nil)
        let small = OpenAIFormat.body(AIRequest(model: "gpt-5", messages: [AIAPIMessage(role: "user", text: "x")], maxTokens: 800))
        #expect(small["max_completion_tokens"] == 800)
    }

    @Test func imagePartsIncludingToolResultImages() throws {
        let png: JSONValue = ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": "QUJD"]]
        let msgs: [JSONValue] = [
            ["role": "user", "content": [["type": "text", "text": "what is this"], png]],
            ["role": "assistant", "content": [["type": "tool_use", "id": "c1", "name": "screenshot", "input": [:]]]],
            ["role": "user", "content": [["type": "tool_result", "tool_use_id": "c1", "content": [["type": "text", "text": "captured"], png]]]],
        ]
        let out = OpenAIFormat.messages(msgs, system: "")
        #expect(out.map { $0["role"]?.stringValue } == ["user", "assistant", "tool", "user"])
        #expect(out[0]["content"]?.arrayValue?[1]["image_url"]?["url"] == "data:image/png;base64,QUJD")
        #expect(out[2]["content"] == "captured")
        #expect(out[3]["content"]?.arrayValue?.first?["type"] == "image_url")
    }

    @Test func baseURLNormalization() {
        #expect(OpenAIClient.normalizedBaseURL("http://localhost:11434")?.absoluteString == "http://localhost:11434/v1")
        #expect(OpenAIClient.normalizedBaseURL("http://127.0.0.1:1234/")?.absoluteString == "http://127.0.0.1:1234/v1")
        #expect(OpenAIClient.normalizedBaseURL("https://openrouter.ai/api/v1")?.absoluteString == "https://openrouter.ai/api/v1")
        #expect(OpenAIClient.normalizedBaseURL("http://localhost:11434/v1/chat/completions")?.absoluteString == "http://localhost:11434/v1")
        #expect(OpenAIClient.normalizedBaseURL("not a url") == nil)
        #expect(OpenAIClient(apiKey: "k").isOfficialAPI)
        #expect(!OpenAIClient(apiKey: "k", baseURL: URL(string: "http://localhost:11434/v1")).isOfficialAPI)
    }
}

@Suite("OpenAI-compatible servers over loopback", .serialized)
struct OpenAICompatLoopbackTests {
    static let key = "sk-test-FAKE-compat"
    func client(_ s: FakeAnthropicServer) -> OpenAIClient { OpenAIClient(apiKey: Self.key, baseURL: URL(string: s.baseURL + "/v1"), maxRetries: 0) }
    func ask(_ c: OpenAIClient, model: String = "llama3.2:3b") async throws -> AIStreamOutcome {
        try await c.complete(AIRequest(model: model, messages: [AIAPIMessage(role: "user", text: "hi")], system: "be brief"))
    }

    @Test func compatibleServerGetsSystemRoleAndNoDoneIsFine() async throws {
        let server = try FakeAnthropicServer { _ in sseResponse(Fixtures.lmStudioNoDone) }
        defer { server.stop() }
        let out = try await ask(client(server), model: "gpt-5")
        #expect(out.text == "Answer.")
        let msgs = server.requests.first?.json?["messages"] as? [[String: Any]]
        #expect(msgs?.first?["role"] as? String == "system") // not "developer": a compatible server
        #expect(server.requests.first?.json?["max_completion_tokens"] == nil && server.requests.first?.json?["max_tokens"] == nil)
    }

    @Test func nonStreamedJSONAnswer() async throws {
        let server = try FakeAnthropicServer { _ in sseResponse(Fixtures.nonStreamed, contentType: "application/json") }
        defer { server.stop() }
        let out = try await ask(client(server), model: "gpt-4.1")
        #expect(out.stopReason == "tool_use" && out.content == [.toolUse(id: "call_9", name: "start_timer", input: ["minutes": 2])])
        #expect(out.inputTokens == 20)
    }

    @Test func cutOffWithoutAnythingIsAnError() async throws {
        let server = try FakeAnthropicServer { _ in sseResponse(": nothing\n\n") }
        defer { server.stop() }
        await #expect(throws: AIError.self) { try await ask(client(server)) }
    }

    @Test func ollamaStyleErrorBodies() async throws {
        let server = try FakeAnthropicServer { r in
            r.path.hasSuffix("chat/completions") ? .json(404, ["error": "model \"llama9\" not found, try pulling it first"]) : .json(400, ["error": "bad"])
        }
        defer { server.stop() }
        do { _ = try await ask(client(server), model: "llama9"); Issue.record("expected an error") } catch let e as AIError {
            #expect(e.message.contains("try pulling it first"), "\(e.message)")
            #expect(!e.message.contains(Self.key))
        }
    }

    @Test func wrongBaseURLHint() async throws {
        let server = try FakeAnthropicServer { _ in FakeAnthropicServer.Response(status: 404, headers: ["content-type": "text/plain"], chunks: [(Data("404 page not found".utf8), 0)]) }
        defer { server.stop() }
        do { _ = try await ask(client(server)); Issue.record("expected an error") } catch let e as AIError {
            #expect(e.message.contains("/v1"), "\(e.message)")
        }
    }

    @Test func testKeyFallsBackToModelList() async throws {
        let server = try FakeAnthropicServer { r in
            r.path == "/v1/models" ? .json(200, ["object": "list", "data": [["id": "openai/gpt-5"], ["id": "qwen3-8b"]]]) : .json(404, ["error": ["message": "not found"]])
        }
        defer { server.stop() }
        #expect(try await client(server).testKey(model: "openai/gpt-5") == "openai/gpt-5")
        do { _ = try await client(server).testKey(model: "nope"); Issue.record("expected an error") } catch let e as AIError {
            #expect(e.message.contains("qwen3-8b"))
        }
    }
}
