import Foundation
import GlideCore
@testable import GlideFeatures
import Testing

private func calc(_ q: String) -> String? { CalcEngine.compute(q)?.text }

@Suite("calculator") struct CalcTests {
    @Test func basics() {
        #expect(calc("1 + 2 * 3") == "7")
        #expect(calc("(1 + 2) * 3") == "9")
        #expect(calc("2^10") == "1024")
        #expect(calc("2 ** 3 ** 2") == "512")
        #expect(calc("-2^2") == "-4")
        #expect(calc("10 / 4") == "2.5")
        #expect(calc("1,000 * 3") == "3000")
        #expect(calc("7 × 6") == "42")
        #expect(calc("42") == nil) // a bare number is not a calculation
        #expect(calc("safari") == nil)
        #expect(calc("5 km in miles") == nil)
    }
    @Test func percentAndOf() {
        #expect(calc("80 + 15%") == "92")
        #expect(calc("15% of 80") == "12")
        #expect(calc("50%") == "0.5")
        #expect(calc("17 % 5") == "2")
        #expect(calc("17 mod 5") == "2")
    }
    @Test func functionsAndConstants() {
        #expect(calc("sqrt(16) + abs(-2)") == "6")
        #expect(calc("max(1, 7, 3)") == "7")
        #expect(calc("min(4,2)") == "2")
        #expect(calc("pow(2, 8)") == "256")
        #expect(calc("hypot(3, 4)") == "5")
        #expect(calc("gcd(12, 18)") == "6")
        #expect(calc("lcm(4, 6)") == "12")
        #expect(calc("log(8, 2)") == "3")
        #expect(calc("log(1000)") == "3")
        #expect(calc("round(3.14159, 2)") == "3.14")
        #expect(calc("5!") == "120")
        #expect(calc("sin(30°)") == "0.5")
        #expect(calc("2pi") == Calculator.format(2 * Double.pi))
        #expect(calc("tau / 2") == Calculator.format(Double.pi))
        #expect(calc("3(4+5)") == "27")
        #expect(calc("cbrt(27)") == "3")
        #expect(calc("root(-8, 3)") == "-2")
    }
    @Test func radix() {
        #expect(calc("255 in hex") == "0xFF")
        #expect(calc("0xff") == "255")
        #expect(calc("0b1010 + 3") == "13")
        #expect(calc("0xff to bin") == "0b11111111")
        #expect(calc("8 as oct") == "0o10")
        #expect(calc("0x10 in dec") == "16")
        #expect(calc("0xF0 | 0x0F") == "255")
        #expect(calc("6 & 3") == "2")
        #expect(calc("1 << 4") == "16")
        #expect(calc("5 xor 1") == "4")
        let r = CalcEngine.compute("200 + 55")
        #expect(r?.alternatives.contains { $0.text == "0xFF" } == true)
        #expect(r?.alternatives.contains { $0.text == "0b11111111" } == true)
    }
    @Test func rowsAreCalculatorKind() {
        let items = CalcEngine.items(for: "2+2", featureId: "calculator")
        #expect(items.first?.item.kind == .calculator)
        #expect(items.first?.item.title == "= 4")
        #expect(items.first?.item.text == "4")
    }
}

@Suite("quicklinks 2.0 templates") struct QLTemplateTests {
    let now: Date = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 14, minute: 5, second: 9))!
    }()
    var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    func env(_ args: [String: String] = [:], clipboard: String = "clip board") -> QLTemplate.Env {
        QLTemplate.Env(now: now, calendar: cal, clipboard: clipboard, selection: "sel/ected", uuid: { "1111-2222" }, arguments: args)
    }

    @Test func parsesPlaceholders() {
        let t = QLTemplate.parse(#"a{argument name="lang" default='en'}b{clipboard | trim | uppercase}"#)
        #expect(t.count == 4)
        if case let .placeholder(p) = t[1] { #expect(p.attrs == ["name": "lang", "default": "en"]) } else { Issue.record("no placeholder") }
        if case let .placeholder(p) = t[3] { #expect(p.modifiers == ["trim", "uppercase"]) } else { Issue.record("no placeholder") }
        for s in [#"{"a": 1}"#, "{nope}", "function() { return 1; }", "{date", "{date bad}", "{clipboard | shout}"] {
            #expect(QLTemplate.render(s, env: env()) == s)
        }
        #expect(QLTemplate.render(#"{argument name="x" default="a|b}c"}"#, env: env()) == "a|b}c")
    }
    @Test func arguments() {
        let defs = QLTemplate.arguments(#"https://x.com/{argument name="lang" default="en"}/{argument name="query"}?t={argument name="type" options="web, images,news"}&again={argument name="query"}"#)
        #expect(defs.map(\.name) == ["lang", "query", "type"])
        #expect(defs[0].optional && defs[0].defaultValue == "en")
        #expect(defs[1].placeholder == "Query" && !defs[1].optional)
        #expect(defs[2].options == ["web", "images", "news"])
        #expect(QLTemplate.arguments("{argument}-{argument}").map(\.name) == ["argument", "argument 2"])
        let d2 = QLTemplate.arguments(#"{argument name="a"}{argument name="b" default="z"}"#)
        #expect(QLCore.values(d2, named: nil, argument: " hi ") == ["a": "hi"])
        #expect(QLCore.values(d2, named: ["a": "x", "b": "y"], argument: "ignored") == ["a": "x", "b": "y"])
        let d3 = QLTemplate.arguments(#"{argument name="q"}{argument name="lang" default="en"}{argument name="t" options="a,b"}"#)
        #expect(QLCore.missing(d3, ["t": "a"]).map(\.name) == ["q"])
        #expect(QLCore.invalidOptions(d3, ["q": "x", "t": "c"]).map(\.name) == ["t"])
        #expect(QLCore.wantsMultiArgument(d3))
        #expect(!QLCore.wantsMultiArgument(QLTemplate.arguments("https://g.com/?q={query}")))
    }
    @Test func urlsAndEncoding() {
        let url = #"https://translate.example/?sl={argument name="from" default="auto"}&tl={argument name="lang" default="en"}&q={argument name="text"}"#
        #expect(QLCore.buildURL(url, env: env(["text": "a&b c/ü", "lang": "de"])) == "https://translate.example/?sl=auto&tl=de&q=a%26b%20c%2F%C3%BC")
        #expect(QLCore.buildURL(#"https://x.com/{argument name="path" raw="true"}?q={query}"#, env: env(["path": "a/b", "query": "c/d"])) == "https://x.com/a/b?q=c%2Fd")
        #expect(QLCore.buildURL("https://x.com/{clipboard | raw}", env: env()) == "https://x.com/clip board")
        #expect(QLCore.buildURL("{clipboard}", env: env(clipboard: "https://a.com/x?y=1")) == "https://a.com/x?y=1")
        #expect(QLCore.buildURL(#"https://x/?c={clipboard}&s={selection}&u={uuid}&d={date format="yyyy-MM-dd"}"#, env: env()) == "https://x/?c=clip%20board&s=sel%2Fected&u=1111-2222&d=2026-10-21")
        #expect(QLCore.buildURL("https://x/{clipboard | uppercase}", env: env()) == "https://x/CLIP%20BOARD")
        #expect(QLCore.buildURL(#"https://x/{argument name="l" default="en"}"#, env: env(["l": ""])) == "https://x/en")
        #expect(QLCore.resolve(#"https://x/{argument name="q"}"#, named: nil, argument: nil, env: env()) == .error("Fill in “q” — Tab moves between arguments"))
        #expect(QLCore.resolve("https://g.com/?q={query}", named: nil, argument: nil, env: env()) == .url("https://g.com/?q="))
    }
    @Test func dates() {
        #expect(QLDates.format(now, "yyyy-MM-dd HH:mm:ss", cal: cal) == "2026-10-21 14:05:09")
        #expect(QLDates.format(now, "EEEE, MMMM d 'at' h:mm a", cal: cal) == "Wednesday, October 21 at 2:05 PM")
        #expect(QLDates.format(now, "EEE d MMM yy, 'Q'Q 'w'ww", cal: cal) == "Wed 21 Oct 26, Q4 w43")
        #expect(QLDates.format(now, "'it''s' yyyy", cal: cal) == "it's 2026")
        #expect(QLDates.format(QLDates.applyOffset(now, "+1d 3h", cal: cal), "yyyy-MM-dd HH", cal: cal) == "2026-10-22 17")
        #expect(QLDates.format(QLDates.applyOffset(now, "-1d+2h", cal: cal), "dd HH", cal: cal) == "20 16")
        let jan31 = cal.date(from: DateComponents(year: 2026, month: 1, day: 31))!
        #expect(QLDates.format(QLDates.applyOffset(jan31, "+1M", cal: cal), "yyyy-MM-dd", cal: cal) == "2026-02-28")
        #expect(QLDates.applyOffset(now, "soon", cal: cal) == now)
        #expect(QLTemplate.render(#"{date} {time} {day} {date offset="+1d" format="d MMM"}"#, env: env()) == "2026-10-21 14:05 Wednesday 22 Oct")
        #expect(!QLTemplate.isDynamic("x {query} {cursor}"))
        #expect(QLTemplate.isDynamic("x {date}"))
    }
    @Test func importExport() throws {
        let list = [Quicklink(id: "a", name: "G", url: "https://g.com/?q={query}", alias: "g", openWith: "/Applications/Safari.app")]
        let back = try QLCore.parseImport(QLCore.exportJSON(list))
        #expect(back.quicklinks.first?.url == "https://g.com/?q={query}" && back.quicklinks.first?.openWith == "/Applications/Safari.app" && back.skipped == 0)
        let r = try QLCore.parseImport(#"[{"name":"Docs","link":"https://d.dev/{argument name=\"q\"}","openWith":"com.google.Chrome"},{"name":""},5]"#)
        #expect(r.quicklinks.count == 1 && r.skipped == 2 && r.quicklinks[0].openWith == "com.google.Chrome")
        #expect(throws: QLCore.ImportError.invalidJSON) { try QLCore.parseImport("nope") }
        #expect(throws: QLCore.ImportError.noQuicklinks) { try QLCore.parseImport("{}") }
        let dd = QLCore.dedupe([Quicklink(id: "", name: "a", url: "https://A.com/"), Quicklink(id: "", name: "b", url: "https://b.com"), Quicklink(id: "", name: "c", url: "https://b.com/")],
                               existing: [Quicklink(id: "x", name: "x", url: "https://a.com")])
        #expect(dd.map(\.url) == ["https://b.com"])
    }
}

@Suite("fallbacks model") struct FallbacksModelTests {
    @Test func defaultsAndOrder() {
        var p = FallbacksModel.Prefs()
        #expect(FallbacksModel.enabled(p, quicklinks: []).map(\.id) == ["google", "files", "ai", "agent", "github", "youtube"])
        p.order = ["github", "google"]
        p.disabled = ["ai"]
        #expect(FallbacksModel.enabled(p, quicklinks: []).map(\.id).prefix(4) == ["github", "google", "files", "agent"])
        p.custom = [.init(id: "custom-1", name: "Search Wiki", url: "https://w.org/?s={query}")]
        p.quicklinks = ["q1"]
        let ql = [Quicklink(id: "q1", name: "Docs", url: "https://d.dev/{query}")]
        let ids = FallbacksModel.ordered(p, quicklinks: ql).map(\.id)
        #expect(ids.contains("custom-1") && ids.contains("ql-q1"))
        #expect(FallbacksModel.Prefs(bag: p.bag) == p)
    }
    @Test func moveFillValidate() {
        #expect(FallbacksModel.move(["a", "b", "c"], "c", by: -1) == ["a", "c", "b"])
        #expect(FallbacksModel.move(["a", "b", "c"], "a", by: -5) == ["a", "b", "c"])
        #expect(FallbacksModel.move(["a", "b", "c"], "a", by: 9) == ["b", "c", "a"])
        #expect(FallbacksModel.fill("https://www.google.com/search?q={query}", query: "a b&c") == "https://www.google.com/search?q=a%20b%26c")
        #expect(FallbacksModel.validate("") == "URL is required")
        #expect(FallbacksModel.validate("https://x") == "URL must contain {query}")
        #expect(FallbacksModel.validate("x.com/{query}") == "URL needs a scheme, e.g. https://")
        #expect(FallbacksModel.validate("https://x/?q={query}") == nil)
    }
}

@Suite("emoji model") struct EmojiModelTests {
    @Test func dataset() {
        #expect(EmojiModel.all.count == 1898)
        #expect(EmojiModel.all.first?.char == "😀")
        #expect(Set(EmojiModel.all.map(\.category)).count == 9)
    }
    @Test func search() {
        #expect(EmojiModel.search("grinning face").first?.char == "😀")
        #expect(EmojiModel.search(":thumbs_up:").first?.name.contains("thumbs up") == true)
        #expect(EmojiModel.search("heart").count > 10)
        #expect(EmojiModel.search("zzzqqq").isEmpty)
        #expect(EmojiModel.search("😀").first?.char == "😀")
    }
    @Test func skinTones() throws {
        let wave = try #require(EmojiModel.find("👋"))
        #expect(EmojiModel.withTone(wave, 0) == "👋")
        #expect(EmojiModel.withTone(wave, 3) == "👋🏽")
        let smile = try #require(EmojiModel.find("😀"))
        #expect(EmojiModel.withTone(smile, 3) == "😀")
    }
    @Test func usageAndGrid() {
        let u: [String: EmojiModel.Usage] = ["a": .init(count: 5, last: 1), "b": .init(count: 1, last: 9), "c": .init(count: 3, last: 2)]
        let s = EmojiModel.usageSections(u, recentN: 1, frequentN: 5)
        #expect(s.recent == ["b"] && s.frequent == ["a", "c"])
        let e = EmojiModel.all
        let rows = EmojiModel.layout([.init(id: "x", title: "X", items: Array(e[0..<5])), .init(id: "y", title: "Y", items: Array(e[5..<8]))], columns: 2)
        #expect(rows.count == 5)
        #expect(EmojiModel.move(rows, .init(row: 0, col: 1), .right) == .init(row: 1, col: 0))
        #expect(EmojiModel.move(rows, .init(row: 2, col: 0), .down) == .init(row: 3, col: 0))
        #expect(EmojiModel.move(rows, .init(row: 0, col: 0), .nextSection) == .init(row: 3, col: 0))
        #expect(EmojiModel.move(rows, .init(row: 4, col: 0), .prevSection) == .init(row: 3, col: 0))
        #expect(EmojiModel.move(rows, .init(row: 3, col: 0), .prevSection) == .init(row: 0, col: 0))
        #expect(EmojiModel.move(rows, .init(row: 0, col: 0), .end) == .init(row: 4, col: 0))
    }
}

@Suite("files", .serialized) @MainActor struct FilesLogicTests {
    func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("n1-files-\(UUID().uuidString)")
        let fm = FileManager.default
        for d in ["docs", "node_modules/pkg", ".hidden", "proj/build", "Photos.app/Contents"] { try fm.createDirectory(at: root.appendingPathComponent(d), withIntermediateDirectories: true) }
        try "quarterly report about glide".write(to: root.appendingPathComponent("docs/Report Q3.txt"), atomically: true, encoding: .utf8)
        try "notes".write(to: root.appendingPathComponent("docs/report-notes.md"), atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent("node_modules/pkg/report.js"), atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent(".hidden/report.txt"), atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent("proj/build/report.o"), atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent("docs/report.tmp"), atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent("Photos.app/Contents/report.plist"), atomically: true, encoding: .utf8)
        return root
    }

    @Test func settingsBagRoundTrip() {
        let s = FilesSettings(bag: ["scopes": ["~/Work"], "includeHidden": true])
        #expect(s.scopes == ["~/Work"] && s.includeHidden && s.showInRootSearch)
        #expect(s.expandedScopes(home: "/Users/me") == ["/Users/me/Work"])
        #expect(FilesSettings(bag: s.bag) == s)
    }

    @Test func exclusionsAndScan() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let ex = FilesExclusions(settings: FilesSettings())
        let hits = ScanFilesBackend.scan(text: "report", mode: .name, scopes: [root.path], ex: ex, limit: 50).map { String($0.dropFirst(root.path.count + 1)) }
        #expect(Set(hits) == ["docs/Report Q3.txt", "docs/report-notes.md"])
        let content = ScanFilesBackend.scan(text: "quarterly", mode: .content, scopes: [root.path], ex: ex, limit: 50)
        #expect(content.count == 1 && content[0].hasSuffix("Report Q3.txt"))
        var withHidden = FilesSettings()
        withHidden.includeHidden = true
        withHidden.exclusions = ["docs/"]
        let h2 = ScanFilesBackend.scan(text: "report", mode: .name, scopes: [root.path], ex: FilesExclusions(settings: withHidden), limit: 50)
        #expect(h2.count == 1 && h2[0].hasSuffix(".hidden/report.txt"))
    }

    @Test func ranking() {
        let r = FilesRanking.rank(["/a/my report.txt", "/a/report.txt", "/b/reporting.md", "/c/xreport"], query: "report", opened: ["/b/reporting.md": 5])
        #expect(r == ["/a/report.txt", "/b/reporting.md", "/a/my report.txt", "/c/xreport"])
    }

    @Test func recentsPersistInElectronFormat() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("data/opened.json")
        let rec = FilesRecents(file: file)
        let p = root.appendingPathComponent("docs/report-notes.md").path
        rec.record(p, at: 1000)
        rec.record(root.appendingPathComponent("gone.txt").path, at: 2000)
        let again = FilesRecents(file: file)
        #expect(again.recent() == [p]) // missing files are hidden
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Double]
        #expect(raw?[p] == 1000)
    }

    @Test func spotlightBackendFindsSystemApp() async throws {
        // Read-only Spotlight query over a system folder (no user data, no prompts).
        let backend = SpotlightFilesBackend()
        defer { backend.stop() }
        let paths: [String] = await withCheckedContinuation { cont in
            var done = false
            backend.start(text: "Calculator", mode: .name, scopes: ["/System/Applications"], limit: 10) { paths, _, finished in
                if finished && !done { done = true; cont.resume(returning: paths) }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(8))
                if !done { done = true; cont.resume(returning: []) }
            }
        }
        #expect(paths.contains("/System/Applications/Calculator.app"))
    }
}
