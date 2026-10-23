import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Calendar (src/main/features/calendar): "My Schedule" (today + 7 days via EventKit) with meeting-link
/// detection, and "Join <meeting>" rows in the root search for meetings that are on or about to start.
/// Calendar access is requested only from the view's explicit "Grant Calendar Access" row.
@MainActor public final class CalendarFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "calendar"
    public let title = "Calendar"
    private weak var context: FeatureContext?
    var now: () -> Date = { Date() }
    var eventKitOverride: (any EventKitService)?
    private var fixture: FixtureEventKit?
    private(set) var status: EventKitAccess = .notDetermined
    private(set) var message: String?
    private(set) var events: [CalendarEvent] = []
    private(set) var range: (from: Date, to: Date) = (Date(), Date())
    private var cacheAt: Date?
    private var refreshing: Task<Void, Never>?
    private var timer: Timer?
    static let days = 8

    lazy var scheduleModel = N7ListModel(placeholder: "Search events…", emptyTitle: "Loading…") { [weak self] q in self?.scheduleRows(q) ?? [] }

    public init() {
        scheduleModel.banner = { [weak self] in
            guard let self, self.status != .ok, let m = self.message else { return nil }
            return (m, self.status == .error)
        }
    }

    var eventKit: (any EventKitService)? { eventKitOverride ?? fixture ?? context?.services.eventKit }

    public func start(context: FeatureContext) async {
        self.context = context
        fixture = FixtureEventKit.fromEnvironment(headless: context.services.isHeadless)
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in await self?.refresh() } }
    }

    public func stop() async { timer?.invalidate() }

    func access() -> (EventKitAccess, String?) {
        if eventKitOverride != nil || fixture != nil { return (.ok, nil) }
        guard let p = context?.services.permissions.status() else { return (.error, "Not ready") }
        switch p.calendar {
        case "authorized": return (.ok, nil)
        case "notDetermined": return (.notDetermined, "Glide needs permission to read your calendars.")
        case "restricted": return (.restricted, "Calendar access is restricted on this Mac.")
        default: return (.denied, "Calendar access is turned off for Glide.")
        }
    }

    func windowRange() -> (Date, Date) {
        let cal = Calendar.current
        let from = cal.startOfDay(for: now())
        return (from, cal.date(byAdding: .day, value: Self.days, to: from) ?? from)
    }

    func refresh() async {
        if let r = refreshing { return await r.value }
        let task = Task { @MainActor in await self.fetch() }
        refreshing = task
        await task.value
        refreshing = nil
    }

    private func fetch() async {
        let (from, to) = windowRange()
        range = (from, to)
        let a = access()
        status = a.0
        message = a.1
        if a.0 == .ok, let ek = eventKit {
            do {
                let raw = try await ek.calendarEvents(from: from, to: to)
                events = (raw.arrayValue ?? []).compactMap(CalendarEvent.from).sorted {
                    let a = $0.startDate ?? .distantFuture, b = $1.startDate ?? .distantFuture
                    return a != b ? a < b : ($0.allDay && !$1.allDay)
                }
                cacheAt = now()
            } catch {
                let f = RemindersFeature.failure(error)
                status = f.0
                message = f.1
                events = []
            }
        } else {
            events = []
        }
        scheduleModel.changed()
    }

    func requestAccess() async {
        _ = await context?.services.permissions.request(.calendar)
        await refresh()
    }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        [SearchItem(id: "calendar:schedule", kind: .command, title: "My Schedule", subtitle: "Calendar", icon: .symbol("calendar", tint: "#FF453A"),
                    keywords: ["calendar", "events", "agenda", "meetings", "today", "upcoming"], feature: id, data: ["action": "schedule"], kindLabel: "Calendar")]
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        guard CalendarLinks.matchesJoinQuery(query.text) else { return [] }
        if cacheAt.map({ now().timeIntervalSince($0) > 60 }) ?? true { Task { await refresh() } }
        let t = now()
        return events.filter { $0.meeting != nil && CalendarLinks.isJoinable($0, now: t) }.prefix(3).enumerated().map { i, e in
            let item = SearchItem(id: "calendar:join:\(e.id)", kind: .command, title: "Join \(e.title)", subtitle: "\(CalendarLinks.startsInLabel(e, now: t)) · \(e.meeting?.provider ?? "")",
                                  icon: .symbol("video", tint: "#30D158"), keywords: ["join", "meet", "meeting", "call", query.trimmed].filter { !$0.isEmpty }, feature: id,
                                  data: ["action": "join", "url": .string(e.meeting?.url ?? ""), "start": .string(e.start), "noUsage": true], kindLabel: e.meeting?.provider ?? "Meeting")
            return ScoredItem(item: item, score: 1000 - Double(i), matchScore: 1000 - Double(i), matchKind: .keyword)
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        if item.data?["action"]?.stringValue == "join" {
            return [.init(id: "join", title: "Join Meeting", shortcut: "↩", icon: "video"), .init(id: "openCalendar", title: "Open in Calendar", shortcut: "⌘↩", icon: "calendar"),
                    .init(id: "copyLink", title: "Copy Meeting Link", shortcut: "⇧⌘C", icon: "link")]
        }
        return [.init(id: "schedule", title: "Show Schedule", shortcut: "↩", icon: "calendar")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let d = scored.item.data ?? [:]
        switch action {
        case "schedule":
            Task { await refresh() }
            n7AfterUpdate { [weak self] in self?.scheduleModel.syncHost() }
            return .pushView(ViewID(feature: id, name: "schedule"))
        case "join": return join(d["url"]?.stringValue ?? "")
        case "openCalendar": return await openCalendar(at: d["start"]?.stringValue ?? "")
        case "copyLink":
            context?.services.pasteboard.setString(d["url"]?.stringValue ?? "", html: nil, transient: false)
            return .hide(message: "Link copied")
        default: return .error("Unknown action \(action)")
        }
    }

    func join(_ url: String) -> ActionResult {
        guard url.range(of: "^(https?|zoommtg):", options: [.regularExpression, .caseInsensitive]) != nil, let u = URL(string: url) else { return .error("Invalid meeting link") }
        let r = context?.services.workspace.open(url: u)
        return r?.ok == false ? .error(r?.error ?? "Could not open the link") : .hide()
    }

    /// Day view at the event's date (AppleScript; falls back to launching Calendar).
    func openCalendar(at iso: String) async -> ActionResult {
        guard let d = CalendarLinks.date(iso), let ctx = context else { return .error("Invalid date") }
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: d)
        let script = """
        set d to current date
        set year of d to \(c.year ?? 2000)
        set month of d to \(c.month ?? 1)
        set day of d to \(c.day ?? 1)
        set hours of d to \(c.hour ?? 0)
        set minutes of d to \(c.minute ?? 0)
        tell application "Calendar"
          activate
          switch view to day view
          view calendar at d
        end tell
        """
        ctx.hideLauncher()
        if (try? await ctx.services.scripts.runAppleScript(script)) == nil { _ = ctx.services.workspace.launchApplication("com.apple.iCal") }
        return .hide()
    }

    // MARK: schedule view

    static func dayTitle(_ day: Date, now: Date) -> String {
        let cal = Calendar.current
        let diff = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: day).day ?? 0
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "EEEE, MMM d"
        let label = f.string(from: day)
        return diff == 0 ? "Today · \(label)" : diff == 1 ? "Tomorrow · \(label)" : label
    }

    static func timeRange(_ e: CalendarEvent, day: Date) -> String {
        if e.allDay { return "All day" }
        guard let s = e.startDate, let en = e.endDate else { return "" }
        let next = Calendar.current.date(byAdding: .day, value: 1, to: day) ?? day
        return "\(s >= day ? N7Format.time(s.timeIntervalSince1970 * 1000) : "…") – \(en <= next ? N7Format.time(en.timeIntervalSince1970 * 1000) : "…")"
    }

    private func finish(_ r: ActionResult) {
        switch r {
        case let .hide(m):
            if let m { LauncherHosts.current?.toast(m, style: .success) }
            LauncherHosts.current?.close()
        case let .error(e): LauncherHosts.current?.toast(e, style: .error)
        default: break
        }
    }

    func scheduleRows(_ query: String) -> [N7Row] {
        let retry = N7Row(id: "retry", icon: .symbol("arrow.clockwise"), title: "Try Again", subtitle: status == .unavailable ? "Not available in this run" : "Reload events",
                          actions: [N7Action("retry", "Try Again", shortcut: "↩", icon: "arrow.clockwise") { [weak self] in await self?.refresh() }])
        switch status {
        case .notDetermined:
            return [N7Row(id: "grant", icon: .symbol("lock.open", tint: "#FF453A"), title: "Grant Calendar Access", subtitle: "macOS will ask once",
                          actions: [N7Action("grant", "Grant Calendar Access", shortcut: "↩", icon: "lock.open") { [weak self] in await self?.requestAccess() }])]
        case .denied, .restricted:
            return [N7Row(id: "settings", icon: .symbol("gearshape"), title: "Open Privacy Settings", subtitle: "Allow Glide under Privacy & Security → Calendars",
                          actions: [N7Action("settings", "Open Privacy Settings", shortcut: "↩", icon: "gearshape") { [weak self] in
                              if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars") { _ = self?.context?.services.workspace.open(url: u) }
                          }]), retry]
        case .ok: break
        default: return [retry]
        }
        let t = now()
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        var list: [(CalendarEvent, Date)] = []
        for e in events {
            if !e.allDay, let en = e.endDate, en <= t { continue }
            if !q.isEmpty, !"\(e.title) \(e.location ?? "") \(e.calendar)".lowercased().contains(q) { continue }
            for day in CalendarLinks.dayKeys(e, from: range.from, to: range.to) { list.append((e, day)) }
        }
        list.sort { a, b in a.1 != b.1 ? a.1 < b.1 : a.0.allDay != b.0.allDay ? a.0.allDay : (a.0.startDate ?? .distantPast) < (b.0.startDate ?? .distantPast) }
        let rows = list.map { e, day -> N7Row in
            var actions: [N7Action] = []
            if let m = e.meeting { actions.append(N7Action("join", "Join \(m.provider) Meeting", shortcut: "↩", icon: "video") { [weak self] in self?.finish(self?.join(m.url) ?? .stay()) }) }
            actions.append(N7Action("open", "Open in Calendar", shortcut: "⌘↩", icon: "calendar") { [weak self] in
                guard let self else { return }
                self.finish(await self.openCalendar(at: e.start))
            })
            if let m = e.meeting {
                actions.append(N7Action("copyLink", "Copy Meeting Link", shortcut: "⇧⌘C", icon: "link") { [weak self] in
                    self?.context?.services.pasteboard.setString(m.url, html: nil, transient: false)
                    LauncherHosts.current?.toast("Link copied", style: .success)
                })
            }
            actions.append(N7Action("copy", "Copy Event Details", shortcut: "⌘C", icon: "doc.on.doc") { [weak self] in
                let text = [e.title, "\(Self.timeRange(e, day: day)) \(Self.dayTitle(day, now: Date()))", e.location, e.meeting?.url].compactMap { $0 }.joined(separator: "\n")
                self?.context?.services.pasteboard.setString(text, html: nil, transient: false)
                LauncherHosts.current?.toast("Copied", style: .success)
            })
            let live = CalendarLinks.isJoinable(e, now: t, within: 0)
            let soon = !live && CalendarLinks.isJoinable(e, now: t)
            let location = e.location.flatMap { l in e.meeting?.url.contains(l) == true ? nil : l }
            return N7Row(id: "\(e.id)@\(Int(day.timeIntervalSince1970))", section: Self.dayTitle(day, now: t), icon: .symbol(live ? "record.circle" : "circle.fill", tint: e.color ?? "#0A84FF"),
                         title: e.title, subtitle: [Self.timeRange(e, day: day), location].compactMap { $0 }.joined(separator: " · "),
                         tag: e.meeting?.provider, trailing: [live || soon ? CalendarLinks.startsInLabel(e, now: t) : nil, e.calendar].compactMap { $0 }.joined(separator: " · "),
                         actions: actions, detail: { AnyView(EventDetail(event: e)) })
        }
        if rows.isEmpty {
            return [N7Row(id: "empty", icon: .symbol("sun.max", tint: "#FFD60A"), title: q.isEmpty ? "Nothing scheduled" : "No matching events", subtitle: "Next 7 days")]
        }
        return rows
    }

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard id.name == "schedule" else { return nil }
        n7AfterUpdate { [weak self] in self?.scheduleModel.syncHost() }
        return AnyView(N7ListView(model: scheduleModel))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { view.name == "schedule" && scheduleModel.handleKey(key) }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { view.name == "schedule" && scheduleModel.handle(command) }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "schedule":
            await refresh()
            return ["status": .string(status.rawValue), "message": message.map(JSONValue.string) ?? .null, "from": .string(RemindersModel.iso(range.from)),
                    "to": .string(RemindersModel.iso(range.to)), "events": N7JSON.value(events)]
        case "join": return finishJSON(join(args["url"]?.stringValue ?? args.stringValue ?? ""))
        case "requestAccess":
            await requestAccess()
            return try await invoke(method: "schedule", args: .null)
        case "openCalendar":
            // ISO string (Electron) or unix ms (menu bar).
            let iso = args.stringValue ?? args["iso"]?.stringValue ?? (args.number ?? args["ms"]?.number).map { RemindersModel.iso(Date(timeIntervalSince1970: $0 / 1000)) } ?? ""
            return finishJSON(await openCalendar(at: iso))
        case "openPrivacySettings":
            if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars") { _ = context?.services.workspace.open(url: u) }
            return true
        case "viewState": return scheduleModel.snapshot()
        case "viewAction": return .bool(await scheduleModel.run(actionId: args["id"]?.stringValue ?? ""))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    private func finishJSON(_ r: ActionResult) -> JSONValue {
        if case let .error(e) = r { return ["ok": false, "error": .string(e)] }
        return ["ok": true]
    }
}

struct EventDetail: View {
    @Environment(\.glideTheme) private var theme
    let event: CalendarEvent
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(event.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
            if let s = event.startDate, let e = event.endDate {
                Text(event.allDay ? "All day" : "\(s.formatted(date: .abbreviated, time: .shortened)) – \(e.formatted(date: .omitted, time: .shortened))")
                    .font(.system(size: 12)).foregroundStyle(theme.text2)
            }
            Label(event.calendar, systemImage: "calendar").font(.system(size: 12)).foregroundStyle(theme.text3)
            if let l = event.location, !l.isEmpty { Label(l, systemImage: "mappin.and.ellipse").font(.system(size: 12)).foregroundStyle(theme.text2) }
            if let m = event.meeting { Label("\(m.provider) · ⏎ to join", systemImage: "video").font(.system(size: 12, weight: .medium)).foregroundStyle(theme.accentText) }
            if let n = event.notes, !n.isEmpty { Text(n).font(.system(size: 12)).foregroundStyle(theme.text2).lineLimit(12) }
        }
    }
}
