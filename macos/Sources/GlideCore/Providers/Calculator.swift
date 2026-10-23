import Foundation

/// Port of src/main/sources/calculator.ts: + − × ÷ ^ (right-assoc), parentheses, %, "x of y", mod,
/// sqrt/abs/round/floor/ceil/sin/cos/tan/ln/log/exp, pi/e. A bare number is not a calculation.
public enum Calculator {
    public static let score: Double = 1000

    enum Tok: Equatable { case num(Double), op(Character), ident(String), pct }

    static let functions: [String: @Sendable (Double) -> Double] = [
        "sqrt": { $0.squareRoot() }, "abs": { Swift.abs($0) }, "round": { ($0 + 0.5).rounded(.down) }, "floor": { Foundation.floor($0) },
        "ceil": { Foundation.ceil($0) }, "sin": { Foundation.sin($0) }, "cos": { Foundation.cos($0) }, "tan": { Foundation.tan($0) },
        "ln": { Foundation.log($0) }, "log": { Foundation.log10($0) }, "exp": { Foundation.exp($0) },
    ]
    static let constants: [String: Double] = ["pi": Double.pi, "e": M_E]

    static func tokenize(_ src: String) -> [Tok]? {
        var s = src.replacingOccurrences(of: "×", with: "*").replacingOccurrences(of: "÷", with: "/").replacingOccurrences(of: ",", with: "")
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let chars = Array(s)
        var out: [Tok] = []
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == " " { i += 1; continue }
            if c.isASCII && (c.isNumber || c == ".") {
                let rest = String(chars[i...])
                guard let r = rest.range(of: "^(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?", options: .regularExpression) else { return nil }
                let lit = String(rest[r])
                guard let v = Double(lit) else { return nil }
                out.append(.num(v))
                i += lit.count
                continue
            }
            if "+-*/^()".contains(c) { out.append(.op(c)); i += 1; continue }
            if c == "%" {
                let next = String(chars[(i + 1)...]).drop { $0 == " " }
                var isModulo = false
                if case .num = out.last, let f = next.first, f.isNumber || f == "." || f == "(", i + 1 < chars.count, chars[i + 1] == " " { isModulo = true }
                out.append(isModulo ? .op("%") : .pct)
                i += 1
                continue
            }
            if c.isASCII && c.isLetter {
                var j = i
                while j < chars.count && chars[j].isASCII && chars[j].isLetter { j += 1 }
                let word = String(chars[i..<j]).lowercased()
                if word == "x" { out.append(.op("*")) }
                else if word == "mod" { out.append(.op("%")) }
                else if word == "of" { out.append(.ident("of")) }
                else if functions[word] != nil || constants[word] != nil { out.append(.ident(word)) }
                else { return nil }
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
        func parse() -> Double? {
            guard let v = additive(), pos == toks.count else { return nil }
            return v.plain
        }
        var peek: Tok? { pos < toks.count ? toks[pos] : nil }
        func isOp(_ c: Character) -> Bool { if case let .op(o) = peek { return o == c }; return false }

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
        func multiplicative() -> Value? {
            guard var left = power() else { return nil }
            while true {
                if case .ident("of") = peek {
                    pos += 1
                    guard let right = power() else { return nil }
                    left = Value(n: left.plain * right.plain, pct: false)
                    continue
                }
                guard isOp("*") || isOp("/") || isOp("%"), case let .op(op) = toks[pos] else { break }
                pos += 1
                guard let right = power() else { return nil }
                let l = left.plain, r = right.plain
                left = Value(n: op == "*" ? l * r : op == "/" ? l / r : fmod(l, r), pct: false)
            }
            return left
        }
        func power() -> Value? {
            guard let base = unary() else { return nil }
            if isOp("^") {
                pos += 1
                guard let e = power() else { return nil }
                return Value(n: pow(base.plain, e.plain), pct: false)
            }
            return base
        }
        func unary() -> Value? {
            if isOp("-") { pos += 1; return unary().map { Value(n: -$0.n, pct: $0.pct) } }
            if isOp("+") { pos += 1; return unary() }
            return postfix()
        }
        func postfix() -> Value? {
            guard let v = primary() else { return nil }
            if peek == .pct {
                pos += 1
                return Value(n: v.n, pct: true)
            }
            return v
        }
        func primary() -> Value? {
            guard let t = peek else { return nil }
            switch t {
            case let .num(v):
                pos += 1
                return Value(n: v, pct: false)
            case .op("("):
                pos += 1
                guard let inner = additive(), isOp(")") else { return nil }
                pos += 1
                return Value(n: inner.plain, pct: false)
            case let .ident(name):
                if let c = Calculator.constants[name] { pos += 1; return Value(n: c, pct: false) }
                if let f = Calculator.functions[name] {
                    pos += 1
                    guard isOp("(") else { return nil }
                    pos += 1
                    guard let arg = additive(), isOp(")") else { return nil }
                    pos += 1
                    return Value(n: f(arg.plain), pct: false)
                }
                return nil
            default:
                return nil
            }
        }
    }

    /// The value of an arithmetic query, or nil when the text is not maths.
    public static func evaluate(_ query: String) -> Double? {
        var src = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = src.range(of: "^=\\s*", options: .regularExpression) { src.removeSubrange(r) }
        guard !src.isEmpty, src.contains(where: { $0.isASCII && $0.isNumber }) else { return nil }
        guard let toks = tokenize(src) else { return nil }
        let hasOperation = toks.contains { if case .num = $0 { return false }; return true }
        guard hasOperation, let result = Parser(toks).parse(), !result.isNaN else { return nil }
        return result
    }

    /// JS-like compact formatting (formatNumber in calculator.ts).
    public static func format(_ n: Double) -> String {
        if !n.isFinite { return n > 0 ? "∞" : n < 0 ? "-∞" : "NaN" }
        if n == n.rounded(), Swift.abs(n) < 1e15 { return String(Int64(n)) }
        let rounded = Double(String(format: "%.12g", n)) ?? n
        if Swift.abs(rounded) >= 1e15 || (Swift.abs(rounded) < 1e-6 && rounded != 0) {
            // toExponential(6): "1.234568e+20"
            let s = String(format: "%.6e", rounded) // 1.234568e+20
            return s.replacingOccurrences(of: "e+0", with: "e+").replacingOccurrences(of: "e-0", with: "e-")
        }
        if rounded == rounded.rounded() { return String(Int64(rounded)) }
        var s = String(format: "%.12g", rounded)
        if s.contains("e") { s = String(rounded) }
        return s
    }

    public static func items(for query: String) -> [ScoredItem] {
        guard let value = evaluate(query) else { return [] }
        let text = format(value)
        let item = SearchItem(id: "calculator:\(query.trimmingCharacters(in: .whitespacesAndNewlines))", kind: .calculator, title: "= \(text)",
                              subtitle: "Press Enter to copy", icon: .symbol("equal.square.fill"), text: text, source: "calculator")
        return [ScoredItem(item: item, score: score, matchScore: score, matchKind: .exact, frecency: 0, ranges: [])]
    }
}
