import Foundation
import GlideCore

/// Placeholder templates shared by quicklinks and snippets (port of src/main/quicklinks/placeholders.ts + dates.ts).
///
/// Grammar: `{name attr="value" attr2='v' | modifier | modifier}`. Anything that does not parse as a known
/// placeholder stays literal, so JSON or code survives. Names: query, argument, clipboard, selection, date, time,
/// datetime, day, uuid, cursor, snippet. Modifiers: raw, percent-encode, uppercase, lowercase, trim, json-stringify.
public enum QLTemplate {
    public static let names: Set<String> = ["query", "argument", "clipboard", "selection", "date", "time", "datetime", "day", "uuid", "cursor", "snippet"]
    public static let modifierNames: Set<String> = ["raw", "percent-encode", "uppercase", "lowercase", "trim", "json-stringify"]

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

    /// Split on `|` outside quotes.
    static func splitPipes(_ s: [Character]) -> [String] {
        var out: [String] = []
        var cur = ""
        var quote: Character?
        var i = 0
        while i < s.count {
            let c = s[i]
            if let q = quote {
                if c == "\\" && i + 1 < s.count { cur.append(c); cur.append(s[i + 1]); i += 2; continue }
                if c == q { quote = nil }
                cur.append(c)
            } else if c == "\"" || c == "'" {
                quote = c
                cur.append(c)
            } else if c == "|" {
                out.append(cur)
                cur = ""
            } else { cur.append(c) }
            i += 1
        }
        out.append(cur)
        return out
    }

    static func parseInner(_ inner: String) -> (String, [String: String], [String])? {
        let pieces = splitPipes(Array(inner))
        guard let head = pieces.first else { return nil }
        let h = Array(head)
        var i = 0
        while i < h.count && h[i].isWhitespace { i += 1 }
        let start = i
        while i < h.count && h[i].isASCII && h[i].isLowercase { i += 1 }
        let name = String(h[start..<i])
        guard !name.isEmpty, names.contains(name) else { return nil }
        // \b after the name: the next char must not be a word char.
        if i < h.count, h[i].isLetter || h[i].isNumber || h[i] == "_" { return nil }
        var attrs: [String: String] = [:]
        var rest = String(h[i...]).trimmingCharacters(in: .whitespacesAndNewlines)
        let attrRe = try? NSRegularExpression(pattern: "^([a-zA-Z][\\w-]*)\\s*=\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|'((?:[^'\\\\]|\\\\.)*)'|([^\\s\"']+))\\s*")
        while !rest.isEmpty {
            let ns = rest as NSString
            guard let m = attrRe?.firstMatch(in: rest, range: NSRange(location: 0, length: ns.length)) else { return nil }
            func g(_ k: Int) -> String? { m.range(at: k).location == NSNotFound ? nil : ns.substring(with: m.range(at: k)) }
            let v = g(2) ?? g(3) ?? g(4) ?? ""
            attrs[g(1) ?? ""] = v.replacingOccurrences(of: "\\\\([\"'\\\\])", with: "$1", options: .regularExpression)
            rest = ns.substring(from: m.range.length)
        }
        var mods: [String] = []
        for p in pieces.dropFirst() {
            let m = p.trimmingCharacters(in: .whitespaces)
            guard modifierNames.contains(m) else { return nil }
            mods.append(m)
        }
        return (name, attrs, mods)
    }

    /// Index of the `}` closing a placeholder that starts at `from`; nil if none (quotes may contain braces).
    static func findClose(_ s: [Character], _ from: Int) -> Int? {
        var quote: Character?
        var i = from
        while i < s.count {
            let c = s[i]
            if let q = quote {
                if c == "\\" { i += 1 } else if c == q { quote = nil }
            } else if c == "\"" || c == "'" { quote = c } else if c == "{" || c == "\n" { return nil } else if c == "}" { return i }
            i += 1
        }
        return nil
    }

    public static func parse(_ template: String) -> [Token] {
        let s = Array(template)
        var tokens: [Token] = []
        var text = ""
        var i = 0
        while i < s.count {
            if s[i] == "{", let end = findClose(s, i + 1), let p = parseInner(String(s[(i + 1)..<end])) {
                if !text.isEmpty { tokens.append(.text(text)); text = "" }
                tokens.append(.placeholder(Placeholder(name: p.0, attrs: p.1, modifiers: p.2, raw: String(s[i...end]))))
                i = end + 1
                continue
            }
            text.append(s[i])
            i += 1
        }
        if !text.isEmpty { tokens.append(.text(text)) }
        return tokens
    }

    // MARK: arguments

    public struct ArgumentDef: Equatable, Sendable {
        public var name: String
        public var placeholder: String
        public var defaultValue: String?
        public var options: [String]?
        public var optional: Bool

        public var json: JSONValue {
            var o: [String: JSONValue] = ["name": .string(name), "placeholder": .string(placeholder), "optional": .bool(optional)]
            if let defaultValue { o["default"] = .string(defaultValue) }
            if let options { o["options"] = .array(options.map(JSONValue.string)) }
            return .object(o)
        }
    }

    static func splitOptions(_ s: String) -> [String] { s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }

    /// Arguments in order of first appearance; same-name placeholders share one; unnamed `{argument}`s are "argument", "argument 2", …
    public static func arguments(_ template: String) -> [ArgumentDef] { arguments(parse(template)) }
    public static func arguments(_ tokens: [Token]) -> [ArgumentDef] {
        var out: [ArgumentDef] = []
        var unnamed = 0
        for t in tokens {
            guard case let .placeholder(p) = t, p.name == "argument" || p.name == "query" else { continue }
            var name = p.name == "query" ? "query" : (p.attrs["name"]?.trimmingCharacters(in: .whitespaces) ?? "")
            if name.isEmpty { unnamed += 1; name = unnamed == 1 ? "argument" : "argument \(unnamed)" }
            let options = p.attrs["options"].map(splitOptions)
            if let idx = out.firstIndex(where: { $0.name == name }) {
                if out[idx].defaultValue == nil, let d = p.attrs["default"] { out[idx].defaultValue = d }
                if out[idx].options == nil, let o = options, !o.isEmpty { out[idx].options = o }
                continue
            }
            let ph = p.attrs["placeholder"]?.trimmingCharacters(in: .whitespaces)
            out.append(ArgumentDef(name: name, placeholder: (ph?.isEmpty == false ? ph! : (name == "query" ? "Query" : name)), defaultValue: p.attrs["default"],
                                   options: (options?.isEmpty == false) ? options : nil, optional: p.attrs["optional"] == "true" || p.attrs["default"] != nil))
        }
        return out
    }

    // MARK: rendering

    public struct Env {
        public var now: Date
        public var calendar: Calendar
        public var clipboard: String?
        public var selection: String?
        public var uuid: () -> String
        public var arguments: [String: String]
        public var snippet: ((String) -> String?)?
        public init(now: Date = Date(), calendar: Calendar = .current, clipboard: String? = nil, selection: String? = nil,
                    uuid: @escaping () -> String = { UUID().uuidString.lowercased() }, arguments: [String: String] = [:], snippet: ((String) -> String?)? = nil) {
            self.now = now
            self.calendar = calendar
            self.clipboard = clipboard
            self.selection = selection
            self.uuid = uuid
            self.arguments = arguments
            self.snippet = snippet
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

    static func escapeHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    static func jsonString(_ s: String) -> String {
        (try? String(decoding: JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes]), as: UTF8.self)).map { String($0.dropFirst().dropLast()) } ?? "\"\(s)\""
    }

    public static func applyModifiers(_ value: String, _ mods: [String]) -> String {
        var v = value
        for m in mods {
            switch m {
            case "uppercase": v = v.uppercased()
            case "lowercase": v = v.lowercased()
            case "trim": v = v.trimmingCharacters(in: .whitespacesAndNewlines)
            case "json-stringify": v = jsonString(v)
            case "percent-encode": v = QuicklinkURL.encodeComponent(v)
            default: break
            }
        }
        return v
    }

    static func baseValue(_ p: Placeholder, _ env: Env, _ counter: inout Int) -> String {
        switch p.name {
        case "query", "argument":
            var name = p.name == "query" ? "query" : (p.attrs["name"]?.trimmingCharacters(in: .whitespaces) ?? "")
            if name.isEmpty { counter += 1; name = counter == 1 ? "argument" : "argument \(counter)" }
            if let v = env.arguments[name], !v.isEmpty { return v }
            return p.attrs["default"] ?? ""
        case "clipboard": return env.clipboard ?? ""
        case "selection": return env.selection ?? ""
        case "uuid": return env.uuid()
        case "date", "time", "datetime", "day":
            let d = p.attrs["offset"].map { QLDates.applyOffset(env.now, $0, cal: env.calendar) } ?? env.now
            let fallback = p.name == "date" ? "yyyy-MM-dd" : p.name == "time" ? "HH:mm" : p.name == "day" ? "EEEE" : "yyyy-MM-dd HH:mm"
            let f = p.attrs["format"].flatMap { $0.isEmpty ? nil : $0 } ?? fallback
            return QLDates.format(d, f, cal: env.calendar)
        default: return ""
        }
    }

    static func atStart(_ tokens: [Token], _ index: Int) -> Bool {
        for t in tokens.prefix(index) {
            switch t {
            case let .text(s): if !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
            case .placeholder: return false
            }
        }
        return true
    }

    public static func render(_ tokens: [Token], env: Env, options: Options = Options(), depth: Int = 0, seen: Set<String> = []) -> String {
        var counter = 0
        var out = ""
        for (i, t) in tokens.enumerated() {
            guard case let .placeholder(p) = t else {
                if case let .text(s) = t { out += s }
                continue
            }
            if p.name == "cursor" { out += options.cursorMarker; continue }
            if p.name == "snippet" {
                let name = p.attrs["name"]?.trimmingCharacters(in: .whitespaces) ?? ""
                let key = name.lowercased()
                var value = ""
                if !name.isEmpty, depth < 5, !seen.contains(key), let body = env.snippet?(name) {
                    value = render(parse(body), env: env, options: Options(encode: options.encode, html: false, cursorMarker: ""), depth: depth + 1, seen: seen.union([key]))
                }
                value = applyModifiers(value, p.modifiers)
                out += options.html ? escapeHTML(value).replacingOccurrences(of: "\n", with: "<br>") : value
                continue
            }
            var value = applyModifiers(baseValue(p, env, &counter), p.modifiers.filter { $0 != "percent-encode" })
            let raw = p.attrs["raw"] == "true" || p.modifiers.contains("raw")
            let explicit = p.modifiers.contains("percent-encode") || p.attrs["encode"] == "true"
            if explicit || (options.encode && !raw && !atStart(tokens, i)) { value = QuicklinkURL.encodeComponent(value) }
            if options.html { value = escapeHTML(value) }
            out += value
        }
        return out
    }

    public static func render(_ template: String, env: Env, options: Options = Options()) -> String { render(parse(template), env: env, options: options) }

    public static func uses(_ template: String, _ name: String) -> Bool {
        parse(template).contains { if case let .placeholder(p) = $0 { return p.name == name }; return false }
    }

    public static func isDynamic(_ template: String) -> Bool {
        parse(template).contains { if case let .placeholder(p) = $0 { return !["cursor", "argument", "query"].contains(p.name) }; return false }
    }
}

/// `{date format=… offset=…}` support: Unicode/date-fns style tokens and "+1d 3h" offsets (port of quicklinks/dates.ts).
public enum QLDates {
    static let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    static let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    static let tokens = ["yyyy", "MMMM", "EEEE", "SSS", "MMM", "EEE", "yy", "MM", "dd", "HH", "hh", "mm", "ss", "ww", "M", "d", "H", "h", "m", "s", "a", "w", "Q", "X", "x"]

    static func isoWeek(_ d: Date, cal: Calendar) -> Int {
        var iso = Calendar(identifier: .iso8601)
        iso.timeZone = cal.timeZone
        return iso.component(.weekOfYear, from: d)
    }

    static func token(_ d: Date, _ tok: String, cal: Calendar) -> String? {
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond, .weekday], from: d)
        let y = c.year ?? 0, mo = (c.month ?? 1) - 1, h = c.hour ?? 0
        func p(_ n: Int, _ w: Int = 2) -> String { String(format: "%0\(w)d", n) }
        switch tok {
        case "yyyy": return String(y)
        case "yy": return p(y % 100)
        case "MMMM": return months[mo]
        case "MMM": return String(months[mo].prefix(3))
        case "MM": return p(mo + 1)
        case "M": return String(mo + 1)
        case "dd": return p(c.day ?? 1)
        case "d": return String(c.day ?? 1)
        case "EEEE": return days[(c.weekday ?? 1) - 1]
        case "EEE": return String(days[(c.weekday ?? 1) - 1].prefix(3))
        case "HH": return p(h)
        case "H": return String(h)
        case "hh": return p(h % 12 == 0 ? 12 : h % 12)
        case "h": return String(h % 12 == 0 ? 12 : h % 12)
        case "mm": return p(c.minute ?? 0)
        case "m": return String(c.minute ?? 0)
        case "ss": return p(c.second ?? 0)
        case "s": return String(c.second ?? 0)
        case "SSS": return p((c.nanosecond ?? 0) / 1_000_000, 3)
        case "a": return h < 12 ? "AM" : "PM"
        case "ww": return p(isoWeek(d, cal: cal))
        case "w": return String(isoWeek(d, cal: cal))
        case "Q": return String(mo / 3 + 1)
        case "X": return String(Int64(floor(d.timeIntervalSince1970)))
        case "x": return String(Int64(floor(d.timeIntervalSince1970 * 1000)))
        default: return nil
        }
    }

    /// Format with tokens like `yyyy-MM-dd HH:mm`; text in single quotes is literal (`''` is a quote).
    public static func format(_ d: Date, _ format: String, cal: Calendar) -> String {
        let f = Array(format)
        var out = ""
        var i = 0
        while i < f.count {
            if f[i] == "'" {
                if i + 1 < f.count && f[i + 1] == "'" { out += "'"; i += 2; continue }
                var j = i + 1
                while j < f.count {
                    if f[j] == "'" && j + 1 < f.count && f[j + 1] == "'" { out += "'"; j += 2 } else if f[j] == "'" { break } else { out.append(f[j]); j += 1 }
                }
                i = j + 1
                continue
            }
            let rest = String(f[i...])
            if let tok = tokens.first(where: { rest.hasPrefix($0) }), let v = token(d, tok, cal: cal) {
                out += v
                i += tok.count
            } else {
                out.append(f[i])
                i += 1
            }
        }
        return out
    }

    /// Offsets like "+1d", "-2w", "+1d 3h", "+1M", "-30m", "1y" (y M w d h m s). Unparseable → unchanged.
    public static func applyOffset(_ base: Date, _ offset: String, cal: Calendar) -> Date {
        guard let re = try? NSRegularExpression(pattern: "([+-])?\\s*(\\d+)\\s*(y|M|w|d|h|m|s)") else { return base }
        let ns = offset as NSString
        var d = base
        var sign = 1
        var any = false
        for m in re.matches(in: offset, range: NSRange(location: 0, length: ns.length)) {
            any = true
            if m.range(at: 1).location != NSNotFound { sign = ns.substring(with: m.range(at: 1)) == "-" ? -1 : 1 }
            let n = (Int(ns.substring(with: m.range(at: 2))) ?? 0) * sign
            switch ns.substring(with: m.range(at: 3)) {
            case "y": d = cal.date(byAdding: .year, value: n, to: d) ?? d
            case "M": d = cal.date(byAdding: .month, value: n, to: d) ?? d // Foundation clamps Jan 31 + 1M to Feb 28/29
            case "w": d = cal.date(byAdding: .day, value: 7 * n, to: d) ?? d
            case "d": d = cal.date(byAdding: .day, value: n, to: d) ?? d
            case "h": d = cal.date(byAdding: .hour, value: n, to: d) ?? d
            case "m": d = cal.date(byAdding: .minute, value: n, to: d) ?? d
            default: d = cal.date(byAdding: .second, value: n, to: d) ?? d
            }
        }
        return any ? d : base
    }
}
