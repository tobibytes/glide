import Foundation
import Testing
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem

/// The relay against the REAL gate (`PhoneFeature.perform`), with test actions registered on the feature's registry.
@Suite("phone relay service", .serialized)
@MainActor struct PhoneRelayServiceTests {
    final class Counter { var runs: [String: Int] = [:] }

    func makeEnv(groups: [String: JSONValue] = [:]) async throws -> (RelayEnv, Counter) {
        let env = try await RelayEnv(phoneSettings: groups.isEmpty ? [:] : ["groups": .object(groups)])
        let counter = Counter()
        env.feature.registry.register(PhoneAction("test.echo", "Echo", group: "core") { a, caller in
            counter.runs["test.echo", default: 0] += 1
            return ["text": a["text"] ?? .null, "transport": .string(caller.transport.rawValue), "device": .string(caller.deviceId)]
        })
        env.feature.registry.register(PhoneAction("test.live", "Trackpad", group: "core", relay: false) { _, _ in
            counter.runs["test.live", default: 0] += 1
            return true
        })
        env.feature.registry.register(PhoneAction("test.secret", "Read the secret", group: "clipboard", sensitive: true) { _, _ in
            counter.runs["test.secret", default: 0] += 1
            return ["text": "secret"]
        })
        return (env, counter)
    }

    func service(_ env: RelayEnv, root: URL) -> PhoneRelayService {
        PhoneRelayService(roots: [root], createRoots: true) { [weak feature = env.feature] action, args, caller in
            await feature?.perform(action, args: args, caller: caller) ?? .null
        }
    }

    @Test func validRequestRunsWithTheRelayCallerAndCleansUp() async throws {
        let (env, counter) = try await makeEnv()
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("valid")
        let s = service(env, root: root)
        try writeRequest(root, "a1.json", #"{"v":1,"id":"a1","action":"test.echo","args":{"text":"hello"},"from":"Shortcuts"}"#)
        await s.scanOnce()
        let r = try #require(readReply(root, "a1"))
        #expect(r["id"]?.stringValue == "a1")
        #expect(r["ok"]?.boolValue == true)
        #expect(r["result"]?["text"]?.stringValue == "hello")
        #expect(r["result"]?["transport"]?.stringValue == "relay")
        #expect(r["result"]?["device"]?.stringValue == "icloud")
        #expect(r["text"]?.stringValue == "hello")
        #expect(inboxNames(root).isEmpty)
        #expect(counter.runs["test.echo"] == 1)
        // The gate logged the call with the relay device.
        #expect(env.feature.core.log.entries.contains { $0.deviceId == "icloud" && $0.transport == "relay" && $0.action == "test.echo" })
        // No temp files left in the outbox.
        let out = try FileManager.default.contentsOfDirectory(atPath: PhoneRelayPaths.outbox(root).path)
        #expect(out == ["a1.json"])
    }

    @Test func gateDeniesLanOnlySensitiveAndUnknownActions() async throws {
        let (env, counter) = try await makeEnv()
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("gate")
        let s = service(env, root: root)
        try writeRequest(root, "l1.json", #"{"id":"l1","action":"test.live"}"#)
        try writeRequest(root, "s1.json", #"{"id":"s1","action":"test.secret"}"#)
        try writeRequest(root, "u1.json", #"{"id":"u1","action":"nope.nothing"}"#)
        await s.scanOnce()
        #expect(readReply(root, "l1")?["error"]?["code"]?.stringValue == "denied")
        #expect(readReply(root, "l1")?["text"]?.stringValue?.contains("same Wi-Fi") == true)
        #expect(readReply(root, "s1")?["error"]?["code"]?.stringValue == "denied")
        #expect(readReply(root, "u1")?["error"]?["code"]?.stringValue == "not-found")
        #expect(counter.runs.isEmpty)
        #expect(inboxNames(root).isEmpty)
    }

    @Test func groupSwitchOnLetsTheRelayIn() async throws {
        let (env, counter) = try await makeEnv(groups: ["clipboard": true])
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("group")
        let s = service(env, root: root)
        try writeRequest(root, "c1.json", #"{"id":"c1","action":"clipboard.set","args":{"text":"from the phone"}}"#)
        await s.scanOnce()
        #expect(readReply(root, "c1")?["ok"]?.boolValue == true)
        #expect(env.services.pasteboard.string() == "from the phone")
        _ = counter
    }

    @Test func duplicatesRunOnce() async throws {
        let (env, counter) = try await makeEnv()
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("dup")
        let s = service(env, root: root)
        try writeRequest(root, "d1.json", #"{"id":"d1","action":"test.echo","args":{"text":"one"}}"#)
        await s.scanOnce()
        // The phone already consumed the reply, then iCloud delivers the same request again (another file name).
        try FileManager.default.removeItem(at: PhoneRelayPaths.outbox(root).appendingPathComponent("d1.json"))
        try writeRequest(root, "d1 2.json", #"{"id":"d1","action":"test.echo","args":{"text":"two"}}"#)
        await s.scanOnce()
        #expect(counter.runs["test.echo"] == 1)
        #expect(readReply(root, "d1")?["result"]?["text"]?.stringValue == "one")
        #expect(inboxNames(root).isEmpty)
        #expect(s.hasAnswered("d1"))
    }

    @Test func placeholdersAreDownloadedNotRun() async throws {
        let (env, counter) = try await makeEnv()
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("placeholder")
        let s = service(env, root: root)
        var asked: [String] = []
        s.download = { asked.append($0.lastPathComponent) }
        try writeRequest(root, ".p1.json.icloud", "bplist00 placeholder")
        await s.scanOnce()
        await s.scanOnce() // asked once, not on every scan
        #expect(asked == ["p1.json"])
        #expect(counter.runs.isEmpty)
        #expect(inboxNames(root) == [".p1.json.icloud"])
        // iCloud finishes: the placeholder goes away and the real file appears.
        try FileManager.default.removeItem(at: PhoneRelayPaths.inbox(root).appendingPathComponent(".p1.json.icloud"))
        try writeRequest(root, "p1.json", #"{"id":"p1","action":"test.echo","args":{"text":"downloaded"}}"#)
        await s.scanOnce()
        #expect(readReply(root, "p1")?["result"]?["text"]?.stringValue == "downloaded")
    }

    @Test func partialWritesWaitThenBadJSONGetsAnError() async throws {
        let (env, counter) = try await makeEnv()
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("partial")
        let s = service(env, root: root)
        // Still being written: left alone.
        try writeRequest(root, "w1.json", #"{"id":"w1","action":"test.ec"#)
        await s.scanOnce()
        #expect(inboxNames(root) == ["w1.json"])
        #expect(readReply(root, "w1") == nil)
        // The rest arrives: it runs.
        try writeRequest(root, "w1.json", #"{"id":"w1","action":"test.echo","args":{"text":"whole"}}"#)
        await s.scanOnce()
        #expect(readReply(root, "w1")?["result"]?["text"]?.stringValue == "whole")
        // Broken for longer than the grace period: an error reply under the file name, and the file is removed.
        try writeRequest(root, "bad-1.json", "this is not json", modified: Date().addingTimeInterval(-60))
        await s.scanOnce()
        let r = try #require(readReply(root, "bad-1"))
        #expect(r["ok"]?.boolValue == false)
        #expect(r["error"]?["code"]?.stringValue == "bad-request")
        #expect(inboxNames(root).isEmpty)
        #expect(counter.runs["test.echo"] == 1)
    }

    @Test func tooLargeAndExpiredRequestsAreRefused() async throws {
        let (env, counter) = try await makeEnv()
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("limits")
        let s = service(env, root: root)
        let inbox = PhoneRelayPaths.inbox(root)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        let big = inbox.appendingPathComponent("big.json")
        FileManager.default.createFile(atPath: big.path, contents: nil)
        let h = try FileHandle(forWritingTo: big)
        try h.truncate(atOffset: UInt64(PhoneRelayLimits.maxRequestBytes + 1))
        try h.close()
        try writeRequest(root, "old.json", #"{"id":"old","action":"test.echo"}"#, modified: Date().addingTimeInterval(-2 * 3600))
        await s.scanOnce()
        #expect(readReply(root, "big")?["error"]?["code"]?.stringValue == "too-large")
        #expect(readReply(root, "old")?["error"]?["code"]?.stringValue == "expired")
        #expect(counter.runs.isEmpty)
        #expect(inboxNames(root).isEmpty)
    }

    @Test func outboxIsPrunedAfterTenMinutes() async throws {
        let (env, _) = try await makeEnv()
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("prune")
        let s = service(env, root: root)
        let out = PhoneRelayPaths.outbox(root)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        for (name, age) in [("old.json", 11.0 * 60), ("new.json", 60.0), (".x.json.ab12.tmp", 120.0)] {
            let u = out.appendingPathComponent(name)
            try Data("{}".utf8).write(to: u)
            try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-age)], ofItemAtPath: u.path)
        }
        s.prune()
        #expect(try FileManager.default.contentsOfDirectory(atPath: out.path).sorted() == ["new.json"])
    }

    @Test func watcherPicksUpNewFilesWithoutAScanCall() async throws {
        let (env, counter) = try await makeEnv()
        defer { Task { await env.stop() } }
        let root = RelayScratch.fresh("watch")
        let s = service(env, root: root)
        s.pollInterval = .seconds(60) // only the vnode source can wake it in time
        s.start()
        defer { s.stop() }
        try await Task.sleep(for: .milliseconds(100))
        try writeRequest(root, "e1.json", #"{"id":"e1","action":"test.echo","args":{"text":"event"}}"#)
        var reply: JSONValue?
        for _ in 0..<60 {
            try await Task.sleep(for: .milliseconds(50))
            if let r = readReply(root, "e1") { reply = r; break }
        }
        #expect(reply?["result"]?["text"]?.stringValue == "event")
        #expect(counter.runs["test.echo"] == 1)
    }

    @Test func settingsToggleStartsAndStopsTheRelay() async throws {
        let (env, _) = try await makeEnv()
        defer { Task { await env.stop() } }
        let off = try await env.feature.invoke(method: "relay.status", args: .null)
        #expect(off["running"]?.boolValue == false)
        // Never the real iCloud Drive in tests.
        let roots = (off["roots"]?.arrayValue ?? []).compactMap(\.stringValue)
        #expect(roots.count == 1)
        #expect(roots.allSatisfy { !$0.contains("Mobile Documents") }, "\(roots)")
        let on = try await env.feature.invoke(method: "relay.set", args: ["relay": true])
        #expect(on["relay"]?.boolValue == true)
        #expect(try await env.feature.invoke(method: "relay.status", args: .null)["running"]?.boolValue == true)
        _ = try await env.feature.invoke(method: "relay.set", args: ["relay": false])
        #expect(try await env.feature.invoke(method: "relay.status", args: .null)["running"]?.boolValue == false)
    }
}
