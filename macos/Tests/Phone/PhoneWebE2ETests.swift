import Foundation
import GlideCore
import GlideTestHarness
import Testing

/// Glide Remote end to end: the headless app's phone server on 127.0.0.1, the embedded web app in headless Chrome
/// (own profile), pairing through the #pair= fragment, real encrypted calls, and the recorded effects on the Mac side.
/// Screenshots (390x844) land in $GLIDE_PHONE_SHOTS when set.
@Suite("Phone web E2E (headless Chrome + headless app)", .serialized)
struct PhoneWebE2ETests {
    static func result(_ r: [String: Any]) -> [String: Any] { r["result"] as? [String: Any] ?? [:] }

    @Test func webAppPairsAndDrivesTheMac() throws {
        let node = try #require(PhoneWebSupport.node, "Node is needed for the browser E2E")
        let chrome = try #require(PhoneWebSupport.chrome, "Chrome is needed for the browser E2E (set GLIDE_CHROME)")
        let work = try PhoneWebSupport.scratch("e2e")
        defer { try? FileManager.default.removeItem(at: work) }
        let home = work.appendingPathComponent("home")
        let docs = home.appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        try Data("Glide Remote download check".utf8).write(to: docs.appendingPathComponent("remote-notes.txt"))
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library"), withIntermediateDirectories: true)
        try Data("never".utf8).write(to: home.appendingPathComponent("Library/remote-notes-secret.txt"))
        let profile = work.appendingPathComponent("chrome-profile")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)

        let d = try GlideDriver(environment: ["GLIDE_PHONE_HOST": "127.0.0.1", "GLIDE_PHONE_PORT": "0", "GLIDE_PHONE_FILES_HOME": home.path])
        defer { d.stop() }
        let on = Self.result(try d.invoke("phone", "setEnabled", true))
        let base = try #require(on["url"] as? String)
        #expect(base.hasPrefix("http://127.0.0.1:"))
        for g in ["remote", "files", "clipboard"] { _ = try d.invoke("phone", "setGroup", ["group": g, "enabled": true]) }
        _ = try d.invoke("fileindex", "setSettings", ["scopes": [home.path], "exclusions": [String]()])
        let pair = Self.result(try d.invoke("phone", "pairDevice", ["activate": false]))
        let deviceId = try #require(pair["deviceId"] as? String)
        let key = try #require(pair["key"] as? String)

        let shots = ProcessInfo.processInfo.environment["GLIDE_PHONE_SHOTS"] ?? ""
        let r = try PhoneWebSupport.run(node, [PhoneWebSupport.testsDir.appendingPathComponent("web-e2e.mjs").path], environment: [
            "GLIDE_BASE": base, "GLIDE_PAIR": "\(deviceId).\(key)", "GLIDE_CHROME": chrome, "GLIDE_PROFILE": profile.path, "GLIDE_SHOTS": shots,
            "GLIDE_FILE_QUERY": "remote-notes", "GLIDE_FILE_TEXT": "Glide Remote download check",
        ], timeout: 180)
        let steps = r.stdout.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        for s in steps where s["ok"] as? Bool != true { Issue.record("web step failed: \(s)") }
        #expect(r.status == 0, "web-e2e.mjs: \(r.stdout)\n\(r.stderr.suffix(2000))")
        #expect(steps.count >= 12, "\(r.stdout)")

        // The page paired the pending device with hello, under the phone's name.
        let devices = try d.invoke("phone", "devices")["result"] as? [[String: Any]] ?? []
        #expect(devices.first { $0["id"] as? String == deviceId }?["name"] as? String == "iPhone")

        // Effects on the Mac side, recorded by the headless fakes (no real pasteboard, no posted events).
        let fx = d.sideEffects
        #expect(fx.contains { $0.kind == "pasteboard-set" && $0.detail.contains("Hello from Glide Remote") })
        #expect(fx.contains { $0.kind == "remote-type" && $0.detail.contains("typed from the phone") })
        #expect(fx.contains { $0.kind == "remote-key" && $0.detail.contains("\"code\":40") && $0.detail.contains("cmd") })
        #expect(fx.contains { $0.kind == "remote-click" && $0.detail.contains("left") })
        #expect(fx.contains { $0.kind == "remote-move" })
        #expect(fx.contains { $0.kind == "remote-key" && $0.detail.contains("\"code\":124") }) // slides.next

        // Every call went through the gate and is logged without contents.
        let log = try d.invoke("phone", "log")["result"] as? [[String: Any]] ?? []
        for a in ["hello", "status", "send", "type.text", "pointer.click", "files.search", "files.get"] {
            #expect(log.contains { $0["action"] as? String == a && $0["outcome"] as? String == "ok" }, "\(a) logged as ok")
        }
        #expect(log.contains { $0["action"] as? String == "agent.ask" && $0["outcome"] as? String == "off" })
        #expect(!String(describing: log).contains("Hello from Glide Remote"))
    }

    /// Through the gate without the browser: remote and file actions are off until their switch is on, and LAN-only.
    @Test func remoteActionsAreGated() throws {
        let home = try PhoneWebSupport.scratch("gate-home")
        defer { try? FileManager.default.removeItem(at: home) }
        let d = try GlideDriver(environment: ["GLIDE_PHONE_FILES_HOME": home.path])
        defer { d.stop() }
        func perform(_ action: String, _ args: [String: Any] = [:], transport: String = "lan") throws -> [String: Any] {
            Self.result(try d.invoke("phone", "perform", ["action": action, "args": args, "transport": transport]))
        }
        let off = try perform("pointer.move", ["dx": 5, "dy": 5])
        #expect((off["error"] as? [String: Any])?["code"] as? String == "denied")
        #expect(((off["error"] as? [String: Any])?["message"] as? String)?.contains("Remote control") == true)
        _ = try d.invoke("phone", "setGroup", ["group": "remote", "enabled": true])
        #expect(try perform("pointer.move", ["dx": 5, "dy": 5])["ok"] as? Bool == true)
        #expect((try perform("pointer.move", ["dx": 5], transport: "relay")["error"] as? [String: Any])?["code"] as? String == "denied")
        #expect(d.sideEffects.filter { $0.kind == "remote-move" }.count == 1)
        #expect((try perform("files.get", ["path": "/etc/hosts"])["error"] as? [String: Any])?["code"] as? String == "denied")
        _ = try d.invoke("phone", "setGroup", ["group": "files", "enabled": true])
        #expect((try perform("files.get", ["path": "/etc/hosts"])["error"] as? [String: Any])?["code"] as? String == "not-allowed")
    }

    /// Without Accessibility the remote actions say so instead of failing silently.
    @Test func missingAccessibilityThroughTheGate() throws {
        let d = try GlideDriver(environment: ["GLIDE_HEADLESS_AX": "0"])
        defer { d.stop() }
        _ = try d.invoke("phone", "setGroup", ["group": "remote", "enabled": true])
        let r = Self.result(try d.invoke("phone", "perform", ["action": "type.text", "args": ["text": "x"]]))
        #expect((r["error"] as? [String: Any])?["code"] as? String == "needs-permission")
        #expect(!d.sideEffects.contains { $0.kind == "remote-type" })
    }
}
