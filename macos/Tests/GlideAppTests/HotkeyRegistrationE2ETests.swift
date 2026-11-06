import Foundation
import GlideTestHarness
import Testing

/// Changing the launcher hotkey in Settings: one macOS refuses is rolled back (so Glide can still be opened) and
/// Settings says why; one macOS also uses is kept with a warning.
@Suite("launcher hotkey registration", .serialized)
struct HotkeyRegistrationE2ETests {
    private func status(_ d: GlideDriver) throws -> [String: Any] { (try d.invoke("launcher", "hotkeyStatus")["result"] as? [String: Any]) ?? [:] }
    private func wait(_ f: () throws -> Bool) rethrows -> Bool {
        for _ in 0..<60 { if try f() { return true }; usleep(50_000) }
        return try f()
    }

    @Test func refusedHotkeyRollsBack() throws {
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1", "GLIDE_HEADLESS_TAKEN_HOTKEYS": "Alt+Q"])
        defer { d.stop() }
        #expect(try status(d)["hotkey"] as? String == "Alt+Space")
        _ = try d.invoke("store", "setSettings", ["hotkey": "Alt+Q"])
        #expect(try wait { try status(d)["hotkey"] as? String == "Alt+Space" })
        let s = try status(d)
        #expect(s["message"] as? String == "Couldn't use ⌥Q: in use by another app. Glide kept ⌥Space.", "\(s)")
        #expect(s["warning"] as? Bool == false)
        // A shortcut that works clears the message.
        _ = try d.invoke("store", "setSettings", ["hotkey": "Control+Alt+G"])
        #expect(try wait { try status(d)["message"] is NSNull })
        #expect(try status(d)["hotkey"] as? String == "Control+Alt+G")
    }

    @Test func systemShortcutIsKeptWithAWarning() throws {
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1", "GLIDE_HEADLESS_SYSTEM_HOTKEYS": "Control+Alt+M"])
        defer { d.stop() }
        _ = try d.invoke("store", "setSettings", ["hotkey": "Control+Alt+M"])
        #expect(try wait { (try status(d)["message"] as? String)?.contains("also a macOS shortcut") == true })
        let s = try status(d)
        #expect(s["warning"] as? Bool == true && s["hotkey"] as? String == "Control+Alt+M")
    }

    /// The lock file names the running Glide, so a stuck one can be found and replaced.
    @Test func lockFileRecordsThePid() throws {
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1"])
        defer { d.stop() }
        let lock = d.dataDirectory.appendingPathComponent("glide-native.lock")
        let pid = try String(contentsOf: lock, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(pid == String(d.process.processIdentifier))
    }
}
