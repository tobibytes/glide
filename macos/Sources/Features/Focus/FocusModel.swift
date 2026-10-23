import Foundation
import GlideCore

/// Focus sessions as a pure state machine plus stats and block-list matching (port of
/// src/main/features/focus/machine.ts). File: <userData>/features/focus/focus.json {session, history}.
public struct BlockedApp: Hashable, Codable, Sendable {
    public var name: String
    public var bundleId: String?
    public var path: String?
    public init(name: String, bundleId: String? = nil, path: String? = nil) {
        self.name = name
        self.bundleId = bundleId
        self.path = path
    }
}

public struct FocusSession: Hashable, Codable, Sendable {
    public var id: String
    public var goal: String
    public var durationMs: Double
    public var startedAt: Double
    /// "running" | "paused"
    public var status: String
    public var accumulatedMs: Double
    public var segmentStartedAt: Double?
    public var blockedApps: [BlockedApp]
    public var blockedSites: [String]

    enum CodingKeys: String, CodingKey { case id, goal, durationMs, startedAt, status, accumulatedMs, segmentStartedAt, blockedApps, blockedSites }
    public init(id: String, goal: String, durationMs: Double, startedAt: Double, status: String, accumulatedMs: Double, segmentStartedAt: Double?, blockedApps: [BlockedApp], blockedSites: [String]) {
        self.id = id
        self.goal = goal
        self.durationMs = durationMs
        self.startedAt = startedAt
        self.status = status
        self.accumulatedMs = accumulatedMs
        self.segmentStartedAt = segmentStartedAt
        self.blockedApps = blockedApps
        self.blockedSites = blockedSites
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        goal = (try? c.decode(String.self, forKey: .goal)) ?? ""
        durationMs = try c.decode(Double.self, forKey: .durationMs)
        startedAt = (try? c.decode(Double.self, forKey: .startedAt)) ?? 0
        status = (try? c.decode(String.self, forKey: .status)) ?? "running"
        accumulatedMs = (try? c.decode(Double.self, forKey: .accumulatedMs)) ?? 0
        segmentStartedAt = try? c.decode(Double.self, forKey: .segmentStartedAt)
        blockedApps = (try? c.decode([BlockedApp].self, forKey: .blockedApps)) ?? []
        blockedSites = (try? c.decode([String].self, forKey: .blockedSites)) ?? []
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(goal, forKey: .goal)
        try c.encode(durationMs, forKey: .durationMs)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encode(status, forKey: .status)
        try c.encode(accumulatedMs, forKey: .accumulatedMs)
        try c.encode(segmentStartedAt, forKey: .segmentStartedAt)
        try c.encode(blockedApps, forKey: .blockedApps)
        try c.encode(blockedSites, forKey: .blockedSites)
    }
}

public struct FocusRecord: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var goal: String
    public var startedAt: Double
    public var endedAt: Double
    public var focusedMs: Double
    public var plannedMs: Double
    public var completed: Bool
}

public struct FocusFile: Codable, Sendable {
    public var session: FocusSession?
    public var history: [FocusRecord]
    enum CodingKeys: String, CodingKey { case session, history }
    public init(session: FocusSession?, history: [FocusRecord]) {
        self.session = session
        self.history = history
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try? c.decode(FocusSession.self, forKey: .session)
        history = ((try? c.decode([FocusRecordLossy].self, forKey: .history)) ?? []).compactMap(\.value)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(session, forKey: .session)
        try c.encode(history, forKey: .history)
    }
}

/// Drops malformed history entries instead of failing the whole file.
struct FocusRecordLossy: Decodable {
    let value: FocusRecord?
    init(from decoder: Decoder) throws { value = try? FocusRecord(from: decoder) }
}

public struct FocusStats: Hashable, Codable, Sendable {
    public struct Day: Hashable, Codable, Sendable {
        public var day: Double
        public var ms: Double
    }
    public var todayMs: Double = 0
    public var weekMs: Double = 0
    public var sessionsToday = 0
    public var sessionsWeek = 0
    public var completedWeek = 0
    public var last7: [Day] = []
}

public enum FocusMachine {
    public static func start(now: Double, goal: String, minutes: Double, blockedApps: [BlockedApp] = [], blockedSites: [String] = []) -> FocusSession {
        let m = min(24 * 60, max(1, minutes.rounded()))
        return FocusSession(id: "focus-\(String(Int64(now), radix: 36))", goal: goal.trimmingCharacters(in: .whitespaces), durationMs: m * 60_000, startedAt: now,
                            status: "running", accumulatedMs: 0, segmentStartedAt: now, blockedApps: blockedApps, blockedSites: blockedSites.map(normalizeSite).filter { !$0.isEmpty })
    }

    public static func elapsed(_ s: FocusSession, now: Double) -> Double {
        s.accumulatedMs + (s.status == "running" && s.segmentStartedAt != nil ? max(0, now - (s.segmentStartedAt ?? now)) : 0)
    }
    public static func remaining(_ s: FocusSession, now: Double) -> Double { max(0, s.durationMs - elapsed(s, now: now)) }
    public static func isComplete(_ s: FocusSession, now: Double) -> Bool { remaining(s, now: now) == 0 }

    public static func pause(_ s: FocusSession, now: Double) -> FocusSession {
        guard s.status == "running" else { return s }
        var s2 = s
        s2.accumulatedMs = min(s.durationMs, elapsed(s, now: now))
        s2.status = "paused"
        s2.segmentStartedAt = nil
        return s2
    }
    public static func resume(_ s: FocusSession, now: Double) -> FocusSession {
        guard s.status == "paused" else { return s }
        var s2 = s
        s2.status = "running"
        s2.segmentStartedAt = now
        return s2
    }
    public static func togglePause(_ s: FocusSession, now: Double) -> FocusSession { s.status == "running" ? pause(s, now: now) : resume(s, now: now) }

    /// Never below elapsed + 1 min.
    public static func extend(_ s: FocusSession, now: Double, minutes: Double) -> FocusSession {
        var s2 = s
        s2.durationMs = max(elapsed(s, now: now) + 60_000, s.durationMs + minutes * 60_000)
        return s2
    }

    public static func finish(_ s: FocusSession, now: Double) -> FocusRecord {
        let focused = min(s.durationMs, elapsed(s, now: now))
        return FocusRecord(id: s.id, goal: s.goal, startedAt: s.startedAt, endedAt: now, focusedMs: focused, plannedMs: s.durationMs, completed: focused >= s.durationMs)
    }

    static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
    /// "05:00", "1:05:00"
    public static func formatClock(_ ms: Double) -> String {
        let total = Int((ms / 1000).rounded(.up))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? "\(h):\(pad(m)):\(pad(s))" : "\(pad(m)):\(pad(s))"
    }
    public static func formatDuration(_ ms: Double) -> String {
        let minTotal = Int((ms / 60_000).rounded())
        if minTotal < 60 { return "\(minTotal) min" }
        let h = minTotal / 60, m = minTotal % 60
        return m > 0 ? "\(h) h \(m) min" : "\(h) h"
    }

    static func startOfDay(_ t: Double, _ cal: Calendar) -> Double { cal.startOfDay(for: Date(timeIntervalSince1970: t / 1000)).timeIntervalSince1970 * 1000 }

    /// Week starts on Monday.
    public static func stats(_ records: [FocusRecord], now: Double, current: FocusSession? = nil, calendar: Calendar = .current) -> FocusStats {
        let all = current.map { records + [finish($0, now: now)] } ?? records
        let today = startOfDay(now, calendar)
        let todayDate = Date(timeIntervalSince1970: today / 1000)
        let dow = (calendar.component(.weekday, from: todayDate) + 5) % 7
        let week = (calendar.date(byAdding: .day, value: -dow, to: todayDate) ?? todayDate).timeIntervalSince1970 * 1000
        var st = FocusStats()
        st.last7 = (0..<7).map { i in FocusStats.Day(day: (calendar.date(byAdding: .day, value: -(6 - i), to: todayDate) ?? todayDate).timeIntervalSince1970 * 1000, ms: 0) }
        for r in all {
            let day = startOfDay(r.startedAt, calendar)
            if day == today {
                st.todayMs += r.focusedMs
                st.sessionsToday += 1
            }
            if r.startedAt >= week {
                st.weekMs += r.focusedMs
                st.sessionsWeek += 1
                if r.completed { st.completedWeek += 1 }
            }
            if let i = st.last7.firstIndex(where: { $0.day == day }) { st.last7[i].ms += r.focusedMs }
        }
        return st
    }

    /// "https://www.YouTube.com/watch" → "youtube.com"
    public static func normalizeSite(_ input: String) -> String {
        var s = input.trimmingCharacters(in: .whitespaces).lowercased()
        guard !s.isEmpty else { return "" }
        s = s.replacingOccurrences(of: "^[a-z]+://", with: "", options: .regularExpression).replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
        s = String(s.split(whereSeparator: { "/?#".contains($0) }).first ?? "").replacingOccurrences(of: ":\\d+$", with: "", options: .regularExpression)
        return s.range(of: "^[a-z0-9.-]+\\.[a-z]{2,}$", options: .regularExpression) != nil ? s : ""
    }

    public static func siteMatches(_ url: String, _ sites: [String]) -> String? {
        guard let host = URL(string: url)?.host?.lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression) else { return nil }
        return sites.first { host == $0 || host.hasSuffix(".\($0)") }
    }

    public static func appMatches(name: String, bundleId: String?, _ blocked: [BlockedApp]) -> BlockedApp? {
        blocked.first { b in
            if let bb = b.bundleId, let bid = bundleId { return bb == bid }
            return b.name.lowercased() == name.lowercased()
        }
    }

    /// "45m write report" / "1h deep work" / "30" → minutes + goal ("3 little pigs" is a goal).
    public static func parseDurationPrefix(_ text: String) -> (minutes: Int, goal: String)? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard let re = try? NSRegularExpression(pattern: #"^(\d{1,3}(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?)?(?:\s+(.*))?$"#, options: .caseInsensitive),
              let m = re.firstMatch(in: t, range: NSRange(location: 0, length: (t as NSString).length)) else { return nil }
        func g(_ i: Int) -> String? {
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : (t as NSString).substring(with: r)
        }
        let unit = g(2), rest = g(3)
        if unit == nil, rest != nil { return nil }
        let n = Double(g(1) ?? "") ?? 0
        let minutes = (unit?.lowercased().hasPrefix("h") ?? false) ? n * 60 : n
        guard minutes > 0, minutes <= 24 * 60 else { return nil }
        return (Int(minutes.rounded()), (rest ?? "").trimmingCharacters(in: .whitespaces))
    }
}
