import Foundation
import GlideCore

/// The full inline calculator: a superset of `GlideCore.Calculator` (src/main/sources/calculator.ts semantics for
/// %, "x of y", mod) adding hex/binary/octal literals and output ("255 in hex", "0b1010 + 3", "0xff to bin"),
/// bitwise operators (& | xor << >>), factorial, `**`, implicit multiplication ("2pi", "3(4+5)"), degrees
/// ("sin(30°)"), multi-argument functions (min, max, pow, hypot, atan2, gcd, lcm, root, log(x, base), round(x, n))
/// and constants (pi/π, e, tau/τ, phi/φ).
public enum CalcEngine {
    public enum Radix: String, Sendable { case dec, hex, bin, oct }

    public struct Result: Sendable, Equatable {
        public var value: Double
        /// Requested output base ("… in hex").
        public var radix: Radix
        /// The text copied by ⏎ / pasted by ⌘⏎.
        public var text: String
        /// Other representations: [(label, text)].
        public var alternatives: [Alternative]
    }

    public struct Alternative: Sendable, Equatable {
        public var id: String
        public var label: String
        public var text: String
    }

    enum Tok: Equatable {
        case num(Double, based: Bool)
        case op(String)
        case ident(String)
        case pct
        case comma
        case bang
        case degree
    }

    static let unary: [String: @Sendable (Double) -> Double] = [
        "sqrt": { $0.squareRoot() }, "cbrt": { Foundation.cbrt($0) }, "abs": { Swift.abs($0) }, "floor": { Foundation.floor($0) }, "ceil": { Foundation.ceil($0) },
        "trunc": { Foundation.trunc($0) }, "sign": { $0 > 0 ? 1 : $0 < 0 ? -1 : 0 },
        "sin": { Foundation.sin($0) }, "cos": { Foundation.cos($0) }, "tan": { Foundation.tan($0) },
        "asin": { Foundation.asin($0) }, "acos": { Foundation.acos($0) }, "atan": { Foundation.atan($0) },
        "sinh": { Foundation.sinh($0) }, "cosh": { Foundation.cosh($0) }, "tanh": { Foundation.tanh($0) },
        "ln": { Foundation.log($0) }, "log2": { Foundation.log2($0) }, "log10": { Foundation.log10($0) }, "exp": { Foundation.exp($0) },
        "fact": { factorial($0) }, "deg": { $0 * 180 / Double.pi }, "rad": { $0 * Double.pi / 180 },
    ]
    /// Functions taking a variable number of arguments.
    static let multi: Set<String> = ["min", "max", "pow", "hypot", "atan2", "gcd", "lcm", "root", "log", "round"]
    static let constants: [String: Double] = ["pi": Double.pi, "π": Double.pi, "e": M_E, "tau": 2 * Double.pi, "τ": 2 * Double.pi, "phi": (1 + 5.0.squareRoot()) / 2, "φ": (1 + 5.0.squareRoot()) / 2]

    static func factorial(_ x: Double) -> Double {
        guard x >= 0, x == x.rounded(), x <= 170 else { return x == x.rounded() && x > 170 ? .infinity : Foundation.tgamma(x + 1) }
        var r = 1.0
        var i = 2.0
        while i <= x { r *= i; i += 1 }
        return r
    }

    static func gcd(_ a: Double, _ b: Double) -> Double {
        var x = Swift.abs(a.rounded()), y = Swift.abs(b.rounded())
        while y > 0 { (x, y) = (y, x.truncatingRemainder(dividingBy: y)) }
        return x
    }

    static func callMulti(_ name: String, _ args: [Double]) -> Double? {
        switch (name, args.count) {
        case ("min", 1...): return args.min()
        case ("max", 1...): return args.max()
        case ("pow", 2): return Foundation.pow(args[0], args[1])
        case ("hypot", 1...): return args.reduce(0) { $0 + $1 * $1 }.squareRoot()
        case ("atan2", 2): return Foundation.atan2(args[0], args[1])
        case ("gcd", 1...): return args.dropFirst().reduce(args[0]) { gcd($0, $1) }
        case ("lcm", 1...): return args.dropFirst().reduce(args[0]) { a, b in let g = gcd(a, b); return g == 0 ? 0 : Swift.abs(a.rounded() * b.rounded()) / g }
        case ("root", 2): return args[0] < 0 && args[1].truncatingRemainder(dividingBy: 2) == 1 ? -Foundation.pow(-args[0], 1 / args[1]) : Foundation.pow(args[0], 1 / args[1])
        case ("log", 1): return Foundation.log10(args[0])
        case ("log", 2): return Foundation.log(args[0]) / Foundation.log(args[1])
        // JS Math.round: half up.
        case ("round", 1): return (args[0] + 0.5).rounded(.down)
        case ("round", 2):
            let p = Foundation.pow(10, args[1].rounded())
            return ((args[0] * p) + 0.5).rounded(.down) / p
        default: return nil
        }
    }

    static func tokenize(_ src: String) -> [Tok]? {
        var s = src.replacingOccurrences(of: "×", with: "*").replacingOccurrences(of: "÷", with: "/").replacingOccurrences(of: "−", with: "-")
        // Thousands separators ("1,000,000") — but keep commas that separate function arguments.
        s = s.replacingOccurrences(of: "(?<=\\d),(?=\\d{3}(?!\\d))", with: "", options: .regularExpression)
        let chars = Array(s)
        var out: [Tok] = []
        var i = 0
        func peekNonSpace(_ from: Int) -> Character? {
            var j = from
            while j < chars.count && chars[j] == " " { j += 1 }
            return j < chars.count ? chars[j] : nil
        }
        while i < chars.count {
            let c = chars[i]
            if c.isWhitespace { i += 1; continue }
            if c == "0", i + 1 < chars.count, "xXbBoO".contains(chars[i + 1]) {
                let radix: Int
                switch chars[i + 1].lowercased() { case "x": radix = 16; case "b": radix = 2; default: radix = 8 }
                var j = i + 2
                var digits = ""
                while j < chars.count, chars[j].isHexDigit || chars[j] == "_" {
                    if chars[j] != "_" { digits.append(chars[j]) }
                    j += 1
                }
                guard !digits.isEmpty, let v = UInt64(digits, radix: radix) else { return nil }
                out.append(.num(Double(v), based: true))
                i = j
                continue
            }
            if c.isASCII && (c.isNumber || c == ".") {
                let rest = String(chars[i...])
                guard let r = rest.range(of: "^(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?", options: .regularExpression), let v = Double(rest[r]) else { return nil }
                out.append(.num(v, based: false))
                i += rest[r].count
                continue
            }
            if c == "*" && i + 1 < chars.count && chars[i + 1] == "*" { out.append(.op("^")); i += 2; continue }
            if (c == "<" || c == ">") && i + 1 < chars.count && chars[i + 1] == c { out.append(.op(String([c, c]))); i += 2; continue }
            if "+-*/^()&|".contains(c) { out.append(.op(String(c))); i += 1; continue }
            if c == "," { out.append(.comma); i += 1; continue }
            if c == "°" { out.append(.degree); i += 1; continue }
            if c == "!" { out.append(.bang); i += 1; continue }
            if c == "%" {
                var isModulo = false
                if case .num = out.last, let f = peekNonSpace(i + 1), f.isNumber || f == "." || f == "(", i + 1 < chars.count, chars[i + 1] == " " { isModulo = true }
                out.append(isModulo ? .op("%") : .pct)
                i += 1
                continue
            }
            if c.isLetter {
                var j = i
                while j < chars.count && (chars[j].isLetter || (j > i && chars[j].isNumber)) { j += 1 }
                let word = String(chars[i..<j]).lowercased()
                switch word {
                case "x": out.append(.op("*"))
                case "mod": out.append(.op("%"))
                case "xor": out.append(.op("xor"))
                case "and": out.append(.op("&"))
                case "or": out.append(.op("|"))
                case "of": out.append(.ident("of"))
                default:
                    guard unary[word] != nil || multi.contains(word) || constants[word] != nil else { return nil }
                    out.append(.ident(word))
                }
                i = j
                continue
            }
            return nil
        }
        return out
    }

    struct Value { var n: Double; var pct: Bool; var plain: Double { pct ? n / 100 : n } }

    final class Parser {
        let toks: [Tok]
        var pos = 0
        init(_ t: [Tok]) { toks = t }
        var peek: Tok? { pos < toks.count ? toks[pos] : nil }
        func isOp(_ o: String) -> Bool { if case let .op(x) = peek { return x == o }; return false }

        func parse() -> Double? {
            guard let v = bitOr(), pos == toks.count else { return nil }
            return v.plain
        }

        static func int(_ d: Double) -> Int64? { d.isFinite && Swift.abs(d) < 9.2e18 ? Int64(d.rounded(.towardZero)) : nil }

        func binary(_ ops: [String], _ next: () -> Value?, _ f: (String, Double, Double) -> Double?) -> Value? {
            guard var left = next() else { return nil }
            while case let .op(o) = peek, ops.contains(o) {
                pos += 1
                guard let right = next(), let r = f(o, left.plain, right.plain) else { return nil }
                left = Value(n: r, pct: false)
            }
            return left
        }

        func bitOr() -> Value? {
            binary(["|"], bitXor) { _, a, b in guard let x = Parser.int(a), let y = Parser.int(b) else { return nil }; return Double(x | y) }
        }
        func bitXor() -> Value? {
            binary(["xor"], bitAnd) { _, a, b in guard let x = Parser.int(a), let y = Parser.int(b) else { return nil }; return Double(x ^ y) }
        }
        func bitAnd() -> Value? {
            binary(["&"], shift) { _, a, b in guard let x = Parser.int(a), let y = Parser.int(b) else { return nil }; return Double(x & y) }
        }
        func shift() -> Value? {
            binary(["<<", ">>"], additive) { o, a, b in
                guard let x = Parser.int(a), let y = Parser.int(b), y >= 0, y < 63 else { return nil }
                return Double(o == "<<" ? x << y : x >> y)
            }
        }

        func additive() -> Value? {
            guard var left = multiplicative() else { return nil }
            while isOp("+") || isOp("-") {
                guard case let .op(op) = toks[pos] else { return nil }
                pos += 1
                guard let right = multiplicative() else { return nil }
                let l = left.plain
                let r = right.pct ? l * (right.n / 100) : right.n
                left = Value(n: op == "+" ? l + r : l - r, pct: false)
            }
            return left
        }

        /// Starts an operand (for implicit multiplication: "2pi", "3(4+5)", "2 sqrt(4)").
        var startsOperand: Bool {
            switch peek {
            case .num: return true
            case let .ident(n): return n != "of"
            case .op("("): return true
            default: return false
            }
        }

        func multiplicative() -> Value? {
            guard var left = unaryMinus() else { return nil }
            while true {
                if case .ident("of") = peek {
                    pos += 1
                    guard let right = unaryMinus() else { return nil }
                    left = Value(n: left.plain * right.plain, pct: false)
                    continue
                }
                if isOp("*") || isOp("/") || isOp("%"), case let .op(op) = toks[pos] {
                    pos += 1
                    guard let right = unaryMinus() else { return nil }
                    let l = left.plain, r = right.plain
                    left = Value(n: op == "*" ? l * r : op == "/" ? l / r : fmod(l, r), pct: false)
                    continue
                }
                if startsOperand {
                    guard let right = power() else { return nil }
                    left = Value(n: left.plain * right.plain, pct: false)
                    continue
                }
                break
            }
            return left
        }

        func unaryMinus() -> Value? {
            if isOp("-") { pos += 1; return unaryMinus().map { Value(n: -$0.n, pct: $0.pct) } }
            if isOp("+") { pos += 1; return unaryMinus() }
            return power()
        }

        func power() -> Value? {
            guard let base = postfix() else { return nil }
            if isOp("^") {
                pos += 1
                guard let e = unaryMinus() else { return nil }
                return Value(n: Foundation.pow(base.plain, e.plain), pct: false)
            }
            return base
        }

        func postfix() -> Value? {
            guard var v = primary() else { return nil }
            while true {
                switch peek {
                case .pct: pos += 1; v = Value(n: v.n, pct: true)
                case .bang: pos += 1; v = Value(n: CalcEngine.factorial(v.plain), pct: false)
                case .degree: pos += 1; v = Value(n: v.plain * Double.pi / 180, pct: false)
                default: return v
                }
            }
        }

        func primary() -> Value? {
            guard let t = peek else { return nil }
            switch t {
            case let .num(v, _):
                pos += 1
                return Value(n: v, pct: false)
            case .op("("):
                pos += 1
                guard let inner = bitOr(), isOp(")") else { return nil }
                pos += 1
                return Value(n: inner.plain, pct: false)
            case let .ident(name):
                if let c = CalcEngine.constants[name] { pos += 1; return Value(n: c, pct: false) }
                pos += 1
                guard isOp("(") else {
                    // "sqrt 16", "sin 30°": a function applied to the next factor.
                    guard let f = CalcEngine.unary[name], let arg = postfix() else { return nil }
                    return Value(n: f(arg.plain), pct: false)
                }
                pos += 1
                var args: [Double] = []
                if !isOp(")") {
                    while true {
                        guard let a = bitOr() else { return nil }
                        args.append(a.plain)
                        if peek == .comma { pos += 1; continue }
                        break
                    }
                }
                guard isOp(")") else { return nil }
                pos += 1
                if CalcEngine.multi.contains(name) { return CalcEngine.callMulti(name, args).map { Value(n: $0, pct: false) } }
                guard args.count == 1, let f = CalcEngine.unary[name] else { return nil }
                return Value(n: f(args[0]), pct: false)
            default:
                return nil
            }
        }
    }

    /// Strip a trailing "in hex" / "to binary" / "as oct" / "= dec".
    static func splitRadix(_ q: String) -> (String, Radix?) {
        let pattern = "^(.*?)\\s+(?:in|to|as|=)\\s+(hex|hexadecimal|bin|binary|oct|octal|dec|decimal)$"
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: q, range: NSRange(location: 0, length: (q as NSString).length)) else { return (q, nil) }
        let ns = q as NSString
        let word = ns.substring(with: m.range(at: 2)).lowercased()
        let radix: Radix = word.hasPrefix("hex") ? .hex : word.hasPrefix("bin") ? .bin : word.hasPrefix("oct") ? .oct : .dec
        return (ns.substring(with: m.range(at: 1)), radix)
    }

    /// The value of a query, or nil when it is not maths. A bare decimal number is not a calculation.
    public static func evaluate(_ query: String) -> (value: Double, radix: Radix?)? {
        var src = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = src.range(of: "^=\\s*", options: .regularExpression) { src.removeSubrange(r) }
        let (expr, radix) = splitRadix(src)
        guard !expr.isEmpty, expr.contains(where: { $0.isNumber }) || constants.keys.contains(where: { expr.lowercased().contains($0) }) else { return nil }
        guard let toks = tokenize(expr), !toks.isEmpty else { return nil }
        let hasOperation = toks.contains { t in
            switch t {
            case .num(_, let based): return based
            default: return true
            }
        }
        guard hasOperation || radix != nil, let v = Parser(toks).parse(), !v.isNaN else { return nil }
        return (v, radix)
    }

    static func based(_ v: Double, _ radix: Radix) -> String? {
        guard v.isFinite, v == v.rounded(), Swift.abs(v) < 9.2e18 else { return nil }
        let i = Int64(v)
        let neg = i < 0
        let mag = i.magnitude
        switch radix {
        case .hex: return (neg ? "-" : "") + "0x" + String(mag, radix: 16).uppercased()
        case .bin: return (neg ? "-" : "") + "0b" + String(mag, radix: 2)
        case .oct: return (neg ? "-" : "") + "0o" + String(mag, radix: 8)
        case .dec: return String(i)
        }
    }

    public static func compute(_ query: String) -> Result? {
        guard let (v, radix) = evaluate(query) else { return nil }
        let r = radix ?? .dec
        let dec = Calculator.format(v)
        let text = r == .dec ? dec : (based(v, r) ?? dec)
        var alts: [Alternative] = []
        if r != .dec { alts.append(Alternative(id: "dec", label: "Decimal", text: dec)) }
        for (rad, label) in [(Radix.hex, "Hex"), (.bin, "Binary"), (.oct, "Octal")] where rad != r {
            if let b = based(v, rad), Swift.abs(v) >= 2 || rad == .hex { alts.append(Alternative(id: rad.rawValue, label: label, text: b)) }
        }
        if v.isFinite && v != v.rounded() { alts.append(Alternative(id: "sci", label: "Scientific", text: String(format: "%.6e", v))) }
        return Result(value: v, radix: r, text: text, alternatives: alts)
    }

    public static func items(for query: String, featureId: String) -> [ScoredItem] {
        guard let r = compute(query) else { return [] }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = r.alternatives.prefix(3).map { "\($0.label) \($0.text)" }.joined(separator: " · ")
        var data: [String: JSONValue] = ["noUsage": true, "copy": .string(r.text)]
        data["more"] = .array(r.alternatives.map { ["id": .string($0.id), "title": .string("Copy \($0.label) (\($0.text))"), "text": .string($0.text)] })
        let item = SearchItem(id: "calculator:\(q)", kind: .calculator, title: "= \(r.text)", subtitle: subtitle.isEmpty ? "Press Enter to copy, ⌘Enter to paste" : subtitle,
                              icon: .symbol("equal.square.fill"), text: r.text, source: "calculator", feature: featureId, data: data)
        return [ScoredItem(item: item, score: Calculator.score, matchScore: Calculator.score, matchKind: .exact)]
    }
}
