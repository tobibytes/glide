import Foundation
import GlideTestHarness
import Testing

/// Shared status-item API through the real binary, headless: the recording fake service (never an NSStatusItem)
/// is read with `menubar.statusItems` / clicked with `menubar.statusClick`.
@Suite("status items (headless driver)", .serialized)
struct StatusItemsE2ETests {
    private func poll(_ timeout: TimeInterval = 10, _ cond: () throws -> Bool) rethrows -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if try cond() { return true }
            usleep(50_000)
        }
        return try cond()
    }

    private func items(_ d: GlideDriver) throws -> [[String: Any]] {
        ((try d.invoke("menubar", "statusItems")["result"] as? [String: Any])?["items"] as? [[String: Any]]) ?? []
    }
    private func item(_ d: GlideDriver, _ id: String) throws -> [String: Any]? { try items(d).first { $0["id"] as? String == id } }

    @Test func timersAndFocusInGlideIconThenSeparate() throws {
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1"])
        defer { d.stop() }
        // Glide's own icon is registered through the API (headless: state only).
        #expect(try poll { (try item(d, "glide")?["menu"] as? [[String: Any]])?.contains { ($0["title"] as? String)?.hasPrefix("Open Glide") == true } == true })
        // The Menu Bar Timers extra (default on) would hold the timers; turn it off so Timers shows itself.
        _ = try d.invoke("menubar", "setSettings", ["timers": false])
        let settings = try d.invoke("menubar", "getSettings")["result"] as? [String: Any]
        #expect(settings?["combineWithGlide"] as? Bool == true) // "Show timers and focus in Glide's menu bar icon" defaults on
        _ = try d.invoke("timers", "start", ["ms": 180_000, "name": "Tea"])
        _ = try d.invoke("focus", "start", ["goal": "write", "minutes": 25])
        #expect(try poll {
            let g = try item(d, "glide")
            let t = g?["title"] as? String ?? ""
            return t.contains("⏱") && t.contains("◷") && (g?["sources"] as? [String]) == ["timers", "focus"]
        })
        #expect(try items(d).map { $0["id"] as? String } == ["glide"]) // no separate icons
        let menu = try item(d, "glide")?["menu"] as? [[String: Any]] ?? []
        #expect(menu.compactMap { $0["header"] as? String } == ["Timers", "Focus"])
        // Focus ▸ Pause from Glide's menu.
        let pause = try #require(menu.firstIndex { $0["title"] as? String == "Pause" })
        #expect(try d.invoke("menubar", "statusClick", ["id": "glide", "path": [pause]])["result"] as? Bool == true)
        #expect(try poll { (try item(d, "glide")?["title"] as? String)?.contains("❚❚") == true })
        // Setting off → separate items like before.
        _ = try d.invoke("menubar", "setSettings", ["combineWithGlide": false])
        #expect(try poll { Set(try items(d).compactMap { $0["id"] as? String }) == ["glide", "timers", "focus"] })
        #expect((try item(d, "glide")?["title"] as? String) == "")
        #expect(d.sideEffects.contains { $0.kind == "status-item" && $0.detail.contains("\"focus\"") })
    }

    @Test func raycastMenuBarCommandRendersStatusItem() throws {
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1"])
        defer { d.stop() }
        let inst = try d.invoke("extensions", "installExample", ["path": "raycast-fixtures/rc-compat"])
        try #require((inst["result"] as? [String: Any])?["name"] as? String == "rc-compat", "\(inst)")
        let run = try d.invoke("extensions", "run", ["name": "rc-compat", "command": "menu-status"])
        #expect((run["result"] as? [String: Any])?["result"] as? String == "hide", "\(run)")
        #expect(try poll { (try item(d, "ext:rc-compat/menu-status")?["title"] as? String) == "C0" })
        #expect(try d.invoke("extensions", "menuBarClick", ["ext": "rc-compat", "command": "menu-status", "path": [1]])["result"] as? Bool == true)
        #expect(try poll { (try item(d, "ext:rc-compat/menu-status")?["title"] as? String) == "C1" })
        _ = try d.invoke("extensions", "setBackground", ["ext": "rc-compat", "command": "menu-status", "enabled": false])
        #expect(try poll { try item(d, "ext:rc-compat/menu-status") == nil })
    }
}
