import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Timers & stopwatches (src/main/features/timers): "timer 25m tea" in the root search, presets, laps, the
/// soonest timer in the menu bar, a notification (NotificationService → UNUserNotificationCenter; recorded
/// in headless runs) and a system sound when done. State persists in timers.json across restarts.
@MainActor public final class TimersFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "timers"
    public let title = "Timers"
    private weak var context: FeatureContext?
    public private(set) var data = TimersData()
    var now: N7Now = n7SystemNow
    private var ticker: Timer?
    private var statusShown = false
    static let statusItemId = "timers"
    /// Notifications this run posted (title) — the test channel reads them.
    public private(set) var notified: [String] = []
    lazy var listModel = N7ListModel(placeholder: "Type a duration (25m, 1h30m tea, 5:00) or search timers…", emptyTitle: "No timers match",
                                     emptySubtitle: "Type a duration like 25m to start one") { [weak self] q in self?.listRows(q) ?? [] }

    public init() {}

    var file: URL? { context?.dataDirectory().appendingPathComponent("timers.json") }

    var sound: String {
        let s = context?.settings(defaults: ["sound": "Glass"])["sound"]?.stringValue ?? "Glass"
        return s == "none" || TimersModel.sounds.contains(s) ? s : "Glass"
    }
    var showInMenuBar: Bool { context?.settings(defaults: ["showInMenuBar": true])["showInMenuBar"]?.boolValue != false }

    public func start(context: FeatureContext) async {
        self.context = context
        let loaded = TimersModel.load(file.flatMap(N7JSON.read), now: now())
        data = loaded.data
        for t in loaded.finished { notifyDone(t, whileClosed: true) }
        if !loaded.finished.isEmpty { save() }
        ensureTicking()
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.save() }
        }
    }

    public func stop() async {
        save()
        ticker?.invalidate()
        ticker = nil
    }

    func save() { if let file { N7JSON.write(data, to: file) } }

    func changed() {
        save()
        ensureTicking()
        context?.refreshCatalogue()
        listModel.changed()
    }

    // MARK: ticking / done

    private func ensureTicking() {
        let active = !data.timers.isEmpty || data.stopwatches.contains { $0.pausedAt == nil }
        if active, ticker == nil {
            ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
        } else if !active {
            ticker?.invalidate()
            ticker = nil
        }
        updateStatusItem()
    }

    /// Finish due timers (also callable from tests with a fake clock).
    func tick() {
        let t = now()
        let done = data.timers.filter { TimersModel.isDone($0, now: t) }
        if !done.isEmpty {
            data.timers.removeAll { d in done.contains { $0.id == d.id } }
            for d in done { notifyDone(d) }
            changed()
            return
        }
        updateStatusItem()
        if LauncherHosts.current != nil { listModel.changed() }
    }

    private func notifyDone(_ t: CountdownTimer, whileClosed: Bool = false) {
        let title = "⏱ \(TimersModel.label(t)) is done"
        let body = whileClosed ? "Finished while Glide was closed (\(TimersModel.formatDuration(t.durationMs)) timer)." : "\(TimersModel.formatDuration(t.durationMs)) timer finished."
        notified.append(title)
        context?.services.notifications.notify(title: title, body: body)
        if !whileClosed { playSound() }
    }

    private func playSound() {
        guard sound != "none", context?.services.isHeadless == false else { return }
        NSSound(named: NSSound.Name(sound))?.play()
    }

    /// The soonest timer through the shared status-item API (`services.statusItems`, item "timers", `.combinable`):
    /// next to Glide's icon with its actions in Glide's menu while "Show timers and focus in Glide's menu bar
    /// icon" is on, its own icon otherwise. When the Menu Bar feature's Timers extra is on it shows the timers
    /// (`StatusTitleRouting.claim`), so the countdown never appears twice.
    private func updateStatusItem() {
        guard let ctx = context else { return }
        let title = showInMenuBar ? TimersModel.trayTitle(data, now: now()) : ""
        let claimed = !title.isEmpty && (StatusTitleRouting.claim?(id, title) ?? false)
        guard !title.isEmpty, !claimed, let spec = statusSpec(title: title) else {
            if statusShown { ctx.services.statusItems.remove(Self.statusItemId) }
            statusShown = false
            return
        }
        statusShown = true
        ctx.services.statusItems.show(Self.statusItemId, spec, placement: .combinable)
    }

    /// Countdown title + the Menu Bar Timers extra's rows (pause / add / stop per timer, presets, Show Timers…).
    func statusSpec(title: String) -> StatusItemSpec? {
        var state = N7JSON.value(data).objectValue ?? [:]
        state["settings"] = ["showInMenuBar": true]
        let actions = TimerActions(
            toggle: { [weak self] tid in self?.updateTimer(tid) { [weak self] in TimersModel.toggle($0, now: self?.now() ?? 0) } },
            add: { [weak self] tid, ms in self?.updateTimer(tid) { TimersModel.addTime($0, ms: ms) } },
            stop: { [weak self] tid in self?.updateTimer(tid) { _ in nil } },
            stopwatchToggle: { [weak self] sid in self?.updateStopwatch(sid) { [weak self] in TimersModel.toggle($0, now: self?.now() ?? 0) } },
            stopwatchRemove: { [weak self] sid in self?.updateStopwatch(sid) { _ in nil } },
            startPreset: { [weak self] pid in
                guard let self, let p = self.data.presets.first(where: { $0.id == pid }) else { return }
                self.startTimer(p.durationMs, p.name)
            },
            show: { [weak self] in self?.context?.push(ViewID(feature: "timers", name: "list"), payload: .null) })
        guard let spec = ExtraSpecs.timers(TimersInput(json: .object(state)), now: now(), actions) else { return nil }
        var out = StatusItemBridge.spec(spec, section: "Timers")
        out.title = title
        return out
    }

    // MARK: operations

    @discardableResult func startTimer(_ ms: Double, _ name: String) -> ActionResult {
        guard ms > 0 else { return .error("Enter a duration such as 25m, 1h30m or 5:00") }
        let t = TimersModel.createTimer(now: now(), durationMs: ms, name: name)
        data.timers.append(t)
        changed()
        return .hide(message: "\(TimersModel.label(t)) started — \(TimersModel.formatClock(ms))")
    }

    @discardableResult func updateTimer(_ id: String, _ fn: (CountdownTimer) -> CountdownTimer?) -> ActionResult {
        guard let i = data.timers.firstIndex(where: { $0.id == id }) else { return .error("That timer is no longer running") }
        let old = data.timers[i]
        if let next = fn(old) {
            data.timers[i] = next
            changed()
            return .stay(message: "\(TimersModel.label(next)): \(TimersModel.formatClock(TimersModel.remaining(next, now: now()))) left\(next.pausedAt != nil ? " (paused)" : "")")
        }
        data.timers.remove(at: i)
        changed()
        return .stay(message: "\(TimersModel.label(old)) stopped")
    }

    @discardableResult func updateStopwatch(_ id: String, _ fn: (Stopwatch) -> Stopwatch?) -> ActionResult {
        guard let i = data.stopwatches.firstIndex(where: { $0.id == id }) else { return .error("That stopwatch no longer exists") }
        if let next = fn(data.stopwatches[i]) {
            data.stopwatches[i] = next
            changed()
            return .stay(message: "\(next.name.isEmpty ? "Stopwatch" : next.name): \(TimersModel.formatClock(TimersModel.elapsed(next, now: now()), roundUp: false))")
        }
        data.stopwatches.remove(at: i)
        changed()
        return .stay(message: "Stopwatch removed")
    }

    @discardableResult func startStopwatch(_ name: String) -> Stopwatch {
        let s = TimersModel.createStopwatch(now: now(), name: name)
        data.stopwatches.append(s)
        changed()
        return s
    }

    @discardableResult func savePreset(_ name: String, _ ms: Double) -> ActionResult {
        guard ms > 0 else { return .error("Invalid duration") }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let p = TimerPreset(id: TimersModel.newId("p", now: now()), name: trimmed.isEmpty ? TimersModel.formatDuration(ms) : trimmed, durationMs: ms)
        data.presets.append(p)
        changed()
        return .stay(message: "Saved preset “\(p.name)”")
    }

    // MARK: catalogue

    private func item(_ action: String, _ title: String, _ subtitle: String, _ symbol: String, _ keywords: [String], argument: Bool = false) -> SearchItem {
        SearchItem(id: "timers:\(action)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol, tint: "#FF9F0A"), keywords: keywords,
                   acceptsArgument: argument ? true : nil, feature: id, data: ["action": .string(action)], kindLabel: "Timer")
    }

    public func items() -> [SearchItem] {
        let n = data.timers.count
        let t = now()
        let running = n > 0 ? "\(n) running · next \(TimersModel.formatClock(data.timers.map { TimersModel.remaining($0, now: t) }.min() ?? 0))" : "Timers & Stopwatches"
        return [item("start", "Start Timer", "Type a duration: 25m, 1h30m, 5:00 · Tab for presets", "timer", ["timer", "countdown", "alarm", "pomodoro", "egg", "tea", "kitchen"], argument: true),
                item("list", "Timers", running, "list.bullet.clipboard", ["timer", "timers", "running", "countdown", "stopwatch", "presets"]),
                item("stopwatch", "Start Stopwatch", "Stopwatch with laps", "stopwatch", ["stopwatch", "lap", "chronometer", "elapsed", "time"], argument: true)]
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        var out: [ScoredItem] = []
        let t = now()
        if let p = TimersModel.parseTimerQuery(query.text) {
            let label = p.name.isEmpty ? TimersModel.formatDuration(p.ms) : "\(TimersModel.formatDuration(p.ms)) · \(p.name)"
            let it = SearchItem(id: "timers:quick:\(query.trimmed.lowercased())", kind: .calculator, title: "Start \(label) Timer",
                                subtitle: "Ends around \(N7Format.time(t + p.ms)) · ⏎ start · ⌘⏎ save as preset", icon: .symbol("timer", tint: "#FF9F0A"), feature: id,
                                data: ["action": "quick", "ms": .double(p.ms), "name": .string(p.name), "noUsage": true], kindLabel: "Timer")
            out.append(ScoredItem(item: it, score: 998, matchScore: 998, matchKind: .exact))
        }
        let q = query.trimmed.lowercased()
        guard q.count >= 2 else { return out }
        func relevant(_ name: String) -> Bool { "timers".hasPrefix(q) || q.hasPrefix("timer") || "stopwatch".hasPrefix(q) || (q.count >= 3 && name.lowercased().contains(q)) }
        for tm in data.timers where relevant(TimersModel.label(tm)) {
            let left = TimersModel.formatClock(TimersModel.remaining(tm, now: t))
            let sub = tm.pausedAt != nil ? "Paused · ⏎ resume · ⌘⏎ +1 min" : "Ends \(N7Format.time(TimersModel.endsAt(tm))) · ⏎ pause · ⌘⏎ +1 min"
            let it = SearchItem(id: "timers:running:\(tm.id)", kind: .command, title: "\(TimersModel.label(tm)) — \(left) left", subtitle: sub,
                                icon: .symbol(tm.pausedAt != nil ? "pause.circle" : "timer", tint: "#FF9F0A"), keywords: ["timer", "running", tm.name], feature: id,
                                data: ["action": "running", "timerId": .string(tm.id), "noUsage": true], kindLabel: "Timer")
            out.append(ScoredItem(item: it, score: 500, matchScore: 500, matchKind: .keyword))
        }
        for s in data.stopwatches where relevant(s.name.isEmpty ? "stopwatch" : s.name) {
            let it = SearchItem(id: "timers:sw:\(s.id)", kind: .command, title: "\(s.name.isEmpty ? "Stopwatch" : s.name) — \(TimersModel.formatClock(TimersModel.elapsed(s, now: t), roundUp: false))",
                                subtitle: "\(s.laps.count) lap\(s.laps.count == 1 ? "" : "s") · ⏎ lap · ⌘⏎ \(s.pausedAt == nil ? "pause" : "resume")",
                                icon: .symbol("stopwatch", tint: "#FF9F0A"), keywords: ["stopwatch", "running", s.name], feature: id,
                                data: ["action": "stopwatch", "stopwatchId": .string(s.id), "noUsage": true], kindLabel: "Timer")
            out.append(ScoredItem(item: it, score: 499, matchScore: 499, matchKind: .keyword))
        }
        return out
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "start": return [.init(id: "start", title: "Start Timer", shortcut: "↩", icon: "play"), .init(id: "list", title: "Show Timers", shortcut: "⌘↩", icon: "list.bullet")]
        case "list": return [.init(id: "list", title: "Show Timers", shortcut: "↩", icon: "list.bullet")]
        case "quick": return [.init(id: "quick", title: "Start Timer", shortcut: "↩", icon: "play"), .init(id: "savePreset", title: "Save as Preset", shortcut: "⌘↩", icon: "bookmark")]
        case "running":
            return [.init(id: "toggle", title: "Pause / Resume", shortcut: "↩", icon: "playpause"), .init(id: "plus1", title: "Add 1 Minute", shortcut: "⌘↩", icon: "plus"),
                    .init(id: "plus5", title: "Add 5 Minutes", icon: "goforward.5"), .init(id: "restart", title: "Restart", icon: "arrow.counterclockwise"),
                    .init(id: "list", title: "Show Timers", shortcut: "⌘T", icon: "list.bullet"), .init(id: "stop", title: "Stop Timer", shortcut: "⌃X", icon: "stop", destructive: true)]
        case "stopwatch":
            if item.data?["stopwatchId"] != nil {
                return [.init(id: "lap", title: "Lap", shortcut: "↩", icon: "flag"), .init(id: "swToggle", title: "Pause / Resume", shortcut: "⌘↩", icon: "playpause"),
                        .init(id: "swReset", title: "Reset", icon: "arrow.counterclockwise"), .init(id: "list", title: "Show Timers", shortcut: "⌘T", icon: "list.bullet"),
                        .init(id: "swStop", title: "Remove Stopwatch", shortcut: "⌃X", icon: "trash", destructive: true)]
            }
            return [.init(id: "stopwatch", title: "Start Stopwatch", shortcut: "↩", icon: "stopwatch"), .init(id: "list", title: "Show Timers", shortcut: "⌘↩", icon: "list.bullet")]
        default: return []
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let d = scored.item.data ?? [:]
        let arg = (scored.argument ?? "").trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^timer\s+"#, with: "", options: [.regularExpression, .caseInsensitive])
        let timerId = d["timerId"]?.stringValue ?? "", swId = d["stopwatchId"]?.stringValue ?? ""
        let t = now()
        switch action {
        case "start":
            if !arg.isEmpty, let p = TimersModel.parseDurationAndName(arg) { return startTimer(p.ms, p.name) }
            return openList(query: arg)
        case "list": return openList(query: "")
        case "stopwatch":
            let s = startStopwatch(arg)
            n7AfterUpdate { [weak self] in self?.listModel.select(id: s.id) }
            return .pushView(ViewID(feature: id, name: "list"))
        case "quick": return startTimer(d["ms"]?.number ?? 0, d["name"]?.stringValue ?? "")
        case "savePreset": return savePreset(d["name"]?.stringValue ?? "", d["ms"]?.number ?? 0)
        case "toggle": return updateTimer(timerId) { TimersModel.toggle($0, now: t) }
        case "plus1": return updateTimer(timerId) { TimersModel.addTime($0, ms: 60_000) }
        case "plus5": return updateTimer(timerId) { TimersModel.addTime($0, ms: 300_000) }
        case "restart": return updateTimer(timerId) { TimersModel.restart($0, now: t) }
        case "stop": return updateTimer(timerId) { _ in nil }
        case "lap": return updateStopwatch(swId) { TimersModel.lap($0, now: t) }
        case "swToggle": return updateStopwatch(swId) { TimersModel.toggle($0, now: t) }
        case "swReset": return updateStopwatch(swId) { TimersModel.reset($0, now: t) }
        case "swStop": return updateStopwatch(swId) { _ in nil }
        default: return .error("Unknown action \(action)")
        }
    }

    private func openList(query: String) -> ActionResult {
        // The host cannot pre-fill the search text, so an unparsable argument just opens the list.
        n7AfterUpdate { [weak self] in self?.listModel.syncHost() }
        return .pushView(ViewID(feature: id, name: "list"))
    }

    // MARK: list view

    private func say(_ r: ActionResult) {
        switch r {
        case let .stay(m), let .hide(m): if let m { LauncherHosts.current?.toast(m, style: .info) }
        case let .error(m): LauncherHosts.current?.toast(m, style: .error)
        default: break
        }
    }

    func listRows(_ query: String) -> [N7Row] {
        let t = now()
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let parsed = TimersModel.parseDurationAndName(query)
        func match(_ s: String) -> Bool { q.isEmpty || parsed != nil || s.lowercased().contains(q) }
        var out: [N7Row] = []
        if let p = parsed {
            out.append(N7Row(id: "new", section: "Start", icon: .symbol("play.circle.fill", tint: "#30D158"), title: "Start \(TimersModel.formatDuration(p.ms)) Timer\(p.name.isEmpty ? "" : " “\(p.name)”")",
                             subtitle: "Ends around \(N7Format.time(t + p.ms))", trailing: "⏎ start · ⌘⏎ save preset", actions: [
                                 N7Action("start", "Start Timer", shortcut: "↩", icon: "play") { [weak self] in
                                     guard let self else { return }
                                     self.say(self.startTimer(p.ms, p.name))
                                 },
                                 N7Action("preset", "Save as Preset", shortcut: "⌘↩", icon: "bookmark") { [weak self] in
                                     guard let self else { return }
                                     self.say(self.savePreset(p.name, p.ms))
                                 },
                             ]))
        }
        for tm in data.timers where match(TimersModel.label(tm)) {
            let left = TimersModel.remaining(tm, now: t)
            let paused = tm.pausedAt != nil
            out.append(N7Row(id: tm.id, section: "Running Timers", icon: .symbol(paused ? "pause.circle" : "timer", tint: "#FF9F0A"), title: TimersModel.label(tm),
                             subtitle: "\(paused ? "Paused" : "Ends \(N7Format.time(TimersModel.endsAt(tm)))") · \(TimersModel.formatDuration(tm.durationMs))",
                             clock: TimersModel.formatClock(left), progress: tm.durationMs > 0 ? 1 - left / tm.durationMs : 0, actions: [
                                 N7Action("toggle", paused ? "Resume" : "Pause", shortcut: "↩", icon: paused ? "play" : "pause") { [weak self] in
                                     guard let self else { return }
                                     self.say(self.updateTimer(tm.id) { TimersModel.toggle($0, now: self.now()) })
                                 },
                                 N7Action("plus1", "Add 1 Minute", shortcut: "⌘↩", icon: "plus") { [weak self] in self?.say(self?.updateTimer(tm.id) { TimersModel.addTime($0, ms: 60_000) } ?? .stay()) },
                                 N7Action("plus5", "Add 5 Minutes", shortcut: "⌘5", icon: "goforward.5") { [weak self] in self?.say(self?.updateTimer(tm.id) { TimersModel.addTime($0, ms: 300_000) } ?? .stay()) },
                                 N7Action("restart", "Restart", shortcut: "⌘R", icon: "arrow.counterclockwise") { [weak self] in
                                     guard let self else { return }
                                     self.say(self.updateTimer(tm.id) { TimersModel.restart($0, now: self.now()) })
                                 },
                                 N7Action("save", "Save as Preset", shortcut: "⌘S", icon: "bookmark") { [weak self] in self?.say(self?.savePreset(tm.name, tm.durationMs) ?? .stay()) },
                                 N7Action("stop", "Stop Timer", shortcut: "⌃X", icon: "stop", destructive: true) { [weak self] in self?.say(self?.updateTimer(tm.id) { _ in nil } ?? .stay()) },
                             ]))
        }
        for s in data.stopwatches where match(s.name.isEmpty ? "stopwatch" : s.name) {
            let paused = s.pausedAt != nil
            var detail: (@MainActor () -> AnyView)?
            if !s.laps.isEmpty { detail = { AnyView(LapsDetail(stopwatch: s, now: t)) } }
            out.append(N7Row(id: s.id, section: "Stopwatches", icon: .symbol(paused ? "pause.circle" : "stopwatch", tint: "#FF9F0A"), title: s.name.isEmpty ? "Stopwatch" : s.name,
                             subtitle: "\(s.laps.count) lap\(s.laps.count == 1 ? "" : "s") · ⏎ lap · ⌘⏎ \(paused ? "resume" : "pause")",
                             clock: TimersModel.formatStopwatch(TimersModel.elapsed(s, now: t)), actions: [
                                 N7Action("lap", "Lap", shortcut: "↩", icon: "flag") { [weak self] in
                                     guard let self else { return }
                                     self.say(self.updateStopwatch(s.id) { TimersModel.lap($0, now: self.now()) })
                                 },
                                 N7Action("toggle", paused ? "Resume" : "Pause", shortcut: "⌘↩", icon: "playpause") { [weak self] in
                                     guard let self else { return }
                                     self.say(self.updateStopwatch(s.id) { TimersModel.toggle($0, now: self.now()) })
                                 },
                                 N7Action("reset", "Reset", shortcut: "⌘R", icon: "arrow.counterclockwise") { [weak self] in
                                     guard let self else { return }
                                     self.say(self.updateStopwatch(s.id) { TimersModel.reset($0, now: self.now()) })
                                 },
                                 N7Action("copy", "Copy Laps", shortcut: "⇧⌘C", icon: "doc.on.doc") { [weak self] in
                                     guard let self, let cur = self.data.stopwatches.first(where: { $0.id == s.id }) else { return }
                                     self.context?.services.pasteboard.setString(Self.lapsText(cur, now: self.now()), html: nil, transient: false)
                                     LauncherHosts.current?.toast("Laps copied", style: .success)
                                 },
                                 N7Action("remove", "Remove Stopwatch", shortcut: "⌃X", icon: "trash", destructive: true) { [weak self] in self?.say(self?.updateStopwatch(s.id) { _ in nil } ?? .stay()) },
                             ], detail: detail))
        }
        if parsed == nil {
            let name = q.isEmpty || "stopwatch".contains(q) || "new stopwatch".contains(q) ? "" : query.trimmingCharacters(in: .whitespaces)
            out.append(N7Row(id: "new-sw", section: "Stopwatches", icon: .symbol("plus.circle", tint: "#FF9F0A"), title: "Start Stopwatch\(name.isEmpty ? "" : " “\(name)”")",
                             actions: [N7Action("sw", "Start Stopwatch", shortcut: "↩", icon: "stopwatch") { [weak self] in
                                 guard let self else { return }
                                 let sw = self.startStopwatch(name)
                                 self.listModel.select(id: sw.id)
                             }]))
            for p in data.presets where match(p.name) {
                out.append(N7Row(id: "preset-\(p.id)", section: "Presets", icon: .symbol("timer", tint: "#64D2FF"), title: p.name, subtitle: TimersModel.formatDuration(p.durationMs),
                                 trailing: "⏎ start · ⌃X delete", actions: [
                                     N7Action("start", "Start \(TimersModel.formatDuration(p.durationMs)) Timer", shortcut: "↩", icon: "play") { [weak self] in
                                         guard let self else { return }
                                         self.say(self.startTimer(p.durationMs, p.name))
                                     },
                                     N7Action("delete", "Delete Preset", shortcut: "⌃X", icon: "trash", destructive: true) { [weak self] in
                                         self?.data.presets.removeAll { $0.id == p.id }
                                         self?.changed()
                                     },
                                     N7Action("reset", "Restore Default Presets", icon: "arrow.uturn.backward") { [weak self] in
                                         self?.data.presets = TimersModel.defaultPresets
                                         self?.changed()
                                     },
                                 ]))
            }
        }
        return out
    }

    static func lapsText(_ s: Stopwatch, now: Double) -> String {
        let lines = TimersModel.splits(s).enumerated().map { i, ms in "Lap \(i + 1)\t\(TimersModel.formatStopwatch(ms))\t\(TimersModel.formatStopwatch(s.laps[i]))" }
        return (lines + ["Total\t\(TimersModel.formatStopwatch(TimersModel.elapsed(s, now: now)))"]).joined(separator: "\n")
    }

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard id.name == "list" else { return nil }
        n7AfterUpdate { [weak self] in self?.listModel.syncHost() }
        return AnyView(N7ListView(model: listModel))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { view.name == "list" && listModel.handleKey(key) }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { view.name == "list" && listModel.handle(command) }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Timers", symbol: "timer", order: 112) { [weak self] in
            AnyView(TimersSettingsView(sound: self?.sound ?? "Glass", menuBar: self?.showInMenuBar ?? true, onSound: { s in
                self?.context?.setSettings(["sound": .string(s)])
                if s != "none", self?.context?.services.isHeadless == false { NSSound(named: NSSound.Name(s))?.play() }
            }, onMenuBar: { v in
                self?.context?.setSettings(["showInMenuBar": .bool(v)])
                self?.updateStatusItem()
            }))
        }
    }

    // MARK: invoke

    private func resultJSON(_ r: ActionResult) -> JSONValue {
        switch r {
        case let .hide(m), let .stay(m): return ["ok": true, "message": m.map(JSONValue.string) ?? .null]
        case let .error(e): return ["ok": false, "error": .string(e)]
        default: return ["ok": true]
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        let idArg = args["id"]?.stringValue ?? args.stringValue ?? ""
        let ms = args["ms"]?.number ?? args.number ?? 0
        let t = now()
        switch method {
        case "state":
            var o = N7JSON.value(data).objectValue ?? [:]
            o["now"] = .double(t)
            o["settings"] = ["sound": .string(sound), "showInMenuBar": .bool(showInMenuBar)]
            o["sounds"] = .array(TimersModel.sounds.map(JSONValue.string))
            return .object(o)
        case "start": return resultJSON(startTimer(ms, args["name"]?.stringValue ?? ""))
        case "startPreset":
            guard let p = data.presets.first(where: { $0.id == idArg }) else { return resultJSON(.error("Unknown preset")) }
            return resultJSON(startTimer(p.durationMs, p.name))
        case "toggle": return resultJSON(updateTimer(idArg) { TimersModel.toggle($0, now: t) })
        case "add": return resultJSON(updateTimer(idArg) { TimersModel.addTime($0, ms: ms) })
        case "restart": return resultJSON(updateTimer(idArg) { TimersModel.restart($0, now: t) })
        case "stop": return resultJSON(updateTimer(idArg) { _ in nil })
        case "savePreset": return resultJSON(savePreset(args["name"]?.stringValue ?? "", ms))
        case "deletePreset":
            data.presets.removeAll { $0.id == idArg }
            changed()
            return resultJSON(.stay(message: "Preset deleted"))
        case "resetPresets":
            data.presets = TimersModel.defaultPresets
            changed()
            return resultJSON(.stay(message: "Presets restored"))
        case "stopwatchStart": return N7JSON.value(startStopwatch(args["name"]?.stringValue ?? ""))
        case "lap": return resultJSON(updateStopwatch(idArg) { TimersModel.lap($0, now: t) })
        case "stopwatchToggle": return resultJSON(updateStopwatch(idArg) { TimersModel.toggle($0, now: t) })
        case "stopwatchReset": return resultJSON(updateStopwatch(idArg) { TimersModel.reset($0, now: t) })
        case "stopwatchRemove": return resultJSON(updateStopwatch(idArg) { _ in nil })
        case "setSettings":
            var patch: [String: JSONValue] = [:]
            if let s = args["sound"]?.stringValue, s == "none" || TimersModel.sounds.contains(s) { patch["sound"] = .string(s) }
            if let b = args["showInMenuBar"]?.boolValue { patch["showInMenuBar"] = .bool(b) }
            context?.setSettings(patch)
            updateStatusItem()
            return ["sound": .string(sound), "showInMenuBar": .bool(showInMenuBar)]
        case "trayTitle": return .string(showInMenuBar ? TimersModel.trayTitle(data, now: t) : "")
        case "parse":
            guard let p = TimersModel.parseTimerQuery(args["text"]?.stringValue ?? "") else { return .null }
            return ["ms": .double(p.ms), "name": .string(p.name)]
        case "tick":
            tick()
            return .int(Int64(data.timers.count))
        case "notified": return .array(notified.map(JSONValue.string))
        case "viewState": return listModel.snapshot()
        case "viewAction": return .bool(await listModel.run(actionId: args["id"]?.stringValue ?? ""))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

struct LapsDetail: View {
    @Environment(\.glideTheme) private var theme
    let stopwatch: Stopwatch
    let now: Double
    var body: some View {
        let splits = TimersModel.splits(stopwatch)
        let best = splits.min() ?? 0, worst = splits.max() ?? 0
        VStack(alignment: .leading, spacing: 8) {
            Text(TimersModel.formatStopwatch(TimersModel.elapsed(stopwatch, now: now))).font(.system(size: 28, weight: .semibold, design: .monospaced)).foregroundStyle(theme.text)
            ForEach(Array(splits.enumerated().reversed()), id: \.offset) { i, ms in
                HStack {
                    Text("Lap \(i + 1)").foregroundStyle(splits.count > 1 && ms == best ? theme.success : splits.count > 1 && ms == worst ? theme.danger : theme.text)
                    Spacer()
                    Text(TimersModel.formatStopwatch(ms)).font(.system(size: 12, design: .monospaced))
                    Text(TimersModel.formatStopwatch(stopwatch.laps[i])).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text3)
                }.font(.system(size: 12.5))
            }
        }
    }
}

struct TimersSettingsView: View {
    @State var sound: String
    @State var menuBar: Bool
    let onSound: (String) -> Void
    let onMenuBar: (Bool) -> Void
    var body: some View {
        Form {
            Section("When a timer finishes") {
                Picker("Sound", selection: $sound) {
                    Text("None").tag("none")
                    ForEach(TimersModel.sounds, id: \.self) { Text($0).tag($0) }
                }
                .onChange(of: sound) { _, s in onSound(s) }
                N7SettingsNote(text: "A notification is posted too. Timers keep running while Glide is closed and notify on the next launch.")
            }
            Section("Menu bar") {
                Toggle("Show the next timer in the menu bar", isOn: $menuBar).onChange(of: menuBar) { _, v in onMenuBar(v) }
            }
        }
        .formStyle(.grouped)
    }
}
