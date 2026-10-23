import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem
import Testing

@Suite("color: parse/format (colors.test.ts port)")
struct ColorModelTests {
    @Test func parse() throws {
        #expect(ColorMath.parse("#f80") == ColorRGBA(r: 255, g: 136, b: 0))
        #expect(ColorMath.parse("#FF8800") == ColorRGBA(r: 255, g: 136, b: 0))
        #expect(ColorMath.parse("#ff880080")?.a == 0.5)
        #expect(ColorMath.parse("rgb(255, 136, 0)") == ColorRGBA(r: 255, g: 136, b: 0))
        #expect(ColorMath.parse("rgba(255 136 0 / 50%)")?.a == 0.5)
        #expect(ColorMath.parse("hsl(32, 100%, 50%)") == ColorRGBA(r: 255, g: 136, b: 0))
        #expect(ColorMath.parse("hsl(32, 100, 50)") == nil)
        #expect(ColorMath.parse("#ggg") == nil)
        #expect(ColorMath.parse("tomato") == nil)
    }

    @Test func formats() throws {
        let c = try #require(ColorMath.parse("#ff8800"))
        #expect(ColorMath.format(c, .hex) == "#FF8800")
        #expect(ColorMath.format(c, .hexLower) == "#ff8800")
        #expect(ColorMath.format(c, .rgb) == "rgb(255, 136, 0)")
        #expect(ColorMath.format(c, .hsl) == "hsl(32, 100%, 50%)")
        #expect(ColorMath.format(c, .swiftui) == "Color(red: 1, green: 0.533, blue: 0)")
        #expect(ColorMath.format(c, .nscolor) == "NSColor(srgbRed: 1, green: 0.533, blue: 0, alpha: 1)")
        #expect(ColorMath.format(c, .css) == "color: #ff8800;")
        let half = ColorRGBA(r: 255, g: 136, b: 0, a: 0.5)
        #expect(ColorMath.format(half, .hex) == "#FF880080")
        #expect(ColorMath.format(half, .rgb) == "rgba(255, 136, 0, 0.5)")
        #expect(ColorMath.luminance(ColorRGBA(r: 255, g: 255, b: 255)) > 0.99)
    }

    @Test func historyDedupesAndCaps() {
        var h: [ColorEntry] = []
        for i in 0..<70 { h = ColorEntry.add(h, ColorRGBA(r: Double(i), g: 0, b: 0), source: "search", now: Double(i)) }
        #expect(h.count == 60)
        h = ColorEntry.add(h, ColorRGBA(r: 65, g: 0, b: 0), source: "picker", now: 100)
        #expect(h.first?.hex == "#410000" && h.count == 60 && h.filter { $0.hex == "#410000" }.count == 1)
        // Electron history.json shape round-trips.
        let v = N7JSON.value(h)
        #expect(ColorEntry.load(v) == h)
    }
}

@Suite("color: feature", .serialized)
@MainActor struct ColorFeatureTests {
    @Test func swatchRowCopyAndPickerFake() async throws {
        let ctx = N7TestContext("color")
        defer { ctx.cleanup() }
        let f = ColorFeature()
        await f.start(context: ctx)
        let rows = await f.dynamicItems(for: DynamicQuery(text: "rgb(255, 136, 0)", deadline: .now + .seconds(1)))
        let swatch = try #require(rows.first)
        #expect(swatch.item.title == "#FF8800")
        #expect(swatch.item.icon?.kind == "color")
        #expect(await f.dynamicItems(for: DynamicQuery(text: "#ff", deadline: .now + .seconds(1))).isEmpty)
        #expect(await f.run(action: "copy:hsl", on: swatch, modifiers: []) == .hide(message: "Copied hsl(32, 100%, 50%)"))
        #expect(ctx.services.pasteboard.string() == "hsl(32, 100%, 50%)")
        _ = await f.run(action: "save", on: swatch, modifiers: [])
        #expect(f.history.first?.hex == "#FF8800")
        // Pick Color uses the headless fake sampler (NSColorSampler is never shown in tests).
        _ = await f.pick()
        #expect(ctx.effects("color-pick").count == 1)
        #expect(f.history.first?.hex == "#F5A524")
        #expect(N7JSON.read(ctx.dataDirectory().appendingPathComponent("history.json"))?.arrayValue?.count == 2)
    }
}

@Suite("notes: model + feature")
@MainActor struct NotesTests {
    @Test func model() {
        #expect(NotesModel.title(of: "# Groceries\n- milk") == "Groceries")
        #expect(NotesModel.title(of: "\n\n- [x] done thing") == "done thing")
        #expect(NotesModel.title(of: "   ") == "Untitled Note")
        let a = Note(id: "a", body: "Alpha\nmilk and eggs", createdAt: 1, updatedAt: 5)
        let b = Note(id: "b", body: "Milk run\nshop", createdAt: 2, updatedAt: 3)
        #expect(NotesModel.search([a, b], "milk").map(\.id) == ["b", "a"]) // title prefix beats body
        #expect(NotesModel.search([a, b], "").map(\.id) == ["a", "b"])
        var f = NotesFile(notes: [a, b], currentId: "a")
        f = NotesModel.delete(f, id: "a")
        #expect(f.currentId == "b")
        #expect(NotesModel.cycle(NotesFile(notes: [a, b], currentId: "b"), delta: 1) == "a")
        let s = NotesModel.sanitize(["notes": [["id": "x", "body": "hi", "createdAt": 1, "updatedAt": 2], ["id": 3]], "currentId": "nope", "bounds": ["x": 1, "y": 2, "width": 300, "height": 200]])
        #expect(s.notes.count == 1 && s.currentId == "x" && s.bounds?.width == 300)
    }

    @Test func featureCreateSearchDeletePersists() async throws {
        let ctx = N7TestContext("notes")
        defer { ctx.cleanup() }
        let f = NotesFeature()
        await f.start(context: ctx)
        let host = N7TestHost()
        f.searchModel.hostOverride = host
        host.query = "Shopping list"
        let create = try #require(f.searchModel.rows().last)
        #expect(create.title == "Create Note “Shopping list”")
        #expect(f.searchModel.handle(.goto(.last)))
        #expect(f.searchModel.handle(.activate([])))
        try await Task.sleep(for: .milliseconds(50))
        #expect(f.data.notes.first?.body == "Shopping list")
        #expect(f.panelEvents.first?.hasPrefix("show:note-") == true) // headless: the panel is never shown
        f.writeNow()
        let raw = try #require(N7JSON.read(ctx.dataDirectory().appendingPathComponent("notes.json")))
        #expect(raw["notes"]?.arrayValue?.first?["body"]?.stringValue == "Shopping list")
        #expect(raw["currentId"]?.stringValue == f.data.notes.first?.id)
        host.query = "shopping"
        #expect(f.searchModel.rows().first?.title == "Shopping list")
        // ⌘K opens the row's action panel; ⌃X twice deletes.
        #expect(f.searchModel.handle(.actions))
        #expect(f.searchModel.panel?.actions.map(\.title) == ["Open in Floating Notes", "Copy Note Text", "Paste Note Text", "Delete Note"])
        #expect(f.searchModel.handleKey(.init("Escape")))
        #expect(f.searchModel.handleKey(.init("x", ctrl: true)))
        #expect(f.data.notes.count == 1)
        #expect(f.searchModel.handleKey(.init("x", ctrl: true)))
        try await Task.sleep(for: .milliseconds(50))
        #expect(f.data.notes.isEmpty)
    }
}

@Suite("calendar: links (links.test.ts port)")
struct CalendarLinksTests {
    @Test func meetingLinks() {
        #expect(CalendarLinks.findMeetingLink("Join https://us02web.zoom.us/j/123456?pwd=abc.")?.url == "https://us02web.zoom.us/j/123456?pwd=abc")
        #expect(CalendarLinks.findMeetingLink("https://meet.google.com/abc-defg-hij")?.provider == "Google Meet")
        #expect(CalendarLinks.findMeetingLink("https://teams.microsoft.com/l/meetup-join/19%3a")?.provider == "Microsoft Teams")
        #expect(CalendarLinks.findMeetingLink("https://example.com/agenda and zoom.us homepage") == nil)
        #expect(CalendarLinks.findMeetingLink(nil) == nil)
        #expect(CalendarLinks.findMeetingLink("backup https://meet.google.com/aaa-bbbb-ccc primary? no: https://zoom.us/j/1")?.provider == "Google Meet")
        #expect(CalendarLinks.meetingLink(url: "https://zoom.us/j/1", location: "https://meet.google.com/x-y-z", notes: "")?.provider == "Zoom")
        #expect(CalendarLinks.meetingLink(url: nil, location: "Room 4", notes: "Dial in https://meet.google.com/x-y-z")?.provider == "Google Meet")
        #expect(CalendarLinks.meetingLink(url: nil, location: "Room 4", notes: nil) == nil)
    }

    func ev(_ startMin: Double, _ endMin: Double, allDay: Bool = false, now: Date) -> CalendarEvent {
        CalendarEvent(id: "e", title: "E", start: RemindersModel.iso(now.addingTimeInterval(startMin * 60)), end: RemindersModel.iso(now.addingTimeInterval(endMin * 60)), allDay: allDay, calendar: "Work")
    }

    @Test func joinable() {
        let now = localDate(2026, 10, 21, 10)
        #expect(CalendarLinks.isJoinable(ev(5, 35, now: now), now: now))
        #expect(CalendarLinks.isJoinable(ev(-10, 20, now: now), now: now))
        #expect(!CalendarLinks.isJoinable(ev(11, 40, now: now), now: now))
        #expect(!CalendarLinks.isJoinable(ev(-40, -1, now: now), now: now))
        #expect(!CalendarLinks.isJoinable(ev(-10, 20, allDay: true, now: now), now: now))
        #expect(CalendarLinks.startsInLabel(ev(4.4, 30, now: now), now: now) == "Starts in 4 min")
        #expect(CalendarLinks.startsInLabel(ev(-5, 25, now: now), now: now) == "Now · 25 min left")
        for q in ["", "j", "jo", "join", "meet", "meeting", "join standup"] { #expect(CalendarLinks.matchesJoinQuery(q)) }
        for q in ["safari", "xy"] { #expect(!CalendarLinks.matchesJoinQuery(q)) }
    }

    @Test func dayKeys() {
        let from = localDate(2026, 10, 19), to = localDate(2026, 10, 27)
        func e(_ s: Date, _ en: Date, _ allDay: Bool) -> CalendarEvent { CalendarEvent(id: "x", title: "x", start: RemindersModel.iso(s), end: RemindersModel.iso(en), allDay: allDay, calendar: "") }
        #expect(CalendarLinks.dayKeys(e(localDate(2026, 10, 20, 9), localDate(2026, 10, 20, 10), false), from: from, to: to) == [localDate(2026, 10, 20)])
        #expect(CalendarLinks.dayKeys(e(localDate(2026, 10, 20), localDate(2026, 10, 22), true), from: from, to: to) == [localDate(2026, 10, 20), localDate(2026, 10, 21)])
        #expect(CalendarLinks.dayKeys(e(localDate(2026, 10, 10), localDate(2026, 10, 20, 12), false), from: from, to: to) == [localDate(2026, 10, 19), localDate(2026, 10, 20)])
    }
}

@Suite("calendar: feature with an in-memory EventKit", .serialized)
@MainActor struct CalendarFeatureTests {
    @Test func joinRowsAndSchedule() async throws {
        let ctx = N7TestContext("calendar")
        defer { ctx.cleanup() }
        let now = Date()
        let ek = FixtureEventKit(seed: ["events": [
            ["id": "e1", "title": "Standup", "start": .string(RemindersModel.iso(now.addingTimeInterval(120))), "end": .string(RemindersModel.iso(now.addingTimeInterval(1020))),
             "allDay": false, "calendar": "Work", "notes": "https://meet.google.com/abc-defg-hij"],
            ["id": "e2", "title": "Lunch", "start": .string(RemindersModel.iso(now.addingTimeInterval(7200))), "end": .string(RemindersModel.iso(now.addingTimeInterval(9000))),
             "allDay": false, "calendar": "Home", "location": "Cafe"],
        ]])
        let f = CalendarFeature()
        f.eventKitOverride = ek
        await f.start(context: ctx)
        await f.refresh()
        let join = await f.dynamicItems(for: DynamicQuery(text: "join", deadline: .now + .seconds(1)))
        #expect(join.map(\.item.title) == ["Join Standup"])
        #expect(join.first?.item.kindLabel == "Google Meet")
        _ = await f.run(action: "join", on: try #require(join.first), modifiers: [])
        #expect(ctx.effects("open-url").first?["url"]?.stringValue == "https://meet.google.com/abc-defg-hij")
        let rows = f.scheduleRows("")
        #expect(rows.map(\.title).prefix(2) == ["Standup", "Lunch"] || rows.map(\.title).contains("Lunch"))
        #expect(rows.first?.actions.first?.title == "Join Google Meet Meeting")
        #expect(f.scheduleRows("cafe").map(\.title) == ["Lunch"])
    }
}
