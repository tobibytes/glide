import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem
import GlideUI
import Testing

/// Fix round: EventKitService.deleteReminder, `reminders.delete {id}`, the ⌃X Delete action (second press
/// confirms), plus the launcher view-host defaults and readable default view titles.
@Suite("reminders: delete", .serialized)
@MainActor struct ReminderDeleteTests {
    func make() async -> (RemindersFeature, N7TestContext, FixtureEventKit) {
        let ctx = N7TestContext("reminders")
        let ek = FixtureEventKit(seed: ["lists": [["id": "L1", "title": "Reminders", "isDefault": true, "writable": true]],
                                        "reminders": [["id": "r1", "title": "Pay rent", "completed": false, "priority": 0, "listId": "L1", "listTitle": "Reminders"],
                                                      ["id": "r2", "title": "Water plants", "completed": false, "priority": 0, "listId": "L1", "listTitle": "Reminders"]]])
        let f = RemindersFeature()
        f.eventKitOverride = ek
        await f.start(context: ctx)
        return (f, ctx, ek)
    }

    @Test func fixtureDeleteRemovesAndUnknownFails() async throws {
        let ek = FixtureEventKit(seed: ["reminders": [["id": "a", "title": "A"]]])
        let r = try await ek.deleteReminder(id: "a")
        #expect(r["deleted"] == true)
        #expect(ek.reminderItems.isEmpty)
        await #expect(throws: (any Error).self) { try await ek.deleteReminder(id: "a") }
        await #expect(throws: (any Error).self) { try await HeadlessEventKit().deleteReminder(id: "a") }
    }

    @Test func invokeDelete() async throws {
        let (f, ctx, ek) = await make()
        defer { ctx.cleanup() }
        let r = try await f.invoke(method: "delete", args: ["id": "r1"])
        #expect(r["ok"] == true)
        #expect(r["message"]?.stringValue == "Deleted reminder “Pay rent”")
        #expect(ek.reminderItems.map { $0["id"]?.stringValue } == ["r2"])
        #expect(f.reminders.map(\.id) == ["r2"])
        let missing = try await f.invoke(method: "delete", args: ["id": "nope"])
        #expect(missing["ok"] == false)
        #expect(try await f.invoke(method: "delete", args: [:])["ok"] == false)
        // bare id string also accepted
        #expect(try await f.invoke(method: "delete", args: "r2")["ok"] == true)
        #expect(ek.reminderItems.isEmpty)
    }

    @Test func controlXAsksThenDeletes() async throws {
        let (f, ctx, ek) = await make()
        defer { ctx.cleanup() }
        let host = N7TestHost()
        f.listModel.hostOverride = host
        let row = try #require(f.listRows("").first { $0.id == "r1" })
        let del = try #require(row.actions.first { $0.id == "delete" })
        #expect(del.title == "Delete Reminder" && del.shortcut == "⌃X" && del.destructive)
        f.listModel.select(id: "r1")
        #expect(f.listModel.handleKey(VimKey("x", ctrl: true)))
        try await Task.sleep(for: .milliseconds(80))
        #expect(ek.reminderItems.count == 2) // first press only asks
        #expect(host.toasts.last == "Press again to delete reminder")
        #expect(f.listModel.handleKey(VimKey("x", ctrl: true)))
        try await Task.sleep(for: .milliseconds(150))
        #expect(ek.reminderItems.map { $0["id"]?.stringValue } == ["r2"])
        #expect(host.toasts.last == "Deleted “Pay rent”")
    }
}

@Suite("launcher host defaults + view titles")
@MainActor struct ViewHostDefaultsTests {
    @Test func defaultsForMinimalHosts() {
        let h = N7TestHost()
        #expect(h.vimMode == nil)
        #expect(h.isOnStack("agent.run") == false)
        h.setContextTitle("X") // default no-op (forwards to setTitle)
        h.popAndClose()
        #expect(h.closed)
    }

    @Test func everyPushedViewHasAReadableDefault() {
        for id in ["emoji.picker", "reminders.create", "reminders.list", "notes.search", "focus.stats", "ocr.codes", "calendar.schedule",
                   "browser.history", "mcp-server.confirm", "timers.list", "workflows.run", "appearance.switch", "color.history", "quicklinks.create"] {
            let t = DefaultViewTitles.title(ViewID(rawValue: id))
            #expect(t != nil && t?.contains(".") == false, "\(id)")
        }
        #expect(DefaultViewTitles.title("scripts.output~7") == "Script Output")
        #expect(DefaultViewTitles.title("nope.view") == nil)
    }
}
