import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Focus sessions (src/main/features/focus): a goal + duration, menu-bar countdown, block list (apps are
/// asked to quit, sites get a reminder), optional Shortcuts for Do Not Disturb, statistics. Same focus.json.
@MainActor public final class FocusFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "focus"
    public let title = "Focus"
    private weak var context: FeatureContext?
    public private(set) var session: FocusSession?
    public private(set) var history: [FocusRecord] = []
    var now: N7Now = n7SystemNow
    private var ticker: Timer?
    private var poll: Timer?
    private var polling = false
    private var statusShown = false
    static let statusItemId = "focus"
    private var lastQuitAttempt: [String: Double] = [:]
    private var snoozed: [String: Double] = [:]
    public private(set) var notified: [String] = []
    static let neverBlock: Set<String> = ["com.apple.finder", "com.apple.loginwindow", "dev.glide.launcher", "com.github.Electron"]
    static let presets = [25, 50, 90]
    static let browsers: [String: Bool] = [ // bundle id → Safari-style AppleScript
        "com.apple.Safari": true, "com.apple.SafariTechnologyPreview": true, "com.google.Chrome": false, "com.google.Chrome.beta": false,
        "com.brave.Browser": false, "com.microsoft.edgemac": false, "company.thebrowser.Browser": false, "com.vivaldi.Vivaldi": false, "com.operasoftware.Opera": false,
    ]

    lazy var startModel = N7ListModel(placeholder: "What do you want to focus on? (e.g. “45m write report”)", emptyTitle: "Focus") { [weak self] q in self?.startRows(q) ?? [] }
    lazy var statsModel = N7ListModel(placeholder: "Focus statistics", emptyTitle: "No sessions yet") { [weak self] _ in self?.statsRows() ?? [] }
    lazy var blockModel = N7ListModel(placeholder: "Type an app name or website to block…", emptyTitle: "Nothing blocked",
                                      emptySubtitle: "Type youtube.com or an app name") { [weak self] q in self?.blockRows(q) ?? [] }

    public init() {
        statsModel.header = { [weak self] in AnyView(FocusStatsHeader(stats: self?.stats ?? FocusStats())) }
    }

    var file: URL? { context?.dataDirectory().appendingPathComponent("focus.json") }

    // MARK: settings

    struct Settings {
        var defaultMinutes: Int
        var blockedApps: [BlockedApp]
        var blockedSites: [String]
        var dndOnShortcut: String
        var dndOffShortcut: String
        var quitBlockedApps: Bool
    }

    var settings: Settings {
        let s = context?.settings(defaults: [:]) ?? [:]
        let dm = s["defaultMinutes"]?.number ?? 25
        return Settings(defaultMinutes: dm > 0 ? Int(dm.rounded()) : 25,
                        blockedApps: (s["blockedApps"]?.arrayValue ?? []).compactMap { N7JSON.decode($0, as: BlockedApp.self) },
                        blockedSites: (s["blockedSites"]?.arrayValue ?? []).compactMap(\.stringValue),
                        dndOnShortcut: s["dndOnShortcut"]?.stringValue ?? "", dndOffShortcut: s["dndOffShortcut"]?.stringValue ?? "",
                        quitBlockedApps: s["quitBlockedApps"]?.boolValue != false)
    }

    func setSettings(_ patch: [String: JSONValue]) {
        var clean: [String: JSONValue] = [:]
        if let m = patch["defaultMinutes"]?.number, m > 0 { clean["defaultMinutes"] = .int(Int64(m.rounded())) }
        if let apps = patch["blockedApps"]?.arrayValue {
            clean["blockedApps"] = .array(apps.compactMap { a -> JSONValue? in
                guard var b = N7JSON.decode(a, as: BlockedApp.self) else { return nil }
                if b.bundleId == nil, let p = b.path { b.bundleId = Bundle(path: p)?.bundleIdentifier }
                return N7JSON.value(b)
            })
        }
        if let sites = patch["blockedSites"]?.arrayValue {
            var seen: [String] = []
            for s in sites.compactMap(\.stringValue).map(FocusMachine.normalizeSite) where !s.isEmpty && !seen.contains(s) { seen.append(s) }
            clean["blockedSites"] = .array(seen.map(JSONValue.string))
        }
        for k in ["dndOnShortcut", "dndOffShortcut"] { if let v = patch[k]?.stringValue { clean[k] = .string(v.trimmingCharacters(in: .whitespaces)) } }
        if let b = patch["quitBlockedApps"]?.boolValue { clean["quitBlockedApps"] = .bool(b) }
        context?.setSettings(clean)
        if var s = session, clean["blockedApps"] != nil || clean["blockedSites"] != nil {
            let st = settings
            s.blockedApps = st.blockedApps
            s.blockedSites = st.blockedSites
            session = s
            save()
        }
        refreshViews()
    }

    // MARK: lifecycle

    public func start(context: FeatureContext) async {
        self.context = context
        if let raw = file.flatMap({ try? Data(contentsOf: $0) }), let f = try? JSONDecoder().decode(FocusFile.self, from: raw) {
            session = f.session
            history = f.history
        }
        if let s = session {
            if FocusMachine.isComplete(s, now: now()) { await stop(completed: true) } else { startTimers() }
        }
    }

    public func stop() async {
        save()
        stopTimers()
    }

    func save() { if let file { N7JSON.write(FocusFile(session: session, history: history), to: file) } }

    var stats: FocusStats { FocusMachine.stats(history, now: now(), current: session) }

    private func refreshViews() {
        startModel.changed()
        statsModel.changed()
        blockModel.changed()
    }

    private func changed() {
        save()
        updateStatusItem()
        context?.refreshCatalogue()
        refreshViews()
    }

    private func notify(_ title: String, _ body: String) {
        notified.append(title)
        context?.services.notifications.notify(title: title, body: body)
    }

    private func startTimers() {
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in Task { @MainActor in await self?.enforce() } }
        updateStatusItem()
    }

    private func stopTimers() {
        ticker?.invalidate()
        poll?.invalidate()
        ticker = nil
        poll = nil
        if statusShown { context?.services.statusItems.remove(Self.statusItemId) }
        statusShown = false
    }

    func tick() {
        guard let s = session else { return }
        if FocusMachine.isComplete(s, now: now()) {
            Task { await stop(completed: true) }
            return
        }
        updateStatusItem()
        if LauncherHosts.current != nil { startModel.changed(); statsModel.changed() }
    }

    var trayTitle: String {
        guard let s = session else { return "" }
        let clock = FocusMachine.formatClock(FocusMachine.remaining(s, now: now()))
        return s.status == "paused" ? "◷ \(clock) ❚❚" : "◷ \(clock)"
    }

    /// The countdown through the shared status-item API (item "focus", `.combinable`): next to Glide's icon with
    /// these rows in Glide's menu while "Show timers and focus in Glide's menu bar icon" is on, its own icon
    /// otherwise. Headless runs record it (never an NSStatusItem).
    private func updateStatusItem() {
        guard let ctx = context else { return }
        guard let spec = statusSpec() else {
            if statusShown { ctx.services.statusItems.remove(Self.statusItemId) }
            statusShown = false
            return
        }
        statusShown = true
        ctx.services.statusItems.show(Self.statusItemId, spec, placement: .combinable)
    }

    /// Title + menu for the running session (nil when there is none). Menu rows carry no ticking text.
    func statusSpec() -> StatusItemSpec? {
        guard let s = session else { return nil }
        return StatusItemSpec(title: trayTitle, tooltip: s.goal.isEmpty ? "Glide Focus" : "Focus: \(s.goal)", menu: [
            .info(s.goal.isEmpty ? "Focus Session" : "Focus: \(s.goal)", "\(FocusMachine.formatDuration(s.durationMs)) session"),
            .separator,
            StatusMenuItem(s.status == "running" ? "Pause" : "Resume", icon: s.status == "running" ? "pause.circle" : "play.circle") { [weak self] in _ = self?.togglePause() },
            StatusMenuItem("Add 5 Minutes", icon: "plus.circle") { [weak self] in _ = self?.extend(5) },
            StatusMenuItem("Stop Session", icon: "stop.circle") { [weak self] in Task { await self?.stop(completed: false) } },
            .separator,
            StatusMenuItem("Focus Statistics…", icon: "chart.bar") { [weak self] in self?.showStats() },
        ], section: "Focus")
    }

    private func showStats() { context?.push(ViewID(feature: id, name: "stats"), payload: .null) }

    // MARK: operations

    @discardableResult func start(goal: String, minutes: Double) async -> ActionResult {
        if session != nil { await stop(completed: false, silent: true) }
        let st = settings
        session = FocusMachine.start(now: now(), goal: goal, minutes: minutes, blockedApps: st.blockedApps, blockedSites: st.blockedSites)
        snoozed = [:]
        startTimers()
        changed()
        if !st.dndOnShortcut.isEmpty, let err = await runShortcut(st.dndOnShortcut) { notify("Focus: Shortcut failed", "“\(st.dndOnShortcut)”: \(err)") }
        return .hide(message: "Focusing for \(FocusMachine.formatDuration(session?.durationMs ?? 0))")
    }

    @discardableResult func stop(completed: Bool, silent: Bool = false) async -> ActionResult {
        guard let s = session else { return .error("No focus session is running") }
        let rec = FocusMachine.finish(s, now: now())
        history = Array((history + [rec]).suffix(1000))
        session = nil
        stopTimers()
        changed()
        if completed { notify("Focus session complete", "\(FocusMachine.formatDuration(rec.focusedMs)) of focus\(rec.goal.isEmpty ? "" : " on “\(rec.goal)”"). Take a break!") }
        let off = settings.dndOffShortcut
        if !off.isEmpty, !silent { _ = await runShortcut(off) }
        return .hide(message: "Focused for \(FocusMachine.formatDuration(rec.focusedMs))")
    }

    @discardableResult func togglePause() -> ActionResult {
        guard let s = session else { return .error("No focus session is running") }
        session = FocusMachine.togglePause(s, now: now())
        changed()
        return .hide(message: session?.status == "paused" ? "Focus paused" : "Focus resumed")
    }

    @discardableResult func extend(_ minutes: Double) -> ActionResult {
        guard let s = session else { return .error("No focus session is running") }
        let next = FocusMachine.extend(s, now: now(), minutes: minutes)
        session = next
        changed()
        return .stay(message: "\(FocusMachine.formatClock(FocusMachine.remaining(next, now: now()))) left")
    }

    /// `shortcuts run <name>` (recorded, not run, in headless mode). nil = ok.
    func runShortcut(_ name: String) async -> String? {
        guard let scripts = context?.services.scripts else { return "Not ready" }
        do {
            let r = try await scripts.runShell("/usr/bin/shortcuts run \(Self.shellQuote(name))", shell: "/bin/zsh", timeout: 15)
            return r.status == 0 ? nil : (r.stderr.isEmpty ? "shortcuts exited with \(r.status)" : r.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            return error.localizedDescription
        }
    }

    static func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    static func asString(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }

    /// Blocked apps are asked to quit (AppleScript, never in headless); blocked sites get a reminder.
    func enforce() async {
        guard let s = session, s.status == "running", !polling, let ctx = context else { return }
        polling = true
        defer { polling = false }
        guard let front = ctx.services.frontmost.targetApp(), !(front.bundleId.map(Self.neverBlock.contains) ?? false),
              !ctx.services.frontmost.isGlide(bundleId: front.bundleId, pid: front.pid) else { return }
        if let hit = FocusMachine.appMatches(name: front.name, bundleId: front.bundleId, s.blockedApps) {
            let key = front.bundleId ?? front.name
            if now() - (lastQuitAttempt[key] ?? 0) > 10_000 {
                lastQuitAttempt[key] = now()
                var quit = false
                if settings.quitBlockedApps {
                    let target = front.bundleId.map { "application id \(Self.asString($0))" } ?? "application \(Self.asString(front.name))"
                    quit = (try? await ctx.services.scripts.runAppleScript("tell \(target) to quit")) != nil
                }
                let goal = s.goal.isEmpty ? "" : " on “\(s.goal)”"
                notify("\(hit.name) is blocked", quit ? "Quit during your focus session\(goal)." : "It is on your focus block list\(goal).")
            }
            return
        }
        if !s.blockedSites.isEmpty, let bid = front.bundleId, let safari = Self.browsers[bid] {
            let script = "tell application id \(Self.asString(bid)) to return URL of \(safari ? "current tab" : "active tab") of front window"
            guard let url = try? await ctx.services.scripts.runAppleScript(script), !url.isEmpty, let site = FocusMachine.siteMatches(url, s.blockedSites),
                  (snoozed[site] ?? 0) < now() else { return }
            snoozed[site] = now() + 60_000
            notify("\(site) is blocked", s.goal.isEmpty ? "It is on your focus block list." : "Back to “\(s.goal)” — \(FocusMachine.formatClock(FocusMachine.remaining(s, now: now()))) left.")
        }
    }

    // MARK: catalogue

    private func item(_ action: String, _ title: String, _ subtitle: String, _ symbol: String, _ keywords: [String], argument: Bool = false) -> SearchItem {
        SearchItem(id: "focus:\(action)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol, tint: "#BF5AF2"), keywords: keywords,
                   acceptsArgument: argument ? true : nil, feature: id, data: ["action": .string(action)], kindLabel: "Focus")
    }

    public func items() -> [SearchItem] {
        var list: [SearchItem] = []
        if let s = session {
            let left = FocusMachine.formatClock(FocusMachine.remaining(s, now: now()))
            list.append(item("stop", "Stop Focus Session", "\(s.goal.isEmpty ? "Focus" : s.goal) · \(left) left", "stop.circle", ["focus", "end", "finish", "pomodoro"]))
            list.append(item("pause", s.status == "running" ? "Pause Focus Session" : "Resume Focus Session", s.goal.isEmpty ? "Focus" : s.goal,
                             s.status == "running" ? "pause.circle" : "play.circle", ["focus", "pause", "resume", "pomodoro"]))
        }
        list.append(item("start", session != nil ? "Start New Focus Session" : "Start Focus Session", "Focus", "target", ["focus", "pomodoro", "timer", "deep work", "concentrate"], argument: true))
        list.append(item("stats", "Focus Statistics", "Focus", "chart.bar", ["focus", "stats", "history", "pomodoro"]))
        return list
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "start": return [.init(id: "start", title: "Start Focus Session", shortcut: "↩", icon: "target"), .init(id: "quickStart", title: "Start \(settings.defaultMinutes) min Now", shortcut: "⌘↩", icon: "play")]
        case "stop": return [.init(id: "stop", title: "Stop Focus Session", shortcut: "↩", icon: "stop")]
        case "pause": return [.init(id: "pause", title: "Pause/Resume", shortcut: "↩", icon: "playpause"), .init(id: "extend", title: "Add 5 Minutes", shortcut: "⌘↩", icon: "plus")]
        default: return [.init(id: "stats", title: "Show Statistics", shortcut: "↩", icon: "chart.bar")]
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let goal = (scored.argument ?? "").trimmingCharacters(in: .whitespaces)
        switch action {
        case "start":
            startGoal = goal
            n7AfterUpdate { [weak self] in self?.startModel.syncHost() }
            return .pushView(ViewID(feature: id, name: "start"), payload: ["goal": .string(goal)])
        case "quickStart": return await start(goal: goal, minutes: Double(settings.defaultMinutes))
        case "stop": return await stop(completed: false)
        case "pause": return togglePause()
        case "extend": return extend(5)
        case "stats":
            n7AfterUpdate { [weak self] in self?.statsModel.syncHost() }
            return .pushView(ViewID(feature: id, name: "stats"))
        default: return .error("Unknown action \(action)")
        }
    }

    // MARK: views

    /// Goal passed from the root argument ("Start Focus Session" ⇥ goal); used when the field is empty.
    var startGoal = ""

    private func finish(_ r: ActionResult) {
        let host = LauncherHosts.current
        switch r {
        case let .hide(m):
            if let m { host?.toast(m, style: .success) }
            host?.close()
        case let .stay(m): if let m { host?.toast(m, style: .info) }
        case let .error(e): host?.toast(e, style: .error)
        default: break
        }
    }

    private func pushView(_ name: String) {
        LauncherHosts.current?.push(ViewID(feature: id, name: name), payload: .null)
        let m = name == "stats" ? statsModel : name == "blocklist" ? blockModel : startModel
        n7AfterUpdate { m.syncHost() }
    }

    func startRows(_ query: String) -> [N7Row] {
        let parsed = FocusMachine.parseDurationPrefix(query)
        let typed = parsed?.goal ?? query.trimmingCharacters(in: .whitespaces)
        let goal = typed.isEmpty && query.isEmpty ? startGoal : typed
        let st = settings
        var rows: [N7Row] = []
        let common: [N7Action] = [
            N7Action("blocklist", "Edit Block List…", shortcut: "⌘B", icon: "nosign") { [weak self] in self?.pushView("blocklist") },
            N7Action("stats", "Focus Statistics", shortcut: "⌘S", icon: "chart.bar") { [weak self] in self?.pushView("stats") },
        ]
        if let s = session {
            let left = FocusMachine.formatClock(FocusMachine.remaining(s, now: now()))
            rows.append(N7Row(id: "pause", section: "Current Session", icon: .symbol(s.status == "paused" ? "play.circle" : "pause.circle", tint: "#BF5AF2"),
                              title: s.status == "paused" ? "Resume Session" : "Pause Session", subtitle: "\(left) left",
                              actions: [N7Action("pause", s.status == "paused" ? "Resume" : "Pause", shortcut: "↩", icon: "playpause") { [weak self] in
                                  guard let self else { return }
                                  if case let .hide(m) = self.togglePause() { LauncherHosts.current?.toast(m ?? "", style: .info) }
                              }] + common))
            rows.append(N7Row(id: "stop", section: "Current Session", icon: .symbol("stop.circle", tint: "#FF453A"), title: "Stop Current Session",
                              subtitle: "\(s.goal.isEmpty ? "Focus" : s.goal) · \(left) left",
                              actions: [N7Action("stop", "Stop Session", shortcut: "↩", icon: "stop", destructive: true) { [weak self] in
                                  guard let self else { return }
                                  self.finish(await self.stop(completed: false))
                              }] + common))
        }
        var durations: [Int] = []
        for m in [parsed?.minutes, st.defaultMinutes].compactMap({ $0 }) + Self.presets where !durations.contains(m) { durations.append(m) }
        for m in durations {
            let label = m >= 60 && m % 60 == 0 ? "\(m / 60) hour\(m == 60 ? "" : "s")" : "\(m) minutes"
            rows.append(N7Row(id: "d\(m)", section: session != nil ? "Start a New Session" : "Start Focusing", icon: .symbol("target", tint: "#BF5AF2"), title: "Focus for \(label)",
                              subtitle: goal.isEmpty ? "Type a goal in the search field" : "on “\(goal)”", trailing: st.defaultMinutes == m ? "Default" : nil,
                              actions: [N7Action("start", "Start \(label)", shortcut: "↩", icon: "play") { [weak self] in
                                  guard let self else { return }
                                  self.startGoal = ""
                                  self.finish(await self.start(goal: goal, minutes: Double(m)))
                              }] + common))
        }
        let blocked = st.blockedApps.map(\.name) + st.blockedSites
        rows.append(N7Row(id: "blocklist", section: "Block List", icon: .symbol("nosign", tint: "#FF453A"), title: "Edit Block List…",
                          subtitle: blocked.isEmpty ? "Nothing blocked" : blocked.prefix(5).joined(separator: ", ") + (blocked.count > 5 ? " +\(blocked.count - 5)" : ""),
                          actions: [N7Action("edit", "Edit Block List", shortcut: "↩", icon: "nosign") { [weak self] in self?.pushView("blocklist") }] + common))
        return rows
    }

    func statsRows() -> [N7Row] {
        var rows: [N7Row] = []
        if let s = session {
            rows.append(N7Row(id: "current", section: "Now", icon: .symbol(s.status == "paused" ? "pause.circle" : "timer", tint: "#BF5AF2"), title: s.goal.isEmpty ? "Focus session" : s.goal,
                              subtitle: "\(FocusMachine.formatClock(FocusMachine.remaining(s, now: now()))) left of \(FocusMachine.formatDuration(s.durationMs))\(s.status == "paused" ? " · paused" : "")",
                              trailing: "⏎ pause · ⌘⏎ +5 min · ⌃X stop", actions: [
                                  N7Action("pause", s.status == "paused" ? "Resume" : "Pause", shortcut: "↩", icon: "playpause") { [weak self] in _ = self?.togglePause() },
                                  N7Action("extend", "Add 5 Minutes", shortcut: "⌘↩", icon: "plus") { [weak self] in self?.finish(self?.extend(5) ?? .stay()) },
                                  N7Action("stop", "Stop Session", shortcut: "⌃X", icon: "stop", destructive: true) { [weak self] in _ = await self?.stop(completed: false) },
                              ]))
        } else {
            rows.append(N7Row(id: "start", section: "Now", icon: .symbol("target", tint: "#BF5AF2"), title: "Start Focus Session",
                              actions: [N7Action("start", "Start Focus Session", shortcut: "↩", icon: "play") { [weak self] in self?.pushView("start") }]))
        }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US")
        df.dateFormat = "EEE MMM d, h:mm a"
        for r in history.suffix(20).reversed() {
            rows.append(N7Row(id: r.id, section: "Recent Sessions", icon: .symbol(r.completed ? "checkmark.circle.fill" : "stop.circle", tint: r.completed ? "#30D158" : "#8E8E93"),
                              title: r.goal.isEmpty ? "Focus session" : r.goal, subtitle: "\(FocusMachine.formatDuration(r.focusedMs)) of \(FocusMachine.formatDuration(r.plannedMs))",
                              trailing: df.string(from: Date(timeIntervalSince1970: r.startedAt / 1000)),
                              actions: [N7Action("again", "Focus on This Again", shortcut: "↩", icon: "arrow.clockwise") { [weak self] in
                                  self?.startGoal = r.goal
                                  self?.pushView("start")
                              }]))
        }
        return rows
    }

    func blockRows(_ query: String) -> [N7Row] {
        let st = settings
        let q = query.trimmingCharacters(in: .whitespaces)
        var rows: [N7Row] = []
        if !q.isEmpty {
            let site = FocusMachine.normalizeSite(q)
            if !site.isEmpty, !st.blockedSites.contains(site) {
                rows.append(N7Row(id: "add-site", section: "Add", icon: .symbol("globe", tint: "#FF453A"), title: "Block \(site)", subtitle: "Website (and its subdomains)",
                                  actions: [N7Action("add", "Block Website", shortcut: "↩", icon: "plus") { [weak self] in
                                      self?.setSettings(["blockedSites": .array((st.blockedSites + [site]).map(JSONValue.string))])
                                  }]))
            }
            for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
                guard let name = app.localizedName, name.localizedCaseInsensitiveContains(q), !st.blockedApps.contains(where: { $0.bundleId == app.bundleIdentifier }) else { continue }
                let entry = BlockedApp(name: name, bundleId: app.bundleIdentifier, path: app.bundleURL?.path)
                rows.append(N7Row(id: "add-app-\(app.bundleIdentifier ?? name)", section: "Add", icon: app.bundleURL.map { .app($0.path) }, title: "Block \(name)", subtitle: "Running app",
                                  actions: [N7Action("add", "Block App", shortcut: "↩", icon: "plus") { [weak self] in
                                      self?.setSettings(["blockedApps": .array((st.blockedApps + [entry]).map { N7JSON.value($0) })])
                                  }]))
                if rows.count > 6 { break }
            }
        }
        for a in st.blockedApps where q.isEmpty || a.name.localizedCaseInsensitiveContains(q) {
            rows.append(N7Row(id: "app-\(a.bundleId ?? a.name)", section: "Blocked Apps", icon: a.path.map { .app($0) } ?? .symbol("app"), title: a.name, subtitle: a.bundleId,
                              actions: [N7Action("remove", "Remove from Block List", shortcut: "⌃X", icon: "trash", destructive: true) { [weak self] in
                                  self?.setSettings(["blockedApps": .array(st.blockedApps.filter { $0 != a }.map { N7JSON.value($0) })])
                              }]))
        }
        for s in st.blockedSites where q.isEmpty || s.contains(q.lowercased()) {
            rows.append(N7Row(id: "site-\(s)", section: "Blocked Websites", icon: .symbol("globe", tint: "#FF453A"), title: s,
                              actions: [N7Action("remove", "Remove from Block List", shortcut: "⌃X", icon: "trash", destructive: true) { [weak self] in
                                  self?.setSettings(["blockedSites": .array(st.blockedSites.filter { $0 != s }.map(JSONValue.string))])
                              }]))
        }
        return rows
    }

    private func model(_ view: ViewID) -> N7ListModel? {
        switch view.name {
        case "start": return startModel
        case "stats": return statsModel
        case "blocklist": return blockModel
        default: return nil
        }
    }

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard let m = model(id) else { return nil }
        n7AfterUpdate { m.syncHost() }
        return AnyView(N7ListView(model: m))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { model(view)?.handleKey(key) ?? false }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { model(view)?.handle(command) ?? false }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Focus", symbol: "target", order: 114) { [weak self] in
            let st = self?.settings
            return AnyView(FocusSettingsView(minutes: st?.defaultMinutes ?? 25, sites: (st?.blockedSites ?? []).joined(separator: "\n"),
                                             apps: (st?.blockedApps ?? []).map(\.name), dndOn: st?.dndOnShortcut ?? "", dndOff: st?.dndOffShortcut ?? "",
                                             quit: st?.quitBlockedApps ?? true) { patch in self?.setSettings(patch) })
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        func res(_ r: ActionResult) -> JSONValue {
            switch r {
            case let .hide(m), let .stay(m): return ["ok": true, "message": m.map(JSONValue.string) ?? .null]
            case let .error(e): return ["ok": false, "error": .string(e)]
            default: return ["ok": true]
            }
        }
        switch method {
        case "state":
            let t = now()
            return ["session": N7JSON.value(session), "remainingMs": .double(session.map { FocusMachine.remaining($0, now: t) } ?? 0),
                    "elapsedMs": .double(session.map { FocusMachine.elapsed($0, now: t) } ?? 0), "stats": N7JSON.value(stats),
                    "recent": N7JSON.value(Array(history.suffix(20).reversed())), "trayTitle": .string(trayTitle)]
        case "start":
            let m = args["minutes"]?.number ?? Double(settings.defaultMinutes)
            return res(await start(goal: args["goal"]?.stringValue ?? "", minutes: m > 0 ? m : Double(settings.defaultMinutes)))
        case "stop": return res(await stop(completed: false))
        case "togglePause": return res(togglePause())
        case "extend": return res(extend(args["minutes"]?.number ?? 5))
        case "setSettings":
            setSettings(args.objectValue ?? [:])
            return ["blockedSites": .array(settings.blockedSites.map(JSONValue.string)), "defaultMinutes": .int(Int64(settings.defaultMinutes))]
        case "enforce":
            await enforce()
            return .array(notified.map(JSONValue.string))
        case "tick":
            tick()
            return .bool(session != nil)
        case "notified": return .array(notified.map(JSONValue.string))
        case "viewState": return model(ViewID(feature: id, name: args["view"]?.stringValue ?? "start"))?.snapshot() ?? .null
        case "viewAction": return .bool(await model(ViewID(feature: id, name: args["view"]?.stringValue ?? "start"))?.run(actionId: args["id"]?.stringValue ?? "") ?? false)
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

struct FocusStatsHeader: View {
    @Environment(\.glideTheme) private var theme
    let stats: FocusStats
    var body: some View {
        let maxMs = max(60_000, stats.last7.map(\.ms).max() ?? 0)
        let days = ["S", "M", "T", "W", "T", "F", "S"]
        HStack(alignment: .bottom, spacing: 12) {
            card(FocusMachine.formatDuration(stats.todayMs), "Today · \(stats.sessionsToday) session\(stats.sessionsToday == 1 ? "" : "s")")
            card(FocusMachine.formatDuration(stats.weekMs), "This week · \(stats.sessionsWeek) sessions")
            card("\(stats.completedWeek)", "Completed this week")
            Spacer()
            HStack(alignment: .bottom, spacing: 5) {
                ForEach(stats.last7, id: \.day) { d in
                    VStack(spacing: 3) {
                        RoundedRectangle(cornerRadius: 2).fill(theme.accent).frame(width: 12, height: max(2, 40 * d.ms / maxMs))
                        Text(days[Calendar.current.component(.weekday, from: Date(timeIntervalSince1970: d.day / 1000)) - 1]).font(.system(size: 9)).foregroundStyle(theme.text3)
                    }
                }
            }
            .accessibilityLabel("Focus time, last 7 days")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 1) }
    }

    private func card(_ num: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(num).font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
            Text(label).font(.system(size: 11)).foregroundStyle(theme.text3)
        }
    }
}

struct FocusSettingsView: View {
    @State var minutes: Int
    @State var sites: String
    let apps: [String]
    @State var dndOn: String
    @State var dndOff: String
    @State var quit: Bool
    let onChange: ([String: JSONValue]) -> Void
    var body: some View {
        Form {
            Section("Sessions") {
                Stepper("Default length: \(minutes) min", value: $minutes, in: 5...240, step: 5).onChange(of: minutes) { _, v in onChange(["defaultMinutes": .int(Int64(v))]) }
            }
            Section("Block list") {
                Toggle("Ask blocked apps to quit", isOn: $quit).onChange(of: quit) { _, v in onChange(["quitBlockedApps": .bool(v)]) }
                LabeledContent("Blocked apps", value: apps.isEmpty ? "None" : apps.joined(separator: ", "))
                TextField("Blocked websites (one per line)", text: $sites, axis: .vertical).lineLimit(3...8)
                    .onSubmit { onChange(["blockedSites": .array(sites.split(whereSeparator: \.isNewline).map { .string(String($0)) })]) }
                N7SettingsNote(text: "Edit the list from the launcher too: Start Focus Session → Edit Block List (⌘B). Websites are checked in Safari and Chromium browsers (needs Automation permission, asked by macOS once).")
            }
            Section("Do Not Disturb") {
                TextField("Shortcut to run on start", text: $dndOn).onSubmit { onChange(["dndOnShortcut": .string(dndOn)]) }
                TextField("Shortcut to run on stop", text: $dndOff).onSubmit { onChange(["dndOffShortcut": .string(dndOff)]) }
            }
        }
        .formStyle(.grouped)
    }
}
