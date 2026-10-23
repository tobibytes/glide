import Foundation
import GlideTestHarness
import Testing

/// N2 end-to-end: Clipboard History, Paste Stack and Snippets 2.0 views driven headless over the test channel.
/// The pasteboard is the in-memory fake (`clipboard.debugSetClipboard` stands in for "another app copied");
/// pastes are `[headless]` lines, never keystrokes. Snapshots go to $GLIDE_SNAPSHOT_DIR (or the temp dir).
private let n2Snapshots = ProcessInfo.processInfo.environment["GLIDE_SNAPSHOT_DIR"] ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-snapshots").path

private func view(_ d: GlideDriver, _ feature: String = "clipboard", _ v: String = "history") throws -> [String: Any] {
    (try d.invoke(feature, "viewState", ["view": v])["result"] as? [String: Any]) ?? [:]
}
private func copy(_ d: GlideDriver, _ args: [String: Any]) throws { try d.invoke("clipboard", "debugSetClipboard", args) }
private func effects(_ d: GlideDriver, _ kind: String) -> [String] { d.sideEffects.filter { $0.kind == kind }.map(\.detail) }

@Suite("N2: clipboard + snippets via test channel", .serialized)
struct N2E2E {
    @Test func clipboardHistoryFlow() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try copy(d, ["text": "alpha one", "source": ["name": "Safari", "bundleId": "com.apple.Safari"]])
        try copy(d, ["text": "https://github.com/tobibytes/glide", "source": ["name": "Safari", "bundleId": "com.apple.Safari"]])
        try copy(d, ["text": "secret", "extraTypes": ["org.nspasteboard.ConcealedType"]])
        try copy(d, ["text": "pw", "source": ["name": "1Password", "bundleId": "com.1password.1password"]])
        try copy(d, ["color": "#FF8800"])
        try copy(d, ["files": ["/etc/hosts"]])
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        try copy(d, ["pngBase64": png])

        try d.type("clipboard history")
        #expect(try d.selectedTitle() == "Clipboard History")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "clipboard.history")
        var v = try view(d)
        #expect((v["types"] as? [String]) == ["image", "file", "color", "link", "text"])
        #expect((v["rows"] as? [String])?.contains("secret") == false)
        #expect((v["rows"] as? [String])?.contains("pw") == false)
        _ = try d.snapshot("\(n2Snapshots)/n2-clipboard-list.png")

        // search inside the history (the launcher field is the view's query)
        try d.type("github")
        v = try view(d)
        #expect((v["rows"] as? [String]) == ["https://github.com/tobibytes/glide"])
        try d.send(["cmd": "setQuery", "text": ""])

        // navigation, marking, panel, grid, filter menu
        try d.key("down")
        v = try view(d)
        #expect(v["selected"] as? Int == 1)
        try d.key("cmd+k")
        v = try view(d)
        #expect((v["panel"] as? [String: Any])?["open"] as? Bool == true)
        #expect(((v["panel"] as? [String: Any])?["actions"] as? [String])?.prefix(3) == ["Paste", "Copy to Clipboard", "Paste Paths as Text"])
        try d.key("esc")
        try d.key("cmd+g")
        v = try view(d)
        #expect(v["grid"] as? Bool == true)
        _ = try d.snapshot("\(n2Snapshots)/n2-clipboard-grid.png")
        try d.key("cmd+g")
        try d.key("cmd+p")
        v = try view(d)
        #expect(((v["menu"] as? [String: Any])?["options"] as? [String])?.contains("Links") == true)
        _ = try d.snapshot("\(n2Snapshots)/n2-clipboard-filter.png")
        try d.key("esc")

        // pin with ⌘. then paste the link with ⏎ (recorded, launcher hides)
        try d.key("up")
        try d.key("down")
        try d.key("down")
        v = try view(d)
        #expect((v["types"] as? [String])?[v["selected"] as? Int ?? 0] == "color")
        try d.key("cmd+.")
        v = try view(d)
        #expect((v["types"] as? [String])?.first == "color") // pinned first
        try d.key("down") // file? selection follows ids; go to the link
        let ids = (v["ids"] as? [String]) ?? []
        let types = (v["types"] as? [String]) ?? []
        let linkId = zip(ids, types).first { $0.1 == "link" }?.0
        s = try d.invoke("clipboard", "paste", ["id": linkId ?? ""])
        #expect(effects(d, "pasteboard-set").contains { $0.contains("github.com") })
        #expect(effects(d, "paste").isEmpty) // clipboard pastes go through the watcher, never PasteService
        let st = try d.state()
        #expect(st["visible"] as? Bool == false)
        // stats and persistence
        let stats = (try d.invoke("clipboard", "stats")["result"] as? [String: Any]) ?? [:]
        #expect(stats["total"] as? Int == 5)
        #expect(stats["watching"] as? Bool == true)
        try d.invoke("clipboard", "flush")
        let history = d.dataDirectory.appendingPathComponent("features/clipboard/history.json")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: history)) as? [String: Any]
        #expect((json?["entries"] as? [[String: Any]])?.count == 5)
    }

    @Test func pasteStackFlow() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.invoke("clipboard", "setSettings", ["stackInterceptPaste": true]) // opt-in, off by default
        _ = try d.show()
        try d.type("start paste stack")
        #expect(try d.selectedTitle() == "Start Paste Stack")
        try d.key("enter")
        for t in ["one", "two", "three"] { try copy(d, ["text": t]) }
        var stack = (try d.invoke("clipboard", "stackGet")["result"] as? [String: Any]) ?? [:]
        #expect(((stack["items"] as? [[String: Any]]) ?? []).compactMap { $0["title"] as? String } == ["one", "two", "three"])
        #expect(stack["intercepts"] as? Bool == true)
        _ = try d.show()
        try d.invoke("launcher", "push", ["view": "clipboard.stack", "payload": ["nonce": "e2e"]])
        _ = try d.snapshot("\(n2Snapshots)/n2-paste-stack.png")
        try d.key("down")
        try d.key("cmd+up") // reorder: "two" moves to the head
        var v = try view(d, "clipboard", "stack")
        #expect((v["rows"] as? [String]) == ["two", "one", "three"])
        // ⌘V path (what the tap would get), FIFO
        var r = (try d.invoke("clipboard", "debugStackNext")["result"] as? [String: Any]) ?? [:]
        #expect((r["reply"] as? [String: Any])?["text"] as? String == "two")
        r = (try d.invoke("clipboard", "debugStackNext")["result"] as? [String: Any]) ?? [:]
        #expect((r["reply"] as? [String: Any])?["text"] as? String == "one")
        r = (try d.invoke("clipboard", "debugStackNext")["result"] as? [String: Any]) ?? [:]
        #expect(r["active"] as? Bool == false)
        r = (try d.invoke("clipboard", "debugStackNext")["result"] as? [String: Any]) ?? [:]
        #expect((r["reply"] as? [String: Any])?["empty"] as? Bool == true)
        v = try view(d, "clipboard", "stack")
        #expect((v["rows"] as? [String]) == [])
        stack = (try d.invoke("clipboard", "stackGet")["result"] as? [String: Any]) ?? [:]
        #expect(stack["intercepts"] as? Bool == false)
    }

    @Test func snippetsFlow() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("snippets2", "setSettings", ["keywordPrefix": ";", "caseAdaptive": true])
        let saved = (try d.invoke("snippets2", "save", ["name": "Greeting", "text": "Hi {clipboard}, {cursor}bye", "keyword": "hi"])["result"] as? [String: Any]) ?? [:]
        let sid = saved["id"] as? String ?? ""
        #expect(sid.hasPrefix("sn-"))
        try d.invoke("snippets2", "save", ["name": "Rich", "text": "bold", "html": "<b onclick=\"x()\">bold</b>", "keyword": "b"])
        try copy(d, ["text": "Olu"])
        // what the tap watches (Keyboard feature contribution) and what a match pastes
        let tap = (try d.invoke("snippets2", "tapEntries")["result"] as? [String: Any]) ?? [:]
        let keywords = ((tap["snippets"] as? [[String: Any]]) ?? []).compactMap { $0["keyword"] as? String }
        #expect(keywords.contains(";hi") && keywords.contains(";Hi") && keywords.contains(";HI") && keywords.contains(";sig"))
        let m = (try d.invoke("snippets2", "debugMatch", ["keyword": ";Hi", "id": sid])["result"] as? [String: Any]) ?? [:]
        #expect(m["text"] as? String == "Hi Olu, bye")
        #expect(m["cursorLeft"] as? Int == 3)
        // Search Snippets view
        try d.type("search snippets")
        #expect(try d.selectedTitle() == "Search Snippets")
        let s = try d.key("enter")
        #expect(s["view"] as? String == "snippets2.search")
        try d.type("greet")
        var v = try view(d, "snippets2")
        #expect((v["rows"] as? [String]) == ["Greeting"])
        #expect(v["preview"] as? String == "Hi ‹clipboard›, bye")
        _ = try d.snapshot("\(n2Snapshots)/n2-search-snippets.png")
        try d.key("cmd+k")
        v = try view(d, "snippets2")
        #expect(((v["panel"] as? [String: Any])?["actions"] as? [String])?.first == "Paste")
        try d.key("esc")
        try d.key("enter")
        try? await_(0.3)
        #expect(effects(d, "paste").contains { $0.contains("Hi Olu, bye") })
        #expect(effects(d, "cursor-left").contains { $0.contains("3") })
        // Raycast import
        let imp = (try d.invoke("snippets2", "importJson", ["json": #"[{"name":"From Raycast","text":"{browser-tab} hi","keyword":"!rc"}]"#])["result"] as? [String: Any]) ?? [:]
        #expect(imp["added"] as? Int == 1)
        #expect((imp["unsupported"] as? [String]) == ["{browser-tab}"])
    }
}

private func await_(_ s: TimeInterval) throws { Thread.sleep(forTimeInterval: s) }
