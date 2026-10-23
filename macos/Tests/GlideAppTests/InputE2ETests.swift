import Foundation
import GlideTestHarness
import Testing

/// input-audit: paste-back with "Keep open after running" (the default). The paste action hides the launcher so the
/// user's app gets key focus back, then posts ⌘V; re-showing the launcher right after took the focus back, and the
/// ⌘V landed in Glide's own search field instead of the user's app.
@Suite("paste-back hands focus to the user's app", .serialized)
struct InputE2E {
    private func effects(_ d: GlideDriver, _ kind: String) -> [String] { d.sideEffects.filter { $0.kind == kind }.map(\.detail) }

    @Test func pasteActionKeepsTheLauncherHiddenWithKeepOpen() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        try d.invoke("store", "setSettings", ["keepOpenAfterRun": true])
        _ = try d.show()
        var s = try d.type("2+2")
        #expect(((s["rows"] as? [[String: Any]])?.first?["title"] as? String) == "= 4")
        // ↩ copies: no focus hand-off, keep-open still keeps the launcher up.
        s = try d.key("enter")
        #expect(s["visible"] as? Bool == true)
        #expect(effects(d, "pasteboard-set").contains { $0.contains("\"4\"") })
        // ⌘↩ pastes into the previous app: the launcher must stay out of the way.
        s = try d.key("cmdEnter")
        #expect(effects(d, "paste").contains { $0.contains("\"4\"") })
        #expect(s["visible"] as? Bool == false)
        usleep(150_000)
        #expect(try d.state()["visible"] as? Bool == false)
    }

    @Test func snippetPasteKeepsTheLauncherHiddenWithKeepOpen() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        try d.invoke("store", "setSettings", ["keepOpenAfterRun": true])
        _ = try d.show()
        let s = try d.type("shrug")
        #expect((s["rows"] as? [[String: Any]])?.first?["kind"] as? String == "snippet")
        try d.key("enter")
        #expect(effects(d, "paste").contains { $0.contains("(ツ)") })
        #expect(try d.state()["visible"] as? Bool == false)
    }
}
