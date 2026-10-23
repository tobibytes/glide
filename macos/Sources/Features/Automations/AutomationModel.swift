import Foundation
import GlideCore

// Automations (Shortcuts-style "Personal Automations"): a trigger + a target (workflow or catalogue command).
// Port of src/main/features/automations/model.ts + schedule.ts; automations.json stays byte-compatible in shape.

public enum AutomationTrigger: Hashable, Sendable {
    /// time "HH:MM" (24 h, local); days 0=Sun…6=Sat, empty = every day
    case time(time: String, days: [Int])
    case interval(minutes: Int)
    /// app: name or bundle id, "" = any app; event launched | quit | activated
    case app(event: String, app: String)
    /// network: SSID or router signature, "" = any; event joined | left | changed
    case wifi(event: String, network: String)
    /// event ac | battery | below | above
    case power(event: String, percent: Int)
    /// event connected | disconnected | any
    case display(event: String)
    /// event added | any
    case folder(path: String, event: String)
    case launch
    case hotkey(accelerator: String)

    public var kind: String {
        switch self {
        case .time: return "time"
        case .interval: return "interval"
        case .app: return "app"
        case .wifi: return "wifi"
        case .power: return "power"
        case .display: return "display"
        case .folder: return "folder"
        case .launch: return "launch"
        case .hotkey: return "hotkey"
        }
    }

    public var json: JSONValue {
        switch self {
        case let .time(t, d): return ["kind": "time", "time": .string(t), "days": .array(d.map { .int(Int64($0)) })]
        case let .interval(m): return ["kind": "interval", "minutes": .int(Int64(m))]
        case let .app(e, a): return ["kind": "app", "event": .string(e), "app": .string(a)]
        case let .wifi(e, n): return ["kind": "wifi", "event": .string(e), "network": .string(n)]
        case let .power(e, p): return ["kind": "power", "event": .string(e), "percent": .int(Int64(p))]
        case let .display(e): return ["kind": "display", "event": .string(e)]
        case let .folder(p, e): return ["kind": "folder", "path": .string(p), "event": .string(e)]
        case .launch: return ["kind": "launch"]
        case let .hotkey(a): return ["kind": "hotkey", "accelerator": .string(a)]
        }
    }
}

public enum AutomationTarget: Hashable, Sendable {
    case workflow(workflowId: String)
    /// argument may contain {{input}} (the trigger's value, e.g. the added file's path)
    case command(itemId: String, title: String, argument: String)

    public var json: JSONValue {
        switch self {
        case let .workflow(id): return ["kind": "workflow", "workflowId": .string(id)]
        case let .command(i, t, a): return ["kind": "command", "itemId": .string(i), "title": .string(t), "argument": .string(a)]
        }
    }
}

public struct AutomationRunRecord: Hashable, Sendable {
    public var id: String
    public var at: Double
    public var trigger: String
    /// ok | error | skipped
    public var status: String
    public var message: String
    public var input: String?
    public var durationMs: Double
    public var manual: Bool?

    public var json: JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "at": .double(at), "trigger": .string(trigger), "status": .string(status), "message": .string(message), "durationMs": .double(durationMs)]
        if let input { o["input"] = .string(input) }
        if manual == true { o["manual"] = true }
        return .object(o)
    }
}

public struct Automation: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var enabled: Bool
    public var askBeforeRunning: Bool
    public var trigger: AutomationTrigger
    public var target: AutomationTarget
    public var createdAt: Double
    public var updatedAt: Double
    /// newest first, at most `AutomationModel.logLimit`
    public var log: [AutomationRunRecord]

    public var json: JSONValue {
        ["id": .string(id), "name": .string(name), "enabled": .bool(enabled), "askBeforeRunning": .bool(askBeforeRunning), "trigger": trigger.json, "target": target.json,
         "createdAt": .double(createdAt), "updatedAt": .double(updatedAt), "log": .array(log.map(\.json))]
    }
}

/// Events produced by the sources; the engine matches them against triggers.
public enum AutomationEvent: Hashable, Sendable {
    case app(event: String, name: String, bundleId: String?)
    case wifi(from: String?, to: String?)
    case power(source: String, percent: Int, prevSource: String, prevPercent: Int)
    case display(event: String, name: String)
    case folder(path: String, event: String, file: String)
    case launch
    case hotkey(automationId: String)

    /// The Electron TriggerEvent JSON (debugEvent).
    public init?(json v: JSONValue) {
        let s = { (k: String) in v[k]?.stringValue }
        switch s("type") ?? "" {
        case "app": self = .app(event: s("event") ?? "launched", name: s("name") ?? "", bundleId: s("bundleId"))
        case "wifi": self = .wifi(from: s("from"), to: s("to"))
        case "power": self = .power(source: s("source") ?? "battery", percent: v["percent"]?.intValue ?? 0, prevSource: s("prevSource") ?? "battery", prevPercent: v["prevPercent"]?.intValue ?? 0)
        case "display": self = .display(event: s("event") ?? "connected", name: s("name") ?? "Display")
        case "folder": self = .folder(path: s("path") ?? "", event: s("event") ?? "added", file: s("file") ?? "")
        case "launch": self = .launch
        case "hotkey": self = .hotkey(automationId: s("automationId") ?? "")
        default: return nil
        }
    }
}

public enum AutomationModel {
    public static let logLimit = 50
    public static let rateLimitMs: Double = 10_000
    public static let minInterval = 1
    public static let maxInterval = 7 * 24 * 60

    public static let triggerKinds: [(kind: String, title: String, symbol: String)] = [
        ("time", "Time of Day", "clock"), ("interval", "Every N Minutes", "repeat"), ("app", "App", "app.badge"),
        ("wifi", "Wi‑Fi Network", "wifi"), ("power", "Power & Battery", "battery.75percent"), ("display", "Display", "display"),
        ("folder", "Folder", "folder"), ("launch", "Glide Launches", "power"), ("hotkey", "Global Hotkey", "keyboard"),
    ]

    /// Workflow actions that touch other apps, the network or files — default "ask before running" for these.
    public static let riskyActions: Set<String> = ["runShell", "runAppleScript", "typeText", "httpRequest", "openFile", "setClipboard"]

    public static func defaultTrigger(_ kind: String) -> AutomationTrigger {
        switch kind {
        case "time": return .time(time: "09:00", days: [])
        case "interval": return .interval(minutes: 15)
        case "app": return .app(event: "launched", app: "")
        case "wifi": return .wifi(event: "joined", network: "")
        case "power": return .power(event: "below", percent: 20)
        case "display": return .display(event: "connected")
        case "folder": return .folder(path: "~/Downloads", event: "added")
        case "hotkey": return .hotkey(accelerator: "")
        default: return .launch
        }
    }

    // MARK: validation (untrusted JSON: disk, settings UI, test channel)

    static func str(_ v: JSONValue?) -> String { v?.stringValue ?? "" }
    static func num(_ v: JSONValue?, _ fallback: Double) -> Double {
        if let d = v?.doubleValue, d.isFinite { return d }
        if let s = v?.stringValue, let d = Double(s.trimmingCharacters(in: .whitespaces)), d.isFinite { return d }
        return fallback
    }
    static func oneOf(_ v: JSONValue?, _ options: [String], _ fallback: String) -> String {
        guard let s = v?.stringValue, options.contains(s) else { return fallback }
        return s
    }

    public static func normalizeTime(_ s: String) -> String? {
        let parts = s.trimmingCharacters(in: .whitespaces).split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, (1...2).contains(parts[0].count), parts[1].count == 2, let h = Int(parts[0]), let m = Int(parts[1]), parts[0].allSatisfy(\.isNumber), parts[1].allSatisfy(\.isNumber),
              h <= 23, m <= 59 else { return nil }
        return String(format: "%02d:%@", h, String(parts[1]))
    }

    public static func normalizeTrigger(_ raw: JSONValue?) -> AutomationTrigger? {
        guard let raw, raw.objectValue != nil, let kind = raw["kind"]?.stringValue else { return nil }
        switch kind {
        case "time":
            guard let t = normalizeTime(str(raw["time"])) else { return nil }
            var days = Array(Set((raw["days"]?.arrayValue ?? []).compactMap { $0.intValue }.filter { (0...6).contains($0) })).sorted()
            if days.count == 7 { days = [] }
            return .time(time: t, days: days)
        case "interval":
            let m = Int(num(raw["minutes"], 15).rounded())
            return .interval(minutes: min(maxInterval, max(minInterval, m)))
        case "app": return .app(event: oneOf(raw["event"], ["launched", "quit", "activated"], "launched"), app: str(raw["app"]).trimmingCharacters(in: .whitespaces))
        case "wifi": return .wifi(event: oneOf(raw["event"], ["joined", "left", "changed"], "joined"), network: str(raw["network"]).trimmingCharacters(in: .whitespaces))
        case "power":
            return .power(event: oneOf(raw["event"], ["ac", "battery", "below", "above"], "below"), percent: min(100, max(1, Int(num(raw["percent"], 20).rounded()))))
        case "display": return .display(event: oneOf(raw["event"], ["connected", "disconnected", "any"], "connected"))
        case "folder":
            let p = str(raw["path"]).trimmingCharacters(in: .whitespaces)
            return p.isEmpty ? nil : .folder(path: p, event: oneOf(raw["event"], ["added", "any"], "added"))
        case "launch": return .launch
        case "hotkey":
            let a = str(raw["accelerator"]).trimmingCharacters(in: .whitespaces)
            return a.isEmpty ? nil : .hotkey(accelerator: a)
        default: return nil
        }
    }

    public static func normalizeTarget(_ raw: JSONValue?) -> AutomationTarget? {
        guard let raw, raw.objectValue != nil else { return nil }
        switch raw["kind"]?.stringValue {
        case "workflow":
            let id = str(raw["workflowId"]).trimmingCharacters(in: .whitespaces)
            return id.isEmpty ? nil : .workflow(workflowId: id)
        case "command":
            let id = str(raw["itemId"]).trimmingCharacters(in: .whitespaces)
            return id.isEmpty ? nil : .command(itemId: id, title: raw["title"]?.stringValue ?? id, argument: str(raw["argument"]))
        default: return nil
        }
    }

    static func normalizeRecord(_ raw: JSONValue) -> AutomationRunRecord? {
        guard raw.objectValue != nil, let at = raw["at"]?.doubleValue else { return nil }
        return AutomationRunRecord(id: raw["id"]?.stringValue ?? "r\(Int64(at))", at: at, trigger: str(raw["trigger"]),
                                   status: oneOf(raw["status"], ["ok", "error", "skipped"], "error"), message: str(raw["message"]),
                                   input: raw["input"]?.stringValue, durationMs: num(raw["durationMs"], 0), manual: raw["manual"]?.boolValue == true ? true : nil)
    }

    public enum Validation: Sendable {
        case ok(Automation)
        case error(String)
    }

    public static func validate(_ raw: JSONValue, now: Double) -> Validation {
        guard raw.objectValue != nil else { return .error("Invalid automation") }
        guard let trigger = normalizeTrigger(raw["trigger"]) else {
            switch raw["trigger"]?["kind"]?.stringValue {
            case "time": return .error("Enter a time like 09:00")
            case "folder": return .error("Choose a folder")
            case "hotkey": return .error("Record a hotkey")
            default: return .error("Choose a trigger")
            }
        }
        guard let target = normalizeTarget(raw["target"]) else { return .error("Choose a workflow or command to run") }
        let id = str(raw["id"]).trimmingCharacters(in: .whitespaces)
        let name = str(raw["name"]).trimmingCharacters(in: .whitespaces)
        let log = (raw["log"]?.arrayValue ?? []).compactMap(normalizeRecord).prefix(logLimit)
        return .ok(Automation(id: id.isEmpty ? newId("a", now) : id, name: name.isEmpty ? describe(trigger) : name, enabled: raw["enabled"]?.boolValue != false,
                              askBeforeRunning: raw["askBeforeRunning"]?.boolValue == true, trigger: trigger, target: target,
                              createdAt: num(raw["createdAt"], now), updatedAt: num(raw["updatedAt"], now), log: Array(log)))
    }

    nonisolated(unsafe) private static var seq = 0
    private static let seqLock = NSLock()
    public static func newId(_ prefix: String, _ now: Double) -> String {
        seqLock.lock()
        seq = (seq + 1) % 1_000_000
        let s = seq
        seqLock.unlock()
        return "\(prefix)\(String(Int64(now), radix: 36))\(String(s, radix: 36))\(String(Int.random(in: 0..<1296), radix: 36))"
    }

    // MARK: describing

    static let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    public static func describeDays(_ days: [Int]) -> String {
        if days.isEmpty || days.count == 7 { return "Every day" }
        let key = days.sorted().map(String.init).joined()
        if key == "12345" { return "Weekdays" }
        if key == "06" { return "Weekends" }
        return days.sorted().map { dayNames[$0] }.joined(separator: ", ")
    }

    static func q(_ s: String) -> String { "“\(s)”" }

    public static func describe(_ t: AutomationTrigger) -> String {
        switch t {
        case let .time(time, days): return "\(describeDays(days)) at \(time)"
        case let .interval(m):
            if m == 1 { return "Every minute" }
            if m % 60 == 0 { return m / 60 == 1 ? "Every hour" : "Every \(m / 60) hours" }
            return "Every \(m) minutes"
        case let .app(event, app):
            let who = app.isEmpty ? "any app" : q(app)
            return event == "launched" ? "When \(who) launches" : event == "quit" ? "When \(who) quits" : "When \(who) becomes active"
        case let .wifi(event, network):
            let net = network.isEmpty ? "a Wi‑Fi network" : "Wi‑Fi \(q(network))"
            return event == "joined" ? "When joining \(net)" : event == "left" ? "When leaving \(net)" : "When the Wi‑Fi network changes"
        case let .power(event, p):
            switch event {
            case "ac": return "When connected to power"
            case "battery": return "When switching to battery"
            case "below": return "When battery drops to \(p)%"
            default: return "When battery charges to \(p)%"
            }
        case let .display(event): return event == "connected" ? "When a display is connected" : event == "disconnected" ? "When a display is disconnected" : "When displays change"
        case let .folder(path, event): return event == "added" ? "When a file is added to \(path)" : "When \(path) changes"
        case .launch: return "When Glide launches"
        case let .hotkey(a): return "Hotkey \(a)"
        }
    }

    public static func describe(_ target: AutomationTarget, workflows: [Workflow]) -> String {
        switch target {
        case let .workflow(id):
            guard let wf = workflows.first(where: { $0.id == id }) else { return "Run a missing workflow" }
            return "Run workflow \(q(wf.name))"
        case let .command(_, title, argument): return "Run \(q(title))" + (argument.isEmpty ? "" : " with \(q(argument))")
        }
    }

    public static func describe(_ e: AutomationEvent) -> String {
        switch e {
        case let .app(event, name, _): return "\(name) \(event == "activated" ? "became active" : event)"
        case let .wifi(from, to): return to.map { "Joined \($0)" } ?? "Left \(from ?? "Wi‑Fi")"
        case let .power(source, percent, _, _): return "\(source == "ac" ? "Power adapter" : "Battery") · \(percent)%"
        case let .display(event, name): return "Display \(event): \(name)"
        case let .folder(_, event, file): return "\(event == "added" ? "Added" : "Changed") \(file)"
        case .launch: return "Glide launched"
        case .hotkey: return "Hotkey pressed"
        }
    }

    // MARK: risk

    static func actionsAreRisky(_ actions: [WorkflowAction], _ byId: (String) -> Workflow?, _ depth: Int) -> Bool {
        for a in actions where a.disabled != true {
            if riskyActions.contains(a.type) { return true }
            if a.type == "runWorkflow" {
                guard let sub = byId(a.param("workflowId") ?? ""), depth <= 4, !actionsAreRisky(sub.actions, byId, depth + 1) else { return true }
            }
            if a.type == "condition" && (actionsAreRisky(a.then ?? [], byId, depth) || actionsAreRisky(a.else ?? [], byId, depth)) { return true }
        }
        return false
    }

    /// Whether running the target unattended could change things outside Glide (default for "ask before running").
    public static func isRisky(_ target: AutomationTarget, workflows: [Workflow]) -> Bool {
        switch target {
        case let .command(itemId, _, _): return !(itemId.hasPrefix("app:") || itemId.hasPrefix("quicklink:"))
        case let .workflow(id):
            let byId = { (i: String) in workflows.first { $0.id == i } }
            guard let wf = byId(id) else { return true }
            return actionsAreRisky(wf.actions, byId, 0)
        }
    }

    // MARK: matching

    static func norm(_ s: String) -> String {
        var t = s.lowercased().replacingOccurrences(of: "_", with: " ")
        while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
        t = t.trimmingCharacters(in: .whitespaces)
        if t.hasSuffix(".app") { t.removeLast(4) }
        return t.trimmingCharacters(in: .whitespaces)
    }
    static func sameApp(_ pattern: String, _ name: String, _ bundleId: String?) -> Bool {
        pattern.isEmpty || norm(pattern) == norm(name) || (bundleId.map { pattern.lowercased() == $0.lowercased() } ?? false)
    }
    static func sameNetwork(_ pattern: String, _ net: String?) -> Bool {
        guard let net else { return false }
        return pattern.isEmpty || pattern.lowercased() == net.lowercased()
    }

    public static func expandHome(_ p: String, home: String) -> String {
        p == "~" ? home : p.hasPrefix("~/") ? home + p.dropFirst() : p
    }

    static func trimSlashes(_ s: String) -> String {
        var t = s
        while t.count > 1 && t.hasSuffix("/") { t.removeLast() }
        return t
    }

    /// Does `event` fire `trigger`? Returns the input passed to the target (file path, app name, …) or nil.
    public static func match(_ trigger: AutomationTrigger, _ event: AutomationEvent, automationId: String, home: String = NSHomeDirectory()) -> String? {
        switch (trigger, event) {
        case let (.app(te, app), .app(ee, name, bid)):
            return te == ee && sameApp(app, name, bid) ? name : nil
        case let (.wifi(te, network), .wifi(from, to)):
            if from == to { return nil }
            if te == "changed" { return to ?? "" }
            if te == "joined" { return sameNetwork(network, to) ? to : nil }
            return sameNetwork(network, from) ? (from ?? "") : nil
        case let (.power(te, threshold), .power(source, pct, prevSource, prevPct)):
            let p = String(pct)
            switch te {
            case "ac": return source == "ac" && prevSource != "ac" ? p : nil
            case "battery": return source == "battery" && prevSource != "battery" ? p : nil
            // Crossing a threshold, not merely being past it, so it fires once per crossing.
            case "below": return source == "battery" && pct <= threshold && (prevPct > threshold || prevSource != "battery") ? p : nil
            default: return pct >= threshold && prevPct < threshold ? p : nil
            }
        case let (.display(te), .display(ee, name)):
            return te == "any" || te == ee ? name : nil
        case let (.folder(path, te), .folder(epath, ee, file)):
            guard trimSlashes(expandHome(path, home: home)) == trimSlashes(epath) else { return nil }
            if te == "added" && ee != "added" { return nil }
            return file
        case (.launch, .launch): return ""
        case let (.hotkey, .hotkey(aid)): return aid == automationId ? "" : nil
        default: return nil
        }
    }

    // MARK: schedule (local time, DST-safe via Calendar)

    /// First moment strictly after `after` (ms) matching HH:MM on one of `days` (empty = every day).
    public static func nextTimeOfDay(_ time: String, days: [Int], after: Double, calendar: Calendar = .current) -> Double {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return .infinity }
        let base = Date(timeIntervalSince1970: after / 1000)
        let startOfDay = calendar.startOfDay(for: base)
        for i in 0...8 {
            guard let day = calendar.date(byAdding: .day, value: i, to: startOfDay),
                  let d = calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: day) else { continue }
            let ms = d.timeIntervalSince1970 * 1000
            if ms <= after { continue }
            if !days.isEmpty && !days.contains(calendar.component(.weekday, from: d) - 1) { continue }
            return ms
        }
        return .infinity
    }

    /// Next fire time for a scheduled trigger, or nil for event triggers.
    public static func nextFire(_ t: AutomationTrigger, since: Double, calendar: Calendar = .current) -> Double? {
        switch t {
        case let .time(time, days): return nextTimeOfDay(time, days: days, after: since, calendar: calendar)
        case let .interval(m): return since + Double(m) * 60_000
        default: return nil
        }
    }

    public enum Due: Sendable, Equatable { case wait, fire, missed }

    /// "missed" when noticed more than `grace` late (the Mac slept through it): never replays stale runs.
    public static func due(_ nextAt: Double, now: Double, graceMs: Double) -> Due {
        if now < nextAt { return .wait }
        return now - nextAt <= graceMs ? .fire : .missed
    }
}
