import Foundation
import Testing
@testable import GlideCore
@testable import GlideFeatures

// Ports of src/main/snippets/{snippets,responder}.test.ts and the date tests of quicklinks.test.ts.

private func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0, _ s: Int = 0) -> Date {
    Calendar.current.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi, second: s)) ?? Date()
}
private let NOW = date(2026, 10, 21, 9, 30)
private func env(clipboard: String? = "CLIP", selection: String? = nil, snippet: ((String) -> String?)? = nil, now: Date = NOW) -> SnipTemplate.Env {
    SnipTemplate.Env(now: now, clipboard: clipboard, selection: selection, uuid: { "u-1" }, snippet: snippet)
}
private func sn(_ id: String, _ name: String, _ text: String, keyword: String? = nil, html: String? = nil, excluded: [String]? = nil) -> Snippet {
    Snippet(id: id, name: name, text: text, keyword: keyword, html: html, excludedApps: excluded)
}
private func render(_ text: String, html: String? = nil, _ e: SnipTemplate.Env = env()) -> RenderedSnippet { SnipRender.render(text: text, html: html, env: e) }

@Suite("snippet rendering")
struct SnippetRenderTests {
    @Test func placeholders() {
        #expect(render(#"{clipboard} {date format="dd/MM/yyyy"} {date offset="+1d" format="EEE"} {time format="h:mm a"} {uuid}"#) == RenderedSnippet(text: "CLIP 21/10/2026 Thu 9:30 AM u-1"))
        #expect(render("{clipboard}", env(clipboard: "a b&c")).text == "a b&c")
        #expect(render("{selection}!", env(selection: "sel")).text == "sel!")
        #expect(render(#"{clipboard | uppercase} {clipboard | json-stringify}"#, env(clipboard: "a\"b")).text == #"A"B "a\"b""#)
        // Not a placeholder: stays literal (JSON / code survive).
        #expect(render(#"{"a": 1} {unknown} {date format="x"#).text == #"{"a": 1} {unknown} {date format="x"#)
    }
    @Test func cursor() {
        #expect(render("Hello {cursor}, bye") == RenderedSnippet(text: "Hello , bye", cursorLeft: 5))
        #expect(render("<div>{cursor}</div>") == RenderedSnippet(text: "<div></div>", cursorLeft: 6))
        #expect(render("{cursor}").cursorLeft == 0)
        #expect(render(#"({cursor}) {date format="yyyy"}"#) == RenderedSnippet(text: "() 2026", cursorLeft: 6))
        #expect(SnipRender.cursorLeftCount("👍🏽é\r\nx") == 4)
        #expect(SnipRender.cursorLeftCount("🇳🇬") == 1)
        #expect(SnipRender.placeCursor("a\u{E000}b\u{E000}c") == ("abc", 2))
    }
    @Test func nestedSnippetsWithCycleGuard() {
        let all = [sn("1", "sig", "Best,\n{snippet name=\"me\"}"), sn("2", "me", "Olu {snippet name=\"sig\"}", keyword: ";me"), sn("3", "x", "{snippet name=\";me\"}!")]
        let lookup = SnipRender.lookup(all)
        #expect(render(all[0].text, env(snippet: lookup)).text == "Best,\nOlu Best,\n")
        #expect(render(all[2].text, env(snippet: lookup)).text == "Olu Best,\nOlu !")
        #expect(render("{snippet name=\"missing\"}x", env(snippet: lookup)).text == "x")
    }
    @Test func richText() {
        #expect(render("Hi {clipboard}", html: "<b>Hi</b> {clipboard}", env(clipboard: "<you>")) == RenderedSnippet(text: "Hi <you>", html: "<b>Hi</b> &lt;you&gt;"))
    }
    @Test func htmlHelpers() {
        #expect(SnipRender.htmlToText("<p>Hi&nbsp;<b>there</b></p><ul><li>one</li><li>two</li></ul>a<br>b &amp; &#x41;") == "Hi there\n• one\n• two\na\nb & A")
        #expect(SnipRender.sanitizeHTML(#"<b onclick="x()">x</b><script>alert(1)</script><a href="javascript:evil()">l</a>"#) == ##"<b>x</b><a href="#">l</a>"##)
    }
}

@Suite("snippet dates")
struct SnippetDateTests {
    let now = date(2026, 10, 21, 14, 5, 9)
    @Test func formats() {
        #expect(SnipDates.format(now, "yyyy-MM-dd HH:mm:ss") == "2026-10-21 14:05:09")
        #expect(SnipDates.format(now, "EEEE, MMMM d 'at' h:mm a") == "Wednesday, October 21 at 2:05 PM")
        #expect(SnipDates.format(now, "EEE d MMM yy, 'Q'Q 'w'ww") == "Wed 21 Oct 26, Q4 w43")
        #expect(SnipDates.format(now, "'it''s' yyyy") == "it's 2026")
    }
    @Test func offsets() {
        func f(_ o: String, _ fmt: String, base: Date? = nil) -> String { SnipDates.format(SnipDates.applyOffset(base ?? now, o), fmt) }
        #expect(f("+1d", "yyyy-MM-dd") == "2026-10-22")
        #expect(f("-2w", "yyyy-MM-dd") == "2026-10-07")
        #expect(f("+1d 3h", "yyyy-MM-dd HH") == "2026-10-22 17")
        #expect(f("-1d+2h", "dd HH") == "20 16")
        #expect(f("+1M", "yyyy-MM-dd", base: date(2026, 1, 31)) == "2026-02-28")
        #expect(f("+1y", "yyyy") == "2027")
        #expect(f("+30m", "HH:mm") == "14:35")
        #expect(SnipDates.applyOffset(now, "soon") == now)
    }
    @Test func defaultsInTemplates() {
        #expect(SnipTemplate.render(#"{date} {time} {day} {date offset="+1d" format="d MMM"}"#, env(now: now)) == "2026-10-21 14:05 Wednesday 22 Oct")
        #expect(SnipTemplate.isDynamic("x {date}"))
        #expect(!SnipTemplate.isDynamic("x {cursor} {argument}"))
    }
}

@Suite("keyword prefix, case-adaptive, exclusions")
struct SnippetExpansionTests {
    @Test func prefix() {
        #expect(SnipExpansion.effectiveKeyword("sig", prefix: ";") == ";sig")
        #expect(SnipExpansion.effectiveKeyword(";sig", prefix: ";") == ";sig")
        #expect(SnipExpansion.effectiveKeyword(" sig ", prefix: "") == "sig")
        let list = SnipExpansion.buildList([sn("1", "Signature", "Olu", keyword: "sig")], settings: SnippetSettings(keywordPrefix: ";"), env: env())
        #expect(list.map(\.keyword) == [";sig"])
        #expect(!"design".hasSuffix(list[0].keyword))
        #expect("de;sig".hasSuffix(list[0].keyword))
    }
    @Test func warnings() {
        #expect(SnipExpansion.keywordWarning("sig", prefix: "")?.contains("inside a longer word") == true)
        #expect(SnipExpansion.keywordWarning("sig", prefix: ";") == nil)
        #expect(SnipExpansion.keywordWarning("!sig", prefix: "") == nil)
    }
    @Test func caseVariants() {
        typealias V = SnipExpansion.Variant
        #expect(SnipExpansion.caseVariants(";addr", "12 main st") == [V(keyword: ";addr", text: "12 main st"), V(keyword: ";Addr", text: "12 Main st"), V(keyword: ";ADDR", text: "12 MAIN ST")])
        #expect(SnipExpansion.caseVariants("sig", "best, olu") == [V(keyword: "sig", text: "best, olu"), V(keyword: "Sig", text: "Best, olu"), V(keyword: "SIG", text: "BEST, OLU")])
        #expect(SnipExpansion.caseVariants("mySig", "x") == [V(keyword: "mySig", text: "x")])
        #expect(SnipExpansion.caseVariants(";;1", "x") == [V(keyword: ";;1", text: "x")])
    }
    @Test func listLongestFirstRenderedWithoutCursor() {
        let list = SnipExpansion.buildList([sn("1", "a", "Today is {date}{cursor}.", keyword: "td"), sn("2", "b", "x", keyword: "td2"), sn("3", "dup", "y", keyword: "td"), sn("4", "none", "z")],
                                           settings: SnippetSettings(keywordPrefix: "!"), env: env())
        #expect(list == [.init(keyword: "!td2", text: "x", snippetId: "2"), .init(keyword: "!td", text: "Today is 2026-10-21.", snippetId: "1")])
        #expect(SnipExpansion.buildList([sn("1", "h", "", keyword: ";h", html: "<b>Bold</b>")], settings: SnippetSettings(), env: env()).first?.text == "Bold")
    }
    @Test func planAdaptsCase() {
        let s = sn("1", "sig", "best,{cursor} olu", keyword: "sig")
        let ca = SnippetSettings(caseAdaptive: true)
        #expect(SnipExpansion.plan(typed: "Sig", snippet: s, all: [s], settings: ca, env: env()) == .init(deleteCount: 3, text: "Best, olu", html: nil, cursorLeft: 4))
        #expect(SnipExpansion.plan(typed: "SIG", snippet: s, all: [s], settings: ca, env: env()) == .init(deleteCount: 3, text: "BEST, OLU", html: nil, cursorLeft: 4))
        #expect(SnipExpansion.plan(typed: ";sig", snippet: s, all: [s], settings: SnippetSettings(), env: env()) == .init(deleteCount: 4, text: "best, olu", html: nil, cursorLeft: 4))
    }
    @Test func exclusions() {
        let settings = SnippetSettings(bag: ["excludedApps": ["com.apple.Terminal"]])
        let snippets = [sn("1", "a", "A", keyword: ";a", excluded: ["com.microsoft.VSCode"]), sn("2", "b", "B", keyword: ";b")]
        #expect(!SnipExpansion.expandsIn(snippets[0], settings, bundleId: "com.microsoft.vscode"))
        #expect(SnipExpansion.expandsIn(snippets[1], settings, bundleId: "com.microsoft.VSCode"))
        #expect(!SnipExpansion.expandsIn(snippets[1], settings, bundleId: "com.apple.Terminal"))
        #expect(SnipExpansion.expandsIn(snippets[0], settings, bundleId: nil))
        #expect(SnipExpansion.buildList(snippets, settings: settings, env: env(), frontmostBundleId: "com.microsoft.VSCode").map(\.keyword) == [";b"])
        #expect(SnipExpansion.buildList(snippets, settings: settings, env: env(), frontmostBundleId: "com.apple.Terminal").isEmpty)
        #expect(SnipExpansion.needsRefresh([sn("1", "a", "{date}", keyword: "x")]))
        #expect(!SnipExpansion.needsRefresh([sn("1", "a", "{date}")]))
    }
    @Test func sanitizesSettings() {
        #expect(SnippetSettings(bag: ["keywordPrefix": " ; ", "caseAdaptive": "yes", "excludedApps": ["a", 3, " "]]) == SnippetSettings(keywordPrefix: ";", caseAdaptive: false, excludedApps: ["a"]))
    }
    @Test func tapEntriesMarkOnlyLiveSnippets() {
        let list = SnipExpansion.tapEntries([sn("plain", "plain", "Best, Olu", keyword: "sig"), sn("dyn", "dyn", "{clipboard}", keyword: "cb"),
                                             sn("cur", "cur", "a{cursor}b", keyword: "cur", excluded: ["com.microsoft.VSCode"]), sn("rich", "rich", "bold", keyword: "b", html: "<b>bold</b>")],
                                            settings: SnippetSettings(keywordPrefix: ";", excludedApps: ["com.apple.Terminal"]), env: env(clipboard: nil))
        #expect(list.map(\.keyword) == [";sig", ";cur", ";cb", ";b"])
        #expect(list.map(\.id) == [nil, "cur", "dyn", "rich"])
        #expect(list.map(\.text) == ["Best, Olu", "ab", "", "bold"])
        #expect(list[1].excludedBundleIds == ["com.microsoft.VSCode"])
        #expect(!SnipExpansion.needsLiveRender(sn("a", "a", "static")))
        #expect(SnipExpansion.needsLiveRender(sn("a", "a", "{time}")))
        #expect(SnipExpansion.needsLiveRender(sn("a", "a", "x{cursor}")))
        #expect(SnipExpansion.needsLiveRender(sn("a", "a", "x", html: "<i>x</i>")))
    }
}

@Suite("snippet import / export")
struct SnippetIOTests {
    @Test func raycastImport() throws {
        let raycast = #"[{"name":"Signature","text":"Best,\n{cursor}\n{clipboard}","keyword":"!sig"},{"name":"Tab","text":"Current: {browser-tab}"},{"name":"","text":"x"}]"#
        let r = try SnipIO.parse(raycast)
        #expect(r.snippets.map(\.name) == ["Signature", "Tab"])
        #expect(r.snippets[0].keyword == "!sig" && r.snippets[0].text == "Best,\n{cursor}\n{clipboard}")
        #expect(r.snippets[1].keyword == nil)
        #expect(r.skipped == 1)
        #expect(r.unsupported == ["{browser-tab}"])
        #expect(throws: (any Error).self) { try SnipIO.parse("nope") }
        #expect(throws: (any Error).self) { try SnipIO.parse(#"{"x":1}"#) }
    }
    @Test func glideRoundTrip() throws {
        let list = [sn("a", "A", "t", keyword: ";a", html: "<b>t</b>", excluded: ["x"])]
        let back = try SnipIO.parse(SnipIO.export(list, now: NOW)).snippets
        #expect(back.count == 1 && back[0].name == "A" && back[0].html == "<b>t</b>" && back[0].keyword == ";a" && back[0].excludedApps == ["x"])
        #expect(SnipIO.export(list).contains("\"format\" : \"glide.snippets\""))
    }
    @Test func mergeSkipsDuplicatesAndKeywordConflicts() {
        let r = SnipIO.merge([sn("", "A", "t"), sn("", "B", "u", keyword: ";a"), sn("", "C", "v", keyword: ";c")], existing: [sn("1", "a", "t", keyword: ";a")])
        #expect(r.add.map(\.name) == ["B", "C"])
        #expect(r.add.map(\.keyword) == [nil, ";c"])
        #expect(r.duplicates == 1 && r.keywordConflicts == 1)
    }
}
