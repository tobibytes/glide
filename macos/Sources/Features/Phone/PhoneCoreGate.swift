import Foundation
import GlideCore

// phone-core: the gate every phone action goes through (docs/PHONE.md "Two transports, one action registry"):
// transport check, group switch, per-action policy (Allow / Ask / Off), confirmation on the Mac, run, request log.

/// Per-action policy, like the MCP server's.
enum PhonePolicy: String, Sendable, CaseIterable { case allow, ask, off }

/// The groups that have a switch in Settings → iPhone (all off by default). Other groups ("core", "notify") are
/// always on; their actions are still gated one by one.
enum PhoneGroups {
    static let switchable: [(id: String, title: String, symbol: String, detail: String)] = [
        ("clipboard", "Clipboard", "doc.on.clipboard", "Read and replace the Mac clipboard and its history from the phone."),
        ("remote", "Remote control", "hand.point.up.left", "Trackpad, keyboard, media keys and a slide clicker. Only on the same Wi-Fi."),
        ("files", "Files", "folder", "Search files on this Mac and download one to the phone. Only on the same Wi-Fi."),
        ("agent", "Glide Agent", "sparkles", "Ask Glide Agent from the phone. Anything it wants to change still asks first."),
    ]
    static let ids: Set<String> = Set(switchable.map(\.id))
}

/// The feature's settings bag (`settings.features.phone`).
struct PhoneSettings: Equatable {
    var enabled = false
    /// Preferred LAN port (0 = any free port).
    var port = 7470
    var groups: [String: Bool] = [:]
    /// action name → "allow" | "ask" | "off" (only what the user changed).
    var policies: [String: String] = [:]
    /// "Always allow" grants from the confirmation prompt: device id → action names.
    var always: [String: [String]] = [:]
    var confirmTimeoutSec = 60

    static let defaultsBag: [String: JSONValue] = ["enabled": false, "port": 7470, "groups": [:], "policies": [:], "always": [:], "confirmTimeoutSec": 60]

    init() {}
    init(bag b: [String: JSONValue]) {
        enabled = b["enabled"]?.boolValue == true
        port = b["port"]?.intValue ?? 7470
        groups = (b["groups"]?.objectValue ?? [:]).compactMapValues(\.boolValue)
        policies = (b["policies"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
        always = (b["always"]?.objectValue ?? [:]).mapValues { ($0.arrayValue ?? []).compactMap(\.stringValue) }
        confirmTimeoutSec = max(5, min(600, b["confirmTimeoutSec"]?.intValue ?? 60))
    }

    var json: JSONValue {
        ["enabled": .bool(enabled), "port": .int(Int64(port)), "groups": .object(groups.mapValues(JSONValue.bool)),
         "policies": .object(policies.mapValues(JSONValue.string)), "always": .object(always.mapValues { .array($0.map(JSONValue.string)) }),
         "confirmTimeoutSec": .int(Int64(confirmTimeoutSec))]
    }

    func groupEnabled(_ g: String) -> Bool { PhoneGroups.ids.contains(g) ? groups[g] == true : true }
}

@MainActor enum PhoneGate {
    enum Decision: Equatable { case deny(PhoneError), run, confirm }

    /// Default: sensitive → Off, confirm → Ask, safe → Allow. A disabled group forces Off (see `policy`).
    static func defaultPolicy(_ a: PhoneAction) -> PhonePolicy {
        if a.sensitive && !PhoneGroups.ids.contains(a.group) { return .off }
        return a.risk == .confirm ? .ask : .allow
    }

    /// The effective policy: group switch first, then the user's choice, then the default.
    static func policy(_ a: PhoneAction, _ s: PhoneSettings) -> PhonePolicy {
        guard s.groupEnabled(a.group) else { return .off }
        if let raw = s.policies[a.name], let p = PhonePolicy(rawValue: raw) { return p }
        return defaultPolicy(a)
    }

    static func decide(_ a: PhoneAction, _ s: PhoneSettings, caller: PhoneCaller) -> Decision {
        if caller.transport == .relay && !a.relay {
            return .deny(PhoneError("denied", "\(a.title) works only from Glide Remote on the same Wi-Fi as the Mac."))
        }
        switch policy(a, s) {
        case .off:
            if !s.groupEnabled(a.group), let g = PhoneGroups.switchable.first(where: { $0.id == a.group }) {
                return .deny(PhoneError("denied", "\(g.title) is off. Turn it on in Glide → Settings → iPhone."))
            }
            return .deny(PhoneError("denied", "\(a.title) is off. Turn it on in Glide → Settings → iPhone."))
        case .allow: return .run
        case .ask: return (s.always[caller.deviceId] ?? []).contains(a.name) ? .run : .confirm
        }
    }

    static func ok(_ result: JSONValue) -> JSONValue { ["ok": true, "result": result] }
    static func fail(_ e: PhoneError) -> JSONValue { ["ok": false, "error": ["code": .string(e.code), "message": .string(e.message)]] }
}

// MARK: - confirmations

/// Pending "Ask" confirmations. Each waits for Allow / Always / Deny on the Mac (launcher view `phone.confirm`)
/// or from a paired phone (phone-notify's `approvals.respond`). Denied on timeout (60 s by default), when too
/// many already wait, or when the feature stops.
@MainActor public final class PhoneConfirmations {
    public struct Request: Identifiable, Sendable, Equatable {
        public let id: String
        public let deviceName: String
        public let action: String
        public let title: String
        public let summary: String
        public let at: Date
        /// Internal: who asked (for "always" grants). Not part of the shared shape.
        let deviceId: String
        let expiresAt: Date

        var json: JSONValue {
            ["id": .string(id), "deviceName": .string(deviceName), "action": .string(action), "title": .string(title), "summary": .string(summary),
             "at": .int(Int64(at.timeIntervalSince1970 * 1000)), "expiresAt": .int(Int64(expiresAt.timeIntervalSince1970 * 1000))]
        }
    }

    public enum Decision: String, Sendable { case allow, always, deny, timeout }

    var timeout: () -> Duration = { .seconds(60) }
    var maxPending = 5
    private var waiting: [String: (req: Request, resume: (Decision) -> Void)] = [:]
    private var order: [String] = []
    private var observers: [@MainActor (Request) -> Void] = []
    private var changeObservers: [@MainActor () -> Void] = []

    public init() {}

    public var pending: [Request] { order.compactMap { waiting[$0]?.req } }

    /// Called whenever a request is added (phone-notify pushes a notification; the Mac shows `phone.confirm`).
    public func addObserver(_ f: @escaping @MainActor (Request) -> Void) { observers.append(f) }
    /// Called whenever the pending list changes (added, answered, expired).
    func addChangeObserver(_ f: @escaping @MainActor () -> Void) { changeObservers.append(f) }

    func request(caller: PhoneCaller, action: String, title: String, summary: String) async -> Decision {
        if waiting.count >= maxPending { return .deny }
        let now = Date()
        let limit = timeout()
        let secs = Double(limit.components.seconds) + Double(limit.components.attoseconds) / 1e18
        let req = Request(id: PhoneCrypto.randomID(9), deviceName: caller.deviceName, action: action, title: title, summary: summary, at: now,
                          deviceId: caller.deviceId, expiresAt: now.addingTimeInterval(secs))
        return await withCheckedContinuation { (c: CheckedContinuation<Decision, Never>) in
            var done = false
            waiting[req.id] = (req, { d in
                guard !done else { return }
                done = true
                c.resume(returning: d)
            })
            order.append(req.id)
            for o in observers { o(req) }
            for o in changeObservers { o() }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: limit)
                self?.settle(req.id, .timeout)
            }
        }
    }

    @discardableResult func settle(_ id: String, _ d: Decision) -> Bool {
        guard let w = waiting.removeValue(forKey: id) else { return false }
        order.removeAll { $0 == id }
        w.resume(d)
        for o in changeObservers { o() }
        return true
    }

    /// Answer a pending request: "allow" | "always" | "deny". False when it is unknown or already answered.
    @discardableResult public func respond(_ id: String, decision: String) -> Bool {
        guard let d = Decision(rawValue: decision), d != .timeout else { return false }
        return settle(id, d)
    }

    func denyAll() { for id in order { settle(id, .deny) } }
}

// MARK: - request log (<dataDir>/requests.json; never arguments, clipboard text or file contents)

struct PhoneLogEntry: Codable, Equatable, Sendable {
    var id: String
    /// Unix ms.
    var at: Double
    var deviceId: String
    var device: String
    var transport: String
    var action: String
    /// ok | error | denied | timeout | off | not-found
    var outcome: String
    var ms: Double
    /// Error code (never the message, which can echo arguments).
    var error: String?
    /// auto | user | always
    var approval: String?
}

@MainActor final class PhoneRequestLog {
    static let max = 300
    let file: URL?
    private(set) var entries: [PhoneLogEntry] = []
    private var seq = 0
    private var writeTask: Task<Void, Never>?
    var onChange: () -> Void = {}

    init(file: URL?) {
        self.file = file
        if let file, let d = try? Data(contentsOf: file), let list = try? JSONDecoder().decode([PhoneLogEntry].self, from: d) { entries = Array(list.suffix(Self.max)) }
    }

    func add(_ e: PhoneLogEntry) {
        seq += 1
        var e = e
        e.id = "\(String(Int64(e.at), radix: 36))-\(String(seq, radix: 36))"
        entries.append(e)
        if entries.count > Self.max { entries.removeFirst(entries.count - Self.max) }
        persist()
        onChange()
    }

    /// Newest first.
    var list: [PhoneLogEntry] { entries.reversed() }

    func clear() {
        entries = []
        persist()
        onChange()
    }

    private func persist() {
        guard file != nil, writeTask == nil else { return }
        writeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self else { return }
            self.writeTask = nil
            self.flush()
        }
    }

    func flush() {
        guard let file else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONEncoder.glideCompact.encode(entries) { try? d.write(to: file, options: .atomic) }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

// MARK: - the shared API (docs/PHONE.md; used by phone-web, phone-relay, phone-notify)

extension PhoneFeature {
    /// The only way to run an action: gate (transport, group switch, policy Allow/Ask/Off, confirmation), run, log.
    /// Returns {"ok":true,"result":…} or {"ok":false,"error":{"code","message"}}.
    func perform(_ action: String, args: JSONValue, caller: PhoneCaller) async -> JSONValue {
        let t0 = Date()
        let s = phoneSettings
        func record(_ outcome: String, error: String? = nil, approval: String? = nil) {
            core.log.add(PhoneLogEntry(id: "", at: t0.timeIntervalSince1970 * 1000, deviceId: caller.deviceId, device: caller.deviceName,
                                       transport: caller.transport.rawValue, action: String(action.prefix(80)), outcome: outcome,
                                       ms: Date().timeIntervalSince(t0) * 1000, error: error, approval: approval))
        }
        guard let a = registry.action(action) else {
            record("not-found", error: "not-found")
            return PhoneGate.fail(.notFound)
        }
        var approval = "auto"
        switch PhoneGate.decide(a, s, caller: caller) {
        case let .deny(e):
            record(PhoneGate.policy(a, s) == .off ? "off" : "denied", error: e.code)
            return PhoneGate.fail(e)
        case .run:
            if (s.always[caller.deviceId] ?? []).contains(a.name), PhoneGate.policy(a, s) == .ask { approval = "always" }
        case .confirm:
            let summary = PhoneCoreSummary.describe(a, args: args)
            switch await confirmations.request(caller: caller, action: a.name, title: a.title, summary: summary) {
            case .allow: approval = "user"
            case .always:
                grantAlways(deviceId: caller.deviceId, action: a.name)
                approval = "always"
            case .deny:
                record("denied", error: "denied", approval: "user")
                return PhoneGate.fail(PhoneError("denied", "Denied on the Mac."))
            case .timeout:
                record("timeout", error: "timeout")
                return PhoneGate.fail(PhoneError("timeout", "No one answered on the Mac within a minute, so Glide did not run it. Try again."))
            }
        }
        do {
            let out = try await a.run(args, caller)
            record("ok", approval: approval)
            return PhoneGate.ok(out)
        } catch let e as PhoneError {
            record("error", error: e.code, approval: approval)
            return PhoneGate.fail(e)
        } catch {
            record("error", error: "failed", approval: approval)
            return PhoneGate.fail(PhoneError("failed", (error as? LocalizedError)?.errorDescription ?? error.localizedDescription))
        }
    }

    /// Whether a group's switch in Settings → iPhone is on ("core" and "notify" are always on).
    func isGroupEnabled(_ group: String) -> Bool { phoneSettings.groupEnabled(group) }

    /// "http://<LAN IP>:<port>" while the LAN server runs, else nil (phone-notify uses it for approval links).
    var lanBaseURL: String? { core.server?.baseURL }

    var phoneSettings: PhoneSettings {
        PhoneSettings(bag: context?.settings(defaults: PhoneSettings.defaultsBag) ?? PhoneSettings.defaultsBag)
    }

    func grantAlways(deviceId: String, action: String) {
        var always = phoneSettings.always
        var list = always[deviceId] ?? []
        if !list.contains(action) { list.append(action) }
        always[deviceId] = list
        context?.setSettings(["always": .object(always.mapValues { .array($0.map(JSONValue.string)) })])
        core.bump()
    }
}

/// Plain-English text for confirmations (never includes clipboard text or file contents in full).
@MainActor enum PhoneCoreSummary {
    static func clip(_ s: String, _ n: Int = 80) -> String {
        let one = s.replacingOccurrences(of: "\n", with: " ")
        return one.count > n ? String(one.prefix(n)) + "…" : one
    }

    static func describe(_ a: PhoneAction, args: JSONValue) -> String {
        switch a.name {
        case "run":
            if let id = args["id"]?.stringValue {
                let arg = args["argument"]?.stringValue.map { " with \"\(clip($0, 40))\"" } ?? ""
                return "Run \(clip(id, 60))\(arg)"
            }
        case "workflows.run":
            if let n = args["name"]?.stringValue ?? args["id"]?.stringValue { return "Run the workflow \"\(clip(n, 60))\"" }
        case "mac.sleep": return "Put the Mac to sleep"
        case "agent.ask":
            if let p = args["prompt"]?.stringValue { return "Ask Glide Agent: \"\(clip(p))\"" }
        default: break
        }
        return a.title
    }
}
