import Foundation
import GlideCore
import Testing
@testable import GlideFeatures

@MainActor @Suite("Agent safety, history, workflows, tools")
struct AgentSupportTests {
    @Test func protectedProcesses() {
        #expect(AgentSafety.isProtectedProcess(name: "WindowServer", command: "/System/Library/WindowServer"))
        #expect(AgentSafety.isProtectedProcess(name: "x", command: "/Applications/Glide.app/Contents/MacOS/Glide"))
        #expect(AgentSafety.isProtectedProcess(name: "glide-helper", command: "glide-helper"))
        #expect(!AgentSafety.isProtectedProcess(name: "Slack", command: "/Applications/Slack.app/Contents/MacOS/Slack"))
    }

    @Test func rateLimiterSlidingWindow() {
        var t = 0.0
        let l = AgentRateLimiter(limit: 2, windowMs: 1000, now: { t })
        #expect(l.take() == nil)
        #expect(l.take() == nil)
        #expect(l.take()?.hasPrefix("Rate limited") == true)
        t = 1001
        #expect(l.take() == nil)
    }

    @Test func historyHelpers() {
        var h = AgentHistory.appendPrompt([], "one")
        #expect(h == [["role": "user", "content": "one"]])
        h = AgentHistory.appendPrompt(h, "two") // merges consecutive user messages
        #expect(h.count == 1 && AgentHistory.blocks(h[0]).count == 2)
        let dangling: [JSONValue] = [["role": "user", "content": "x"], ["role": "assistant", "content": [["type": "tool_use", "id": "t1", "name": "open_app", "input": [:]]]]]
        let repaired = AgentHistory.repairTail(dangling)
        #expect(repaired.count == 3)
        #expect(repaired[2]["content"]?.arrayValue?.first?["tool_use_id"] == "t1")
        let long = (0..<70).map { i -> JSONValue in i % 2 == 0 ? ["role": "user", "content": .string("p\(i)")] : ["role": "assistant", "content": [["type": "text", "text": "a"]]] }
        let trimmed = AgentHistory.trim(long)
        #expect(trimmed.count <= 60 && AgentHistory.isPlainPrompt(trimmed[0]))
        #expect(AgentHistory.title(for: "  a   b ") == "a b")
    }

    @Test func redactionForDisk() {
        let tools = AgentTools.all()
        let info = AgentSafety.Sensitivity(tools)
        let msgs: [JSONValue] = [
            ["role": "assistant", "content": [["type": "thinking", "thinking": "x"], ["type": "tool_use", "id": "a", "name": "get_clipboard", "input": [:]],
                                              ["type": "tool_use", "id": "b", "name": "copy_to_clipboard", "input": ["text": "secret"]]]],
            ["role": "user", "content": [["type": "tool_result", "tool_use_id": "a", "content": "clipboard secret"], ["type": "tool_result", "tool_use_id": "b", "content": "Copied"]]],
        ]
        let r = AgentHistory.redact(msgs, info, keepSensitive: false)
        let text = AgentText.json(.array(r))
        #expect(!text.contains("secret"))
        #expect(!text.contains("thinking"))
        #expect(AgentHistory.redact(msgs, info, keepSensitive: true)[1]["content"]?.arrayValue?.first?["content"] == "clipboard secret")

        var step = AgentStep(id: "s1", tool: "copy_to_clipboard", title: "Copy to Clipboard", args: ["text": "pw"], summary: "Copy “pw”", mutating: true, status: .ok)
        step.workflow = [AgentWorkflowStep(type: "setClipboard", params: ["text": "pw"])]
        let run = AgentRunSnapshot(runId: "r", prompt: "p", status: .done, entries: [.step(id: "s1", step: step)], toolCalls: 1, maxToolCalls: 12, model: "m", startedAt: 0)
        let red = AgentSafety.redactRun(run, info)
        #expect(red.steps[0].args["text"]?.stringValue == AgentSafety.redacted)
        #expect(red.steps[0].workflow == nil)
    }

    @Test func workflowPlanning() {
        var a = AgentStep(id: "1", tool: "open_url", title: "Open URL", args: [:], summary: "Open x", mutating: true, status: .ok)
        a.workflow = [AgentWorkflowStep(type: "openUrl", params: ["url": "https://x"])]
        let b = AgentStep(id: "2", tool: "create_note", title: "Create Note", args: [:], summary: "Create a note", mutating: true, status: .ok)
        let look = AgentStep(id: "3", tool: "search_catalogue", title: "Search", args: [:], summary: "Search", mutating: false, status: .ok)
        #expect(AgentWorkflowPlanner.plan([.init(step: a, workflow: a.workflow), .init(step: look)]) == .ok(a.workflow ?? []))
        if case let .failed(_, unmapped) = AgentWorkflowPlanner.plan([.init(step: a, workflow: a.workflow), .init(step: b)]) { #expect(unmapped == ["Create a note"]) } else { Issue.record("should fail") }
        #expect(!AgentWorkflowPlanner.plan([.init(step: look)]).isOK)
        var data = UserData()
        data.quicklinks = [Quicklink(id: "q", name: "GH", url: "https://github.com/search?q={query}")]
        #expect(AgentWorkflowPlanner.itemToWorkflowStep("quicklink:q", argument: "a b", data: data, title: nil)?.params["url"] == "https://github.com/search?q=a%20b")
        #expect(AgentWorkflowPlanner.itemToWorkflowStep("app:/Applications/Safari.app", argument: nil, data: data, title: nil)?.type == "openApp")
        #expect(AgentWorkflowPlanner.itemToWorkflowStep("windows.left-half", argument: nil, data: data, title: "Left")?.params["action"] == "runItem")
        #expect(AgentWorkflowPlanner.itemToWorkflowStep("agent:ask", argument: nil, data: data, title: nil) == nil)
        let wf = AgentWorkflowPlanner.buildWorkflow(name: "", prompt: "Open x", actions: a.workflow ?? [], now: 1000)
        #expect(wf.name == "Open x" && wf.actions.count == 1 && wf.id.hasPrefix("wf-agent-"))
        #expect(wf.actions[0].params["url"] == "https://x")
    }

    /// conversations.json written by the Electron app (shape of history.ts) loads, and writes back compatibly.
    @Test func conversationsFileCompatibility() throws {
        let dir = n5TempDir()
        let file = dir.appendingPathComponent("conversations.json")
        let electron = #"""
        {"version":1,"conversations":[{"id":"cr1","title":"Start a timer","createdAt":1760000000000,"updatedAt":1760000005000,
        "runs":[{"runId":"r1","conversationId":"cr1","prompt":"Start a timer","status":"done","entries":[
          {"kind":"prompt","id":"r1-e1","text":"Start a timer"},
          {"kind":"plan","id":"r1-e2","title":"I'll do 1 thing:","items":[{"text":"Start","stepId":"r1-s3"}]},
          {"kind":"step","id":"r1-s3","step":{"id":"r1-s3","tool":"start_timer","title":"Start Timer","args":{"minutes":5},"summary":"Start a 5 min timer","mutating":true,"status":"ok","result":"Timer started","undo":{"summary":"Cancel","state":"available"},"workflow":[{"type":"feature","params":{"feature":"timers","action":"start","duration":"5m","name":""}}]}},
          {"kind":"text","id":"r1-e4","text":"Started."},
          {"kind":"summary","id":"r1-e5","text":"Finished: 1 action done","undoable":1,"saveable":true},
          {"kind":"notice","id":"r1-e6","text":"hi","tone":"info"}],
          "toolCalls":1,"maxToolCalls":12,"model":"claude-opus-5-5","startedAt":1760000000000,"endedAt":1760000005000}],
        "messages":[{"role":"user","content":"Start a timer"},{"role":"assistant","content":[{"type":"text","text":"Started."}]}]},
        {"id":"broken"}]}
        """#
        try Data(electron.utf8).write(to: file)
        let store = AgentConversationStore(file: file)
        let list = store.search("timer")
        #expect(list.count == 1)
        #expect(list.first?.preview == "Start a timer")
        let rec = try #require(store.get("cr1"))
        #expect(rec.runs[0].entries.count == 6)
        #expect(rec.runs[0].steps[0].workflow?.first?.params["duration"] == "5m")
        // Resuming drops undo (closures don't survive restarts).
        let sessions = AgentSessions(store: store, sensitivity: { AgentSafety.Sensitivity([]) }, keepSensitive: { false }, saveHistory: { true })
        #expect(sessions.get("cr1")?.runs[0].steps[0].undo == nil)
        store.put(rec)
        store.flush()
        let back = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
        #expect(back["version"] == 1)
        let entry = back["conversations"]?.arrayValue?.first?["runs"]?.arrayValue?.first?["entries"]?.arrayValue?[2]
        #expect(entry?["kind"] == "step")
        #expect(entry?["step"]?["status"] == "ok")
        #expect(store.delete("cr1"))
        #expect(store.search("").isEmpty)
    }

    @Test func toolValidation() async {
        let caps = FakeCaps()
        let tools = AgentTools.all()
        func prep(_ name: String, _ input: JSONValue) -> AgentPrepared { tools.first { $0.name == name }!.prepare(input, caps) }
        func err(_ p: AgentPrepared) -> String? { if case let .invalid(m) = p { return m }; return nil }
        #expect(err(prep("open_url", ["url": "javascript:alert(1)"])) != nil)
        #expect(err(prep("open_url", ["url": "https://ok.example/x"])) == nil)
        #expect(err(prep("start_timer", ["seconds": 0.5])) == "Give a duration with minutes and/or seconds")
        #expect(err(prep("start_timer", ["minutes": 2000])) == "Timers can be at most 24 hours")
        #expect(err(prep("window_action", ["action": "fly"]))?.hasPrefix("\"action\" must be one of") == true)
        #expect(err(prep("execute_item", ["id": "agent:ask"])) == "The agent cannot run itself")
        #expect(err(prep("kill_process", ["pid": 1])) == "That process is protected and can't be killed")
        #expect(err(prep("create_snippet", ["name": "a", "text": "b", "keyword": "a b"])) == "keyword can't contain spaces")
        #expect(err(prep("create_quicklink", ["name": "a", "url": "ftp://x"])) != nil)
        #expect(err(prep("create_automation", ["trigger": ["kind": "hotkey"], "item_id": "x"])) == "Hotkey automations must be created in Settings → Automations")
        #expect(err(prep("create_reminder", ["title": "x", "due": "tomorrowish"])) != nil)
        #expect(err(prep("search_catalogue", "not an object")) == "Tool input must be a JSON object")
        if case let .ready(p) = prep("start_timer", ["minutes": 25, "name": "Focus"]) { #expect(await p.describe() == "Start a 25 min timer named “Focus”") }
        if case let .ready(p) = prep("transform_text", ["transform": "upper", "text": "abc"]) { #expect((try? await p.run().text) == "ABC") }
        if case let .ready(p) = prep("convert", ["query": "2+3"]) { #expect((try? await p.run().text)?.contains("5") == true) }
        #expect(tools.count == 35)
        #expect(Set(tools.map(\.name)).count == tools.count)
    }

    @Test func turnRequestBody() {
        let req = AgentTurnRequest(model: "claude-opus-5-5", effort: "high", system: "SYS", context: "CTX", tools: [["name": "x"]], messages: [["role": "user", "content": "hi"]])
        let (body, betas) = AgentAnthropicClient.body(req)
        #expect(body["system"]?.arrayValue?.count == 2)
        #expect(body["system"]?.arrayValue?.first?["cache_control"] != nil)
        #expect(body["cache_control"] != nil)
        #expect(body["output_config"]?["effort"] == "high")
        #expect(body["stream"] == true)
        _ = betas
    }

    @Test func scriptedClientLoadsMockScript() throws {
        let c = try AgentScriptedClient(script: ["model": "m", "turns": [["text": "hi", "tool_calls": [["name": "open_app", "input": ["name": "Notes"]]]]]])
        #expect(c.turns.first?.toolCalls.first?.name == "open_app")
        #expect(throws: AgentClientError.self) { try AgentScriptedClient(script: [:]) }
    }
}
