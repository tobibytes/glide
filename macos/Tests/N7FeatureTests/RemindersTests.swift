import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem
import Testing

// Wednesday 21 October 2026, 14:30 local time (same fixture as due.test.ts).
private let NOW = localDate(2026, 10, 21, 14, 30)
private func at(_ m: Int, _ d: Int, _ h: Int? = nil, _ min: Int = 0, year: Int = 2026) -> Date { localDate(year, m + 1, d, h ?? 0, min) }

private func check(_ text: String, _ title: String, _ due: Date?, _ allDay: Bool, sourceLocation: SourceLocation = #_sourceLocation) {
    let p = ReminderDue.parse(text, now: NOW)
    #expect(p.title == title, "\(text)", sourceLocation: sourceLocation)
    #expect(p.due?.timeIntervalSince1970 == due?.timeIntervalSince1970, "\(text): \(String(describing: p.due))", sourceLocation: sourceLocation)
    if due != nil { #expect(p.allDay == allDay, "\(text)", sourceLocation: sourceLocation) }
}

@Suite("reminders: natural-language due dates (due.test.ts port)")
struct ReminderDueTests {
    @Test func plainTitles() {
        check("Buy milk", "Buy milk", nil, false)
        check("Take 2 pills a day", "Take 2 pills a day", nil, false)
        check("Add 1/2 cup sugar to the list", "Add 1/2 cup sugar to the list", nil, false)
        check("sun cream and sat nav", "sun cream and sat nav", nil, false)
    }

    @Test func dayWords() {
        check("Call mom tomorrow", "Call mom", at(9, 22), true)
        check("Call mom tomorrow 9am", "Call mom", at(9, 22, 9), false)
        check("tomorrow at 9:30 pm pay rent", "pay rent", at(9, 22, 21, 30), false)
        check("Submit report today", "Submit report", at(9, 21), true)
        check("Take out trash tonight", "Take out trash", at(9, 21, 20), false)
        check("water plants the day after tomorrow", "water plants", at(9, 23), true)
        check("gym tomorrow morning", "gym", at(9, 22, 9), false)
    }

    @Test func relativeOffsets() {
        check("Check oven in 20 minutes", "Check oven", NOW.addingTimeInterval(20 * 60), false)
        check("in 2 hours stretch", "stretch", NOW.addingTimeInterval(2 * 3600), false)
        check("follow up in an hour", "follow up", NOW.addingTimeInterval(3600), false)
        check("follow up in half an hour", "follow up", NOW.addingTimeInterval(1800), false)
        check("renew passport in 3 days", "renew passport", at(9, 24), true)
        check("dentist in 2 weeks", "dentist", at(10, 4), true)
        check("review in 1 month", "review", at(10, 21), true)
    }

    @Test func weekdays() {
        check("Team lunch next friday", "Team lunch", at(9, 23), true)
        check("Team lunch friday at noon", "Team lunch", at(9, 23, 12), false)
        check("standup on mon 10am", "standup", at(9, 26, 10), false)
        check("water plants wednesday", "water plants", at(9, 28), true)
        check("this wednesday 6pm dinner", "dinner", at(9, 21, 18), false)
        check("plan trip next week", "plan trip", at(9, 26), true)
        check("clean garage this weekend", "clean garage", at(9, 24), true)
    }

    @Test func calendarDates() {
        check("Buy gifts dec 20", "Buy gifts", at(11, 20), true)
        check("Buy gifts on December 20th at 5pm", "Buy gifts", at(11, 20, 17), false)
        check("tax 15 april", "tax", at(3, 15, year: 2027), true)
        check("party 2026-11-01", "party", at(10, 1), true)
        check("vet 11/3", "vet", at(10, 3), true)
        check("vet on 11/3/2027", "vet", at(10, 3, year: 2027), true)
    }

    @Test func timesWithoutDates() {
        check("Call Sam at 5pm", "Call Sam", at(9, 21, 17), false)
        check("Call Sam at 9am", "Call Sam", at(9, 22, 9), false)
        check("Standup 17:45", "Standup", at(9, 21, 17, 45), false)
        check("Call Sam at 4", "Call Sam", at(9, 21, 16), false)
        check("Lunch at noon", "Lunch", at(9, 22, 12), false)
        check("Read in the evening", "Read", at(9, 21, 18), false)
        check("Ship 5p", "Ship", at(9, 21, 17), false)
    }

    @Test func helperWords() {
        check("remind me to call Bob tomorrow", "call Bob", at(9, 22), true)
        check("Pay invoice by friday", "Pay invoice", at(9, 23), true)
        check("tomorrow", "tomorrow", at(9, 22), true)
    }

    @Test func previews() {
        #expect(ReminderDue.preview(ReminderDue.parse("x tomorrow 9am", now: NOW), now: NOW) == "Due Tomorrow, 9:00 AM")
        #expect(ReminderDue.preview(ReminderDue.parse("x", now: NOW), now: NOW) == "No due date")
        #expect(ReminderDue.describe(at(9, 21), allDay: true, now: NOW) == "Today")
        #expect(ReminderDue.describe(at(9, 24), allDay: true, now: NOW) == "Saturday")
        #expect(ReminderDue.describe(at(9, 20, 8), allDay: false, now: NOW) == "Yesterday, 8:00 AM")
        #expect(ReminderDue.describe(at(0, 5, year: 2027), allDay: true, now: NOW) == "Tue, Jan 5, 2027")
    }
}

private func rem(_ title: String, due: Date? = nil, allDay: Bool? = nil, completed: Bool = false, priority: Int = 0, notes: String? = nil, completionDate: Date? = nil) -> ReminderItem {
    ReminderItem(id: title, title: title, completed: completed, priority: priority, listId: "L1", listTitle: "Reminders",
                 due: due.map(RemindersModel.iso), dueAllDay: allDay, completionDate: completionDate.map(RemindersModel.iso), notes: notes)
}

private let LISTS = [ReminderList(id: "L1", title: "Reminders", color: "#0a84ff", isDefault: true, writable: true),
                     ReminderList(id: "L2", title: "Work Stuff"), ReminderList(id: "L3", title: "Shared", writable: false)]

@Suite("reminders: model (model.test.ts port)")
struct RemindersModelTests {
    @Test func sections() {
        #expect(RemindersModel.section(rem("a", due: localDate(2026, 10, 21, 9)), now: NOW) == .overdue)
        #expect(RemindersModel.section(rem("a", due: localDate(2026, 10, 21), allDay: true), now: NOW) == .today)
        #expect(RemindersModel.section(rem("a", due: localDate(2026, 10, 20), allDay: true), now: NOW) == .overdue)
        #expect(RemindersModel.section(rem("a", due: localDate(2026, 10, 21, 18)), now: NOW) == .today)
        #expect(RemindersModel.section(rem("a", due: localDate(2026, 10, 25), allDay: true), now: NOW) == .upcoming)
        #expect(RemindersModel.section(rem("a"), now: NOW) == .noDue)
        #expect(RemindersModel.section(rem("a", due: localDate(2020, 1, 1), completed: true), now: NOW) == .completed)
    }

    @Test func ordering() {
        let rows = RemindersModel.rows([
            rem("later", due: localDate(2026, 10, 30), allDay: true), rem("none-low", priority: 9), rem("none-high", priority: 1),
            rem("late", due: localDate(2026, 10, 1), allDay: true), rem("today", due: localDate(2026, 10, 21, 17)), rem("done", completed: true, completionDate: NOW),
        ], now: NOW)
        #expect(rows.map { "\($0.1.rawValue):\($0.0.title)" } == ["Overdue:late", "Today:today", "Upcoming:later", "No Due Date:none-high", "No Due Date:none-low", "Completed:done"])
        #expect(RemindersModel.rows([rem("Buy milk"), rem("Call", notes: "about milk"), rem("Other")], now: NOW, query: "milk").map(\.0.title) == ["Buy milk", "Call"])
        let c = RemindersModel.countDue([rem("x", due: localDate(2026, 10, 1)), rem("y", due: localDate(2026, 10, 21, 20))], now: NOW)
        #expect(c.overdue == 1 && c.today == 1)
    }

    @Test func listsAndTags() {
        #expect(RemindersModel.pickList(LISTS, "L2")?.id == "L2")
        #expect(RemindersModel.pickList(LISTS, "L3")?.id == "L1")
        #expect(RemindersModel.pickList(LISTS, nil)?.id == "L1")
        let t = RemindersModel.extractListTag("send report #work tomorrow", LISTS)
        #expect(t.text == "send report tomorrow" && t.listId == "L2")
        #expect(RemindersModel.extractListTag("send report #nope", LISTS).listId == nil)
        let d = RemindersModel.draft("Ship it #workstuff friday 5pm // bring slides", lists: LISTS, now: NOW)
        #expect(d.title == "Ship it" && d.allDay == false && d.listId == "L2" && d.phrase == "friday 5pm" && d.notes == "bring slides")
        #expect(d.due.flatMap(RemindersModel.date) == localDate(2026, 10, 23, 17))
    }
}

@Suite("reminders: feature with an in-memory EventKit", .serialized)
@MainActor struct RemindersFeatureTests {
    func make() async -> (RemindersFeature, N7TestContext, FixtureEventKit) {
        let ctx = N7TestContext("reminders")
        let ek = FixtureEventKit(seed: ["lists": [["id": "L1", "title": "Reminders", "isDefault": true, "writable": true], ["id": "L2", "title": "Work", "writable": true]],
                                        "reminders": [["id": "r1", "title": "Pay rent", "completed": false, "priority": 0, "listId": "L1", "listTitle": "Reminders",
                                                       "due": .string(RemindersModel.iso(NOW.addingTimeInterval(-3600)))]]])
        let f = RemindersFeature()
        f.eventKitOverride = ek
        f.now = { NOW }
        await f.start(context: ctx)
        return (f, ctx, ek)
    }

    @Test func rootQueryDraftAndCreate() async throws {
        let (f, ctx, ek) = await make()
        defer { ctx.cleanup() }
        let items = await f.dynamicItems(for: DynamicQuery(text: "remind call mom tomorrow 9am #work", deadline: .now + .seconds(1)))
        let item = try #require(items.first)
        #expect(item.item.title == "Create Reminder “call mom”")
        #expect(item.item.subtitle == "Due Tomorrow, 9:00 AM · Work")
        let r = await f.run(action: "create", on: item, modifiers: [])
        #expect(r == .hide(message: "Reminder created: call mom"))
        let created = try #require(ek.reminderItems.last)
        #expect(created["listId"]?.stringValue == "L2")
        #expect(created["due"]?.stringValue.flatMap(RemindersModel.date) == localDate(2026, 10, 22, 9))
    }

    @Test func listViewCompletesWithEnter() async throws {
        let (f, ctx, ek) = await make()
        defer { ctx.cleanup() }
        let host = N7TestHost()
        f.listModel.hostOverride = host
        let rows = f.listRows("")
        #expect(rows.first?.title == "Pay rent")
        #expect(rows.first?.section == "Overdue")
        #expect(f.listModel.handle(.activate([])))
        try await Task.sleep(for: .milliseconds(100))
        #expect(ek.reminderItems.first?["completed"]?.boolValue == true)
        #expect(host.toasts.contains("Completed “Pay rent”"))
    }

    @Test func noAccessNeverPrompts() async {
        let ctx = N7TestContext("reminders")
        defer { ctx.cleanup() }
        let f = RemindersFeature()
        await f.start(context: ctx)
        _ = f.listRows("")
        #expect(ctx.effects("permission-request").isEmpty)
    }
}
