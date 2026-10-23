import Foundation
import GlideCore

/// Timers & stopwatches as plain data (port of src/main/features/timers/model.ts). Absolute unix-ms
/// timestamps, so they survive restarts. File: <userData>/features/timers/timers.json.
public struct CountdownTimer: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var durationMs: Double
    public var startedAt: Double
    /// Set while paused (encoded as null otherwise).
    public var pausedAt: Double?
    public var pausedMs: Double

    enum CodingKeys: String, CodingKey { case id, name, durationMs, startedAt, pausedAt, pausedMs }
    public init(id: String, name: String, durationMs: Double, startedAt: Double, pausedAt: Double?, pausedMs: Double) {
        self.id = id
        self.name = name
        self.durationMs = durationMs
        self.startedAt = startedAt
        self.pausedAt = pausedAt
        self.pausedMs = pausedMs
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(durationMs, forKey: .durationMs)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encode(pausedAt, forKey: .pausedAt)
        try c.encode(pausedMs, forKey: .pausedMs)
    }
}

public struct Stopwatch: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var startedAt: Double
    public var pausedAt: Double?
    public var pausedMs: Double
    /// Elapsed ms at each lap press.
    public var laps: [Double]

    enum CodingKeys: String, CodingKey { case id, name, startedAt, pausedAt, pausedMs, laps }
    public init(id: String, name: String, startedAt: Double, pausedAt: Double?, pausedMs: Double, laps: [Double]) {
        self.id = id
        self.name = name
        self.startedAt = startedAt
        self.pausedAt = pausedAt
        self.pausedMs = pausedMs
        self.laps = laps
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encode(pausedAt, forKey: .pausedAt)
        try c.encode(pausedMs, forKey: .pausedMs)
        try c.encode(laps, forKey: .laps)
    }
}

public struct TimerPreset: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var durationMs: Double
    public init(id: String, name: String, durationMs: Double) {
        self.id = id
        self.name = name
        self.durationMs = durationMs
    }
}

public struct TimersData: Hashable, Codable, Sendable {
    public var timers: [CountdownTimer] = []
    public var stopwatches: [Stopwatch] = []
    public var presets: [TimerPreset] = TimersModel.defaultPresets
    public init(timers: [CountdownTimer] = [], stopwatches: [Stopwatch] = [], presets: [TimerPreset] = TimersModel.defaultPresets) {
        self.timers = timers
        self.stopwatches = stopwatches
        self.presets = presets
    }
}

public enum TimersModel {
    static let minute = 60_000.0
    public static let maxDurationMs = 7 * 24 * 60 * minute
    public static let defaultPresets: [TimerPreset] = [
        .init(id: "pomodoro", name: "Pomodoro", durationMs: 25 * minute), .init(id: "short-break", name: "Short Break", durationMs: 5 * minute),
        .init(id: "long-break", name: "Long Break", durationMs: 15 * minute), .init(id: "tea", name: "Tea", durationMs: 3 * minute),
        .init(id: "coffee", name: "French Press", durationMs: 4 * minute), .init(id: "egg", name: "Soft-Boiled Egg", durationMs: 6 * minute),
        .init(id: "nap", name: "Power Nap", durationMs: 20 * minute), .init(id: "hour", name: "1 Hour", durationMs: 60 * minute),
    ]
    public static let sounds = ["Glass", "Ping", "Hero", "Submarine", "Funk", "Purr", "Sosumi", "Tink", "Blow", "Bottle", "Frog", "Morse", "Pop", "Basso"]

    nonisolated(unsafe) private static var seq = 0
    public static func newId(_ prefix: String, now: Double) -> String {
        defer { seq += 1 }
        return "\(prefix)-\(String(Int64(now), radix: 36))-\(String(seq, radix: 36))"
    }

    // MARK: timers

    public static func createTimer(now: Double, durationMs: Double, name: String) -> CountdownTimer {
        CountdownTimer(id: newId("t", now: now), name: name.trimmingCharacters(in: .whitespaces), durationMs: durationMs, startedAt: now, pausedAt: nil, pausedMs: 0)
    }
    public static func elapsed(_ t: CountdownTimer, now: Double) -> Double { max(0, (t.pausedAt ?? now) - t.startedAt - t.pausedMs) }
    public static func remaining(_ t: CountdownTimer, now: Double) -> Double { max(0, t.durationMs - elapsed(t, now: now)) }
    public static func isDone(_ t: CountdownTimer, now: Double) -> Bool { t.pausedAt == nil && remaining(t, now: now) <= 0 }
    /// When the timer ends; infinity while paused.
    public static func endsAt(_ t: CountdownTimer) -> Double { t.pausedAt == nil ? t.startedAt + t.pausedMs + t.durationMs : .infinity }
    public static func pause(_ t: CountdownTimer, now: Double) -> CountdownTimer {
        var t = t
        if t.pausedAt == nil { t.pausedAt = now }
        return t
    }
    public static func resume(_ t: CountdownTimer, now: Double) -> CountdownTimer {
        guard let p = t.pausedAt else { return t }
        var t = t
        t.pausedMs += now - p
        t.pausedAt = nil
        return t
    }
    public static func toggle(_ t: CountdownTimer, now: Double) -> CountdownTimer { t.pausedAt == nil ? pause(t, now: now) : resume(t, now: now) }
    public static func addTime(_ t: CountdownTimer, ms: Double) -> CountdownTimer {
        var t = t
        t.durationMs = min(maxDurationMs, max(1000, t.durationMs + ms))
        return t
    }
    public static func restart(_ t: CountdownTimer, now: Double) -> CountdownTimer {
        var t = t
        t.startedAt = now
        t.pausedAt = nil
        t.pausedMs = 0
        return t
    }

    // MARK: stopwatches

    public static func createStopwatch(now: Double, name: String) -> Stopwatch {
        Stopwatch(id: newId("s", now: now), name: name.trimmingCharacters(in: .whitespaces), startedAt: now, pausedAt: nil, pausedMs: 0, laps: [])
    }
    public static func elapsed(_ s: Stopwatch, now: Double) -> Double { max(0, (s.pausedAt ?? now) - s.startedAt - s.pausedMs) }
    public static func lap(_ s: Stopwatch, now: Double) -> Stopwatch {
        guard s.pausedAt == nil else { return s }
        var s = s
        s.laps.append(elapsed(s, now: now))
        return s
    }
    public static func toggle(_ s: Stopwatch, now: Double) -> Stopwatch {
        var s = s
        if let p = s.pausedAt {
            s.pausedMs += now - p
            s.pausedAt = nil
        } else {
            s.pausedAt = now
        }
        return s
    }
    public static func reset(_ s: Stopwatch, now: Double) -> Stopwatch {
        var s = s
        s.startedAt = now
        s.pausedAt = s.pausedAt == nil ? nil : now
        s.pausedMs = 0
        s.laps = []
        return s
    }
    /// [lap1, lap2 - lap1, …]
    public static func splits(_ s: Stopwatch) -> [Double] { s.laps.enumerated().map { i, t in t - (i > 0 ? s.laps[i - 1] : 0) } }

    // MARK: parsing

    static let unitMs: [String: Double] = [
        "h": 3_600_000, "hr": 3_600_000, "hrs": 3_600_000, "hour": 3_600_000, "hours": 3_600_000,
        "m": minute, "min": minute, "mins": minute, "minute": minute, "minutes": minute,
        "s": 1000, "sec": 1000, "secs": 1000, "second": 1000, "seconds": 1000,
    ]
    static let unit = "(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)"
    static let term = try! NSRegularExpression(pattern: #"(\d+(?:\.\d+)?)\s*"# + unit + #"(?![a-z])\s*(?:and\s+|,\s*)?"#, options: [.caseInsensitive, .anchorsMatchLines])
    static let clock = try! NSRegularExpression(pattern: #"^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?=\s|$)"#)
    static let bare = try! NSRegularExpression(pattern: #"^(\d+(?:\.\d+)?)(?=\s|$)"#)

    static func group(_ m: NSTextCheckingResult, _ i: Int, in s: String) -> String? {
        let r = m.range(at: i)
        guard r.location != NSNotFound, let rr = Range(r, in: s) else { return nil }
        return String(s[rr])
    }

    /// Duration at the start of `text` and the UTF-16 length consumed.
    static func leadingDuration(_ text: String) -> (ms: Double, length: Int)? {
        let ns = text as NSString
        if let m = clock.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) {
            let a = Double(group(m, 1, in: text) ?? "0") ?? 0, b = Double(group(m, 2, in: text) ?? "0") ?? 0
            let ms = group(m, 3, in: text).map { a * 3_600_000 + b * minute + (Double($0) ?? 0) * 1000 } ?? (a * minute + b * 1000)
            return (ms, m.range.length)
        }
        var ms = 0.0, pos = 0
        while pos < ns.length, let m = term.firstMatch(in: text, options: [.anchored], range: NSRange(location: pos, length: ns.length - pos)) {
            ms += (Double(group(m, 1, in: text) ?? "0") ?? 0) * (unitMs[(group(m, 2, in: text) ?? "").lowercased()] ?? 0)
            pos = m.range.location + m.range.length
        }
        if pos > 0 { return (ms.rounded(), pos) }
        if let m = bare.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) {
            return (((Double(group(m, 1, in: text) ?? "0") ?? 0) * minute).rounded(), m.range.length)
        }
        return nil
    }

    /// "25m", "1h30m", "1 h 30 min", "1.5h", "5:00", "1:30:00", "25" (minutes).
    public static func parseDuration(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard let d = leadingDuration(t), d.length >= (t as NSString).length, d.ms > 0, d.ms <= maxDurationMs else { return nil }
        return d.ms
    }

    /// "10 min tea" / "tea 10 min" / "for 25m" → duration + name.
    public static func parseDurationAndName(_ text: String) -> (ms: Double, name: String)? {
        let t = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^for\s+"#, with: "", options: [.regularExpression, .caseInsensitive])
        guard !t.isEmpty else { return nil }
        if let lead = leadingDuration(t), lead.ms > 0, lead.ms <= maxDurationMs {
            let rest = (t as NSString).substring(from: lead.length).trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: #"^(?:for|called|named|-|–|:)\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
            return (lead.ms, rest)
        }
        let re = try? NSRegularExpression(pattern: #"^(.+?)\s+((?:\d+(?:\.\d+)?\s*"# + unit + #"(?![a-z])\s*)+)$"#, options: .caseInsensitive)
        if let m = re?.firstMatch(in: t, range: NSRange(location: 0, length: (t as NSString).length)), let durText = group(m, 2, in: t), let ms = parseDuration(durText) {
            let name = (group(m, 1, in: t) ?? "").trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\s+for$"#, with: "", options: [.regularExpression, .caseInsensitive])
            return (ms, name)
        }
        return nil
    }

    /// Root-search phrases: "timer 25m", "start timer 10 min tea", "25m timer", "set a timer for 5 minutes".
    public static func parseTimerQuery(_ query: String) -> (ms: Double, name: String)? {
        let q = query.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        let ns = q as NSString
        let full = NSRange(location: 0, length: ns.length)
        if let re = try? NSRegularExpression(pattern: #"^(?:start |set |new )?(?:an? )?timer(?: for)? (.+)$"#, options: .caseInsensitive), let m = re.firstMatch(in: q, range: full) {
            return parseDurationAndName(group(m, 1, in: q) ?? "")
        }
        if let re = try? NSRegularExpression(pattern: #"^(.+?) timer(?: (.+))?$"#, options: .caseInsensitive), let m = re.firstMatch(in: q, range: full),
           let ms = parseDuration(group(m, 1, in: q) ?? "") {
            return (ms, (group(m, 2, in: q) ?? "").trimmingCharacters(in: .whitespaces))
        }
        return nil
    }

    // MARK: formatting

    static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// "4:32", "1:04:32" (rounded up so a fresh 25 min timer shows 25:00).
    public static func formatClock(_ ms: Double, roundUp: Bool = true) -> String {
        let total = Int(roundUp ? (ms / 1000).rounded(.up) : (ms / 1000).rounded(.down))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? "\(h):\(pad(m)):\(pad(s))" : "\(m):\(pad(s))"
    }

    /// "1:02.3"
    public static func formatStopwatch(_ ms: Double) -> String {
        "\(formatClock(ms, roundUp: false)).\(Int(ms.truncatingRemainder(dividingBy: 1000) / 100))"
    }

    /// "25 min", "1 h 30 min", "45 s", "1 min 30 s".
    public static func formatDuration(_ ms: Double) -> String {
        let total = Int((ms / 1000).rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        var parts: [String] = []
        if h > 0 { parts.append("\(h) h") }
        if m > 0 { parts.append("\(m) min") }
        if s > 0 || parts.isEmpty { parts.append("\(s) s") }
        return parts.joined(separator: " ")
    }

    public static func label(_ t: CountdownTimer) -> String { t.name.isEmpty ? "\(formatDuration(t.durationMs)) Timer" : t.name }

    /// Menu-bar title: the soonest running timer, plus a count of the others.
    public static func trayTitle(_ d: TimersData, now: Double) -> String {
        let running = d.timers.filter { $0.pausedAt == nil }.sorted { endsAt($0) < endsAt($1) }
        if let next = running.first ?? d.timers.first {
            let more = d.timers.count > 1 ? " +\(d.timers.count - 1)" : ""
            return "⏱ \(formatClock(remaining(next, now: now)))\(next.pausedAt != nil ? " ❚❚" : "")\(more)"
        }
        if let sw = d.stopwatches.first(where: { $0.pausedAt == nil }) { return "⏱ \(formatClock(elapsed(sw, now: now), roundUp: false))" }
        return ""
    }

    /// Tolerant load; timers that finished while Glide was closed are returned separately.
    public static func load(_ raw: JSONValue?, now: Double) -> (data: TimersData, finished: [CountdownTimer]) {
        guard let raw else { return (TimersData(), []) }
        func opt(_ v: JSONValue?) -> Double? { v?.number }
        let timers: [CountdownTimer] = (raw["timers"]?.arrayValue ?? []).compactMap { t in
            guard let id = t["id"]?.stringValue, let d = t["durationMs"]?.number, let s = t["startedAt"]?.number, let p = t["pausedMs"]?.number else { return nil }
            return CountdownTimer(id: id, name: t["name"]?.stringValue ?? "", durationMs: d, startedAt: s, pausedAt: opt(t["pausedAt"]), pausedMs: p)
        }
        let sws: [Stopwatch] = (raw["stopwatches"]?.arrayValue ?? []).compactMap { s in
            guard let id = s["id"]?.stringValue, let st = s["startedAt"]?.number, let laps = s["laps"]?.arrayValue else { return nil }
            return Stopwatch(id: id, name: s["name"]?.stringValue ?? "", startedAt: st, pausedAt: opt(s["pausedAt"]), pausedMs: s["pausedMs"]?.number ?? 0, laps: laps.compactMap(\.number))
        }
        let presets: [TimerPreset]
        if let arr = raw["presets"]?.arrayValue {
            presets = arr.compactMap { p in
                guard let id = p["id"]?.stringValue, let n = p["name"]?.stringValue, let d = p["durationMs"]?.number, d > 0 else { return nil }
                return TimerPreset(id: id, name: n, durationMs: d)
            }
        } else {
            presets = defaultPresets
        }
        let finished = timers.filter { isDone($0, now: now) }
        return (TimersData(timers: timers.filter { !isDone($0, now: now) }, stopwatches: sws, presets: presets), finished)
    }
}
