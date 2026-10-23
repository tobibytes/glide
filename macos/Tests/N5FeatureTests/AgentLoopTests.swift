import Foundation
import GlideCore
import Testing
@testable import GlideFeatures

@MainActor @Suite("Agent loop (scripted model)")
struct AgentLoopTests {
    @Test func readOnlyToolRunsWithoutConfirmation() async {
        let caps = FakeCaps()
        let client = scripted([Turn(text: "Looking.", toolCalls: [call("search_catalogue", ["query": "saf"])]), Turn(text: "Found Safari.")])
        var l = loop(client, caps)
        var asked = 0
        l.confirm = { _, _ in asked += 1; return true }
        let out = await l.run()
        #expect(asked == 0)
        #expect(out.snapshot.status == .done)
        #expect(out.snapshot.steps.first?.status == .ok)
        #expect(out.snapshot.steps.first?.result?.contains("Safari") == true)
        #expect(caps.log.contains("search saf"))
        // messages: user prompt, assistant tool_use, user tool_result, assistant text
        #expect(out.messages.count == 4)
        #expect(out.messages[2]["content"]?.arrayValue?.first?["type"]?.stringValue == "tool_result")
        if case let .summary(_, text, _, saveable)? = out.snapshot.entries.last {
            #expect(text == "Finished: 1 lookup")
            #expect(saveable == false)
        } else { Issue.record("no summary") }
        // Second request saw the tool result.
        #expect(client.requests.count == 2)
        #expect(client.requests[0].tools.contains { $0["name"]?.stringValue == "kill_process" })
    }

    @Test func mutatingStepAsksAndRunsWhenApproved() async {
        let caps = FakeCaps()
        var l = loop(scripted([Turn(toolCalls: [call("open_url", ["url": "https://example.com"])]), Turn(text: "Opened.")]), caps)
        var confirmations: [AgentConfirmation] = []
        l.confirm = { c, snap in
            confirmations.append(c)
            #expect(snap.status == .confirming)
            #expect(snap.steps.first?.status == .awaiting)
            #expect(snap.steps.first?.summary == "Open https://example.com")
            return true
        }
        let out = await l.run()
        #expect(confirmations.count == 1)
        #expect(caps.log.contains("open https://example.com"))
        #expect(out.snapshot.steps.first?.status == .ok)
        #expect(out.snapshot.steps.first?.workflow?.first?.type == "openUrl")
    }

    @Test func declinedStepIsNotRunAndToldToTheModel() async {
        let caps = FakeCaps()
        let client = scripted([Turn(toolCalls: [call("copy_to_clipboard", ["text": "hello"])]), Turn(text: "Skipped.")])
        var l = loop(client, caps)
        l.confirm = { _, _ in false }
        let out = await l.run()
        #expect(caps.clipboard == "old clipboard")
        #expect(out.snapshot.steps.first?.status == .declined)
        let result = client.requests[1].messages.last?["content"]?.arrayValue?.first
        #expect(result?["content"]?.stringValue == AgentLoop.declinedResult)
        #expect(result?["is_error"]?.boolValue == true)
    }

    @Test func allowListSkipsConfirmationButNotAlwaysConfirmTools() async {
        let caps = FakeCaps()
        var l = loop(scripted([Turn(toolCalls: [call("open_app", ["name": "Notes"]), call("kill_process", ["pid": 123])]), Turn(text: "ok")]), caps)
        l.isAllowed = { _ in true }
        var asked: [String] = []
        l.confirm = { c, snap in
            asked = snap.steps.filter { c.stepIds.contains($0.id) }.map(\.tool)
            return true
        }
        let out = await l.run()
        #expect(asked == ["kill_process"])
        #expect(out.snapshot.steps.first { $0.tool == "open_app" }?.autoApproved == true)
        #expect(caps.log.contains("kill 123 false"))
    }

    @Test func protectedProcessIsRefusedEvenWhenApproved() async {
        let caps = FakeCaps()
        var l = loop(scripted([Turn(toolCalls: [call("kill_process", ["pid": 88, "force": true])]), Turn(text: "no")]), caps)
        l.confirm = { _, _ in true }
        let out = await l.run()
        #expect(out.snapshot.steps.first?.status == .error)
        #expect(out.snapshot.steps.first?.result?.contains("protected") == true)
        #expect(!caps.log.contains { $0.hasPrefix("kill") })
    }

    @Test func readOnlyModeOffersOnlyLookupsAndRefusesChanges() async {
        let caps = FakeCaps()
        let client = scripted([Turn(toolCalls: [call("open_url", ["url": "https://example.com"])]), Turn(text: "can't")])
        var l = loop(client, caps)
        l.readOnly = true
        let out = await l.run()
        #expect(!client.requests[0].tools.contains { $0["name"]?.stringValue == "open_url" })
        #expect(out.snapshot.readOnly == true)
        #expect(out.snapshot.steps.first?.result == AgentLoop.readOnlyResult)
        #expect(!caps.log.contains { $0.hasPrefix("open ") })
    }

    @Test func planToolShowsPlanAndLinksSteps() async {
        let caps = FakeCaps()
        var l = loop(scripted([
            Turn(toolCalls: [call("plan", ["steps": ["Open Safari", "Move it left"]]), call("open_app", ["name": "Safari"])]),
            Turn(toolCalls: [call("window_action", ["action": "left-half", "app": "Safari"])]),
            Turn(text: "Done."),
        ]), caps)
        l.confirm = { _, _ in true }
        let out = await l.run()
        guard case let .plan(_, title, items)? = out.snapshot.entries.first(where: { if case .plan = $0 { return true }; return false }) else {
            Issue.record("no plan"); return
        }
        #expect(title == "I'll do 2 things:")
        #expect(items.allSatisfy { $0.stepId != nil })
        #expect(!out.snapshot.steps.contains { $0.tool == "plan" })
        // window_action recorded an undo and a workflow equivalent.
        #expect(out.undos.count == 1)
        #expect(out.snapshot.steps.last?.workflow?.map(\.type) == ["openApp", "wait", "feature"])
        if case let .summary(_, _, undoable, saveable)? = out.snapshot.entries.last { #expect(undoable == 1); #expect(saveable) }
    }

    @Test func severalActionsInOneTurnBecomeThePlan() async {
        let caps = FakeCaps()
        var l = loop(scripted([Turn(toolCalls: [call("open_app", ["name": "Safari"]), call("open_app", ["name": "Notes"])]), Turn(text: "ok")]), caps)
        var confirmed = 0
        l.confirm = { c, _ in confirmed = c.stepIds.count; return true }
        let out = await l.run()
        #expect(confirmed == 2) // one confirmation for the whole turn
        #expect(out.snapshot.entries.contains { if case let .plan(_, _, items) = $0 { return items.count == 2 }; return false })
    }

    @Test func toolCallLimitStopsTheRun() async {
        let caps = FakeCaps()
        let many = (0..<14).map { _ in call("search_catalogue", ["query": "x"]) }
        let client = scripted([Turn(toolCalls: many), Turn(toolCalls: [call("search_catalogue", ["query": "y"])]), Turn(text: "done")])
        let out = await loop(client, caps).run()
        #expect(out.snapshot.toolCalls == 12)
        #expect(out.snapshot.steps.filter { $0.status == .skipped }.count == 2)
        #expect(out.snapshot.entries.contains { if case let .notice(_, t, _) = $0 { return t.contains("limit of 12") }; return false })
        #expect(client.requests[1].messages.last?["content"]?.arrayValue?.last?["type"]?.stringValue == "text")
    }

    @Test func destructiveRateLimit() async {
        let caps = FakeCaps()
        let limiter = AgentRateLimiter(limit: 1)
        var l = loop(scripted([Turn(toolCalls: [call("run_shortcut", ["name": "A"]), call("run_shortcut", ["name": "B"])]), Turn(text: "ok")]), caps)
        l.confirm = { _, _ in true }
        l.takeRateLimit = { _ in limiter.take() }
        let out = await l.run()
        #expect(out.snapshot.steps.map(\.status) == [.ok, .error])
        #expect(out.snapshot.steps[1].result?.hasPrefix("Rate limited") == true)
    }

    @Test func invalidInputAndUnknownToolsBecomeToolErrors() async {
        let caps = FakeCaps()
        let out = await loop(scripted([Turn(toolCalls: [call("open_url", ["url": "file:///etc/passwd"]), call("nope")]), Turn(text: "ok")]), caps).run()
        #expect(out.snapshot.steps[0].result == "Invalid input: Only http, https and mailto URLs can be opened")
        #expect(out.snapshot.steps[1].result == "Unknown tool nope")
    }

    @Test func cancellationStopsTheRun() async {
        let caps = FakeCaps()
        var slow = Turn(text: "one two three four five six seven eight nine ten")
        slow.delayMs = 50
        let client = AgentScriptedClient(turns: [slow])
        let l = loop(client, caps)
        let task = Task { @MainActor in await l.run() }
        try? await Task.sleep(for: .milliseconds(120))
        task.cancel()
        let out = await task.value
        #expect(out.snapshot.status == .cancelled)
        #expect(out.snapshot.entries.contains { if case let .notice(_, t, _) = $0 { return t == "Stopped." }; return false })
    }

    @Test func clientErrorsAndRefusals() async {
        let out = await loop(scripted([Turn(error: "overloaded!")]), FakeCaps()).run()
        #expect(out.snapshot.status == .error)
        #expect(out.snapshot.error?.message == "overloaded!")
        let refused = await loop(scripted([Turn(stopReason: "refusal")]), FakeCaps()).run()
        #expect(refused.snapshot.error?.kind == "refusal")
    }

    @Test func followUpContinuesHistory() async {
        let caps = FakeCaps()
        let first = await loop(scripted([Turn(toolCalls: [call("search_catalogue", ["query": "a"])]), Turn(text: "A")]), caps).run()
        let client = scripted([Turn(text: "-"), Turn(text: "-"), Turn(text: "B")]) // indexed by assistant turns so far
        var l = loop(client, caps, prompt: "and again")
        l.history = first.messages
        let second = await l.run()
        #expect(client.requests[0].messages.count == 5)
        #expect(second.messages.last?["content"]?.arrayValue?.first?["text"]?.stringValue == "B")
    }

    @Test func undoClosuresPutThingsBack() async throws {
        let caps = FakeCaps()
        var l = loop(scripted([Turn(toolCalls: [call("copy_to_clipboard", ["text": "new"]), call("start_timer", ["minutes": 25, "name": "Focus"]),
                                                 call("create_snippet", ["name": "Sig", "text": "Best"]), call("set_theme", ["preset": "nord"])]),
                               Turn(text: "ok")]), caps)
        l.isAllowed = { _ in true }
        let out = await l.run()
        #expect(caps.clipboard == "new")
        #expect(caps.snippetList.count == 1)
        #expect(out.undos.count == 4)
        for u in out.undos.values { _ = try await u.run() }
        #expect(caps.clipboard == "old clipboard")
        #expect(caps.snippetList.isEmpty)
        #expect(caps.appearanceState.darkTheme == "glide-dark")
        #expect(caps.log.contains("timers.stop"))
    }

    @Test func mcpStyleAskFirstToolIsConfirmed() async {
        var tool = AgentTool(name: "mcp__fix__echo", title: "fix › Echo", description: "", mutating: false, schema: agentSchema()) { _, _ in
            .ready(AgentPreparedCall(describe: { "Run echo" }, run: { AgentToolOutput(text: "echoed") }))
        }
        tool.askFirst = true
        var l = loop(scripted([Turn(toolCalls: [call("mcp__fix__echo")]), Turn(text: "ok")]), FakeCaps(), tools: [tool])
        var asked = false
        l.confirm = { _, _ in asked = true; return true }
        let out = await l.run()
        #expect(asked)
        #expect(out.snapshot.steps.first?.result == "echoed")
    }
}
