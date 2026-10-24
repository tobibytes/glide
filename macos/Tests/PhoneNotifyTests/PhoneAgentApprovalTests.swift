import Foundation
import GlideCore
import GlideTestHarness
import Testing
@testable import GlideFeatures

/// agent.ask / approvals.* through `PhoneFeature.perform`, with the real Glide Agent loop talking to a loopback
/// fake Anthropic server (never the real API or a real key), and notifications going to a fake ntfy server.
@MainActor @Suite("phone-notify agent and approvals", .serialized)
struct PhoneAgentApprovalTests {
    static let lan = PhoneCaller(deviceId: "dev1", deviceName: "Test iPhone", transport: .lan)
    static let relay = PhoneCaller(deviceId: "icloud", deviceName: "Shortcuts", transport: .relay)

    struct Rig {
        let host: NotifyTestHost
        let phone: PhoneFeature
        let agent: AgentFeature
        let model: FakeAnthropicServer
        let ntfy: FakeNtfy
        func stop() async {
            await host.stopAll()
            model.stop()
            ntfy.stop()
        }
    }

    /// The model asks to open a URL first, then answers in text once it sees the tool result.
    func rig(phoneBag: [String: JSONValue] = [:]) async throws -> Rig {
        // No setenv here: child processes of other suites would inherit it. Phone access stays off (no listener).
        let model = try FakeAnthropicServer { req in
            let messages = (req.json?["messages"] as? [[String: Any]]) ?? []
            let sawResult = messages.contains { m in ((m["content"] as? [[String: Any]]) ?? []).contains { $0["type"] as? String == "tool_result" } }
            if sawResult {
                let declined = String(decoding: req.body, as: UTF8.self).contains("declined")
                return .sse(text: declined ? "Okay, I left it closed." : "Opened example.com for you.", pieces: 2, delay: 0)
            }
            return sseToolUse(id: "toolu_1", name: "open_url", input: ["url": "https://example.com/phone"], text: "Opening it.")
        }
        let ntfy = try FakeNtfy()
        let host = NotifyTestHost("phone-agent")
        var bag: [String: JSONValue] = ["groups": ["agent": true], "policies": ["agent.ask": "allow"],
                                        "notify": ["enabled": true, "server": .string(ntfy.baseURL), "topic": "glide-agenttest"]]
        for (k, v) in phoneBag { bag[k] = v }
        host.store.setFeatureSettings("phone", bag)
        let agent = AgentFeature()
        let base = URL(string: model.baseURL)
        agent.clientOverride = { AgentAnthropicClient(client: AnthropicClient(apiKey: "sk-ant-test-FAKE", baseURL: base, maxRetries: 0, timeout: 10)) }
        await host.add(agent)
        let phone = PhoneFeature()
        await host.add(phone)
        if let hub = PhoneNotify.hub(for: phone) {
            hub.agent.pollInterval = .milliseconds(20)
            hub.notifier.backoffBase = 0.01
        }
        return Rig(host: host, phone: phone, agent: agent, model: model, ntfy: ntfy)
    }

    @Test func askStopsAtConfirmationThenApprovalRunsIt() async throws {
        let r = try await rig()
        defer { Task { await r.stop() } }
        let out = await r.phone.perform("agent.ask", args: ["prompt": "open example.com"], caller: Self.lan)
        #expect(out["ok"]?.boolValue == true, "\(out)")
        let res = out["result"] ?? .null
        #expect(res["status"]?.stringValue == "confirming")
        #expect(res["text"]?.stringValue == "Opening it.")
        let pending = try #require(res["pending"]?.arrayValue?.first)
        let id = try #require(pending["id"]?.stringValue)
        #expect(pending["source"]?.stringValue == "agent")
        #expect(pending["steps"]?.arrayValue?.first?.stringValue == "Open URL")
        // Nothing ran yet.
        #expect(!r.host.log.all.contains { $0.kind == "open-url" })

        // approvals.list shows it; the phone was notified (LAN server off in tests, so no link).
        let list = await r.phone.perform("approvals.list", args: [:], caller: Self.lan)
        #expect(list["result"]?["pending"]?.arrayValue?.contains { $0["id"]?.stringValue == id } == true)
        #expect(await notifyWait { r.ntfy.posts.contains { $0.headers["title"] == "Glide Agent needs your OK" } })
        let post = try #require(r.ntfy.posts.first { $0.headers["title"] == "Glide Agent needs your OK" })
        #expect(String(decoding: post.body, as: UTF8.self) == "Glide Agent wants to: Open URL.")
        #expect(!String(decoding: post.body, as: UTF8.self).contains("example.com"))

        // approvals.respond is LAN-only.
        let viaRelay = await r.phone.perform("approvals.respond", args: ["id": .string(id), "decision": "allow"], caller: Self.relay)
        #expect(viaRelay["ok"]?.boolValue == false && viaRelay["error"]?["code"]?.stringValue == "denied")

        let done = await r.phone.perform("approvals.respond", args: ["id": .string(id), "decision": "allow"], caller: Self.lan)
        #expect(done["ok"]?.boolValue == true, "\(done)")
        #expect(done["result"]?["status"]?.stringValue == "done")
        #expect(done["result"]?["text"]?.stringValue?.contains("Opened example.com for you.") == true)
        #expect(r.host.log.all.contains { $0.kind == "open-url" && "\($0.detail)".contains("example.com/phone") })
        // Answered: gone from the list, and can't be answered twice.
        let after = await r.phone.perform("approvals.list", args: [:], caller: Self.lan)
        #expect(after["result"]?["pending"]?.arrayValue?.isEmpty == true)
        let again = await r.phone.perform("approvals.respond", args: ["id": .string(id), "decision": "allow"], caller: Self.lan)
        #expect(again["error"]?["code"]?.stringValue == "not-found")
        // Phone runs never use the always-allow list, and "allow" from the phone never adds to it.
        #expect((try await r.agent.invoke(method: "getSettings", args: .null))["allow"]?.objectValue?.isEmpty == true)
    }

    @Test func denySkipsTheStepAndAlwaysAllowListIsIgnored() async throws {
        let r = try await rig()
        defer { Task { await r.stop() } }
        _ = r.agent.setSettings(["allow": ["open_url": true]]) // allowed on the Mac; the phone still asks
        let out = await r.phone.perform("agent.ask", args: ["prompt": "open example.com"], caller: Self.lan)
        let id = try #require(out["result"]?["pending"]?.arrayValue?.first?["id"]?.stringValue)
        let denied = await r.phone.perform("approvals.respond", args: ["id": .string(id), "decision": "deny"], caller: Self.lan)
        #expect(denied["result"]?["status"]?.stringValue == "done")
        #expect(denied["result"]?["decision"]?.stringValue == "deny")
        #expect(denied["result"]?["text"]?.stringValue?.contains("left it closed") == true)
        #expect(!r.host.log.all.contains { $0.kind == "open-url" })
    }

    @Test func agentGroupOffAndBadArgs() async throws {
        let r = try await rig(phoneBag: ["groups": ["agent": false]])
        defer { Task { await r.stop() } }
        let off = await r.phone.perform("agent.ask", args: ["prompt": "hi"], caller: Self.lan)
        #expect(off["error"]?["code"]?.stringValue == "denied")
        #expect(r.model.requests.isEmpty)
        let r2 = try await rig()
        defer { Task { await r2.stop() } }
        let empty = await r2.phone.perform("agent.ask", args: ["prompt": "  "], caller: Self.lan)
        #expect(empty["error"]?["code"]?.stringValue == "bad-args")
        let bad = await r2.phone.perform("approvals.respond", args: ["id": "x", "decision": "maybe"], caller: Self.lan)
        #expect(bad["error"]?["code"]?.stringValue == "bad-args")
        let unknown = await r2.phone.perform("approvals.respond", args: ["id": "nope", "decision": "deny"], caller: Self.lan)
        #expect(unknown["error"]?["code"]?.stringValue == "not-found")
    }

    @Test func phoneConfirmationsAreListedNotifiedAndAnswerable() async throws {
        // agent.ask on "Ask" (the default): the gate's own confirmation, answered from the phone.
        let r = try await rig(phoneBag: ["policies": [:]])
        defer { Task { await r.stop() } }
        let ask = Task { @MainActor in await r.phone.perform("agent.ask", args: ["prompt": "open example.com"], caller: Self.lan) }
        #expect(await notifyWait { !r.phone.confirmations.pending.isEmpty })
        let req = try #require(r.phone.confirmations.pending.first)
        let list = await r.phone.perform("approvals.list", args: [:], caller: Self.lan)
        let first = list["result"]?["pending"]?.arrayValue?.first
        #expect(first?["id"]?.stringValue == req.id && first?["source"]?.stringValue == "phone")
        #expect(await notifyWait { r.ntfy.posts.contains { $0.headers["title"] == "Glide needs your OK" } })
        let post = try #require(r.ntfy.posts.first { $0.headers["title"] == "Glide needs your OK" })
        // The prompt never goes into the notification.
        #expect(String(decoding: post.body, as: UTF8.self) == "Test iPhone wants to: Ask Glide Agent.")
        let ok = await r.phone.perform("approvals.respond", args: ["id": .string(req.id), "decision": "allow"], caller: Self.lan)
        #expect(ok["result"]?["ok"]?.boolValue == true)
        let out = await ask.value
        #expect(out["result"]?["status"]?.stringValue == "confirming")
        // Newest first: the agent's own confirmation is now listed.
        let list2 = await r.phone.perform("approvals.list", args: [:], caller: Self.lan)
        #expect(list2["result"]?["pending"]?.arrayValue?.first?["source"]?.stringValue == "agent")
    }

    @Test func macRunConfirmationsAreOfferedWhileTheAgentGroupIsOn() async throws {
        let r = try await rig()
        defer { Task { await r.stop() } }
        let started = try await r.agent.invoke(method: "start", args: ["prompt": "open example.com"])
        let runId = try #require(started["runId"]?.stringValue)
        let hub = try #require(PhoneNotify.hub(for: r.phone))
        #expect(await notifyWait { !hub.agent.pending.isEmpty })
        let item = try #require(hub.agent.pending.first)
        #expect(item.runId == runId && item.deviceName == "Mac" && !item.fromPhone)
        // Answered on the Mac: the phone's copy goes away.
        #expect(r.agent.respond(runId: runId, confirmationId: nil, approve: false))
        #expect(await notifyWait { hub.agent.pending.isEmpty })
    }

    @Test func notifyTestAction() async throws {
        let r = try await rig()
        defer { Task { await r.stop() } }
        let out = await r.phone.perform("notify.test", args: [:], caller: Self.relay)
        #expect(out["ok"]?.boolValue == true, "\(out)")
        #expect(r.ntfy.posts.last?.headers["title"] == "Test from Glide")
        let hub = try #require(PhoneNotify.hub(for: r.phone))
        _ = try await hub.invoke("setSettings", args: ["enabled": false])
        let off = await r.phone.perform("notify.test", args: [:], caller: Self.lan)
        #expect(off["error"]?["code"]?.stringValue == "off")
    }
}
