import Foundation

/// Small NSRegularExpression wrapper used by the transforms (JS `String.replace` semantics, UTF-16 safe).
/// Patterns are compile-time constants; an invalid one is a programming error caught by the tests.
struct TransformRegex: @unchecked Sendable {
    let re: NSRegularExpression

    init(_ pattern: String, caseInsensitive: Bool = false) {
        var opts: NSRegularExpression.Options = []
        if caseInsensitive { opts.insert(.caseInsensitive) }
        // swiftlint:disable:next force_try
        re = try! NSRegularExpression(pattern: pattern, options: opts)
    }

    /// Replace every match with `transform(groups)`; groups[0] is the whole match, missing groups are "".
    func replace(_ s: String, _ transform: ([String]) -> String) -> String {
        let ns = s as NSString
        var out = ""
        var cursor = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            var groups: [String] = []
            for i in 0..<m.numberOfRanges {
                let r = m.range(at: i)
                groups.append(r.location == NSNotFound ? "" : ns.substring(with: r))
            }
            out += transform(groups)
            cursor = m.range.location + m.range.length
        }
        out += ns.substring(from: cursor)
        return out
    }

    /// Template replacement ("$1 $2").
    func replace(_ s: String, template: String) -> String {
        re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: template)
    }

    func matches(_ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    /// All whole-match substrings.
    func all(_ s: String) -> [String] {
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
    }

    /// Capture groups of the first match.
    func firstGroups(_ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? "" : ns.substring(with: r)
        }
    }

    /// JS `split(regex)`.
    func split(_ s: String) -> [String] {
        let ns = s as NSString
        var out: [String] = []
        var cursor = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out.append(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor)))
            cursor = m.range.location + m.range.length
        }
        out.append(ns.substring(from: cursor))
        return out
    }
}
