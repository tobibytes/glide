import Foundation

/// Date maths (port of convert/dates.ts): "days until dec 25", "weeks since jan 1", "days between mar 1 and jun 30",
/// "today + 3 weeks", "christmas - 10 days", "90 days from now", "2 weeks ago", "in 45 minutes".
/// Calendar units move the local calendar date; hours/minutes move the instant. `cal` carries the local zone.
public enum ConvertDates {
    enum CalUnit: String { case minute, hour, day, week, month, year }

    static let unitAliases: [String: CalUnit] = [
        "m": .minute, "min": .minute, "mins": .minute, "minute": .minute, "minutes": .minute,
        "h": .hour, "hr": .hour, "hrs": .hour, "hour": .hour, "hours": .hour,
        "d": .day, "day": .day, "days": .day,
        "w": .week, "wk": .week, "wks": .week, "week": .week, "weeks": .week,
        "mo": .month, "mos": .month, "month": .month, "months": .month,
        "y": .year, "yr": .year, "yrs": .year, "year": .year, "years": .year,
    ]
    static let months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    static let weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

    struct Parsed {
        var date: Date
        var hasYear: Bool
        var hasTime: Bool
        var label: String
    }

    static func ymd(_ cal: Calendar, _ y: Int, _ m0: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0, _ s: Int = 0) -> Date {
        // JS `new Date(y, m, d)` normalises overflow (month 12 → next January, day 0 → last day of previous month).
        var c = DateComponents()
        c.year = y; c.month = 1; c.day = 1; c.hour = h; c.minute = mi; c.second = s
        let base = cal.date(from: c) ?? Date(timeIntervalSince1970: 0)
        let withMonths = cal.date(byAdding: .month, value: m0, to: base) ?? base
        return cal.date(byAdding: .day, value: d - 1, to: withMonths) ?? withMonths
    }

    static func parts(_ cal: Calendar, _ d: Date) -> (y: Int, m0: Int, d: Int, h: Int, mi: Int, s: Int, wd: Int) {
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute, .second, .weekday], from: d)
        return (c.year ?? 1970, (c.month ?? 1) - 1, c.day ?? 1, c.hour ?? 0, c.minute ?? 0, c.second ?? 0, (c.weekday ?? 1) - 1)
    }

    static func startOfDay(_ cal: Calendar, _ d: Date) -> Date { cal.startOfDay(for: d) }

    static func monthIndex(_ word: String) -> Int {
        var w = word.lowercased()
        if w.hasSuffix(".") { w.removeLast() }
        guard w.count >= 3 else { return -1 }
        guard let idx = months.firstIndex(where: { w.hasPrefix(String($0.prefix(3))) }) else { return -1 }
        return months[idx].hasPrefix(w) || w == "sept" ? idx : -1
    }

    static func validYmd(_ cal: Calendar, _ y: Int, _ m0: Int, _ d: Int) -> Date? {
        guard (0...11).contains(m0), d >= 1 else { return nil }
        let date = ymd(cal, y, m0, d)
        let p = parts(cal, date)
        return p.y == y && p.m0 == m0 && p.d == d ? date : nil
    }

    static func parseDate(_ raw: String, now: Date, cal: Calendar) -> Parsed? {
        let t = ConvertRegex.replace("\\s+", in: raw.trimmingCharacters(in: .whitespaces).lowercased(), with: " ").replacingOccurrences(of: ",", with: "")
        let today = startOfDay(cal, now)
        let tp = parts(cal, today)
        let y = tp.y
        func rel(_ days: Int, _ label: String) -> Parsed { Parsed(date: ymd(cal, tp.y, tp.m0, tp.d + days), hasYear: true, hasTime: false, label: label) }
        switch t {
        case "now": return Parsed(date: now, hasYear: true, hasTime: true, label: "now")
        case "today": return rel(0, "today")
        case "tomorrow": return rel(1, "tomorrow")
        case "yesterday": return rel(-1, "yesterday")
        default: break
        }
        let holidays: [String: (Int, Int)] = [
            "christmas": (11, 25), "christmas day": (11, 25), "xmas": (11, 25), "christmas eve": (11, 24),
            "new year": (0, 1), "new years": (0, 1), "new year's": (0, 1), "new years day": (0, 1), "new year's day": (0, 1),
            "new years eve": (11, 31), "new year's eve": (11, 31), "halloween": (9, 31), "valentines": (1, 14), "valentines day": (1, 14), "valentine's day": (1, 14),
        ]
        if let h = holidays[t] {
            var date = ymd(cal, y, h.0, h.1)
            if date < today { date = ymd(cal, y + 1, h.0, h.1) }
            return Parsed(date: date, hasYear: true, hasTime: false, label: t)
        }
        if let wd = ConvertRegex.match("^(?:(next|this|last) )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*$", t), let stem = wd[2] {
            let bare = ConvertRegex.replace("^(next|this|last) ", in: t, with: "")
            if weekdays.contains(where: { $0.hasPrefix(bare) }), let target = weekdays.firstIndex(where: { $0.hasPrefix(stem) }) {
                var diff = (target - tp.wd + 7) % 7
                if wd[1] == "last" { diff = diff == 0 ? -7 : diff - 7 } else if diff == 0 || wd[1] == "next" { diff = diff == 0 ? 7 : diff }
                return rel(diff, t)
            }
        }
        if let m = ConvertRegex.match("^(\\d{4})-(\\d{1,2})-(\\d{1,2})$", t), let a = Int(m[1] ?? ""), let b = Int(m[2] ?? ""), let c = Int(m[3] ?? "") {
            return validYmd(cal, a, b - 1, c).map { Parsed(date: $0, hasYear: true, hasTime: false, label: raw.trimmingCharacters(in: .whitespaces)) }
        }
        if let m = ConvertRegex.match("^(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?$", t), var a = Int(m[1] ?? ""), var b = Int(m[2] ?? "") {
            if a > 12 && b <= 12 { swap(&a, &b) }
            let yr = m[3].map { $0.count == 2 ? 2000 + (Int($0) ?? 0) : (Int($0) ?? y) } ?? y
            return validYmd(cal, yr, a - 1, b).map { Parsed(date: $0, hasYear: m[3] != nil, hasTime: false, label: raw.trimmingCharacters(in: .whitespaces)) }
        }
        var month = -1, day = 0
        var year: Int?
        if let m = ConvertRegex.match("^([a-z.]+) (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?$", t) {
            month = monthIndex(m[1] ?? ""); day = Int(m[2] ?? "") ?? 0; year = m[3].flatMap { Int($0) }
        } else if let m = ConvertRegex.match("^(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z.]+)(?: (\\d{4}))?$", t) {
            month = monthIndex(m[2] ?? ""); day = Int(m[1] ?? "") ?? 0; year = m[3].flatMap { Int($0) }
        }
        if month >= 0 {
            return validYmd(cal, year ?? y, month, day).map { Parsed(date: $0, hasYear: year != nil, hasTime: false, label: raw.trimmingCharacters(in: .whitespaces)) }
        }
        return nil
    }

    struct Offset { var n: Double; var unit: CalUnit }

    static func parseOffsets(_ raw: String) -> [Offset]? {
        let t = raw.trimmingCharacters(in: .whitespaces).lowercased() as NSString
        guard let re = ConvertRegex.regex("(\\d+(?:\\.\\d+)?)\\s*([a-z]+)\\s*(?:and\\s*|,\\s*)?") else { return nil }
        var out: [Offset] = []
        var pos = 0
        while pos < t.length {
            guard let m = re.firstMatch(in: t as String, options: [.anchored], range: NSRange(location: pos, length: t.length - pos)), m.range.length > 0,
                  let unit = unitAliases[t.substring(with: m.range(at: 2))], let n = Double(t.substring(with: m.range(at: 1))) else { return nil }
            if n != n.rounded() && ![.hour, .minute, .day, .week].contains(unit) { return nil }
            out.append(Offset(n: n, unit: unit))
            pos = m.range.location + m.range.length
        }
        return out.isEmpty ? nil : out
    }

    static func applyOffsets(_ base: Date, _ offsets: [Offset], _ sign: Double, cal: Calendar) -> Date {
        var d = base
        for o in offsets {
            let k = o.n * sign
            switch o.unit {
            case .minute: d = d.addingTimeInterval(k * 60)
            case .hour: d = d.addingTimeInterval(k * 3600)
            case .day, .week:
                let days = o.unit == .week ? k * 7 : k
                let whole = days.rounded(.towardZero)
                let p = parts(cal, d)
                d = ymd(cal, p.y, p.m0, p.d + Int(whole), p.h, p.mi, p.s)
                if days != whole { d = d.addingTimeInterval((days - whole) * 86_400) }
            case .month, .year:
                let monthsN = Int(o.unit == .year ? k * 12 : k)
                let p = parts(cal, d)
                let first = ymd(cal, p.y, p.m0 + monthsN, 1, p.h, p.mi, p.s)
                let tp = parts(cal, first)
                let lastDay = parts(cal, ymd(cal, tp.y, tp.m0 + 1, 0)).d
                d = ymd(cal, tp.y, tp.m0, min(p.d, lastDay), p.h, p.mi, p.s)
            }
        }
        return d
    }

    public enum Result {
        case date(Date, hasTime: Bool, expression: String)
        case count(days: Int, unit: String, from: Date, to: Date, direction: String, target: String)
    }

    /// Whole calendar days from a to b (DST-safe).
    static func daysBetween(_ a: Date, _ b: Date, cal: Calendar) -> Int {
        cal.dateComponents([.day], from: cal.startOfDay(for: a), to: cal.startOfDay(for: b)).day ?? 0
    }

    public static func parse(_ query: String, now: Date, cal: Calendar) -> Result? {
        var q = ConvertRegex.replace("\\s+", in: query.trimmingCharacters(in: .whitespaces).lowercased(), with: " ")
        if q.hasSuffix("?") { q.removeLast() }
        guard q.count >= 3, q.count <= 80 else { return nil }
        if let m = ConvertRegex.match("^(?:how many )?(days|weeks|months|years|hours|minutes) (until|till|til|to|since|from) (.+)$", q), let u = m[1], let dir = m[2], let tgt = m[3] {
            guard let target = parseDate(tgt, now: now, cal: cal) else { return nil }
            let since = dir == "since" || dir == "from"
            var to = target.date
            if !since && !target.hasYear && startOfDay(cal, to) < startOfDay(cal, now) {
                let p = parts(cal, to)
                to = ymd(cal, p.y + 1, p.m0, p.d)
            }
            let unit = String(u.dropLast())
            return .count(days: since ? daysBetween(to, now, cal: cal) : daysBetween(now, to, cal: cal), unit: unit, from: since ? to : now, to: since ? now : to,
                          direction: since ? "since" : "until", target: tgt)
        }
        if let m = ConvertRegex.match("^(?:how many )?(days|weeks|months|years) between (.+?) and (.+)$", q), let u = m[1], let x = m[2], let y = m[3] {
            guard let a = parseDate(x, now: now, cal: cal), let b = parseDate(y, now: now, cal: cal) else { return nil }
            return .count(days: abs(daysBetween(a.date, b.date, cal: cal)), unit: String(u.dropLast()), from: a.date, to: b.date, direction: "between", target: "\(x) and \(y)")
        }
        if let m = ConvertRegex.match("^(.+) ?([+-]) ?(\\d[^+-]*)$", q), let l = m[1], let sign = m[2], let r = m[3],
           let base = parseDate(l, now: now, cal: cal), let offsets = parseOffsets(r) {
            let timed = base.hasTime || offsets.contains { $0.unit == .hour || $0.unit == .minute }
            let start = timed && !base.hasTime && base.label == "today" ? now : base.date
            return .date(applyOffsets(start, offsets, sign == "-" ? -1 : 1, cal: cal), hasTime: timed, expression: q)
        }
        if let m = ConvertRegex.match("^(.+?) (from|after|before) (.+)$", q), let l = m[1], let w = m[2], let r = m[3],
           let offsets = parseOffsets(l), let base = parseDate(r, now: now, cal: cal) {
            let timed = base.hasTime || offsets.contains { $0.unit == .hour || $0.unit == .minute }
            let start = timed && !base.hasTime ? now : base.date
            return .date(applyOffsets(start, offsets, w == "before" ? -1 : 1, cal: cal), hasTime: timed, expression: q)
        }
        if let m = ConvertRegex.match("^(.+) ago$", q), let l = m[1], let offsets = parseOffsets(l) {
            let timed = offsets.contains { $0.unit == .hour || $0.unit == .minute }
            return .date(applyOffsets(timed ? now : startOfDay(cal, now), offsets, -1, cal: cal), hasTime: timed, expression: q)
        }
        if let m = ConvertRegex.match("^in (\\d.+)$", q), let l = m[1], let offsets = parseOffsets(l) {
            let timed = offsets.contains { $0.unit == .hour || $0.unit == .minute }
            return .date(applyOffsets(timed ? now : startOfDay(cal, now), offsets, 1, cal: cal), hasTime: timed, expression: q)
        }
        return nil
    }

    static func formatter(_ cal: Calendar, _ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = cal
        f.timeZone = cal.timeZone
        f.dateFormat = format
        return f
    }

    public static func formatDate(_ d: Date, withTime: Bool = false, cal: Calendar) -> String {
        let date = formatter(cal, "EEE, MMM d, yyyy").string(from: d)
        return withTime ? "\(date), \(formatter(cal, "h:mm a").string(from: d))" : date
    }

    public static func isoDate(_ d: Date, cal: Calendar) -> String { formatter(cal, "yyyy-MM-dd").string(from: d) }

    /// "9 weeks, 3 days" breakdown of a day count.
    public static func describeDays(_ days: Int) -> String {
        let a = abs(days)
        let weeks = a / 7, rest = a % 7
        var out: [String] = []
        if weeks > 0 { out.append("\(weeks) week\(weeks == 1 ? "" : "s")") }
        if rest > 0 || weeks == 0 { out.append("\(rest) day\(rest == 1 ? "" : "s")") }
        return out.joined(separator: ", ")
    }

    static func jsNum(_ v: Double) -> String { v == v.rounded() ? String(Int64(v)) : ConvertFormat.plainNumber(v, 12) }

    /// Headline value for a count result in its requested unit ("66 days", "9.4 weeks", "2 months").
    public static func countValue(days: Int, unit: String, from: Date, to: Date, cal: Calendar) -> (value: Double, label: String) {
        func plural(_ n: Double, _ w: String) -> String { "\(jsNum(n)) \(w)\(n == 1 ? "" : "s")" }
        switch unit {
        case "week":
            let v = (Double(days) / 7 * 10).rounded() / 10
            return (v, plural(v, "week"))
        case "month":
            let (a, b) = from <= to ? (from, to) : (to, from)
            let pa = parts(cal, a), pb = parts(cal, b)
            var monthsN = (pb.y - pa.y) * 12 + (pb.m0 - pa.m0)
            if pb.d < pa.d { monthsN -= 1 }
            let anchor = applyOffsets(startOfDay(cal, a), [Offset(n: Double(monthsN), unit: .month)], 1, cal: cal)
            let rest = daysBetween(anchor, b, cal: cal)
            let mv = Double(monthsN)
            return (mv, rest != 0 ? "\(plural(mv, "month")), \(plural(Double(rest), "day"))" : plural(mv, "month"))
        case "year":
            let v = (Double(days) / 365.2425 * 100).rounded() / 100
            return (v, plural(v, "year"))
        case "hour":
            let v = (abs(to.timeIntervalSince(from)) / 3600).rounded()
            return (v, plural(v, "hour"))
        case "minute":
            let v = (abs(to.timeIntervalSince(from)) / 60).rounded()
            return (v, plural(v, "minute"))
        default:
            return (Double(days), plural(Double(days), "day"))
        }
    }
}
