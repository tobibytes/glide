import Foundation
import GlideTestHarness
import Testing

/// N3 driver checks: windows, layouts, menus, keyboard, finder, processes, system monitor, syscmds — all through
/// the headless binary. Real side effects never happen; we assert the recorded `[headless] …` lines instead.
private let n3Snapshots = ProcessInfo.processInfo.environment["GLIDE_SNAPSHOT_DIR"]
    ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-snapshots").path

private func rows(_ s: [String: Any]) -> [[String: Any]] { (s["rows"] as? [[String: Any]]) ?? [] }
private func effects(_ d: GlideDriver, _ kind: String) -> [String] { d.sideEffects.filter { $0.kind == kind }.map(\.detail) }
private func snap(_ d: GlideDriver, _ name: String) throws {
    try FileManager.default.createDirectory(atPath: n3Snapshots, withIntermediateDirectories: true)
    let r = try d.snapshot("\(n3Snapshots)/n3-\(name).png")
    #expect((r["width"] as? Int ?? 0) > 0)
}
private func wait(_ d: GlideDriver, _ kind: String, _ match: String, timeout: TimeInterval = 3) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if effects(d, kind).contains(where: { $0.contains(match) }) { return true }
        usleep(50_000)
    }
    return false
}

private func waitView(_ d: GlideDriver, _ view: String, timeout: TimeInterval = 5) throws -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if try d.state()["view"] as? String == view { return true }
        usleep(50_000)
    }
    return false
}

private let seededLayouts = """
{"version":1,"layouts":[{"id":"layout-e2e","name":"Coding","createdAt":1,"updatedAt":2,
 "displays":[{"id":1,"uuid":"A","name":"Built-in","frame":{"x":0,"y":0,"width":1440,"height":900},"visible":{"x":0,"y":25,"width":1440,"height":875},"main":true}],
 "windows":[{"bundleId":"com.apple.Terminal","appName":"Terminal","appPath":null,"title":"zsh","frame":{"x":0,"y":25,"width":720,"height":875},"display":0,"order":0}]}],
 "workspaces":[{"id":"ws-e2e","name":"Finder Free","layoutId":null,"quitApps":[{"name":"Finder","bundleId":"com.apple.finder","path":null}],
 "launchApps":[{"name":"Notes","bundleId":"com.apple.Notes","path":null}],"urls":["example.com"],"createdAt":1,"updatedAt":1}]}
"""

@Suite("N3 features via test channel", .serialized)
struct N3E2E {
    @Test func windowCommandsAndSuggestedHotkeys() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        let s = try d.type("left half")
        #expect(rows(s).first?["id"] as? String == "windows.left-half")
        let after = try d.key("enter")
        #expect(wait(d, "window", "left-half"))
        #expect(after["visible"] as? Bool == false || after["toast"] != nil)
        try d.invoke("windows", "setSuggestedHotkeys", true)
        let hk = try d.invoke("headless", "hotkeys")["result"] as? [[String: Any]] ?? []
        #expect(hk.contains { $0["id"] as? String == "feature:windows:maximize" && $0["accelerator"] as? String == "Control+Alt+Enter" })
        try d.invoke("headless", "pressHotkey", ["id": "feature:windows:maximize"])
        #expect(wait(d, "window", "maximize"))
    }

    @Test func layoutsReadExistingDataAndConfirmQuits() throws {
        let d = try GlideDriver(seed: ["features/layouts/layouts.json": Data(seededLayouts.utf8)])
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("restore layout coding")
        #expect(rows(s).contains { $0["id"] as? String == "layouts.layout.layout-e2e" })
        try d.setQueryEmpty()
        s = try d.type("open workspace finder free")
        #expect(rows(s).first?["id"] as? String == "layouts.workspace.ws-e2e")
        s = try d.key("enter")
        // Finder is always running, so the workspace asks before quitting it.
        #expect(s["view"] as? String == "layouts.confirm")
        #expect(effects(d, "quit-apps").isEmpty)
        try snap(d, "layouts-confirm")
        _ = try d.key("enter")
        #expect(wait(d, "quit-apps", "com.apple.finder"))
        #expect(wait(d, "launch-app", "com.apple.Notes"))
        #expect(wait(d, "open-url", "https://example.com"))
        // Save Window Layout: headless capture has no windows → a clear error, nothing written.
        try d.invoke("launcher", "pop")
        let state = try d.invoke("layouts", "state")["result"] as? [String: Any]
        #expect((state?["layouts"] as? [[String: Any]])?.count == 1)
    }

    @Test func menuSearchPressesThroughFake() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("search menu items")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "menus.search")
        try snap(d, "menus")
        try d.type("copy")
        s = try d.key("enter")
        #expect(wait(d, "menu-press", "Copy"))
    }

    @Test func keyboardHyperAndCommandSpaceOnlyRecorded() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        try d.invoke("keyboard", "setHyperKey", "capslock")
        #expect(wait(d, "keyboard-tap-config", "\"hyper\":true"))
        try d.invoke("keyboard", "setUseCommandSpace", true)
        #expect(wait(d, "spotlight-shortcut", "\"enabled\":false"))
        try d.invoke("store", "flush")
        let data = try d.invoke("store", "data")["result"] as? [String: Any]
        #expect((data?["settings"] as? [String: Any])?["hotkey"] as? String == "Command+Space")
        let st = try d.invoke("keyboard", "getState")["result"] as? [String: Any]
        #expect(((st?["settings"] as? [String: Any])?["spotlightTakeover"]) as? Bool == true)
        try d.invoke("keyboard", "setUseCommandSpace", false)
        #expect(wait(d, "spotlight-shortcut", "\"enabled\":true"))
        // Settings page renders (no window on screen: only built).
        try d.invoke("keyboard", "setHyperKey", "off")
    }

    @Test func finderActionsOnTestSelection() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("finder", "setTestSelection", ["paths": ["/Users/me/a b.txt"], "folder": "/Users/me"])
        try d.type("copy path of selection")
        _ = try d.key("enter")
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "/Users/me/a b.txt")
        _ = try d.show()
        try d.setQueryEmpty()
        try d.type("new file here")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "finder.newFile")
        try d.type("notes.md")
        try snap(d, "finder-newfile")
        s = try d.key("enter")
        #expect(wait(d, "finder.newFile", "notes.md"))
        _ = try d.show()
        try d.setQueryEmpty()
        try d.type("open terminal here")
        _ = try d.key("enter")
        #expect(wait(d, "exec", "/Users/me"))
    }

    @Test func processesAndPorts() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("port 1")
        #expect(rows(s).contains { ($0["id"] as? String)?.hasPrefix("processes:port:1") == true })
        try d.setQueryEmpty()
        s = try d.type("kill process")
        // "Kill Port" takes an argument, so it can rank first for "kill …": select the Kill Process row explicitly.
        let idx = try #require(rows(s).firstIndex { $0["id"] as? String == "processes:list" })
        for _ in 0..<idx { try d.key("down") }
        _ = try d.key("enter")
        #expect(try waitView(d, "processes.list")) // the first list primes CPU counters (~250 ms)
        try snap(d, "processes")
        // Signals are confirmed and recorded, never sent (target: the headless Glide itself).
        let pid = Int(d.process.processIdentifier)
        let r = try d.invoke("processes", "signal", ["pid": pid])["result"] as? [String: Any]
        #expect(r?["ok"] as? Bool == true)
        #expect(effects(d, "confirm").contains { $0.contains("Glide itself") })
        #expect(wait(d, "process-signal", "\"pid\":\(pid)"))
        #expect(d.process.isRunning)
    }

    @Test func systemMonitorGlanceAndView() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        let s = try d.type("cpu")
        let glance = rows(s).first { $0["id"] as? String == "sysmon:glance" }
        #expect((glance?["title"] as? String)?.hasPrefix("CPU ") == true)
        try d.setQueryEmpty()
        try d.type("system monitor")
        let v = try d.key("enter")
        #expect(v["view"] as? String == "sysmon.monitor")
        usleep(1_200_000)
        try snap(d, "sysmon")
    }

    @Test func syscmdsAreRecordedNotRun() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        let s = try d.type("toggle hidden files")
        #expect(rows(s).first?["id"] as? String == "syscmds:toggleHiddenFiles")
        _ = try d.key("enter")
        #expect(wait(d, "exec", "AppleShowAllFiles"))
        #expect(wait(d, "exec", "killall"))
        _ = try d.show()
        try d.setQueryEmpty()
        try d.type("restart finder")
        _ = try d.key("enter")
        #expect(wait(d, "confirm", "Restart Finder"))
    }
}

private extension GlideDriver {
    func setQueryEmpty() throws { _ = try send(["cmd": "setQuery", "text": ""]) }
}
