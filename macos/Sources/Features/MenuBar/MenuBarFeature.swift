import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Menu-bar extras (feature id "menubar", same bag as the Electron app: `{ timers, sysmon, meeting, clipboard,
/// agent }` booleans). Each enabled extra is its own NSStatusItem in the live app; in headless mode only state is
/// kept (`menubar.state` / `menubar.click` over the test channel). Data comes from the owning features through
/// `callFeature` (timers.state, calendar.schedule, clipboard.list, agent.activeRun).
@MainActor public final class MenuBarFeature: Feature, FeatureUI {
    public let id = "menubar"
    public let title = "Menu Bar"
    public let manager = MenuBarManager()
    private weak var context: FeatureContext?
    private var enabled: [ExtraID: Bool] = [:]
    private var timers: [ExtraID: Timer] = [:]
    private var prevTicks: SystemSample.Ticks = []
    private var schedule: ExtraSpecs.Schedule?
    private var meetingTicks = 0
    /// Headless tests only: data injected per source instead of calling the owning feature.
    private var injected: [String: JSONValue] = [:]
    /// Calls made to other features (headless debug: what a menu click did).
    public private(set) var calls: [JSONValue] = []
    var nowOverride: Double?

    public init() {}

    private var now: Double { nowOverride ?? Date().timeIntervalSince1970 * 1000 }
    private var headless: Bool { context?.services.isHeadless ?? true }

    public func start(context: FeatureContext) async {
        self.context = context
        // Headless: never create status items; keep state for tests.
        if context.services.isHeadless {
            manager.activate(nil)
        } else {
            let factory: TrayFactory = { _ in StatusItemTray() }
            manager.activate(factory)
        }
        apply(readSettings())
    }

    public func stop() async {
        StatusTitleRouting.claim = nil
        for e in ExtraID.allCases { stopExtra(e) }
        manager.deactivate()
    }

    // MARK: settings

    static var defaults: [String: JSONValue] {
        var d: [String: JSONValue] = [:]
        for e in ExtraID.allCases { d[e.rawValue] = .bool(e.defaultOn) }
        return d
    }

    func readSettings() -> [ExtraID: Bool] {
        let raw = context?.settings(defaults: Self.defaults) ?? Self.defaults
        var out: [ExtraID: Bool] = [:]
        for e in ExtraID.allCases { out[e] = raw[e.rawValue]?.boolValue ?? e.defaultOn }
        return out
    }

    func apply(_ next: [ExtraID: Bool]) {
        for e in ExtraID.allCases where next[e] != enabled[e] {
            if next[e] == true { startExtra(e) } else { stopExtra(e) }
        }
        enabled = next
        // Integration: the timers countdown (`setStatusTitle` from Timers) shows on the Timers extra when it is on,
        // else next to the Glide icon (Electron `setTrayTitleHandler`).
        StatusTitleRouting.claim = { [weak self] feature, _ in feature == "timers" && self?.enabled[.timers] == true }
        context?.refreshCatalogue()
    }

    public func setEnabled(_ patch: [String: JSONValue]) {
        var clean: [String: JSONValue] = [:]
        for (k, v) in patch { if ExtraID(rawValue: k) != nil, let b = v.boolValue { clean[k] = .bool(b) } }
        context?.setSettings(clean)
        var next = enabled
        for (k, v) in clean { if let e = ExtraID(rawValue: k) { next[e] = v.boolValue } }
        apply(next)
    }

    func settingsState() -> JSONValue {
        ["extras": .array(ExtraID.allCases.map { e in
            ["id": .string(e.rawValue), "title": .string(e.title), "description": .string(e.detail), "icon": .string(e.symbol), "enabled": .bool(enabled[e] == true)]
        })]
    }

    // MARK: data from other features

    private func source(_ feature: String, _ method: String, _ args: JSONValue = .null) async -> JSONValue? {
        if headless, let v = injected["\(feature).\(method)"] { return v }
        guard let c = context else { return nil }
        return try? await c.callFeature(feature, method: method, args: args)
    }

    private func call(_ feature: String, _ method: String, _ args: JSONValue) {
        calls.append(["feature": .string(feature), "method": .string(method), "args": args])
        if calls.count > 100 { calls.removeFirst() }
        guard let c = context else { return }
        Task { @MainActor in
            _ = try? await c.callFeature(feature, method: method, args: args)
            await self.render(.timers)
        }
    }

    private func openView(_ view: String) { context?.push(ViewID(rawValue: view), payload: .null) }

    private var timerActions: TimerActions {
        TimerActions(toggle: { [weak self] in self?.call("timers", "toggle", .string($0)) },
                     add: { [weak self] id, ms in self?.call("timers", "add", ["id": .string(id), "ms": .double(ms)]) },
                     stop: { [weak self] in self?.call("timers", "stop", .string($0)) },
                     stopwatchToggle: { [weak self] in self?.call("timers", "stopwatchToggle", .string($0)) },
                     stopwatchRemove: { [weak self] in self?.call("timers", "stopwatchRemove", .string($0)) },
                     startPreset: { [weak self] in self?.call("timers", "startPreset", .string($0)) },
                     show: { [weak self] in self?.openView("timers.list") })
    }

    // MARK: runtimes

    private func startExtra(_ e: ExtraID) {
        let interval: TimeInterval
        switch e {
        case .timers: interval = 1 // countdown title; menus are diffed so only the title re-renders
        case .sysmon: interval = 2; prevTicks = SystemSample.cpuTicks()
        case .meeting: interval = 30; meetingTicks = 0
        case .clipboard: interval = 3
        case .agent: interval = 2
        }
        Task { @MainActor in
            if e == .meeting { await self.refreshSchedule() }
            await self.render(e)
        }
        timers[e]?.invalidate()
        timers[e] = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                Task { @MainActor in
                    if e == .meeting {
                        self.meetingTicks += 1
                        if self.meetingTicks % 2 == 0 { await self.refreshSchedule() }
                    }
                    await self.render(e)
                }
            }
        }
    }

    private func stopExtra(_ e: ExtraID) {
        timers[e]?.invalidate()
        timers[e] = nil
        manager.show(e.rawValue, nil)
    }

    private func refreshSchedule() async {
        if let r = await source("calendar", "schedule") { schedule = ExtraSpecs.Schedule(json: r) }
    }

    func render(_ e: ExtraID) async {
        guard enabled[e] == true || e == .timers && enabled[.timers] == true else { return }
        let spec: MenuBarItemSpec?
        switch e {
        case .timers:
            spec = await source("timers", "state").flatMap { ExtraSpecs.timers(TimersInput(json: $0), now: now, timerActions) }
        case .sysmon:
            let next = SystemSample.cpuTicks()
            let cpu = SystemSample.cpuUsage(prevTicks, next)
            prevTicks = next
            var sample = SystemSample(cpu: cpu, cores: next.count, load: SystemSample.loadAverage(), memory: SystemSample.memory())
            if headless, let fake = injected["sysmon.sample"] {
                sample = SystemSample(cpu: fake["cpu"]?.doubleValue ?? 0, cores: fake["cores"]?.intValue ?? 8, load: fake["load"]?.arrayValue?.compactMap(\.doubleValue) ?? [0, 0, 0],
                                      memory: fake["totalBytes"]?.doubleValue.map { SystemSample.Memory(totalBytes: $0, usedBytes: fake["usedBytes"]?.doubleValue ?? 0) })
            }
            spec = ExtraSpecs.sysmon(sample) { [weak self] in Task { _ = await self?.context?.executeItem(id: "sysmon:open", argument: nil) } }
        case .meeting:
            spec = ExtraSpecs.meeting(schedule, now: now, ExtraSpecs.MeetingActions(
                join: { [weak self] in self?.call("calendar", "join", .string($0)) },
                openCalendar: { [weak self] ms in self?.call("calendar", "openCalendar", .double(ms)) },
                schedule: { [weak self] in self?.openView("calendar.schedule") },
                // Permission prompts only ever follow this explicit menu click.
                requestAccess: { [weak self] in self?.call("calendar", "requestAccess", .null) },
                refresh: { [weak self] in Task { await self?.refreshSchedule(); await self?.render(.meeting) } }))
        case .clipboard:
            let list = await source("clipboard", "list", ["limit": 10])
            spec = ExtraSpecs.clipboard(list?.arrayValue ?? list?["items"]?.arrayValue ?? [],
                                        paste: { [weak self] in self?.call("clipboard", "paste", .string($0)) },
                                        open: { [weak self] in self?.openView("clipboard.history") })
        case .agent:
            let run = await source("agent", "activeRun")
            spec = ExtraSpecs.agent(run.flatMap { $0.isNull ? nil : $0 },
                                    ask: { [weak self] p in Task { _ = await self?.context?.executeItem(id: "agent:ask", argument: p) } },
                                    cancel: { [weak self] in self?.call("agent", "cancel", .string($0)) })
        }
        guard enabled[e] == true else { return } // turned off while awaiting data
        manager.show(e.rawValue, spec)
    }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        func base(_ id: String, _ title: String, _ subtitle: String, _ symbol: String, _ kw: [String], _ data: [String: JSONValue]) -> SearchItem {
            SearchItem(id: "menubar:\(id)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol), keywords: ["menu bar", "menubar", "status"] + kw,
                       source: "menubar", feature: self.id, data: data, kindLabel: "Menu Bar")
        }
        return [base("settings", "Menu Bar Settings", "Choose which extras appear in the menu bar", "menubar.rectangle", ["extras", "tray"], ["action": "settings"])]
            + ExtraID.allCases.map { e in
                base("toggle:\(e.rawValue)", "\(enabled[e] == true ? "Hide" : "Show") \(e.title) in Menu Bar", e.detail, e.symbol, [e.title.lowercased(), "toggle"],
                     ["action": "toggle", "extra": .string(e.rawValue)])
            }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        if item.data?["action"]?.stringValue == "toggle" {
            return [ItemAction(id: "toggle", title: "Toggle", shortcut: "↩", icon: "menubar.rectangle"), ItemAction(id: "settings", title: "Menu Bar Settings", shortcut: "⌘↩", icon: "gearshape")]
        }
        return [ItemAction(id: "settings", title: "Open Menu Bar Settings", shortcut: "↩", icon: "gearshape")]
    }

    public func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        if action == "settings" { return .openSettings(page: id) }
        if action == "toggle", let e = item.item.data?["extra"]?.stringValue.flatMap(ExtraID.init(rawValue:)) {
            let on = enabled[e] != true
            setEnabled([e.rawValue: .bool(on)])
            return .stay(message: "\(e.title) \(on ? "shown in" : "removed from") the menu bar")
        }
        return .error("Unknown action \(action)")
    }

    // MARK: settings page

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Menu Bar", symbol: "menubar.rectangle", order: 60) { [weak self] in
            AnyView(MenuBarSettingsView(feature: self))
        }
    }

    var enabledMap: [ExtraID: Bool] { enabled }

    // MARK: methods

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "getSettings": return settingsState()
        case "setSettings": setEnabled(args.objectValue ?? [:]); return settingsState()
        // Test hooks (headless only): state, click, inject data, render now.
        case "state" where headless:
            return ["items": manager.state(), "calls": .array(calls)]
        case "click" where headless:
            guard let id = args["id"]?.stringValue, let path = args["path"]?.arrayValue?.compactMap(\.intValue) else { throw FeatureError.invalidArguments("id and path required") }
            let ok = manager.click(id, path: path)
            try? await Task.sleep(for: .milliseconds(20))
            return .bool(ok)
        case "inject" where headless:
            guard let key = args["source"]?.stringValue else { throw FeatureError.invalidArguments("source required") }
            injected[key] = args["data"] ?? .null
            if key == "calendar.schedule" { await refreshSchedule() }
            return true
        case "tick" where headless:
            if let n = args["now"]?.doubleValue { nowOverride = n }
            for e in ExtraID.allCases where enabled[e] == true { await render(e) }
            manager.flush()
            return ["items": manager.state()]
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

struct MenuBarSettingsView: View {
    weak var feature: MenuBarFeature?
    @State private var tick = 0
    var body: some View {
        let map = feature?.enabledMap ?? [:]
        Form {
            Section {
                ForEach(ExtraID.allCases, id: \.self) { e in
                    Toggle(isOn: Binding(get: { map[e] == true }, set: { feature?.setEnabled([e.rawValue: .bool($0)]); tick += 1 })) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.title)
                                Text(e.detail).font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: e.symbol) }
                    }
                }
            } header: { Text("Extras") } footer: {
                Text("Each extra is its own item in the macOS menu bar. Data comes from the matching feature (Timers, Calendar, Clipboard, Agent); polling runs only while an extra is shown.")
            }
        }
        .formStyle(.grouped)
        .id(tick)
    }
}
