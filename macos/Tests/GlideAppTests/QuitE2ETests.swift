import Foundation
import GlideTestHarness
import Testing

/// Quit must actually quit. "Quit Glide" from the launcher runs inside a Swift task; calling NSApp.terminate there
/// used to deadlock (AppKit's terminateLater wait can't drain the main queue it is already inside), so Glide hung
/// half-quit and the updater's restart never happened. The process must exit cleanly, well before the 8 s fallback.
@Suite("quit", .serialized)
struct QuitE2ETests {
    @Test func quitCommandExitsCleanly() throws {
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1"])
        defer { d.stop() }
        _ = try d.show()
        _ = try d.send(["cmd": "setQuery", "text": "quit glide"])
        #expect(try d.selectedTitle() == "Quit Glide")
        let t0 = Date()
        _ = try? d.key("enter")
        while d.process.isRunning, Date().timeIntervalSince(t0) < 12 { usleep(50_000) }
        let took = Date().timeIntervalSince(t0)
        #expect(!d.process.isRunning, "Glide is still running \(took) s after Quit")
        #expect(took < 6, "quit took \(took) s (the 8 s safety exit must not be what ends it)")
        #expect(d.process.terminationStatus == 0)
    }
}
