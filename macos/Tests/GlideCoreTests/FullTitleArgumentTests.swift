import Foundation
import Testing
@testable import GlideCore

/// Fix round: an acceptsArgument item's WHOLE multi-word title followed by text takes the text as its argument
/// ("search files report"), instead of the first-word rule handing "files report" to another "Search …" item.
@Suite("search engine: full-title inline arguments")
struct FullTitleArgumentTests {
    func engine(_ items: [SearchItem]) -> SearchEngine {
        var e = SearchEngine(options: EngineOptions(), now: { 1_700_000_000_000 })
        e.setItems(items)
        return e
    }
    func first(_ e: SearchEngine, _ q: String) -> ScoredItem? { e.search(q).sections.flatMap(\.items).first }

    let items = [
        SearchItem(id: "snip", kind: .command, title: "Search Snippets", acceptsArgument: true),
        SearchItem(id: "files", kind: .command, title: "Search Files", acceptsArgument: true),
        SearchItem(id: "bm", kind: .command, title: "Search Bookmarks", acceptsArgument: true),
        SearchItem(id: "clip", kind: .command, title: "Clipboard History", acceptsArgument: true),
        SearchItem(id: "ask", kind: .command, title: "Ask Glide Agent", acceptsArgument: true),
    ]

    @Test func wholeTitleThenText() {
        let e = engine(items)
        #expect(first(e, "search files quarterly report")?.item.id == "files")
        #expect(first(e, "search files quarterly report")?.argument == "quarterly report")
        #expect(first(e, "Search Snippets sig")?.item.id == "snip")
        #expect(first(e, "Search Snippets sig")?.argument == "sig")
        #expect(first(e, "clipboard history  abc")?.argument == "abc")
    }

    @Test func titleAloneAndFirstWordRuleUnchanged() {
        let e = engine(items)
        #expect(first(e, "search files")?.argument == nil)
        #expect(first(e, "ask what time is it")?.item.id == "ask")
        #expect(first(e, "ask what time is it")?.argument == "what time is it")
    }

    @Test func notWhileTypingALongerTitle() {
        let e = engine(items + [SearchItem(id: "folder", kind: .command, title: "Search Files in Folder")])
        let top = first(e, "search files in")
        #expect(top?.argument == nil)
        #expect(top?.item.id == "folder")
    }
}
