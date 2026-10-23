import Foundation
import GlideCore
@testable import GlideFeatures
import Testing

private func run(_ id: String, _ input: String, _ opts: TransformOptions = TransformOptions()) throws -> String {
    switch TextTransforms.apply(id, input, opts) {
    case let .ok(o): return o
    case let .failure(e): throw TransformError(e)
    }
}

private func fails(_ id: String, _ input: String) -> String {
    let r = TextTransforms.apply(id, input)
    #expect(r.output == nil, "\(id) should fail")
    return r.error ?? ""
}

private func b64url(_ s: String) -> String {
    Data(s.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

@Suite("text transforms (port of transforms.test.ts)")
struct TransformsTests {
    @Test func catalogue() {
        #expect(TextTransforms.all.count == 33)
        #expect(Set(TextTransforms.all.map(\.id)).count == TextTransforms.all.count)
        for t in TextTransforms.all { #expect(!t.keywords.isEmpty) }
        #expect(TextTransforms.all.map(\.id).prefix(3) == ["upper", "lower", "title"])
    }

    @Test func splitsWords() {
        #expect(TextTransforms.splitWords("fooBar baz-qux_HTTPServer") == ["foo", "Bar", "baz", "qux", "HTTP", "Server"])
    }

    @Test func caseTransforms() throws {
        #expect(try run("upper", "Hello wörld") == "HELLO WÖRLD")
        #expect(try run("lower", "Hello WÖRLD") == "hello wörld")
        #expect(try run("title", "the quick BROWN fox's tail") == "The Quick Brown Fox's Tail")
        #expect(try run("sentence", "HELLO THERE. how are you? fine!\nnew line") == "Hello there. How are you? Fine!\nNew line")
        #expect(try run("camel", "hello big world\nfoo_bar") == "helloBigWorld\nfooBar")
        #expect(try run("pascal", "hello big-world") == "HelloBigWorld")
        #expect(try run("snake", "helloBigWorld") == "hello_big_world")
        #expect(try run("constant", "max retry count") == "MAX_RETRY_COUNT")
        #expect(try run("kebab", "Hello Big_World") == "hello-big-world")
        #expect(try run("slugify", "  Crème Brûlée: The Recipe!  ") == "creme-brulee-the-recipe")
    }

    @Test func lineTransforms() throws {
        #expect(try run("trim", "  a  \n   b \n") == "a\nb")
        #expect(try run("sort", "b10\nB2\na") == "a\nB2\nb10")
        #expect(try run("dedupe", "a\nb\na\nc\nb") == "a\nb\nc")
        #expect(try run("reverse-lines", "1\n2\n3") == "3\n2\n1")
        #expect(try run("reverse", "abc😀") == "😀cba")
        #expect(try run("wrap", "aaa bbb ccc ddd", TransformOptions(width: 10)) == "aaa bbb\nccc ddd")
        #expect(try run("wrap", "  one two three four", TransformOptions(width: 12)) == "  one two\n  three four")
        #expect(try run("wrap", "short", TransformOptions(width: 80)) == "short")
        #expect(try run("count", "Hello world\n\nsecond para") == "Characters: 24\nCharacters (no spaces): 20\nWords: 4\nLines: 3\nParagraphs: 2")
    }

    @Test func jsonTransforms() throws {
        #expect(try run("json-pretty", #"{"a":1,"b":[1,2]}"#) == "{\n  \"a\": 1,\n  \"b\": [\n    1,\n    2\n  ]\n}")
        #expect(try run("json-minify", "{ \"a\" : 1 ,\n \"b\": [ 1 ] }") == #"{"a":1,"b":[1]}"#)
        #expect(try run("json-validate", #"{"a":1}"#) == "✓ Valid JSON (object with 1 keys)")
        #expect(fails("json-validate", "{a:1}").hasPrefix("Invalid JSON"))
        // key order, unicode, escapes and JS number formatting survive
        #expect(try run("json-minify", #"{"z":1.50,"a":"é\n\u0001","n":null,"big":1e21,"small":1e-7,"x":0.1,"t":true}"#)
            == #"{"z":1.5,"a":"é\n\u0001","n":null,"big":1e+21,"small":1e-7,"x":0.1,"t":true}"#)
        #expect(try run("json-pretty", "[]") == "[]")
        #expect(try run("json-validate", "[1,2]") == "✓ Valid JSON (array of 2)")
        #expect(try run("json-validate", "\"s\"") == "✓ Valid JSON (string)")
    }

    @Test func markdownToPlain() throws {
        let md = "# Title\n\nSome **bold** and _it_ with [a link](http://x) and `code`.\n\n- item one\n- [x] done\n> quote\n```js\nconst x = 1;\n```\n---"
        #expect(try run("markdown-plain", md) == "Title\n\nSome bold and it with a link and code.\n\n• item one\n• done\nquote\nconst x = 1;")
    }

    @Test func jwt() throws {
        let token = "\(b64url(#"{"alg":"HS256","typ":"JWT"}"#)).\(b64url(#"{"sub":"42","exp":1700000000}"#)).sig"
        let out = try run("jwt", token)
        #expect(out.contains("NOT verified"))
        #expect(out.contains("// exp: 2023-11-14T22:13:20.000Z"))
        #expect(out.contains(#""sub": "42""#))
        #expect(fails("jwt", "not-a-token").hasPrefix("Not a JWT"))
    }

    @Test func timestamps() throws {
        #expect(try run("timestamp", "1700000000") == "2023-11-14T22:13:20.000Z")
        #expect(try run("timestamp", "1700000000123") == "2023-11-14T22:13:20.123Z")
        #expect(try run("timestamp", "2023-11-14T22:13:20Z") == "1700000000")
        #expect(try run("timestamp", "", TransformOptions(now: Date(timeIntervalSince1970: 1_000_000_000))) == "1000000000\n2001-09-09T01:46:40.000Z")
        #expect(fails("timestamp", "next tuesday-ish").hasPrefix("Not a unix timestamp"))
    }

    @Test func encodings() throws {
        #expect(try run("base64-encode", "héllo ✓") == Data("héllo ✓".utf8).base64EncodedString())
        #expect(try run("base64-decode", Data("héllo ✓".utf8).base64EncodedString()) == "héllo ✓")
        #expect(try run("base64-decode", b64url("??>>")) == "??>>")
        #expect(fails("base64-decode", "%%%").contains("Base64"))
        #expect(try run("url-encode", "a b&c=d/é") == "a%20b%26c%3Dd%2F%C3%A9")
        #expect(try run("url-decode", "a%20b+c%C3%A9") == "a b cé")
        #expect(fails("url-decode", "%E0%A4%A").hasPrefix("Malformed"))
        #expect(try run("html-escape", #"<a href="x">Tom & 'Jerry'</a>"#) == "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;")
        #expect(try run("html-unescape", "&lt;b&gt; &amp; &#169; &#x1F600;") == "<b> & © 😀")
    }

    @Test func hashes() throws {
        #expect(try run("md5", "abc") == "900150983cd24fb0d6963f7d28e17f72")
        #expect(try run("sha1", "abc") == "a9993e364706816aba3e25717850c26c9cd0d89d")
        #expect(try run("sha256", "abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(try run("md5", "The quick brown fox jumps over the lazy dog") == "9e107d9d372bb6826bd81d3542a419d6")
    }

    @Test func generatorsAndPlumbing() throws {
        let u = try run("uuid", "")
        #expect(u.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil)
        #expect(try run("uuid", "x", TransformOptions(uuid: { "fixed" })) == "fixed")
        #expect(fails("upper", "").hasPrefix("No input"))
        #expect(fails("nope", "x").hasPrefix("Unknown"))
        #expect(TextTransforms.parseQuery("wrap 60") == ("wrap", 60))
        #expect(TextTransforms.parseQuery("sha256") == ("sha256", nil))
        #expect(TextTransforms.filter("json").map(\.id) == ["json-pretty", "json-minify", "json-validate", "jwt"])
    }
}

@Suite("transforms feature", .serialized)
@MainActor struct TransformsFeatureTests {
    @Test func catalogueItemsKeepElectronIds() async throws {
        let ctx = try N4TestContext(featureId: "transforms")
        defer { ctx.cleanup() }
        let f = TransformsFeature()
        await f.start(context: ctx)
        let items = f.items()
        #expect(items.count == 34) // "Transform Text" + 33 transforms
        #expect(items.first?.id == "transforms:open")
        #expect(items.contains { $0.id == "transforms:json-pretty" && $0.title == "JSON Pretty Print" })
        #expect(f.actions(for: items[1]).map(\.id) == ["preview", "paste", "copy"])
    }

    @Test func pasteResultUsesSelectionAndPastesBack() async throws {
        let ctx = try N4TestContext(featureId: "transforms", selection: "hello world")
        defer { ctx.cleanup() }
        let f = TransformsFeature()
        await f.start(context: ctx)
        let item = try #require(f.items().first { $0.id == "transforms:upper" })
        let r = await f.run(action: "paste", on: ScoredItem(item: item, score: 0), modifiers: [])
        #expect(r == .hide(message: "Pasted"))
        #expect(ctx.hidden == 1)
        #expect(ctx.effects("paste").first?["text"]?.stringValue == "HELLO WORLD")
    }

    @Test func copyFallsBackToClipboard() async throws {
        let ctx = try N4TestContext(featureId: "transforms", clipboard: "{\"b\":1}")
        defer { ctx.cleanup() }
        let f = TransformsFeature()
        await f.start(context: ctx)
        let item = try #require(f.items().first { $0.id == "transforms:json-pretty" })
        _ = await f.run(action: "copy", on: ScoredItem(item: item, score: 0), modifiers: [])
        #expect(ctx.services.pasteboard.string() == "{\n  \"b\": 1\n}")
    }

    @Test func viewSessionNavigationChainAndPaste() async throws {
        let ctx = try N4TestContext(featureId: "transforms", selection: "fooBar")
        defer { ctx.cleanup() }
        let f = TransformsFeature()
        await f.start(context: ctx)
        let item = try #require(f.items().first { $0.id == "transforms:snake" })
        let r = await f.run(action: "preview", on: ScoredItem(item: item, score: 0), modifiers: [])
        guard case let .pushView(view, payload) = r else { Issue.record("expected push"); return }
        #expect(view.rawValue == "transforms.transform")
        #expect(payload["transform"]?.stringValue == "snake")
        let s = try #require(f.session)
        var query = ""
        s.queryProvider = { query }
        await s.waitForInput()
        #expect(s.input?.source == .selection)
        #expect(s.rows.first?.id == "pick:snake")
        #expect(s.rows.first?.section == "Suggested")
        #expect(s.result("snake").output == "foo_bar")
        // ⌘I chains: the result becomes the input
        #expect(f.handleKey(VimKey("i", meta: true), view: view))
        #expect(s.text == "foo_bar")
        // filter + navigation
        query = "upper"
        #expect(s.rows.map(\.transform) == ["upper", "pascal"])
        query = "case"
        #expect(f.handleCommand(.move(delta: 1), view: view))
        #expect(s.selected?.transform == s.rows[1].transform)
        query = "wrap 60"
        #expect(s.options.width == 60)
        query = "upper"
        s.selectedIndex = 0
        // ⌘K panel, then ⏎ runs "Paste Result"
        #expect(f.handleCommand(.actions, view: view))
        #expect(s.panelOpen)
        #expect(f.handleKey(VimKey("Enter"), view: view))
        #expect(!s.panelOpen)
        #expect(ctx.effects("paste").first?["text"]?.stringValue == "FOO_BAR")
    }
}
