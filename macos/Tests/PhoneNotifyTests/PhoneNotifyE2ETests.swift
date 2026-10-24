import Foundation
import GlideTestHarness
import Testing

/// End to end with the real Glide binary (headless, test channel): a finished timer reaches a loopback fake
/// ntfy server; Settings state and the test notification go through `invoke phone notify.*`.
@Suite("phone-notify headless end-to-end", .serialized)
struct PhoneNotifyE2ETests {
    func seed(_ ntfyBase: String, extra: [String: Any] = [:]) throws -> [String: Data] {
        var notify: [String: Any] = ["enabled": true, "server": ntfyBase, "topic": "glide-e2etopic", "timer": true, "automation": true, "confirmation": true]
        for (k, v) in extra { notify[k] = v }
        let data: [String: Any] = ["settings": ["features": ["phone": ["notify": notify]]]]
        return ["data.json": try JSONSerialization.data(withJSONObject: data)]
    }

    func driver(_ ntfy: FakeNtfy, extra: [String: Any] = [:], env: [String: String] = [:]) throws -> GlideDriver {
        var e = env
        e["GLIDE_PHONE_HOST"] = "127.0.0.1"
        e["GLIDE_PHONE_PORT"] = "0"
        if let tmp = ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"] { e["GLIDE_PHONE_RELAY_DIR"] = tmp + "/relay-\(UUID().uuidString)" }
        return try GlideDriver(seed: try seed(ntfy.baseURL, extra: extra), environment: e)
    }

    func waitFor(_ timeout: Double = 8, _ cond: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if cond() { return true }
            usleep(50_000)
        }
        return cond()
    }

    @Test func timerFinishedReachesThePhone() throws {
        let ntfy = try FakeNtfy()
        defer { ntfy.stop() }
        let d = try driver(ntfy, env: ["GLIDE_PHONE_NTFY_TEST_TOKEN": "tk_e2e"])
        defer { d.stop() }
        let started = try d.invoke("timers", "start", ["ms": 1000, "name": "Tea"])
        #expect((started["result"] as? [String: Any])?["ok"] as? Bool == true)
        #expect(waitFor { !ntfy.posts.isEmpty })
        let p = try #require(ntfy.posts.first)
        #expect(p.path == "/glide-e2etopic")
        #expect(p.headers["title"] == "Timer done")
        #expect(p.headers["tags"] == "alarm_clock")
        #expect(p.headers["authorization"] == "Bearer tk_e2e")
        #expect(String(decoding: p.body, as: UTF8.self) == "Tea is done.")
        // The Mac notification still happens as before.
        #expect(d.sideEffects.contains { $0.kind == "notify" || $0.kind == "notification" })
        let state = (try d.invoke("phone", "notify.state")["result"] as? [String: Any]) ?? [:]
        let history = (state["history"] as? [[String: Any]]) ?? []
        #expect(history.first?["outcome"] as? String == "sent")
        #expect(history.first?["kind"] as? String == "timer")
        #expect(state["hasToken"] as? Bool == true)
    }

    @Test func timerSwitchOffAndTestNotification() throws {
        let ntfy = try FakeNtfy()
        defer { ntfy.stop() }
        let d = try driver(ntfy, extra: ["timer": false])
        defer { d.stop() }
        _ = try d.invoke("timers", "start", ["ms": 500, "name": "Quiet"])
        usleep(2_000_000)
        #expect(ntfy.posts.isEmpty)
        let t = (try d.invoke("phone", "notify.test")["result"] as? [String: Any]) ?? [:]
        #expect(t["outcome"] as? String == "sent")
        #expect(ntfy.posts.count == 1 && ntfy.posts.first?.headers["title"] == "Test from Glide")
        // Server validation through the settings method: http to a non-loopback host is refused.
        let bad = try d.send(["cmd": "invoke", "feature": "phone", "method": "notify.setSettings", "args": ["server": "http://ntfy.example.com"]])
        #expect(bad["ok"] as? Bool == false)
        let regen = (try d.invoke("phone", "notify.regenerateTopic")["result"] as? [String: Any]) ?? [:]
        let topic = ((regen["settings"] as? [String: Any])?["topic"] as? String) ?? ""
        #expect(topic.hasPrefix("glide-") && topic.count == 38)
    }
}
