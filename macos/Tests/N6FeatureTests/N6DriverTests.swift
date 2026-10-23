import Foundation
import GlideTestHarness
import Testing

/// Headless end-to-end checks for Workflows + Automations over the test channel. Nothing reaches the screen,
/// the pasteboard, the network or another app: shell/AppleScript/notify/open are fakes in the side-effect log.
/// Needs the Glide executable built first (`swift build`); skipped when it is missing.
let n6SnapshotDir = ProcessInfo.processInfo.environment["GLIDE_SNAPSHOT_DIR"] ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-snapshots").path

private let seed = #"""
{"settings":{"keepOpenAfterRun":true},"workflows":[
 {"id":"wf-ask","name":"Ask Name Demo","icon":{"kind":"emoji","value":"👋"},"actions":[
   {"id":"a1","type":"askInput","params":{"prompt":"What's your name?","placeholder":"Name"}},
   {"id":"a2","type":"setClipboard","params":{"text":"Hello {{input}}"}},
   {"id":"a3","type":"notify","params":{"title":"Greeted","body":"{{clipboard}}"}}]},
 {"id":"wf-show","name":"Show Demo","icon":{"kind":"emoji","value":"🪟"},"actions":[
   {"id":"b1","type":"setVariable","params":{"name":"x","value":"forty-two"}},
   {"id":"b2","type":"feature","params":{"feature":"transforms","action":"upper","text":"{{x}}"}},
   {"id":"b3","type":"showResult","params":{"text":"Answer: {{result}}","title":"Result"}}]},
 {"id":"wf-fx","name":"Effects Demo","icon":{"kind":"emoji","value":"🧪"},"actions":[
   {"id":"c1","type":"runShell","params":{"command":"echo {{input}}","shell":"/bin/zsh"}},
   {"id":"c2","type":"runAppleScript","params":{"script":"return 1"}},
   {"id":"c3","type":"httpRequest","params":{"method":"POST","url":"https://example.invalid/hook","body":"{{input}}"}},
   {"id":"c4","type":"condition","params":{"left":"{{input}}","operator":"contains","right":"go"},
    "then":[{"id":"c5","type":"runWorkflow","params":{"workflowId":"wf-note","input":"nested {{input}}"}}],"else":[]},
   {"id":"c6","type":"playSound","params":{"name":"Glass"}}]},
 {"id":"wf-note","name":"Note Demo","icon":{"kind":"emoji","value":"📝"},"actions":[
   {"id":"d1","type":"notify","params":{"title":"Note","body":"{{input}}"}}]}
],"quicklinks":[],"snippets":[]}
"""#

@Suite("N6 headless driver", .serialized)
struct N6DriverTests {
    func driver() throws -> GlideDriver? {
        guard GlideDriver.defaultBinary() != nil else { return nil }
        return try GlideDriver(seed: ["data.json": Data(seed.utf8)])
    }
    func effects(_ d: GlideDriver, _ kind: String) -> [String] { d.sideEffects.filter { $0.kind == kind }.map(\.detail) }
    func wait(_ what: () throws -> Bool) rethrows {
        for _ in 0..<40 { if try what() { return }; usleep(50_000) }
    }

    @Test func launcherPromptResultAndEffects() throws {
        guard let d = try driver() else { return }
        defer { d.stop() }
        _ = try d.show()
        try d.type("ask name demo")
        var s = try d.key("enter")
        try wait { (try d.state()["view"] as? String) == "workflows.prompt" }
        s = try d.state()
        #expect(s["view"] as? String == "workflows.prompt")
        #expect(s["placeholder"] as? String == "Name")
        _ = try d.snapshot("\(n6SnapshotDir)/n6-launcher-prompt.png")
        try d.type("Bo")
        s = try d.key("enter")
        try wait { (try d.invoke("headless", "pasteboard")["result"] as? String) == "Hello Bo" }
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "Hello Bo")
        try wait { effects(d, "notify").contains { $0.contains("Greeted") } }
        #expect(effects(d, "notify").contains { $0.contains("Hello Bo") })
        #expect(try d.state()["view"] is NSNull)

        // Escape cancels a prompt; the run is logged as cancelled.
        try d.send(["cmd": "setQuery", "text": ""])
        try d.type("ask name demo")
        _ = try d.key("enter")
        try wait { (try d.state()["view"] as? String) == "workflows.prompt" }
        _ = try d.key("esc")
        try wait { (try d.invoke("workflows", "lastRun", ["workflowId": "wf-ask"])["result"] as? [String: Any])?["ok"] as? Bool == false }
        #expect(try d.state()["toast"] as? String == "Cancelled")
        #expect(try d.state()["mode"] as? String == "insert")

        // showResult pushes the result view; ⏎ copies it.
        try d.send(["cmd": "setQuery", "text": ""])
        try d.type("show demo")
        _ = try d.key("enter")
        try wait { (try d.state()["view"] as? String) == "workflows.result" }
        _ = try d.snapshot("\(n6SnapshotDir)/n6-launcher-result.png")
        _ = try d.key("enter")
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "Answer: FORTY-TWO")

        // Shell / AppleScript / HTTP / sound never run for real: recorded only. Nested workflow via If.
        let r = try d.invoke("workflows", "run", ["workflowId": "wf-fx", "input": "let's go"])["result"] as? [String: Any]
        #expect(r?["ok"] as? Bool == true)
        #expect(effects(d, "shell").contains { $0.contains("echo let's go") })
        #expect(effects(d, "applescript").contains { $0.contains("return 1") })
        try wait { d.outputLines.contains { $0.hasPrefix("[headless] http") } }
        #expect(d.outputLines.contains { $0.hasPrefix("[headless] http") && $0.contains("example.invalid") })
        #expect(d.outputLines.contains { $0.hasPrefix("[headless] sound") })
        #expect(effects(d, "notify").contains { $0.contains("nested let's go") })

        // The editor renders offscreen (never on screen).
        let snap = try d.invoke("workflows", "snapshotEditor", ["workflowId": "wf-fx", "path": "\(n6SnapshotDir)/n6-workflow-editor.png", "select": "3"])["result"] as? [String: Any]
        #expect((snap?["width"] as? Int ?? 0) > 1000)
        _ = try d.invoke("workflows", "snapshotEditor", ["workflowId": "wf-show", "path": "\(n6SnapshotDir)/n6-workflow-editor-library.png", "library": true, "dark": false])
        let specs = try d.invoke("workflows", "specs")["result"] as? [[String: Any]] ?? []
        #expect(specs.count > 17 && specs.contains { $0["feature"] as? String == "transforms" })
    }

    @Test func automationsTriggerAskAndPersist() throws {
        guard let d = try driver() else { return }
        defer { d.stop() }
        _ = try d.show()
        // Event trigger → workflow (not risky: runs unattended).
        var r = try d.invoke("automations", "save", ["automation": ["name": "On Mail", "trigger": ["kind": "app", "event": "launched", "app": "Mail"],
                                                                    "target": ["kind": "workflow", "workflowId": "wf-note"]]])["result"] as? [String: Any]
        #expect(r?["ok"] as? Bool == true)
        r = try d.invoke("automations", "debugEvent", ["event": ["type": "app", "event": "launched", "name": "Mail", "bundleId": "com.apple.mail"]])["result"] as? [String: Any]
        #expect(((r?["results"] as? [[String: Any]])?.first?["status"]) as? String == "ok")
        #expect(effects(d, "notify").contains { $0.contains("Mail") })

        // Hotkey trigger → risky workflow → asks first; answered through the API.
        r = try d.invoke("automations", "save", ["automation": ["id": "hk", "name": "Hotkey FX", "trigger": ["kind": "hotkey", "accelerator": "Control+Alt+Shift+F"],
                                                                "target": ["kind": "workflow", "workflowId": "wf-fx"]]])["result"] as? [String: Any]
        #expect((r?["automation"] as? [String: Any])?["askBeforeRunning"] as? Bool == true)
        let hk = try d.invoke("headless", "hotkeys")["result"] as? [[String: Any]] ?? []
        let binding = hk.first { ($0["id"] as? String)?.hasSuffix("automation:hk") == true }
        #expect(binding?["accelerator"] as? String == "Control+Alt+Shift+F")
        _ = try d.invoke("headless", "pressHotkey", ["id": binding?["id"] as? String ?? ""])
        var pending: [[String: Any]] = []
        try wait {
            pending = ((try d.invoke("automations", "state")["result"] as? [String: Any])?["pending"] as? [[String: Any]]) ?? []
            return !pending.isEmpty
        }
        #expect(pending.first?["name"] as? String == "Hotkey FX")
        #expect(effects(d, "notify").contains { $0.contains("Run “Hotkey FX”?") })
        _ = try d.invoke("automations", "snapshotSettings", ["path": "\(n6SnapshotDir)/n6-automations-settings.png", "select": "hk"])
        try d.invoke("launcher", "push", ["view": "automations.list"])
        _ = try d.snapshot("\(n6SnapshotDir)/n6-launcher-automations.png")
        _ = try d.invoke("automations", "answer", ["pendingId": pending.first?["id"] as? String ?? "", "run": true])
        try wait { effects(d, "shell").contains { $0.contains("echo") } }
        #expect(effects(d, "shell").count == 1)

        // Interval trigger fires on a tick once due; data is the Electron automations.json shape.
        _ = try d.invoke("automations", "flush")
        let file = d.dataDirectory.appendingPathComponent("features/automations/automations.json")
        let doc = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        #expect(doc?["version"] as? Int == 1)
        let list = doc?["automations"] as? [[String: Any]] ?? []
        #expect(list.count == 2)
        let hkLog = list.first { $0["id"] as? String == "hk" }?["log"] as? [[String: Any]]
        #expect(hkLog?.first?["status"] as? String == "ok")
        #expect((list.first?["trigger"] as? [String: Any])?["kind"] as? String == "app")
    }
}
