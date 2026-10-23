import Foundation
import GlideTestHarness
import Testing

/// Headless driver checks for the N1 features (real Glide binary over the test channel; nothing on screen,
/// no real pasteboard, no network except the 127.0.0.1 rates stub).
let n1SnapshotDir: String = {
    let dir = ProcessInfo.processInfo.environment["GLIDE_SNAPSHOT_DIR"] ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-snapshots").path
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}()

private func rows(_ s: [String: Any]) -> [[String: Any]] { (s["rows"] as? [[String: Any]]) ?? [] }
private func titles(_ s: [String: Any]) -> [String] { rows(s).compactMap { $0["title"] as? String } }
private func effects(_ d: GlideDriver, _ kind: String) -> [String] { d.sideEffects.filter { $0.kind == kind }.map(\.detail) }
private func json(_ o: Any) -> Data { (try? JSONSerialization.data(withJSONObject: o)) ?? Data() }
private func result(_ r: [String: Any]) -> Any? { r["result"] }

/// Poll the launcher state until `ok` (dynamic rows can land after the first settle, e.g. a first rates fetch).
private func waitState(_ d: GlideDriver, timeout: TimeInterval = 5, _ ok: ([String: Any]) -> Bool) throws -> [String: Any] {
    let deadline = Date().addingTimeInterval(timeout)
    var s = try d.state()
    while !ok(s) && Date() < deadline {
        usleep(100_000)
        s = try d.state()
    }
    return s
}

private func seed(settings: [String: Any] = [:], quicklinks: [[String: Any]] = []) -> [String: Data] {
    var st: [String: Any] = ["theme": "dark", "vimMode": false]
    for (k, v) in settings { st[k] = v }
    return ["data.json": json(["settings": st, "quicklinks": quicklinks, "snippets": [], "workflows": []])]
}

@Suite("N1 headless driver", .serialized)
struct N1E2E {
    @Test func calculatorCopyAndPaste() throws {
        let d = try GlideDriver(seed: seed())
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("255 in hex")
        #expect(rows(s).first?["title"] as? String == "= 0xFF")
        #expect(rows(s).first?["section"] as? String == "calculator")
        _ = try d.snapshot("\(n1SnapshotDir)/n1-calculator-hex.png")
        s = try d.key("enter")
        #expect(effects(d, "pasteboard-set").contains { $0.contains("0xFF") })
        try d.send(["cmd": "setQuery", "text": "max(2, 9) * 3!"])
        s = try d.state()
        #expect(rows(s).first?["title"] as? String == "= 54")
        _ = try d.key("cmdEnter")
        #expect(effects(d, "paste").contains { $0.contains("\"54\"") })
    }

    @Test func conversionsWithStubbedRates() throws {
        let server = try N1StubHTTPServer()
        defer { server.stop() }
        let d = try GlideDriver(seed: seed(), environment: ["GLIDE_CONVERT_RATES_BASE_URL": server.baseURL])
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("5 km in miles")
        #expect(titles(s).first == "3.10686 mi")
        #expect(server.hits("/") == 0) // units never touch the network
        try d.send(["cmd": "setQuery", "text": "100 usd in eur"])
        s = try waitState(d) { titles($0).first == "€90.00" }
        #expect(titles(s).first == "€90.00")
        #expect(server.hits("/v6/latest/USD") == 1)
        _ = try d.snapshot("\(n1SnapshotDir)/n1-convert-currency.png")
        _ = try d.key("enter")
        #expect(effects(d, "pasteboard-set").contains { $0.contains("90.00") })
        try d.send(["cmd": "setQuery", "text": "50 eur to gbp"])
        s = try d.state()
        #expect(titles(s).first == "£44.44")
        #expect(server.hits("/v6/latest/USD") == 1) // 6 h cache
        try d.send(["cmd": "setQuery", "text": "days until dec 25"])
        #expect(titles(try d.state()).first?.hasSuffix("days") == true)
        try d.send(["cmd": "setQuery", "text": "5pm london in tokyo"])
        #expect(titles(try d.state()).first?.hasSuffix("Tokyo") == true)
        let cache = d.dataDirectory.appendingPathComponent("features/convert/rates.json")
        #expect(FileManager.default.fileExists(atPath: cache.path))
    }

    @Test func headlessNeverFetchesRatesWithoutStub() throws {
        let d = try GlideDriver(seed: seed())
        defer { d.stop() }
        _ = try d.show()
        let s = try d.type("100 usd in eur")
        #expect(!titles(s).contains { $0.contains("€") })
        let st = try d.invoke("convert", "state")
        #expect((result(st) as? [String: Any])?["requests"] as? Int == 0)
        #expect((result(st) as? [String: Any])?["networkAllowed"] as? Bool == false)
    }

    @Test func fallbacksUnderEveryQuery() throws {
        let d = try GlideDriver(seed: seed(settings: ["features": ["fallbacks": ["disabled": ["duckduckgo", "maps", "ai", "agent"]]]]))
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("zzqx plover")
        let fb = rows(s).filter { $0["section"] as? String == "fallbacks" }.compactMap { $0["title"] as? String }
        #expect(fb == ["Search Google", "Search Files", "Search GitHub", "Search YouTube"])
        _ = try d.snapshot("\(n1SnapshotDir)/n1-fallbacks.png")
        s = try d.key("enter") // first row: Search Google
        #expect(effects(d, "open-url").contains { $0.contains("https://www.google.com/search?q=zzqx%20plover") })
        // Reorder and disable through the settings methods (what the Settings page calls).
        try d.invoke("fallbacks", "move", ["id": "youtube", "delta": -10])
        try d.invoke("fallbacks", "setEnabled", ["id": "files", "enabled": false])
        try d.send(["cmd": "setQuery", "text": "zzqx plover"])
        s = try d.state()
        let fb2 = rows(s).filter { $0["section"] as? String == "fallbacks" }.compactMap { $0["title"] as? String }
        #expect(fb2 == ["Search YouTube", "Search Google", "Search GitHub"])
        try d.invoke("store", "flush")
        let data = try d.invoke("store", "data")
        let bag = ((result(data) as? [String: Any])?["settings"] as? [String: Any]).flatMap { ($0["features"] as? [String: Any])?["fallbacks"] as? [String: Any] }
        #expect((bag?["disabled"] as? [String])?.contains("files") == true)
        #expect((bag?["order"] as? [String])?.first == "youtube")
    }

    @Test func quicklinkMultiArgumentPills() throws {
        let url = #"https://translate.example/?sl={argument name="from" default="auto"}&tl={argument name="to" options="de,fr,es"}&q={argument name="text"}"#
        let d = try GlideDriver(seed: seed(quicklinks: [["id": "tr", "name": "Translate", "url": url],
                                                        ["id": "gh", "name": "GitHub Search", "url": "https://github.com/search?q={query}", "openWith": "com.apple.Safari"]]))
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("Translate")
        #expect(titles(s).first == "Translate")
        // ⏎ with required arguments missing opens the pills instead of an error.
        s = try d.key("enter")
        #expect(s["argumentFor"] as? String == "Translate")
        var pills = s["arguments"] as? [[String: Any]] ?? []
        #expect(pills.map { $0["name"] as? String } == ["from", "to", "text"])
        #expect(s["query"] as? String == "auto")
        s = try d.key("tab")
        #expect(s["placeholder"] as? String == "to: de / fr / es (↑↓)")
        s = try d.key("down")
        #expect(s["query"] as? String == "de")
        s = try d.key("tab")
        s = try d.type("hi there")
        pills = s["arguments"] as? [[String: Any]] ?? []
        #expect(pills.last?["value"] as? String == "hi there")
        #expect(pills.last?["current"] as? Bool == true)
        _ = try d.snapshot("\(n1SnapshotDir)/n1-quicklink-pills.png")
        s = try d.key("shift+tab")
        #expect(s["query"] as? String == "de")
        s = try d.key("tab")
        _ = try d.key("enter")
        #expect(effects(d, "open-url").contains { $0.contains(#"https://translate.example/?sl=auto&tl=de&q=hi%20there"#) })
        // Legacy {query} link: one-field Tab entry + open-with app.
        _ = try d.show()
        try d.send(["cmd": "setQuery", "text": ""])
        _ = try d.type("GitHub Search")
        s = try d.key("tab")
        #expect(s["arguments"] == nil)
        _ = try d.type("glide")
        _ = try d.key("enter")
        #expect(effects(d, "open-url").contains { $0.contains("https://github.com/search?q=glide") && $0.contains("com.apple.Safari") })
        // Template preview with clipboard / uuid / date placeholders.
        try d.invoke("headless", "clearEffects")
        let p = try d.invoke("quicklinks", "preview", ["url": "https://x/{argument name=\"a\"}?d={date format=\"yyyy\"}", "values": ["a": "b c"]])
        #expect(((result(p) as? [String: Any])?["url"] as? String)?.hasPrefix("https://x/b%20c?d=20") == true)
    }

    @Test func emojiPicker() throws {
        let d = try GlideDriver(seed: seed())
        defer { d.stop() }
        _ = try d.show()
        _ = try d.type("emoji")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "emoji.picker")
        _ = try d.snapshot("\(n1SnapshotDir)/n1-emoji-grid.png")
        _ = try d.type("thumbs")
        var st = result(try d.invoke("emoji", "state")) as? [String: Any]
        #expect(st?["selected"] as? String == "👍")
        try d.invoke("emoji", "setSkinTone", 2)
        st = result(try d.invoke("emoji", "state")) as? [String: Any]
        #expect(st?["selected"] as? String == "👍🏼")
        _ = try d.snapshot("\(n1SnapshotDir)/n1-emoji-search.png")
        _ = try d.key("right")
        st = result(try d.invoke("emoji", "state")) as? [String: Any]
        #expect(st?["col"] as? Int == 1)
        _ = try d.key("left")
        s = try d.key("enter")
        #expect(effects(d, "paste").contains { $0.contains("👍🏼") })
        st = result(try d.invoke("emoji", "state")) as? [String: Any]
        #expect((st?["recent"] as? [String])?.first == "👍")
        // :name rows in the root search.
        _ = try d.show()
        try d.invoke("launcher", "pop")
        try d.send(["cmd": "setQuery", "text": ":party"])
        s = try d.state()
        #expect(rows(s).contains { ($0["title"] as? String)?.lowercased().contains("party popper") == true })
    }

    @Test func fileSearchActionsAndPreview() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("n1-e2e-files-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("docs"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("node_modules"), withIntermediateDirectories: true)
        let report = root.appendingPathComponent("docs/Plover Report.txt")
        try "Quarterly plover numbers\nline two\n".write(to: report, atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent("docs/plover-notes.md"), atomically: true, encoding: .utf8)
        try "x".write(to: root.appendingPathComponent("node_modules/plover.js"), atomically: true, encoding: .utf8)
        let d = try GlideDriver(seed: seed(settings: ["features": ["fileindex": ["scopes": [root.path]]]]), environment: ["GLIDE_FILES_BACKEND": "scan"])
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("plover")
        s = try waitState(d) { rows($0).contains { $0["section"] as? String == "files" } }
        let files = rows(s).filter { $0["section"] as? String == "files" }.compactMap { $0["title"] as? String }
        #expect(Set(files) == ["Plover Report.txt", "plover-notes.md"])
        _ = try d.snapshot("\(n1SnapshotDir)/n1-files-root.png")
        // content: search
        try d.send(["cmd": "setQuery", "text": "content:quarterly"])
        s = try waitState(d) { rows($0).contains { $0["section"] as? String == "files" } }
        #expect(rows(s).filter { $0["section"] as? String == "files" }.compactMap { $0["title"] as? String } == ["Plover Report.txt"])
        // Search Files view with the Quick Look pane (headless: metadata + text fallback).
        try d.invoke("launcher", "push", ["view": "fileindex.search"])
        let v = result(try d.invoke("fileindex", "search", "plover report")) as? [String: Any]
        #expect((v?["results"] as? [String])?.first == report.path)
        _ = try d.snapshot("\(n1SnapshotDir)/n1-files-view-preview.png")
        let pv = result(try d.invoke("fileindex", "preview", report.path)) as? [String: Any]
        #expect((pv?["text"] as? String)?.hasPrefix("Quarterly plover") == true)
        // Open records a recent; ⇧⌘C copies the path; ⌃X asks and trashes (recorded, not performed).
        _ = try d.key("enter")
        #expect(effects(d, "open-path").contains { $0.contains("Plover Report.txt") })
        let recents = result(try d.invoke("fileindex", "recent")) as? [String] ?? []
        #expect(recents.first == report.path)
        try d.invoke("fileindex", "action", ["action": "copyPath", "path": report.path])
        #expect(effects(d, "pasteboard-set").contains { $0.contains("Plover Report.txt") })
        try d.invoke("fileindex", "action", ["action": "trash", "path": report.path])
        #expect(effects(d, "confirm").contains { $0.contains("Move “Plover Report.txt” to the Trash?") })
        #expect(effects(d, "trash").contains { $0.contains("Plover Report.txt") })
        #expect(FileManager.default.fileExists(atPath: report.path))
        try d.invoke("store", "flush")
        let opened = d.dataDirectory.appendingPathComponent("features/fileindex/opened.json")
        #expect(FileManager.default.fileExists(atPath: opened.path))
    }

    @Test func fileTrashCancelledKeepsEverything() throws {
        let d = try GlideDriver(seed: seed(), environment: ["GLIDE_HEADLESS_CONFIRM": "0"])
        defer { d.stop() }
        try d.invoke("fileindex", "action", ["action": "trash", "path": "/tmp/n1-does-not-matter.txt"])
        #expect(effects(d, "confirm").count == 1)
        #expect(effects(d, "trash").isEmpty)
    }
}
