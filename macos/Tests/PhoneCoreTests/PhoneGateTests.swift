import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

@MainActor @Suite("Phone gate, policies, confirmations, log")
struct PhoneGateTests {
    func action(_ name: String, group: String = "core", risk: PhoneRisk = .safe, sensitive: Bool = false, relay: Bool = true) -> PhoneAction {
        PhoneAction(name, name, group: group, risk: risk, sensitive: sensitive, relay: relay) { _, _ in "ran" }
    }

    @Test func defaults() {
        let s = PhoneSettings()
        #expect(PhoneGate.policy(action("a"), s) == .allow)
        #expect(PhoneGate.policy(action("b", risk: .confirm), s) == .ask)
        #expect(PhoneGate.policy(action("c", sensitive: true), s) == .off)
        // Switchable groups are off until turned on.
        #expect(PhoneGate.policy(action("d", group: "clipboard"), s) == .off)
        #expect(PhoneGate.policy(action("e", group: "remote"), s) == .off)
        #expect(PhoneGate.policy(action("f", group: "files"), s) == .off)
        #expect(PhoneGate.policy(action("g", group: "agent", risk: .confirm), s) == .off)
        #expect(PhoneGate.policy(action("h", group: "notify"), s) == .allow)
        var on = s
        on.groups = ["clipboard": true, "agent": true]
        #expect(PhoneGate.policy(action("d", group: "clipboard", sensitive: true), on) == .allow)
        #expect(PhoneGate.policy(action("g", group: "agent", risk: .confirm), on) == .ask)
        // The user's choice wins inside an enabled group; a disabled group always wins.
        on.policies = ["a": "off", "b": "allow", "e": "allow"]
        #expect(PhoneGate.policy(action("a"), on) == .off)
        #expect(PhoneGate.policy(action("b", risk: .confirm), on) == .allow)
        #expect(PhoneGate.policy(action("e", group: "remote"), on) == .off)
    }

    @Test func relayCannotUseLiveControls() {
        let a = action("pointer.move", group: "remote", relay: false)
        var s = PhoneSettings()
        s.groups = ["remote": true]
        #expect(PhoneGate.decide(a, s, caller: lanCaller) == .run)
        guard case let .deny(e) = PhoneGate.decide(a, s, caller: relayCaller) else { Issue.record("expected deny"); return }
        #expect(e.code == "denied")
    }

    @Test func performShapesAndLog() async throws {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        f.registry.register(action("t.ok"))
        f.registry.register(PhoneAction("t.fail", "Fail", group: "core") { _, _ in throw PhoneError.badArgs("nope") })
        let ok = await f.perform("t.ok", args: [:], caller: lanCaller)
        #expect(ok == ["ok": true, "result": "ran"])
        let fail = await f.perform("t.fail", args: [:], caller: lanCaller)
        #expect(fail["ok"] == false && fail["error"]?["code"] == "bad-args" && fail["error"]?["message"] == "nope")
        let nf = await f.perform("nope.nope", args: [:], caller: lanCaller)
        #expect(nf["error"]?["code"] == "not-found")
        let off = await f.perform("clipboard.get", args: [:], caller: lanCaller)
        #expect(off["error"]?["code"] == "denied")
        #expect(f.isGroupEnabled("core") && !f.isGroupEnabled("clipboard"))
        let outcomes = f.core.log.list.map(\.outcome)
        #expect(outcomes == ["off", "not-found", "error", "ok"])
        #expect(f.core.log.list.allSatisfy { $0.device == "Test iPhone" && $0.transport == "lan" })
    }

    @Test func confirmationAllowDenyAlwaysTimeout() async throws {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        f.registry.register(action("t.ask", risk: .confirm))
        var seen: [PhoneConfirmations.Request] = []
        f.confirmations.addObserver { seen.append($0) }

        // Allow once
        async let r1 = f.perform("t.ask", args: [:], caller: lanCaller)
        #expect(await waitUntil { f.confirmations.pending.count == 1 })
        #expect(ctx.pushes == ["phone.confirm"])
        #expect(seen.count == 1 && seen[0].deviceName == "Test iPhone" && seen[0].action == "t.ask")
        #expect(f.confirmations.respond(seen[0].id, decision: "allow"))
        #expect(!f.confirmations.respond(seen[0].id, decision: "allow"), "answered twice")
        #expect(await r1 == ["ok": true, "result": "ran"])

        // Deny
        async let r2 = f.perform("t.ask", args: [:], caller: lanCaller)
        #expect(await waitUntil { f.confirmations.pending.count == 1 })
        #expect(!f.confirmations.respond(f.confirmations.pending[0].id, decision: "maybe"))
        f.confirmations.respond(f.confirmations.pending[0].id, decision: "deny")
        #expect(await r2["error"]?["code"] == "denied")

        // Always: the next call from the same device runs without asking; another device still asks.
        async let r3 = f.perform("t.ask", args: [:], caller: lanCaller)
        #expect(await waitUntil { f.confirmations.pending.count == 1 })
        f.confirmations.respond(f.confirmations.pending[0].id, decision: "always")
        #expect(await r3["ok"] == true)
        #expect(f.phoneSettings.always["dev1"] == ["t.ask"])
        #expect(await f.perform("t.ask", args: [:], caller: lanCaller)["ok"] == true)
        #expect(f.confirmations.pending.isEmpty)

        // Timeout
        f.confirmations.timeout = { .milliseconds(100) }
        let other = PhoneCaller(deviceId: "dev2", deviceName: "Other", transport: .lan)
        let r4 = await f.perform("t.ask", args: [:], caller: other)
        #expect(r4["error"]?["code"] == "timeout")
        #expect(f.core.log.list.first?.outcome == "timeout")
        #expect(f.core.log.list.map(\.approval).contains("always"))
    }

    @Test func tooManyPendingAreDenied() async {
        let c = PhoneConfirmations()
        c.maxPending = 1
        async let first = c.request(caller: lanCaller, action: "a", title: "A", summary: "A")
        #expect(await waitUntil { c.pending.count == 1 })
        #expect(await c.request(caller: lanCaller, action: "b", title: "B", summary: "B") == .deny)
        c.denyAll()
        #expect(await first == .deny)
    }

    @Test func settingsPatchIsSanitised() async {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        _ = await PhoneCore.applySettings(f, ["groups": ["clipboard": true, "bogus": true], "policies": ["run": "allow", "nope": "allow", "status": "weird"],
                                              "port": 80, "confirmTimeoutSec": 1])
        let s = f.phoneSettings
        #expect(s.groups == ["clipboard": true])
        #expect(s.policies == ["run": "allow"])
        #expect(s.port == 7470 && s.confirmTimeoutSec == 60)
        #expect(!s.enabled && f.core.server == nil, "headless without GLIDE_PHONE_HOST never listens")
    }
}
