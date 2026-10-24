import Foundation

// Port of src/engine/frecency.ts: "future date" frecency:
//   decode(date) = max(1, 2^((date − now) / halfLife))
//   visit(date)  = now + halfLife · log2( max(1, decode(max(date, now))) + 100 )

public enum Frecency {
    public static let daySec: Double = 86_400
    public static let defaultHalfLifeDays: Double = 10
    public static let defaultHalfLifeSec: Double = defaultHalfLifeDays * daySec
    public static let visitBonus: Double = 100
    /// Stored search terms only count while opened within 17 days.
    public static let searchTermWindowMs: Double = 17 * daySec * 1000
    public static let searchTermMinFrecency: Double = 1
    public static let maxSearchTerms = 3
    public static let launchRing = 10
    public static let overboundsMaxExtra = 3
    static let maxLog2 = 709.78 / M_LN2

    public static func decode(_ date: Double?, _ nowSec: Double, _ halfLifeSec: Double = defaultHalfLifeSec) -> Double {
        guard let date, !date.isNaN else { return 1 }
        let exponent = min((date - nowSec) / halfLifeSec, maxLog2)
        return max(1, pow(2, exponent))
    }

    public static func visit(_ date: Double?, _ nowSec: Double, _ halfLifeSec: Double = defaultHalfLifeSec) -> Double {
        let base = (date == nil || date!.isNaN) ? nowSec : max(date!, nowSec)
        let decayed = decode(base, nowSec, halfLifeSec)
        return nowSec + halfLifeSec * log2(decayed + visitBonus)
    }

    public static func encode(_ score: Double, _ nowSec: Double, _ halfLifeSec: Double = defaultHalfLifeSec) -> Double {
        nowSec + halfLifeSec * log2(max(1, score))
    }

    public static func decayScore(_ score: Double, sampledAtMs: Double, nowMs: Double, halfLifeMs: Double = defaultHalfLifeSec * 1000) -> Double {
        let delta = nowMs - sampledAtMs
        if delta <= 0 { return score }
        return max(1, score * pow(2, -delta / halfLifeMs))
    }

    /// GLIDE CHOICE: recompute the encoded date from a UsageRecord by folding visit() over its launches.
    public static func dateFromRecord(_ r: UsageRecord, halfLifeSec: Double = defaultHalfLifeSec) -> Double? {
        var launches = r.launches.filter(\.isFinite).sorted()
        let count = max(0, r.count)
        if launches.isEmpty && count > 0 && r.lastLaunchedAt.isFinite { launches.append(r.lastLaunchedAt) }
        if launches.isEmpty { return nil }
        var date: Double?
        let overflow = max(0, count - launches.count)
        let oldestSec = launches[0] / 1000
        for _ in 0..<overflow { date = visit(date, oldestSec, halfLifeSec) }
        for t in launches { date = visit(date, t / 1000, halfLifeSec) }
        return date
    }

    /// Newest → oldest, folded, de-duplicated, at most 3.
    public static func normalizeTerms(_ terms: [String]) -> [String] {
        var out: [String] = []
        for raw in terms {
            let t = foldText(raw.trimmingCharacters(in: .whitespacesAndNewlines))
            if t.isEmpty || out.contains(t) { continue }
            out.append(t)
            if out.count >= maxSearchTerms { break }
        }
        return out
    }
}

public enum SearchTermMatch: Equatable, Sendable {
    case exact, prefix, overbounds(count: Int), unmatched

    public var rank: Int {
        switch self {
        case .exact: return 3
        case .prefix: return 2
        case .overbounds: return 1
        case .unmatched: return 0
        }
    }
    public var overCount: Int { if case let .overbounds(c) = self { return c }; return 0 }
}

/// Best over all eligible terms, exact > prefix > overbounds (longest).
public func matchSearchTerms(_ terms: [String], _ foldedQuery: String) -> SearchTermMatch {
    var best = SearchTermMatch.unmatched
    let q = Array(foldedQuery.utf16)
    for term in terms {
        let t = Array(term.utf16)
        if t == q { return .exact }
        if t.count > q.count && t.starts(with: q) {
            if best != .prefix { best = .prefix }
            continue
        }
        if q.starts(with: t) {
            let extra = q.count - t.count
            if extra >= 1 && extra <= Frecency.overboundsMaxExtra {
                switch best {
                case .unmatched: best = .overbounds(count: t.count)
                case let .overbounds(c) where c < t.count: best = .overbounds(count: t.count)
                default: break
                }
            }
        }
    }
    return best
}

public struct FrecencyEntry: Sendable {
    public var frecencyDate: Double
    public var score: Double
    public var sampledAtMs: Double
    public var openedAtMs: Double
    public var searchTerms: [String]
}

/// Per-item frecency state derived from usage records; decays on read.
public struct FrecencyCache: Sendable {
    private var entries: [String: FrecencyEntry] = [:]
    public private(set) var halfLifeSec: Double

    public init(halfLifeSec: Double = Frecency.defaultHalfLifeSec) { self.halfLifeSec = halfLifeSec }

    public mutating func load(_ records: [UsageRecord], nowMs: Double, halfLifeSec: Double? = nil) {
        if let halfLifeSec { self.halfLifeSec = halfLifeSec }
        entries.removeAll()
        for r in records {
            guard let date = Frecency.dateFromRecord(r, halfLifeSec: self.halfLifeSec) else { continue }
            entries[r.itemId] = FrecencyEntry(
                frecencyDate: date, score: Frecency.decode(date, nowMs / 1000, self.halfLifeSec), sampledAtMs: nowMs,
                openedAtMs: r.lastLaunchedAt, searchTerms: Frecency.normalizeTerms(r.searchTerms ?? []))
        }
    }

    public func score(_ itemId: String, nowMs: Double) -> Double {
        guard let e = entries[itemId] else { return 1 }
        return Frecency.decayScore(e.score, sampledAtMs: e.sampledAtMs, nowMs: nowMs, halfLifeMs: halfLifeSec * 1000)
    }

    public func entry(_ itemId: String) -> FrecencyEntry? { entries[itemId] }

    public mutating func recordVisit(_ prev: UsageRecord?, itemId: String, nowMs: Double, searchTerm: String? = nil) -> UsageRecord {
        let launches = Array(((prev?.launches ?? []) + [nowMs]).suffix(Frecency.launchRing))
        var record = UsageRecord(itemId: itemId, launches: launches, count: (prev?.count ?? 0) + 1, lastLaunchedAt: nowMs)
        if let prev { record.extra = prev.extra }
        let prevTerms = entries[itemId]?.searchTerms ?? Frecency.normalizeTerms(prev?.searchTerms ?? [])
        let folded = searchTerm.map { foldText($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? ""
        let terms = Frecency.normalizeTerms(folded.isEmpty ? prevTerms : [folded] + prevTerms)
        if !terms.isEmpty { record.searchTerms = terms }
        let nowSec = nowMs / 1000
        let date = Frecency.visit(entries[itemId]?.frecencyDate, nowSec, halfLifeSec)
        entries[itemId] = FrecencyEntry(frecencyDate: date, score: Frecency.decode(date, nowSec, halfLifeSec), sampledAtMs: nowMs, openedAtMs: nowMs, searchTerms: terms)
        return record
    }

    /// Stored terms only apply while frecency > 1 and the item was opened within 17 days.
    public func termsEligible(_ itemId: String, nowMs: Double) -> [String] {
        guard let e = entries[itemId], !e.searchTerms.isEmpty else { return [] }
        if score(itemId, nowMs: nowMs) <= Frecency.searchTermMinFrecency { return [] }
        if nowMs - e.openedAtMs > Frecency.searchTermWindowMs { return [] }
        return e.searchTerms
    }
}
