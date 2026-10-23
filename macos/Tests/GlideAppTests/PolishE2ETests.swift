import Foundation
import GlideTestHarness
import Testing

/// Fix round ("polish"): reminder delete end to end (fixture EventKit), readable footer titles for every pushed
/// view, and command arguments pre-filling the pushed view's search field — all through the headless app.
private func rows(_ s: [String: Any]) -> [[String: Any]] { (s["rows"] as? [[String: Any]]) ?? [] }
private func poll(_ tries: Int = 80, _ what: () throws -> Bool) rethrows -> Bool {
    for _ in 0..<tries { if try what() { return true }; usleep(50_000) }
    return try what()
}
private let tmpRoot = ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory

@Suite("polish: delete reminders, view titles, argument pre-fill", .serialized)
struct PolishE2ETests {
    @Test func deleteReminderWithControlXTwice() throws {
        let fixture = tmpRoot.appendingPathComponent("polish-ek-\(UUID().uuidString).json")
        try Data(#"{"lists":[{"id":"L1","title":"Reminders","isDefault":true,"writable":true}],"reminders":[{"id":"r1","title":"Pay rent","completed":false,"priority":0,"listId":"L1","listTitle":"Reminders"},{"id":"r2","title":"Water plants","completed":false,"priority":0,"listId":"L1","listTitle":"Reminders"}]}"#.utf8).write(to: fixture)
        defer { try? FileManager.default.removeItem(at: fixture) }
        let d = try GlideDriver(environment: ["GLIDE_EVENTKIT_FIXTURE": fixture.path])
        defer { d.stop() }
        _ = try d.show()
        try d.send(["cmd": "setQuery", "text": "my reminders"])
        var s = try d.key("enter")
        #expect(s["view"] as? String == "reminders.list")
        #expect(s["contextTitle"] as? String == "My Reminders")
        func vs() throws -> [String: Any] { (try d.invoke("reminders", "viewState", ["view": "list"])["result"] as? [String: Any]) ?? [:] }
        #expect(try poll { rows(try vs()).contains { $0["id"] as? String == "r1" } })
        let first = rows(try vs()).first { $0["selected"] as? Bool == true }
        #expect((first?["actions"] as? [String])?.contains("Delete Reminder") == true)
        let target = first?["id"] as? String ?? ""
        s = try d.key("ctrl+x")
        #expect(try poll { (try d.state()["toast"] as? String) == "Press again to delete reminder" })
        #expect(rows(try vs()).count == 2)
        try d.key("ctrl+x")
        #expect(try poll { !rows(try vs()).contains { $0["id"] as? String == target } })
        let st = (try d.invoke("reminders", "state")["result"] as? [String: Any]) ?? [:]
        #expect(((st["reminders"] as? [[String: Any]]) ?? []).map { $0["id"] as? String } == [target == "r1" ? "r2" : "r1"])
        // reminders.delete {id} (agent / MCP path)
        let left = target == "r1" ? "r2" : "r1"
        let r = (try d.invoke("reminders", "delete", ["id": left])["result"] as? [String: Any]) ?? [:]
        #expect(r["ok"] as? Bool == true)
    }

    @Test func everyPushedViewShowsAHumanTitle() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        let views = ["ai.chat", "agent.run", "agent.history", "automations.list", "clipboard.history", "clipboard.stack", "fileindex.search",
                     "finder.newFile", "layouts.list", "layouts.save", "menus.search", "processes.list", "processes.ports", "snippets2.search",
                     "sysmon.monitor", "workflows.prompt", "workflows.result", "appearance.switch", "browser.bookmarks", "browser.history",
                     "calendar.schedule", "color.history", "emoji.picker", "focus.start", "focus.stats", "focus.blocklist", "mcp-server.confirm",
                     "notes.search", "ocr.result", "ocr.codes", "quicklinks.create", "reminders.list", "reminders.create", "timers.list",
                     "transforms.transform", "workflows.run", "glide.shortcuts"]
        var seen: [String: String] = [:]
        for v in views {
            let s = try d.invoke("launcher", "push", ["view": v, "payload": NSNull()])
            let t = s["contextTitle"] as? String ?? ""
            seen[v] = t
            #expect(!t.isEmpty && !t.contains(".") && !t.contains("~"), "\(v) → \(t)")
            try d.invoke("launcher", "pop")
        }
        #expect(seen["ai.chat"] == "Quick AI")
        #expect(seen["reminders.create"] == "New Reminder")
        #expect(seen["emoji.picker"] == "Search Emoji & Symbols")
    }

    @Test func argumentsPrefillTheSearchField() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        // Tab → argument → ⏎
        for (cmd, title, arg, view) in [("search files", "Search Files", "report", "fileindex.search"),
                                         ("search emoji", "Search Emoji & Symbols", "smile", "emoji.picker"),
                                         ("search bookmarks", "Search Bookmarks", "git", "browser.bookmarks"),
                                         ("search notes", "Search Notes", "todo", "notes.search"),
                                         ("clipboard history", "Clipboard History", "abc", "clipboard.history"),
                                         ("search snippets", "Search Snippets", "sig", "snippets2.search")] {
            try d.send(["cmd": "setQuery", "text": cmd])
            #expect(try d.selectedTitle() == title, "\(cmd)")
            try d.key("tab")
            #expect(try d.state()["argumentFor"] as? String == title, "\(cmd)")
            try d.type(arg)
            let s = try d.key("enter")
            #expect(try poll { (try d.state()["view"] as? String) == view }, "\(cmd)")
            #expect(try d.state()["query"] as? String == arg, "\(cmd)")
            #expect(try d.state()["contextTitle"] as? String == title, "\(cmd) \(s["contextTitle"] ?? "")")
            try d.invoke("launcher", "pop")
            try d.send(["cmd": "setQuery", "text": ""])
        }
        // Inline: the whole title, then the text ("search files quarterly report").
        try d.send(["cmd": "setQuery", "text": "search files quarterly report"])
        let top = rows(try d.state()).first
        #expect(top?["title"] as? String == "Search Files")
        #expect(top?["argument"] as? String == "quarterly report")
        try d.key("enter")
        #expect(try poll { (try d.state()["view"] as? String) == "fileindex.search" })
        #expect(try d.state()["query"] as? String == "quarterly report")
    }

    @Test func nestedExtensionPushIsNamedAfterTheCommand() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("extensions", "installExample", ["path": "raycast-fixtures/rc-fruits"])
        try d.send(["cmd": "setQuery", "text": "browse fruits"])
        let cmdTitle = try d.selectedTitle() ?? ""
        try d.key("enter")
        try d.invoke("extensions", "setField", ["id": "greeting", "value": "Howdy"])
        try d.key("cmd+enter")
        func ev() throws -> [String: Any] { (try d.invoke("extensions", "view")["result"] as? [String: Any]) ?? [:] }
        #expect(try poll { ((try ev()["rows"] as? [Any]) ?? []).count == 7 })
        try d.key("enter") // Action.Push → Detail at depth 1 (pushed by the runtime, no item title)
        #expect(try poll { (try ev()["depth"] as? Int) == 1 })
        let t = try d.state()["contextTitle"] as? String ?? ""
        #expect(!t.isEmpty && t != "Extensions" && !t.contains("~") && !t.contains("extensions."), "\(t) (command \(cmdTitle))")
    }
}
