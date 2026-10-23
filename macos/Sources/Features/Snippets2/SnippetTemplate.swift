import Foundation

// Placeholder templates for snippets — port of src/main/quicklinks/placeholders.ts + dates.ts (pure).
//
// Grammar: `{name attr="value" attr2='v' | modifier | modifier}`. Anything that does not parse as a known
// placeholder stays literal text, so JSON or code in a snippet survives untouched.
// Names: query, argument, clipboard, selection, date, time, datetime, day, uuid, cursor, snippet.
// Modifiers: raw, percent-encode, uppercase, lowercase, trim, json-stringify.

public enum SnipTemplate {
    public static let names: Set<String> = ["query", "argument", "clipboard", "selection", "date", "time", "datetime", "day", "uuid", "cursor", "snippet"]
    public static let modifiers: Set<String> = ["raw", "percent-encode", "uppercase", "lowercase", "trim", "json-stringify"]
    /// Private-use char marking {cursor} in rendered text (never typed by people).
    public static let cursorMarker = "\u{E000}"

    public struct Placeholder: Equatable, Sendable {
        public var name: String
        public var attrs: [String: String]
        public var modifiers: [String]
        public var raw: String
    }

    public enum Token: Equatable, Sendable {
        case text(String)
        case placeholder(Placeholder)
    }

    public struct Env {
        public var now: Date
        public var clipboard: String?
        public var selection: String?
        public var uuid: () -> String
        public var arguments: [String: String]?
        /// Text of another snippet by name (snippets only); nil when unknown.
        public var snippet: ((String) -> String?)?
        public var calendar: Calendar
        public init(now: Date, clipboard: String? = nil, selection: String? = nil, uuid: @escaping () -> String = { UUID().uuidString.lowercased() },
                    arguments: [String: String]? = nil, snippet: ((String) -> String?)? = nil, calendar: Calendar = .current) {
            self.now = now
            self.clipboard = clipboard
            self.selection = selection
            self.uuid = uuid
            self.arguments = arguments
            self.snippet = snippet
            self.calendar = calendar
        }
    }

    public struct Options {
        public var encode = false
        public var html = false
        public var cursorMarker = ""
        public init(encode: Bool = false, html: Bool = false, cursorMarker: String = "") {
            self.encode = encode
            self.html = html
            self.cursorMarker = cursorMarker
        }
    }

    // MARK: parsing

    private static let headRe = try? NSRegularExpression(pattern: #"^\s*([a-z]+)\b([\s\S]*)$"#)
    private static let attrRe = try? NSRegularExpression(pattern: #"^([a-zA-Z][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"']+))\s*"#)

    private static func group(_ m: NSTextCheckingResult, _ i: Int, _ s: String) -> String? {
        let r = m.range(at: i)
        guard r.location != NSNotFound, let rr = Range(r, in: s) else { return nil }
        return String(s[rr])
    }

    static func splitPipes(_ s: String) -> [String] {
        var out: [String] = []
        var cur = ""
        var quote: Character?
        var it = Array(s)
        var i = 0
        while i < it.count {
            let c = it[i]
            if let q = quote {
                if c == "\\" && i + 1 < it.count { cur.append(c); cur.append(it[i + 1]); i += 2; continue }
                if c == q { quote = nil }
                cur.append(c)
            } else if c == "\"" || c == "'" {
                quote = c
                cur.append(c)
            } else if c == "|" {
                out.append(cur)
                cur = ""
            } else {
                cur.append(c)
            }
            i += 1
        }
        out.append(cur)
        it = []
        return out
    }

    static func parseInner(_ inner: String) -> (name: String, attrs: [String: String], modifiers: [String])? {
        let parts = splitPipes(inner)
        let head = parts.first ?? ""
        guard let headRe, let m = headRe.firstMatch(in: head, range: NSRange(head.startIndex..., in: head)), let name = group(m, 1, head), names.contains(name) else { return nil }
        var attrs: [String: String] = [:]
        var rest = (group(m, 2, head) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        while !rest.isEmpty {
            guard let attrRe, let a = attrRe.firstMatch(in: rest, range: NSRange(rest.startIndex..., in: rest)), let key = group(a, 1, rest),
                  let whole = Range(a.range, in: rest) else { return nil }
            let v = group(a, 2, rest) ?? group(a, 3, rest) ?? group(a, 4, rest) ?? ""
            attrs[key] = unescape(v)
            rest = String(rest[whole.upperBound...])
        }
        var mods: [String] = []
        for p in parts.dropFirst() {
            let mod = p.trimmingCharacters(in: .whitespacesAndNewlines)
            guard modifiers.contains(mod) else { return nil }
            mods.append(mod)
        }
        return (name, attrs, mods)
    }

    /// `\"` `\'` `\\` → the character.
    private static func unescape(_ s: String) -> String {
        var out = ""
        var esc = false
        for c in s {
            if esc {
                if c != "\"" && c != "'" && c != "\\" { out.append("\\") }
                out.append(c)
                esc = false
            } else if c == "\\" {
                esc = true
            } else {
                out.append(c)
            }
        }
        if esc { out.append("\\") }
        return out
    }

    /// Index of the `}` closing a placeholder that starts at `from` (quotes may hold braces); nil if none.
    private static func findClose(_ s: [Character], from: Int) -> Int? {
        var quote: Character?
        var i = from
        while i < s.count {
            let c = s[i]
            if let q = quote {
                if c == "\\" { i += 1 } else if c == q { quote = nil }
            } else if c == "\"" || c == "'" {
                quote = c
            } else if c == "{" || c == "\n" {
                return nil
            } else if c == "}" {
                return i
            }
            i += 1
        }
        return nil
    }

    public static func parse(_ template: String) -> [Token] {
        let chars = Array(template)
        var tokens: [Token] = []
        var text = ""
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "{", let end = findClose(chars, from: i + 1) {
                let inner = String(chars[(i + 1)..<end])
                if let p = parseInner(inner) {
                    if !text.isEmpty { tokens.append(.text(text)) }
                    text = ""
                    tokens.append(.placeholder(Placeholder(name: p.name, attrs: p.attrs, modifiers: p.modifiers, raw: String(chars[i...end]))))
                    i = end + 1
                    continue
                }
            }
            text.append(c)
            i += 1
        }
        if !text.isEmpty { tokens.append(.text(text)) }
        return tokens
    }

    // MARK: rendering

    static func encodeValue(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
        allowed.insert(charactersIn: "-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    static func escapeHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    static func jsonString(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed, .withoutEscapingSlashes]) else { return "\"\(s)\"" }
        return String(decoding: d, as: UTF8.self)
    }

    public static func applyModifiers(_ value: String, _ mods: [String]) -> String {
        var v = value
        for m in mods {
            switch m {
            case "uppercase": v = v.uppercased()
            case "lowercase": v = v.lowercased()
            case "trim": v = v.trimmingCharacters(in: .whitespacesAndNewlines)
            case "json-stringify": v = jsonString(v)
            case "percent-encode": v = encodeValue(v)
            default: break
            }
        }
        return v
    }

    private static func argumentName(_ p: Placeholder, _ counter: inout Int) -> String {
        if p.name == "query" { return "query" }
        if let n = p.attrs["name"]?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
        counter += 1
        return counter == 1 ? "argument" : "argument \(counter)"
    }

    private static func baseValue(_ p: Placeholder, _ env: Env, _ counter: inout Int) -> String {
        switch p.name {
        case "query", "argument":
            let name = argumentName(p, &counter)
            if let v = env.arguments?[name], !v.isEmpty { return v }
            return p.attrs["default"] ?? ""
        case "clipboard": return env.clipboard ?? ""
        case "selection": return env.selection ?? ""
        case "uuid": return env.uuid()
        case "date", "time", "datetime", "day":
            let d = p.attrs["offset"].map { SnipDates.applyOffset(env.now, $0, calendar: env.calendar) } ?? env.now
            let fallback = p.name == "date" ? "yyyy-MM-dd" : p.name == "time" ? "HH:mm" : p.name == "day" ? "EEEE" : "yyyy-MM-dd HH:mm"
            let f = p.attrs["format"].flatMap { $0.isEmpty ? nil : $0 } ?? fallback
            return SnipDates.format(d, f, calendar: env.calendar)
        default: return ""
        }
    }

    private static func atURLStart(_ tokens: [Token], _ index: Int) -> Bool {
        for t in tokens.prefix(index) {
            switch t {
            case let .text(s): if !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
            case .placeholder: return false
            }
        }
        return true
    }

    /// Render tokens. Snippet references resolve through env.snippet with the same options and a depth guard.
    public static func render(_ tokens: [Token], _ env: Env, _ opts: Options = Options(), depth: Int = 0, seen: Set<String> = []) -> String {
        var counter = 0
        var out = ""
        for (i, t) in tokens.enumerated() {
            guard case let .placeholder(p) = t else {
                if case let .text(s) = t { out += s }
                continue
            }
            if p.name == "cursor" { out += opts.cursorMarker; continue }
            if p.name == "snippet" {
                let name = p.attrs["name"]?.trimmingCharacters(in: .whitespaces) ?? ""
                let body = !name.isEmpty && depth < 5 && !seen.contains(name.lowercased()) ? env.snippet?(name) : nil
                var value = body.map { render(parse($0), env, Options(encode: opts.encode, html: false, cursorMarker: ""), depth: depth + 1, seen: seen.union([name.lowercased()])) } ?? ""
                value = applyModifiers(value, p.modifiers)
                out += opts.html ? escapeHTML(value).replacingOccurrences(of: "\n", with: "<br>") : value
                continue
            }
            var value = applyModifiers(baseValue(p, env, &counter), p.modifiers.filter { $0 != "percent-encode" })
            let raw = p.attrs["raw"] == "true" || p.modifiers.contains("raw")
            let explicit = p.modifiers.contains("percent-encode") || p.attrs["encode"] == "true"
            if explicit || (opts.encode && !raw && !atURLStart(tokens, i)) { value = encodeValue(value) }
            if opts.html { value = escapeHTML(value) }
            out += value
        }
        return out
    }

    public static func render(_ template: String, _ env: Env, _ opts: Options = Options()) -> String { render(parse(template), env, opts) }

    /// True when rendering depends on time, clipboard, selection, uuid or other snippets.
    public static func isDynamic(_ template: String) -> Bool {
        parse(template).contains { if case let .placeholder(p) = $0 { return !["cursor", "argument", "query"].contains(p.name) }; return false }
    }

    public static func uses(_ template: String, _ name: String) -> Bool {
        parse(template).contains { if case let .placeholder(p) = $0 { return p.name == name }; return false }
    }
}

/// Date formatting (date-fns style tokens) and offsets ("+1d", "-2w", "+1d 3h", "+1M") — port of dates.ts.
public enum SnipDates {
    private static let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    private static let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    private static let tokens = ["yyyy", "MMMM", "EEEE", "SSS", "MMM", "EEE", "yy", "MM", "dd", "HH", "hh", "mm", "ss", "ww", "M", "d", "H", "h", "m", "s", "a", "w", "Q", "X", "x"]

    private static func pad(_ n: Int, _ w: Int = 2) -> String {
        let s = String(n)
        return s.count >= w ? s : String(repeating: "0", count: w - s.count) + s
    }

    static func isoWeek(_ d: Date, calendar: Calendar) -> Int {
        var iso = Calendar(identifier: .iso8601)
        iso.timeZone = calendar.timeZone
        return iso.component(.weekOfYear, from: d)
    }

    private static func token(_ d: Date, _ tok: String, _ cal: Calendar) -> String? {
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond, .weekday], from: d)
        let h = c.hour ?? 0
        switch tok {
        case "yyyy": return String(c.year ?? 0)
        case "yy": return pad((c.year ?? 0) % 100)
        case "MMMM": return months[(c.month ?? 1) - 1]
        case "MMM": return String(months[(c.month ?? 1) - 1].prefix(3))
        case "MM": return pad(c.month ?? 1)
        case "M": return String(c.month ?? 1)
        case "dd": return pad(c.day ?? 1)
        case "d": return String(c.day ?? 1)
        case "EEEE": return days[(c.weekday ?? 1) - 1]
        case "EEE": return String(days[(c.weekday ?? 1) - 1].prefix(3))
        case "HH": return pad(h)
        case "H": return String(h)
        case "hh": return pad(h % 12 == 0 ? 12 : h % 12)
        case "h": return String(h % 12 == 0 ? 12 : h % 12)
        case "mm": return pad(c.minute ?? 0)
        case "m": return String(c.minute ?? 0)
        case "ss": return pad(c.second ?? 0)
        case "s": return String(c.second ?? 0)
        case "SSS": return pad((c.nanosecond ?? 0) / 1_000_000, 3)
        case "a": return h < 12 ? "AM" : "PM"
        case "ww": return pad(isoWeek(d, calendar: cal))
        case "w": return String(isoWeek(d, calendar: cal))
        case "Q": return String(((c.month ?? 1) - 1) / 3 + 1)
        case "X": return String(Int(d.timeIntervalSince1970.rounded(.down)))
        case "x": return String(Int((d.timeIntervalSince1970 * 1000).rounded(.down)))
        default: return nil
        }
    }

    /// Format with tokens like `yyyy-MM-dd HH:mm`, `EEEE, MMMM d`. Text in single quotes is literal (`''` = quote).
    public static func format(_ d: Date, _ format: String, calendar: Calendar = .current) -> String {
        let f = Array(format)
        var out = ""
        var i = 0
        func starts(_ t: String, at i: Int) -> Bool {
            let tc = Array(t)
            guard i + tc.count <= f.count else { return false }
            return Array(f[i..<(i + tc.count)]) == tc
        }
        while i < f.count {
            let c = f[i]
            if c == "'" {
                if i + 1 < f.count && f[i + 1] == "'" { out += "'"; i += 2; continue }
                var j = i + 1
                while j < f.count {
                    if f[j] == "'" && j + 1 < f.count && f[j + 1] == "'" { out += "'"; j += 2 }
                    else if f[j] == "'" { break }
                    else { out.append(f[j]); j += 1 }
                }
                i = j + 1
                continue
            }
            if let tok = tokens.first(where: { starts($0, at: i) }), let v = token(d, tok, calendar) {
                out += v
                i += tok.count
            } else {
                out.append(c)
                i += 1
            }
        }
        return out
    }

    private static let offsetRe = try? NSRegularExpression(pattern: #"([+-])?\s*(\d+)\s*(y|M|w|d|h|m|s)"#)

    /// Units y M w d h m s; a sign applies to the following terms until another sign. Unparseable → unchanged.
    public static func applyOffset(_ base: Date, _ offset: String, calendar: Calendar = .current) -> Date {
        guard let offsetRe else { return base }
        var d = base
        var sign = 1
        let ns = offset as NSString
        for m in offsetRe.matches(in: offset, range: NSRange(location: 0, length: ns.length)) {
            if m.range(at: 1).location != NSNotFound { sign = ns.substring(with: m.range(at: 1)) == "-" ? -1 : 1 }
            let n = (Int(ns.substring(with: m.range(at: 2))) ?? 0) * sign
            let unit: Calendar.Component
            var amount = n
            switch ns.substring(with: m.range(at: 3)) {
            case "y": unit = .year
            case "M": unit = .month
            case "w": unit = .day; amount = 7 * n
            case "d": unit = .day
            case "h": unit = .hour
            case "m": unit = .minute
            default: unit = .second
            }
            d = calendar.date(byAdding: unit, value: amount, to: d) ?? d
        }
        return d
    }
}
