import Foundation
import GlideCore
import Testing
@testable import GlideFeatures

/// phone-notify logic: topics, server URLs, messages (nothing sensitive), rate limit and backoff.
@Suite("phone-notify logic")
struct PhoneNotifyLogicTests {
    @Test func topicsAreRandomGlideTopics() {
        var seen: Set<String> = []
        for _ in 0..<200 {
            let t = PhoneNotifyRules.newTopic()
            #expect(t.hasPrefix("glide-"))
            let hex = t.dropFirst("glide-".count)
            #expect(hex.count == 32)
            #expect(hex.allSatisfy { "0123456789abcdef".contains($0) })
            #expect(PhoneNotifyRules.isValidTopic(t))
            seen.insert(t)
        }
        #expect(seen.count == 200)
        #expect(!PhoneNotifyRules.isValidTopic(""))
        #expect(!PhoneNotifyRules.isValidTopic("has space"))
        #expect(!PhoneNotifyRules.isValidTopic("a/b"))
        #expect(!PhoneNotifyRules.isValidTopic("tëst"))
        #expect(!PhoneNotifyRules.isValidTopic(String(repeating: "a", count: 65)))
        #expect(PhoneNotifyRules.isValidTopic("my_topic-1"))
    }

    @Test func serverURLValidation() throws {
        #expect(try PhoneNotifyRules.validateServer("https://ntfy.sh").absoluteString == "https://ntfy.sh")
        #expect(try PhoneNotifyRules.validateServer(" https://NTFY.example.com/ ").absoluteString == "https://ntfy.example.com")
        #expect(try PhoneNotifyRules.validateServer("https://example.com/ntfy/").absoluteString == "https://example.com/ntfy")
        #expect(try PhoneNotifyRules.validateServer("https://example.com:8443").absoluteString == "https://example.com:8443")
        // http only on loopback (test servers)
        #expect(try PhoneNotifyRules.validateServer("http://127.0.0.1:8080").absoluteString == "http://127.0.0.1:8080")
        #expect(try PhoneNotifyRules.validateServer("http://localhost:2586").absoluteString == "http://localhost:2586")
        #expect(throws: PhoneError.self) { try PhoneNotifyRules.validateServer("http://ntfy.sh") }
        #expect(throws: PhoneError.self) { try PhoneNotifyRules.validateServer("http://192.168.1.10") }
        #expect(throws: PhoneError.self) { try PhoneNotifyRules.validateServer("ftp://ntfy.sh") }
        #expect(throws: PhoneError.self) { try PhoneNotifyRules.validateServer("ntfy.sh") }
        #expect(throws: PhoneError.self) { try PhoneNotifyRules.validateServer("https://user:pw@ntfy.sh") }
        #expect(throws: PhoneError.self) { try PhoneNotifyRules.validateServer("https://ntfy.sh/?auth=x") }
        #expect(throws: PhoneError.self) { try PhoneNotifyRules.validateServer("https://ntfy.sh/#x") }
        #expect(throws: PhoneError.self) { try PhoneNotifyRules.validateServer("") }
    }

    @Test func settingsApplyValidatesAndGeneratesTopic() throws {
        var s = PhoneNotifySettings()
        #expect(!s.enabled && s.server == "https://ntfy.sh" && s.topic.isEmpty)
        try s.apply(["enabled": true])
        #expect(s.enabled && PhoneNotifyRules.isValidTopic(s.topic) && s.topic.hasPrefix("glide-"))
        #expect(throws: PhoneError.self) { try s.apply(["server": "http://evil.example"]) }
        #expect(s.server == "https://ntfy.sh")
        try s.apply(["server": "https://push.example.org/", "timer": false])
        #expect(s.server == "https://push.example.org" && !s.timer && s.automation)
        try s.apply(["server": ""])
        #expect(s.server == "https://ntfy.sh")
        #expect(throws: PhoneError.self) { try s.apply(["topic": "bad topic"]) }
        let round = PhoneNotifySettings(json: s.json)
        #expect(round == s)
        #expect(!PhoneNotifySettings(json: nil).enabled)
    }

    @Test func messagesStayShortAndPlain() {
        let t = PhoneNotifyMessages.timerFinished(label: "Tea\nsecond line " + String(repeating: "x", count: 200))
        #expect(t.title == "Timer done")
        #expect(!t.body.contains("\n"))
        #expect(t.body.count <= 70)
        #expect(t.tags == ["alarm_clock"])

        let a = PhoneNotifyMessages.automationFailed(name: "Morning")
        #expect(a.body.contains("\"Morning\""))
        #expect(a.title == "Automation failed")

        // Confirmations carry only the device and the action title; with the LAN server on, a Review link.
        let c = PhoneNotifyMessages.confirmation(.phone(device: "Tobi's iPhone", action: "Ask Glide Agent"), id: "abc_123", lanBaseURL: "http://192.168.1.5:7470")
        #expect(c.body == "Tobi's iPhone wants to: Ask Glide Agent.")
        #expect(c.click == "http://192.168.1.5:7470/#approve=abc_123")
        #expect(c.actions == [.init(label: "Review", url: "http://192.168.1.5:7470/#approve=abc_123")])
        #expect(c.headers["Actions"] == "view, Review, http://192.168.1.5:7470/#approve=abc_123, clear=true")
        #expect(c.headers["Click"] == "http://192.168.1.5:7470/#approve=abc_123")
        #expect(c.headers["Tags"] == "raised_hand")
        #expect(c.headers["Priority"] == "4")

        let off = PhoneNotifyMessages.confirmation(.phone(device: "iPhone", action: "Run"), id: "x", lanBaseURL: nil)
        #expect(off.click == nil && off.actions.isEmpty && off.headers["Actions"] == nil)
        // Unsafe ids never make it into a link.
        let bad = PhoneNotifyMessages.confirmation(.phone(device: "iPhone", action: "Run"), id: "x\"; view, Evil, http://e", lanBaseURL: "http://10.0.0.2:7470")
        #expect(bad.click == nil && bad.actions.isEmpty)
        // MCP requests are answered on the Mac only.
        let mcp = PhoneNotifyMessages.confirmation(.mcp(client: "Claude", tool: "Run Command"), id: "req-1", lanBaseURL: "http://10.0.0.2:7470")
        #expect(mcp.click == nil && mcp.body.contains("Answer it on the Mac"))

        let ag = PhoneNotifyMessages.confirmation(.agent(tools: ["Open URL", "Copy to Clipboard", "Start Timer", "Create Note"]), id: "agent-1", lanBaseURL: nil)
        #expect(ag.body == "Glide Agent wants to: Open URL, Copy to Clipboard, Start Timer and 1 more.")
    }

    @Test func confirmationBodiesNeverIncludeArguments() {
        // The phone-core confirmation summary can quote arguments; notifications use only the action title.
        let secret = "my clipboard secret 4111 1111"
        let m = PhoneNotifyMessages.confirmation(.phone(device: "iPhone", action: "Set Mac clipboard"), id: "r1", lanBaseURL: nil)
        #expect(!m.body.contains(secret) && !m.title.contains(secret))
        let agent = PhoneNotifyMessages.confirmation(.agent(tools: ["Copy to Clipboard"]), id: "a1", lanBaseURL: nil)
        #expect(agent.body == "Glide Agent wants to: Copy to Clipboard.")
    }

    @Test func nonASCIIHeadersAreEncoded() {
        #expect(PhoneNotifyMessage.headerValue("Timer done") == "Timer done")
        let enc = PhoneNotifyMessage.headerValue("Tee ist fertig ☕")
        #expect(enc.hasPrefix("=?UTF-8?B?") && enc.hasSuffix("?="))
        let b64 = enc.dropFirst(10).dropLast(2)
        #expect(Data(base64Encoded: String(b64)).map { String(decoding: $0, as: UTF8.self) } == "Tee ist fertig ☕")
        #expect(PhoneNotifyMessage.headerValue("a\r\nX-Evil: 1") != "a\r\nX-Evil: 1")
        #expect(PhoneNotifyMessage.actionLabel("Re,vi;ew\"") == "Review")
    }

    func take(_ r: inout PhoneNotifyRateLimiter, _ at: Date) -> Bool { r.take(now: at) }

    @Test func rateLimitSlidingWindow() {
        var r = PhoneNotifyRateLimiter(limit: 3, window: 60)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        #expect(take(&r, t0))
        #expect(take(&r, t0.addingTimeInterval(1)))
        #expect(take(&r, t0.addingTimeInterval(2)))
        #expect(!take(&r, t0.addingTimeInterval(3)))
        #expect(!take(&r, t0.addingTimeInterval(59.9)))
        #expect(take(&r, t0.addingTimeInterval(60)))
        #expect(!take(&r, t0.addingTimeInterval(60.5)))
        #expect(take(&r, t0.addingTimeInterval(62)))
    }

    @Test func backoffPolicy() {
        #expect(PhoneNotifyBackoff.shouldRetry(status: nil))
        #expect(PhoneNotifyBackoff.shouldRetry(status: 429))
        #expect(PhoneNotifyBackoff.shouldRetry(status: 502))
        #expect(!PhoneNotifyBackoff.shouldRetry(status: 400))
        #expect(!PhoneNotifyBackoff.shouldRetry(status: 401))
        #expect(!PhoneNotifyBackoff.shouldRetry(status: 403))
        #expect(PhoneNotifyBackoff.delay(afterAttempt: 1) == 1)
        #expect(PhoneNotifyBackoff.delay(afterAttempt: 2) == 2)
        #expect(PhoneNotifyBackoff.delay(afterAttempt: 3) == 4)
        #expect(PhoneNotifyBackoff.delay(afterAttempt: 10) == 30)
        #expect(PhoneNotifyBackoff.delay(afterAttempt: 1, retryAfter: "5") == 5)
        #expect(PhoneNotifyBackoff.delay(afterAttempt: 1, retryAfter: "3600") == 30)
        #expect(PhoneNotifyBackoff.delay(afterAttempt: 2, retryAfter: "soon") == 2)
    }

    @Test func requestShape() throws {
        let m = PhoneNotifyMessages.confirmation(.phone(device: "iPhone", action: "Run"), id: "r1", lanBaseURL: "http://10.0.0.2:7470")
        let r = PhoneNtfySender.request(m, server: try PhoneNotifyRules.validateServer("https://ntfy.sh"), topic: "glide-abc", token: "tk_123")
        #expect(r.url?.absoluteString == "https://ntfy.sh/glide-abc")
        #expect(r.httpMethod == "POST")
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer tk_123")
        #expect(r.value(forHTTPHeaderField: "Title") == "Glide needs your OK")
        #expect(String(decoding: r.httpBody ?? Data(), as: UTF8.self) == "iPhone wants to: Run.")
        let noToken = PhoneNtfySender.request(m, server: try PhoneNotifyRules.validateServer("https://ntfy.sh"), topic: "glide-abc", token: nil)
        #expect(noToken.value(forHTTPHeaderField: "Authorization") == nil)
    }
}
