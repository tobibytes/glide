import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

/// Fix round: the agent's delete_reminder tool (mutating, destructive, always confirmed) and the MCP server's
/// delete_reminder (destructive, Off by default), both backed by `reminders.delete {id}`.
@MainActor @Suite("delete_reminder (agent + MCP)", .serialized)
struct DeleteReminderToolTests {
    func caps() -> FakeCaps {
        let c = FakeCaps()
        var rows: [JSONValue] = [["id": "r1", "title": "Pay rent"], ["id": "r2", "title": "Call mom"], ["id": "r3", "title": "Call dad"]]
        c.features["reminders.state"] = { _ in ["status": "ok", "reminders": .array(rows)] }
        c.features["reminders.delete"] = { a in
            let before = rows.count
            rows.removeAll { $0["id"] == a["id"] }
            return ["ok": .bool(rows.count < before), "error": rows.count < before ? .null : "Reminder not found"]
        }
        return c
    }
    func tool() throws -> AgentTool { try #require(AgentTools.all().first { $0.name == "delete_reminder" }) }

    @Test func metadata() throws {
        let t = try tool()
        #expect(t.mutating && t.destructive && t.alwaysConfirm)
        #expect(t.requires == "reminders")
        let m = try #require(MCPServerTools.all().first { $0.name == "delete_reminder" })
        #expect(!m.readOnly && m.destructive && m.agentTool == "delete_reminder" && m.requires == "reminders")
        #expect(m.listEntry["annotations"]?["destructiveHint"] == true)
        #expect(MCPPolicy.policy(m, MCPServerSettings()) == .off)
        var s = MCPServerSettings()
        s.tools["delete_reminder"] = "allow" // never silently allowed
        #expect(MCPPolicy.gate(m, s, client: "c") == .confirm)
    }

    @Test func validationAndRunByTitleOrId() async throws {
        let c = caps()
        let t = try tool()
        if case let .invalid(msg) = t.prepare([:], c) { #expect(msg == "Give the reminder's id or title") } else { Issue.record("expected invalid") }
        guard case let .ready(byTitle) = t.prepare(["title": "pay rent"], c) else { Issue.record("not ready"); return }
        #expect(await byTitle.describe() == "Delete the reminder “Pay rent” — this can't be undone")
        #expect(try await byTitle.run().text == "Deleted the reminder “Pay rent”")
        #expect(c.log.contains("reminders.delete"))
        // ambiguous "call" is refused with the ids; an id is exact
        guard case let .ready(amb) = t.prepare(["title": "call"], c) else { Issue.record("not ready"); return }
        await #expect(throws: AgentToolFailure.self) { try await amb.run() }
        guard case let .ready(byId) = t.prepare(["id": "r3"], c) else { Issue.record("not ready"); return }
        #expect(try await byId.run().text == "Deleted the reminder “Call dad”")
        guard case let .ready(gone) = t.prepare(["id": "r3"], c) else { Issue.record("not ready"); return }
        await #expect(throws: AgentToolFailure.self) { try await gone.run() }
    }

    @Test func loopAlwaysAsksEvenWhenAllowListed() async {
        let c = caps()
        var l = loop(scripted([Turn(toolCalls: [call("delete_reminder", ["id": "r1"])]), Turn(text: "ok")]), c)
        l.isAllowed = { _ in true }
        var asked: [String] = []
        l.confirm = { conf, snap in
            asked = snap.steps.filter { conf.stepIds.contains($0.id) }.map(\.tool)
            return false
        }
        _ = await l.run()
        #expect(asked == ["delete_reminder"])
        #expect(!c.log.contains("reminders.delete")) // declined → nothing deleted
    }
}
