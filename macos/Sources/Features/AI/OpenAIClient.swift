import Foundation
import GlideCore

// OpenAI Chat Completions over URLSession (no SDK dependency). Works with api.openai.com and OpenAI-compatible
// servers (OpenRouter, Ollama, LM Studio) through a custom base URL. Requests are built from the same
// Anthropic-shaped messages the rest of Glide uses, and answers come back as the same `AIStreamEvent`s and
// content blocks (text, tool_use), so Quick AI, the chat window, AI Commands and the agent loop don't change.
// The key only ever lives in the `Authorization` header of requests built here.

/// Anthropic-shaped request JSON → Chat Completions JSON (pure; unit-tested).
public enum OpenAIFormat {
    /// `messages`: MessageParam JSON values (string content or text / image / tool_use / tool_result blocks).
    public static func messages(_ anthropic: [JSONValue], system: String) -> [JSONValue] {
        var out: [JSONValue] = []
        if !system.isEmpty { out.append(["role": "system", "content": .string(system)]) }
        for m in anthropic {
            let role = m["role"]?.stringValue ?? "user"
            if let text = m["content"]?.stringValue {
                out.append(["role": .string(role), "content": .string(text)])
                continue
            }
            let blocks = m["content"]?.arrayValue ?? []
            if role == "assistant" {
                let text = blocks.compactMap { $0["type"]?.stringValue == "text" ? $0["text"]?.stringValue : nil }.joined()
                let calls: [JSONValue] = blocks.compactMap { b in
                    guard b["type"]?.stringValue == "tool_use" else { return nil }
                    let args = (try? JSONEncoder.glideCompact.encode(b["input"] ?? [:])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
                    return ["id": .string(b["id"]?.stringValue ?? ""), "type": "function",
                            "function": ["name": .string(b["name"]?.stringValue ?? ""), "arguments": .string(args)]]
                }
                var o: [String: JSONValue] = ["role": "assistant", "content": text.isEmpty && !calls.isEmpty ? .null : .string(text)]
                if !calls.isEmpty { o["tool_calls"] = .array(calls) }
                out.append(.object(o))
                continue
            }
            // user turn: tool results become `tool` messages (they must directly follow the assistant's calls),
            // the rest one user message.
            var parts: [JSONValue] = []
            for b in blocks {
                switch b["type"]?.stringValue {
                case "tool_result":
                    var content = b["content"]?.stringValue
                        ?? (b["content"]?.arrayValue ?? []).compactMap { $0["text"]?.stringValue }.joined(separator: "\n")
                    if b["is_error"]?.boolValue == true { content = "Error: " + content }
                    out.append(["role": "tool", "tool_call_id": .string(b["tool_use_id"]?.stringValue ?? ""), "content": .string(content)])
                case "text":
                    parts.append(["type": "text", "text": .string(b["text"]?.stringValue ?? "")])
                case "image":
                    let src = b["source"]
                    let url = "data:\(src?["media_type"]?.stringValue ?? "image/png");base64,\(src?["data"]?.stringValue ?? "")"
                    parts.append(["type": "image_url", "image_url": ["url": .string(url)]])
                default: break
                }
            }
            if parts.count == 1, let t = parts[0]["text"]?.stringValue {
                out.append(["role": "user", "content": .string(t)])
            } else if !parts.isEmpty {
                out.append(["role": "user", "content": .array(parts)])
            }
        }
        return out
    }

    /// `{name, description, input_schema}` → `{type: function, function: {name, description, parameters}}`.
    public static func tools(_ anthropic: [JSONValue]) -> [JSONValue] {
        anthropic.map { t in
            ["type": "function", "function": ["name": t["name"] ?? "", "description": t["description"] ?? "",
                                              "parameters": t["input_schema"] ?? ["type": "object", "properties": [:]]]]
        }
    }

    /// A Chat Completions request body (streaming).
    public static func body(model: String, effort: String, system: String, messages: [JSONValue], tools: [JSONValue]) -> JSONValue {
        var o: [String: JSONValue] = [
            "model": .string(model), "messages": .array(Self.messages(messages, system: system)),
            "stream": true, "stream_options": ["include_usage": true],
        ]
        if !tools.isEmpty { o["tools"] = .array(Self.tools(tools)) }
        if OpenAIModels.supportsEffort(model), AIModels.efforts.contains(effort) { o["reasoning_effort"] = .string(effort) }
        return .object(o)
    }

    /// Glide AI's own requests (Quick AI, chat, AI Commands): the shared system prompt plus any per-request block.
    public static func body(_ r: AIRequest) -> JSONValue {
        var system = AIRequestBuilder.systemPrompt
        if let extra = r.system?.trimmingCharacters(in: .whitespacesAndNewlines), !extra.isEmpty { system += "\n\n" + extra }
        let tools: [JSONValue] = r.tools.map { ["name": .string($0.name), "description": .string($0.description), "input_schema": $0.inputSchema] }
        return body(model: r.model, effort: r.effort, system: system, messages: r.messages.map(\.json), tools: tools)
    }
}

/// Folds Chat Completions stream chunks into the final message, emitting the same events as the Anthropic path.
public struct OpenAIStreamAccumulator: Sendable {
    private struct Call: Sendable {
        var id = ""
        var name = ""
        var arguments = ""
    }
    public private(set) var model: String
    public private(set) var stopReason: String?
    public private(set) var done = false
    private var started = false
    private var text = ""
    private var refusal = ""
    private var calls: [Int: Call] = [:]
    private var inputTokens: Int?
    private var outputTokens: Int?

    public init(requestedModel: String) { model = requestedModel }

    public mutating func consume(_ e: SSEParser.Event) throws -> [AIStreamEvent] {
        if e.data == "[DONE]" { done = true; return [] }
        guard let data = try? JSONDecoder().decode(JSONValue.self, from: Data(e.data.utf8)) else { return [] }
        if let err = data["error"], err != .null {
            throw AIError(.other, "OpenAI API error: \(err["message"]?.stringValue ?? "stream error")")
        }
        var out: [AIStreamEvent] = []
        if !started {
            started = true
            if let m = data["model"]?.stringValue, !m.isEmpty { model = m }
            out.append(.started(model: model))
        }
        if let u = data["usage"], u != .null {
            inputTokens = u["prompt_tokens"]?.intValue
            outputTokens = u["completion_tokens"]?.intValue
        }
        guard let choice = data["choices"]?.arrayValue?.first else { return out }
        let delta = choice["delta"]
        if let t = delta?["content"]?.stringValue, !t.isEmpty {
            text += t
            out.append(.textDelta(t))
        }
        if let r = delta?["refusal"]?.stringValue { refusal += r }
        for c in delta?["tool_calls"]?.arrayValue ?? [] {
            let i = c["index"]?.intValue ?? calls.count
            var call = calls[i] ?? Call()
            if let id = c["id"]?.stringValue, !id.isEmpty { call.id = id }
            if let n = c["function"]?["name"]?.stringValue { call.name += n }
            if let a = c["function"]?["arguments"]?.stringValue { call.arguments += a }
            calls[i] = call
        }
        if let f = choice["finish_reason"]?.stringValue {
            switch f {
            case "stop": stopReason = "end_turn"
            case "tool_calls", "function_call": stopReason = "tool_use"
            case "length": stopReason = "max_tokens"
            case "content_filter": stopReason = "refusal"
            default: stopReason = f
            }
            if !refusal.isEmpty && text.isEmpty { stopReason = "refusal" }
            for (_, c) in calls.sorted(by: { $0.key < $1.key }) { out.append(.toolUse(id: c.id, name: c.name, input: Self.parse(c.arguments))) }
        }
        return out
    }

    private static func parse(_ args: String) -> JSONValue {
        args.isEmpty ? .object([:]) : ((try? JSONDecoder().decode(JSONValue.self, from: Data(args.utf8))) ?? .object([:]))
    }

    public var finished: Bool { done || stopReason != nil }

    public var outcome: AIStreamOutcome {
        var content: [AIContentBlock] = text.isEmpty ? [] : [.text(text)]
        for (i, c) in calls.sorted(by: { $0.key < $1.key }) {
            content.append(.toolUse(id: c.id.isEmpty ? "call_\(i)" : c.id, name: c.name, input: Self.parse(c.arguments)))
        }
        // Some compatible servers end tool turns with "stop".
        let reason = stopReason == "end_turn" && !calls.isEmpty ? "tool_use" : stopReason
        return AIStreamOutcome(text: text, model: model, stopReason: reason, content: content, inputTokens: inputTokens, outputTokens: outputTokens)
    }
}

/// Stateless Chat Completions client. `baseURL` includes the version path (https://api.openai.com/v1).
public struct OpenAIClient: AIChatClient {
    public static let defaultBaseURL = URL(string: "https://api.openai.com/v1")!
    public var vendor: String { baseURL.host == "api.openai.com" ? "OpenAI" : "the AI server" }
    public let apiKey: String
    public let baseURL: URL
    public let maxRetries: Int
    let session: URLSession

    public init(apiKey: String, baseURL: URL? = nil, maxRetries: Int = 1, timeout: TimeInterval = 120) {
        self.apiKey = apiKey
        self.baseURL = baseURL ?? Self.defaultBaseURL
        self.maxRetries = maxRetries
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.httpCookieStorage = nil
        cfg.urlCache = nil
        session = URLSession(configuration: cfg)
    }

    func request(path: String, method: String, body: Data?) -> URLRequest {
        var r = URLRequest(url: baseURL.appendingPathComponent(path))
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.setValue("Bearer \(apiKey)", forHTTPHeaderField: "authorization")
        r.httpBody = body
        return r
    }

    func request(body: JSONValue) -> URLRequest {
        request(path: "chat/completions", method: "POST", body: (try? JSONEncoder.glideCompact.encode(body)) ?? Data())
    }

    public func stream(_ req: AIRequest) -> AsyncThrowingStream<AIStreamEvent, Error> {
        stream(request: request(body: OpenAIFormat.body(req)), model: req.model)
    }

    /// Streams a prepared request. Retries once (429 / 5xx / connection errors) only before any output.
    func stream(request urlRequest: URLRequest, model: String) -> AsyncThrowingStream<AIStreamEvent, Error> {
        let session = session
        let maxRetries = maxRetries
        let vendor = vendor
        return AsyncThrowingStream { continuation in
            let task = Task {
                var attempt = 0
                while true {
                    do {
                        try await Self.runStream(session: session, request: urlRequest, model: model, vendor: vendor, continuation: continuation)
                        continuation.finish()
                        return
                    } catch let e as AnthropicClient.RetryableBeforeOutput where attempt < maxRetries && !Task.isCancelled {
                        attempt += 1
                        try? await Task.sleep(for: .milliseconds(Int(min(4, max(0.2, e.retryAfter ?? 0.5)) * 1000)))
                    } catch let e as AnthropicClient.RetryableBeforeOutput {
                        continuation.finish(throwing: e.error)
                        return
                    } catch {
                        continuation.finish(throwing: Task.isCancelled ? CancellationError() : AIError.from(error, vendor: vendor))
                        return
                    }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func runStream(session: URLSession, request: URLRequest, model: String, vendor: String,
                          continuation: AsyncThrowingStream<AIStreamEvent, Error>.Continuation) async throws {
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch let u as URLError where u.code != .cancelled {
            throw AnthropicClient.RetryableBeforeOutput(error: AIError.from(u, vendor: vendor), retryAfter: nil)
        }
        guard let http = response as? HTTPURLResponse else { throw AIError(.network, "No HTTP response") }
        if !(200..<300).contains(http.statusCode) {
            var body = Data()
            for try await b in bytes {
                body.append(b)
                if body.count > 64_000 { break }
            }
            let err = AIError.from(status: http.statusCode, body: body, vendor: vendor)
            if err.retryable { throw AnthropicClient.RetryableBeforeOutput(error: err, retryAfter: http.value(forHTTPHeaderField: "retry-after").flatMap(Double.init)) }
            throw err
        }
        var parser = SSEParser()
        var acc = OpenAIStreamAccumulator(requestedModel: model)
        var line = Data()
        func handle(_ event: SSEParser.Event) throws {
            for e in try acc.consume(event) { continuation.yield(e) }
        }
        for try await byte in bytes {
            if byte == 0x0A {
                if let ev = parser.feed(line: String(decoding: line, as: UTF8.self)) { try handle(ev) }
                line.removeAll(keepingCapacity: true)
            } else {
                line.append(byte)
            }
        }
        if !line.isEmpty, let ev = parser.feed(line: String(decoding: line, as: UTF8.self)) { try handle(ev) }
        if let ev = parser.flush() { try handle(ev) }
        try Task.checkCancellation()
        let out = acc.outcome
        if out.stopReason == "refusal" { throw AIError.refused }
        if !acc.finished { throw AIError(.network, "The answer was cut off (connection closed early).") }
        continuation.yield(.finished(out))
    }

    /// Checks the key with the Models API (no tokens generated).
    public func testKey(model: String) async throws -> String {
        let r = request(path: "models/\(model)", method: "GET", body: nil)
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await session.data(for: r) } catch { throw AIError.from(error, vendor: vendor) }
        guard let http = response as? HTTPURLResponse else { throw AIError(.network, "No HTTP response") }
        guard (200..<300).contains(http.statusCode) else { throw AIError.from(status: http.statusCode, body: data, vendor: vendor) }
        let obj = try? JSONDecoder().decode(JSONValue.self, from: data)
        return obj?["id"]?.stringValue ?? model
    }
}
