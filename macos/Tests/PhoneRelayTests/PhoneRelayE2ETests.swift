import Foundation
import GlideTestHarness
import Testing

/// Headless E2E: the real Glide binary with GLIDE_PHONE_RELAY_DIR in scratch. Drop inbox files like a shortcut
/// would, wait for the outbox reply, check the effect on the (fake) Mac clipboard and the clipboard mirror.
@Suite("phone relay E2E", .serialized)
struct PhoneRelayE2ETests {
    func seed(_ phone: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["settings": ["onboardingDone": true, "features": ["phone": phone]]])
    }

    func waitFor(_ url: URL, timeout: TimeInterval = 10, until: (([String: Any]) -> Bool)? = nil) -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let d = try? Data(contentsOf: url), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], until?(o) ?? true { return o }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return nil
    }

    func drop(_ root: URL, _ id: String, _ action: String, _ args: [String: Any]) throws {
        let inbox = root.appendingPathComponent("inbox")
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        let body: [String: Any] = ["v": 1, "id": id, "action": action, "args": args, "from": "Shortcuts"]
        // Write it the way iCloud does: a temp name first, then the final name.
        let tmp = inbox.appendingPathComponent(".\(id).json.sync")
        try JSONSerialization.data(withJSONObject: body).write(to: tmp)
        try FileManager.default.moveItem(at: tmp, to: inbox.appendingPathComponent("\(id).json"))
    }

    @Test func shortcutRequestsRoundTripThroughTheRelay() throws {
        let root = RelayScratch.fresh("e2e-relay")
        let d = try GlideDriver(seed: ["data.json": try seed(["relay": true, "clipboardMirror": true, "groups": ["clipboard": true]])],
                                environment: ["GLIDE_PHONE_RELAY_DIR": root.path, "GLIDE_PHONE_RELAY_POLL_MS": "300"])
        defer { d.stop(); try? FileManager.default.removeItem(at: root) }

        let status = try d.invoke("phone", "relay.status")["result"] as? [String: Any]
        #expect(status?["running"] as? Bool == true)
        #expect(status?["mirror"] as? Bool == true)
        #expect((status?["roots"] as? [String])?.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } == [root.resolvingSymlinksInPath().path])

        // Phone → Mac clipboard.
        try drop(root, "e2e-1", "clipboard.set", ["text": "hello from the iPhone"])
        let reply = waitFor(root.appendingPathComponent("outbox/e2e-1.json"))
        #expect(reply?["ok"] as? Bool == true)
        #expect(reply?["id"] as? String == "e2e-1")
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "hello from the iPhone")
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("inbox/e2e-1.json").path))

        // The mirror follows the Mac clipboard (Clipboard History's watcher), so "Get Mac Clipboard" reads it.
        let mirror = root.appendingPathComponent("clipboard.json")
        #expect(waitFor(mirror) { $0["text"] as? String == "hello from the iPhone" } != nil)
        _ = try d.invoke("clipboard", "debugSetClipboard", ["text": "copied on the Mac"])
        #expect(waitFor(mirror) { $0["text"] as? String == "copied on the Mac" } != nil)
        // A password manager's copy is never mirrored.
        _ = try d.invoke("clipboard", "debugSetClipboard", ["text": "hunter2", "extraTypes": ["org.nspasteboard.ConcealedType"]])
        Thread.sleep(forTimeInterval: 1)
        #expect(waitFor(mirror, timeout: 1)?["text"] as? String == "copied on the Mac")

        // Live controls are LAN-only: denied over the relay.
        try drop(root, "e2e-2", "media", ["key": "playpause"])
        let denied = waitFor(root.appendingPathComponent("outbox/e2e-2.json"))
        #expect(denied?["ok"] as? Bool == false)
        #expect((denied?["error"] as? [String: Any])?["code"] as? String == "denied")
        #expect(!d.sideEffects.contains { $0.kind.contains("media") })

        // Bad JSON that is no longer being written gets an error reply.
        let bad = root.appendingPathComponent("inbox/broken.json")
        try Data("{not json".utf8).write(to: bad)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-120)], ofItemAtPath: bad.path)
        let err = waitFor(root.appendingPathComponent("outbox/broken.json"))
        #expect((err?["error"] as? [String: Any])?["code"] as? String == "bad-request")

        // Turning the mirror off removes clipboard.json.
        _ = try d.invoke("phone", "relay.set", ["clipboardMirror": false])
        #expect(!FileManager.default.fileExists(atPath: mirror.path))
    }

    @Test func relayStaysOffUntilTurnedOn() throws {
        let root = RelayScratch.fresh("e2e-off")
        let d = try GlideDriver(seed: ["data.json": try seed(["groups": ["clipboard": true]])],
                                environment: ["GLIDE_PHONE_RELAY_DIR": root.path, "GLIDE_PHONE_RELAY_POLL_MS": "300"])
        defer { d.stop(); try? FileManager.default.removeItem(at: root) }
        try drop(root, "off-1", "clipboard.set", ["text": "should not land"])
        Thread.sleep(forTimeInterval: 1.5)
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("outbox/off-1.json").path))
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String != "should not land")
        // Turn it on from the test channel: the waiting request is answered.
        _ = try d.invoke("phone", "relay.set", ["relay": true])
        #expect(waitFor(root.appendingPathComponent("outbox/off-1.json"))?["ok"] as? Bool == true)
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "should not land")
    }
}
