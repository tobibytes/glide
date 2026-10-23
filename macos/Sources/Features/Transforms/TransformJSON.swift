import Foundation

/// Order-preserving JSON value with JS `JSON.parse` / `JSON.stringify` semantics (key order kept, numbers
/// printed like JS `Number#toString`), so "JSON Pretty Print" output matches the Electron app byte for byte.
indirect enum TransformJSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([TransformJSON])
    case object([(String, TransformJSON)])

    static func == (a: TransformJSON, b: TransformJSON) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case let (.bool(x), .bool(y)): return x == y
        case let (.number(x), .number(y)): return x == y
        case let (.string(x), .string(y)): return x == y
        case let (.array(x), .array(y)): return x == y
        case let (.object(x), .object(y)): return x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }

    struct ParseError: Error, CustomStringConvertible {
        let description: String
    }

    // MARK: parse

    static func parse(_ text: String) throws -> TransformJSON {
        var p = Parser(Array(text.utf16))
        p.skipWS()
        let v = try p.value(depth: 0)
        p.skipWS()
        if p.i < p.s.count { throw p.unexpected() }
        return v
    }

    private struct Parser {
        let s: [UInt16]
        var i = 0
        init(_ s: [UInt16]) { self.s = s }

        mutating func skipWS() {
            while i < s.count, [0x20, 0x09, 0x0A, 0x0D].contains(s[i]) { i += 1 }
        }

        func unexpected() -> ParseError {
            if i >= s.count { return ParseError(description: "Unexpected end of JSON input") }
            let ch = String(utf16CodeUnits: [s[i]], count: 1)
            return ParseError(description: "Unexpected token '\(ch)' at position \(i)")
        }

        mutating func value(depth: Int) throws -> TransformJSON {
            guard depth < 512 else { throw ParseError(description: "Nesting too deep") }
            guard i < s.count else { throw unexpected() }
            switch s[i] {
            case 0x7B: return try object(depth)
            case 0x5B: return try array(depth)
            case 0x22: return .string(try string())
            case 0x74: try literal("true"); return .bool(true)
            case 0x66: try literal("false"); return .bool(false)
            case 0x6E: try literal("null"); return .null
            case 0x2D, 0x30...0x39: return .number(try number())
            default: throw unexpected()
            }
        }

        mutating func literal(_ word: String) throws {
            for u in word.utf16 {
                guard i < s.count, s[i] == u else { throw unexpected() }
                i += 1
            }
        }

        mutating func number() throws -> Double {
            let start = i
            if s[i] == 0x2D { i += 1 }
            guard i < s.count, (0x30...0x39).contains(s[i]) else { throw unexpected() }
            if s[i] == 0x30 { i += 1 } else { while i < s.count, (0x30...0x39).contains(s[i]) { i += 1 } }
            if i < s.count, s[i] == 0x2E {
                i += 1
                guard i < s.count, (0x30...0x39).contains(s[i]) else { throw unexpected() }
                while i < s.count, (0x30...0x39).contains(s[i]) { i += 1 }
            }
            if i < s.count, s[i] == 0x65 || s[i] == 0x45 {
                i += 1
                if i < s.count, s[i] == 0x2B || s[i] == 0x2D { i += 1 }
                guard i < s.count, (0x30...0x39).contains(s[i]) else { throw unexpected() }
                while i < s.count, (0x30...0x39).contains(s[i]) { i += 1 }
            }
            let text = String(utf16CodeUnits: Array(s[start..<i]), count: i - start)
            guard let d = Double(text) else { throw ParseError(description: "Bad number at position \(start)") }
            return d
        }

        mutating func string() throws -> String {
            i += 1 // opening quote
            var units: [UInt16] = []
            while true {
                guard i < s.count else { throw ParseError(description: "Unterminated string in JSON at position \(i)") }
                let c = s[i]
                if c == 0x22 { i += 1; break }
                if c < 0x20 { throw ParseError(description: "Bad control character in string literal at position \(i)") }
                if c == 0x5C {
                    i += 1
                    guard i < s.count else { throw unexpected() }
                    switch s[i] {
                    case 0x22: units.append(0x22)
                    case 0x5C: units.append(0x5C)
                    case 0x2F: units.append(0x2F)
                    case 0x62: units.append(0x08)
                    case 0x66: units.append(0x0C)
                    case 0x6E: units.append(0x0A)
                    case 0x72: units.append(0x0D)
                    case 0x74: units.append(0x09)
                    case 0x75:
                        guard i + 4 < s.count, let v = UInt16(String(utf16CodeUnits: Array(s[(i + 1)...(i + 4)]), count: 4), radix: 16) else {
                            throw ParseError(description: "Bad Unicode escape in JSON at position \(i)")
                        }
                        units.append(v)
                        i += 4
                    default: throw ParseError(description: "Bad escaped character in JSON at position \(i)")
                    }
                    i += 1
                    continue
                }
                units.append(c)
                i += 1
            }
            return String(utf16CodeUnits: units, count: units.count)
        }

        mutating func array(_ depth: Int) throws -> TransformJSON {
            i += 1
            var out: [TransformJSON] = []
            skipWS()
            if i < s.count, s[i] == 0x5D { i += 1; return .array(out) }
            while true {
                skipWS()
                out.append(try value(depth: depth + 1))
                skipWS()
                guard i < s.count else { throw unexpected() }
                if s[i] == 0x2C { i += 1; continue }
                if s[i] == 0x5D { i += 1; return .array(out) }
                throw unexpected()
            }
        }

        mutating func object(_ depth: Int) throws -> TransformJSON {
            i += 1
            var out: [(String, TransformJSON)] = []
            skipWS()
            if i < s.count, s[i] == 0x7D { i += 1; return .object(out) }
            while true {
                skipWS()
                guard i < s.count, s[i] == 0x22 else { throw unexpected() }
                let key = try string()
                skipWS()
                guard i < s.count, s[i] == 0x3A else { throw unexpected() }
                i += 1
                skipWS()
                let v = try value(depth: depth + 1)
                // JSON.parse: a duplicate key keeps its first position and takes the last value.
                if let idx = out.firstIndex(where: { $0.0 == key }) { out[idx].1 = v } else { out.append((key, v)) }
                skipWS()
                guard i < s.count else { throw unexpected() }
                if s[i] == 0x2C { i += 1; continue }
                if s[i] == 0x7D { i += 1; return .object(out) }
                throw unexpected()
            }
        }
    }

    // MARK: stringify

    /// `JSON.stringify(value, null, indent)` (indent 0 = compact).
    func stringify(indent: Int = 0) -> String {
        var out = ""
        write(&out, indent: indent, level: 0)
        return out
    }

    private func write(_ out: inout String, indent: Int, level: Int) {
        let pad = indent > 0 ? "\n" + String(repeating: " ", count: indent * (level + 1)) : ""
        let close = indent > 0 ? "\n" + String(repeating: " ", count: indent * level) : ""
        switch self {
        case .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .number(d): out += Self.jsNumber(d)
        case let .string(s): out += Self.quote(s)
        case let .array(a):
            if a.isEmpty { out += "[]"; return }
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                out += pad
                v.write(&out, indent: indent, level: level + 1)
            }
            out += close + "]"
        case let .object(o):
            if o.isEmpty { out += "{}"; return }
            out += "{"
            for (i, kv) in o.enumerated() {
                if i > 0 { out += "," }
                out += pad + Self.quote(kv.0) + (indent > 0 ? ": " : ":")
                kv.1.write(&out, indent: indent, level: level + 1)
            }
            out += close + "}"
        }
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }

    /// JS Number#toString for finite doubles (JSON has no NaN/Infinity: those print as null).
    static func jsNumber(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == 0 { return "0" }
        if d == d.rounded(), abs(d) < 1e21 {
            return String(format: "%.0f", d)
        }
        // Swift's description is the shortest round-trip repr ("0.1", "1e-07", "1.5e+300"); adapt the exponent.
        var s = "\(d)"
        if let e = s.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            let mantissa = String(s[..<e])
            var exp = String(s[s.index(after: e)...])
            var sign = "+"
            if exp.hasPrefix("-") { sign = "-"; exp.removeFirst() } else if exp.hasPrefix("+") { exp.removeFirst() }
            while exp.count > 1 && exp.hasPrefix("0") { exp.removeFirst() }
            let expValue = (Int(exp) ?? 0) * (sign == "-" ? -1 : 1)
            // JS uses plain notation for 1e-7 < |d| < 1e21.
            if expValue >= -6 && expValue < 21 {
                return plain(d)
            }
            let m = mantissa.hasSuffix(".0") ? String(mantissa.dropLast(2)) : mantissa
            s = "\(m)e\(sign)\(exp)"
            return s
        }
        if s.hasSuffix(".0") { s.removeLast(2) }
        return s
    }

    private static func plain(_ d: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.usesGroupingSeparator = false
        f.maximumFractionDigits = 20
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: NSNumber(value: d)) ?? "\(d)"
    }

    // MARK: inspection

    var kindDescription: String {
        switch self {
        case let .array(a): return "array of \(a.count)"
        case .null: return "null"
        case let .object(o): return "object with \(o.count) keys"
        case .number: return "number"
        case .string: return "string"
        case .bool: return "boolean"
        }
    }

    subscript(key: String) -> TransformJSON? {
        if case let .object(o) = self { return o.first { $0.0 == key }?.1 }
        return nil
    }
}
