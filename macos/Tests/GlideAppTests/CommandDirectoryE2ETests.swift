import Foundation
import GlideTestHarness
import Testing

/// "What Can Glide Do?": every command grouped by feature, filterable, ⏎ runs it from the root search.
@Suite("command directory", .serialized)
struct CommandDirectoryE2ETests {
    private func rows(_ d: GlideDriver) throws -> [[String: Any]] {
        ((try d.invoke("glide", "viewState")["result"] as? [String: Any])?["rows"] as? [[String: Any]]) ?? []
    }

    @Test func listsFiltersAndOpensCommands() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.send(["cmd": "setQuery", "text": "what can glide do"])
        #expect(try d.selectedTitle() == "What Can Glide Do?")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "glide.commands")
        #expect(s["contextTitle"] as? String == "What Can Glide Do?")
        let all = try rows(d)
        let sections = Set(all.compactMap { $0["section"] as? String })
        #expect(all.count > 40)
        #expect(sections.count > 10)
        #expect(!sections.contains("Applications") && !sections.contains("Files"))
        #expect(all.first?["section"] as? String == "Just Type It")
        #expect(all.contains { $0["title"] as? String == "Capture Text" })
        // Filter, then ⏎ opens the command (Keyboard Shortcuts is a pushed view of its own).
        try d.send(["cmd": "setQuery", "text": "keyboard shortcuts"])
        let filtered = try rows(d)
        #expect(filtered.first?["title"] as? String == "Keyboard Shortcuts")
        #expect((filtered.first?["actions"] as? [String])?.first == "Open Command")
        s = try d.key("enter")
        for _ in 0..<40 where s["view"] as? String != "glide.shortcuts" { usleep(50_000); s = try d.state() }
        #expect(s["view"] as? String == "glide.shortcuts")
        #expect(try d.state()["view"] as? String == "glide.shortcuts")
    }

    /// Every "Just Type It" example, typed into the root search, produces a result.
    @Test func typeExamplesWork() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        _ = try d.invoke("launcher", "push", ["view": "glide.commands", "payload": NSNull()])
        let examples = try rows(d).filter { $0["section"] as? String == "Just Type It" }
        #expect(examples.count == 10)
        try d.send(["cmd": "setQuery", "text": "port 3000"])
        _ = try d.key("enter") // Try It → root search with the example typed in
        let s = try d.state()
        #expect(s["view"] is NSNull)
        #expect(s["query"] as? String == "port 3000")
        for ex in examples.compactMap({ $0["title"] as? String }) {
            try d.send(["cmd": "setQuery", "text": ex])
            var top: [String: Any]? = nil
            for _ in 0..<40 {
                top = (try d.state()["rows"] as? [[String: Any]])?.first
                if top != nil { break }
                usleep(50_000)
            }
            #expect(top != nil, "\(ex) → no result")
            // Currency rates need the network (never fetched headless), so that one falls back to web search here.
            if !ex.contains("usd") { #expect(top?["kind"] as? String != "fallback", "\(ex) → only the web-search fallback") }
        }
    }
}
