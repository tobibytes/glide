import Foundation

/// Number formatting shared by every converter (port of src/main/features/convert/format.ts): compact,
/// locale-independent, copy-friendly.
public enum ConvertFormat {
    /// Round to `sig` significant digits without float noise (JS `Number(n.toPrecision(sig))`).
    public static func roundSig(_ n: Double, _ sig: Int = 6) -> Double {
        guard n.isFinite, n != 0 else { return n }
        return Double(String(format: "%.\(max(1, sig))g", n)) ?? n
    }

    /// "3106.86" style: no grouping, up to `sig` significant digits; exponent form outside [1e-6, 1e15).
    public static func plainNumber(_ n: Double, _ sig: Int = 6) -> String {
        if !n.isFinite { return n > 0 ? "∞" : n < 0 ? "-∞" : "NaN" }
        let r = roundSig(n, sig)
        let a = abs(r)
        if a != 0 && (a >= 1e15 || a < 1e-6) { return exponential(r, digits: max(0, sig - 1)) }
        return fixedTrimmed(r, sig: sig)
    }

    /// "1,234,567.89" for display.
    public static func groupedNumber(_ n: Double, _ sig: Int = 6) -> String {
        let plain = plainNumber(n, sig)
        if plain.lowercased().contains("e") || !n.isFinite { return plain }
        return group(plain)
    }

    /// Insert thousands separators into a plain decimal string ("-1234.5" → "-1,234.5").
    static func group(_ plain: String) -> String {
        var s = plain
        var neg = false
        if s.hasPrefix("-") { neg = true; s.removeFirst() }
        let parts = s.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let int = Array(parts.first.map(String.init) ?? "")
        var out = ""
        for (i, c) in int.enumerated() {
            if i > 0 && (int.count - i) % 3 == 0 { out.append(",") }
            out.append(c)
        }
        if parts.count > 1 { out += "." + parts[1] }
        return (neg ? "-" : "") + out
    }

    /// JS `toExponential(digits).replace(/\.?0+e/, "e")`: "1e-9", "1.23457e+20".
    static func exponential(_ n: Double, digits: Int) -> String {
        let s = String(format: "%.\(digits)e", n) // 1.234570e+20 / 1.000000e-09
        guard let eIdx = s.firstIndex(of: "e") else { return s }
        var mantissa = String(s[..<eIdx])
        var exp = String(s[s.index(after: eIdx)...])
        if mantissa.contains(".") {
            while mantissa.hasSuffix("0") { mantissa.removeLast() }
            if mantissa.hasSuffix(".") { mantissa.removeLast() }
        }
        let sign = exp.first == "-" ? "-" : "+"
        exp = String(exp.drop { $0 == "+" || $0 == "-" })
        while exp.count > 1 && exp.hasPrefix("0") { exp.removeFirst() }
        return "\(mantissa)e\(sign)\(exp)"
    }

    /// Fixed-point with just enough decimals for `sig` significant digits, trailing zeros removed.
    static func fixedTrimmed(_ r: Double, sig: Int) -> String {
        if r == 0 { return "0" }
        let mag = Int(floor(log10(abs(r))))
        let decimals = max(0, sig - 1 - mag)
        var s = String(format: "%.\(min(decimals, 20))f", r)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        if s == "-0" { s = "0" }
        return s
    }

    /// JS `toFixed(decimals)` (half away from zero on the printed digits, like %.*f).
    static func toFixed(_ v: Double, _ decimals: Int) -> String { String(format: "%.\(decimals)f", v) }

    /// Parse "1,000.5", "2e3" (and "1.5k" when allowSuffix); nil when the text is not a plain number.
    public static func parseAmount(_ text: String, allowSuffix: Bool = false) -> Double? {
        var s = text.trimmingCharacters(in: .whitespaces)
        s = s.replacingOccurrences(of: ",(?=\\d{3}\\b)", with: "", options: .regularExpression).replacingOccurrences(of: "_", with: "")
        guard let m = ConvertRegex.match("^([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)\\s*([kmbKMB])?$", s) else { return nil }
        if m[2] != nil && !allowSuffix { return nil }
        guard let lit = m[1], let base = Double(lit) else { return nil }
        let mult: Double
        switch m[2]?.lowercased() {
        case "k": mult = 1e3
        case "m": mult = 1e6
        case "b": mult = 1e9
        default: mult = 1
        }
        return base.isFinite ? base * mult : nil
    }
}

/// Tiny regex helper: capture groups as optional strings (index 0 = whole match).
enum ConvertRegex {
    nonisolated(unsafe) private static var cache: [String: NSRegularExpression] = [:]
    private static let lock = NSLock()

    static func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression? {
        let key = "\(options.rawValue)|\(pattern)"
        lock.lock()
        defer { lock.unlock() }
        if let r = cache[key] { return r }
        let r = try? NSRegularExpression(pattern: pattern, options: options)
        if let r { cache[key] = r }
        return r
    }

    static func match(_ pattern: String, _ s: String, _ options: NSRegularExpression.Options = []) -> [String?]? {
        guard let re = regex(pattern, options) else { return nil }
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
    }

    /// All matches with their ranges (NSString indices).
    static func matches(_ pattern: String, _ s: String, _ options: NSRegularExpression.Options = []) -> [NSTextCheckingResult] {
        guard let re = regex(pattern, options) else { return [] }
        return re.matches(in: s, range: NSRange(location: 0, length: (s as NSString).length))
    }

    static func test(_ pattern: String, _ s: String, _ options: NSRegularExpression.Options = []) -> Bool {
        guard let re = regex(pattern, options) else { return false }
        return re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    static func replace(_ pattern: String, in s: String, with template: String, _ options: NSRegularExpression.Options = []) -> String {
        guard let re = regex(pattern, options) else { return s }
        return re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: template)
    }
}
