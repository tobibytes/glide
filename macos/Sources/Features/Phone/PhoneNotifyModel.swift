import Foundation
import GlideCore
import Security

// phone-notify: the pure parts of "Notifications to the phone" (docs/PHONE.md, D): settings, server URL and topic
// validation, topic generation, message building, rate limiting and retry backoff. No I/O here.

/// What can be sent. Each kind has its own switch in Settings → iPhone → Notifications (except `test`).
enum PhoneNotifyKind: String, Sendable, CaseIterable {
    case timer, automation, confirmation, test
}

/// `settings.features.phone.notify` (one object inside the phone feature's bag; written as a whole).
struct PhoneNotifySettings: Equatable, Sendable {
    static let defaultServer = "https://ntfy.sh"
    var enabled = false
    var server = PhoneNotifySettings.defaultServer
    /// Generated the first time notifications are turned on ("glide-" + 32 hex characters).
    var topic = ""
    var timer = true
    var automation = true
    var confirmation = true

    init() {}
    init(json v: JSONValue?) {
        let o = v?.objectValue ?? [:]
        enabled = o["enabled"]?.boolValue == true
        if let s = o["server"]?.stringValue, !s.isEmpty { server = s }
        topic = o["topic"]?.stringValue ?? ""
        timer = o["timer"]?.boolValue != false
        automation = o["automation"]?.boolValue != false
        confirmation = o["confirmation"]?.boolValue != false
    }

    var json: JSONValue {
        ["enabled": .bool(enabled), "server": .string(server), "topic": .string(topic), "timer": .bool(timer),
         "automation": .bool(automation), "confirmation": .bool(confirmation)]
    }

    func wants(_ k: PhoneNotifyKind) -> Bool {
        switch k {
        case .timer: return timer
        case .automation: return automation
        case .confirmation: return confirmation
        case .test: return true
        }
    }

    /// Apply a partial update (unknown keys and wrong types are ignored). Server and topic are validated.
    mutating func apply(_ patch: JSONValue) throws {
        if let b = patch["enabled"]?.boolValue { enabled = b }
        for (k, path) in [("timer", \PhoneNotifySettings.timer), ("automation", \.automation), ("confirmation", \.confirmation)] {
            if let b = patch[k]?.boolValue { self[keyPath: path] = b }
        }
        if let s = patch["server"]?.stringValue {
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            server = trimmed.isEmpty ? Self.defaultServer : try PhoneNotifyRules.validateServer(trimmed).absoluteString
        }
        if let t = patch["topic"]?.stringValue {
            guard PhoneNotifyRules.isValidTopic(t) else { throw PhoneError.badArgs(PhoneNotifyRules.topicHint) }
            topic = t
        }
        if enabled && topic.isEmpty { topic = PhoneNotifyRules.newTopic() }
    }
}

enum PhoneNotifyRules {
    static let topicHint = "Use 1 to 64 letters, numbers, - or _ for the topic."

    /// "glide-" + 32 random hex characters (128 bits): the topic is the only secret on a public ntfy server.
    static func newTopic() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            var g = SystemRandomNumberGenerator()
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255, using: &g) }
        }
        return "glide-" + bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func isValidTopic(_ t: String) -> Bool {
        !t.isEmpty && t.count <= 64 && t.unicodeScalars.allSatisfy { ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "-" || $0 == "_" }
    }

    static func isLoopback(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return h == "localhost" || h == "::1" || h == "127.0.0.1" || h.hasPrefix("127.")
    }

    /// https only (http is allowed for loopback test servers). No credentials, query or fragment in the URL; the
    /// access token goes in a header. A trailing slash is dropped so `<server>/<topic>` is well formed.
    static func validateServer(_ raw: String) throws -> URL {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.count <= 300, let c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty else {
            throw PhoneError.badArgs("That server address isn't a valid URL. Use something like https://ntfy.sh.")
        }
        guard scheme == "https" || (scheme == "http" && isLoopback(host)) else {
            throw PhoneError.badArgs("Use an https:// address for the ntfy server, so the notification and your token are encrypted on the way.")
        }
        guard c.user == nil, c.password == nil else {
            throw PhoneError.badArgs("Don't put a user name or password in the address. Add an access token instead.")
        }
        guard c.query == nil, c.fragment == nil else {
            throw PhoneError.badArgs("Remove the ? or # part from the server address.")
        }
        var out = c
        out.scheme = scheme
        out.host = host.lowercased()
        while out.path.hasSuffix("/") { out.path.removeLast() }
        guard let url = out.url else { throw PhoneError.badArgs("That server address isn't a valid URL. Use something like https://ntfy.sh.") }
        return url
    }

    /// The link the ntfy app opens to subscribe (`ntfy://<host>/<topic>` for self-hosted servers works too, but the
    /// https link also opens in Safari, which offers the app).
    static func subscribeURL(server: String, topic: String) -> String {
        "\(server)/\(topic)"
    }
}

/// One ntfy message, published as `POST <server>/<topic>` with the body as the text and the options as headers
/// (Title, Tags, Priority, Click, Actions), as documented at https://docs.ntfy.sh/publish/.
struct PhoneNotifyMessage: Equatable, Sendable {
    struct Action: Equatable, Sendable {
        var label: String
        var url: String
    }

    var kind: PhoneNotifyKind
    var title: String
    var body: String
    var tags: [String] = []
    /// 1…5 (3 is ntfy's default).
    var priority: Int?
    var click: String?
    var actions: [Action] = []

    static let maxTitle = 80
    static let maxBody = 200

    /// Header values. Non-ASCII values use RFC 2047 encoded words, which ntfy decodes.
    var headers: [String: String] {
        var h: [String: String] = ["Title": Self.headerValue(title)]
        if !tags.isEmpty { h["Tags"] = tags.joined(separator: ",") }
        if let priority { h["Priority"] = String(priority) }
        if let click { h["Click"] = click }
        if !actions.isEmpty {
            h["Actions"] = actions.map { "view, \(Self.actionLabel($0.label)), \($0.url), clear=true" }.joined(separator: "; ")
        }
        return h
    }

    static func headerValue(_ s: String) -> String {
        if s.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 0x20 && $0.value != 0x7f }) { return s }
        return "=?UTF-8?B?\(Data(s.utf8).base64EncodedString())?="
    }

    /// Labels sit inside a comma/semicolon separated header: keep them to plain ASCII words.
    static func actionLabel(_ s: String) -> String {
        String(s.unicodeScalars.filter { $0.isASCII && $0 != "," && $0 != ";" && $0 != "\"" && $0.value >= 0x20 }.map(Character.init))
    }

    /// One line, at most `n` characters, no control characters.
    static func clip(_ s: String, _ n: Int) -> String {
        let one = s.components(separatedBy: .newlines).joined(separator: " ")
            .unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.map(String.init).joined()
            .trimmingCharacters(in: .whitespaces)
        return one.count > n ? String(one.prefix(max(0, n - 1))) + "…" : one
    }
}

/// Builds every message Glide sends. Short, plain, and never with clipboard text, file contents, prompts,
/// tool arguments or error messages: only names the user chose (a timer's label, an automation's name) and the
/// kind of request that waits.
enum PhoneNotifyMessages {
    static func timerFinished(label: String) -> PhoneNotifyMessage {
        let l = PhoneNotifyMessage.clip(label, 60)
        return PhoneNotifyMessage(kind: .timer, title: "Timer done", body: l.isEmpty ? "Your timer is done." : "\(l) is done.",
                                  tags: ["alarm_clock"], priority: 4)
    }

    static func automationFailed(name: String) -> PhoneNotifyMessage {
        let n = PhoneNotifyMessage.clip(name, 60)
        return PhoneNotifyMessage(kind: .automation, title: "Automation failed",
                                  body: "\(n.isEmpty ? "An automation" : "\"\(n)\"") didn't finish. Open Automations in Glide to see why.",
                                  tags: ["warning"], priority: 3)
    }

    enum Source: Equatable, Sendable {
        /// A phone action waits (device name, action title).
        case phone(device: String, action: String)
        /// Glide Agent wants to run these tools (titles only).
        case agent(tools: [String])
        /// An MCP client's tool call waits on the Mac (no remote approval).
        case mcp(client: String, tool: String)
    }

    /// `lanBaseURL` is set while the LAN server runs: the notification then opens Glide Remote at the request.
    static func confirmation(_ source: Source, id: String?, lanBaseURL: String?) -> PhoneNotifyMessage {
        var m: PhoneNotifyMessage
        switch source {
        case let .phone(device, action):
            m = PhoneNotifyMessage(kind: .confirmation, title: "Glide needs your OK",
                                   body: "\(PhoneNotifyMessage.clip(device, 40)) wants to: \(PhoneNotifyMessage.clip(action, 60)).")
        case let .agent(tools):
            let names = tools.prefix(3).map { PhoneNotifyMessage.clip($0, 30) }.joined(separator: ", ")
            let more = tools.count > 3 ? " and \(tools.count - 3) more" : ""
            m = PhoneNotifyMessage(kind: .confirmation, title: "Glide Agent needs your OK",
                                   body: names.isEmpty ? "Glide Agent wants to make a change." : "Glide Agent wants to: \(names)\(more).")
        case let .mcp(client, tool):
            m = PhoneNotifyMessage(kind: .confirmation, title: "MCP request waiting",
                                   body: "\(PhoneNotifyMessage.clip(client, 40)) wants to run \(PhoneNotifyMessage.clip(tool, 50)). Answer it on the Mac.")
        }
        m.tags = ["raised_hand"]
        m.priority = 4
        var remote = true
        if case .mcp = source { remote = false }
        if remote, let base = lanBaseURL, let id, isSafeID(id) {
            let link = "\(base.hasSuffix("/") ? String(base.dropLast()) : base)/#approve=\(id)"
            m.click = link
            m.actions = [.init(label: "Review", url: link)]
        }
        return m
    }

    static func test() -> PhoneNotifyMessage {
        PhoneNotifyMessage(kind: .test, title: "Test from Glide", body: "Notifications from your Mac are working.", tags: ["white_check_mark"])
    }

    static func isSafeID(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && id.unicodeScalars.allSatisfy { ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "-" || $0 == "_" }
    }
}

/// At most `limit` messages per `window` seconds (sliding window). Drops beyond that, so a burst of failing
/// automations can't flood the phone or get the topic rate-limited by ntfy.sh.
struct PhoneNotifyRateLimiter: Sendable {
    var limit = 6
    var window: TimeInterval = 60
    private(set) var sent: [Date] = []

    init(limit: Int = 6, window: TimeInterval = 60) {
        self.limit = limit
        self.window = window
    }

    /// True (and counts it) when one more message may go out now.
    mutating func take(now: Date = Date()) -> Bool {
        sent.removeAll { now.timeIntervalSince($0) >= window }
        guard sent.count < limit else { return false }
        sent.append(now)
        return true
    }
}

/// Retry policy: network errors, 429 and 5xx are retried with exponential backoff (1 s, 2 s, 4 s), honouring
/// Retry-After up to 30 s. Anything else (bad token, unknown topic) fails at once.
enum PhoneNotifyBackoff {
    static let maxAttempts = 4

    static func shouldRetry(status: Int?) -> Bool {
        guard let status else { return true } // no response: network error
        return status == 429 || (500...599).contains(status)
    }

    /// Delay before attempt `attempt + 1` (attempt counts from 1).
    static func delay(afterAttempt attempt: Int, retryAfter: String? = nil, base: TimeInterval = 1) -> TimeInterval {
        if let ra = retryAfter.flatMap({ TimeInterval($0.trimmingCharacters(in: .whitespaces)) }), ra >= 0 { return min(ra, 30) }
        return min(base * pow(2, Double(max(0, attempt - 1))), 30)
    }
}
