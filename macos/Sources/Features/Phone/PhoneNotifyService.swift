import Foundation
import GlideCore
import Observation

/// Sends notifications to the phone through ntfy: checks the switches, rate-limits, publishes off the main thread
/// with retries, and keeps a short history for Settings. Never blocks the app; failures are logged (never the
/// topic, token or message text) and shown in Settings.
@MainActor @Observable final class PhoneNotifier {
    enum Outcome: Equatable, Sendable {
        case sent
        /// Notifications are off, or this kind is switched off.
        case off
        case rateLimited
        case busy
        /// Topic or server missing / invalid.
        case notSetUp
        case failed(status: Int?)
    }

    struct Record: Equatable, Identifiable, Sendable {
        var id: Int
        var at: Date
        var kind: PhoneNotifyKind
        var outcome: Outcome
        var attempts: Int
    }

    @ObservationIgnored var settings: @MainActor () -> PhoneNotifySettings
    @ObservationIgnored var saveSettings: @MainActor (PhoneNotifySettings) -> Void
    @ObservationIgnored let tokens: any AISecretStore
    @ObservationIgnored let sender: PhoneNtfySender
    @ObservationIgnored var log: @MainActor (String) -> Void = { _ in }
    /// Seconds; tests shrink it.
    @ObservationIgnored var backoffBase: TimeInterval = 1
    @ObservationIgnored var limiter = PhoneNotifyRateLimiter()
    @ObservationIgnored var maxInFlight = 4
    private(set) var history: [Record] = []
    private(set) var inFlight = 0
    /// Bumped on every settings / token change (Settings re-reads).
    private(set) var revision = 0
    @ObservationIgnored private var seq = 0
    @ObservationIgnored private var cachedToken: String??

    init(settings: @escaping @MainActor () -> PhoneNotifySettings, saveSettings: @escaping @MainActor (PhoneNotifySettings) -> Void,
         tokens: any AISecretStore, sender: PhoneNtfySender = PhoneNtfySender()) {
        self.settings = settings
        self.saveSettings = saveSettings
        self.tokens = tokens
        self.sender = sender
    }

    // MARK: settings

    func update(_ patch: JSONValue) throws -> PhoneNotifySettings {
        var s = settings()
        try s.apply(patch)
        saveSettings(s)
        revision += 1
        return s
    }

    func regenerateTopic() -> PhoneNotifySettings {
        var s = settings()
        s.topic = PhoneNotifyRules.newTopic()
        saveSettings(s)
        revision += 1
        return s
    }

    var hasToken: Bool {
        if let c = cachedToken { return c != nil }
        return tokens.exists()
    }

    func setToken(_ raw: String?) throws {
        let t = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if t.isEmpty {
            try tokens.delete()
            cachedToken = .some(nil)
        } else {
            guard t.count <= 256, t.unicodeScalars.allSatisfy({ $0.isASCII && $0.value > 0x20 && $0.value < 0x7f }) else {
                throw PhoneError.badArgs("That token has spaces or unusual characters. Copy it again from your ntfy account.")
            }
            try tokens.write(t)
            cachedToken = .some(t)
        }
        revision += 1
    }

    private func token() -> String? {
        if let c = cachedToken { return c }
        let t = (try? tokens.read()) ?? nil
        cachedToken = .some(t)
        return t
    }

    // MARK: sending

    /// Queue a message (returns at once). The task's value is the outcome, for tests and the test button.
    @discardableResult func post(_ m: PhoneNotifyMessage) -> Task<Outcome, Never> {
        let s = settings()
        let ready: Outcome? = {
            guard s.enabled, s.wants(m.kind) else { return .off }
            guard PhoneNotifyRules.isValidTopic(s.topic), (try? PhoneNotifyRules.validateServer(s.server)) != nil else { return .notSetUp }
            guard inFlight < maxInFlight else { return .busy }
            guard limiter.take() else { return .rateLimited }
            return nil
        }()
        if let ready {
            if ready != .off { record(m.kind, ready, attempts: 0) }
            if ready == .rateLimited || ready == .busy { log("ntfy: dropped a \(m.kind.rawValue) notification (\(ready == .busy ? "too many in flight" : "rate limit"))") }
            return Task { ready }
        }
        guard let server = try? PhoneNotifyRules.validateServer(s.server) else { return Task { .notSetUp } }
        let request = PhoneNtfySender.request(m, server: server, topic: s.topic, token: token())
        inFlight += 1
        let sender = self.sender
        let base = backoffBase
        return Task { @MainActor [weak self] in
            var attempt = 0
            var last = PhoneNtfySender.Attempt(status: nil)
            while attempt < PhoneNotifyBackoff.maxAttempts {
                attempt += 1
                last = await sender.attempt(request)
                if let st = last.status, (200...299).contains(st) { break }
                guard PhoneNotifyBackoff.shouldRetry(status: last.status), attempt < PhoneNotifyBackoff.maxAttempts else { break }
                let wait = PhoneNotifyBackoff.delay(afterAttempt: attempt, retryAfter: last.retryAfter, base: base)
                try? await Task.sleep(for: .milliseconds(Int(wait * 1000)))
                if Task.isCancelled { break }
            }
            let ok = last.status.map { (200...299).contains($0) } ?? false
            let outcome: Outcome = ok ? .sent : .failed(status: last.status)
            guard let self else { return outcome }
            self.inFlight -= 1
            self.record(m.kind, outcome, attempts: attempt)
            if !ok {
                let why = last.status.map { "HTTP \($0)" } ?? "server not reachable"
                self.log("ntfy: couldn't send a \(m.kind.rawValue) notification (\(why), \(attempt) \(attempt == 1 ? "try" : "tries"))")
            }
            return outcome
        }
    }

    private func record(_ kind: PhoneNotifyKind, _ outcome: Outcome, attempts: Int) {
        seq += 1
        history.insert(Record(id: seq, at: Date(), kind: kind, outcome: outcome, attempts: attempts), at: 0)
        if history.count > 20 { history.removeLast(history.count - 20) }
    }

    var historyJSON: JSONValue {
        .array(history.map { r in
            var o: [String: JSONValue] = ["kind": .string(r.kind.rawValue), "at": .int(Int64(r.at.timeIntervalSince1970 * 1000)), "attempts": .int(Int64(r.attempts))]
            switch r.outcome {
            case .sent: o["outcome"] = "sent"
            case .off: o["outcome"] = "off"
            case .rateLimited: o["outcome"] = "rate-limited"
            case .busy: o["outcome"] = "busy"
            case .notSetUp: o["outcome"] = "not-set-up"
            case let .failed(st):
                o["outcome"] = "failed"
                o["status"] = st.map { .int(Int64($0)) } ?? .null
            }
            return .object(o)
        })
    }

    /// Plain words for Settings and the `notify.test` result.
    static func describe(_ o: Outcome) -> String {
        switch o {
        case .sent: return "Sent. Check your iPhone."
        case .off: return "Notifications are off. Turn them on first."
        case .rateLimited: return "Glide sent a lot of notifications in the last minute, so it skipped this one. Try again in a minute."
        case .busy: return "Glide is still sending earlier notifications. Try again in a moment."
        case .notSetUp: return "Set a server and topic first."
        case let .failed(st?) where st == 401 || st == 403: return "The ntfy server refused the notification (HTTP \(st)). Check the access token."
        case let .failed(st?): return "The ntfy server answered HTTP \(st). Check the server address and try again."
        case .failed(nil): return "Couldn't reach the ntfy server. Check the address and your internet connection."
        }
    }
}
