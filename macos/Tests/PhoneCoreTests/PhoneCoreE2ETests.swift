import Foundation
import GlideCore
import GlideFeatures
import GlideTestHarness
import Testing

/// End to end through the real headless binary: GLIDE_PHONE_HOST=127.0.0.1 (never all interfaces), a device paired
/// with the headless-only `pairDevice` hook, then encrypted calls over real HTTP.
@Suite("Phone core E2E (headless app over loopback HTTP)", .serialized)
struct PhoneCoreE2ETests {
    static func result(_ r: [String: Any]) -> [String: Any] { r["result"] as? [String: Any] ?? [:] }

    static func post(_ url: URL, _ body: Data) async throws -> (Int, Data) {
        var req = URLRequest(url: url.appendingPathComponent("api"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let (data, resp) = try await URLSession.shared.data(for: req)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    @Test func pairHelloStatusSendOverHTTP() async throws {
        let d = try GlideDriver(environment: ["GLIDE_PHONE_HOST": "127.0.0.1", "GLIDE_PHONE_PORT": "0"])
        defer { d.stop() }

        // Off by default: nothing listens.
        #expect(Self.result(try d.invoke("phone", "state"))["running"] as? Bool == false)
        let on = Self.result(try d.invoke("phone", "setEnabled", true))
        #expect(on["running"] as? Bool == true)
        #expect(on["bonjour"] as? Bool == false)
        let urlText = try #require(on["url"] as? String)
        #expect(urlText.hasPrefix("http://127.0.0.1:"))
        let base = try #require(URL(string: urlText))

        // The web app is served unauthenticated.
        let (html, r0) = try await URLSession.shared.data(from: base)
        #expect((r0 as? HTTPURLResponse)?.statusCode == 200 && !html.isEmpty)

        let pair = Self.result(try d.invoke("phone", "pairDevice", ["name": "E2E iPhone", "activate": false]))
        let deviceId = try #require(pair["deviceId"] as? String)
        let key = try #require((pair["key"] as? String).flatMap(PhoneCrypto.fromBase64url))
        #expect(key.count == 32)

        // hello activates the pending device.
        let (s1, b1) = try await Self.post(base, try PhoneEnvelope.request(action: "hello", args: ["name": "E2E iPhone"], key: key, deviceId: deviceId))
        #expect(s1 == 200)
        let hello = try PhoneEnvelope.response(b1, key: key, deviceId: deviceId)
        #expect(hello["ok"] == true && hello["result"]?["device"]?["name"] == "E2E iPhone")
        let devices = try d.invoke("phone", "devices")["result"] as? [[String: Any]] ?? []
        #expect(devices.first?["name"] as? String == "E2E iPhone" && devices.first?["lastSeen"] is NSNumber)

        let (s2, b2) = try await Self.post(base, try PhoneEnvelope.request(action: "status", args: [:], key: key, deviceId: deviceId))
        #expect(s2 == 200)
        let status = try PhoneEnvelope.response(b2, key: key, deviceId: deviceId)
        #expect(status["ok"] == true && status["result"]?["timers"]?.arrayValue != nil)

        // send → clipboard is recorded as a headless side effect, never a real pasteboard write.
        let (s3, b3) = try await Self.post(base, try PhoneEnvelope.request(action: "send", args: ["text": "from the phone", "to": "clipboard"], key: key, deviceId: deviceId))
        #expect(s3 == 200)
        #expect(try PhoneEnvelope.response(b3, key: key, deviceId: deviceId)["ok"] == true)
        #expect(d.sideEffects.contains { $0.kind == "pasteboard-set" && $0.detail.contains("from the phone") })

        // Gated: clipboard.get is off until the Clipboard group is on.
        let (_, b4) = try await Self.post(base, try PhoneEnvelope.request(action: "clipboard.get", args: [:], key: key, deviceId: deviceId))
        #expect(try PhoneEnvelope.response(b4, key: key, deviceId: deviceId)["error"]?["code"] == "denied")
        _ = try d.invoke("phone", "setGroup", ["group": "clipboard", "enabled": true])
        let (_, b5) = try await Self.post(base, try PhoneEnvelope.request(action: "clipboard.get", args: [:], key: key, deviceId: deviceId))
        #expect(try PhoneEnvelope.response(b5, key: key, deviceId: deviceId)["result"]?["text"] == "from the phone")

        // Ask: mac.sleep waits for an answer on the Mac (answered through the test channel).
        async let asked = Self.post(base, try PhoneEnvelope.request(action: "mac.sleep", args: [:], key: key, deviceId: deviceId))
        var pending: [[String: Any]] = []
        for _ in 0..<100 where pending.isEmpty {
            pending = try d.invoke("phone", "pending")["result"] as? [[String: Any]] ?? []
            if pending.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
        }
        #expect(pending.first?["deviceName"] as? String == "E2E iPhone")
        _ = try d.invoke("phone", "respond", ["decision": "deny"])
        let (s6, b6) = try await asked
        let denied = try PhoneEnvelope.response(b6, key: key, deviceId: deviceId)
        #expect(s6 == 200 && denied["error"]?["code"] == "denied")

        // Replaying a captured request is refused.
        let replay = try PhoneEnvelope.request(action: "status", args: [:], key: key, deviceId: deviceId)
        #expect(try await Self.post(base, replay).0 == 200)
        let (s7, b7) = try await Self.post(base, replay)
        #expect(s7 == 401 && String(decoding: b7, as: UTF8.self) == #"{"error":"unpaired"}"#)

        // The request log names actions and outcomes only.
        let log = try d.invoke("phone", "log")["result"] as? [[String: Any]] ?? []
        #expect(log.contains { $0["action"] as? String == "send" && $0["outcome"] as? String == "ok" })
        #expect(!String(describing: log).contains("from the phone"))

        // Revoked devices are unpaired.
        #expect(try d.invoke("phone", "revokeDevice", ["id": deviceId])["result"] as? Bool == true)
        #expect(try await Self.post(base, try PhoneEnvelope.request(action: "status", args: [:], key: key, deviceId: deviceId)).0 == 401)

        // Turning it off closes the port.
        #expect(Self.result(try d.invoke("phone", "setEnabled", false))["running"] as? Bool == false)
        let closed = try? await Self.post(base, replay)
        #expect(closed == nil)
    }

    @Test func headlessWithoutHostNeverListens() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        let st = Self.result(try d.invoke("phone", "setEnabled", true))
        #expect(st["running"] as? Bool == false && st["url"] is NSNull)
        let r = try d.invoke("phone", "snapshotSettings", ["path": (d.dataDirectory.path as NSString).appendingPathComponent("phone-settings.png")])
        #expect((Self.result(r)["width"] as? Double ?? 0) > 0)
    }
}
