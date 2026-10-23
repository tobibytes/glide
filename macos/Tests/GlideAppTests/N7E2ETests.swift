import AppKit
import Foundation
import GlideTestHarness
import Testing

/// N7 headless driver checks: Notes, Timers, Focus, Calendar, Reminders, Color, OCR, Browser through the real
/// binary. Calendar/Reminders use an in-memory EventKit fixture, Browser a synthetic fixture home, OCR a
/// generated image — nothing of the user's data is read and nothing reaches the screen.
private func n7Rows(_ s: [String: Any]) -> [[String: Any]] { (s["rows"] as? [[String: Any]]) ?? [] }
private func n7Titles(_ s: [String: Any]) -> [String] { n7Rows(s).compactMap { $0["title"] as? String } }
private func result(_ r: [String: Any]) -> [String: Any] { r["result"] as? [String: Any] ?? [:] }
private func viewState(_ d: GlideDriver, _ feature: String, _ view: String? = nil) throws -> [String: Any] {
    result(try d.invoke(feature, "viewState", view.map { ["view": $0] } ?? NSNull()))
}
private func snap(_ d: GlideDriver, _ name: String) throws -> String {
    try FileManager.default.createDirectory(atPath: snapshotDir, withIntermediateDirectories: true)
    let path = (snapshotDir as NSString).appendingPathComponent("n7-\(name).png")
    let r = try d.snapshot(path)
    #expect((r["width"] as? Int ?? 0) > 0)
    return path
}

private func tempDir(_ name: String) throws -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("n7-e2e-\(name)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

private func eventKitFixture() throws -> URL {
    let now = Date()
    let iso = ISO8601DateFormatter()
    let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now)) ?? now
    let json: [String: Any] = [
        "lists": [["id": "L1", "title": "Reminders", "isDefault": true, "writable": true, "color": "#ff9f0a"], ["id": "L2", "title": "Work", "isDefault": false, "writable": true, "color": "#0a84ff"]],
        "reminders": [["id": "r1", "title": "Pay rent", "completed": false, "priority": 1, "listId": "L1", "listTitle": "Reminders", "due": iso.string(from: now.addingTimeInterval(-3600))],
                      ["id": "r2", "title": "Review PR", "completed": false, "priority": 0, "listId": "L2", "listTitle": "Work", "due": iso.string(from: tomorrow), "dueAllDay": true],
                      ["id": "r3", "title": "Buy stamps", "completed": false, "priority": 0, "listId": "L1", "listTitle": "Reminders"]],
        "events": [["id": "e1", "title": "Standup", "start": iso.string(from: now.addingTimeInterval(180)), "end": iso.string(from: now.addingTimeInterval(1080)), "allDay": false,
                    "calendar": "Work", "color": "#0a84ff", "url": "https://meet.google.com/abc-defg-hij"],
                   ["id": "e2", "title": "Design review", "start": iso.string(from: tomorrow.addingTimeInterval(14 * 3600)), "end": iso.string(from: tomorrow.addingTimeInterval(15 * 3600)),
                    "allDay": false, "calendar": "Work", "color": "#bf5af2", "location": "Room 4"],
                   ["id": "e3", "title": "Holiday", "start": iso.string(from: tomorrow), "end": iso.string(from: tomorrow.addingTimeInterval(86400)), "allDay": true, "calendar": "Home", "color": "#30d158"]],
    ]
    let u = try tempDir("ek").appendingPathComponent("eventkit.json")
    try JSONSerialization.data(withJSONObject: json).write(to: u)
    return u
}

private func browserHome() throws -> URL {
    let home = try tempDir("home")
    let chrome = home.appendingPathComponent("Library/Application Support/Google/Chrome/Default")
    try FileManager.default.createDirectory(at: chrome, withIntermediateDirectories: true)
    try #"{"roots":{"bookmark_bar":{"children":[{"type":"url","name":"Swift Forums","url":"https://forums.swift.org/"},{"type":"folder","name":"Dev","children":[{"type":"url","name":"Swift Package Index","url":"https://swiftpackageindex.com/"}]}]}}}"#
        .write(to: chrome.appendingPathComponent("Bookmarks"), atomically: true, encoding: .utf8)
    return home
}

@MainActor private func textImage() throws -> String {
    let rep = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1000, pixelsHigh: 300, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: 1000, height: 300).fill()
    for (i, l) in ["Invoice 2048 total 31.50", "see https://example.com/pay"].enumerated() {
        (l as NSString).draw(at: NSPoint(x: 30, y: 190 - i * 90), withAttributes: [.font: NSFont.systemFont(ofSize: 52), .foregroundColor: NSColor.black])
    }
    NSGraphicsContext.restoreGraphicsState()
    let u = try tempDir("img").appendingPathComponent("text.png")
    try #require(rep.representation(using: .png, properties: [:])).write(to: u)
    return u.path
}

@Suite("N7 features via the headless test channel", .serialized)
struct N7E2E {
    @Test func timersNaturalLanguageAndListView() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("timer 10m tea")
        #expect(n7Titles(s).first == "Start 10 min · tea Timer")
        s = try d.key("enter")
        // Integration: ⏎ runs the action asynchronously; under full-suite load the timer can start a beat later.
        var st = result(try d.invoke("timers", "state"))
        for _ in 0..<60 where ((st["timers"] as? [[String: Any]]) ?? []).isEmpty {
            usleep(50_000)
            st = result(try d.invoke("timers", "state"))
        }
        #expect((st["timers"] as? [[String: Any]])?.first?["name"] as? String == "tea")
        let tray = try d.invoke("timers", "trayTitle")["result"] as? String ?? ""
        #expect(tray.hasPrefix("⏱ 10:00") || tray.hasPrefix("⏱ 9:"))
        _ = try d.show()
        try d.send(["cmd": "setQuery", "text": ""])
        try d.type("Timers")
        s = try d.key("enter")
        #expect(s["view"] as? String == "timers.list")
        var v = try viewState(d, "timers")
        #expect(n7Titles(v).first == "tea")
        #expect((n7Rows(v).first?["clock"] as? String)?.contains(":") == true)
        try d.type("25m focus")
        v = try viewState(d, "timers")
        #expect(n7Titles(v).first == "Start 25 min Timer “focus”")
        #expect(try d.state()["primaryAction"] as? String == "Start Timer")
        _ = try snap(d, "timers-list")
        // Electron method shapes used by the menu bar (N8) and workflows (N6).
        let id = (st["timers"] as? [[String: Any]])?.first?["id"] as? String ?? ""
        #expect(result(try d.invoke("timers", "toggle", id))["ok"] as? Bool == true)
        #expect(result(try d.invoke("timers", "add", ["id": id, "ms": 60000]))["ok"] as? Bool == true)
        #expect(result(try d.invoke("timers", "start", ["ms": 300000, "name": "eggs"]))["ok"] as? Bool == true)
        #expect(result(try d.invoke("timers", "stop", id))["ok"] as? Bool == true)
        #expect(!d.sideEffects.contains { $0.kind == "notify" })
    }

    @Test func notesSearchCreateVimAndDelete() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.invoke("notes", "create", ["body": "# Groceries\n- [ ] milk\n- [x] **eggs**\nRemember `oat` milk"])
        _ = try d.invoke("notes", "create", ["body": "Meeting notes\nship the beta"])
        _ = try d.show()
        var s = try d.invoke("launcher", "push", ["view": "notes.search"])
        #expect(s["view"] as? String == "notes.search")
        var v = try viewState(d, "notes")
        #expect(n7Titles(v) == ["Meeting notes", "Groceries"])
        // Vim: Esc → NORMAL, j moves the view's own selection.
        s = try d.key("esc")
        #expect(s["mode"] as? String == "normal")
        try d.key("j")
        v = try viewState(d, "notes")
        #expect(v["selected"] as? Int == 1)
        _ = try snap(d, "notes-search")
        // ⌘K opens the row's action panel (own panel inside the view).
        try d.key("cmdK")
        v = try viewState(d, "notes")
        #expect(((v["panel"] as? [String: Any])?["actions"] as? [String])?.first == "Open in Floating Notes")
        _ = try snap(d, "notes-actions")
        try d.key("esc")
        try d.key("i")
        try d.type("weekend plan")
        v = try viewState(d, "notes")
        #expect(n7Titles(v).last == "Create Note “weekend plan”")
        // Select the create row (⌃J moves in INSERT mode too) and run it.
        for _ in 0..<3 { try d.key("ctrlJ") }
        try d.key("enter")
        let state = result(try d.invoke("notes", "state"))
        #expect((state["notes"] as? [[String: Any]])?.count == 3)
        let events = try d.invoke("notes", "panelEvents")["result"] as? [String] ?? []
        #expect(events.first?.hasPrefix("show:note-") == true)
        try d.invoke("notes", "flush")
        let file = d.dataDirectory.appendingPathComponent("features/notes/notes.json")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        #expect((json?["notes"] as? [[String: Any]])?.count == 3)
    }

    @Test func colorSwatchAndHistory() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("#ff8800")
        #expect(n7Titles(s).first == "#FF8800")
        _ = try snap(d, "color-swatch")
        s = try d.key("cmdK")
        #expect(((s["actionPanel"] as? [String: Any])?["actions"] as? [String])?.prefix(3) == ["Copy HEX", "Paste HEX", "Copy RGB"])
        try d.type("hsl")
        try d.key("enter")
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "hsl(32, 100%, 50%)")
        _ = try d.invoke("color", "add", ["text": "rgb(10, 132, 255)"])
        _ = try d.invoke("color", "add", ["text": "#30d158"])
        _ = try d.show()
        try d.send(["cmd": "setQuery", "text": ""])
        try d.invoke("launcher", "push", ["view": "color.history"])
        let v = try viewState(d, "color")
        #expect(n7Titles(v).prefix(3) == ["Pick Color", "#30D158", "#0A84FF"])
        try d.key("down")
        _ = try snap(d, "color-history")
    }

    @Test func remindersAndCalendarWithFixtureEventKit() throws {
        let fixture = try eventKitFixture()
        let d = try GlideDriver(environment: ["GLIDE_EVENTKIT_FIXTURE": fixture.path])
        defer { d.stop() }
        _ = try d.show()
        var s = try d.type("remind call mom tomorrow 9am #work")
        #expect(n7Titles(s).first == "Create Reminder “call mom”")
        #expect(n7Rows(s).first?["subtitle"] as? String == "Due Tomorrow, 9:00 AM · Work")
        s = try d.key("enter")
        #expect(s["toast"] as? String == "Reminder created: call mom")
        let state = result(try d.invoke("reminders", "state"))
        #expect((state["reminders"] as? [[String: Any]])?.contains { $0["title"] as? String == "call mom" && $0["listId"] as? String == "L2" } == true)
        _ = try d.show()
        try d.send(["cmd": "setQuery", "text": ""])
        try d.invoke("launcher", "push", ["view": "reminders.list"])
        var v = try viewState(d, "reminders", "list")
        #expect(n7Rows(v).first?["section"] as? String == "Overdue")
        #expect(n7Titles(v).first == "!!! Pay rent")
        _ = try snap(d, "reminders-list")
        try d.key("enter") // complete the selected (overdue) reminder
        v = try viewState(d, "reminders", "list")
        #expect(!n7Titles(v).contains("!!! Pay rent"))
        #expect(!d.sideEffects.contains { $0.kind == "permission-request" })
        // Calendar.
        try d.invoke("launcher", "pop")
        let sched = result(try d.invoke("calendar", "schedule"))
        #expect(sched["status"] as? String == "ok")
        try d.send(["cmd": "setQuery", "text": ""])
        s = try d.type("join")
        #expect(n7Titles(s).contains("Join Standup"))
        try d.send(["cmd": "setQuery", "text": ""])
        try d.invoke("launcher", "push", ["view": "calendar.schedule"])
        v = try viewState(d, "calendar")
        #expect(n7Titles(v).contains("Standup") && n7Titles(v).contains("Design review"))
        #expect((n7Rows(v).first?["actions"] as? [String])?.first == "Join Google Meet Meeting")
        _ = try snap(d, "calendar-schedule")
        try d.key("enter")
        #expect(d.sideEffects.contains { $0.kind == "open-url" && $0.detail.contains("meet.google.com") })
    }

    @Test func calendarWithoutAccessShowsGrantRowOnly() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("launcher", "push", ["view": "calendar.schedule"])
        let v = try viewState(d, "calendar")
        #expect(["Grant Calendar Access", "Try Again", "Open Privacy Settings"].contains(n7Titles(v).first ?? ""))
        #expect(!d.sideEffects.contains { $0.kind == "permission-request" })
        _ = try snap(d, "calendar-access")
    }

    @Test func ocrOnGeneratedImageAndNoScreenCapture() async throws {
        let img = try await MainActor.run { try textImage() }
        let d = try GlideDriver()
        defer { d.stop() }
        _ = try d.show()
        let r = result(try d.invoke("ocr", "openImage", ["path": img]))
        #expect((r["text"] as? String)?.contains("Invoice 2048") == true)
        #expect((r["links"] as? [String])?.contains("https://example.com/pay") == true)
        let s = try d.state()
        #expect(s["view"] as? String == "ocr.result")
        let v = try viewState(d, "ocr")
        #expect(n7Titles(v).first == "All Text")
        #expect(n7Titles(v).contains("https://example.com/pay"))
        _ = try snap(d, "ocr-result")
        // Capture Text never runs screencapture headless.
        let cap = result(try d.invoke("ocr", "captureText"))
        #expect(cap["cancelled"] as? Bool == true)
        #expect(try d.invoke("ocr", "effects")["result"] as? [String] == ["screencapture -i (skipped: headless)"])
    }

    @Test func browserBookmarksFromFixtureHome() throws {
        let home = try browserHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let d = try GlideDriver(environment: ["GLIDE_BROWSER_HOME": home.path])
        defer { d.stop() }
        let st = result(try d.invoke("browser", "refresh"))
        #expect((st["totals"] as? [String: Any])?["bookmarks"] as? Int == 2)
        #expect((st["totals"] as? [String: Any])?["history"] as? Int == 0)
        _ = try d.show()
        var s = try d.type("swift forums")
        #expect(n7Titles(s).first == "Swift Forums")
        try d.send(["cmd": "setQuery", "text": ""])
        s = try d.invoke("launcher", "push", ["view": "browser.bookmarks"])
        #expect(s["view"] as? String == "browser.bookmarks")
        try d.type("swift")
        let v = try viewState(d, "browser", "bookmarks")
        #expect(n7Titles(v).count == 2)
        _ = try snap(d, "browser-bookmarks")
    }

    @Test func focusStartAndStats() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        #expect(result(try d.invoke("focus", "start", ["goal": "write report", "minutes": 45]))["ok"] as? Bool == true)
        _ = try d.show()
        try d.invoke("launcher", "push", ["view": "focus.start"])
        var v = try viewState(d, "focus", "start")
        #expect(n7Titles(v).prefix(2) == ["Pause Session", "Stop Current Session"])
        _ = try snap(d, "focus-start")
        try d.invoke("launcher", "push", ["view": "focus.stats"])
        v = try viewState(d, "focus", "stats")
        #expect(n7Titles(v).first == "write report")
        _ = try snap(d, "focus-stats")
        #expect(result(try d.invoke("focus", "stop"))["ok"] as? Bool == true)
    }
}
