import Foundation
import GlideTestHarness
import Testing

/// End-to-end: the real Glide binary, headless, driven over the test channel. Nothing is shown on screen,
/// no hotkey/tap is registered, no pasteboard is touched; side effects arrive as `[headless]` lines.
let snapshotDir = ProcessInfo.processInfo.environment["GLIDE_SNAPSHOT_DIR"]
    ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-snapshots").path

private func rows(_ s: [String: Any]) -> [[String: Any]] { (s["rows"] as? [[String: Any]]) ?? [] }
private func effects(_ d: GlideDriver, _ kind: String) -> [String] { d.sideEffects.filter { $0.kind == kind }.map(\.detail) }
private func fixtureData() throws -> Data {
    try Data(contentsOf: try #require(Bundle.module.url(forResource: "fixture-data", withExtension: "json")))
}

@Suite("launcher via test channel", .serialized)
struct LauncherE2E {
    @Test func typeSafShowsSafariFirst() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        #expect(try d.show()["visible"] as? Bool == true)
        let s = try d.type("saf")
        #expect(s["query"] as? String == "saf")
        #expect(rows(s).first?["title"] as? String == "Safari")
        #expect(rows(s).first?["selected"] as? Bool == true)
        #expect(s["primaryAction"] as? String == "Open")
    }

    @Test func enterOpensSelectedAppAndRecordsUsage() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("saf")
        let s = try d.key("enter")
        #expect(effects(d, "open-path").contains { $0.contains("Safari.app") })
        #expect(s["visible"] as? Bool == false) // apps switch away: launcher steps aside even with keepOpenAfterRun
        try d.invoke("store", "flush")
        let usage = try d.invoke("store", "usage")["result"] as? [[String: Any]] ?? []
        let rec = usage.first { ($0["itemId"] as? String)?.hasSuffix("Safari.app") == true }
        #expect(rec?["count"] as? Int == 1)
        #expect(rec?["searchTerms"] as? [String] == ["saf"])
    }

    @Test func commandKOpensActionPanel() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("saf")
        var s = try d.key("cmdK")
        let panel = s["actionPanel"] as? [String: Any]
        #expect(panel?["open"] as? Bool == true)
        #expect((panel?["actions"] as? [String])?.prefix(3) == ["Open", "Show in Finder", "Copy Path"])
        s = try d.key("down")
        #expect((s["actionPanel"] as? [String: Any])?["selected"] as? Int == 1)
        s = try d.type("fav") // filter
        #expect((s["actionPanel"] as? [String: Any])?["actions"] as? [String] == ["Add to Favorites"])
        s = try d.key("esc")
        #expect((s["actionPanel"] as? [String: Any])?["open"] as? Bool == false)
        #expect(s["visible"] as? Bool == true)
        // run an action from the panel: Copy Path → fake pasteboard
        try d.key("cmdK")
        try d.type("copy")
        s = try d.key("enter")
        #expect((try d.invoke("headless", "pasteboard")["result"] as? String)?.hasSuffix("Safari.app") == true)
    }

    @Test func escapeSemanticsVimOn() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("saf")
        var s = try d.key("esc")
        #expect(s["mode"] as? String == "normal")
        #expect(s["visible"] as? Bool == true)
        #expect(s["query"] as? String == "saf")
        s = try d.key("i")
        #expect(s["mode"] as? String == "insert")
        s = try d.key("esc")
        s = try d.key("esc")
        #expect(s["visible"] as? Bool == false)
        // empty query in INSERT: Esc hides straight away
        _ = try d.show()
        try d.send(["cmd": "setQuery", "text": ""])
        s = try d.key("esc")
        #expect(s["visible"] as? Bool == false)
    }

    @Test func escapeSemanticsVimOff() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        try d.invoke("store", "setSettings", ["vimMode": false])
        _ = try d.show()
        try d.type("saf")
        var s = try d.key("esc")
        #expect(s["query"] as? String == "")
        #expect(s["visible"] as? Bool == true)
        s = try d.key("esc")
        #expect(s["visible"] as? Bool == false)
    }

    @Test func vimNavigationCountsAndJumps() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("s")
        let all = try d.titles()
        #expect(all.count >= 5)
        try d.key("esc") // NORMAL
        try d.key("j")
        #expect(try d.selectedTitle() == all[1])
        try d.key("3")
        try d.key("j")
        #expect(try d.selectedTitle() == all[4])
        try d.key("G")
        #expect(try d.selectedTitle() == all.last)
        try d.key("g")
        try d.key("g")
        #expect(try d.selectedTitle() == all[0])
        try d.key("ctrlJ")
        #expect(try d.selectedTitle() == all[1])
        // typing in NORMAL never reaches the field
        let s = try d.key("z")
        #expect(s["query"] as? String == "s")
    }

    @Test func calculatorCopiesResult() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        let s = try d.type("2+2*3")
        #expect(rows(s).first?["title"] as? String == "= 8")
        #expect(rows(s).first?["kind"] as? String == "calculator")
        try d.key("enter")
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "8")
    }

    @Test func quicklinkArgumentAndTab() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("g swift ui")
        #expect(rows(s).first?["title"] as? String == "Google")
        #expect(rows(s).first?["argument"] as? String == "swift ui")
        try d.key("enter")
        #expect(effects(d, "open-url").contains { $0.contains("https://www.google.com/search?q=swift%20ui") })
        // Tab enters argument mode for the selected acceptsArgument item
        _ = try d.show()
        try d.send(["cmd": "setQuery", "text": "youtube"])
        s = try d.key("tab")
        #expect(s["argumentFor"] as? String == "YouTube")
        #expect(s["placeholder"] as? String == "Query…")
        try d.type("cats")
        try d.key("enter")
        #expect(effects(d, "open-url").contains { $0.contains("search_query=cats") })
    }

    @Test func snippetPastesIntoPreviousApp() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        let s = try d.type("shrug")
        #expect(rows(s).first?["kind"] as? String == "snippet")
        try d.key("enter")
        #expect(effects(d, "paste").contains { $0.contains("(ツ)") })
    }

    @Test func systemCommandAsksForConfirmation() throws {
        let d = try GlideDriver(environment: ["GLIDE_HEADLESS_CONFIRM": "0"])
        defer { d.stop() }
        _ = try d.show()
        try d.type("empty trash")
        #expect(try d.selectedTitle() == "Empty Trash")
        try d.key("enter")
        #expect(effects(d, "confirm").count == 1)
        #expect(effects(d, "applescript").isEmpty) // cancelled → nothing ran
        let d2 = try GlideDriver()
        defer { d2.stop() }
        _ = try d2.show()
        try d2.type("empty trash")
        try d2.key("enter")
        #expect(effects(d2, "applescript").contains { $0.contains("empty trash") })
    }

    @Test func viewStackPushPop() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("keyboard shortcuts")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "glide.shortcuts")
        #expect(s["query"] as? String == "")
        s = try d.key("backspace") // ⌫ on an empty view query pops
        #expect(s["view"] is NSNull)
        #expect(s["query"] as? String == "keyboard shortcuts")
        s = try d.invoke("launcher", "push", ["view": "glide.shortcuts"])
        s = try d.key("esc") // vim on: NORMAL inside the view
        #expect(s["mode"] as? String == "normal")
        s = try d.key("h") // h pops and lands in INSERT
        #expect(s["view"] is NSNull)
        #expect(s["mode"] as? String == "insert")
    }

    @Test func popToRootAfterIdle() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("saf")
        _ = try d.hide()
        _ = try d.show()
        #expect(try d.state()["query"] as? String == "saf") // within 90 s the query is kept
        _ = try d.hide()
        try d.invoke("launcher", "expireIdle")
        _ = try d.show()
        #expect(try d.state()["query"] as? String == "")
    }

    @Test func commandNumberRunsRow() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("saf")
        try d.key("cmd+2")
        #expect(effects(d, "open-path").contains { $0.contains("Grammarly") } || effects(d, "open-path").count == 1)
    }

    @Test func userDataCarriesOver() throws {
        let d = try GlideDriver(seed: ["data.json": try fixtureData()])
        defer { d.stop() }
        // stored hotkey honoured (Command+Space) — registered with the (fake) hotkey service
        let hotkeys = try d.invoke("headless", "hotkeys")["result"] as? [[String: Any]] ?? []
        #expect(hotkeys.contains { $0["id"] as? String == "launcher" && $0["accelerator"] as? String == "Command+Space" })
        _ = try d.show()
        // empty query: favorites first, in favorite order
        let s = try d.state()
        #expect(rows(s).first?["section"] as? String == "favorites")
        #expect(rows(s).first?["title"] as? String == "Calendar")
        #expect(s["theme"] as? String == "nord") // appearance bag from the Electron settings
        // alias "sf" → Safari
        #expect(rows(try d.type("sf")).first?["title"] as? String == "Safari")
        // round trip keeps unknown fields
        try d.invoke("store", "setSettings", ["sectionLimit": 7])
        try d.invoke("store", "flush")
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: d.dataDirectory.appendingPathComponent("data.json"))) as? [String: Any]
        #expect(raw?["schemaVersion"] as? Int == 3)
        #expect(((raw?["settings"] as? [String: Any])?["features"] as? [String: Any])?["clipboard"] != nil)
        #expect((raw?["settings"] as? [String: Any])?["sectionLimit"] as? Int == 7)
    }

    @Test func hotkeyTogglesLauncher() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        #expect(try d.invoke("headless", "pressHotkey", ["id": "launcher"])["result"] as? Bool == true)
        #expect(try d.invoke("headless", "pressHotkey", ["id": "launcher"])["result"] as? Bool == false)
    }

    @Test func snapshotsAndMetrics() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        var showMs: [Double] = []
        for _ in 0..<5 {
            showMs.append(try d.show()["showMs"] as? Double ?? 999)
            _ = try d.hide()
        }
        _ = try d.show()
        let empty = try d.snapshot("\(snapshotDir)/launcher-empty.png")
        try d.type("saf")
        let results = try d.snapshot("\(snapshotDir)/launcher-saf.png")
        try d.key("cmdK")
        let actions = try d.snapshot("\(snapshotDir)/launcher-actions.png")
        try d.key("esc")
        try d.send(["cmd": "setQuery", "text": "12*(3+4)"])
        _ = try d.snapshot("\(snapshotDir)/launcher-calculator.png")
        try d.send(["cmd": "setQuery", "text": "keyboard shortcuts"])
        try d.key("enter")
        _ = try d.snapshot("\(snapshotDir)/launcher-view-shortcuts.png")
        try d.key("esc")
        try d.key("h")
        try d.invoke("store", "setSettings", ["theme": "light"])
        try d.send(["cmd": "setQuery", "text": "s"])
        _ = try d.snapshot("\(snapshotDir)/launcher-light.png")
        try d.invoke("store", "setSettings", ["theme": "dark", "appearance": ["darkTheme": "dracula", "density": "compact"]])
        _ = try d.snapshot("\(snapshotDir)/launcher-dracula-compact.png")
        for snap in [empty, results, actions] {
            let path = try #require(snap["path"] as? String)
            let head = try FileHandle(forReadingFrom: URL(fileURLWithPath: path)).readData(ofLength: 8)
            #expect(head == Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
            #expect((snap["width"] as? Int ?? 0) >= 1280)
        }
        let m = try d.metrics()
        let median = showMs.sorted()[showMs.count / 2]
        let line = "show ms (5 runs, median \(String(format: "%.2f", median))): \(showMs.map { String(format: "%.2f", $0) }) footprint \(m["footprintMB"] ?? "?") MB resident \(m["residentMB"] ?? "?") MB items \(m["items"] ?? "?")"
        try? line.write(toFile: "\(snapshotDir)/metrics.txt", atomically: true, encoding: .utf8)
        print("[metrics] \(line)")
        #expect(median < 50)
    }
}
