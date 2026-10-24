import Foundation

// Swift port of src/engine/fuzzy.ts: the root-search subsequence scorer and helpers (word boundaries,
// per-char bonus, sensitivity gate, exact/prefix, whole-word floor). All indices are UTF-16 code units, exactly like the TypeScript version, so match ranges
// and test expectations are identical.

public enum Sensitivity: String, Sendable { case low, medium, high }

/// Score of an exact (whole-text) match: 2^53-1.
public let EXACT_SCORE: Double = 9_007_199_254_740_991
/// Score of an unmatched field.
public let UNMATCHED_SCORE: Double = -9_007_199_254_740_991

public struct FuzzyResult: Equatable, Sendable {
    public var score: Double
    public var exact: Bool
    /// `text.count > query.count && text.hasPrefix(query)` (J7e).
    public var prefix: Bool
    /// Query separators that found no counterpart in the text.
    public var skipped: Int
    /// Matched ranges in the ORIGINAL text, adjacent ones merged.
    public var ranges: [MatchRange]
}

/// Pre-folded text with per-position bonus information, built once per item.
public struct PreparedText: Sendable {
    public let text: String
    public let folded: [UInt16]
    public let isSep: [Bool]
    /// Per-char bonus: 3 at a word boundary, 2 elsewhere.
    public let bonus: [UInt8]
    public var foldedString: String { String(utf16CodeUnits: folded, count: folded.count) }
}

public struct PreparedQuery: Sendable {
    public let text: String
    public let folded: [UInt16]
    public let isSkippable: [Bool]
    public let required: Int
    public let literalQueryDots: Bool
    public var foldedString: String { String(utf16CodeUnits: folded, count: folded.count) }
}

// MARK: - character tables

/// Separator table: tab, space, nbsp, '-', '.', '/', '(', ')', '[', ']'.
@inline(__always) public func isSeparatorCode(_ c: UInt16) -> Bool {
    switch c {
    case 9, 32, 160, 45, 46, 47, 40, 41, 91, 93: return true
    default: return false
    }
}

private let DOT: UInt16 = 46

private final class FoldCache: @unchecked Sendable {
    private var map: [UInt16: UInt16] = [:]
    private let lock = NSLock()
    func get(_ c: UInt16) -> UInt16? { lock.lock(); defer { lock.unlock() }; return map[c] }
    func set(_ c: UInt16, _ v: UInt16) { lock.lock(); map[c] = v; lock.unlock() }
}
private let foldCache = FoldCache()

/// Fold one UTF-16 unit: NFD, strip combining marks, lowercase; always one unit.
@inline(__always) func foldUnit(_ c: UInt16) -> UInt16 {
    if c < 128 { return (c >= 65 && c <= 90) ? c + 32 : c }
    if let hit = foldCache.get(c) { return hit }
    var out = c
    if let scalar = Unicode.Scalar(UInt32(c)) { // lone surrogates have no scalar: kept as is
        let decomposed = String(Character(scalar)).decomposedStringWithCanonicalMapping
        let base = String(String.UnicodeScalarView(decomposed.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) }))
        let lower = (base.isEmpty ? String(Character(scalar)) : base).lowercased()
        if let first = lower.utf16.first { out = first }
    }
    foldCache.set(c, out)
    return out
}

/// Lowercase + diacritic fold preserving UTF-16 length (GLIDE CHOICE: NFD + strip combining marks).
public func foldUnits(_ text: String) -> [UInt16] { text.utf16.map(foldUnit) }

public func foldText(_ text: String) -> String {
    let u = foldUnits(text)
    return String(utf16CodeUnits: u, count: u.count)
}

@inline(__always) private func isLowerOrDigit(_ c: UInt16) -> Bool { (c >= 97 && c <= 122) || (c >= 48 && c <= 57) }
@inline(__always) private func isUpper(_ c: UInt16) -> Bool { c >= 65 && c <= 90 }

/// Fold, camelCase boundaries on the ORIGINAL case (`[a-z0-9]` → `[A-Z]`), per-char bonus per position.
public func prepareText(_ text: String) -> PreparedText {
    let original = Array(text.utf16)
    let folded = original.map(foldUnit)
    let n = folded.count
    var isSep = [Bool](repeating: false, count: n)
    var bonus = [UInt8](repeating: 2, count: n)
    for i in 0..<n { isSep[i] = isSeparatorCode(folded[i]) }
    for i in 0..<n where !isSep[i] {
        let camel = i > 0 && isLowerOrDigit(original[i - 1]) && isUpper(original[i])
        let afterSep = i > 0 && isSep[i - 1]
        bonus[i] = camel || afterSep ? 3 : 2
    }
    return PreparedText(text: text, folded: folded, isSep: isSep, bonus: bonus)
}

public func prepareQuery(_ query: String, literalQueryDots: Bool = true) -> PreparedQuery {
    let folded = foldUnits(query)
    var skippable = [Bool](repeating: false, count: folded.count)
    var required = 0
    for (i, c) in folded.enumerated() {
        let s = isSeparatorCode(c) && !(literalQueryDots && c == DOT)
        skippable[i] = s
        if !s { required += 1 }
    }
    return PreparedQuery(text: query, folded: folded, isSkippable: skippable, required: required, literalQueryDots: literalQueryDots)
}

// MARK: - DP scorer

private func subsequencePrecheck(_ t: PreparedText, _ q: PreparedQuery) -> Bool {
    var pos = 0
    let tc = t.folded
    let n = tc.count
    for i in 0..<q.folded.count where !q.isSkippable[i] {
        let c = q.folded[i]
        while pos < n && tc[pos] != c { pos += 1 }
        if pos >= n { return false }
        pos += 1
    }
    return true
}

private func mergeRanges(_ cols: [Int]) -> [MatchRange] {
    var ranges: [MatchRange] = []
    for c in cols {
        if let last = ranges.last, last.end == c { ranges[ranges.count - 1].end = c + 1 }
        else { ranges.append(MatchRange(start: c, end: c + 1)) }
    }
    return ranges
}

@inline(__always) private func hasPrefix(_ a: [UInt16], _ b: [UInt16]) -> Bool {
    guard a.count >= b.count else { return false }
    for i in 0..<b.count where a[i] != b[i] { return false }
    return true
}

/// Ordered-subsequence DP (4 start-of-text, 3 boundary, 2 elsewhere, 1 for a
/// separator matching a different separator, gaps cost 1, consecutive free, skippable query separators).
public func fuzzyMatch(_ t: PreparedText, _ q: PreparedQuery) -> FuzzyResult? {
    let s = t.folded.count
    let c = q.folded.count
    if c == 0 { return nil }
    if t.folded == q.folded {
        return FuzzyResult(score: EXACT_SCORE, exact: true, prefix: false, skipped: 0, ranges: s > 0 ? [MatchRange(start: 0, end: s)] : [])
    }
    let prefix = s > c && hasPrefix(t.folded, q.folded)
    let u = q.required
    if u > s { return nil }
    if u > 2 && !subsequencePrecheck(t, q) { return nil }

    let NEG = UNMATCHED_SCORE
    var prev = [Double](repeating: NEG, count: s)
    var curr = [Double](repeating: NEG, count: s)
    var backPtr = [Int](repeating: -1, count: s * c)
    let tc = t.folded
    let tSep = t.isSep
    let tBonus = t.bonus

    var d = -1
    var skipped = 0
    var matchedRows = 0
    var effRows = 0

    for e in 0..<c {
        let qc = q.folded[e]
        let skippable = q.isSkippable[e]
        let remaining = u - 1 - matchedRows
        var m = -1
        let h = d + 1
        let g = min(s, s - remaining)
        let rowBase = effRows * s
        var gapMax = NEG
        var gapCol = -1

        if h < g {
            for col in h..<g {
                if d >= 0 && col - 2 >= d {
                    let v = prev[col - 2]
                    if v > gapMax { gapMax = v; gapCol = col - 2 }
                }
                let a = tc[col]
                let same = a == qc
                let sepMatch = !same && skippable && tSep[col]
                if !same && !sepMatch { curr[col] = NEG; continue }
                var score: Double
                var from = -1
                if d < 0 {
                    score = sepMatch ? 1 : (col == 0 ? 4 : Double(tBonus[col]))
                } else {
                    let bonus: Double = sepMatch ? 1 : Double(tBonus[col])
                    score = NEG
                    if col - 1 >= d {
                        let v = prev[col - 1]
                        if v > NEG { score = v + bonus; from = col - 1 }
                    }
                    if gapMax > NEG {
                        let v = gapMax + bonus - 1
                        if v > score { score = v; from = gapCol }
                    }
                    if score <= NEG { curr[col] = NEG; continue }
                }
                curr[col] = score
                backPtr[rowBase + col] = from
                if m < 0 { m = col }
            }
        }

        if m >= 0 {
            if h > 0 { for col in 0..<min(h, s) { curr[col] = NEG } }
            if g < s { for col in max(g, 0)..<s { curr[col] = NEG } }
            d = m
            matchedRows += 1
            effRows += 1
            swap(&prev, &curr)
        } else if skippable {
            skipped += 1
        } else {
            return nil
        }
    }

    var best = NEG
    var bestCol = -1
    for col in 0..<s where prev[col] > best { best = prev[col]; bestCol = col }
    if effRows == 0 || bestCol < 0 { return nil }

    var cols = [Int](repeating: 0, count: effRows)
    var col = bestCol
    for r in stride(from: effRows - 1, through: 0, by: -1) {
        cols[r] = col
        col = backPtr[r * s + col]
    }
    return FuzzyResult(score: best, exact: false, prefix: prefix, skipped: skipped, ranges: mergeRanges(cols))
}

public func fuzzyMatch(_ text: String, _ query: String, literalQueryDots: Bool = true) -> FuzzyResult? {
    fuzzyMatch(prepareText(text), prepareQuery(query, literalQueryDots: literalQueryDots))
}

// MARK: - companions

public enum ExactOrPrefix: Sendable { case exact, prefix, unmatched }

/// Exact/prefix test on folded strings.
public func exactOrPrefix(_ text: [UInt16], _ query: [UInt16]) -> ExactOrPrefix {
    if text == query { return .exact }
    if text.count > query.count && hasPrefix(text, query) { return .prefix }
    return .unmatched
}

/// Sensitivity gate: low any; medium `score ≥ 1.5·(len−skipped−2)+4`; high `score > 2·(len−skipped)`.
public func passesSensitivity(_ score: Double, _ len: Int, _ skipped: Int, _ level: Sensitivity) -> Bool {
    if score == EXACT_SCORE { return true }
    if score <= UNMATCHED_SCORE { return false }
    switch level {
    case .low: return true
    case .medium: return score >= 1.5 * Double(len - skipped - 2) + 4
    case .high: return score > 2 * Double(len - skipped)
    }
}

/// Whole-word floor: 4 + (len−1)·2 + 0.5.
public func wholeWordFloor(_ len: Int) -> Double { 4 + Double(len - 1) * 2 + 0.5 }

/// The folded query occurs as a whole word (separators / camelCase / string ends on both sides).
public func containsWholeWord(_ t: PreparedText, _ q: [UInt16]) -> Bool {
    let n = q.count
    let total = t.folded.count
    guard n > 0, n <= total else { return false }
    var i = 0
    while i + n <= total {
        var hit = true
        for k in 0..<n where t.folded[i + k] != q[k] { hit = false; break }
        if hit {
            let startOk = i == 0 || t.isSep[i - 1] || t.bonus[i] == 3
            let end = i + n
            let endOk = end == total || t.isSep[end] || t.bonus[end] == 3
            if startOk && endOk { return true }
        }
        i += 1
    }
    return false
}

public func wholeWordApplies(_ query: [UInt16]) -> Bool {
    query.count >= 3 && !query.contains { $0 == 32 || $0 == 9 || $0 == 10 || $0 == 13 || $0 == 160 || $0 == 12 || $0 == 11 }
}
