import Foundation
import Testing
@testable import GlideCore
@testable import GlideFeatures

// Ports of src/main/features/clipboard/{model,model2,stack}.test.ts.

private let DAY = ClipModel.day
nonisolated(unsafe) private var counter = 0
private func newId() -> String { counter += 1; return "id\(counter)" }
private func text(_ t: String) -> ClipCandidate { ClipCandidate(type: ClipModel.classifyText(t), key: "t:\(t)", text: t) }
private func entry(_ type: ClipType = .text, text: String? = "x", files: [String]? = nil, image: ClipImage? = nil, source: SourceApp? = nil,
                   last: Double = 0, pinned: Bool = false, ocr: String? = nil, id: String? = nil) -> ClipEntry {
    let i = id ?? newId()
    return ClipEntry(id: i, type: type, key: "k\(i)", text: text, files: files, image: image, source: source, createdAt: 0, lastCopiedAt: last, count: 1, pinned: pinned, ocrText: ocr)
}
private func img(_ sha: String, mb: Double = 0, bytes: Int = 1) -> ClipImage { ClipImage(sha1: sha, width: 1, height: 1, bytes: mb > 0 ? Int(mb * 1024 * 1024) : bytes) }
private func settings(_ f: (inout ClipSettings) -> Void) -> ClipSettings { var s = ClipSettings(); f(&s); return s }

@Suite("clipboard model: type detection")
struct ClipTypeDetectionTests {
    @Test func links() {
        #expect(ClipModel.classifyText("https://raycast.com/pro") == .link)
        #expect(ClipModel.classifyText("  mailto:a@b.co ") == .link)
        #expect(ClipModel.classifyText("www.example.com/path") == .link)
        #expect(ClipModel.classifyText("see https://x.com for more") == .text)
    }
    @Test func colors() {
        for c in ["#fff", "#FFAA00", "#ffaa0080", "rgb(255, 0, 10)", "rgba(1,2,3,0.5)", "hsl(120deg 50% 40%)", "hsla(120, 50%, 40%, .3)"] { #expect(ClipModel.classifyText(c) == .color, "\(c)") }
        #expect(ClipModel.classifyText("#ggg") == .text)
        #expect(ClipModel.classifyText("#12345") == .text)
    }
    @Test func uriLists() {
        #expect(ClipModel.filePathsFromUriList("file:///etc/hosts\r\nfile:///Users/me/My%20Doc.txt\n# comment\nhttps://x.com") == ["/etc/hosts", "/Users/me/My Doc.txt"])
    }
    @Test func titles() {
        #expect(ClipModel.title(entry(text: "\n\n  hello\nworld")) == "hello")
        #expect(ClipModel.title(entry(.file, text: nil, files: ["/a/b.txt", "/c"])) == "b.txt + 1 more")
        #expect(ClipModel.title(entry(.image, text: nil, image: ClipImage(sha1: "x", width: 3, height: 4, bytes: 1))) == "Image (3×4)")
    }
}

@Suite("clipboard model: ignore rules")
struct ClipIgnoreTests {
    @Test func concealed() {
        #expect(ClipModel.isConcealed(["org.nspasteboard.ConcealedType"]))
        #expect(ClipModel.isConcealed(["org.nspasteboard.TransientType"]))
        #expect(ClipModel.isConcealed(["com.agilebits.onepassword"]))
        #expect(!ClipModel.isConcealed(["public.utf8-plain-text", "public.html"]))
    }
    @Test func ignoredApps() {
        #expect(ClipModel.isIgnoredApp("com.1Password.1password", ["com.1password.1password"]))
        #expect(!ClipModel.isIgnoredApp("com.apple.Safari", ["com.1password.1password"]))
        #expect(!ClipModel.isIgnoredApp(nil, ["com.1password.1password"]))
    }
}

@Suite("clipboard model: dedupe")
struct ClipDedupeTests {
    @Test func sameContentMovesToTop() {
        var list: [ClipEntry] = []
        list = ClipModel.upsert(list, text("a"), now: 1, newId: newId).entries
        list = ClipModel.upsert(list, text("b"), now: 2, newId: newId).entries
        let firstId = list[1].id
        let r = ClipModel.upsert(list, text("a"), now: 3, newId: newId)
        #expect(!r.isNew)
        #expect(r.entries.map(\.text) == ["a", "b"])
        #expect(r.entries[0].id == firstId && r.entries[0].count == 2 && r.entries[0].createdAt == 1 && r.entries[0].lastCopiedAt == 3)
    }
    @Test func keepsPin() {
        var list = ClipModel.upsert([], text("a"), now: 1, newId: newId).entries
        list[0].pinned = true
        #expect(ClipModel.upsert(list, text("a"), now: 2, newId: newId).entries[0].pinned)
    }
    @Test func touchMovesToTop() {
        let list = [entry(last: 5, id: "x"), entry(last: 1, id: "y")]
        #expect(ClipModel.touch(list, id: "y", now: 9).map(\.id) == ["y", "x"])
    }
}

@Suite("clipboard model: retention")
struct ClipRetentionTests {
    let base = settings { $0.retentionDays = 7 }
    @Test func expiresOldButNotPinned() {
        let now = 100 * DAY
        let old = entry(last: now - 8 * DAY), oldPinned = entry(last: now - 300 * DAY, pinned: true), fresh = entry(last: now - DAY)
        let r = ClipModel.prune([old, oldPinned, fresh], base, now: now)
        #expect(r.kept.map(\.id) == [fresh.id, oldPinned.id])
        #expect(r.removed.map(\.id) == [old.id])
    }
    @Test func zeroKeepsForever() {
        let e = entry(last: 0)
        #expect(ClipModel.prune([e], settings { $0.retentionDays = 0 }, now: 1e12).kept == [e])
    }
    @Test func capsEntryCount() {
        let list = (0..<15).map { i in entry(last: Double(1000 - i), pinned: i == 14) }
        let r = ClipModel.prune(list, settings { $0.retentionDays = 0; $0.maxEntries = 10 }, now: 1000)
        #expect(r.kept.count == 10)
        #expect(r.kept.contains { $0.pinned })
        #expect(r.removed.count == 5)
    }
    @Test func capsImagesByCountAndBytes() {
        let list = [entry(.image, text: nil, image: img("s0", mb: 1), last: 1000), entry(.image, text: nil, image: img("s1", mb: 1), last: 999),
                    entry(.image, text: nil, image: img("s2", mb: 1), last: 998), entry(last: 1)]
        #expect(ClipModel.prune(list, settings { $0.retentionDays = 0; $0.maxImages = 2 }, now: 1000).removed.map { $0.image?.sha1 } == ["s2"])
        #expect(ClipModel.prune(list, settings { $0.retentionDays = 0; $0.maxImageMB = 1 }, now: 1000).removed.map { $0.image?.sha1 } == ["s2", "s1"])
    }
    @Test func perTypeRetention() {
        let now = 100 * DAY
        let list = [entry(.image, text: nil, image: img("a"), last: now - 8 * DAY), entry(.image, text: nil, image: img("b"), last: now - 8 * DAY, pinned: true),
                    entry(.image, text: nil, image: img("c"), last: now - 2 * DAY), entry(last: now - 30 * DAY)]
        let r = ClipModel.prune(list, settings { $0.retentionDays = 90; $0.retentionByType = [.image: 7]; $0.maxEntries = 0; $0.maxImages = 0; $0.maxImageMB = 0 }, now: now)
        #expect(r.removed.map { $0.image?.sha1 } == ["a"])
        #expect(r.kept.count == 3)
    }
}

@Suite("clipboard model: search and filters")
struct ClipSearchTests {
    @Test func wordsTypeAndPinnedFirst() {
        let a = entry(text: "Hello world", last: 3), b = entry(.link, text: "https://hello.dev", last: 2), c = entry(text: "unrelated", last: 1, pinned: true)
        #expect(ClipModel.filter([a, b, c], query: "", filter: .all).map(\.id) == [c.id, a.id, b.id])
        #expect(ClipModel.filter([a, b, c], query: "hello", filter: .all).map(\.id) == [a.id, b.id])
        #expect(ClipModel.filter([a, b, c], query: "hello", filter: .type(.link)).map(\.id) == [b.id])
        #expect(ClipModel.filter([a, b, c], query: "world hello", filter: .all, limit: 1).map(\.id) == [a.id])
    }

    let safari = SourceApp(name: "Safari", bundleId: "com.apple.Safari"), notes = SourceApp(name: "Notes", bundleId: nil)
    var list: [ClipEntry] {
        [entry(text: "hello world", source: safari, last: 5), entry(.link, text: "https://github.com/x", source: safari, last: 4),
         entry(.image, text: nil, image: ClipImage(sha1: "a", width: 10, height: 10, bytes: 1), last: 3, ocr: "Invoice total 42"),
         entry(.file, text: nil, files: ["/tmp/a.txt"], source: notes, last: 2), entry(.color, text: "#ff0000", last: 1, pinned: true)]
    }
    @Test func pinnedFilter() { #expect(ClipModel.filter(list, query: "", filter: .pinned).map(\.type) == [.color]) }
    @Test func typeAndSource() {
        #expect(ClipModel.filter(list, query: "", filter: .all, source: "com.apple.Safari").map(\.type) == [.text, .link])
        #expect(ClipModel.filter(list, query: "", filter: .type(.link), source: "com.apple.Safari").count == 1)
        #expect(ClipModel.filter(list, query: "", filter: .all, source: "name:Notes").map(\.type) == [.file])
    }
    @Test func searchesOCRText() {
        #expect(ClipModel.filter(list, query: "invoice", filter: .all).map(\.type) == [.image])
        #expect(ClipModel.haystack(list[2]).contains("total 42"))
    }
    @Test func sourceAppsByCount() {
        let s = ClipModel.sourceApps(list)
        #expect(s.map(\.key) == ["com.apple.Safari", "name:Notes"])
        #expect(s.map(\.count) == [2, 1])
    }
    @Test func stats() {
        let s = ClipModel.stats([entry(.image, image: ClipImage(sha1: "a", width: 1, height: 1, bytes: 10)), entry(pinned: true)], ClipSettings(), now: 0)
        #expect(s.total == 2 && s.pinned == 1 && s.imageBytes == 10 && s.byType[.image] == 1 && s.byType[.text] == 1)
    }
}

@Suite("clipboard model: settings, pause, merge, links")
struct ClipMiscTests {
    @Test func normalizesSettings() {
        let s = ClipSettings(bag: ["retentionDays": -4, "maxEntries": 5.6, "ignoredApps": ["a", "", 3]])
        #expect(s.retentionDays == 0)
        #expect(s.maxEntries == 10)
        #expect(s.ignoredApps == ["a"])
        #expect(ClipSettings(bag: ["retentionByType": ["image": 7, "text": -1, "link": 0]]).retentionByType == [.image: 7])
        // round trip through the settings bag
        var t = ClipSettings()
        t.stackOrder = .lifo
        t.retentionByType = [.file: 3]
        #expect(ClipSettings(bag: t.bag) == t)
    }
    @Test func timedPause() {
        var s = ClipSettings()
        s.pausedUntil = 1000
        #expect(s.isPaused(now: 999))
        #expect(!s.isPaused(now: 1000))
        let st = ClipModel.stats([], { var x = ClipSettings(); x.pausedUntil = 2000; return x }(), now: 1000)
        #expect(st.paused && st.pausedUntil == 2000)
    }
    @Test func mergesTextAndFilesSkippingImages() {
        let l = [entry(text: "a"), entry(.image, text: nil), entry(.file, text: nil, files: ["/x", "/y"]), entry(.link, text: "https://b.co")]
        #expect(ClipModel.mergeTexts(l) == "a\n/x\n/y\nhttps://b.co")
        #expect(ClipModel.mergeTexts([entry(.image, text: nil)]) == nil)
        #expect(ClipModel.mergeTexts([entry(text: "a"), entry(text: "b")], separator: ", ") == "a, b")
    }
    @Test func domainsAndMarkdown() {
        #expect(ClipModel.linkDomain("https://www.github.com/a?b") == "github.com")
        #expect(ClipModel.linkDomain("www.example.org/x") == "example.org")
        #expect(ClipModel.linkDomain("mailto:me@mail.com") == "mail.com")
        #expect(ClipModel.markdownLink("https://github.com/a b") == "[github.com](https://github.com/a%20b)")
        #expect(ClipModel.markdownLink("https://x.com/(y)", title: "A [b]") == "[A \\[b\\]](https://x.com/(y%29)")
        #expect(ClipModel.linkHref("www.x.com") == "https://www.x.com")
    }
}

@Suite("clipboard persistence (Electron history.json compatibility)")
struct ClipPersistenceTests {
    @Test func readsElectronHistoryAndRoundTripsUnknownFields() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("n2-clip-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let json = """
        {"version":1,"entries":[
          {"id":"e1","type":"text","key":"t:abc","text":"hello","source":{"name":"Safari","bundleId":"com.apple.Safari"},"createdAt":1,"lastCopiedAt":5,"count":2,"pinned":true,"future":{"x":1}},
          {"id":"e2","type":"image","key":"i:ff","image":{"sha1":"ff","width":2,"height":3,"bytes":40},"source":null,"createdAt":2,"lastCopiedAt":9,"count":1,"pinned":false,"ocrText":""},
          {"id":"bad","type":"nope","key":"x","lastCopiedAt":1},
          {"type":"text"}
        ]}
        """
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(json.utf8).write(to: dir.appendingPathComponent("history.json"))
        let st = ClipStorage(directory: dir)
        let list = st.loadHistory()
        #expect(list.map(\.id) == ["e2", "e1"])
        #expect(list[1].source?.bundleId == "com.apple.Safari" && list[1].pinned && list[1].count == 2)
        #expect(list[0].image?.height == 3 && list[0].ocrText == "")
        try st.saveHistory(list)
        let back = try JSONSerialization.jsonObject(with: Data(contentsOf: st.historyURL)) as? [String: Any]
        #expect(back?["version"] as? Int == 1)
        let entries = back?["entries"] as? [[String: Any]] ?? []
        #expect((entries.first { $0["id"] as? String == "e1" }?["future"] as? [String: Any])?["x"] as? Int == 1)
        let attrs = try FileManager.default.attributesOfItem(atPath: st.historyURL.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test func textKeyMatchesElectronSha1() {
        // node -e 'console.log(require("crypto").createHash("sha1").update("hello").digest("hex"))'
        #expect(ClipStorage.textKey("hello") == "t:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d")
    }
}

@Suite("paste stack")
struct PasteStackTests {
    @Test func fifoStopsAfterN() {
        var s = PasteStack.start(order: .fifo, limit: 3)
        for id in ["a", "b", "c", "d"] { s = s.pushed(id) }
        #expect(s.items == ["a", "b", "c"])
        #expect(!s.collecting)
        let r1 = s.takeNext()
        #expect(r1.id == "a")
        let r2 = r1.stack.takeNext()
        #expect(r2.id == "b")
        #expect(r2.stack.items == ["c"])
    }
    @Test func lifo() {
        var s = PasteStack.start(order: .lifo)
        for id in ["a", "b", "c"] { s = s.pushed(id) }
        #expect(s.collecting)
        #expect(s.takeNext().id == "c")
    }
    @Test func recopyMoves() {
        var s = PasteStack.start(order: .fifo)
        for id in ["a", "b", "a"] { s = s.pushed(id) }
        #expect(s.items == ["b", "a"])
    }
    @Test func skipsDeleted() {
        var s = PasteStack.start(order: .fifo)
        s.items = ["gone", "b"]
        let r = s.takeNext { $0 != "gone" }
        #expect(r.id == "b" && r.stack.items.isEmpty)
        var e = s
        e.items = []
        #expect(e.takeNext().id == nil)
    }
    @Test func manualAddsWhenNotCollecting() {
        let s = PasteStack.start(order: .fifo).cleared()
        #expect(s.pushed("a").items.isEmpty)
        #expect(s.added("a").items == ["a"])
    }
    @Test func reorderRemoveOrder() {
        var s = PasteStack.start(order: .fifo)
        s.items = ["a", "b", "c"]
        #expect(s.moving("c", by: -1).items == ["a", "c", "b"])
        #expect(s.moving("a", by: -1).items == ["a", "b", "c"])
        #expect(s.moving("a", by: 1).items == ["b", "a", "c"])
        #expect(s.removing("b").items == ["a", "c"])
        let l = s.withOrder(.lifo)
        #expect(l.items == ["c", "b", "a"])
        #expect(l.pushed("d").items.first == "d")
    }
    @Test func normalizes() {
        let s = PasteStack(json: ["collecting": true, "limit": -2, "items": ["a", 3], "order": "x"])
        #expect(s == PasteStack(collecting: true, limit: 0, collected: 0, order: .fifo, items: ["a"]))
        #expect(PasteStack(json: nil).items.isEmpty)
    }
    @Test func interceptsOnlyWithItems() {
        #expect(!PasteStack().interceptsPaste)
        #expect(PasteStack().added("a").interceptsPaste)
        #expect(PasteStack(items: ["b"]).restoringHead("a").items == ["a", "b"])
    }
}
