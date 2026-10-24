import AppKit
import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

@MainActor @Suite("Phone core actions (headless)")
struct PhoneCoreActionsTests {
    func run(_ f: PhoneFeature, _ action: String, _ args: JSONValue = [:], caller: PhoneCaller = lanCaller) async -> JSONValue {
        await f.perform(action, args: args, caller: caller)
    }

    @Test func registeredWithContractShapes() async {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        let expected: [(String, String, PhoneRisk, Bool)] = [
            ("hello", "core", .safe, true), ("status", "core", .safe, true), ("search", "core", .safe, true), ("run", "core", .confirm, true),
            ("timers.start", "core", .safe, true), ("timers.stop", "core", .safe, true), ("workflows.list", "core", .safe, true),
            ("workflows.run", "core", .confirm, true), ("send", "core", .safe, true), ("clipboard.get", "clipboard", .safe, true),
            ("clipboard.set", "clipboard", .safe, true), ("clipboard.history", "clipboard", .safe, true), ("notes.append", "core", .safe, true),
            ("mac.lock", "core", .safe, true), ("mac.sleep", "core", .confirm, true), ("media", "remote", .safe, false),
        ]
        for (name, group, risk, relay) in expected {
            let a = f.registry.action(name)
            #expect(a?.group == group && a?.risk == risk && a?.relay == relay, "\(name)")
        }
    }

    @Test func statusSearchRunAndTimers() async throws {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        var timers: [JSONValue] = [["id": "t0", "name": "Tea", "durationMs": 60000, "startedAt": 0, "pausedAt": .null, "pausedMs": 0]]
        ctx.featureHandler = { feat, method, args in
            switch (feat, method) {
            case ("timers", "state"): return ["now": 30000, "timers": .array(timers)]
            case ("timers", "start"):
                timers.append(["id": "t1", "name": args["name"] ?? "", "durationMs": args["ms"] ?? 0, "startedAt": 30000, "pausedAt": .null, "pausedMs": 0])
                return ["ok": true, "message": "Timer started"]
            case ("timers", "stop"):
                timers.removeAll { $0["id"] == args["id"] }
                return ["ok": true]
            case ("focus", "state"): return ["session": ["goal": "Write"], "remainingMs": 1200]
            default: return .null
            }
        }
        let st = await run(f, "status")
        #expect(st["ok"] == true)
        #expect(st["result"]?["timers"]?.arrayValue?.first?["remainingMs"] == 30000)
        #expect(st["result"]?["focus"]?["goal"] == "Write")
        #expect(st["result"]?["mac"]?["name"]?.stringValue?.isEmpty == false)

        let started = await run(f, "timers.start", ["minutes": 5, "name": "Pasta"])
        #expect(started["result"]?["id"] == "t1")
        #expect(ctx.calls.contains { $0.method == "start" && $0.args["ms"]?.doubleValue == 300_000 })
        #expect(await run(f, "timers.start", ["minutes": 0])["error"]?["code"] == "bad-args")
        #expect(await run(f, "timers.stop", ["id": "t1"])["ok"] == true)
        #expect(await run(f, "timers.stop", ["id": "t1"])["error"]?["code"] == "not-found")

        ctx.items = [SearchItem(id: "app:safari", kind: .app, title: "Safari", feature: "applications"),
                     SearchItem(id: "phone:pair", kind: .command, title: "Pair iPhone Safari", feature: "phone"),
                     SearchItem(id: "agent:ask", kind: .command, title: "Ask Safari Agent", feature: "agent")]
        let found = await run(f, "search", ["query": "safari"])
        #expect(found["result"]?["items"]?.arrayValue?.map { $0["id"] } == ["app:safari"])

        // `run` asks first (confirm risk): answer from the Mac.
        async let ran = run(f, "run", ["id": "app:safari"])
        #expect(await waitUntil { f.confirmations.pending.count == 1 })
        #expect(f.confirmations.pending.first?.summary == "Run app:safari")
        f.confirmations.respond(f.confirmations.pending[0].id, decision: "allow")
        #expect(await ran["result"]?["ok"] == true)
        #expect(ctx.executed.map(\.id) == ["app:safari"])

        // Never pairing / agent / MCP items, and never unknown ids.
        _ = await PhoneCore.applySettings(f, ["policies": ["run": "allow"]])
        #expect(await run(f, "run", ["id": "phone:pair"])["error"]?["code"] == "denied")
        #expect(await run(f, "run", ["id": "app:gone"])["error"]?["code"] == "not-found")
        #expect(ctx.executed.count == 1)
    }

    @Test func workflows() async {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        ctx.featureHandler = { feat, method, args in
            switch (feat, method) {
            case ("workflows", "list"): return [["id": "w1", "name": "Morning", "actions": 3]]
            case ("workflows", "run"): return ["workflowId": args["id"] ?? .null, "ok": true, "log": [], "variables": [:], "result": .string("done: \(args["input"]?.stringValue ?? "")")]
            default: return .null
            }
        }
        #expect(await run(f, "workflows.list")["result"] == ["workflows": [["id": "w1", "name": "Morning"]]])
        _ = await PhoneCore.applySettings(f, ["policies": ["workflows.run": "allow"]])
        let r = await run(f, "workflows.run", ["name": "morning", "input": "hi"], caller: relayCaller)
        #expect(r["result"]?["result"] == "done: hi")
        #expect(ctx.calls.contains { $0.method == "run" && $0.args["source"] == "phone" })
        #expect(await run(f, "workflows.run", ["name": "Evening"])["error"]?["code"] == "not-found")
    }

    @Test func sendRecordsEffectsInsteadOfDoingThem() async throws {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        var notes: [String: String] = [:]
        ctx.featureHandler = { feat, method, args in
            guard feat == "notes" else { return .null }
            switch method {
            case "state": return ["notes": .array(notes.keys.sorted().map { ["id": .string($0)] })]
            case "get": return ["id": args["id"] ?? .null, "body": .string(notes[args["id"]?.stringValue ?? ""] ?? "")]
            case "save":
                notes[args["id"]?.stringValue ?? ""] = args["body"]?.stringValue
                return true
            case "create":
                notes["n\(notes.count + 1)"] = args["body"]?.stringValue
                return ["id": "n1"]
            default: return .null
            }
        }
        #expect(await run(f, "send", ["text": "hello mac", "to": "clipboard"])["ok"] == true)
        #expect(ctx.services.pasteboard.string() == "hello mac")
        #expect(ctx.sideEffects("pasteboard-set").count == 1)

        #expect(await run(f, "send", ["url": "https://example.com/a", "to": "open"])["ok"] == true)
        #expect(ctx.log.all.contains { $0.detail.description.contains("https://example.com/a") })
        #expect(await run(f, "send", ["url": "file:///etc/passwd", "to": "open"])["error"]?["code"] == "bad-args")
        #expect(await run(f, "send", ["text": "javascript:alert(1)", "to": "open"])["error"]?["code"] == "bad-args")

        #expect(await run(f, "send", ["text": "first", "to": "note"])["ok"] == true)
        #expect(await run(f, "notes.append", ["text": "second"])["ok"] == true)
        #expect(notes.count == 1 && notes.values.first == "# From iPhone\n\nfirst\n\nsecond")

        // A photo (JPEG) becomes PNG on the clipboard.
        let rep = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4, bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false,
                                                isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let jpeg = try #require(rep.representation(using: .jpeg, properties: [:]))
        #expect(await run(f, "send", ["image": .string(jpeg.base64EncodedString()), "to": "clipboard"])["ok"] == true)
        #expect(ctx.services.pasteboard.imagePNG()?.starts(with: [0x89, 0x50, 0x4E, 0x47]) == true)
        #expect(await run(f, "send", ["image": "bm90IGFuIGltYWdl", "to": "clipboard"])["error"]?["code"] == "bad-args")
        #expect(await run(f, "send", ["image": .string(jpeg.base64EncodedString()), "to": "note"])["error"]?["code"] == "bad-args")
        #expect(await run(f, "send", ["to": "clipboard"])["error"]?["code"] == "bad-args")
    }

    @Test func clipboardGroupAndMedia() async {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        ctx.services.pasteboard.setString("secret", html: nil, transient: false)
        ctx.featureHandler = { feat, method, _ in
            feat == "clipboard" && method == "list" ? [["id": "c1", "type": "text", "preview": "secret", "title": "secret", "lastCopiedAt": 5]] : .null
        }
        #expect(await run(f, "clipboard.get")["error"]?["code"] == "denied")
        #expect(await run(f, "media", ["key": "playpause"])["error"]?["code"] == "denied")
        _ = await PhoneCore.applySettings(f, ["groups": ["clipboard": true, "remote": true]])
        #expect(await run(f, "clipboard.get")["result"] == ["text": "secret"])
        #expect(await run(f, "clipboard.set", ["text": "new"])["ok"] == true)
        #expect(ctx.services.pasteboard.string() == "new")
        #expect(await run(f, "clipboard.history", ["limit": 5])["result"]?["items"]?.arrayValue?.first?["text"] == "secret")
        #expect(await run(f, "media", ["key": "playpause"])["ok"] == true)
        #expect(ctx.effects.map(\.kind) == ["phone.media"])
        #expect(await run(f, "media", ["key": "volup"])["ok"] == true)
        #expect(ctx.executed.map(\.id) == ["system:volumeUp"])
        #expect(await run(f, "media", ["key": "playpause"], caller: relayCaller)["error"]?["code"] == "denied")
        #expect(await run(f, "media", ["key": "eject"])["error"]?["code"] == "bad-args")
        // The log never keeps clipboard text.
        let logged = f.core.log.list.map { "\($0)" }.joined()
        #expect(!logged.contains("secret") && !logged.contains("new\""))
    }

    @Test func macLockAndSleep() async {
        let (f, ctx) = await makePhone()
        defer { ctx.cleanup() }
        #expect(await run(f, "mac.lock")["ok"] == true)
        #expect(ctx.executed.map(\.id) == ["system:lockScreen"])
        f.confirmations.timeout = { .milliseconds(50) }
        #expect(await run(f, "mac.sleep")["error"]?["code"] == "timeout")
        #expect(ctx.executed.count == 1)
    }
}
