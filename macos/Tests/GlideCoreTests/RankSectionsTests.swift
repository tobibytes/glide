import Foundation
import Testing
@testable import GlideCore

private let T0: Double = 1_700_000_000_000
private let DAY: Double = 86_400_000

private func item(_ id: String, _ title: String, kind: ItemKind = .app, subtitle: String? = nil, keywords: [String]? = nil,
                  alias: String? = nil, hotkey: String? = nil, url: String? = nil, acceptsArgument: Bool? = nil, path: String? = nil) -> SearchItem {
    SearchItem(id: id, kind: kind, title: title, subtitle: subtitle, keywords: keywords, alias: alias, hotkey: hotkey, path: path, url: url, acceptsArgument: acceptsArgument)
}
private func usage(_ id: String, _ launches: [Double]) -> UsageRecord {
    UsageRecord(itemId: id, launches: launches, count: launches.count, lastLaunchedAt: launches.max()!)
}
private func engine(_ now: Double = T0, _ configure: (inout EngineOptions) -> Void = { _ in }) -> SearchEngine {
    var o = EngineOptions()
    configure(&o)
    return SearchEngine(options: o, now: { now })
}
private func titles(_ items: [SearchItem], _ q: String, _ records: [UsageRecord] = [], now: Double = T0) -> [String] {
    var e = engine(now)
    e.setItems(items)
    e.setUsage(records)
    return e.search(q).sections.first { $0.id == .results }?.items.map(\.item.title) ?? []
}
private func dyn(_ it: SearchItem, _ score: Double, _ kind: MatchKind) -> ScoredItem {
    ScoredItem(item: it, score: score, matchScore: score, matchKind: kind, frecency: 0, ranges: [])
}

/// Mutable clock for tests that move time.
private final class Clock: @unchecked Sendable { var now = T0 }

@Suite("rank — tiers")
struct RankTiers {
    @Test func exactAliasBeatsEverything() {
        let items = [item("code", "Code"), item("term", "Terminal", alias: "code")]
        #expect(titles(items, "code", [usage("code", [T0 - 1000, T0 - 2000, T0 - 3000])]) == ["Terminal", "Code"])
    }
    @Test func exactBeatsPrefixBeatsFuzzy() {
        let items = [item("x", "Xcode"), item("n", "Notes"), item("note", "Note"), item("sn", "Sticky Notes")]
        #expect(titles(items, "note") == ["Note", "Notes", "Sticky Notes"])
    }
    @Test func wholeWordFloorAndGate() {
        let items = [item("codex", "Codex"), item("vsc", "Visual Studio Code"), item("xcode", "Xcode")]
        #expect(titles(items, "code") == ["Visual Studio Code", "Codex"])
    }
    @Test func frecencyBreaksEqualClasses() {
        let items = [item("a", "Safari"), item("b", "Sabre")]
        #expect(titles(items, "sa") == ["Sabre", "Safari"])
        #expect(titles(items, "sa", [usage("a", [T0 - 1000])]) == ["Safari", "Sabre"])
    }
    @Test func frecencyDecays() {
        let items = [item("a", "Safari"), item("b", "Sabre")]
        #expect(titles(items, "sa", [usage("a", [T0 - 40 * DAY]), usage("b", [T0 - DAY])]) == ["Sabre", "Safari"])
    }
    @Test func kindPriority() {
        let items = [item("s", "Lock", kind: .setting), item("q", "Lock", kind: .quicklink), item("sys", "Lock", kind: .system), item("app", "Lock", kind: .app)]
        var e = engine()
        e.setItems(items)
        #expect(e.search("lock").sections[0].items.map(\.item.kind) == [.app, .system, .quicklink, .setting])
    }
    @Test func keywordOnlySortsLast() {
        let items = [item("k", "Preview", keywords: ["image", "pdf"]), item("i", "Image Capture"), item("z", "Pixelmator")]
        #expect(titles(items, "image") == ["Image Capture", "Preview"])
        var e = engine()
        e.setItems(items)
        let res = e.search("pdf").sections[0].items
        #expect(res.map(\.item.title) == ["Preview"])
        #expect(res[0].matchKind == .keyword)
        #expect(res[0].ranges.isEmpty)
    }
    @Test func keywordOnlyLosesToTitleEvenWithFrecency() {
        let items = [item("k", "Preview", keywords: ["image"]), item("i", "Image Capture")]
        #expect(titles(items, "image", [usage("k", [T0 - 1000, T0 - 2000, T0 - 3000])]) == ["Image Capture", "Preview"])
    }
    @Test func hotkeysNeverAffectOrder() {
        #expect(titles([item("a", "Safari", hotkey: "⌥⌘S"), item("b", "Sabre")], "sa") == ["Sabre", "Safari"])
        #expect(titles([item("a", "Safari"), item("b", "Sabre", hotkey: "⌥⌘S")], "sa") == ["Sabre", "Safari"])
    }
    @Test func aliasPrefixOutranksFuzzy() {
        #expect(titles([item("a", "Zed", alias: "editor"), item("b", "Edit Something")], "edi") == ["Zed", "Edit Something"])
    }
    @Test func subtitleExact() {
        #expect(titles([item("a", "Finder", subtitle: "files"), item("b", "Files Lite")], "files") == ["Finder", "Files Lite"])
    }
    @Test func highSensitivityFilters() {
        #expect(titles([item("a", "xaxbxcx"), item("b", "abc")], "abc") == ["abc"])
    }
    @Test func storedTermLifts() {
        var e = engine()
        e.setItems([item("a", "Slack"), item("b", "Slides Pro")])
        e.recordUsage("b", searchTerm: "sl")
        #expect(e.search("sl").sections[0].items.map(\.item.title) == ["Slides Pro", "Slack"])
    }
    @Test func storedTermsExpire() {
        let clock = Clock()
        var e = SearchEngine(options: EngineOptions(), now: { clock.now })
        e.setItems([item("a", "Slack"), item("b", "Slides Pro")])
        e.recordUsage("b", searchTerm: "sl")
        clock.now = T0 + 18 * DAY
        #expect(e.search("sl").sections[0].items.map(\.item.title) == ["Slides Pro", "Slack"])
        e.recordUsage("a")
        e.recordUsage("a")
        #expect(e.search("sl").sections[0].items.map(\.item.title) == ["Slack", "Slides Pro"])
    }
    @Test func configuredAliasesOverride() {
        var e = engine { $0.aliases = ["b": "code"] }
        e.setItems([item("a", "Code"), item("b", "Terminal", alias: "zz")])
        #expect(e.search("code").sections[0].items[0].item.title == "Terminal")
        e.configure { $0.aliases = [:] }
        #expect(e.search("code").sections[0].items[0].item.title == "Code")
    }
}

@Suite("rank — primitives")
struct RankPrimitives {
    let ctx = EvalContext(sensitivity: .high, frecency: 1, searchTerms: [])
    @Test func nonMatching() { #expect(evaluate(Candidate(item: item("a", "Safari")), prepareQuery("zzz"), ctx) == nil) }
    @Test func prefixBypassesGate() {
        #expect(evaluate(Candidate(item: item("a", "Safari")), prepareQuery("s"), ctx)!.ranking.titleMatch == .prefix)
    }
    @Test func compareOrders() {
        let q = prepareQuery("vsc")
        let a = evaluate(Candidate(item: item("a", "Visual Studio Code")), q, ctx)!
        let b = evaluate(Candidate(item: item("b", "Vscode", subtitle: "Visual Studio Code")), q, ctx)!
        let flags = computeFlags([a, b], queryLen: 3)
        #expect(compareRanked(flags, a, b).signum() == compareTitles("Visual Studio Code", "Vscode").signum())
        var c = a
        c.frecency = 50
        #expect(compareRanked(flags, c, b) < 0)
    }
}

@Suite("rank — presentation")
struct RankPresentation {
    @Test func matchKindsRangesScores() {
        var e = engine()
        e.setItems([item("a", "Visual Studio Code"), item("b", "Vsc"), item("c", "Vscope"), item("d", "Term", alias: "vsc")])
        let res = e.search("vsc").sections[0].items
        #expect(res.map(\.matchKind) == [.alias, .exact, .acronym, .prefix])
        #expect(res[3].ranges == [MatchRange(start: 0, end: 3)])
        #expect(res[2].ranges == [MatchRange(start: 0, end: 1), MatchRange(start: 7, end: 8), MatchRange(start: 14, end: 15)])
        #expect(res[2].matchScore == 8)
        #expect(res[3].matchScore == 8)
        for i in 1..<res.count { #expect(res[i].score < res[i - 1].score) }
    }
}

@Suite("sections — empty query")
struct EmptySections {
    @Test func freshInstallShowsWorkflows() {
        var e = engine()
        e.setItems([item("app", "Safari"), item("w1", "Morning Setup", kind: .workflow), item("w2", "Quick Note", kind: .workflow)])
        let res = e.search("")
        #expect(res.sections.map(\.id) == [.workflows])
        #expect(res.sections[0].items.map(\.item.title).sorted() == ["Morning Setup", "Quick Note"])
    }
    @Test func noRepeatOfSuggestedWorkflow() {
        var e = engine()
        e.setItems([item("w1", "Morning Setup", kind: .workflow), item("w2", "Quick Note", kind: .workflow)])
        e.setUsage([usage("w1", [T0 - 1000])])
        let res = e.search("")
        #expect(res.sections.map(\.id) == [.suggestions, .workflows])
        #expect(res.sections[1].items.map(\.item.id) == ["w2"])
    }
    @Test func favoritesThenSuggestions() {
        var e = engine { $0.favorites = ["c", "a"] }
        e.setItems([item("a", "Alpha"), item("b", "Beta"), item("c", "Gamma"), item("d", "Delta"), item("h", "Hot", hotkey: "⌘H"), item("f", "Fallback", kind: .fallback)])
        e.setUsage([usage("a", [T0 - 1000]), usage("b", [T0 - 1000]), usage("d", [T0 - 1000, T0 - 2000]),
                    usage("h", [T0 - 500, T0 - 600, T0 - 700]), usage("f", [T0 - 500, T0 - 600, T0 - 700])])
        let res = e.search("")
        #expect(res.sections.map(\.id) == [.favorites, .suggestions])
        #expect(res.sections[0].items.map(\.item.id) == ["c", "a"])
        #expect(res.sections[1].items.map(\.item.id) == ["d", "b"])
        #expect(res.sections[1].items[0].frecency > res.sections[1].items[1].frecency)
    }
    @Test func whitespaceIsEmpty() {
        var e = engine()
        e.setItems([item("a", "Alpha")])
        #expect(e.search("   ").sections.isEmpty)
    }
    @Test func sectionLimit() {
        var e = engine { $0.sectionLimit = 2 }
        e.setItems([item("a", "A"), item("b", "B"), item("c", "C")])
        e.setUsage([usage("a", [T0 - 1]), usage("b", [T0 - 2]), usage("c", [T0 - 3])])
        #expect(e.search("").sections[0].items.count == 2)
        e.configure { $0.sectionLimit = 3 }
        #expect(e.search("").sections[0].items.count == 3)
    }
}

@Suite("sections — searching")
struct SearchSections {
    @Test func argumentExtraction() {
        var e = engine()
        e.setItems([item("g", "Google", kind: .quicklink, alias: "g", url: "https://google.com/search?q={query}", acceptsArgument: true),
                    item("gh", "GitHub", kind: .quicklink, acceptsArgument: true), item("ge", "Gelectron Thing")])
        let results = e.search("g electron").sections.first { $0.id == .results }!
        #expect(results.items[0].item.id == "g")
        #expect(results.items[0].argument == "electron")
        #expect(results.items[0].matchKind == .alias)
        #expect(results.items.dropFirst().allSatisfy { $0.argument == nil })
    }
    @Test func argumentTitlePrefix() {
        var e = engine()
        e.setItems([item("w", "Translate", kind: .workflow, acceptsArgument: true), item("t", "Terminal")])
        let res = e.search("trans hello world")
        #expect(res.sections[0].items[0].item.id == "w")
        #expect(res.sections[0].items[0].argument == "hello world")
    }
    /// Integration regression: with many features, the first word often prefix-matches some OTHER acceptsArgument
    /// item ("Search Bookmarks" for "search snippets"); typing a whole multi-word title must not pin that item.
    @Test func wholeTitleBeatsFirstWordArgument() {
        var e = engine()
        e.setItems([item("bm", "Search Bookmarks", kind: .command, acceptsArgument: true), item("sn", "Search Snippets", kind: .command),
                     item("ag", "Ask Glide Agent", kind: .command, acceptsArgument: true), item("wf", "Ask Name Demo", kind: .workflow)])
        let r1 = e.search("search snippets").sections.first { $0.id == .results }!
        #expect(r1.items[0].item.id == "sn")
        #expect(r1.items.allSatisfy { $0.argument == nil })
        #expect(e.search("ask name demo").sections[0].items[0].item.id == "wf")
        // A prefix of a title still counts ("search sni"), and a real argument still works.
        #expect(e.search("search sni").sections[0].items[0].item.id == "sn")
        #expect(e.search("ask what time is it").sections[0].items[0].item.id == "ag")
        #expect(e.search("ask what time is it").sections[0].items[0].argument == "what time is it")
    }
    @Test func noArgumentWithoutAccepts() {
        var e = engine()
        e.setItems([item("t", "Terminal")])
        #expect(e.search("terminal foo").sections.first { $0.id == .results } == nil)
    }
    @Test func calculatorAndFiles() {
        var e = engine()
        e.setItems([item("a", "2048 Game")])
        let res = e.search("2+2", dynamicItems: [
            dyn(item("calc", "4", kind: .calculator), 1000, .exact),
            dyn(item("f1", "2+2.txt", kind: .file, path: "/tmp/2+2.txt"), 25, .fuzzy),
            dyn(item("f2", "notes 2+2", kind: .file), 30, .fuzzy),
        ])
        #expect(res.sections.map(\.id) == [.calculator, .files])
        #expect(res.sections[1].items.map(\.item.id) == ["f2", "f1"])
        #expect(res.total == 4)
    }
    @Test func calculatorSuppressed() {
        var e = engine()
        e.setItems([item("pi", "Pixelmator")])
        let res = e.search("pi", dynamicItems: [dyn(item("calc", "3.14159", kind: .calculator), 1000, .exact)])
        #expect(res.sections.map(\.id) == [.results])
    }
    @Test func fallbacksLast() {
        var e = engine()
        e.setItems([item("a", "Safari"), item("fb", "Search Google", kind: .fallback, url: "https://google.com/search?q={query}")])
        let res = e.search("saf")
        #expect(res.sections.map(\.id) == [.results, .fallbacks])
        #expect(res.sections[0].items.map(\.item.id) == ["a"])
        #expect(res.sections[1].items[0].argument == "saf")
        #expect(e.search("zzz").sections.map(\.id) == [.fallbacks])
    }
    @Test func limits() {
        var e = engine { $0.sectionLimit = 2 }
        e.setItems((0..<10).map { item("a\($0)", "Alpha \($0)") })
        let files = (0..<5).map { dyn(item("f\($0)", "alpha\($0).txt", kind: .file), 25, .fuzzy) }
        let res = e.search("alpha", dynamicItems: files)
        #expect(res.sections.first { $0.id == .results }!.items.count == 4)
        #expect(res.sections.first { $0.id == .files }!.items.count == 2)
    }
    @Test func otherDynamicKindsMerged() {
        var e = engine()
        e.setItems([item("a", "Safari")])
        let res = e.search("saf", dynamicItems: [dyn(item("s", "Safe Snippet", kind: .snippet), 10, .fuzzy), dyn(item("x", "Unrelated", kind: .snippet), 5, .none)])
        #expect(res.sections[0].items.map(\.item.id) == ["a", "s", "x"])
    }
    @Test func verbatimQuery() {
        var e = engine()
        e.setItems([item("a", "Safari")])
        let res = e.search("Saf ")
        #expect(res.query == "Saf ")
        #expect(res.tookMs >= 0)
    }
}

@Suite("usage round-trip")
struct UsageRoundTrip {
    @Test func persistAndRestore() throws {
        var e = engine()
        e.setItems([item("a", "Safari")])
        let rec = e.recordUsage("a", searchTerm: "saf")
        #expect(rec.count == 1)
        #expect(rec.launches == [T0])
        #expect(rec.lastLaunchedAt == T0)
        var restored = engine(T0 + 1)
        restored.setItems([item("a", "Safari")])
        let json = try JSONEncoder().encode(e.usageRecords)
        restored.setUsage(try JSONDecoder().decode([UsageRecord].self, from: json))
        #expect(abs(restored.search("").sections[0].items[0].frecency - 101) < 0.01)
    }
    @Test func boundedRing() {
        var e = engine()
        e.setItems([item("a", "Safari")])
        var rec = e.recordUsage("a")
        for _ in 0..<14 { rec = e.recordUsage("a") }
        #expect(rec.launches.count == 10)
        #expect(rec.count == 15)
    }
}

@Suite("argument extraction vs multi-word titles")
struct MultiWord {
    @Test func fullyTypedTitle() {
        var e = engine()
        e.setItems([item("s", "Two Args", kind: .command, acceptsArgument: true)])
        let top = e.search("two args").flattened.first
        #expect(top?.item.id == "s")
        #expect(top?.argument == nil)
    }
    @Test func beyondTitle() {
        var e = engine()
        e.setItems([item("g", "Google", kind: .quicklink, acceptsArgument: true)])
        let top = e.search("google electron").flattened.first
        #expect(top?.item.id == "g")
        #expect(top?.argument == "electron")
    }
}

@Suite("performance guard")
struct Performance {
    @Test func twoThousandItemsFiftyQueries() {
        var e = engine()
        let words = ["Safari", "Notes", "Calendar", "Visual", "Studio", "Code", "Terminal", "Finder", "Preview", "Music", "Photos", "Mail"]
        e.setItems((0..<2000).map { i in item("i\(i)", "\(words[i % words.count]) \(words[(i / 7) % words.count]) \(i)", subtitle: i % 3 == 0 ? "Utility \(i)" : nil) })
        let queries = ["s", "sa", "saf", "vsc", "code", "term", "no", "cal", "fin", "pre", "mu", "ph", "ma", "vis stu", "x"]
        let start = Date()
        for i in 0..<50 { _ = e.search(queries[i % queries.count]) }
        let perQuery = Date().timeIntervalSince(start) * 1000 / 50
        // Soft target < 5 ms in release; debug builds are ~5–10× slower, so the hard guard is generous.
        #expect(perQuery < 150, "average \(perQuery) ms per query")
    }
}
