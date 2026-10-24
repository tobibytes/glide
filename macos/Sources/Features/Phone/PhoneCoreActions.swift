import AppKit
import Foundation
import GlideCore

// phone-core: the core actions (docs/PHONE.md "Actions", owner "core"). Each reuses an existing feature through
// `context.callFeature` / `executeItem` / SystemServices, so headless runs record effects instead of doing them.

@MainActor enum PhoneCoreActions {
    static let maxImageBytes = 25 * 1024 * 1024
    static let maxText = 1024 * 1024
    /// Items a phone may never run through `run` (pairing, MCP, Agent have their own gated paths).
    static let blockedPrefixes = ["phone:", "mcp-server:", "agent:"]
    static let noteTitle = "From iPhone"

    static func register(_ f: PhoneFeature) {
        let r = f.registry
        r.register(PhoneAction("hello", "Connect", group: "core") { [weak f] a, c in try await hello(f, a, c) })
        r.register(PhoneAction("status", "Mac status", group: "core") { [weak f] _, _ in try await status(f) })
        r.register(PhoneAction("search", "Search Glide", group: "core") { [weak f] a, _ in try await search(f, a) })
        r.register(PhoneAction("run", "Run a Glide command", group: "core", risk: .confirm) { [weak f] a, _ in try await run(f, a) })
        r.register(PhoneAction("timers.start", "Start a timer", group: "core") { [weak f] a, _ in try await timerStart(f, a) })
        r.register(PhoneAction("timers.stop", "Stop a timer", group: "core") { [weak f] a, _ in try await timerStop(f, a) })
        r.register(PhoneAction("workflows.list", "List workflows", group: "core") { [weak f] _, _ in try await workflowsList(f) })
        r.register(PhoneAction("workflows.run", "Run a workflow", group: "core", risk: .confirm) { [weak f] a, _ in try await workflowsRun(f, a) })
        r.register(PhoneAction("send", "Send to Mac", group: "core") { [weak f] a, _ in try await send(f, a) })
        r.register(PhoneAction("clipboard.get", "Read the Mac clipboard", group: "clipboard", sensitive: true) { [weak f] _, _ in try clipboardGet(f) })
        r.register(PhoneAction("clipboard.set", "Replace the Mac clipboard", group: "clipboard") { [weak f] a, _ in try clipboardSet(f, a) })
        r.register(PhoneAction("clipboard.history", "Read clipboard history", group: "clipboard", sensitive: true) { [weak f] a, _ in try await clipboardHistory(f, a) })
        r.register(PhoneAction("notes.append", "Add to a note", group: "core") { [weak f] a, _ in try await notesAppend(f, a) })
        r.register(PhoneAction("mac.lock", "Lock the Mac", group: "core") { [weak f] _, _ in try await runItem(f, "system:lockScreen", "Mac locked") })
        r.register(PhoneAction("mac.sleep", "Put the Mac to sleep", group: "core", risk: .confirm) { [weak f] _, _ in try await runItem(f, "system:sleep", "Mac going to sleep") })
        r.register(PhoneAction("media", "Media keys", group: "remote", relay: false) { [weak f] a, _ in try await media(f, a) })
    }

    static func ctx(_ f: PhoneFeature?) throws -> FeatureContext {
        guard let c = f?.context else { throw PhoneError("unavailable", "Glide is still starting. Try again in a moment.") }
        return c
    }

    static func str(_ a: JSONValue, _ k: String, max: Int = 4096) -> String? {
        guard let s = a[k]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return String(s.prefix(max))
    }

    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev" }
    static var macName: String { PhoneNetwork.computerName() }

    // MARK: hello / status / search / run

    static func hello(_ f: PhoneFeature?, _ a: JSONValue, _ c: PhoneCaller) async throws -> JSONValue {
        guard let f else { throw PhoneError("unavailable", "Glide is not ready") }
        var name = c.deviceName
        if c.transport == .lan, let reg = f.core.devices, let d = reg.device(c.deviceId) {
            if d.name == PhoneDeviceRegistry.defaultName, let n = PhoneDeviceRegistry.clean(a["name"]?.stringValue), n != d.name { reg.rename(d.id, n) }
            name = reg.device(c.deviceId)?.name ?? name
        }
        return ["mac": ["name": .string(macName), "version": .string(version)], "device": ["id": .string(c.deviceId), "name": .string(name)],
                "groups": .object(Dictionary(uniqueKeysWithValues: PhoneGroups.switchable.map { ($0.id, JSONValue.bool(f.isGroupEnabled($0.id))) })),
                "actions": .array(f.registry.all.filter { PhoneGate.policy($0, f.phoneSettings) != .off }.map { .string($0.name) })]
    }

    static func remaining(_ t: JSONValue, now: Double) -> Double { MCPLiveBackend.remaining(t, now: now) }

    static func status(_ f: PhoneFeature?) async throws -> JSONValue {
        let ctx = try ctx(f)
        let now = Date().timeIntervalSince1970 * 1000
        var timers: [JSONValue] = []
        if let st = try? await ctx.callFeature("timers", method: "state", args: .null) {
            let t = st["now"]?.doubleValue ?? now
            timers = (st["timers"]?.arrayValue ?? []).map { tm in
                ["id": tm["id"] ?? .null, "name": .string(tm["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Timer"),
                 "durationMs": tm["durationMs"] ?? .null, "remainingMs": .int(Int64(remaining(tm, now: t))), "paused": .bool(!(tm["pausedAt"]?.isNull ?? true))]
            }
        }
        var focus: JSONValue = .null
        if let fs = try? await ctx.callFeature("focus", method: "state", args: .null), let s = fs["session"], !s.isNull {
            focus = ["active": true, "goal": s["goal"] ?? .null, "remainingMs": .int(Int64(fs["remainingMs"]?.doubleValue ?? 0))]
        }
        let battery: JSONValue = Sysmon.battery().map { ["percent": .int(Int64($0.percent)), "charging": .bool($0.charging)] } ?? .null
        return ["mac": ["name": .string(macName), "version": .string(version)], "timers": .array(timers), "focus": focus, "battery": battery]
    }

    static func search(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        let q = str(a, "query", max: 200) ?? ""
        let limit = max(1, min(50, a["limit"]?.intValue ?? 20))
        let items = await ctx.search(q).lazy.filter { s in !blockedPrefixes.contains { s.item.id.hasPrefix($0) } }.prefix(limit)
        return ["items": .array(items.map { s in
            ["id": .string(s.item.id), "title": .string(s.item.title), "subtitle": s.item.subtitle.map(JSONValue.string) ?? .null,
             "kind": .string(s.item.displayKind), "acceptsArgument": .bool(s.item.acceptsArgument == true)]
        })]
    }

    static func describe(_ r: ActionResult, ok okMessage: String) throws -> JSONValue {
        switch r {
        case let .error(m): throw PhoneError("failed", m)
        case let .hide(m), let .stay(m): return ["ok": true, "message": .string(m ?? okMessage)]
        case .pushView: return ["ok": true, "message": "Opened on the Mac"]
        case .openSettings: return ["ok": true, "message": "Opened Glide Settings on the Mac"]
        }
    }

    static func run(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        guard let id = str(a, "id", max: 500) else { throw PhoneError.badArgs("Give the id of a search result.") }
        guard !blockedPrefixes.contains(where: { id.hasPrefix($0) }) else { throw PhoneError("denied", "This command can only be run on the Mac.") }
        guard ctx.findItem(id: id) != nil else { throw PhoneError("not-found", "That command is no longer in Glide. Search again.") }
        return try describe(await ctx.executeItem(id: id, argument: str(a, "argument", max: 2000)), ok: "Done")
    }

    static func runItem(_ f: PhoneFeature?, _ id: String, _ done: String) async throws -> JSONValue {
        let ctx = try ctx(f)
        return try describe(await ctx.executeItem(id: id, argument: nil), ok: done)
    }

    // MARK: timers / workflows

    static func timerStart(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        let ms = ((a["minutes"]?.doubleValue ?? 0) * 60 + (a["seconds"]?.doubleValue ?? 0)) * 1000
        guard ms >= 1000, ms <= 24 * 3600 * 1000 else { throw PhoneError.badArgs("Give minutes or seconds (up to 24 hours).") }
        let before = Set(((try? await ctx.callFeature("timers", method: "state", args: .null))?["timers"]?.arrayValue ?? []).compactMap { $0["id"]?.stringValue })
        let r = try await ctx.callFeature("timers", method: "start", args: ["ms": .double(ms), "name": .string(str(a, "name", max: 100) ?? "")])
        if r["ok"]?.boolValue == false { throw PhoneError("failed", r["error"]?.stringValue ?? "Could not start the timer") }
        let after = (try? await ctx.callFeature("timers", method: "state", args: .null))?["timers"]?.arrayValue ?? []
        let id = after.compactMap { $0["id"]?.stringValue }.first { !before.contains($0) }
        return ["ok": true, "id": id.map(JSONValue.string) ?? .null, "message": r["message"] ?? "Timer started"]
    }

    static func timerStop(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        guard let id = str(a, "id", max: 200) else { throw PhoneError.badArgs("Give the timer id.") }
        let list = (try await ctx.callFeature("timers", method: "state", args: .null))["timers"]?.arrayValue ?? []
        guard list.contains(where: { $0["id"]?.stringValue == id }) else { throw PhoneError("not-found", "That timer is not running any more.") }
        let r = try await ctx.callFeature("timers", method: "stop", args: ["id": .string(id)])
        if r["ok"]?.boolValue == false { throw PhoneError("failed", r["error"]?.stringValue ?? "Could not stop the timer") }
        return ["ok": true]
    }

    static func workflows(_ ctx: FeatureContext) async throws -> [JSONValue] {
        (try await ctx.callFeature("workflows", method: "list", args: .null)).arrayValue ?? []
    }

    static func workflowsList(_ f: PhoneFeature?) async throws -> JSONValue {
        let ctx = try ctx(f)
        return ["workflows": .array(try await workflows(ctx).map { ["id": $0["id"] ?? .null, "name": $0["name"] ?? .null] })]
    }

    static func workflowsRun(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        let all = try await workflows(ctx)
        let wf: JSONValue?
        if let id = str(a, "id", max: 200) { wf = all.first { $0["id"]?.stringValue == id } } else if let name = str(a, "name", max: 200)?.lowercased() {
            wf = all.first { $0["name"]?.stringValue?.lowercased() == name }
        } else { throw PhoneError.badArgs("Give the workflow id or name.") }
        guard let wf, let id = wf["id"]?.stringValue else { throw PhoneError("not-found", "No workflow with that name. Check the list in Glide.") }
        let r = try await ctx.callFeature("workflows", method: "run", args: ["id": .string(id), "input": .string(str(a, "input", max: maxText) ?? ""), "source": "phone"])
        if r["ok"]?.boolValue == false {
            let err = (r["log"]?.arrayValue ?? []).first { $0["status"]?.stringValue == "error" }?["error"]?.stringValue
            throw PhoneError("failed", err ?? "The workflow did not finish.")
        }
        return ["result": .string(String((r["result"]?.stringValue ?? "").prefix(maxText)))]
    }

    // MARK: send / clipboard / notes

    static func send(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        let to = a["to"]?.stringValue ?? "clipboard"
        let text = a["text"]?.stringValue.map { String($0.prefix(maxText)) }
        let url = str(a, "url", max: 8192)
        if let b64 = a["image"]?.stringValue {
            guard to == "clipboard" else { throw PhoneError.badArgs("Photos can go to the clipboard only.") }
            guard b64.utf8.count <= maxImageBytes * 4 / 3 + 4, let raw = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) ?? PhoneCrypto.fromBase64url(b64),
                  raw.count <= maxImageBytes else { throw PhoneError.badArgs("The photo is too big or damaged. Photos up to 25 MB work.") }
            guard let png = pngData(raw) else { throw PhoneError.badArgs("That file is not a photo Glide can read.") }
            ctx.services.pasteboard.setImagePNG(png, transient: false)
            return ["ok": true, "message": "Photo copied on the Mac"]
        }
        guard let body = (text?.isEmpty == false ? text : nil) ?? url else { throw PhoneError.badArgs("Send some text, a link or a photo.") }
        switch to {
        case "clipboard":
            ctx.services.pasteboard.setString(body, html: nil, transient: false)
            return ["ok": true, "message": "Copied on the Mac"]
        case "note":
            try await appendToNote(ctx, url.map { u in text.map { "\($0)\n\(u)" } ?? u } ?? body)
            return ["ok": true, "message": .string("Added to the note \(noteTitle)")]
        case "open":
            let candidate = (url ?? body).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let u = URL(string: candidate), let scheme = u.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme), u.host != nil || scheme == "mailto" else {
                throw PhoneError.badArgs("Only web links can be opened. Send it to the clipboard instead.")
            }
            let r = ctx.services.workspace.open(url: u)
            guard r.ok else { throw PhoneError("failed", r.error ?? "The Mac could not open the link.") }
            return ["ok": true, "message": "Opened on the Mac"]
        default:
            throw PhoneError.badArgs("Choose clipboard, note or open.")
        }
    }

    /// Any image NSImage can read (JPEG, HEIC, PNG…) → PNG.
    static func pngData(_ raw: Data) -> Data? {
        if raw.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return NSBitmapImageRep(data: raw) != nil ? raw : nil }
        guard let rep = NSBitmapImageRep(data: raw) ?? NSImage(data: raw)?.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    static func clipboardGet(_ f: PhoneFeature?) throws -> JSONValue {
        let ctx = try ctx(f)
        let t = ctx.services.pasteboard.string() ?? ""
        return ["text": .string(String(t.prefix(maxText)))]
    }

    static func clipboardSet(_ f: PhoneFeature?, _ a: JSONValue) throws -> JSONValue {
        let ctx = try ctx(f)
        guard let t = a["text"]?.stringValue, !t.isEmpty else { throw PhoneError.badArgs("Give the text to copy.") }
        ctx.services.pasteboard.setString(String(t.prefix(maxText)), html: nil, transient: false)
        return ["ok": true]
    }

    static func clipboardHistory(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        let limit = max(1, min(100, a["limit"]?.intValue ?? 20))
        let list = (try await ctx.callFeature("clipboard", method: "list", args: ["limit": .int(Int64(limit))])).arrayValue ?? []
        return ["items": .array(list.map { e in
            ["id": e["id"] ?? .null, "type": e["type"] ?? .null, "text": e["preview"] ?? .null, "title": e["title"] ?? .null,
             "at": e["lastCopiedAt"] ?? e["createdAt"] ?? .null, "pinned": e["pinned"] ?? false]
        })]
    }

    static func notesAppend(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        guard let t = a["text"]?.stringValue, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PhoneError.badArgs("Give the text to add.") }
        try await appendToNote(ctx, String(t.prefix(maxText)))
        return ["ok": true, "message": .string("Added to the note \(noteTitle)")]
    }

    /// Appends to the note whose first line is "# From iPhone" (created when missing).
    static func appendToNote(_ ctx: FeatureContext, _ text: String) async throws {
        let header = "# \(noteTitle)"
        let state = try await ctx.callFeature("notes", method: "state", args: .null)
        let summaries = state["notes"]?.arrayValue ?? []
        for s in summaries {
            guard let id = s["id"]?.stringValue else { continue }
            let n = try await ctx.callFeature("notes", method: "get", args: ["id": .string(id)])
            let body = n["body"]?.stringValue ?? ""
            if body.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init)?.trimmingCharacters(in: .whitespaces) == header {
                let ok = try await ctx.callFeature("notes", method: "save", args: ["id": .string(id), "body": .string(body.trimmingCharacters(in: .newlines) + "\n\n" + text)])
                if ok.boolValue == false { throw PhoneError("failed", "Could not save the note.") }
                return
            }
        }
        _ = try await ctx.callFeature("notes", method: "create", args: ["body": .string("\(header)\n\n\(text)")])
    }

    // MARK: media keys

    static let mediaKeys: [String: Int32] = ["playpause": 16, "next": 17, "prev": 18] // NX_KEYTYPE_PLAY / NEXT / PREVIOUS
    static let volumeItems = ["volup": "system:volumeUp", "voldown": "system:volumeDown", "mute": "system:volumeMute"]

    static func media(_ f: PhoneFeature?, _ a: JSONValue) async throws -> JSONValue {
        let ctx = try ctx(f)
        let key = a["key"]?.stringValue ?? ""
        if let item = volumeItems[key] { return try await runItem(f, item, "Done") }
        guard let code = mediaKeys[key] else { throw PhoneError.badArgs("Unknown media key. Use playpause, next, prev, volup, voldown or mute.") }
        if ctx.services.isHeadless {
            ctx.recordEffect(kind: "phone.media", detail: .string(key))
            return ["ok": true]
        }
        postMediaKey(code)
        return ["ok": true]
    }

    /// A system-defined "aux control button" event (what the keyboard's media keys send).
    static func postMediaKey(_ code: Int32) {
        for down in [true, false] {
            let flags = NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00)
            let data1 = Int((code << 16) | ((down ? 0xA : 0xB) << 8))
            let ev = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil,
                                        subtype: 8, data1: data1, data2: -1)
            ev?.cgEvent?.post(tap: .cghidEventTap)
        }
    }
}
