import Foundation

/// Time zones (port of convert/timezones.ts): "time in tokyo", "nyc time", "5pm london in tokyo", "9:30am pst to cet".
/// Zone maths uses Foundation's IANA database, so DST is handled for free.
public enum ConvertTimeZones {
    public struct ZoneRef: Equatable, Sendable {
        public var zone: String
        public var label: String
        var tz: TimeZone? { TimeZone(identifier: zone) }
    }

    static func a(_ z: String, _ l: String) -> ZoneRef { ZoneRef(zone: z, label: l) }

    static let aliases: [String: ZoneRef] = [
        "nyc": a("America/New_York", "New York"), "new york city": a("America/New_York", "New York"), "ny": a("America/New_York", "New York"),
        "boston": a("America/New_York", "Boston"), "miami": a("America/New_York", "Miami"), "atlanta": a("America/New_York", "Atlanta"), "washington": a("America/New_York", "Washington"),
        "dc": a("America/New_York", "Washington"), "philadelphia": a("America/New_York", "Philadelphia"), "toronto": a("America/Toronto", "Toronto"),
        "sf": a("America/Los_Angeles", "San Francisco"), "san francisco": a("America/Los_Angeles", "San Francisco"), "la": a("America/Los_Angeles", "Los Angeles"),
        "seattle": a("America/Los_Angeles", "Seattle"), "silicon valley": a("America/Los_Angeles", "San Francisco"), "san jose": a("America/Los_Angeles", "San Jose"),
        "las vegas": a("America/Los_Angeles", "Las Vegas"), "portland": a("America/Los_Angeles", "Portland"), "san diego": a("America/Los_Angeles", "San Diego"),
        "austin": a("America/Chicago", "Austin"), "dallas": a("America/Chicago", "Dallas"), "houston": a("America/Chicago", "Houston"), "denver": a("America/Denver", "Denver"),
        "phoenix": a("America/Phoenix", "Phoenix"), "montreal": a("America/Toronto", "Montreal"), "mexico city": a("America/Mexico_City", "Mexico City"),
        "rio": a("America/Sao_Paulo", "Rio de Janeiro"), "rio de janeiro": a("America/Sao_Paulo", "Rio de Janeiro"),
        "uk": a("Europe/London", "London"), "england": a("Europe/London", "London"), "britain": a("Europe/London", "London"), "ireland": a("Europe/Dublin", "Dublin"),
        "france": a("Europe/Paris", "Paris"), "germany": a("Europe/Berlin", "Berlin"), "munich": a("Europe/Berlin", "Munich"), "frankfurt": a("Europe/Berlin", "Frankfurt"),
        "hamburg": a("Europe/Berlin", "Hamburg"), "spain": a("Europe/Madrid", "Madrid"), "barcelona": a("Europe/Madrid", "Barcelona"), "italy": a("Europe/Rome", "Rome"),
        "milan": a("Europe/Rome", "Milan"), "netherlands": a("Europe/Amsterdam", "Amsterdam"), "switzerland": a("Europe/Zurich", "Zurich"), "geneva": a("Europe/Zurich", "Geneva"),
        "sweden": a("Europe/Stockholm", "Stockholm"), "norway": a("Europe/Oslo", "Oslo"), "poland": a("Europe/Warsaw", "Warsaw"), "greece": a("Europe/Athens", "Athens"),
        "turkey": a("Europe/Istanbul", "Istanbul"), "russia": a("Europe/Moscow", "Moscow"), "ukraine": a("Europe/Kyiv", "Kyiv"), "kiev": a("Europe/Kyiv", "Kyiv"),
        "portugal": a("Europe/Lisbon", "Lisbon"), "belgium": a("Europe/Brussels", "Brussels"), "austria": a("Europe/Vienna", "Vienna"),
        "nigeria": a("Africa/Lagos", "Lagos"), "abuja": a("Africa/Lagos", "Abuja"), "ghana": a("Africa/Accra", "Accra"), "kenya": a("Africa/Nairobi", "Nairobi"),
        "egypt": a("Africa/Cairo", "Cairo"), "south africa": a("Africa/Johannesburg", "Johannesburg"), "cape town": a("Africa/Johannesburg", "Cape Town"),
        "morocco": a("Africa/Casablanca", "Casablanca"), "ethiopia": a("Africa/Addis_Ababa", "Addis Ababa"),
        "dubai": a("Asia/Dubai", "Dubai"), "uae": a("Asia/Dubai", "Dubai"), "abu dhabi": a("Asia/Dubai", "Abu Dhabi"), "israel": a("Asia/Jerusalem", "Jerusalem"),
        "tel aviv": a("Asia/Jerusalem", "Tel Aviv"), "saudi arabia": a("Asia/Riyadh", "Riyadh"), "qatar": a("Asia/Qatar", "Doha"), "doha": a("Asia/Qatar", "Doha"),
        "india": a("Asia/Kolkata", "India"), "mumbai": a("Asia/Kolkata", "Mumbai"), "delhi": a("Asia/Kolkata", "Delhi"), "new delhi": a("Asia/Kolkata", "New Delhi"),
        "bangalore": a("Asia/Kolkata", "Bangalore"), "bengaluru": a("Asia/Kolkata", "Bengaluru"), "chennai": a("Asia/Kolkata", "Chennai"), "pakistan": a("Asia/Karachi", "Karachi"),
        "china": a("Asia/Shanghai", "China"), "beijing": a("Asia/Shanghai", "Beijing"), "shenzhen": a("Asia/Shanghai", "Shenzhen"), "hong kong": a("Asia/Hong_Kong", "Hong Kong"),
        "hk": a("Asia/Hong_Kong", "Hong Kong"), "taiwan": a("Asia/Taipei", "Taipei"), "japan": a("Asia/Tokyo", "Tokyo"), "osaka": a("Asia/Tokyo", "Osaka"), "kyoto": a("Asia/Tokyo", "Kyoto"),
        "korea": a("Asia/Seoul", "Seoul"), "south korea": a("Asia/Seoul", "Seoul"), "singapore": a("Asia/Singapore", "Singapore"), "thailand": a("Asia/Bangkok", "Bangkok"),
        "vietnam": a("Asia/Ho_Chi_Minh", "Ho Chi Minh City"), "hanoi": a("Asia/Bangkok", "Hanoi"), "indonesia": a("Asia/Jakarta", "Jakarta"), "bali": a("Asia/Makassar", "Bali"),
        "philippines": a("Asia/Manila", "Manila"), "malaysia": a("Asia/Kuala_Lumpur", "Kuala Lumpur"),
        "australia": a("Australia/Sydney", "Sydney"), "canberra": a("Australia/Sydney", "Canberra"), "new zealand": a("Pacific/Auckland", "Auckland"), "nz": a("Pacific/Auckland", "Auckland"),
        "wellington": a("Pacific/Auckland", "Wellington"), "hawaii": a("Pacific/Honolulu", "Honolulu"), "alaska": a("America/Anchorage", "Anchorage"),
        "brazil": a("America/Sao_Paulo", "São Paulo"), "argentina": a("America/Argentina/Buenos_Aires", "Buenos Aires"), "chile": a("America/Santiago", "Santiago"),
        "colombia": a("America/Bogota", "Bogotá"), "peru": a("America/Lima", "Lima"), "mexico": a("America/Mexico_City", "Mexico City"), "canada": a("America/Toronto", "Toronto"),
        "vancouver": a("America/Vancouver", "Vancouver"), "calgary": a("America/Edmonton", "Calgary"),
        "utc": a("UTC", "UTC"), "gmt": a("GMT", "GMT"), "z": a("UTC", "UTC"), "zulu": a("UTC", "UTC"),
        "est": a("America/New_York", "ET"), "edt": a("America/New_York", "ET"), "et": a("America/New_York", "ET"), "eastern": a("America/New_York", "ET"),
        "cst": a("America/Chicago", "CT"), "cdt": a("America/Chicago", "CT"), "ct": a("America/Chicago", "CT"), "central": a("America/Chicago", "CT"),
        "mst": a("America/Denver", "MT"), "mdt": a("America/Denver", "MT"), "mt": a("America/Denver", "MT"), "mountain": a("America/Denver", "MT"),
        "pst": a("America/Los_Angeles", "PT"), "pdt": a("America/Los_Angeles", "PT"), "pt": a("America/Los_Angeles", "PT"), "pacific": a("America/Los_Angeles", "PT"),
        "akst": a("America/Anchorage", "AKT"), "hst": a("Pacific/Honolulu", "HST"),
        "bst": a("Europe/London", "UK"), "wet": a("Europe/Lisbon", "WET"), "cet": a("Europe/Paris", "CET"), "cest": a("Europe/Paris", "CET"), "eet": a("Europe/Athens", "EET"),
        "eest": a("Europe/Athens", "EET"), "msk": a("Europe/Moscow", "MSK"), "wat": a("Africa/Lagos", "WAT"), "cat": a("Africa/Maputo", "CAT"), "eat": a("Africa/Nairobi", "EAT"),
        "sast": a("Africa/Johannesburg", "SAST"), "ist": a("Asia/Kolkata", "IST"), "pkt": a("Asia/Karachi", "PKT"), "gst": a("Asia/Dubai", "GST"),
        "sgt": a("Asia/Singapore", "SGT"), "hkt": a("Asia/Hong_Kong", "HKT"), "jst": a("Asia/Tokyo", "JST"), "kst": a("Asia/Seoul", "KST"),
        "aest": a("Australia/Sydney", "AET"), "aedt": a("Australia/Sydney", "AET"), "acst": a("Australia/Adelaide", "ACT"), "awst": a("Australia/Perth", "AWT"),
        "nzst": a("Pacific/Auckland", "NZT"), "nzdt": a("Pacific/Auckland", "NZT"),
    ]

    /// "america/new_york" and "new york" → America/New_York (from the system zone list).
    static let cities: [String: ZoneRef] = {
        var out: [String: ZoneRef] = [:]
        for zone in TimeZone.knownTimeZoneIdentifiers + ["UTC"] {
            let city = (zone.split(separator: "/").last.map(String.init) ?? zone).replacingOccurrences(of: "_", with: " ")
            out[zone.lowercased()] = ZoneRef(zone: zone, label: city)
            if out[city.lowercased()] == nil { out[city.lowercased()] = ZoneRef(zone: zone, label: city) }
        }
        // Foundation still ships the old spelling.
        if out["kyiv"] == nil, TimeZone(identifier: "Europe/Kiev") != nil { out["kyiv"] = ZoneRef(zone: "Europe/Kiev", label: "Kyiv") }
        return out
    }()

    static func normalise(_ r: ZoneRef) -> ZoneRef? {
        if TimeZone(identifier: r.zone) != nil { return r }
        if r.zone == "Europe/Kyiv", TimeZone(identifier: "Europe/Kiev") != nil { return ZoneRef(zone: "Europe/Kiev", label: r.label) }
        return nil
    }

    /// Resolve "tokyo", "NYC", "pst", "Europe/Paris", "utc+3", "local".
    public static func lookupZone(_ raw: String, localZone: String) -> ZoneRef? {
        var t = ConvertRegex.replace("\\s+", in: raw.trimmingCharacters(in: .whitespaces).lowercased(), with: " ")
        t = ConvertRegex.replace("[?.!]+$", in: t, with: "")
        guard !t.isEmpty else { return nil }
        if ["local", "here", "my time", "local time"].contains(t) { return ZoneRef(zone: localZone, label: "Local") }
        if let off = ConvertRegex.match("^(?:utc|gmt)\\s*([+-])\\s*(\\d{1,2})(?::?(\\d{2}))?$", t), let sign = off[1], let hs = off[2], let h = Int(hs) {
            guard h <= 14 else { return nil }
            let mins = off[3].flatMap { Int($0) } ?? 0
            let total = (h * 3600 + mins * 60) * (sign == "-" ? -1 : 1)
            let zone: String
            if mins != 0 { zone = "GMT\(sign)\(String(format: "%02d", h))\(String(format: "%02d", mins))" } else if h == 0 { zone = "UTC" } else { zone = "Etc/GMT\(sign == "+" ? "-" : "+")\(h)" }
            guard TimeZone(identifier: zone) != nil || TimeZone(secondsFromGMT: total) != nil else { return nil }
            return ZoneRef(zone: TimeZone(identifier: zone) != nil ? zone : "GMT\(sign)\(String(format: "%02d%02d", h, mins))", label: "UTC\(sign)\(h)\(mins != 0 ? ":\(off[3] ?? "")" : "")")
        }
        guard let hit = aliases[t] ?? cities[t] else { return nil }
        return normalise(hit)
    }

    struct Wall: Equatable { var year, month, day, hour, minute: Int }

    static func calendar(_ zone: String) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: zone) ?? TimeZone(secondsFromGMT: 0) ?? .current
        return c
    }

    static func wallIn(_ zone: String, _ instantMs: Double) -> Wall {
        let d = calendar(zone).dateComponents([.year, .month, .day, .hour, .minute], from: Date(timeIntervalSince1970: instantMs / 1000))
        return Wall(year: d.year ?? 1970, month: d.month ?? 1, day: d.day ?? 1, hour: (d.hour ?? 0) % 24, minute: d.minute ?? 0)
    }

    /// Minutes east of UTC for `zone` at `instant`.
    public static func offsetMinutes(_ zone: String, _ instantMs: Double) -> Int {
        guard let tz = TimeZone(identifier: zone) else { return 0 }
        return tz.secondsFromGMT(for: Date(timeIntervalSince1970: instantMs / 1000)) / 60
    }

    /// The instant when the wall clock in `zone` shows the given time (DST gaps resolve forward).
    static func wallToInstant(_ zone: String, _ w: Wall) -> Double {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        let guess = (utc.date(from: DateComponents(year: w.year, month: w.month, day: w.day, hour: w.hour, minute: w.minute))?.timeIntervalSince1970 ?? 0) * 1000
        let o1 = offsetMinutes(zone, guess)
        var inst = guess - Double(o1) * 60_000
        let o2 = offsetMinutes(zone, inst)
        if o2 != o1 { inst = guess - Double(o2) * 60_000 }
        return inst
    }

    /// "5pm", "5:30 pm", "17:00", "noon", "midnight" → (hour, minute). Bare "5" is not a time.
    public static func parseClock(_ raw: String) -> (hour: Int, minute: Int)? {
        let t = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if t == "noon" || t == "midday" { return (12, 0) }
        if t == "midnight" { return (0, 0) }
        guard let m = ConvertRegex.match("^(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.|a|p)?$", t), let hs = m[1], var hour = Int(hs) else { return nil }
        if m[2] == nil && m[3] == nil { return nil }
        let minute = m[2].flatMap { Int($0) } ?? 0
        if minute > 59 { return nil }
        if let ap = m[3] {
            guard (1...12).contains(hour) else { return nil }
            hour = hour % 12 + (ap.hasPrefix("p") ? 12 : 0)
        } else if hour > 23 { return nil }
        return (hour, minute)
    }

    public struct Result: Sendable {
        public var time: String
        public var date: String
        public var offset: String
        public var to: ZoneRef
        public var from: ZoneRef?
        public var fromTime: String?
        public var dayDelta: Int
        public var instant: Double
        public var iso: String
    }

    static func formatter(_ zone: String, _ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: zone)
        f.dateFormat = format
        return f
    }

    /// Intl "shortOffset": "GMT+9", "GMT+5:30", "GMT-4", "GMT".
    public static func formatOffset(_ zone: String, _ instantMs: Double) -> String {
        let m = offsetMinutes(zone, instantMs)
        if m == 0 { return "GMT" }
        let sign = m > 0 ? "+" : "-"
        let h = abs(m) / 60, mm = abs(m) % 60
        return mm == 0 ? "GMT\(sign)\(h)" : "GMT\(sign)\(h):\(String(format: "%02d", mm))"
    }

    static func isoIn(_ zone: String, _ instantMs: Double) -> String {
        let w = wallIn(zone, instantMs)
        let off = offsetMinutes(zone, instantMs)
        func p(_ n: Int) -> String { String(format: "%02d", abs(n)) }
        return "\(w.year)-\(p(w.month))-\(p(w.day))T\(p(w.hour)):\(p(w.minute)):00\(off >= 0 ? "+" : "-")\(p(off / 60)):\(p(off % 60))"
    }

    static func dayNumber(_ w: Wall) -> Int {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        let d = utc.date(from: DateComponents(year: w.year, month: w.month, day: w.day)) ?? Date(timeIntervalSince1970: 0)
        return Int((d.timeIntervalSince1970 / 86_400).rounded())
    }

    static func describe(_ instantMs: Double, to: ZoneRef, from: ZoneRef?, sourceZone: String) -> Result {
        let date = Date(timeIntervalSince1970: instantMs / 1000)
        return Result(time: formatter(to.zone, "h:mm a").string(from: date), date: formatter(to.zone, "EEE, MMM d").string(from: date),
                      offset: formatOffset(to.zone, instantMs), to: to, from: from, fromTime: from.map { formatter($0.zone, "h:mm a").string(from: date) },
                      dayDelta: dayNumber(wallIn(to.zone, instantMs)) - dayNumber(wallIn(sourceZone, instantMs)), instant: instantMs, iso: isoIn(to.zone, instantMs))
    }

    /// Parse and evaluate a time-zone query; nil when the text is not one.
    public static func parse(_ query: String, nowMs: Double, localZone: String) -> Result? {
        var q = ConvertRegex.replace("\\s+", in: query.trimmingCharacters(in: .whitespaces).lowercased(), with: " ")
        if q.hasSuffix("?") { q.removeLast() }
        guard q.count >= 4, q.count <= 60 else { return nil }
        let local = ZoneRef(zone: localZone, label: "Local")
        if let cur = ConvertRegex.match("^(?:what(?:'s| is)? the time in|what time is it in|current time in|time (?:in|at)|now in|time)\\s+(.+)$", q) ?? ConvertRegex.match("^(.+?)\\s+(?:time|now)$", q),
           let place = cur[1], let to = lookupZone(place, localZone: localZone) {
            return describe(nowMs, to: to, from: nil, sourceZone: localZone)
        }
        var left = q
        var right: String?
        if let conv = ConvertRegex.match("^(.+?)\\s+(?:in|to|into|->|→|=)\\s+(.+)$", q), let l = conv[1], let r = conv[2] { left = l; right = r }
        guard let lm = ConvertRegex.match("^(noon|midnight|midday|\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.|a|p)?)(?:\\s+(.+))?$", left), let clockText = lm[1],
              let clock = parseClock(clockText) else { return nil }
        let from = lm[2].flatMap { lookupZone($0, localZone: localZone) }
        if lm[2] != nil && from == nil { return nil }
        let to = right.flatMap { lookupZone($0, localZone: localZone) }
        if right != nil && to == nil { return nil }
        if from == nil && to == nil { return nil }
        let src = from ?? local
        let dst = to ?? local
        let today = wallIn(src.zone, nowMs)
        let instant = wallToInstant(src.zone, Wall(year: today.year, month: today.month, day: today.day, hour: clock.hour, minute: clock.minute))
        return describe(instant, to: dst, from: src, sourceZone: src.zone)
    }
}
