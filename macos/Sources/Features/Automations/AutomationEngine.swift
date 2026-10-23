import Foundation
import GlideCore

public struct AutomationRunOutcome: Sendable, Equatable {
    public var ok: Bool
    public var message: String
    public init(ok: Bool, message: String) {
        self.ok = ok
        self.message = message
    }
}

public enum AutomationFireResult: Sendable, Equatable {
    case record(AutomationRunRecord)
    case disabled, rateLimited, busy, missing

    public var json: JSONValue {
        switch self {
        case let .record(r): return r.json
        case .disabled: return "disabled"
        case .rateLimited: return "rate-limited"
        case .busy: return "busy"
        case .missing: return "missing"
        }
    }
}

/// Everything with side effects is injected (clock, runner, confirmation, disk) so tests can fake it.
@MainActor public struct AutomationEngineDeps {
    public var now: () -> Double
    public var run: (Automation, String) async -> AutomationRunOutcome
    /// true = run, false = skip ("ask before running").
    public var confirm: (Automation, String, String) async -> Bool
    public var persist: ([Automation]) -> Void
    public var changed: ([Automation]) -> Void = { _ in }
    public var home: String = NSHomeDirectory()
    public var rateLimitMs: Double = AutomationModel.rateLimitMs
    /// How late a scheduled run may still fire (default 2 min).
    public var lateGraceMs: Double = 120_000
    public var calendar: Calendar = .current

    public init(now: @escaping () -> Double, run: @escaping (Automation, String) async -> AutomationRunOutcome,
                confirm: @escaping (Automation, String, String) async -> Bool, persist: @escaping ([Automation]) -> Void) {
        self.now = now
        self.run = run
        self.confirm = confirm
        self.persist = persist
    }
}

/// Owns the list, schedules time/interval triggers on `tick()`, matches events, enforces the per-automation
/// rate limit, asks for confirmation, runs and logs (src/main/features/automations/engine.ts).
@MainActor public final class AutomationEngine {
    public private(set) var list: [Automation]
    private var nextAt: [String: Double] = [:]
    private var lastTriggerAt: [String: Double] = [:]
    private var running: Set<String> = []
    public var deps: AutomationEngineDeps

    public init(deps: AutomationEngineDeps, initial: [Automation] = []) {
        self.deps = deps
        list = initial
    }

    public func get(_ id: String) -> Automation? { list.first { $0.id == id } }
    public func isRunning(_ id: String) -> Bool { running.contains(id) }

    public func nextRun(_ id: String) -> Double? {
        guard let a = get(id), a.enabled else { return nil }
        return schedule(for: a)
    }

    /// Create or replace (keeps the existing log and createdAt).
    public func upsert(_ raw: JSONValue) -> AutomationModel.Validation {
        let now = deps.now()
        guard case var .ok(a) = AutomationModel.validate(raw, now: now) else { return AutomationModel.validate(raw, now: now) }
        let prev = get(a.id)
        a.createdAt = prev?.createdAt ?? now
        a.updatedAt = now
        a.log = prev?.log ?? []
        if let i = list.firstIndex(where: { $0.id == a.id }) { list[i] = a } else { list.append(a) }
        // A trigger edit or re-enable restarts the schedule from now.
        if prev == nil || prev?.trigger != a.trigger || prev?.enabled != a.enabled { nextAt[a.id] = nil }
        commit()
        return .ok(a)
    }

    @discardableResult
    public func remove(_ id: String) -> Bool {
        let before = list.count
        list.removeAll { $0.id == id }
        nextAt[id] = nil
        lastTriggerAt[id] = nil
        if list.count != before { commit() }
        return list.count != before
    }

    @discardableResult
    public func setEnabled(_ id: String, _ enabled: Bool) -> Automation? {
        guard let i = list.firstIndex(where: { $0.id == id }) else { return nil }
        if list[i].enabled == enabled { return list[i] }
        list[i].enabled = enabled
        list[i].updatedAt = deps.now()
        nextAt[id] = nil
        commit()
        return list[i]
    }

    public func clearLog(_ id: String) {
        guard let i = list.firstIndex(where: { $0.id == id }) else { return }
        list[i].log = []
        commit()
    }

    /// Check schedules; call every second. Returns when the runs it started finish.
    @discardableResult
    public func tick() async -> [AutomationFireResult] {
        let now = deps.now()
        var due: [(String, String)] = []
        for a in list where a.enabled {
            guard let at = schedule(for: a) else { continue }
            let d = AutomationModel.due(at, now: now, graceMs: deps.lateGraceMs)
            if d == .wait { continue }
            // Reschedule from now so a late tick never double-fires the same slot.
            nextAt[a.id] = AutomationModel.nextFire(a.trigger, since: now, calendar: deps.calendar) ?? .infinity
            if d == .fire { due.append((a.id, AutomationModel.describe(a.trigger))) }
        }
        return await fireAll(due.map { ($0.0, "", $0.1) })
    }

    /// Feed an event; fires every matching enabled automation.
    @discardableResult
    public func handle(_ event: AutomationEvent) async -> [AutomationFireResult] {
        var due: [(String, String, String)] = []
        for a in list where a.enabled {
            guard let input = AutomationModel.match(a.trigger, event, automationId: a.id, home: deps.home) else { continue }
            due.append((a.id, input, "\(AutomationModel.describe(a.trigger)) · \(AutomationModel.describe(event))"))
        }
        return await fireAll(due)
    }

    private func fireAll(_ due: [(String, String, String)]) async -> [AutomationFireResult] {
        // Matching automations run concurrently; results keep their order.
        let tasks = due.map { d in Task { @MainActor in await self.fire(d.0, input: d.1, reason: d.2) } }
        var out: [AutomationFireResult] = []
        for t in tasks { out.append(await t.value) }
        return out
    }

    /// Run Now: ignores enabled/ask/rate limit, but never overlaps a run in progress.
    public func runNow(_ id: String, input: String = "") async -> AutomationFireResult {
        await fire(id, input: input, reason: "Run Now", manual: true)
    }

    public func fire(_ id: String, input: String, reason: String, manual: Bool = false) async -> AutomationFireResult {
        guard let a = get(id) else { return .missing }
        if running.contains(id) { return .busy }
        let now = deps.now()
        if !manual {
            if !a.enabled { return .disabled }
            if let last = lastTriggerAt[id], now - last < deps.rateLimitMs { return .rateLimited }
        }
        lastTriggerAt[id] = now
        running.insert(id)
        deps.changed(list)
        defer {
            running.remove(id)
            deps.changed(list)
        }
        if !manual && a.askBeforeRunning {
            let yes = await deps.confirm(a, input, reason)
            if !yes {
                return .record(record(id, at: now, reason: reason, status: "skipped", message: "Skipped — not confirmed", input: input, duration: deps.now() - now, manual: false))
            }
        }
        let started = deps.now()
        let outcome = await deps.run(a, input)
        return .record(record(id, at: started, reason: reason, status: outcome.ok ? "ok" : "error", message: outcome.message, input: input, duration: deps.now() - started, manual: manual))
    }

    private func schedule(for a: Automation) -> Double? {
        if let c = nextAt[a.id] { return c }
        let at = AutomationModel.nextFire(a.trigger, since: deps.now(), calendar: deps.calendar)
        if let at { nextAt[a.id] = at }
        return at
    }

    private func record(_ id: String, at: Double, reason: String, status: String, message: String, input: String, duration: Double, manual: Bool) -> AutomationRunRecord {
        let r = AutomationRunRecord(id: AutomationModel.newId("r", at), at: at, trigger: reason, status: status, message: message,
                                    input: input.isEmpty ? nil : input, durationMs: duration, manual: manual ? true : nil)
        if let i = list.firstIndex(where: { $0.id == id }) {
            list[i].log.insert(r, at: 0)
            if list[i].log.count > AutomationModel.logLimit { list[i].log.removeLast(list[i].log.count - AutomationModel.logLimit) }
        }
        commit()
        return r
    }

    private func commit() {
        deps.persist(list)
        deps.changed(list)
    }
}
