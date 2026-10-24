import AppKit
import GlideCore
import GlideUI
import Observation
import SwiftUI

/// Automations (feature id "automations"): run a workflow or command when something happens.
/// Data: <userData>/features/automations/automations.json (`{version: 1, automations: [...]}`, Electron format).
@MainActor public final class AutomationsFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "automations"
    public let title = "Automations"
    static let fileName = "automations.json"
    static let confirmTimeout: Duration = .seconds(300)
    static let launchDelay: Duration = .seconds(3)

    weak var context: FeatureContext?
    private(set) var engine: AutomationEngine?
    var sources: AutomationEventSources?
    private(set) var problems: [String: String] = [:]
    private var ticker: Timer?
    private var saveTask: Task<Void, Never>?
    private var lastCatalogueKey = ""
    private var fileURL: URL?
    let ui = AutomationsUIModel()
    /// Inject for tests: sources and the clock.
    var makeSources: ((FeatureContext) -> AutomationEventSources)?
    var clock: () -> Double = { Date().timeIntervalSince1970 * 1000 }
    var autoTick = true

    public struct Pending: Identifiable, Sendable {
        public var id: String
        public var automationId: String
        public var name: String
        public var reason: String
        public var input: String
        public var at: Double
        public var expiresAt: Double
        var json: JSONValue {
            ["id": .string(id), "automationId": .string(automationId), "name": .string(name), "reason": .string(reason), "input": .string(input), "at": .double(at), "expiresAt": .double(expiresAt)]
        }
    }
    private(set) var pending: [Pending] = []
    private var pendingResolvers: [String: CheckedContinuation<Bool, Never>] = [:]

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        let dir = context.dataDirectory()
        fileURL = dir.appendingPathComponent(Self.fileName)
        let home = NSHomeDirectory()
        let register: (String, String?, @escaping @MainActor () -> Void) -> Bool = { [weak context] key, accel, handler in
            context?.registerHotkey(key: key, accelerator: accel, handler: handler) ?? false
        }
        let src = makeSources?(context) ?? (context.services.isHeadless
            ? HeadlessAutomationSources(home: home, registerHotkey: register)
            : LiveAutomationSources(home: home, wifiInfo: { [weak context] in context?.services.wifi.info() ?? .null }, registerHotkey: register))
        sources = src
        var deps = AutomationEngineDeps(now: { [weak self] in self?.clock() ?? 0 },
                                        run: { [weak self] a, input in await self?.runTarget(a, input) ?? AutomationRunOutcome(ok: false, message: "Glide is shutting down") },
                                        confirm: { [weak self] a, input, reason in await self?.confirm(a, input, reason) ?? false },
                                        persist: { _ in })
        deps.changed = { [weak self] list in self?.onChanged(list) }
        deps.home = home
        engine = AutomationEngine(deps: deps, initial: Self.load(fileURL))
        src.emit = { [weak self] e in self?.handle(e) }
        problems = src.sync(engine?.list ?? [])
        if autoTick {
            ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tickNow() }
            }
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.launchDelay)
            self?.handle(.launch)
        }
    }

    public func stop() async {
        ticker?.invalidate()
        ticker = nil
        sources?.stop()
        for p in pending { settle(p.id, run: false) }
        flush()
    }

    // MARK: persistence

    static func load(_ url: URL?) -> [Automation] {
        guard let url, let data = try? Data(contentsOf: url), let raw = try? JSONDecoder().decode(JSONValue.self, from: data),
              let list = raw["automations"]?.arrayValue else { return [] }
        let now = Date().timeIntervalSince1970 * 1000
        var seen = Set<String>()
        var out: [Automation] = []
        for e in list {
            if case let .ok(a) = AutomationModel.validate(e, now: now), seen.insert(a.id).inserted { out.append(a) }
        }
        return out
    }

    func flush() {
        saveTask?.cancel()
        saveTask = nil
        guard let url = fileURL, let list = engine?.list else { return }
        let doc: JSONValue = ["version": 1, "automations": .array(list.map(\.json))]
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder.glide.encode(doc).write(to: url, options: .atomic)
        } catch { context?.log("could not save automations: \(error)") }
    }

    private func scheduleSave() {
        guard saveTask == nil else { return }
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            self?.saveTask = nil
            self?.flush()
        }
    }

    private func onChanged(_ list: [Automation]) {
        scheduleSave()
        problems = sources?.sync(list) ?? [:]
        let key = list.map { "\($0.id)|\($0.name)|\($0.enabled)|\($0.trigger)|\($0.log.first?.id ?? "")" }.joined(separator: ";")
        if key != lastCatalogueKey {
            lastCatalogueKey = key
            context?.refreshCatalogue()
        }
        ui.generation += 1
    }

    // MARK: running

    func tickNow() {
        guard let engine else { return }
        Task { @MainActor [weak self] in self?.notifyFailures(await engine.tick()) }
    }

    func handle(_ e: AutomationEvent) {
        guard let engine else { return }
        Task { @MainActor [weak self] in self?.notifyFailures(await engine.handle(e)) }
    }

    var workflows: [Workflow] { context?.store.data.workflows ?? [] }

    func runTarget(_ a: Automation, _ input: String) async -> AutomationRunOutcome {
        guard let ctx = context else { return AutomationRunOutcome(ok: false, message: "Glide is shutting down") }
        switch a.target {
        case let .workflow(wid):
            guard workflows.contains(where: { $0.id == wid }) else { return AutomationRunOutcome(ok: false, message: "The workflow no longer exists") }
            do {
                let r = try await ctx.callFeature("workflows", method: "run", args: ["workflowId": .string(wid), "input": .string(input), "source": "automation"])
                if r["ok"]?.boolValue != true {
                    let err = r["log"]?.arrayValue?.first { $0["status"]?.stringValue == "error" }?["error"]?.stringValue
                    return AutomationRunOutcome(ok: false, message: err ?? "The workflow failed")
                }
                let result = (r["result"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let n = r["log"]?.arrayValue?.count ?? 0
                return AutomationRunOutcome(ok: true, message: result.isEmpty ? "Finished (\(n) action\(n == 1 ? "" : "s"))" : "Finished · \(result.count > 120 ? String(result.prefix(120)) + "…" : result)")
            } catch {
                return AutomationRunOutcome(ok: false, message: error.localizedDescription)
            }
        case let .command(itemId, title, argument):
            let arg = argument.replacingOccurrences(of: "{{input}}", with: input).replacingOccurrences(of: "{{ input }}", with: input)
            guard ctx.findItem(id: itemId) != nil else { return AutomationRunOutcome(ok: false, message: "“\(title)” is no longer available") }
            switch await ctx.executeItem(id: itemId, argument: arg.isEmpty ? nil : arg) {
            case let .error(m): return AutomationRunOutcome(ok: false, message: m)
            case let .hide(m), let .stay(m): return AutomationRunOutcome(ok: true, message: m ?? "Done")
            default: return AutomationRunOutcome(ok: true, message: "Done")
            }
        }
    }

    /// "Ask before running": a pending request (launcher view + Settings) and a notification. Unanswered = skipped.
    func confirm(_ a: Automation, _ input: String, _ reason: String) async -> Bool {
        let now = clock()
        let pid = AutomationModel.newId("p", now)
        let p = Pending(id: pid, automationId: a.id, name: a.name, reason: reason, input: input, at: now, expiresAt: now + 300_000)
        return await withCheckedContinuation { cont in
            pending.append(p)
            pendingResolvers[pid] = cont
            ui.generation += 1
            context?.refreshCatalogue()
            context?.services.notifications.notify(title: "Run “\(a.name)”?", body: "\(reason)\(input.isEmpty ? "" : "\n\(input)")\nOpen Automations in Glide to run or skip.")
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.confirmTimeout)
                self?.settle(pid, run: false)
            }
        }
    }

    @discardableResult
    func settle(_ pid: String, run: Bool) -> Bool {
        guard let cont = pendingResolvers.removeValue(forKey: pid) else { return false }
        pending.removeAll { $0.id == pid }
        ui.generation += 1
        context?.refreshCatalogue()
        cont.resume(returning: run)
        return true
    }

    /// Unattended runs that fail get a notification (Run Now failures show as a toast instead).
    func notifyFailures(_ results: [AutomationFireResult]) {
        for r in results {
            guard case let .record(rec) = r, rec.status == "error", rec.manual != true,
                  let a = engine?.list.first(where: { $0.log.contains { $0.id == rec.id } }) else { continue }
            context?.services.notifications.notify(title: "Automation “\(a.name)” failed", body: rec.message)
            GlideFeatureEvents.post(GlideFeatureEvents.automationFailed, ["name": a.name]) // phone-notify
        }
    }

    // MARK: API (methods, Settings UI)

    func save(_ raw: JSONValue) -> AutomationModel.Validation {
        guard let engine else { return .error("Automations are not ready") }
        var r = raw.objectValue ?? [:]
        // New automations default to "ask before running" when the target can change things outside Glide.
        if r["askBeforeRunning"] == nil || r["askBeforeRunning"]?.isNull == true {
            r["askBeforeRunning"] = .bool(AutomationModel.normalizeTarget(r["target"]).map { AutomationModel.isRisky($0, workflows: workflows) } ?? true)
        }
        return engine.upsert(.object(r))
    }

    func resultMessage(_ a: Automation?, _ r: AutomationFireResult) -> JSONValue {
        switch r {
        case .missing: return ["ok": false, "error": "That automation no longer exists"]
        case .busy: return ["ok": false, "error": .string("“\(a?.name ?? "")” is already running")]
        case let .record(rec):
            return rec.status == "ok" ? ["ok": true, "message": .string("“\(a?.name ?? "")”: \(rec.message)")] : ["ok": false, "error": .string("“\(a?.name ?? "")”: \(rec.message)")]
        default: return ["ok": false, "error": .string("Not run (\(r.json.description))")]
        }
    }

    func runNow(_ id: String) async -> JSONValue {
        guard let engine else { return ["ok": false, "error": "Automations are not ready"] }
        let a = engine.get(id)
        return resultMessage(a, await engine.runNow(id))
    }

    func setEnabled(_ id: String, _ enabled: Bool) -> JSONValue {
        guard let a = engine?.setEnabled(id, enabled) else { return ["ok": false, "error": "That automation no longer exists"] }
        return ["ok": true, "message": .string("“\(a.name)” \(enabled ? "enabled" : "disabled")")]
    }

    func remove(_ id: String) -> JSONValue {
        engine?.remove(id) == true ? ["ok": true, "message": "Automation deleted"] : ["ok": false, "error": "That automation no longer exists"]
    }

    func triggerText(_ a: Automation) -> String { AutomationModel.describe(a.trigger) }
    func targetText(_ a: Automation) -> String { AutomationModel.describe(a.target, workflows: workflows) }

    func state() -> JSONValue {
        let wfs = workflows
        let list: [JSONValue] = (engine?.list ?? []).map { a in
            var o = a.json.objectValue ?? [:]
            o["nextRun"] = engine?.nextRun(a.id).flatMap { $0.isFinite ? JSONValue.double($0) : nil } ?? .null
            o["running"] = .bool(engine?.isRunning(a.id) ?? false)
            if let p = problems[a.id] { o["problem"] = .string(p) }
            o["triggerText"] = .string(triggerText(a))
            o["targetText"] = .string(targetText(a))
            return .object(o)
        }
        return ["automations": .array(list), "pending": .array(pending.map(\.json)),
                "workflows": .array(wfs.map { ["id": .string($0.id), "name": .string($0.name.isEmpty ? "Untitled" : $0.name), "risky": .bool(AutomationModel.isRisky(.workflow(workflowId: $0.id), workflows: wfs))] }),
                "sources": .array((sources?.active() ?? []).map(JSONValue.string)), "now": .double(clock())]
    }

    static func arg(_ args: JSONValue, _ key: String, _ index: Int = 0) -> JSONValue? {
        if let v = args[key] { return v }
        if let a = args.arrayValue, index < a.count { return a[index] }
        if index == 0, args.stringValue != nil { return args }
        return nil
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        let idArg = Self.arg(args, "id")?.stringValue ?? ""
        switch method {
        case "state": return state()
        case "save":
            switch save(args["automation"] ?? args) {
            case let .ok(a): return ["ok": true, "automation": a.json]
            case let .error(e): return ["ok": false, "error": .string(e)]
            }
        case "remove": return remove(idArg)
        case "setEnabled": return setEnabled(idArg, Self.arg(args, "enabled", 1)?.boolValue == true)
        case "runNow": return await runNow(idArg)
        case "clearLog":
            engine?.clearLog(idArg)
            return ["ok": true, "message": "Log cleared"]
        case "answer":
            let pid = Self.arg(args, "pendingId")?.stringValue ?? idArg
            let run = Self.arg(args, "run", 1)?.boolValue == true
            return settle(pid, run: run) ? ["ok": true, "message": .string(run ? "Running…" : "Skipped")] : ["ok": false, "error": "That request has expired"]
        case "currentNetwork": return sources?.currentNetwork().map(JSONValue.string) ?? .null
        case "debugEvent":
            // Feed a synthetic trigger event (headless, or GLIDE_AUTOMATIONS_DEBUG=1 like the Electron hook).
            guard context?.services.isHeadless == true || ProcessInfo.processInfo.environment["GLIDE_AUTOMATIONS_DEBUG"] == "1" else { return ["ok": false, "error": "debug hooks are off"] }
            guard let engine, let e = AutomationEvent(json: args["event"] ?? args) else { return ["ok": false, "error": "invalid event"] }
            let results = await engine.handle(e)
            notifyFailures(results)
            return ["ok": true, "results": .array(results.map(\.json))]
        case "tick":
            guard context?.services.isHeadless == true, let engine else { return ["ok": false, "error": "headless only"] }
            return ["ok": true, "results": .array(await engine.tick().map(\.json))]
        case "flush":
            flush()
            return true
        case "snapshotSettings":
            let path = args["path"]?.stringValue ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-automations.png").path
            ui.selection = args["select"]?.stringValue ?? ui.selection ?? engine?.list.first?.id
            let size = try WorkflowSnapshots.render(AnyView(AutomationsSettingsView(feature: self, ui: ui).frame(width: 980, height: 680)), size: NSSize(width: 980, height: 680),
                                                    dark: args["dark"]?.boolValue ?? true, to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .int(Int64(size.width)), "height": .int(Int64(size.height))]
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    // MARK: catalogue

    func item(_ suffix: String, _ title: String, _ subtitle: String, _ symbol: String, _ keywords: [String], _ data: [String: JSONValue]) -> SearchItem {
        var it = SearchItem(id: "automations:\(suffix)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol), keywords: keywords, source: "automations", feature: id)
        it.kindLabel = "Automation"
        it.data = data
        return it
    }

    static func lastRunText(_ a: Automation) -> String {
        guard let r = a.log.first else { return "never run" }
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMdjmm")
        return "last \(r.status == "ok" ? "ran" : r.status == "skipped" ? "skipped" : "failed") \(f.string(from: Date(timeIntervalSince1970: r.at / 1000)))"
    }

    public func items() -> [SearchItem] {
        let list = engine?.list ?? []
        let on = list.filter(\.enabled).count
        var out = [
            item("create", "Create Automation", "Run a workflow or command when something happens", "sparkles", ["automation", "trigger", "schedule", "when", "personal automation", "new", "cron"], ["action": "create"]),
            item("list", "Automations", list.isEmpty ? "Event-triggered workflows" : "\(list.count) automation\(list.count == 1 ? "" : "s") · \(on) on",
                 "bolt.fill", ["automation", "automations", "triggers", "schedule", "cron", "rules"], ["action": "list"]),
        ]
        for p in pending {
            out.append(item("p:\(p.id)", "Run “\(p.name)”?", "\(p.reason) · waiting for you", "questionmark.circle.fill", ["automation", "confirm", "pending"], ["action": "pending", "pendingId": .string(p.id)]))
        }
        out += list.map { a in
            item("a:\(a.id)", a.name, "\(triggerText(a)) · \(a.enabled ? "on" : "off") · \(Self.lastRunText(a))", a.enabled ? "bolt.fill" : "bolt.slash", ["automation", "run", "enable", "disable"],
                 ["action": "automation", "automationId": .string(a.id)])
        }
        return out
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "create": return [ItemAction(id: "create", title: "Create Automation", shortcut: "↩", icon: "plus"), ItemAction(id: "list", title: "Show Automations", shortcut: "⌘↩", icon: "list.bullet")]
        case "list": return [ItemAction(id: "list", title: "Show Automations", shortcut: "↩", icon: "list.bullet"), ItemAction(id: "create", title: "Create Automation", shortcut: "⌘↩", icon: "plus")]
        case "pending": return [ItemAction(id: "confirm", title: "Run", shortcut: "↩", icon: "play.fill"), ItemAction(id: "skip", title: "Skip", shortcut: "⌘↩", icon: "forward")]
        case "automation":
            let a = engine?.get(item.data?["automationId"]?.stringValue ?? "")
            return [ItemAction(id: "run", title: "Run Now", shortcut: "↩", icon: "play.fill"),
                    ItemAction(id: "toggle", title: a?.enabled == false ? "Enable Automation" : "Disable Automation", shortcut: "⌘↩", icon: a?.enabled == false ? "bolt" : "bolt.slash"),
                    ItemAction(id: "edit", title: "Edit Automation", shortcut: "⌘E", icon: "pencil"),
                    ItemAction(id: "show", title: "Show Run Log", shortcut: "⌘L", icon: "list.bullet.rectangle"),
                    ItemAction(id: "delete", title: "Delete Automation", shortcut: "⌃X", icon: "trash", destructive: true)]
        default: return []
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let aid = scored.item.data?["automationId"]?.stringValue ?? ""
        let pid = scored.item.data?["pendingId"]?.stringValue ?? ""
        switch action {
        case "create":
            ui.requested = "new"
            return .openSettings(page: "automations#new")
        case "list": return .pushView(ViewID(feature: id, name: "list"), payload: .null)
        case "confirm": return settle(pid, run: true) ? .stay(message: "Running…") : .error("That request has expired")
        case "skip": return settle(pid, run: false) ? .stay(message: "Skipped") : .error("That request has expired")
        case "run": return actionResult(await runNow(aid))
        case "toggle":
            guard let a = engine?.get(aid) else { return .error("That automation no longer exists") }
            return actionResult(setEnabled(aid, !a.enabled))
        case "edit":
            ui.requested = aid
            return .openSettings(page: "automations#\(aid)")
        case "show":
            ui.launcherSelection = aid
            return .pushView(ViewID(feature: id, name: "list"), payload: ["select": .string(aid)])
        case "delete": return actionResult(remove(aid))
        default: return .error("Unknown action \(action)")
        }
    }

    func actionResult(_ r: JSONValue) -> ActionResult {
        r["ok"]?.boolValue == true ? .stay(message: r["message"]?.stringValue) : .error(r["error"]?.stringValue ?? "Failed")
    }

    // MARK: UI

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Automations", symbol: "bolt.badge.clock", order: 32, onRoute: { [weak self] r in self?.ui.requested = r }) { [weak self] in
            guard let self else { return AnyView(EmptyView()) }
            if let r = self.ui.requested {
                self.ui.requested = nil
                if r == "new" { self.ui.beginNew() } else { self.ui.selection = r }
            }
            return AnyView(AutomationsSettingsView(feature: self, ui: self.ui))
        }
    }

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard vid.name == "list" else { return nil }
        host.setPlaceholder("Filter automations…")
        host.setFooter(primary: "Run Now", hasActions: false)
        if let s = payload["select"]?.stringValue { ui.launcherSelection = s }
        return AnyView(AutomationsLauncherView(feature: self, ui: ui, filter: host.query))
    }

    /// Rows of the launcher list: pending confirmations first, then automations matching the filter.
    func launcherRows(filter: String) -> [AutomationsLauncherRow] {
        let f = filter.trimmingCharacters(in: .whitespaces)
        var rows = pending.map { AutomationsLauncherRow.pending($0) }
        rows += (engine?.list ?? []).filter { f.isEmpty || $0.name.localizedCaseInsensitiveContains(f) || triggerText($0).localizedCaseInsensitiveContains(f) }.map { .automation($0) }
        return rows
    }

    private var launcherQuery: String { LauncherHosts.current?.query ?? "" }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        guard view.name == "list" else { return false }
        let rows = launcherRows(filter: launcherQuery)
        let idx = rows.firstIndex { $0.id == ui.launcherSelection } ?? 0
        func select(_ i: Int) { if !rows.isEmpty { ui.launcherSelection = rows[max(0, min(rows.count - 1, i))].id } }
        switch command {
        case let .move(d): select(idx + d); return true
        case let .goto(t):
            if case let .index(i) = t { select(i) } else { select(rows.count - 1) }
            return true
        case let .halfPage(dir, count): select(idx + dir * 5 * max(1, count)); return true
        case .activate, .secondary:
            guard idx < rows.count else { return true }
            let secondary = command == .secondary || command == .activate([.command])
            switch rows[idx] {
            case let .pending(p): settle(p.id, run: !secondary)
            case let .automation(a):
                if secondary { _ = setEnabled(a.id, !a.enabled) }
                else { Task { @MainActor in let r = await self.runNow(a.id); LauncherHosts.current?.toast(r["message"]?.stringValue ?? r["error"]?.stringValue ?? "", style: r["ok"]?.boolValue == true ? .success : .error) } }
            }
            return true
        case .delete:
            if idx < rows.count, case let .automation(a) = rows[idx] { _ = remove(a.id) }
            return true
        default: return false
        }
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        guard view.name == "list" else { return false }
        let rows = launcherRows(filter: launcherQuery)
        let sel = rows.first { $0.id == ui.launcherSelection } ?? rows.first
        if key.meta && key.key.lowercased() == "e", case let .automation(a)? = sel {
            ui.requested = a.id
            context?.openSettings(page: "automations#\(a.id)")
            return true
        }
        if key.ctrl && key.key.lowercased() == "x", case let .automation(a)? = sel {
            _ = remove(a.id)
            return true
        }
        return false
    }
}

enum AutomationsLauncherRow: Identifiable {
    case pending(AutomationsFeature.Pending)
    case automation(Automation)
    var id: String {
        switch self {
        case let .pending(p): return "pending:\(p.id)"
        case let .automation(a): return a.id
        }
    }
}

/// Observable UI state shared by the launcher view and the Settings page.
@MainActor @Observable final class AutomationsUIModel {
    var generation = 0
    var selection: String?
    var launcherSelection: String?
    @ObservationIgnored var requested: String?
    /// Draft being edited in Settings (JSON in the Electron shape) and the last validation error.
    var draft: JSONValue?
    var error: String?

    func beginNew() {
        selection = nil
        draft = ["name": "", "enabled": true, "trigger": AutomationModel.defaultTrigger("time").json, "target": ["kind": "workflow", "workflowId": ""]]
        error = nil
    }
}
