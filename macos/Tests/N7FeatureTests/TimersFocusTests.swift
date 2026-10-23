import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

private let MIN = 60_000.0

@Suite("timers: model (model.test.ts port)")
struct TimersModelTests {
    @Test func parseDuration() {
        #expect(TimersModel.parseDuration("25m") == 25 * MIN)
        #expect(TimersModel.parseDuration("25 min") == 25 * MIN)
        #expect(TimersModel.parseDuration("1h30m") == 90 * MIN)
        #expect(TimersModel.parseDuration("1 h 30 min") == 90 * MIN)
        #expect(TimersModel.parseDuration("1 hour and 15 minutes") == 75 * MIN)
        #expect(TimersModel.parseDuration("1.5h") == 90 * MIN)
        #expect(TimersModel.parseDuration("90s") == 90_000)
        #expect(TimersModel.parseDuration("5:00") == 5 * MIN)
        #expect(TimersModel.parseDuration("1:30:00") == 90 * MIN)
        #expect(TimersModel.parseDuration("10") == 10 * MIN)
        #expect(TimersModel.parseDuration("tea") == nil)
        #expect(TimersModel.parseDuration("0m") == nil)
        #expect(TimersModel.parseDuration("10 mangoes") == nil)
    }

    @Test func durationAndName() {
        func p(_ s: String) -> String? { TimersModel.parseDurationAndName(s).map { "\(Int($0.ms))|\($0.name)" } }
        #expect(p("10 min tea") == "\(Int(10 * MIN))|tea")
        #expect(p("for 25m deep work") == "\(Int(25 * MIN))|deep work")
        #expect(p("tea 3m") == "\(Int(3 * MIN))|tea")
        #expect(p("pasta for 11 minutes") == "\(Int(11 * MIN))|pasta")
        #expect(p("tea") == nil)
    }

    @Test func rootPhrases() {
        func p(_ s: String) -> String? { TimersModel.parseTimerQuery(s).map { "\(Int($0.ms))|\($0.name)" } }
        #expect(p("timer 25m") == "\(Int(25 * MIN))|")
        #expect(p("Start Timer 25m") == "\(Int(25 * MIN))|")
        #expect(p("timer 10m tea") == "\(Int(10 * MIN))|tea")
        #expect(p("timer 10 min tea") == "\(Int(10 * MIN))|tea")
        #expect(p("set a timer for 5 minutes") == "\(Int(5 * MIN))|")
        #expect(p("25m timer") == "\(Int(25 * MIN))|")
        #expect(p("timer") == nil)
        #expect(p("timers") == nil)
        #expect(p("egg timer") == nil)
    }

    @Test func countdownPauseResumeExtend() {
        var t = TimersModel.createTimer(now: 0, durationMs: 10 * MIN, name: " tea ")
        #expect(t.name == "tea")
        #expect(TimersModel.remaining(t, now: 4 * MIN) == 6 * MIN)
        t = TimersModel.pause(t, now: 4 * MIN)
        #expect(TimersModel.remaining(t, now: 100 * MIN) == 6 * MIN)
        #expect(TimersModel.endsAt(t) == .infinity)
        #expect(!TimersModel.isDone(t, now: 100 * MIN))
        t = TimersModel.resume(t, now: 10 * MIN)
        #expect(TimersModel.remaining(t, now: 10 * MIN) == 6 * MIN)
        #expect(TimersModel.endsAt(t) == 16 * MIN)
        t = TimersModel.addTime(t, ms: MIN)
        #expect(TimersModel.endsAt(t) == 17 * MIN)
        #expect(TimersModel.isDone(t, now: 17 * MIN))
        #expect(TimersModel.remaining(TimersModel.restart(t, now: 20 * MIN), now: 20 * MIN) == 11 * MIN)
    }

    @Test func trayTitleAndLaps() {
        let a = TimersModel.createTimer(now: 0, durationMs: 25 * MIN, name: "a")
        let b = TimersModel.createTimer(now: 0, durationMs: 3 * MIN, name: "b")
        #expect(TimersModel.trayTitle(TimersData(timers: [a, b]), now: 0) == "⏱ 3:00 +1")
        #expect(TimersModel.trayTitle(TimersData(timers: [TimersModel.toggle(a, now: 60_000)]), now: 120_000) == "⏱ 24:00 ❚❚")
        #expect(TimersModel.trayTitle(TimersData(stopwatches: [TimersModel.createStopwatch(now: 0, name: "")]), now: 65_000) == "⏱ 1:05")
        var s = TimersModel.createStopwatch(now: 0, name: "run")
        s = TimersModel.lap(s, now: 10_000)
        s = TimersModel.lap(s, now: 25_000)
        #expect(TimersModel.splits(s) == [10_000, 15_000])
        #expect(TimersModel.formatStopwatch(62_345) == "1:02.3")
        #expect(TimersModel.formatDuration(90 * MIN) == "1 h 30 min")
    }

    @Test func reviveAndElectronFileCompatibility() throws {
        // A timers.json as the Electron app writes it (pausedAt null, presets customised).
        let json = #"{"timers":[{"id":"t-a","name":"a","durationMs":60000,"startedAt":0,"pausedAt":null,"pausedMs":0},{"id":"t-b","name":"b","durationMs":600000,"startedAt":100000,"pausedAt":null,"pausedMs":0},{"id":"t-p","name":"paused","durationMs":60000,"startedAt":0,"pausedAt":30000,"pausedMs":0}],"stopwatches":[{"id":"s-1","name":"","startedAt":0,"pausedAt":null,"pausedMs":0,"laps":[1000]}],"presets":[{"id":"x","name":"Mine","durationMs":120000}]}"#
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let (data, finished) = TimersModel.load(raw, now: 200_000)
        #expect(data.timers.map(\.name) == ["b", "paused"])
        #expect(finished.map(\.name) == ["a"])
        #expect(data.presets.map(\.name) == ["Mine"])
        #expect(data.stopwatches.first?.laps == [1000])
        // Round trip keeps the Electron shape (pausedAt written as null).
        let out = String(decoding: try JSONEncoder().encode(data), as: UTF8.self)
        #expect(out.contains("\"pausedAt\":null"))
    }
}

@Suite("timers: feature (fake clock, notifications recorded, never posted)", .serialized)
@MainActor struct TimersFeatureTests {
    @Test func naturalLanguageStartPersistAndNotify() async throws {
        let ctx = N7TestContext("timers")
        defer { ctx.cleanup() }
        var clock = 1_000_000.0
        let f = TimersFeature()
        f.now = { clock }
        await f.start(context: ctx)
        let rows = await f.dynamicItems(for: DynamicQuery(text: "timer 10m tea", deadline: .now + .seconds(1)))
        let quick = try #require(rows.first)
        #expect(quick.item.title == "Start 10 min · tea Timer")
        let r = await f.run(action: "quick", on: quick, modifiers: [])
        #expect(r == .hide(message: "tea started — 10:00"))
        // Persisted in the Electron format.
        let file = ctx.dataDirectory().appendingPathComponent("timers.json")
        let saved = try #require(N7JSON.read(file))
        #expect(saved["timers"]?.arrayValue?.first?["name"]?.stringValue == "tea")
        #expect(saved["timers"]?.arrayValue?.first?["durationMs"]?.number == 600_000)
        // Reload in a fresh instance (restart).
        let g = TimersFeature()
        g.now = { clock }
        await g.start(context: ctx)
        #expect(g.data.timers.count == 1)
        // Done → notification through NotificationService (headless: recorded only).
        clock += 600_001
        g.tick()
        #expect(g.data.timers.isEmpty)
        #expect(g.notified == ["⏱ tea is done"])
        #expect(ctx.effects("notify").count == 1)
        // A timer that finished while Glide was closed notifies on the next launch.
        _ = g.startTimer(60_000, "egg")
        clock += 120_000
        let h = TimersFeature()
        h.now = { clock }
        await h.start(context: ctx)
        #expect(h.notified == ["⏱ egg is done"])
    }

    @Test func listViewLapsAndPresetsViaVim() async throws {
        let ctx = N7TestContext("timers")
        defer { ctx.cleanup() }
        let clock = 5_000_000.0
        let f = TimersFeature()
        f.now = { clock }
        await f.start(context: ctx)
        let host = N7TestHost()
        f.listModel.hostOverride = host
        var rows = f.listModel.rows()
        #expect(rows.first?.title == "Start Stopwatch")
        #expect(rows.contains { $0.title == "Pomodoro" })
        host.query = "5m pasta"
        rows = f.listModel.rows()
        #expect(rows.first?.title == "Start 5 min Timer “pasta”")
        #expect(f.listModel.handle(.activate([])))
        try await Task.sleep(for: .milliseconds(50))
        #expect(f.data.timers.first?.name == "pasta")
        host.query = ""
        // j → second row… G → last preset; ⌃X twice deletes it.
        #expect(f.listModel.handle(.goto(.last)))
        let last = try #require(f.listModel.selectedRow())
        #expect(last.title == "1 Hour")
        #expect(f.listModel.handleKey(.init("x", ctrl: true)))
        #expect(f.listModel.handleKey(.init("x", ctrl: true)))
        try await Task.sleep(for: .milliseconds(50))
        #expect(!f.data.presets.contains { $0.name == "1 Hour" })
    }
}

@Suite("focus: machine (machine.test.ts port)")
struct FocusMachineTests {
    @Test func pauseResumeExtendFinish() {
        var s = FocusMachine.start(now: 0, goal: " write ", minutes: 25)
        #expect(s.goal == "write" && s.durationMs == 25 * MIN)
        #expect(FocusMachine.remaining(s, now: 10 * MIN) == 15 * MIN)
        s = FocusMachine.pause(s, now: 10 * MIN)
        #expect(FocusMachine.remaining(s, now: 50 * MIN) == 15 * MIN)
        s = FocusMachine.resume(s, now: 50 * MIN)
        #expect(FocusMachine.remaining(s, now: 55 * MIN) == 10 * MIN)
        s = FocusMachine.extend(s, now: 55 * MIN, minutes: 5)
        #expect(FocusMachine.remaining(s, now: 55 * MIN) == 15 * MIN)
        #expect(FocusMachine.extend(s, now: 55 * MIN, minutes: -100).durationMs == 16 * MIN) // floor: elapsed + 1 min
        let rec = FocusMachine.finish(s, now: 200 * MIN)
        #expect(rec.completed && rec.focusedMs == s.durationMs)
        #expect(FocusMachine.formatClock(5 * MIN) == "05:00")
        #expect(FocusMachine.formatDuration(90 * MIN) == "1 h 30 min")
    }

    @Test func sitesAppsAndPrefixes() {
        #expect(FocusMachine.normalizeSite("https://www.YouTube.com/watch?v=1") == "youtube.com")
        #expect(FocusMachine.normalizeSite("not a site") == "")
        #expect(FocusMachine.siteMatches("https://m.youtube.com/x", ["youtube.com"]) == "youtube.com")
        #expect(FocusMachine.siteMatches("https://notyoutube.com", ["youtube.com"]) == nil)
        #expect(FocusMachine.appMatches(name: "Slack", bundleId: "com.tinyspeck.slackmacgap", [BlockedApp(name: "slack")])?.name == "slack")
        #expect(FocusMachine.appMatches(name: "Other", bundleId: "a.b", [BlockedApp(name: "Other", bundleId: "c.d")]) == nil)
        #expect(FocusMachine.parseDurationPrefix("45m write report").map { "\($0.minutes)|\($0.goal)" } == "45|write report")
        #expect(FocusMachine.parseDurationPrefix("1h deep work")?.minutes == 60)
        #expect(FocusMachine.parseDurationPrefix("30")?.minutes == 30)
        #expect(FocusMachine.parseDurationPrefix("3 little pigs") == nil)
    }

    @Test func stats() {
        let now = localDate(2026, 10, 21, 12).timeIntervalSince1970 * 1000 // Wednesday
        let mk = { (d: Date, ms: Double, done: Bool) in FocusRecord(id: UUID().uuidString, goal: "", startedAt: d.timeIntervalSince1970 * 1000, endedAt: 0, focusedMs: ms, plannedMs: ms, completed: done) }
        let st = FocusMachine.stats([mk(localDate(2026, 10, 21, 9), 25 * MIN, true), mk(localDate(2026, 10, 19, 9), 50 * MIN, false), mk(localDate(2026, 10, 18, 9), 10 * MIN, true)], now: now)
        #expect(st.todayMs == 25 * MIN && st.sessionsToday == 1)
        #expect(st.weekMs == 75 * MIN && st.sessionsWeek == 2 && st.completedWeek == 1) // week starts Monday 19th
        #expect(st.last7.count == 7 && st.last7.last?.ms == 25 * MIN)
    }
}

@Suite("focus: feature", .serialized)
@MainActor struct FocusFeatureTests {
    @Test func startStopPersistsElectronShape() async throws {
        let ctx = N7TestContext("focus")
        defer { ctx.cleanup() }
        var clock = 1_000_000.0
        let f = FocusFeature()
        f.now = { clock }
        await f.start(context: ctx)
        f.setSettings(["blockedSites": ["https://www.youtube.com/", "bad"], "dndOnShortcut": "Focus On"])
        let r = await f.start(goal: "write", minutes: 25)
        #expect(r == .hide(message: "Focusing for 25 min"))
        #expect(f.session?.blockedSites == ["youtube.com"])
        // DND shortcut goes through ScriptService (recorded, never run, in headless).
        #expect(ctx.effects("shell").first?["command"]?.stringValue == "/usr/bin/shortcuts run 'Focus On'")
        let raw = try #require(N7JSON.read(ctx.dataDirectory().appendingPathComponent("focus.json")))
        #expect(raw["session"]?["goal"]?.stringValue == "write")
        clock += 25 * MIN
        f.tick()
        try await Task.sleep(for: .milliseconds(50))
        #expect(f.session == nil)
        #expect(f.history.first?.completed == true)
        #expect(f.notified == ["Focus session complete"])
    }
}
