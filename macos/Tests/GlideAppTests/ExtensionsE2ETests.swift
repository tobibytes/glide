import Foundation
import GlideTestHarness
import Testing

// N9: Extensions (JavaScriptCore), Store and Script Commands through the real headless app.
private let n9Snapshots = ProcessInfo.processInfo.environment["GLIDE_SNAPSHOT_DIR"]
    ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-snapshots").path

private func view(_ d: GlideDriver) throws -> [String: Any] { (try d.invoke("extensions", "view")["result"] as? [String: Any]) ?? [:] }
private func rowTitles(_ v: [String: Any]) -> [String] { ((v["rows"] as? [[String: Any]]) ?? []).compactMap { $0["title"] as? String } }

private func poll(_ timeout: TimeInterval = 8, _ cond: () throws -> Bool) rethrows -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if try cond() { return true }
        usleep(50_000)
    }
    return try cond()
}

private func gridReady(_ d: GlideDriver, _ type: String, _ min: Int) throws -> Bool {
    let v = try view(d)
    return v["type"] as? String == type && rowTitles(v).count >= min
}

@Suite("N9 extensions via test channel", .serialized)
struct ExtensionsE2E {
    @Test func noViewExtensionCopiesAndHUDs() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("extensions", "installExample", ["path": "uuid-generator"])
        let s = try d.type("generate uuid")
        #expect((s["rows"] as? [[String: Any]])?.first?["id"] as? String == "ext:uuid-generator:generate-uuid")
        try d.key("enter")
        #expect(try poll { (try d.invoke("headless", "pasteboard")["result"] as? String)?.count == 36 })
        let effects = try d.invoke("extensions", "effects")["result"] as? [[String: Any]] ?? []
        #expect(effects.contains { $0["kind"] as? String == "hud" && ($0["text"] as? String ?? "").hasPrefix("Copied ") })
    }

    @Test func raycastListPreferencesFilterPanelPushPop() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("extensions", "installExample", ["path": "raycast-fixtures/rc-fruits"])
        try d.type("browse fruits")
        try d.key("enter")
        // Required preference first.
        var v = try view(d)
        #expect(v["kind"] as? String == "form")
        try d.invoke("extensions", "setField", ["id": "greeting", "value": "Howdy"])
        try d.key("cmd+enter")
        #expect(try poll { rowTitles(try view(d)).count == 7 })
        #expect(try d.state()["placeholder"] as? String == "Search fruits…")
        _ = try d.snapshot("\(n9Snapshots)/n9-fruits-list.png")
        try d.type("ki")
        #expect(try poll { rowTitles(try view(d)) == ["Kiwi"] })
        try d.key("cmdK")
        v = try view(d)
        #expect(v["panel"] as? [String] == ["Show Fruit", "Show Details", "Copy Name", "Eat Fruit"])
        try d.key("esc")
        #expect(try view(d)["panel"] is NSNull)
        try d.key("enter") // Action.Push → Detail at depth 1
        #expect(try poll { (try view(d)["type"] as? String) == "detail" })
        v = try view(d)
        #expect(v["depth"] as? Int == 1)
        #expect(((v["view"] as? [String: Any])?["markdown"] as? String)?.contains("Howdy, **Kiwi**!") == true)
        _ = try d.snapshot("\(n9Snapshots)/n9-fruit-detail.png")
        try d.key("esc") // vim: NORMAL
        try d.key("h") // pop back to the list
        #expect(try poll { (try view(d)["depth"] as? Int) == 0 })
        // ⌃X runs the destructive action (shortcut matching).
        try d.key("ctrl+x")
        #expect(try poll { !rowTitles(try view(d)).contains("Kiwi") })
    }

    @Test func gridAndFormFixtures() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("extensions", "installExample", ["path": "raycast-fixtures/rc-colors"])
        try d.invoke("extensions", "installExample", ["path": "raycast-fixtures/rc-notes"])
        try d.invoke("extensions", "run", ["name": "rc-colors", "command": "color-grid"])
        #expect(try poll { try gridReady(d, "grid", 14) })
        try d.key("right")
        try d.key("down")
        #expect(try view(d)["selected"] as? Int == 5)
        _ = try d.snapshot("\(n9Snapshots)/n9-color-grid.png")
        try d.key("esc")
        try d.key("esc")
        try d.invoke("extensions", "run", ["name": "rc-notes", "command": "new-note"])
        #expect(try poll { (try view(d)["type"] as? String) == "form" })
        try d.invoke("extensions", "setField", ["id": "title", "value": "Milk"])
        try d.key("cmd+enter")
        #expect(try poll { (try view(d)["type"] as? String) == "detail" })
        _ = try d.snapshot("\(n9Snapshots)/n9-note-saved.png")
    }

    @Test func storeInstallsBundledAfterConfirmation() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("store")
        try d.key("enter")
        var v = try view(d)
        #expect(v["kind"] as? String == "store")
        #expect(rowTitles(v).contains("World Clocks"))
        try d.type("world")
        try d.key("enter")
        #expect(try view(d)["confirm"] as? String == "Install World Clocks?")
        _ = try d.snapshot("\(n9Snapshots)/n9-store-confirm.png")
        try d.key("enter")
        #expect(try poll { ((try d.invoke("extensions", "list")["result"] as? [[String: Any]]) ?? []).contains { $0["name"] as? String == "timezones" } })
        v = try view(d)
        #expect(((v["rows"] as? [[String: Any]])?.first?["actions"] as? [String])?.first == "Run World Clocks")
        try d.key("enter") // runs it
        #expect(try poll { try gridReady(d, "list", 6) })
    }

    @Test func scriptCommandsCompactAndFullOutput() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("n9-scripts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "#!/bin/bash\n# @raycast.schemaVersion 1\n# @raycast.title Say Hi\n# @raycast.mode compact\n# @raycast.argument1 { \"type\": \"text\", \"placeholder\": \"Name\" }\necho \"Hi $1\"\n"
            .write(to: dir.appendingPathComponent("hi.sh"), atomically: true, encoding: .utf8)
        try "#!/bin/bash\n# @raycast.title Count\n# @raycast.mode fullOutput\nfor i in 1 2 3; do echo line $i; done\necho oops >&2\n"
            .write(to: dir.appendingPathComponent("count.sh"), atomically: true, encoding: .utf8)
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("scripts", "setDirectory", ["directory": dir.path])
        let st = try d.invoke("scripts", "state")["result"] as? [String: Any]
        #expect((st?["scripts"] as? [[String: Any]])?.count == 2)
        try d.type("say hi")
        let s = try d.key("enter") // required argument → arguments form
        #expect(s["placeholder"] as? String == "Say Hi")
        let r = try d.invoke("scripts", "run", ["id": "scripts:hi.sh", "args": ["Ada"]])["result"] as? [String: Any]
        #expect(r?["message"] as? String == "Hi Ada")
        try d.key("esc")
        try d.invoke("scripts", "run", ["id": "scripts:count.sh"])
        let out = try d.invoke("scripts", "output")["result"] as? [String: Any]
        #expect(out?["text"] as? String == "line 1\nline 2\nline 3\noops\n" || (out?["text"] as? String ?? "").contains("line 3"))
        #expect(out?["code"] as? Int == 0)
        _ = try d.snapshot("\(n9Snapshots)/n9-script-output.png")
    }
}
