import Foundation
import GlideCore
import GlideUI
import SwiftUI

/// Wires the gate, devices, LAN server, core actions, Settings → iPhone and
/// the `phone.confirm` launcher view into `PhoneFeature`.
@MainActor enum PhoneCore {
    nonisolated static let confirmView = ViewID(rawValue: "phone.confirm")

    static func install(_ feature: PhoneFeature) async {
        guard let ctx = feature.context else { return }
        let dir = ctx.dataDirectory()
        let core = feature.core
        core.log = PhoneRequestLog(file: dir.appendingPathComponent("requests.json"))
        core.log.onChange = { [weak core] in core?.bump() }
        let keys: any PhoneKeyStore = ctx.services.isHeadless ? PhoneFileKeyStore(file: dir.appendingPathComponent("headless-keys.json")) : PhoneKeychainStore()
        let reg = PhoneDeviceRegistry(keys: keys, file: dir.appendingPathComponent("devices.json"))
        reg.onChange = { [weak core] in core?.bump() }
        core.devices = reg
        feature.confirmations.timeout = { [weak feature] in .seconds(feature?.phoneSettings.confirmTimeoutSec ?? 60) }
        feature.confirmations.addChangeObserver { [weak feature] in feature?.core.bump() }
        feature.confirmations.addObserver { [weak feature] r in
            guard let ctx = feature?.context else { return }
            ctx.log("confirmation requested: \(r.deviceName) → \(r.action)")
            if LauncherHosts.current?.isOnStack(confirmView) != true { ctx.push(confirmView, payload: ["requestId": .string(r.id)]) }
            ctx.services.notifications.notify(title: "\(r.deviceName) asks to \(r.title.lowercased())", body: r.summary)
        }
        PhoneCoreActions.register(feature)
        feature.onStop { [weak feature] in
            guard let feature else { return }
            feature.confirmations.denyAll()
            await stopServer(feature)
            feature.core.devices?.flush()
            feature.core.log.flush()
        }
    }

    /// After every module's hook ran: start the LAN server if it is on.
    static func didInstallHooks(_ feature: PhoneFeature) {
        Task { @MainActor [weak feature] in
            guard let feature, feature.phoneSettings.enabled else { return }
            await startServer(feature)
        }
    }

    // MARK: LAN server lifecycle

    static var env: [String: String] { ProcessInfo.processInfo.environment }

    /// Headless runs never listen unless a test pins GLIDE_PHONE_HOST (to 127.0.0.1).
    static func serverAllowed(_ ctx: FeatureContext) -> Bool { !ctx.services.isHeadless || (env["GLIDE_PHONE_HOST"].map { !$0.isEmpty } ?? false) }

    static func startServer(_ feature: PhoneFeature) async {
        let core = feature.core
        if core.server != nil { return }
        if let s = core.starting { return await s.value }
        guard let ctx = feature.context, serverAllowed(ctx) else { return }
        let t = Task { @MainActor [weak feature] in
            guard let feature else { return }
            let host = env["GLIDE_PHONE_HOST"].flatMap { $0.isEmpty ? nil : $0 }
            let port = env["GLIDE_PHONE_PORT"].flatMap(Int.init) ?? feature.phoneSettings.port
            let srv = PhoneLANServer(host: host) { [weak feature] body in
                guard let feature else { return PhoneCoreAPI.unpaired }
                return await PhoneCoreAPI.handle(feature, body)
            }
            srv.log = { ctx.log($0) }
            do {
                try await srv.start(preferredPort: port, bonjourName: host == nil ? String("Glide on \(PhoneCoreActions.macName)".prefix(60)) : nil)
                core.server = srv
                core.lastError = nil
                ctx.log("iPhone server listening on \(srv.baseURL ?? "?")")
            } catch {
                core.lastError = "Glide could not start the iPhone server (\(error.localizedDescription)). Turn it off and on again."
                ctx.log("iPhone server could not start: \(error.localizedDescription)")
            }
            core.bump()
        }
        core.starting = t
        await t.value
        core.starting = nil
    }

    static func stopServer(_ feature: PhoneFeature) async {
        let core = feature.core
        if let s = core.starting { await s.value }
        let s = core.server
        core.server = nil
        if let s { await s.close() }
        core.bump()
    }

    @discardableResult static func applySettings(_ feature: PhoneFeature, _ patch: JSONValue) async -> JSONValue {
        let before = feature.phoneSettings
        let clean = cleanPatch(feature, patch)
        if !clean.isEmpty { feature.context?.setSettings(clean) }
        let after = feature.phoneSettings
        if before.enabled && !after.enabled {
            feature.confirmations.denyAll()
            feature.core.pairing = nil
            await stopServer(feature)
        } else if after.enabled && feature.core.server == nil {
            await startServer(feature)
        } else if after.enabled && before.port != after.port {
            await stopServer(feature)
            await startServer(feature)
        }
        feature.core.bump()
        return state(feature)
    }

    static func cleanPatch(_ feature: PhoneFeature, _ patch: JSONValue) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        let known = Set(feature.registry.order)
        if let b = patch["enabled"]?.boolValue { out["enabled"] = .bool(b) }
        if let p = patch["port"]?.intValue, p == 0 || (1024...65535).contains(p) { out["port"] = .int(Int64(p)) }
        if let v = patch["confirmTimeoutSec"]?.intValue, (5...600).contains(v) { out["confirmTimeoutSec"] = .int(Int64(v)) }
        if let g = patch["groups"]?.objectValue {
            var cur = feature.phoneSettings.groups
            for (k, v) in g where PhoneGroups.ids.contains(k) { if let b = v.boolValue { cur[k] = b } }
            out["groups"] = .object(cur.mapValues(JSONValue.bool))
        }
        if let p = patch["policies"]?.objectValue {
            var t: [String: JSONValue] = [:]
            for (k, v) in p where known.contains(k) { if let s = v.stringValue, PhonePolicy(rawValue: s) != nil { t[k] = .string(s) } }
            out["policies"] = .object(t)
        }
        if let always = patch["always"]?.objectValue {
            var a: [String: JSONValue] = [:]
            for (k, v) in always {
                let names = Array(Set((v.arrayValue ?? []).compactMap(\.stringValue).filter { known.contains($0) })).sorted()
                if !names.isEmpty { a[String(k.prefix(64))] = .array(names.map(JSONValue.string)) }
            }
            out["always"] = .object(a)
        }
        return out
    }

    // MARK: pairing

    /// Create a pending device and the QR link. Needs the server to be running.
    @discardableResult static func beginPairing(_ feature: PhoneFeature) async -> Bool {
        if !feature.phoneSettings.enabled { await applySettings(feature, ["enabled": true]) }
        guard let reg = feature.core.devices, let srv = feature.core.server, let base = srv.baseURL else { return false }
        if let old = feature.core.pairing { reg.cancelPending(old.deviceId) }
        let p = reg.createPending()
        let frag = "#pair=\(p.id).\(PhoneCrypto.base64url(p.key))"
        feature.core.pairing = (p.id, base + "/" + frag, srv.localURL.map { $0 + "/" + frag })
        feature.core.bump()
        let id = p.id
        Task { @MainActor [weak feature] in
            try? await Task.sleep(for: .seconds(PhoneDeviceRegistry.pendingLifetime + 1))
            guard let feature, feature.core.pairing?.deviceId == id else { return }
            feature.core.devices?.prune()
            feature.core.pairing = nil
            feature.core.bump()
        }
        return true
    }

    static func cancelPairing(_ feature: PhoneFeature) {
        if let p = feature.core.pairing { feature.core.devices?.cancelPending(p.deviceId) }
        feature.core.pairing = nil
        feature.core.bump()
    }

    // MARK: state for the test channel and the Settings page

    static func policyRows(_ feature: PhoneFeature) -> [JSONValue] {
        let s = feature.phoneSettings
        return feature.registry.all.map { a in
            ["name": .string(a.name), "title": .string(a.title), "group": .string(a.group), "risk": .string(a.risk.rawValue), "sensitive": .bool(a.sensitive),
             "relay": .bool(a.relay), "policy": .string(PhoneGate.policy(a, s).rawValue), "defaultPolicy": .string(PhoneGate.defaultPolicy(a).rawValue)]
        }
    }

    static func state(_ feature: PhoneFeature) -> JSONValue {
        let core = feature.core
        let reg = core.devices
        return ["settings": feature.phoneSettings.json, "running": .bool(core.server != nil), "url": core.server?.baseURL.map(JSONValue.string) ?? .null,
                "localURL": core.server?.localURL.map(JSONValue.string) ?? .null, "port": .int(Int64(core.server?.port ?? 0)),
                "bonjour": .bool(core.server?.advertised ?? false), "error": core.lastError.map(JSONValue.string) ?? .null,
                "devices": .array((reg?.devices ?? []).map(\.json)), "pendingPairing": core.pairing.map { .string($0.deviceId) } ?? .null,
                "actions": .array(policyRows(feature)), "pending": .array(feature.confirmations.pending.map(\.json))]
    }

    // MARK: catalogue

    static func items(_ f: PhoneFeature) -> [SearchItem] {
        [SearchItem(id: "phone:pair", kind: .command, title: "Pair iPhone", subtitle: "Use Glide from your iPhone on the same Wi-Fi", icon: .symbol("iphone.gen3"),
                    keywords: ["iphone", "phone", "pair", "remote", "qr", "mobile", "send to mac"], feature: f.id, data: ["action": "pair"], kindLabel: "iPhone"),
         SearchItem(id: "phone:requests", kind: .command, title: "iPhone Requests", subtitle: "Requests from your iPhone that need an answer", icon: .symbol("iphone.badge.exclamationmark"),
                    keywords: ["iphone", "phone", "requests", "approve", "allow", "deny"], feature: f.id, data: ["action": "requests"], kindLabel: "iPhone")]
    }

    static func actions(_ f: PhoneFeature, for item: SearchItem) -> [ItemAction] {
        item.data?["action"]?.stringValue == "requests" ? [ItemAction(id: "requests", title: "Show Requests", shortcut: "↩", icon: "iphone.badge.exclamationmark")]
            : [ItemAction(id: "pair", title: "Pair iPhone", shortcut: "↩", icon: "qrcode"), ItemAction(id: "settings", title: "Open iPhone Settings", shortcut: "⌘↩", icon: "gearshape")]
    }

    static func run(_ f: PhoneFeature, action: String, on item: ScoredItem) -> ActionResult {
        switch action {
        case "requests": return .pushView(confirmView)
        case "pair": return .openSettings(page: "\(f.id)/pair")
        default: return .openSettings(page: f.id)
        }
    }

    // MARK: test channel / other features

    static func requireHeadless(_ f: PhoneFeature) throws {
        guard f.context?.services.isHeadless == true else { throw FeatureError.failed("Only available with GLIDE_HEADLESS=1") }
    }

    static func invoke(_ f: PhoneFeature, method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "state": return state(f)
        case "setSettings": return await applySettings(f, args)
        case "setEnabled": return await applySettings(f, ["enabled": .bool(args.boolValue ?? args["enabled"]?.boolValue ?? false)])
        case "setGroup":
            guard let g = args["group"]?.stringValue else { throw FeatureError.invalidArguments("group missing") }
            return await applySettings(f, ["groups": [g: .bool(args["enabled"]?.boolValue ?? false)]])
        case "setPolicy":
            guard let n = args["name"]?.stringValue, let p = args["policy"]?.stringValue else { throw FeatureError.invalidArguments("name and policy") }
            var t = f.phoneSettings.policies
            t[n] = p
            return await applySettings(f, ["policies": .object(t.mapValues(JSONValue.string))])
        case "resetPolicies": return await applySettings(f, ["policies": [:]])
        case "revokeAlways":
            var always = f.phoneSettings.always
            if let d = args["deviceId"]?.stringValue {
                if let a = args["action"]?.stringValue { always[d] = (always[d] ?? []).filter { $0 != a } } else { always[d] = nil }
            }
            return await applySettings(f, ["always": .object(always.mapValues { .array($0.map(JSONValue.string)) })])
        case "beginPairing":
            let ok = await beginPairing(f)
            var o: [String: JSONValue] = ["ok": .bool(ok), "deviceId": f.core.pairing.map { .string($0.deviceId) } ?? .null]
            if f.context?.services.isHeadless == true { o["url"] = f.core.pairing.map { .string($0.url) } ?? .null }
            return .object(o)
        case "cancelPairing":
            cancelPairing(f)
            return true
        case "pairDevice":
            // Headless E2E hook: a paired device without the UI. Returns the key (never outside headless).
            try requireHeadless(f)
            guard let reg = f.core.devices else { throw FeatureError.failed("not started") }
            let p = reg.createPending()
            if args["activate"]?.boolValue != false { reg.activate(p.id, name: args["name"]?.stringValue) }
            return ["deviceId": .string(p.id), "key": .string(PhoneCrypto.base64url(p.key)), "base": f.lanBaseURL.map(JSONValue.string) ?? .null]
        case "devices": return .array((f.core.devices?.devices ?? []).map(\.json))
        case "renameDevice":
            return .bool(f.core.devices?.rename(args["id"]?.stringValue ?? "", args["name"]?.stringValue ?? "") ?? false)
        case "revokeDevice":
            let id = args["id"]?.stringValue ?? ""
            let ok = f.core.devices?.revoke(id) ?? false
            if ok {
                var always = f.phoneSettings.always
                if always.removeValue(forKey: id) != nil { await applySettings(f, ["always": .object(always.mapValues { .array($0.map(JSONValue.string)) })]) }
            }
            return .bool(ok)
        case "perform":
            // Headless hook: run an action through the gate as a given caller (no transport crypto).
            try requireHeadless(f)
            let caller = PhoneCaller(deviceId: args["deviceId"]?.stringValue ?? "test", deviceName: args["deviceName"]?.stringValue ?? "Test iPhone",
                                     transport: PhoneCaller.Transport(rawValue: args["transport"]?.stringValue ?? "lan") ?? .lan)
            return await f.perform(args["action"]?.stringValue ?? "", args: args["args"] ?? [:], caller: caller)
        case "pending": return .array(f.confirmations.pending.map(\.json))
        case "respond":
            return .bool(f.confirmations.respond(args["id"]?.stringValue ?? f.confirmations.pending.first?.id ?? "", decision: args["decision"]?.stringValue ?? ""))
        case "log": return .array(f.core.log.list.map { e in (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(e))) ?? .null })
        case "clearLog":
            f.core.log.clear()
            return []
        case "snapshotSettings":
            let path = args["path"]?.stringValue ?? NSTemporaryDirectory() + "phone-settings.png"
            let size = try AgentSnapshot.render(AnyView(PhoneSettingsView(feature: f)), size: NSSize(width: 680, height: args["height"]?.intValue.map(CGFloat.init) ?? 1400),
                                                to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .double(size.width), "height": .double(size.height)]
        default:
            if let m = f.core.methods[method] { return try await m(args) }
            throw FeatureError.unknownMethod(feature: f.id, method: method)
        }
    }

    // MARK: UI

    static func settingsPage(_ f: PhoneFeature) -> SettingsPage? {
        SettingsPage(id: f.id, title: "iPhone", symbol: "iphone.gen3", order: 47, onRoute: { [weak f] route in
            guard let f, route == "pair" else { return }
            Task { @MainActor in await beginPairing(f) }
        }) { [weak f] in
            guard let f else { return AnyView(EmptyView()) }
            return AnyView(PhoneSettingsView(feature: f))
        }
    }

    static func launcherView(_ f: PhoneFeature, _ view: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard view == confirmView else { return nil }
        host.setPlaceholder("iPhone requests")
        host.setFooter(primary: f.confirmations.pending.isEmpty ? nil : "Allow Once", hasActions: false)
        return AnyView(PhoneConfirmView(feature: f, core: f.core))
    }

    static func handleKey(_ f: PhoneFeature, _ key: VimKey, view: ViewID) -> Bool {
        guard view == confirmView else { return false }
        let list = f.confirmations.pending
        guard !list.isEmpty else { return false }
        let i = min(f.core.confirmSelected, list.count - 1)
        switch (key.key, key.meta) {
        case ("ArrowDown", false): f.core.confirmSelected = min(list.count - 1, i + 1); return true
        case ("ArrowUp", false): f.core.confirmSelected = max(0, i - 1); return true
        case ("Enter", let meta) where !key.ctrl:
            f.confirmations.respond(list[i].id, decision: meta ? "always" : "allow")
            afterAnswer(f)
            return true
        case ("Backspace", true):
            f.confirmations.respond(list[i].id, decision: "deny")
            afterAnswer(f)
            return true
        default: return false
        }
    }

    static func afterAnswer(_ f: PhoneFeature) {
        f.core.confirmSelected = 0
        if f.confirmations.pending.isEmpty { LauncherHosts.current?.pop() }
    }
}

/// POST /api: open the envelope, check freshness, run through `perform`, seal the answer.
@MainActor enum PhoneCoreAPI {
    static var unpaired: PhoneHTTPResponse { PhoneHTTPResponse(status: 401, body: Data(#"{"error":"unpaired"}"#.utf8)) }

    static func handle(_ f: PhoneFeature, _ data: Data) async -> PhoneHTTPResponse {
        guard let reg = f.core.devices, let body = PhoneEnvelope.parse(data), let key = reg.key(for: body.d) else { return unpaired }
        let plain: Data
        do { plain = try await Task.detached { try PhoneEnvelope.open(body, key: key, direction: .req) }.value } catch { return unpaired }
        guard let msg = try? JSONDecoder().decode(JSONValue.self, from: plain), let ts = msg["ts"]?.doubleValue,
              let action = msg["action"]?.stringValue, action.count <= 80 else { return unpaired }
        guard reg.acceptFresh(deviceId: body.d, nonce: body.n, ts: ts) else { return unpaired }
        let rid = msg["id"]?.stringValue.map { String($0.prefix(100)) } ?? ""
        let args = msg["args"] ?? [:]
        guard let device = reg.device(body.d) ?? reg.activate(body.d, name: action == "hello" ? args["name"]?.stringValue : nil) else { return unpaired }
        if f.core.pairing?.deviceId == device.id {
            f.core.pairing = nil
            f.context?.toast("\(device.name) is paired", style: .success)
        }
        reg.touch(device.id, transport: "lan")
        let caller = PhoneCaller(deviceId: device.id, deviceName: device.name, transport: .lan)
        var out = (await f.perform(action, args: args, caller: caller)).objectValue ?? [:]
        out["id"] = .string(rid)
        var json = (try? JSONEncoder.glideCompact.encode(JSONValue.object(out))) ?? Data()
        if json.count > PhoneLANServer.maxBody - 1024 {
            json = (try? JSONEncoder.glideCompact.encode(JSONValue.object(["id": .string(rid), "ok": false,
                                                                           "error": ["code": "too-large", "message": "The answer is bigger than 32 MB. Pick a smaller file."]]))) ?? Data()
        }
        let payload = json
        guard let sealed = try? await Task.detached(operation: { try PhoneEnvelope.seal(payload, key: key, deviceId: device.id, direction: .res) }).value else {
            return PhoneHTTPResponse(status: 500, body: Data(#"{"error":"internal"}"#.utf8))
        }
        return PhoneHTTPResponse(status: 200, body: PhoneEnvelope.encode(sealed))
    }
}
