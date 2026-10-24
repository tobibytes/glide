import Foundation
import GlideCore
import GlideTestHarness
import Testing
@testable import GlideFeatures

/// The notifier against a loopback fake ntfy server: the right POSTs, retries with backoff, rate limit, switches.
@MainActor @Suite("phone-notify sending", .serialized)
struct PhoneNotifySendTests {
    func notifier(_ ntfy: FakeNtfy, token: String? = nil, _ change: (inout PhoneNotifySettings) -> Void = { _ in }) -> (PhoneNotifier, () -> PhoneNotifySettings) {
        var s = PhoneNotifySettings()
        s.enabled = true
        s.server = ntfy.baseURL
        s.topic = "glide-0123456789abcdef0123456789abcdef"
        change(&s)
        final class Box { var s: PhoneNotifySettings; init(_ s: PhoneNotifySettings) { self.s = s } }
        let box = Box(s)
        let n = PhoneNotifier(settings: { box.s }, saveSettings: { box.s = $0 }, tokens: MemorySecretStore(token))
        n.backoffBase = 0.02
        return (n, { box.s })
    }

    @Test func postsTitleTagsActionsClickAndToken() async throws {
        let ntfy = try FakeNtfy()
        defer { ntfy.stop() }
        let (n, _) = notifier(ntfy, token: "tk_secret_1")
        let m = PhoneNotifyMessages.confirmation(.phone(device: "Test iPhone", action: "Ask Glide Agent"), id: "req_1", lanBaseURL: "http://127.0.0.1:7470")
        let outcome = await n.post(m).value
        #expect(outcome == .sent)
        let p = try #require(ntfy.posts.first)
        #expect(p.path == "/glide-0123456789abcdef0123456789abcdef")
        #expect(p.headers["title"] == "Glide needs your OK")
        #expect(p.headers["tags"] == "raised_hand")
        #expect(p.headers["priority"] == "4")
        #expect(p.headers["click"] == "http://127.0.0.1:7470/#approve=req_1")
        #expect(p.headers["actions"] == "view, Review, http://127.0.0.1:7470/#approve=req_1, clear=true")
        #expect(p.headers["authorization"] == "Bearer tk_secret_1")
        #expect(String(decoding: p.body, as: UTF8.self) == "Test iPhone wants to: Ask Glide Agent.")
        #expect(n.history.first?.outcome == .sent)
    }

    @Test func retriesServerErrorsWithBackoff() async throws {
        let ntfy = try FakeNtfy(statuses: [503, 429])
        defer { ntfy.stop() }
        let (n, _) = notifier(ntfy)
        let t0 = Date()
        let outcome = await n.post(PhoneNotifyMessages.test()).value
        #expect(outcome == .sent)
        #expect(ntfy.posts.count == 3)
        #expect(Date().timeIntervalSince(t0) >= 0.02) // waited before retrying
        #expect(n.history.first?.attempts == 3)
    }

    @Test func givesUpAfterMaxAttemptsAndDoesNotRetryAuthErrors() async throws {
        let ntfy = try FakeNtfy(statuses: [500, 500, 500, 500, 500])
        defer { ntfy.stop() }
        var logs: [String] = []
        let (n, _) = notifier(ntfy, token: "tk_hidden")
        n.log = { logs.append($0) }
        let outcome = await n.post(PhoneNotifyMessages.test()).value
        #expect(outcome == .failed(status: 500))
        #expect(ntfy.posts.count == PhoneNotifyBackoff.maxAttempts)
        #expect(logs.count == 1)
        // Logs never carry the topic or token.
        #expect(!logs.joined().contains("glide-0123") && !logs.joined().contains("tk_hidden"))

        let auth = try FakeNtfy(statuses: [403])
        defer { auth.stop() }
        let (n2, _) = notifier(auth)
        #expect(await n2.post(PhoneNotifyMessages.test()).value == .failed(status: 403))
        #expect(auth.posts.count == 1)
        #expect(PhoneNotifier.describe(.failed(status: 403)).contains("access token"))
    }

    @Test func unreachableServerFailsWithoutBlocking() async throws {
        let ntfy = try FakeNtfy()
        let base = ntfy.baseURL
        ntfy.stop() // nothing listens there anymore
        var s = PhoneNotifySettings()
        s.enabled = true
        s.server = base
        s.topic = "glide-test"
        let n = PhoneNotifier(settings: { s }, saveSettings: { _ in }, tokens: MemorySecretStore())
        n.backoffBase = 0.01
        let task = n.post(PhoneNotifyMessages.test())
        #expect(n.inFlight == 1) // post returned at once
        #expect(await task.value == .failed(status: nil))
        #expect(n.inFlight == 0)
    }

    @Test func switchesAndRateLimit() async throws {
        let ntfy = try FakeNtfy()
        defer { ntfy.stop() }
        let (off, _) = notifier(ntfy) { $0.enabled = false }
        #expect(await off.post(PhoneNotifyMessages.test()).value == .off)
        let (noTimer, _) = notifier(ntfy) { $0.timer = false }
        #expect(await noTimer.post(PhoneNotifyMessages.timerFinished(label: "Tea")).value == .off)
        #expect(await noTimer.post(PhoneNotifyMessages.automationFailed(name: "x")).value == .sent)
        let (bad, _) = notifier(ntfy) { $0.server = "http://example.com" }
        #expect(await bad.post(PhoneNotifyMessages.test()).value == .notSetUp)

        let (n, _) = notifier(ntfy)
        n.limiter = PhoneNotifyRateLimiter(limit: 2, window: 60)
        #expect(await n.post(PhoneNotifyMessages.test()).value == .sent)
        #expect(await n.post(PhoneNotifyMessages.test()).value == .sent)
        #expect(await n.post(PhoneNotifyMessages.test()).value == .rateLimited)
        #expect(n.history.first?.outcome == .rateLimited)
        #expect(ntfy.posts.count == 3) // 1 automation + 2
    }

    @Test func tokenStorageAndTopicRegeneration() throws {
        let store = MemorySecretStore()
        var saved = PhoneNotifySettings()
        let n = PhoneNotifier(settings: { saved }, saveSettings: { saved = $0 }, tokens: store)
        #expect(!n.hasToken)
        try n.setToken("  tk_abc  ")
        let stored = try store.read()
        #expect(n.hasToken && stored == "tk_abc")
        #expect(throws: PhoneError.self) { try n.setToken("has space") }
        try n.setToken(nil)
        let cleared = try store.read()
        #expect(!n.hasToken && cleared == nil)
        let s1 = try n.update(["enabled": true])
        #expect(PhoneNotifyRules.isValidTopic(s1.topic))
        let s2 = n.regenerateTopic()
        #expect(s2.topic != s1.topic && saved.topic == s2.topic)
    }
}
