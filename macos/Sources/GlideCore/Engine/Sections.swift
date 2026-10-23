import Foundation

// Port of src/engine/sections.ts.

public enum SectionTitles {
    public static func title(_ id: SectionID) -> String {
        switch id.rawValue {
        case "favorites": return "Favorites"
        case "suggestions": return "Suggestions"
        case "results": return "Results"
        case "workflows": return "Workflows"
        case "apps": return "Applications"
        case "files": return "Files"
        case "calculator": return "Calculator"
        case "fallbacks": return "Use with…"
        default: return id.rawValue.capitalized
        }
    }
}

private let notSuggested: Set<ItemKind> = [.fallback, .calculator, .file]

private func plain(_ item: SearchItem, _ frecency: Double) -> ScoredItem {
    ScoredItem(item: item, score: frecency, matchScore: 0, matchKind: .none, frecency: frecency, ranges: [])
}

private func shell(_ c: Candidate, _ frecency: Double) -> Ranked {
    Ranked(candidate: c, ranking: .bypass, frecency: frecency, sortHeuristic: 0)
}

/// Empty query: favorites (favorite order) → suggestions (frecency > 1, B4) → workflows (GLIDE CHOICE).
public func buildEmptySections(candidates: [Candidate], favorites: [String], frecencyOf: (String) -> Double, sectionLimit: Int) -> [ResultSection] {
    var sections: [ResultSection] = []
    let favSet = Set(favorites)
    if !favorites.isEmpty {
        var byId: [String: Candidate] = [:]
        for c in candidates { byId[c.item.id] = c }
        var seen = Set<String>()
        let favs = favorites.compactMap { id -> ScoredItem? in
            guard seen.insert(id).inserted, let c = byId[id] else { return nil }
            return plain(c.item, frecencyOf(id))
        }
        if !favs.isEmpty { sections.append(ResultSection(id: .favorites, title: SectionTitles.title(.favorites), items: favs)) }
    }
    var suggested: [Ranked] = []
    for c in candidates {
        if notSuggested.contains(c.item.kind) || favSet.contains(c.item.id) || (c.item.hotkey?.isEmpty == false) { continue }
        let f = frecencyOf(c.item.id)
        if f <= 1 { continue }
        suggested.append(shell(c, f))
    }
    suggested.sort { compareB4($0, $1) < 0 }
    let items = suggested.prefix(sectionLimit).map { plain($0.candidate.item, $0.frecency) }
    if !items.isEmpty { sections.append(ResultSection(id: .suggestions, title: SectionTitles.title(.suggestions), items: Array(items))) }

    var shown = favSet
    for i in items { shown.insert(i.item.id) }
    var workflows: [Ranked] = []
    for c in candidates where c.item.kind == .workflow && !shown.contains(c.item.id) {
        workflows.append(shell(c, frecencyOf(c.item.id)))
    }
    workflows.sort { compareB4($0, $1) < 0 }
    let wf = workflows.prefix(sectionLimit).map { plain($0.candidate.item, $0.frecency) }
    if !wf.isEmpty { sections.append(ResultSection(id: .workflows, title: SectionTitles.title(.workflows), items: Array(wf))) }
    return sections
}

/// Searching: calculator → results → files → fallbacks.
public func buildSearchSections(foldedQuery: String, results: [ScoredItem], calculator: [ScoredItem], files: [ScoredItem],
                                fallbacks: [ScoredItem], sectionLimit: Int, aliasOf: ((String) -> String)? = nil) -> [ResultSection] {
    var sections: [ResultSection] = []
    if !calculator.isEmpty && !suppressesCalculator(results, foldedQuery: foldedQuery, aliasOf: aliasOf) {
        sections.append(ResultSection(id: .calculator, title: SectionTitles.title(.calculator), items: calculator))
    }
    if !results.isEmpty { sections.append(ResultSection(id: .results, title: SectionTitles.title(.results), items: Array(results.prefix(sectionLimit * 2)))) }
    if !files.isEmpty { sections.append(ResultSection(id: .files, title: SectionTitles.title(.files), items: Array(files.prefix(sectionLimit)))) }
    if !fallbacks.isEmpty { sections.append(ResultSection(id: .fallbacks, title: SectionTitles.title(.fallbacks), items: Array(fallbacks.prefix(sectionLimit)))) }
    return sections
}

/// `_Xi`: any visible result whose title or alias starts with the term hides the calculator.
public func suppressesCalculator(_ results: [ScoredItem], foldedQuery: String, aliasOf: ((String) -> String)? = nil) -> Bool {
    if foldedQuery.isEmpty { return false }
    for r in results {
        if foldText(r.item.title).hasPrefix(foldedQuery) { return true }
        let alias = aliasOf?(r.item.id) ?? (r.item.alias.map(foldText) ?? "")
        if !alias.isEmpty && alias.hasPrefix(foldedQuery) { return true }
    }
    return false
}
