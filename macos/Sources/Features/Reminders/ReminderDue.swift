import Foundation

/// Natural-language due dates for "Create Reminder" (port of src/main/features/reminders/due.ts): pulls a
/// date/time phrase out of the text and leaves the rest as the title.
/// "Call mom tomorrow 9am" → title "Call mom", due tomorrow 09:00. A date without a time is all-day; a time
/// without a date is today (tomorrow once past).
public struct ParsedReminder: Equatable, Sendable {
    public var title: String
    public var due: Date?
    public var allDay: Bool
    /// The text read as the due date ("tomorrow 9am").
    public var phrase: String?
}

public enum ReminderDue {
    static let weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    static let weekdayRE = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?"
    static let months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    static let monthRE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?"
    static let numberWords: [String: Double] = ["a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
                                                 "ten": 10, "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30, "half": 0.5]
    static let periods: [String: Int] = ["morning": 9, "noon": 12, "afternoon": 15, "evening": 18, "tonight": 20, "night": 20, "midnight": 0]

    enum Unit { case minute, hour, day, week, month }
    static func unitOf(_ w: String) -> Unit? {
        switch w.lowercased() {
        case "m", "min", "mins", "minute", "minutes": return .minute
        case "h", "hr", "hrs", "hour", "hours": return .hour
        case "d", "day", "days": return .day
        case "w", "wk", "wks", "week", "weeks": return .week
        case "mo", "month", "months": return .month
        default: return nil
        }
    }

    static func weekdayIndex(_ w: String) -> Int { weekdays.firstIndex { $0.hasPrefix(String(w.lowercased().prefix(3))) } ?? -1 }

    static func monthIndex(_ word: String) -> Int {
        var w = word.lowercased()
        if w.hasSuffix(".") { w.removeLast() }
        guard let idx = months.firstIndex(where: { $0.hasPrefix(String(w.prefix(3))) }) else { return -1 }
        return months[idx].hasPrefix(w) || w == "sept" ? idx : -1
    }

    struct Match {
        var start: Int
        var end: Int
        var groups: [String?]
        func g(_ i: Int) -> String? { i < groups.count ? groups[i] : nil }
    }

    struct DatePart {
        var start: Int
        var end: Int
        var day: Date?
        var instant: Date?
        var defaultHour: Int?
    }

    struct TimePart {
        var start: Int
        var end: Int
        var hour: Int
        var minute: Int
    }

    static func find(_ text: String, _ pattern: String) -> Match? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) else { return nil }
        let ns = text as NSString
        let groups: [String?] = (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        return Match(start: m.range.location, end: m.range.location + m.range.length, groups: groups)
    }

    static func day(_ d: Date, _ cal: Calendar) -> Date { cal.startOfDay(for: d) }
    static func addDays(_ d: Date, _ n: Int, _ cal: Calendar) -> Date { cal.date(byAdding: .day, value: n, to: d) ?? d }
    static func make(_ y: Int, _ m: Int, _ d: Int, _ cal: Calendar, hour: Int = 0, minute: Int = 0) -> Date? {
        cal.date(from: DateComponents(year: y, month: m + 1, day: d, hour: hour, minute: minute))
    }
    /// A real calendar date (no Feb 30).
    static func valid(_ y: Int, _ m: Int, _ d: Int, _ cal: Calendar) -> Date? {
        guard m >= 0, m < 12, d >= 1, d <= 31, let date = make(y, m, d, cal) else { return nil }
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return c.year == y && c.month == m + 1 && c.day == d ? date : nil
    }

    static func findDate(_ t: String, now: Date, cal: Calendar) -> DatePart? {
        let today = day(now, cal)
        let c = cal.dateComponents([.year, .month, .day, .weekday], from: today)
        let year = c.year ?? 2000, month0 = (c.month ?? 1) - 1, dom = c.day ?? 1, dow = (c.weekday ?? 1) - 1

        if let s = find(t, #"\bin\s+(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|half an?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo)\b"#) {
            let raw = (s.g(1) ?? "").lowercased().replacingOccurrences(of: #"\s+an?$"#, with: "", options: .regularExpression)
            let n = Double(raw) ?? numberWords[raw] ?? 1
            switch unitOf(s.g(2) ?? "") ?? .day {
            case .minute: return DatePart(start: s.start, end: s.end, instant: now.addingTimeInterval(n * 60))
            case .hour: return DatePart(start: s.start, end: s.end, instant: now.addingTimeInterval(n * 3600))
            case .day: return DatePart(start: s.start, end: s.end, day: addDays(today, Int(n.rounded()), cal))
            case .week: return DatePart(start: s.start, end: s.end, day: addDays(today, Int((n * 7).rounded()), cal))
            case .month: return DatePart(start: s.start, end: s.end, day: make(year, month0 + Int(n.rounded()), dom, cal))
            }
        }
        if let s = find(t, #"\b(?:the\s+)?day\s+after\s+tomorrow\b"#) { return DatePart(start: s.start, end: s.end, day: addDays(today, 2, cal)) }
        if let s = find(t, #"\b(tomorrow|tmrw|tmr|tomorow)(\s+(morning|afternoon|evening|night))?\b"#) {
            return DatePart(start: s.start, end: s.end, day: addDays(today, 1, cal), defaultHour: s.g(3).flatMap { periods[$0.lowercased()] })
        }
        if let s = find(t, #"\btonight\b"#) { return DatePart(start: s.start, end: s.end, day: today, defaultHour: periods["tonight"]) }
        if let s = find(t, #"\b(?:this\s+)?(morning|afternoon|evening)\b"#), (s.g(0) ?? "").lowercased().hasPrefix("this") {
            return DatePart(start: s.start, end: s.end, day: today, defaultHour: periods[(s.g(1) ?? "").lowercased()])
        }
        if let s = find(t, #"\btoday\b"#) { return DatePart(start: s.start, end: s.end, day: today) }
        if let s = find(t, #"\b(next|this)\s+weekend\b"#) {
            let sat = addDays(today, (6 - dow + 7) % 7, cal)
            return DatePart(start: s.start, end: s.end, day: (s.g(1) ?? "").lowercased() == "next" ? addDays(sat, 7, cal) : sat)
        }
        if let s = find(t, #"\bnext\s+(week|month|year)\b"#) {
            switch (s.g(1) ?? "").lowercased() {
            case "week":
                let d = (1 - dow + 7) % 7
                return DatePart(start: s.start, end: s.end, day: addDays(today, d == 0 ? 7 : d, cal))
            case "month": return DatePart(start: s.start, end: s.end, day: make(year, month0 + 1, 1, cal))
            default: return DatePart(start: s.start, end: s.end, day: make(year + 1, 0, 1, cal))
            }
        }
        // Bare weekdays must be spelled out ("sat"/"sun" are ordinary words); abbreviations need next/this/on.
        if let s = find(t, "\\b(?:(next|this|on|coming)\\s+\(weekdayRE)|(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\\b") {
            let wd = weekdayIndex(s.g(2) ?? s.g(3) ?? "")
            var diff = (wd - dow + 7) % 7
            if diff == 0 && (s.g(1) ?? "").lowercased() != "this" { diff = 7 }
            return DatePart(start: s.start, end: s.end, day: addDays(today, diff, cal))
        }
        if let s = find(t, #"\b(\d{4})-(\d{1,2})-(\d{1,2})\b"#), let d = valid(Int(s.g(1) ?? "") ?? 0, (Int(s.g(2) ?? "") ?? 0) - 1, Int(s.g(3) ?? "") ?? 0, cal) {
            return DatePart(start: s.start, end: s.end, day: d)
        }
        func withYear(_ m: Int, _ d: Int, _ y: String?) -> Date? {
            if let y, let yi = Int(y) { return valid(y.count == 2 ? 2000 + yi : yi, m, d, cal) }
            guard let thisYear = valid(year, m, d, cal) else { return nil }
            return thisYear < today ? valid(year + 1, m, d, cal) : thisYear
        }
        if let s = find(t, "\\b(?:on\\s+)?\(monthRE)\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b") {
            let word = (s.g(0) ?? "").replacingOccurrences(of: #"^on\s+"#, with: "", options: [.regularExpression, .caseInsensitive]).split(separator: " ").first.map(String.init) ?? ""
            let m = monthIndex(word)
            if m >= 0, let d = withYear(m, Int(s.g(2) ?? "") ?? 0, s.g(3)) { return DatePart(start: s.start, end: s.end, day: d) }
        }
        if let s = find(t, "\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?\(monthRE)(?:,?\\s+(\\d{4}))?\\b") {
            let rest = (s.g(0) ?? "").replacingOccurrences(of: #"^(on\s+)?(the\s+)?\d{1,2}(st|nd|rd|th)?\s+(of\s+)?"#, with: "", options: [.regularExpression, .caseInsensitive])
            let word = rest.split(whereSeparator: { $0 == " " || $0 == "," }).first.map(String.init) ?? ""
            let m = monthIndex(word)
            if m >= 0, let d = withYear(m, Int(s.g(1) ?? "") ?? 0, s.g(3)) { return DatePart(start: s.start, end: s.end, day: d) }
        }
        // 11/3 only with a year, after on/by/due, or at the very end: "1/2 cup flour" is not January 2.
        if let s = find(t, #"\b(on\s+|by\s+|due\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b"#), s.g(1) != nil || s.g(4) != nil || s.end == (t as NSString).length,
           let d = withYear((Int(s.g(2) ?? "") ?? 0) - 1, Int(s.g(3) ?? "") ?? 0, s.g(4)) {
            return DatePart(start: s.start, end: s.end, day: d)
        }
        return nil
    }

    static func findTime(_ t: String) -> TimePart? {
        if let s = find(t, #"\b(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm|a\.m\.|p\.m\.)|(a|p))(?![a-z])"#) {
            var h = Int(s.g(1) ?? "") ?? 0
            let minute = Int(s.g(2) ?? "") ?? 0
            if h < 1 || h > 12 || minute > 59 { return nil }
            let pm = (s.g(3) ?? s.g(4) ?? "").lowercased().hasPrefix("p")
            if h == 12 { h = pm ? 12 : 0 } else if pm { h += 12 }
            return TimePart(start: s.start, end: s.end, hour: h, minute: minute)
        }
        if let s = find(t, #"\b(?:at\s+|@\s*)?([01]?\d|2[0-3]):([0-5]\d)\b"#) {
            return TimePart(start: s.start, end: s.end, hour: Int(s.g(1) ?? "") ?? 0, minute: Int(s.g(2) ?? "") ?? 0)
        }
        if let s = find(t, #"\b(?:at|@)\s*(\d{1,2})\b(?!\s*(?:\/|-|minutes?|mins?|hours?|days?|weeks?))"#) {
            let h = Int(s.g(1) ?? "") ?? 0
            if h > 23 { return nil }
            // "at 5" means 5 pm; mornings are written "at 9" too, so 7–11 stay am.
            return TimePart(start: s.start, end: s.end, hour: h >= 1 && h <= 6 ? h + 12 : h, minute: 0)
        }
        if let s = find(t, #"\b(?:at\s+)?(noon|midday|midnight)\b"#) {
            return TimePart(start: s.start, end: s.end, hour: (s.g(1) ?? "").lowercased() == "midnight" ? 0 : 12, minute: 0)
        }
        if let s = find(t, #"\b(?:in\s+the\s+)?(morning|afternoon|evening)\b"#) {
            return TimePart(start: s.start, end: s.end, hour: periods[(s.g(1) ?? "").lowercased()] ?? 9, minute: 0)
        }
        return nil
    }

    static func cut(_ text: String, _ spans: [(Int, Int)]) -> String {
        var out = text as NSString
        for sp in spans.sorted(by: { $0.0 > $1.0 }) {
            out = (out.substring(to: sp.0) + " " + out.substring(from: sp.1)) as NSString
        }
        var s = (out as String).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        s = s.replacingOccurrences(of: #"(?:\s+|^)(?:at|on|by|due|for)$"#, with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: #"^(?:remind\s+me\s+(?:to\s+)?|to\s+)"#, with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: #"[\s,;:–—-]+$"#, with: "", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespaces)
    }

    public static func parse(_ input: String, now: Date = Date(), calendar: Calendar = .current) -> ParsedReminder {
        let text = input.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        let ns = text as NSString
        let date = findDate(text, now: now, cal: calendar)
        // Look for a time outside the date phrase so "in 2 hours" never doubles as "at 2".
        var masked = text
        if let d = date { masked = ns.substring(to: d.start) + String(repeating: " ", count: d.end - d.start) + ns.substring(from: d.end) }
        let time = date?.instant != nil ? nil : findTime(masked)
        var spans: [(Int, Int)] = []
        if let d = date { spans.append((d.start, d.end)) }
        if let t = time { spans.append((t.start, t.end)) }
        if spans.isEmpty { return ParsedReminder(title: cut(text, []), due: nil, allDay: false, phrase: nil) }
        let phrase = spans.sorted { $0.0 < $1.0 }.map { ns.substring(with: NSRange(location: $0.0, length: $0.1 - $0.0)).trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
        let cutTitle = cut(text, spans)
        let title = cutTitle.isEmpty ? text : cutTitle
        if let inst = date?.instant { return ParsedReminder(title: title, due: inst, allDay: false, phrase: phrase) }
        var dayDate = date?.day
        guard let hour = time?.hour ?? date?.defaultHour else { return ParsedReminder(title: title, due: dayDate, allDay: true, phrase: phrase) }
        let minute = time?.minute ?? 0
        func at(_ d: Date) -> Date? { calendar.date(bySettingHour: hour, minute: minute, second: 0, of: d) }
        if dayDate == nil {
            let today = calendar.startOfDay(for: now)
            dayDate = (at(today).map { $0 <= now } ?? false) ? addDays(today, 1, calendar) : today
        }
        return ParsedReminder(title: title, due: dayDate.flatMap(at), allDay: false, phrase: phrase)
    }

    // MARK: labels (format.ts)

    public static func dayDiff(_ d: Date, _ now: Date, calendar: Calendar = .current) -> Int {
        calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: d)).day ?? 0
    }

    static func fmt(_ pattern: String, _ d: Date, _ cal: Calendar) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = cal.timeZone
        f.dateFormat = pattern
        return f.string(from: d)
    }

    /// "Today", "Tomorrow, 9:00 AM", "Yesterday", "Saturday", "Fri, Oct 24, 5:00 PM", "Tue, Jan 5, 2027".
    public static func describe(_ d: Date, allDay: Bool, now: Date = Date(), calendar: Calendar = .current) -> String {
        let diff = dayDiff(d, now, calendar: calendar)
        let dayLabel: String
        switch diff {
        case 0: dayLabel = "Today"
        case 1: dayLabel = "Tomorrow"
        case -1: dayLabel = "Yesterday"
        case 2..<7: dayLabel = fmt("EEEE", d, calendar)
        default:
            let sameYear = calendar.component(.year, from: d) == calendar.component(.year, from: now)
            dayLabel = fmt(sameYear ? "EEE, MMM d" : "EEE, MMM d, yyyy", d, calendar)
        }
        return allDay ? dayLabel : "\(dayLabel), \(fmt("h:mm a", d, calendar))"
    }

    public static func preview(_ p: ParsedReminder, now: Date = Date(), calendar: Calendar = .current) -> String {
        p.due.map { "Due \(describe($0, allDay: p.allDay, now: now, calendar: calendar))" } ?? "No due date"
    }
}
