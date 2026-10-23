import Foundation

/// Runtime options (src/engine/api.ts EngineOptions).
public struct EngineOptions: Sendable {
    public var frecencyHalfLifeDays: Double = Frecency.defaultHalfLifeDays
    public var sectionLimit: Int = 8
    /// Favorite item ids in favorite order.
    public var favorites: [String] = []
    /// item id → alias (overrides item.alias)
    public var aliases: [String: String] = [:]
    public var sensitivity: Sensitivity = .high
    public init() {}
}

/// Port of src/engine/index.ts `createEngine`. A value type: the app owns one on the main actor and tests
/// create their own. `now` is injectable (ms since epoch).
public struct SearchEngine: Sendable {
    public private(set) var options: EngineOptions
    private var items: [SearchItem] = []
    private var candidates: [Candidate] = []
    private var candidateById: [String: Int] = [:]
    private var usage: [String: UsageRecord] = [:]
    private var frecency: FrecencyCache
    public var now: @Sendable () -> Double

    public static let notRanked: Set<ItemKind> = [.fallback, .calculator]

    public init(options: EngineOptions = EngineOptions(), now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.options = options
        self.now = now
        frecency = FrecencyCache(halfLifeSec: Self.halfLife(options))
    }

    private static func halfLife(_ o: EngineOptions) -> Double {
        (o.frecencyHalfLifeDays > 0 ? o.frecencyHalfLifeDays : Frecency.defaultHalfLifeDays) * Frecency.daySec
    }
    private var sectionLimit: Int { options.sectionLimit > 0 ? options.sectionLimit : 8 }

    public var allItems: [SearchItem] { items }
    public func item(_ id: String) -> SearchItem? { candidateById[id].map { candidates[$0].item } }

    public mutating func setItems(_ next: [SearchItem]) {
        items = next
        rebuildCandidates()
    }

    private mutating func rebuildCandidates() {
        candidates = items.map { Candidate(item: $0, aliasOverride: options.aliases[$0.id]) }
        candidateById = [:]
        for (i, c) in candidates.enumerated() { candidateById[c.item.id] = i }
    }

    public mutating func setUsage(_ records: [UsageRecord]) {
        usage = [:]
        for r in records { usage[r.itemId] = r }
        frecency.load(Array(usage.values), nowMs: now(), halfLifeSec: Self.halfLife(options))
    }

    public mutating func configure(_ patch: (inout EngineOptions) -> Void) {
        let prev = options
        patch(&options)
        if prev.aliases != options.aliases { rebuildCandidates() }
        if prev.frecencyHalfLifeDays != options.frecencyHalfLifeDays {
            frecency.load(Array(usage.values), nowMs: now(), halfLifeSec: Self.halfLife(options))
        }
    }

    public func frecencyScore(_ itemId: String) -> Double { frecency.score(itemId, nowMs: now()) }

    private func ctx(_ id: String, _ nowMs: Double, _ sortHeuristic: Double = 0) -> EvalContext {
        EvalContext(sensitivity: options.sensitivity, frecency: frecency.score(id, nowMs: nowMs),
                    searchTerms: frecency.termsEligible(id, nowMs: nowMs), sortHeuristic: sortHeuristic)
    }

    /// GLIDE CHOICE: "g electron" pins the acceptsArgument item identified by the first word.
    private func extractArgument(_ raw: String, _ nowMs: Double) -> (index: Int, argument: String, headLen: Int)? {
        let units = Array(raw.utf16)
        guard let space = units.firstIndex(where: isWhitespaceUnit), space > 0 else { return nil }
        let headStr = String(utf16CodeUnits: Array(units[..<space]), count: space)
        let head = foldUnits(headStr)
        let restUnits = Array(units[(space + 1)...])
        let argument = String(utf16CodeUnits: restUnits, count: restUnits.count).trimmingLeadingWhitespace()
        if argument.isEmpty { return nil }
        let whole = foldUnits(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        // Typing ANY item's multi-word title ("search snippets", "ask name demo") is not head + argument for a
        // different item that merely shares the first word ("Search Bookmarks", "Ask Glide Agent"). Only an
        // exact alias still wins then (rank 3 below), because the user chose it explicitly.
        let wholeIsATitle = candidates.contains { !Self.notRanked.contains($0.item.kind) && $0.title.folded.starts(with: whole) }
        var best: (Int, Int, Double)?
        for (i, c) in candidates.enumerated() {
            guard c.item.acceptsArgument == true, !Self.notRanked.contains(c.item.kind) else { continue }
            var rank = 0
            if !c.alias.isEmpty && c.alias == head { rank = 3 } else {
                switch exactOrPrefix(c.title.folded, head) {
                case .exact: rank = 2
                case .prefix: rank = 1
                case .unmatched: rank = 0
                }
                if rank > 0 && (wholeIsATitle || c.title.folded.starts(with: whole)) { rank = 0 }
            }
            if rank == 0 { continue }
            let f = frecency.score(c.item.id, nowMs: nowMs)
            if best == nil || rank > best!.1 || (rank == best!.1 && f > best!.2) { best = (i, rank, f) }
        }
        guard let b = best else { return nil }
        return (b.0, argument, space)
    }

    private func rankQuery(_ pq: PreparedQuery, raw: String, dynamic: [ScoredItem], nowMs: Double) -> [ScoredItem] {
        var ranked: [Ranked] = []
        var bypass: [Ranked] = []
        let arg = extractArgument(raw, nowMs)
        for (i, c) in candidates.enumerated() {
            if Self.notRanked.contains(c.item.kind) { continue }
            if let arg, arg.index == i { continue }
            if let r = evaluate(c, pq, ctx(c.item.id, nowMs)) { ranked.append(r) }
        }
        for d in dynamic {
            let c = Candidate(item: d.item, aliasOverride: options.aliases[d.item.id])
            let cx = ctx(d.item.id, nowMs, -d.score)
            if let r = evaluate(c, pq, cx) { ranked.append(r) } else { bypass.append(bypassRanking(c, cx)) }
        }
        let flags = computeFlags(ranked, queryLen: pq.folded.count)
        ranked.sort { compareRanked(flags, $0, $1) < 0 }
        bypass.sort { compareB4($0, $1) < 0 }

        var ordered: [(Ranked, String?)] = []
        if let arg {
            let c = candidates[arg.index]
            let headUnits = Array(raw.utf16.prefix(arg.headLen))
            let headQuery = prepareQuery(String(utf16CodeUnits: headUnits, count: headUnits.count))
            let cx = ctx(c.item.id, nowMs)
            ordered.append((evaluate(c, headQuery, cx) ?? bypassRanking(c, cx), arg.argument))
        }
        for r in ranked { ordered.append((r, nil)) }
        for r in bypass { ordered.append((r, nil)) }
        let total = ordered.count
        return ordered.enumerated().map { i, pair in
            toScoredItem(pair.0, score: Double(total - i), queryLen: pq.folded.count, argument: pair.1)
        }
    }

    /// Rank items for a query. Empty query → favorites + suggestions + workflows.
    public func search(_ query: String, dynamicItems: [ScoredItem] = []) -> SearchResponse {
        let started = DispatchTime.now().uptimeNanoseconds
        let nowMs = now()
        let raw = query.precomposedStringWithCanonicalMapping.trimmingLeadingWhitespace()
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let limit = sectionLimit
        func took() -> Double { Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000 }

        if trimmed.isEmpty {
            let sections = buildEmptySections(candidates: candidates, favorites: options.favorites,
                                              frecencyOf: { frecency.score($0, nowMs: nowMs) }, sectionLimit: limit)
            return SearchResponse(query: query, sections: sections, total: candidates.count, tookMs: took())
        }
        let pq = prepareQuery(trimmed)
        let calculator = dynamicItems.filter { $0.item.kind == .calculator }
        let files = dynamicItems.filter { $0.item.kind == .file }.sorted { $0.score > $1.score }
        let other = dynamicItems.filter { $0.item.kind != .calculator && $0.item.kind != .file }
        let results = rankQuery(pq, raw: raw, dynamic: other, nowMs: nowMs)
        var fallbacks: [ScoredItem] = []
        for c in candidates where c.item.kind == .fallback {
            fallbacks.append(ScoredItem(item: c.item, score: 0, matchScore: 0, matchKind: .none, frecency: frecency.score(c.item.id, nowMs: nowMs), ranges: [], argument: trimmed))
        }
        let sections = buildSearchSections(
            foldedQuery: pq.foldedString, results: results, calculator: calculator, files: files, fallbacks: fallbacks, sectionLimit: limit,
            aliasOf: { id in candidateById[id].map { String(utf16CodeUnits: candidates[$0].alias, count: candidates[$0].alias.count) } ?? "" })
        return SearchResponse(query: query, sections: sections, total: candidates.count + dynamicItems.count, tookMs: took())
    }

    /// Record a launch; returns the record the caller persists (Store.setUsage).
    @discardableResult
    public mutating func recordUsage(_ itemId: String, searchTerm: String? = nil) -> UsageRecord {
        let record = frecency.recordVisit(usage[itemId], itemId: itemId, nowMs: now(), searchTerm: searchTerm)
        usage[itemId] = record
        return record
    }

    public var usageRecords: [UsageRecord] { usage.values.sorted { $0.itemId < $1.itemId } }
}

@inline(__always) func isWhitespaceUnit(_ c: UInt16) -> Bool {
    c == 32 || c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 160 || c == 0x2028 || c == 0x2029 || c == 0xFEFF || c == 0x3000 || (c >= 0x2000 && c <= 0x200A)
}

extension String {
    func trimmingLeadingWhitespace() -> String {
        let u = Array(utf16)
        var i = 0
        while i < u.count && isWhitespaceUnit(u[i]) { i += 1 }
        return i == 0 ? self : String(utf16CodeUnits: Array(u[i...]), count: u.count - i)
    }
}
