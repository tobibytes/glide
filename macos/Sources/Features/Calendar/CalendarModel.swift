import Foundation
import GlideCore

/// A calendar event (EventKitService JSON shape) plus its detected meeting link.
public struct CalendarEvent: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var start: String
    public var end: String
    public var allDay: Bool
    public var calendar: String
    public var color: String?
    public var location: String?
    public var url: String?
    public var notes: String?
    public var meeting: MeetingLink?

    public static func from(_ v: JSONValue) -> CalendarEvent? {
        guard let id = v["id"]?.stringValue, let s = v["start"]?.stringValue, let e = v["end"]?.stringValue else { return nil }
        var ev = CalendarEvent(id: id, title: v["title"]?.stringValue ?? "", start: s, end: e, allDay: v["allDay"]?.boolValue ?? false, calendar: v["calendar"]?.stringValue ?? "",
                               color: v["color"]?.stringValue, location: v["location"]?.stringValue, url: v["url"]?.stringValue, notes: v["notes"]?.stringValue)
        ev.meeting = CalendarLinks.meetingLink(url: ev.url, location: ev.location, notes: ev.notes)
        return ev
    }

    public var startDate: Date? { CalendarLinks.date(start) }
    public var endDate: Date? { CalendarLinks.date(end) }
}

public struct MeetingLink: Hashable, Codable, Sendable {
    public var url: String
    public var provider: String
}

/// Meeting-link detection and schedule helpers (port of src/main/features/calendar/links.ts).
public enum CalendarLinks {
    static let providers: [(String, String)] = [
        ("Zoom", #"\bhttps?://(?:[\w-]+\.)*zoom\.us/(?:j|my|w|s|wc/join)/[^\s<>"')\]]+"#),
        ("Zoom", #"\bzoommtg://[^\s<>"')\]]+"#),
        ("Google Meet", #"\bhttps?://meet\.google\.com/[a-z0-9-]+(?:\?[^\s<>"')\]]*)?"#),
        ("Microsoft Teams", #"\bhttps?://teams\.(?:microsoft|live)\.com/(?:l/meetup-join|meet)/[^\s<>"')\]]+"#),
        ("Webex", #"\bhttps?://(?:[\w-]+\.)*webex\.com/[^\s<>"')\]]+"#),
        ("Whereby", #"\bhttps?://(?:[\w-]+\.)?whereby\.com/[^\s<>"')\]]+"#),
        ("Around", #"\bhttps?://(?:[\w-]+\.)?around\.co/[^\s<>"')\]]+"#),
        ("FaceTime", #"\bhttps?://facetime\.apple\.com/join[^\s<>"')\]]*"#),
        ("Amazon Chime", #"\bhttps?://chime\.aws/\d+"#),
        ("GoTo Meeting", #"\bhttps?://(?:global\.)?gotomeeting\.com/join/\d+"#),
    ]

    public static func findMeetingLink(_ text: String?) -> MeetingLink? {
        guard let text, !text.isEmpty else { return nil }
        var best: (MeetingLink, Int)?
        let ns = text as NSString
        for (provider, pattern) in providers {
            guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive), let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { continue }
            if best == nil || m.range.location < best!.1 {
                let url = ns.substring(with: m.range).replacingOccurrences(of: "[.,;]+$", with: "", options: .regularExpression)
                best = (MeetingLink(url: url, provider: provider), m.range.location)
            }
        }
        return best?.0
    }

    /// URL field wins, then location, then notes.
    public static func meetingLink(url: String?, location: String?, notes: String?) -> MeetingLink? {
        findMeetingLink(url) ?? findMeetingLink(location) ?? findMeetingLink(notes)
    }

    public static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    /// Ongoing, or starting within `within` seconds. All-day events never count.
    public static func isJoinable(_ e: CalendarEvent, now: Date, within: TimeInterval = 600) -> Bool {
        guard !e.allDay, let s = e.startDate, let en = e.endDate else { return false }
        return now < en && s.timeIntervalSince(now) <= within
    }

    public static func startsInLabel(_ e: CalendarEvent, now: Date) -> String {
        guard let s = e.startDate, let en = e.endDate else { return "" }
        let diff = s.timeIntervalSince(now)
        if diff <= 0 { return "Now · \(max(0, Int((en.timeIntervalSince(now) / 60).rounded()))) min left" }
        return "Starts in \(max(1, Int((diff / 60).rounded()))) min"
    }

    /// Local midnights the event covers within [from, to); events ending exactly at midnight don't cover the next day.
    public static func dayKeys(_ e: CalendarEvent, from: Date, to: Date, calendar: Calendar = .current) -> [Date] {
        guard let s = e.startDate, let en = e.endDate else { return [] }
        let start = max(s, from)
        let end = min(en.addingTimeInterval(-0.001), to.addingTimeInterval(-0.001))
        var keys: [Date] = []
        var d = calendar.startOfDay(for: start)
        while d <= end {
            keys.append(d)
            d = calendar.date(byAdding: .day, value: 1, to: d) ?? end.addingTimeInterval(1)
        }
        return keys.isEmpty ? [calendar.startOfDay(for: start)] : keys
    }

    public static func matchesJoinQuery(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.count <= 1 { return true }
        return ["join", "meet", "meeting", "call"].contains { $0.hasPrefix(q) || q.hasPrefix($0) }
    }
}
