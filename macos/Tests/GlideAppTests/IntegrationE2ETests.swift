import Foundation
import GlideTestHarness
import Testing

/// Integration checks: cross-feature interactions of the phase-1 features running together in ONE headless app,
/// the shared launcher APIs added at integration (view titles, payload query pre-fill, ⌘⏎ → agent, settings
/// sub-routes, recordEffect, status titles, executeItem results), and the callFeature contracts between features
/// (caller argument shapes → callee response shapes the caller parses).
private let seed = #"""
{"settings":{"keepOpenAfterRun":false},
 "snippets":[{"id":"sn-1","name":"Signature Block","text":"Best, {clipboard}","keyword":"sig"}],
 "workflows":[
  {"id":"wf-bad","name":"Broken Demo","actions":[{"id":"x1","type":"feature","params":{"feature":"nosuchfeature","action":"nope"}}]},
  {"id":"wf-fx","name":"Effects Demo","actions":[{"id":"c3","type":"httpRequest","params":{"method":"POST","url":"https://example.invalid/hook","body":"{{input}}"}}]}
 ],"quicklinks":[]}
"""#

private func rows(_ s: [String: Any]) -> [[String: Any]] { (s["rows"] as? [[String: Any]]) ?? [] }
private func result(_ r: [String: Any]) -> Any? { r["result"] }
private func poll(_ tries: Int = 60, _ what: () throws -> Bool) rethrows -> Bool {
    for _ in 0..<tries { if try what() { return true }; usleep(50_000) }
    return false
}

@Suite("integration: features together", .serialized)
struct IntegrationE2ETests {
    func driver() throws -> GlideDriver { try GlideDriver(seed: ["data.json": Data(seed.utf8)]) }

    @Test func multiWordTitlesBeatFirstWordArguments() throws {
        let d = try driver()
        defer { d.stop() }
        _ = try d.show()
        for (q, want) in [("search snippets", "Search Snippets"), ("search menu items", "Search Menu Items"), ("new file here", "New File Here…"),
                          ("start paste stack", "Start Paste Stack"), ("broken demo", "Broken Demo")] {
            try d.send(["cmd": "setQuery", "text": q])
            #expect(try d.selectedTitle() == want, "query \(q)")
            #expect(rows(try d.state()).first?["argument"] == nil, "query \(q) must not become an argument")
        }
        // A real inline argument still works ("ask <prompt>" → Ask Glide Agent with the argument).
        try d.send(["cmd": "setQuery", "text": "ask what time is it"])
        let first = rows(try d.state()).first
        #expect(first?["title"] as? String == "Ask Glide Agent")
        #expect(first?["argument"] as? String == "what time is it")
    }

    @Test func oneAgentFallbackFollowingFallbackSettings() throws {
        let d = try driver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("zzqx plover")
        let fb = rows(try d.state()).filter { $0["section"] as? String == "fallbacks" }.compactMap { $0["title"] as? String }
        #expect(fb.filter { $0 == "Ask Glide Agent" }.count == 1)
        try d.invoke("fallbacks", "setEnabled", ["id": "agent", "enabled": false])
        try d.send(["cmd": "setQuery", "text": "zzqx plover"])
        let fb2 = rows(try d.state()).filter { $0["section"] as? String == "fallbacks" }.compactMap { $0["title"] as? String }
        #expect(!fb2.contains("Ask Glide Agent"))
        // The Fallbacks-owned agent row really starts the agent (agent/open), not just a bare push.
        try d.invoke("fallbacks", "setEnabled", ["id": "agent", "enabled": true])
        try d.send(["cmd": "setQuery", "text": "zzqx plover"])
        let idx = rows(try d.state()).firstIndex { $0["title"] as? String == "Ask Glide Agent" } ?? 0
        for _ in 0..<idx { try d.key("down") }
        try d.key("enter")
        #expect(try poll { (try d.state()["view"] as? String) == "agent.run" })
        let vs = result(try d.invoke("agent", "viewState")) as? [String: Any]
        #expect(vs != nil)
    }

    @Test func commandEnterFromRootAsksTheAgent() throws {
        let d = try driver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("zzqx plover") // only fallback rows: ⌘⏎ sends the query to Glide Agent
        try d.key("cmdEnter")
        #expect(try poll { (try d.state()["view"] as? String) == "agent.run" })
        #expect(try d.state()["contextTitle"] as? String == "Glide Agent")
        // Turned off in Agent settings: ⌘⏎ is the row's secondary action again.
        try d.invoke("launcher", "pop")
        try d.invoke("agent", "setSettings", ["launcherShortcut": false])
        try d.send(["cmd": "setQuery", "text": "zzqx plover"])
        try d.key("cmdEnter")
        usleep(200_000)
        #expect(try d.state()["view"] as? String != "agent.run")
    }

    @Test func readableContextTitlesAndQueryPrefill() throws {
        let d = try driver()
        defer { d.stop() }
        _ = try d.show()
        try d.type("search snippets")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "snippets2.search")
        #expect(s["contextTitle"] as? String == "Search Snippets")
        try d.invoke("launcher", "pop")
        // Pushed by another feature / the test channel: the feature names the view (never the raw id).
        s = try d.invoke("launcher", "push", ["view": "clipboard.history", "payload": ["query": "abc"]])
        #expect(s["contextTitle"] as? String == "Clipboard History")
        #expect(s["placeholder"] as? String == "Search clipboard history…") // push-time placeholder (first frame)
        #expect(s["query"] as? String == "abc") // payload "query" pre-fills the field
        try d.invoke("launcher", "pop")
        s = try d.invoke("launcher", "push", ["view": "workflows.prompt", "payload": NSNull()])
        #expect((s["contextTitle"] as? String)?.contains(".") == false)
        try d.invoke("launcher", "pop")
        // An argument pre-fills Search Snippets' field (Tab → argument → ⏎).
        try d.send(["cmd": "setQuery", "text": "search snippets"])
        try d.key("tab")
        try d.type("sig")
        s = try d.key("enter")
        #expect(s["view"] as? String == "snippets2.search")
        #expect(s["query"] as? String == "sig")
    }

    @Test func snippetRowsAreOwnedBySnippets2() throws {
        let d = try driver()
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("clipboard", "debugSetClipboard", ["text": "Olu"])
        try d.type("signature block")
        let first = rows(try d.state()).first
        #expect(first?["id"] as? String == "snippet:sn-1")
        #expect(first?["title"] as? String == "Signature Block")
        try d.key("enter")
        #expect(try poll { d.sideEffects.contains { $0.kind == "paste" && $0.detail.contains("Best, Olu") } })
        // Edit → Settings deep link with a sub-route that reaches the editor.
        try d.send(["cmd": "setQuery", "text": "signature block"])
        try d.key("cmd+e")
        #expect(try poll { d.sideEffects.contains { $0.kind == "open-settings" && $0.detail.contains("snippets/sn-1") } })
        let ed = result(try d.invoke("snippets2", "editorState")) as? [String: Any]
        #expect(ed?["selectedId"] as? String == "sn-1")
    }

    @Test func settingsSubRoutesReachThePage() throws {
        let d = try driver()
        defer { d.stop() }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("glide-integ-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        _ = try d.send(["cmd": "snapshot", "target": "settings", "page": "workflows/wf-fx", "path": dir.appendingPathComponent("wf.png").path])
        let sel = result(try d.invoke("workflows", "editorSelection")) as? [String: Any]
        #expect(sel?["selectedId"] as? String == "wf-fx" || sel?["requested"] as? String == "wf-fx")
        _ = try d.send(["cmd": "snapshot", "target": "settings", "page": "snippets/sn-1", "path": dir.appendingPathComponent("sn.png").path])
        #expect((result(try d.invoke("snippets2", "editorState")) as? [String: Any])?["selectedId"] as? String == "sn-1")
    }

    @Test func featureEffectsLandInHeadlessEffects() throws {
        let d = try driver()
        defer { d.stop() }
        _ = try d.invoke("workflows", "run", ["workflowId": "wf-fx", "input": "ping"])
        let effects = (result(try d.invoke("headless", "effects")) as? [[String: Any]]) ?? []
        #expect(effects.contains { $0["kind"] as? String == "http" })
        // Timers' countdown goes through the shared status-item API (`services.statusItems`; the headless fake records
        // `status-item`, never an NSStatusItem). The Menu Bar Timers extra (on by default) would claim it, so turn it off.
        _ = try d.invoke("menubar", "setSettings", ["timers": false])
        _ = try d.invoke("timers", "start", ["ms": 60_000, "name": "Tea"])
        #expect(try poll { d.sideEffects.contains { $0.kind == "status-item" && $0.detail.contains("timers") } })
    }

    // MARK: callFeature contracts (shapes the callers send → what they parse)

    @Test func agentAndMenuBarContracts() throws {
        let d = try driver()
        defer { d.stop() }
        // agent → transforms.apply {id, input}
        let tr = result(try d.invoke("transforms", "apply", ["id": "upper", "input": "abc"])) as? [String: Any]
        #expect(tr?["output"] as? String == "ABC")
        // agent → timers.start {ms, name} / state / stop {id}
        let st = result(try d.invoke("timers", "start", ["ms": 90_000.0, "name": "Pasta"])) as? [String: Any]
        #expect(st?["ok"] as? Bool == true)
        let ts = result(try d.invoke("timers", "state")) as? [String: Any]
        let timer = (ts?["timers"] as? [[String: Any]])?.first
        #expect(timer?["name"] as? String == "Pasta")
        #expect(timer?["durationMs"] != nil && timer?["startedAt"] != nil)
        // menubar → timers.toggle with a bare string id; agent → timers.stop {id}
        _ = try d.invoke("timers", "toggle", timer?["id"] as? String ?? "")
        _ = try d.invoke("timers", "stop", ["id": timer?["id"] as? String ?? ""])
        // agent → notes.create {text, body} / save {id, text} / search {query} / remove {id} → bool
        let note = result(try d.invoke("notes", "create", ["text": "hello integration"])) as? [String: Any]
        let nid = note?["id"] as? String ?? ""
        #expect(!nid.isEmpty)
        _ = try d.invoke("notes", "save", ["id": nid, "text": "hello integration saved"])
        let found = (result(try d.invoke("notes", "search", ["query": "integration"])) as? [[String: Any]]) ?? []
        #expect(found.contains { $0["id"] as? String == nid })
        #expect(result(try d.invoke("notes", "get", ["id": nid])).map { "\($0)" }?.contains("saved") == true)
        #expect(result(try d.invoke("notes", "remove", ["id": nid])) as? Bool == true)
        #expect(result(try d.invoke("notes", "remove", ["id": nid])) as? Bool == false)
        // agent → automations.state / layouts.state
        #expect((result(try d.invoke("automations", "state")) as? [String: Any])?["automations"] is [Any])
        #expect((result(try d.invoke("layouts", "state")) as? [String: Any])?["layouts"] is [Any])
        // agent/menubar → clipboard.list {query, limit} → array
        try d.invoke("clipboard", "debugSetClipboard", ["text": "contract clip"])
        let clips = (result(try d.invoke("clipboard", "list", ["query": "contract", "limit": 5])) as? [Any]) ?? []
        #expect(clips.count == 1)
        // agent → sysmon.sample {record:false} has the fields statusText parses (incl. top)
        let sm = result(try d.invoke("sysmon", "sample", ["record": false])) as? [String: Any]
        #expect(sm?["cpu"] is [String: Any] && sm?["top"] is [Any])
        // agent → processes.list {limit} returns everything asked for
        let pl = result(try d.invoke("processes", "list", ["limit": 100_000])) as? [String: Any]
        #expect((pl?["processes"] as? [Any])?.count == pl?["count"] as? Int)
        // agent → convert.preview {query}
        _ = try d.invoke("convert", "preview", ["query": "10 km in mi"])
        // agent → workflows.run {id, input}: failures carry the step error in log[].error
        let wr = result(try d.invoke("workflows", "run", ["id": "wf-bad", "input": ""])) as? [String: Any]
        #expect(wr?["ok"] as? Bool == false)
        #expect(((wr?["log"] as? [[String: Any]]) ?? []).contains { $0["status"] as? String == "error" && $0["error"] is String })
        // menubar → agent.cancel with a bare runId string; agent.activeRun
        #expect(result(try d.invoke("agent", "cancel", "no-such-run")) as? Bool == false)
        _ = try d.invoke("agent", "activeRun")
        // menubar → calendar.schedule (headless: no EventKit access → a status, never a prompt)
        let cal = result(try d.invoke("calendar", "schedule")) as? [String: Any]
        #expect(cal?["status"] is String)
        // menubar state renders from all of the above without errors
        _ = try d.invoke("menubar", "setSettings", ["timers": true, "clipboard": true, "meeting": true, "agent": true])
        _ = try d.invoke("menubar", "state")
    }
}
