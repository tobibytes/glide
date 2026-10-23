import Foundation
import GlideCore

// Pure builders for the built-in extras (src/main/features/menubar/extras/specs.ts): data in, spec out; nil
// hides the extra. Inputs are decoded from the owning features' JSON (same shapes as the Electron methods).

public enum ExtraID: String, CaseIterable, Sendable {
    case timers, sysmon, meeting, clipboard, agent

    public var title: String {
        switch self {
        case .timers: return "Timers"
        case .sysmon: return "System Monitor"
        case .meeting: return "Next Meeting"
        case .clipboard: return "Clipboard"
        case .agent: return "Glide Agent"
        }
    }
    public var detail: String {
        switch self {
        case .timers: return "Countdown of the soonest timer, with pause / stop for each"
        case .sysmon: return "CPU and memory usage, refreshed every 2 seconds"
        case .meeting: return "Time until your next event; today’s events with Join links"
        case .clipboard: return "Paste any of your last 10 clipboard entries"
        case .agent: return "Ask the agent from the menu bar; shows a running task"
        }
    }
    public var symbol: String {
        switch self {
        case .timers: return "timer"
        case .sysmon: return "chart.xyaxis.line"
        case .meeting: return "calendar"
        case .clipboard: return "doc.on.clipboard"
        case .agent: return "wand.and.stars"
        }
    }
    public var defaultOn: Bool { self == .timers }
}

public enum MenuText {
    public static func truncate(_ text: String, _ max: Int) -> String {
        let t = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard t.count > max else { return t }
        return String(t.prefix(Swift.max(1, max - 1))).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// "1:05:09" / "4:59" (timers model formatClock).
    public static func clock(_ ms: Double, roundUp: Bool = true) -> String {
        let total = Int(roundUp ? (ms / 1000).rounded(.up) : (ms / 1000).rounded(.down))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// "25 min", "1 h 30 min", "45 s".
    public static func duration(_ ms: Double) -> String {
        let total = Int((ms / 1000).rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        var parts: [String] = []
        if h > 0 { parts.append("\(h) h") }
        if m > 0 { parts.append("\(m) min") }
        if s > 0 || parts.isEmpty { parts.append("\(s) s") }
        return parts.joined(separator: " ")
    }

    nonisolated(unsafe) static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "h:mm a"
        return f
    }()
    public static func clockTime(_ ms: Double) -> String { timeFormatter.string(from: Date(timeIntervalSince1970: ms / 1000)) }

    public static func pct(_ x: Double) -> String { "\(Int((min(1, max(0, x)) * 100).rounded()))%" }

    public static func bytes(_ b: Double) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var v = b, i = 0
        while v >= 1024 && i < units.count - 1 { v /= 1024; i += 1 }
        return i == 0 ? "\(Int(v)) B" : String(format: v >= 10 ? "%.0f %@" : "%.1f %@", v, units[i])
    }
}

// MARK: - Timers

public struct TimerInfo: Sendable, Equatable {
    public var id: String, name: String, durationMs: Double, startedAt: Double, pausedAt: Double?, pausedMs: Double
    public init(id: String, name: String, durationMs: Double, startedAt: Double, pausedAt: Double?, pausedMs: Double) {
        self.id = id; self.name = name; self.durationMs = durationMs; self.startedAt = startedAt; self.pausedAt = pausedAt; self.pausedMs = pausedMs
    }
    init?(_ v: JSONValue) {
        guard let id = v["id"]?.stringValue, let d = v["durationMs"]?.doubleValue, let s = v["startedAt"]?.doubleValue else { return nil }
        self.init(id: id, name: v["name"]?.stringValue ?? "", durationMs: d, startedAt: s, pausedAt: v["pausedAt"]?.doubleValue, pausedMs: v["pausedMs"]?.doubleValue ?? 0)
    }
    public func remaining(_ now: Double) -> Double { max(0, durationMs - max(0, (pausedAt ?? now) - startedAt - pausedMs)) }
    public var endsAt: Double { pausedAt == nil ? startedAt + pausedMs + durationMs : .infinity }
    public var label: String { name.isEmpty ? "\(MenuText.duration(durationMs)) Timer" : name }
}

public struct StopwatchInfo: Sendable, Equatable {
    public var id: String, name: String, startedAt: Double, pausedAt: Double?, pausedMs: Double
    init?(_ v: JSONValue) {
        guard let id = v["id"]?.stringValue, let s = v["startedAt"]?.doubleValue else { return nil }
        self.id = id; name = v["name"]?.stringValue ?? ""; startedAt = s; pausedAt = v["pausedAt"]?.doubleValue; pausedMs = v["pausedMs"]?.doubleValue ?? 0
    }
    public func elapsed(_ now: Double) -> Double { max(0, (pausedAt ?? now) - startedAt - pausedMs) }
}

public struct TimersInput: Sendable {
    public var timers: [TimerInfo]
    public var stopwatches: [StopwatchInfo]
    public var presets: [(id: String, name: String, durationMs: Double)]
    public var showInMenuBar: Bool
    public init(json v: JSONValue) {
        timers = v["timers"]?.arrayValue?.compactMap(TimerInfo.init) ?? []
        stopwatches = v["stopwatches"]?.arrayValue?.compactMap(StopwatchInfo.init) ?? []
        presets = v["presets"]?.arrayValue?.compactMap { p in
            guard let id = p["id"]?.stringValue, let d = p["durationMs"]?.doubleValue else { return nil }
            return (id, p["name"]?.stringValue ?? id, d)
        } ?? []
        showInMenuBar = v["settings"]?["showInMenuBar"]?.boolValue ?? true
    }
}

@MainActor public struct TimerActions {
    public var toggle: @MainActor (String) -> Void
    public var add: @MainActor (String, Double) -> Void
    public var stop: @MainActor (String) -> Void
    public var stopwatchToggle: @MainActor (String) -> Void
    public var stopwatchRemove: @MainActor (String) -> Void
    public var startPreset: @MainActor (String) -> Void
    public var show: @MainActor () -> Void
    public static var none: TimerActions { TimerActions(toggle: { _ in }, add: { _, _ in }, stop: { _ in }, stopwatchToggle: { _ in }, stopwatchRemove: { _ in }, startPreset: { _ in }, show: {}) }
}

@MainActor public enum ExtraSpecs {
    /// The soonest running timer, plus a count of the others (timers model trayTitleFor).
    public static func timersTitle(_ s: TimersInput, now: Double) -> String {
        let running = s.timers.filter { $0.pausedAt == nil }.sorted { $0.endsAt < $1.endsAt }
        if let next = running.first ?? s.timers.first {
            let more = s.timers.count > 1 ? " +\(s.timers.count - 1)" : ""
            return "⏱ \(MenuText.clock(next.remaining(now)))\(next.pausedAt != nil ? " ❚❚" : "")\(more)"
        }
        if let sw = s.stopwatches.first(where: { $0.pausedAt == nil }) { return "⏱ \(MenuText.clock(sw.elapsed(now), roundUp: false))" }
        return ""
    }

    public static func timerRows(_ s: TimersInput, now: Double, _ a: TimerActions, withCountdown: Bool) -> [MenuBarMenuItem] {
        var rows: [MenuBarMenuItem] = []
        for t in s.timers {
            let paused = t.pausedAt != nil
            let left = withCountdown ? " — \(MenuText.clock(t.remaining(now)))" : ""
            rows.append(MenuBarMenuItem(title: "\(t.label)\(left)", subtitle: paused ? "Paused" : "Ends \(MenuText.clockTime(t.endsAt))", icon: paused ? "pause.circle" : "timer", submenu: [
                MenuBarMenuItem(title: paused ? "Resume" : "Pause") { a.toggle(t.id) },
                MenuBarMenuItem(title: "Add 1 Minute") { a.add(t.id, 60_000) },
                MenuBarMenuItem(title: "Add 5 Minutes") { a.add(t.id, 300_000) },
                .separatorItem,
                MenuBarMenuItem(title: "Stop Timer") { a.stop(t.id) },
            ]))
        }
        for w in s.stopwatches {
            let paused = w.pausedAt != nil
            let elapsed = withCountdown ? " — \(MenuText.clock(w.elapsed(now), roundUp: false))" : ""
            rows.append(MenuBarMenuItem(title: "\(w.name.isEmpty ? "Stopwatch" : w.name)\(elapsed)", subtitle: paused ? "Paused" : "Running", icon: "stopwatch", submenu: [
                MenuBarMenuItem(title: paused ? "Resume" : "Pause") { a.stopwatchToggle(w.id) },
                .separatorItem,
                MenuBarMenuItem(title: "Remove Stopwatch") { a.stopwatchRemove(w.id) },
            ]))
        }
        return rows
    }

    /// Menu rows carry no ticking text, so the native menu is rebuilt only when timers start/stop/pause.
    public static func timers(_ s: TimersInput, now: Double, _ a: TimerActions) -> MenuBarItemSpec? {
        guard s.showInMenuBar, !(s.timers.isEmpty && s.stopwatches.isEmpty) else { return nil }
        let title = timersTitle(s, now: now)
        return MenuBarItemSpec(id: "timers", title: title.isEmpty ? "⏱" : title, tooltip: "Glide Timers", menu: timerRows(s, now: now, a, withCountdown: false) + [
            .separatorItem,
            MenuBarMenuItem(title: "Start Preset", submenu: s.presets.prefix(12).map { p in MenuBarMenuItem(title: p.name, subtitle: MenuText.clock(p.durationMs)) { a.startPreset(p.id) } }),
            MenuBarMenuItem(title: "Show Timers…", onClick: a.show),
        ])
    }

    // MARK: system monitor

    public static func sysmonTitle(cpu: Double, memory: SystemSample.Memory?) -> String {
        var parts = ["CPU \(MenuText.pct(cpu))"]
        if let m = memory, m.totalBytes > 0 { parts.append("MEM \(MenuText.pct(m.usedBytes / m.totalBytes))") }
        return parts.joined(separator: " · ")
    }

    public static func sysmon(_ s: SystemSample, open: @escaping @MainActor () -> Void) -> MenuBarItemSpec {
        var menu: [MenuBarMenuItem] = [.info("CPU \(MenuText.pct(s.cpu))", "\(s.cores) cores"), .info("Load " + s.load.map { String(format: "%.2f", $0) }.joined(separator: "  "))]
        if let m = s.memory, m.totalBytes > 0 { menu.append(.info("Memory \(MenuText.pct(m.usedBytes / m.totalBytes))", "\(MenuText.bytes(m.usedBytes)) of \(MenuText.bytes(m.totalBytes)) used")) }
        menu += [.separatorItem, MenuBarMenuItem(title: "Open System Monitor…", onClick: open)]
        return MenuBarItemSpec(id: "sysmon", title: sysmonTitle(cpu: s.cpu, memory: s.memory), tooltip: "Glide System Monitor", menu: menu)
    }

    // MARK: next meeting

    public struct Event: Sendable, Equatable {
        public var title: String, start: Double, end: Double, allDay: Bool, location: String?, calendar: String?, meetingURL: String?, provider: String?
        public init(title: String, start: Double, end: Double, allDay: Bool = false, location: String? = nil, calendar: String? = nil, meetingURL: String? = nil, provider: String? = nil) {
            self.title = title; self.start = start; self.end = end; self.allDay = allDay; self.location = location; self.calendar = calendar; self.meetingURL = meetingURL; self.provider = provider
        }
        static func ms(_ v: JSONValue?) -> Double? {
            if let d = v?.doubleValue { return d }
            guard let s = v?.stringValue else { return nil }
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) { return d.timeIntervalSince1970 * 1000 }
            f.formatOptions = [.withInternetDateTime]
            return f.date(from: s).map { $0.timeIntervalSince1970 * 1000 }
        }
        init?(_ v: JSONValue) {
            guard let s = Self.ms(v["start"]), let e = Self.ms(v["end"]) else { return nil }
            self.init(title: v["title"]?.stringValue ?? "Event", start: s, end: e, allDay: v["allDay"]?.boolValue ?? false, location: v["location"]?.stringValue,
                      calendar: v["calendar"]?.stringValue, meetingURL: v["meeting"]?["url"]?.stringValue, provider: v["meeting"]?["provider"]?.stringValue)
        }
    }

    public struct Schedule: Sendable {
        public var status: String
        public var message: String?
        public var events: [Event]
        public init(status: String, message: String? = nil, events: [Event] = []) { self.status = status; self.message = message; self.events = events }
        public init(json v: JSONValue) {
            status = v["status"]?.stringValue ?? (v["events"] != nil ? "ok" : "error")
            message = v["message"]?.stringValue
            events = v["events"]?.arrayValue?.compactMap(Event.init) ?? []
        }
    }

    public struct MeetingActions {
        public var join: @MainActor (String) -> Void
        public var openCalendar: @MainActor (Double) -> Void
        public var schedule: @MainActor () -> Void
        public var requestAccess: @MainActor () -> Void
        public var refresh: @MainActor () -> Void
        public static var none: MeetingActions { MeetingActions(join: { _ in }, openCalendar: { _ in }, schedule: {}, requestAccess: {}, refresh: {}) }
    }

    public static func todaysEvents(_ events: [Event], now: Double) -> [Event] {
        let cal = Calendar.current
        let today = Date(timeIntervalSince1970: now / 1000)
        return events.filter { cal.isDate(Date(timeIntervalSince1970: $0.start / 1000), inSameDayAs: today) || ($0.start <= now && $0.end > now) }
    }

    public static func nextEvent(_ events: [Event], now: Double) -> Event? {
        todaysEvents(events, now: now).filter { !$0.allDay && $0.end > now }.sorted { $0.start < $1.start }.first
    }

    /// "now", "in 5m", "in 1h 20m".
    public static func until(_ start: Double, now: Double) -> String {
        let mins = Int(((start - now) / 60_000).rounded(.up))
        if mins <= 0 { return "now" }
        if mins < 60 { return "in \(mins)m" }
        let h = mins / 60, m = mins % 60
        return m > 0 ? "in \(h)h \(m)m" : "in \(h)h"
    }

    public static func meetingTitle(_ events: [Event], now: Double) -> String {
        guard let e = nextEvent(events, now: now) else { return "" }
        return "\(MenuText.truncate(e.title.isEmpty ? "Event" : e.title, 18)) \(until(e.start, now: now))"
    }

    public static func meeting(_ r: Schedule?, now: Double, _ a: MeetingActions) -> MenuBarItemSpec {
        let footer: [MenuBarMenuItem] = [.separatorItem, MenuBarMenuItem(title: "Open My Schedule…", onClick: a.schedule), MenuBarMenuItem(title: "Refresh", onClick: a.refresh)]
        guard let r else { return MenuBarItemSpec(id: "meeting", icon: "calendar", tooltip: "Next Meeting", menu: [.info("Loading calendar…")] + footer) }
        guard r.status == "ok" else {
            let fix: [MenuBarMenuItem] = r.status == "notDetermined" ? [MenuBarMenuItem(title: "Grant Calendar Access…", onClick: a.requestAccess)] : []
            return MenuBarItemSpec(id: "meeting", icon: "calendar", tooltip: "Next Meeting", menu: [.info(r.message ?? "Calendar unavailable")] + fix + footer)
        }
        let today = todaysEvents(r.events, now: now)
        let next = nextEvent(r.events, now: now)
        let rows: [MenuBarMenuItem] = today.map { e in
            let when = e.allDay ? "All day" : MenuText.clockTime(e.start)
            let ended = !e.allDay && e.end <= now
            var item = MenuBarMenuItem(title: "\(when)  \(MenuText.truncate(e.title.isEmpty ? "Event" : e.title, 40))",
                                       subtitle: e.meetingURL != nil ? "Join \(e.provider ?? "meeting")" : (e.location.map { MenuText.truncate($0, 40) } ?? e.calendar),
                                       icon: e.meetingURL != nil ? "video" : nil, enabled: ended ? false : nil)
            if let url = e.meetingURL { item.onClick = { a.join(url) } } else { let s = e.start; item.onClick = { a.openCalendar(s) } }
            return item
        }
        var head: [MenuBarMenuItem] = []
        if let n = next, let url = n.meetingURL {
            head = [MenuBarMenuItem(title: "Join “\(MenuText.truncate(n.title, 30))”", subtitle: n.provider, icon: "video", shortcut: "CommandOrControl+J") { a.join(url) }, .separatorItem]
        }
        return MenuBarItemSpec(id: "meeting", title: meetingTitle(r.events, now: now), icon: "calendar",
                               tooltip: next.map { "\($0.title) · \(MenuText.clockTime($0.start))" } ?? "No more events today",
                               menu: head + [.info("Today")] + (rows.isEmpty ? [.info("No events today")] : rows) + footer)
    }

    // MARK: clipboard

    static let clipIcons = ["text": "doc.text", "image": "photo", "link": "link", "color": "paintpalette", "file": "folder"]

    public static func clipboard(_ entries: [JSONValue], paste: @escaping @MainActor (String) -> Void, open: @escaping @MainActor () -> Void) -> MenuBarItemSpec {
        let rows: [MenuBarMenuItem] = entries.prefix(10).enumerated().compactMap { i, e in
            guard let id = e["id"]?.stringValue else { return nil }
            let title = e["title"]?.stringValue ?? ""
            return MenuBarMenuItem(title: MenuText.truncate(title.isEmpty ? "(empty)" : title, 48),
                                   icon: e["pinned"]?.boolValue == true ? "pin" : clipIcons[e["type"]?.stringValue ?? "text"] ?? "doc.text",
                                   shortcut: "CommandOrControl+\((i + 1) % 10)") { paste(id) }
        }
        return MenuBarItemSpec(id: "clipboard", icon: "doc.on.clipboard", tooltip: "Glide Clipboard",
                               menu: [.info("Paste from History")] + (rows.isEmpty ? [.info("Nothing copied yet")] : rows) + [.separatorItem, MenuBarMenuItem(title: "Open Clipboard History…", onClick: open)])
    }

    // MARK: agent

    public static let agentSuggestions = ["Arrange my windows side by side", "Start a 25 minute focus timer", "Summarize what’s on my clipboard"]

    public static func agent(_ run: JSONValue?, ask: @escaping @MainActor (String?) -> Void, cancel: @escaping @MainActor (String) -> Void) -> MenuBarItemSpec {
        let status = run?["status"]?.stringValue
        let busy = status == "running" || status == "confirming"
        var menu: [MenuBarMenuItem] = []
        if busy, let runId = run?["runId"]?.stringValue {
            menu = [.info(status == "confirming" ? "Waiting for your approval" : "Working…", MenuText.truncate(run?["prompt"]?.stringValue ?? "", 48)),
                    MenuBarMenuItem(title: status == "confirming" ? "Review…" : "Show Run…") { ask(nil) },
                    MenuBarMenuItem(title: "Cancel Run") { cancel(runId) }, .separatorItem]
        }
        menu += [MenuBarMenuItem(title: "Ask Glide Agent…") { ask(nil) },
                 MenuBarMenuItem(title: "Try", submenu: agentSuggestions.map { p in MenuBarMenuItem(title: p) { ask(p) } })]
        return MenuBarItemSpec(id: "agent", title: busy ? "…" : "", icon: "wand.and.stars", tooltip: "Glide Agent", menu: menu)
    }
}
