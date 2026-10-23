import Foundation

// Port of src/engine/rank.ts: per-candidate evaluation (iXi), whole-word floor, tiered comparators B4 / sXi.

/// Command-type priority (VYi/lXi) adapted to Glide kinds.
public func kindPriority(_ kind: ItemKind) -> Int {
    switch kind.rawValue {
    case "app", "workflow": return 5
    case "system", "command": return 4
    case "quicklink", "snippet": return 3
    case "setting", "file": return 1
    case "calculator": return 0
    case "fallback": return -1
    default: return 0
    }
}

public struct Candidate: Sendable {
    public let item: SearchItem
    public let title: PreparedText
    public let subtitle: PreparedText?
    public let keywords: [PreparedText]
    /// Folded alias (aliases override item.alias).
    public let alias: [UInt16]
    public let priority: Int

    public init(item: SearchItem, aliasOverride: String? = nil) {
        self.item = item
        title = prepareText(item.title)
        let subtitleRaw = item.subtitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let sub: PreparedText? = !subtitleRaw.isEmpty && foldUnits(subtitleRaw) != title.folded ? prepareText(subtitleRaw) : nil
        subtitle = sub
        var kws: [PreparedText] = []
        for k in item.keywords ?? [] {
            let t = k.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { kws.append(prepareText(t)) }
        }
        if sub != nil {
            kws.append(prepareText("\(item.title) \(subtitleRaw)"))
            kws.append(prepareText("\(subtitleRaw) \(item.title)"))
        }
        keywords = kws
        alias = foldUnits((aliasOverride ?? item.alias ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        priority = kindPriority(item.kind)
    }
}

public struct Ranking: Sendable {
    public var alias: ExactOrPrefix
    public var titleMatch: ExactOrPrefix
    public var title: FuzzyResult?
    public var titleScore: Double
    public var subtitle: FuzzyResult?
    public var subtitleScore: Double
    public var searchTerms: SearchTermMatch
    public var keywordOnly: Bool
    public var bypassed: Bool

    static let bypass = Ranking(alias: .unmatched, titleMatch: .unmatched, title: nil, titleScore: UNMATCHED_SCORE, subtitle: nil,
                                subtitleScore: UNMATCHED_SCORE, searchTerms: .unmatched, keywordOnly: false, bypassed: true)
}

public struct Ranked: Sendable {
    public var candidate: Candidate
    public var ranking: Ranking
    public var frecency: Double
    /// Provider-supplied secondary order (lower first).
    public var sortHeuristic: Double
}

public struct EvalContext: Sendable {
    public var sensitivity: Sensitivity
    public var frecency: Double
    public var searchTerms: [String]
    public var sortHeuristic: Double = 0
    public init(sensitivity: Sensitivity = .high, frecency: Double = 1, searchTerms: [String] = [], sortHeuristic: Double = 0) {
        self.sensitivity = sensitivity
        self.frecency = frecency
        self.searchTerms = searchTerms
        self.sortHeuristic = sortHeuristic
    }
}

@inline(__always) private func scoreOf(_ m: FuzzyResult?) -> Double { m?.score ?? UNMATCHED_SCORE }
@inline(__always) private func gate(_ m: FuzzyResult?, _ len: Int, _ s: Sensitivity) -> Bool {
    guard let m else { return false }
    return passesSensitivity(m.score, len, m.skipped, s)
}

/// iXi + whole-word floor. nil when the candidate is not eligible.
public func evaluate(_ c: Candidate, _ q: PreparedQuery, _ ctx: EvalContext) -> Ranked? {
    let len = q.folded.count
    let alias: ExactOrPrefix = c.alias.isEmpty ? .unmatched : exactOrPrefix(c.alias, q.folded)
    let title = fuzzyMatch(c.title, q)
    let titleMatch: ExactOrPrefix = title?.exact == true ? .exact : (exactOrPrefix(c.title.folded, q.folded) == .prefix ? .prefix : .unmatched)
    var titleScore = scoreOf(title)
    if let title, !title.exact, wholeWordApplies(q.folded), containsWholeWord(c.title, q.folded) {
        titleScore = max(titleScore, wholeWordFloor(len))
    }
    let subtitle = c.subtitle.flatMap { fuzzyMatch($0, q) }
    let subtitleScore = scoreOf(subtitle)
    let terms: SearchTermMatch = ctx.searchTerms.isEmpty ? .unmatched : matchSearchTerms(ctx.searchTerms, q.foldedString)

    let titleOk = titleMatch != .unmatched || gate(title, len, ctx.sensitivity)
    let subtitleOk = gate(subtitle, len, ctx.sensitivity)
    var keywordOnly = false
    var matching = titleOk || subtitleOk
    if !matching {
        for k in c.keywords where gate(fuzzyMatch(k, q), len, ctx.sensitivity) {
            matching = true
            keywordOnly = true
            break
        }
    }
    // GLIDE CHOICE: an alias exact/prefix hit makes the item eligible.
    if !matching && alias != .unmatched { matching = true }
    if !matching { return nil }
    return Ranked(candidate: c, ranking: Ranking(alias: alias, titleMatch: titleMatch, title: title, titleScore: titleScore, subtitle: subtitle,
                                                 subtitleScore: subtitleScore, searchTerms: terms, keywordOnly: keywordOnly, bypassed: false),
                  frecency: ctx.frecency, sortHeuristic: ctx.sortHeuristic)
}

public func bypassRanking(_ c: Candidate, _ ctx: EvalContext) -> Ranked {
    Ranked(candidate: c, ranking: .bypass, frecency: ctx.frecency, sortHeuristic: ctx.sortHeuristic)
}

// MARK: - comparators (negative = a first)

/// Intl.Collator(undefined, {numeric: true, sensitivity: "base"}).
public func compareTitles(_ a: String, _ b: String) -> Int {
    switch a.compare(b, options: [.caseInsensitive, .diacriticInsensitive, .numeric, .widthInsensitive], range: nil, locale: Locale.current) {
    case .orderedAscending: return -1
    case .orderedDescending: return 1
    case .orderedSame: return 0
    }
}

@inline(__always) private func desc(_ a: Double, _ b: Double) -> Int { a == b ? 0 : (b > a ? 1 : -1) }
@inline(__always) private func asc(_ a: Double, _ b: Double) -> Int { a == b ? 0 : (a < b ? -1 : 1) }

/// B4: frecency desc → has alias → kind priority desc → sortHeuristic asc → title collation.
public func compareB4(_ a: Ranked, _ b: Ranked) -> Int {
    if a.frecency != b.frecency { return desc(a.frecency, b.frecency) }
    let aa = a.candidate.alias.isEmpty ? 0 : 1
    let ba = b.candidate.alias.isEmpty ? 0 : 1
    if aa != ba { return ba - aa }
    if a.candidate.priority != b.candidate.priority { return b.candidate.priority - a.candidate.priority }
    if a.sortHeuristic != b.sortHeuristic { return asc(a.sortHeuristic, b.sortHeuristic) }
    return compareTitles(a.candidate.item.title, b.candidate.item.title)
}

public struct ListFlags: Sendable {
    public var hasExactTitle: Bool
    public var hasExactSearchTerm: Bool
}

private func compareSearchTermRank(_ a: Ranking, _ b: Ranking) -> Int {
    let ra = a.searchTerms.rank, rb = b.searchTerms.rank
    if ra != rb { return rb - ra }
    if case let .overbounds(ca) = a.searchTerms, case let .overbounds(cb) = b.searchTerms { return cb - ca }
    return 0
}

/// sXi: the non-empty-query order (tiers T1–T16, T3/T4 omitted).
public func compareRanked(_ flags: ListFlags, _ a: Ranked, _ b: Ranked) -> Int {
    let ra = a.ranking, rb = b.ranking

    // T1 alias exact
    if rb.alias == .exact && ra.alias != .exact { return 1 }
    if ra.alias == .exact && rb.alias != .exact { return -1 }
    if ra.alias == .exact && rb.alias == .exact && a.frecency != b.frecency { return desc(a.frecency, b.frecency) }

    // T2
    if flags.hasExactTitle && flags.hasExactSearchTerm {
        let ea = ra.searchTerms == .exact, eb = rb.searchTerms == .exact
        if ea != eb { return ea ? -1 : 1 }
        if ea && eb && a.frecency != b.frecency { return desc(a.frecency, b.frecency) }
    }

    // T5 exact title
    if flags.hasExactTitle {
        let ea = ra.titleMatch == .exact, eb = rb.titleMatch == .exact
        if ea && eb {
            let st = compareSearchTermRank(ra, rb)
            if st != 0 { return st }
            if a.frecency != b.frecency { return desc(a.frecency, b.frecency) }
            return compareB4(a, b)
        }
        if ea != eb { return ea ? -1 : 1 }
    }

    // T6 stored term exact
    do {
        let ea = ra.searchTerms == .exact, eb = rb.searchTerms == .exact
        if ea && eb {
            if a.frecency != b.frecency { return desc(a.frecency, b.frecency) }
            return compareB4(a, b)
        }
        if ea != eb { return ea ? -1 : 1 }
    }

    // T7 subtitle exact
    do {
        let ea = ra.subtitle?.exact == true, eb = rb.subtitle?.exact == true
        if ea && eb {
            if a.frecency != b.frecency { return desc(a.frecency, b.frecency) }
            if ra.titleScore != rb.titleScore { return desc(ra.titleScore, rb.titleScore) }
            return compareB4(a, b)
        }
        if ea != eb { return ea ? -1 : 1 }
    }

    // T8 alias prefix
    do {
        let pa = ra.alias == .prefix, pb = rb.alias == .prefix
        if pa != pb { return pa ? -1 : 1 }
    }

    // T9 / T10
    do {
        let pa = ra.searchTerms == .prefix, pb = rb.searchTerms == .prefix
        if pa != pb { return pa ? -1 : 1 }
        if pa && pb && a.frecency != b.frecency { return desc(a.frecency, b.frecency) }
        let oa = ra.searchTerms.overCount, ob = rb.searchTerms.overCount
        if oa > 0 && ob > 0 {
            if (oa >= 3 || ob >= 3) && oa != ob { return ob - oa }
        } else if oa >= 3 { return -1 } else if ob >= 3 { return 1 }
    }

    // T11 max(title, subtitle)
    let ma = max(ra.titleScore, ra.subtitleScore), mb = max(rb.titleScore, rb.subtitleScore)
    if ma != mb { return desc(ma, mb) }
    // T12 frecency
    if a.frecency != b.frecency { return desc(a.frecency, b.frecency) }
    // T13 title score
    if ra.titleScore != rb.titleScore { return desc(ra.titleScore, rb.titleScore) }
    // T14 kind priority
    if a.candidate.priority != b.candidate.priority { return b.candidate.priority - a.candidate.priority }
    // T15 sortHeuristic
    if a.sortHeuristic != b.sortHeuristic { return asc(a.sortHeuristic, b.sortHeuristic) }
    // T16 collation
    return compareTitles(a.candidate.item.title, b.candidate.item.title)
}

public func computeFlags(_ list: [Ranked], queryLen: Int) -> ListFlags {
    var f = ListFlags(hasExactTitle: false, hasExactSearchTerm: false)
    for r in list {
        if queryLen >= 3 && r.ranking.titleMatch == .exact { f.hasExactTitle = true }
        if r.ranking.searchTerms == .exact { f.hasExactSearchTerm = true }
    }
    return f
}

/// Presentation-only MatchKind.
public func matchKindOf(_ r: Ranking, titleLen: Int) -> MatchKind {
    if r.alias == .exact { return .alias }
    if r.titleMatch == .exact { return .exact }
    if r.titleMatch == .prefix { return .prefix }
    if r.bypassed { return .none }
    if r.keywordOnly { return .keyword }
    guard let t = r.title, !t.ranges.isEmpty else { return r.subtitle != nil ? .fuzzy : .none }
    if t.ranges.count == 1 && t.ranges[0].start > 0 && titleLen > 0 { return .wordPrefix }
    let matched = t.ranges.reduce(0) { $0 + ($1.end - $1.start) }
    if t.ranges.count == matched && matched > 1 { return .acronym }
    return .fuzzy
}

public func toScoredItem(_ r: Ranked, score: Double, queryLen: Int, argument: String? = nil) -> ScoredItem {
    let ranking = r.ranking
    let titleLen = r.candidate.item.title.utf16.count
    var ranges: [MatchRange]
    switch ranking.titleMatch {
    case .exact: ranges = [MatchRange(start: 0, end: titleLen)]
    case .prefix: ranges = [MatchRange(start: 0, end: min(titleLen, queryLen))]
    case .unmatched: ranges = ranking.title?.ranges ?? []
    }
    let ms = ranking.titleMatch == .exact ? EXACT_SCORE : max(ranking.titleScore, ranking.subtitleScore)
    ranges = ranges.filter { $0.end > $0.start }
    return ScoredItem(item: r.candidate.item, score: score, matchScore: ms <= UNMATCHED_SCORE ? 0 : ms,
                      matchKind: matchKindOf(ranking, titleLen: titleLen), frecency: r.frecency, ranges: ranges, argument: argument)
}
