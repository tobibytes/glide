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
                    // `tool` messages are text-only: images a tool returned go in the user message that follows.
                    for img in (b["content"]?.arrayValue ?? []) where img["type"]?.stringValue == "image" { parts.append(imagePart(img)) }
                case "text":
                    parts.append(["type": "text", "text": .string(b["text"]?.stringValue ?? "")])
                case "image":
                    parts.append(imagePart(b))
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

    /// An Anthropic image block (base64 or url source) → a Chat Completions `image_url` part.
    static func imagePart(_ b: JSONValue) -> JSONValue {
        let src = b["source"]
        let url = src?["type"]?.stringValue == "url" ? (src?["url"]?.stringValue ?? "")
            : "data:\(src?["media_type"]?.stringValue ?? "image/png");base64,\(src?["data"]?.stringValue ?? "")"
        return ["type": "image_url", "image_url": ["url": .string(url)]]
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
        if acceptsReasoningEffort(model), AIModels.efforts.contains(effort) { o["reasoning_effort"] = .string(effort) }
        return .object(o)
    }

    /// The model id without a router prefix ("openai/gpt-5" → "gpt-5"), lower-cased.
    static func baseModel(_ model: String) -> String { (model.split(separator: "/").last.map(String.init) ?? model).lowercased() }

    /// Reasoning models (o-series, gpt-5 family) take `reasoning_effort`; chat models reject it, and so do
    /// o1-mini / o1-preview and the non-reasoning gpt-5 chat snapshots.
    public static func acceptsReasoningEffort(_ model: String) -> Bool {
        let m = baseModel(model)
        guard OpenAIModels.supportsEffort(model) else { return false }
        return !(m.hasPrefix("o1-mini") || m.hasPrefix("o1-preview") || m.hasPrefix("gpt-5-chat") || m.contains("-chat-latest"))
    }

    /// o1-mini / o1-preview accept neither `system` nor `developer` messages.
    static func rejectsSystemRole(_ model: String) -> Bool { let m = baseModel(model); return m.hasPrefix("o1-mini") || m.hasPrefix("o1-preview") }

    /// Final per-server adjustments to a Chat Completions body (pure; unit-tested).
    /// - api.openai.com + reasoning models: the system prompt is sent as a `developer` message (OpenAI's role for
    ///   o1+ / gpt-5; compatible servers such as Ollama or LM Studio only know `system`, so they keep it).
    /// - o1-mini / o1-preview: the system prompt is folded into the first user message.
    /// - Output cap: `max_completion_tokens` on api.openai.com (`max_tokens` is rejected by reasoning models),
    ///   `max_tokens` on compatible servers (what OpenRouter, Ollama and LM Studio read).
    public static func adapt(_ body: JSONValue, officialAPI: Bool) -> JSONValue {
        guard case var .object(o) = body else { return body }
        let model = o["model"]?.stringValue ?? ""
        if officialAPI, var msgs = o["messages"]?.arrayValue, let first = msgs.first, first["role"]?.stringValue == "system" {
            if rejectsSystemRole(model) {
                let sys = first["content"]?.stringValue ?? ""
                msgs.removeFirst()
                if let i = msgs.firstIndex(where: { $0["role"]?.stringValue == "user" }), case var .object(u) = msgs[i] {
                    switch u["content"] {
                    case let .string(t)?: u["content"] = .string(sys + "\n\n" + t)
                    case let .array(parts)?: u["content"] = .array([["type": "text", "text": .string(sys)]] + parts)
                    default: u["content"] = .string(sys)
                    }
                    msgs[i] = .object(u)
                }
            } else if OpenAIModels.supportsEffort(model) {
                msgs[0] = ["role": "developer", "content": first["content"] ?? ""]
            }
            o["messages"] = .array(msgs)
        }
        let cap = o["max_completion_tokens"] ?? o["max_tokens"]
        o["max_completion_tokens"] = nil
        o["max_tokens"] = nil
        if let cap { o[officialAPI ? "max_completion_tokens" : "max_tokens"] = cap }
        return .object(o)
    }

    /// Glide AI's own requests (Quick AI, chat, AI Commands): the shared system prompt plus any per-request block.
    public static func body(_ r: AIRequest) -> JSONValue {
        var system = AIRequestBuilder.systemPrompt
        if let extra = r.system?.trimmingCharacters(in: .whitespacesAndNewlines), !extra.isEmpty { system += "\n\n" + extra }
        let tools: [JSONValue] = r.tools.map { ["name": .string($0.name), "description": .string($0.description), "input_schema": $0.inputSchema] }
        let b = body(model: r.model, effort: r.effort, system: system, messages: r.messages.map(\.json), tools: tools)
        // Only an explicit small cap is sent: Glide's default (64k, sized for Claude) exceeds many models' output
        // limits, and leaving it out lets each model use its own maximum.
        guard r.maxTokens > 0, r.maxTokens < 16_384, case var .object(o) = b else { return b }
        o["max_completion_tokens"] = .int(Int64(r.maxTokens))
        return .object(o)
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

    let vendorLabel: String
    public init(requestedModel: String, vendor: String = "OpenAI") {
        model = requestedModel
        vendorLabel = vendor == "OpenAI" ? "OpenAI API" : "AI server"
    }

    public mutating func consume(_ e: SSEParser.Event) throws -> [AIStreamEvent] {
        let payload = e.data.trimmingCharacters(in: .whitespacesAndNewlines)
        if payload == "[DONE]" { done = true; return [] }
        guard let data = try? JSONDecoder().decode(JSONValue.self, from: Data(payload.utf8)) else { return [] }
        return try consume(chunk: data)
    }

    /// One parsed chunk (`chat.completion.chunk`), or a whole non-streamed `chat.completion` (`message` instead of
    /// `delta`) from servers that ignore `stream: true`.
    public mutating func consume(chunk data: JSONValue) throws -> [AIStreamEvent] {
        if let err = data["error"], err != .null {
            // OpenAI / OpenRouter: {"error":{"message":…}}; Ollama: {"error":"…"}.
            throw AIError(.other, "\(vendorLabel) error: \(err["message"]?.stringValue ?? err.stringValue ?? "stream error")")
        }
        var out: [AIStreamEvent] = []
        if !started {
            started = true
            if let m = data["model"]?.stringValue, !m.isEmpty { model = m }
            out.append(.started(model: model))
        }
        if let u = data["usage"], u != .null {
            inputTokens = u["prompt_tokens"]?.intValue ?? inputTokens
            outputTokens = u["completion_tokens"]?.intValue ?? outputTokens
        }
        guard let choice = data["choices"]?.arrayValue?.first else { return out }
        let delta = choice["delta"] ?? choice["message"]
        if let t = delta?["content"]?.stringValue, !t.isEmpty {
            text += t
            out.append(.textDelta(t))
        }
        if let r = delta?["refusal"]?.stringValue { refusal += r }
        for c in delta?["tool_calls"]?.arrayValue ?? [] { mergeToolCall(c) }
        if let f = choice["finish_reason"]?.stringValue, !f.isEmpty, stopReason == nil {
            switch f {
            case "stop", "eos", "end_turn": stopReason = "end_turn"
            case "tool_calls", "function_call", "tool_use": stopReason = "tool_use"
            case "length", "max_tokens": stopReason = "max_tokens"
            case "content_filter": stopReason = "refusal"
            default: stopReason = f
            }
            if !refusal.isEmpty && text.isEmpty && calls.isEmpty { stopReason = "refusal" }
            // Emitted once, with the same ids the final message carries.
            for b in toolBlocks { if case let .toolUse(id, name, input) = b { out.append(.toolUse(id: id, name: name, input: input)) } }
        }
        return out
    }

    /// Folds one `tool_calls` delta. OpenAI sends `index` + `id` + `name` once, then argument fragments; compatible
    /// servers may omit `index` or `id`, repeat the full name in every chunk, or send arguments as an object.
    private mutating func mergeToolCall(_ c: JSONValue) {
        let id = c["id"]?.stringValue ?? ""
        let i: Int
        if let idx = c["index"]?.intValue {
            i = idx
        } else if !id.isEmpty, let existing = calls.first(where: { $0.value.id == id })?.key {
            i = existing
        } else if !id.isEmpty || calls.isEmpty {
            i = (calls.keys.max() ?? -1) + 1
        } else {
            i = calls.keys.max() ?? 0
        }
        var call = calls[i] ?? Call()
        if !id.isEmpty { call.id = id }
        if let n = c["function"]?["name"]?.stringValue, !n.isEmpty {
            if call.name.isEmpty || n.hasPrefix(call.name) { call.name = n } else if !call.name.hasSuffix(n) { call.name += n }
        }
        switch c["function"]?["arguments"] {
        case let .string(a)?: call.arguments += a
        case let v? where v.objectValue != nil:
            call.arguments = (try? JSONEncoder.glideCompact.encode(v)).map { String(decoding: $0, as: UTF8.self) } ?? call.arguments
        default: break
        }
        calls[i] = call
    }

    private var toolBlocks: [AIContentBlock] {
        calls.sorted(by: { $0.key < $1.key }).map { i, c in .toolUse(id: c.id.isEmpty ? "call_\(i)" : c.id, name: c.name, input: Self.parse(c.arguments)) }
    }

    /// The refusal text, if the model refused.
    public var refusalText: String? { refusal.isEmpty ? nil : refusal }

    private static func parse(_ args: String) -> JSONValue {
        args.isEmpty ? .object([:]) : ((try? JSONDecoder().decode(JSONValue.self, from: Data(args.utf8))) ?? .object([:]))
    }

    public var finished: Bool { done || stopReason != nil }

    public var outcome: AIStreamOutcome {
        let content: [AIContentBlock] = (text.isEmpty ? [] : [.text(text)]) + toolBlocks
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

    /// api.openai.com (developer role, max_completion_tokens) vs an OpenAI-compatible server.
    public var isOfficialAPI: Bool { baseURL.host?.lowercased() == "api.openai.com" }

    func request(body: JSONValue) -> URLRequest {
        let adapted = OpenAIFormat.adapt(body, officialAPI: isOfficialAPI)
        var r = request(path: "chat/completions", method: "POST", body: (try? JSONEncoder.glideCompact.encode(adapted)) ?? Data())
        r.setValue("text/event-stream, application/json", forHTTPHeaderField: "accept")
        return r
    }

    /// A user-entered server URL → the API base: "http://localhost:11434" (Ollama) and "http://localhost:1234"
    /// (LM Studio) get "/v1"; a pasted ".../chat/completions" endpoint is trimmed back to its base.
    public static func normalizedBaseURL(_ raw: String) -> URL? {
        var t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasSuffix("/") { t.removeLast() }
        for suffix in ["/chat/completions", "/completions"] where t.lowercased().hasSuffix(suffix) { t.removeLast(suffix.count) }
        guard var c = URLComponents(string: t), c.scheme != nil, c.host?.isEmpty == false else { return nil }
        if c.path.isEmpty || c.path == "/" { c.path = "/v1" }
        return c.url
    }

    /// HTTP errors, with the shapes compatible servers use ({"error":"…"} from Ollama, HTML / text 404s from a
    /// wrong base URL).
    static func httpError(status: Int, body: Data, vendor: String, official: Bool) -> AIError {
        let obj = try? JSONDecoder().decode(JSONValue.self, from: body)
        if !official, let msg = obj?["error"]?.stringValue ?? obj?["error"]?["message"]?.stringValue ?? obj?["message"]?.stringValue {
            switch status {
            case 401, 403, 429, 500...599: break
            case 404: return AIError(.badRequest, "The AI server says: \(msg.prefix(300)). Check the model name in Settings → AI.", status: status)
            default: return AIError(.badRequest, "Request rejected: \(msg.prefix(300))", status: status)
            }
        }
        if status == 404 && obj == nil {
            return AIError(.badRequest, "\(official ? "OpenAI" : "The AI server") has no chat endpoint at this address. Check the server URL in Settings → AI (it usually ends in /v1).", status: status)
        }
        return AIError.from(status: status, body: body, vendor: vendor)
    }

    public func stream(_ req: AIRequest) -> AsyncThrowingStream<AIStreamEvent, Error> {
        stream(request: request(body: OpenAIFormat.body(req)), model: req.model)
    }

    /// Streams a prepared request. Retries once (429 / 5xx / connection errors) only before any output.
    func stream(request urlRequest: URLRequest, model: String) -> AsyncThrowingStream<AIStreamEvent, Error> {
        let session = session
        let maxRetries = maxRetries
        let vendor = vendor
        let official = isOfficialAPI
        return AsyncThrowingStream { continuation in
            let task = Task {
                var attempt = 0
                while true {
                    do {
                        try await Self.runStream(session: session, request: urlRequest, model: model, vendor: vendor, official: official, continuation: continuation)
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

    static func runStream(session: URLSession, request: URLRequest, model: String, vendor: String, official: Bool = true,
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
            let err = httpError(status: http.statusCode, body: body, vendor: vendor, official: official)
            if err.retryable { throw AnthropicClient.RetryableBeforeOutput(error: err, retryAfter: http.value(forHTTPHeaderField: "retry-after").flatMap(Double.init)) }
            throw err
        }
        var parser = SSEParser()
        var acc = OpenAIStreamAccumulator(requestedModel: model, vendor: vendor)
        var line = Data()
        func handle(_ event: SSEParser.Event) throws {
            for e in try acc.consume(event) { continuation.yield(e) }
        }
        // Some compatible servers / proxies ignore `stream: true` and answer with one chat.completion JSON.
        let type = (http.value(forHTTPHeaderField: "content-type") ?? "").lowercased()
        if type.contains("application/json") {
            var body = Data()
            for try await b in bytes { body.append(b) }
            guard let obj = try? JSONDecoder().decode(JSONValue.self, from: body) else { throw AIError(.other, "\(vendor) sent an unreadable answer.") }
            for e in try acc.consume(chunk: obj) { continuation.yield(e) }
            if !acc.finished { _ = try acc.consume(chunk: ["choices": [["delta": [:], "finish_reason": "stop"]]]) }
            return try finish(acc, official: official, continuation)
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
        try finish(acc, official: official, continuation)
    }

    private static func finish(_ acc: OpenAIStreamAccumulator, official: Bool, _ continuation: AsyncThrowingStream<AIStreamEvent, Error>.Continuation) throws {
        let out = acc.outcome
        if out.stopReason == "refusal" { throw AIError.refused }
        // No finish_reason and no [DONE]: a stream that just stopped. api.openai.com always ends properly, so that
        // is a cut-off; compatible servers that close without either are accepted when they sent an answer.
        if !acc.finished && (official || out.content.isEmpty) { throw AIError(.network, "The answer was cut off (connection closed early).") }
        continuation.yield(.finished(out))
    }

    /// Checks the key with the Models API (no tokens generated): GET models/<id>, and — for servers without that
    /// route (OpenRouter ids contain "/", LM Studio) — the model list.
    public func testKey(model: String) async throws -> String {
        func get(_ path: String) async throws -> (Data, HTTPURLResponse) {
            let (data, response): (Data, URLResponse)
            do { (data, response) = try await session.data(for: request(path: path, method: "GET", body: nil)) } catch { throw AIError.from(error, vendor: vendor) }
            guard let http = response as? HTTPURLResponse else { throw AIError(.network, "No HTTP response") }
            return (data, http)
        }
        let (data, http) = try await get("models/\(model)")
        if (200..<300).contains(http.statusCode) {
            return (try? JSONDecoder().decode(JSONValue.self, from: data))?["id"]?.stringValue ?? model
        }
        guard http.statusCode == 404 || http.statusCode == 405 else { throw Self.httpError(status: http.statusCode, body: data, vendor: vendor, official: isOfficialAPI) }
        let (listData, list) = try await get("models")
        guard (200..<300).contains(list.statusCode) else { throw Self.httpError(status: list.statusCode, body: listData, vendor: vendor, official: isOfficialAPI) }
        let ids = ((try? JSONDecoder().decode(JSONValue.self, from: listData))?["data"]?.arrayValue ?? []).compactMap { $0["id"]?.stringValue }
        if ids.isEmpty || ids.contains(model) { return model }
        throw AIError(.badRequest, "Connected, but \(isOfficialAPI ? "OpenAI" : "the AI server") has no model “\(model)”. Available: \(ids.prefix(8).joined(separator: ", "))", status: 404)
    }
}
