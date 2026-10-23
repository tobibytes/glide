import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

@Suite("workflow template + migration")
struct WorkflowTemplateTests {
    @Test func substitutes() {
        let v = ["input": "hi", "result": "R", "a.b-c": "x"]
        #expect(WorkflowTemplate.substitute("say {{input}} / {{ result }} / {{missing}} / {{a.b-c}}", v) == "say hi / R /  / x")
        #expect(WorkflowTemplate.substitute("{{not a var}} {{ }} {{input", v) == "{{not a var}} {{ }} {{input")
        #expect(WorkflowTemplate.references("{{input}} {{clipboard}} {{input}} {{x y}}") == ["input", "clipboard"])
    }

    @Test func conditions() {
        #expect(WorkflowTemplate.evaluateCondition("yes", "equals", "yes"))
        #expect(!WorkflowTemplate.evaluateCondition("yes", "equals", "Yes"))
        #expect(WorkflowTemplate.evaluateCondition("hello world", "contains", "lo w"))
        #expect(WorkflowTemplate.evaluateCondition("hello", "startsWith", "he"))
        #expect(WorkflowTemplate.evaluateCondition("abc123", "matches regex", "^[a-z]+\\d+$"))
        #expect(!WorkflowTemplate.evaluateCondition("abc", "matches regex", "(["))
        #expect(WorkflowTemplate.evaluateCondition("  ", "isEmpty", ""))
        #expect(WorkflowTemplate.evaluateCondition("x", "isNotEmpty", ""))
        #expect(WorkflowTemplate.evaluateCondition("10", ">", "9"))   // numeric, not lexicographic
        #expect(WorkflowTemplate.evaluateCondition("b", ">", "a"))    // falls back to string order
        #expect(WorkflowTemplate.evaluateCondition("2", "<", "10"))
        #expect(!WorkflowTemplate.evaluateCondition("x", "bogus", "x"))
    }

    @Test func builtinVariables() {
        let d = Date(timeIntervalSince1970: 1_800_000_000) // 2027-01-15 08:00 UTC
        let v = WorkflowTemplate.builtinVariables(now: d, locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
        #expect(v["date"] == "1/15/2027")
        #expect(v["time"]?.contains("8:00") == true)
        #expect(v["timestamp"] == "1800000000000")
    }

    @Test func migratesFeatureForms() throws {
        let json = #"""
        {"id":"w","name":"W","actions":[
          {"id":"1","type":"feature:transforms.upper","params":{"text":"a"}},
          {"id":"2","type":"feature","feature":"timers","action":"start","params":{"duration":"5m"}},
          {"id":"3","type":"condition","params":{"left":"a"},"then":[{"id":"4","type":"feature:convert.convert","params":{}}]}
        ]}
        """#
        let w = try JSONDecoder().decode(Workflow.self, from: Data(json.utf8))
        let m = WorkflowMigration.migrate(w)
        #expect(m.actions[0].type == "feature" && m.actions[0].param("feature") == "transforms" && m.actions[0].param("action") == "upper")
        #expect(m.actions[1].param("feature") == "timers" && m.actions[1].param("action") == "start" && m.actions[1].extra["feature"] == nil)
        #expect(m.actions[2].then?[0].param("feature") == "convert")
        // Canonical and plain actions round-trip unchanged through data.json encoding.
        let again = try JSONDecoder().decode(Workflow.self, from: JSONEncoder.glide.encode(m))
        #expect(again == m)
    }

    @Test func seventeenBuiltins() {
        #expect(WorkflowSpecs.builtins.count == 17)
        #expect(Set(WorkflowSpecs.builtins.map(\.type)) == ["openApp", "openUrl", "runShell", "runAppleScript", "typeText", "setClipboard", "getClipboard", "notify", "wait",
                                                             "askInput", "setVariable", "condition", "httpRequest", "runWorkflow", "showResult", "openFile", "playSound"])
        let c = WorkflowSpecs.builtin("condition")!.makeAction()
        #expect(c.then == [] && c.else == [] && c.param("operator") == "equals")
    }
}

@Suite("workflow runtime") @MainActor
struct WorkflowRuntimeTests {
    func runtime(_ env: FakeWorkflowEnv, _ reg: WorkflowActionRegistry = WorkflowActionRegistry()) -> WorkflowRuntime { WorkflowRuntime(env: env, registry: reg) }

    @Test func allBuiltinsRunWithVariables() async {
        let env = FakeWorkflowEnv()
        env.clipboard = "CLIP"
        env.answers = ["typed answer"]
        let w = wf("w1", [
            act("a1", "openApp", ["app": "Notes"]),
            act("a2", "openUrl", ["url": "https://example.com/?q={{input}}"]),
            act("a3", "runShell", ["command": "echo {{clipboard}}", "shell": "/bin/bash"]),
            act("a4", "runAppleScript", ["script": "return \"{{stdout}}\""]),
            act("a5", "typeText", ["text": "hello {{scriptResult}}"]),
            act("a6", "getClipboard"),
            act("a7", "setClipboard", ["text": "set {{result}}"]),
            act("a8", "notify", ["title": "T", "body": "{{clipboard}}"]),
            act("a9", "wait", ["seconds": "2.5"]),
            act("a10", "askInput", ["prompt": "Q?", "placeholder": "p"]),
            act("a11", "setVariable", ["name": "greeting", "value": "Hi {{input}}"]),
            act("a12", "httpRequest", ["method": "post", "url": "https://api.example.com/x", "headers": "A: 1\nB:2\nbad", "body": "{{greeting}}"]),
            act("a13", "showResult", ["text": "{{response}} {{status}}", "title": "Res"]),
            act("a14", "openFile", ["path": "~/notes.txt"]),
            act("a15", "playSound", ["name": "Ping!"]),
            act("a16", "notify", ["title": "{{date}}|{{selection}}"]),
        ])
        let r = await runtime(env).run(w, input: "in put")
        #expect(r.ok)
        #expect(r.log.count == 16 && r.log.allSatisfy { $0.status == .ok })
        #expect(env.effects.contains("openApp:Notes"))
        #expect(env.effects.contains("openUrl:https://example.com/?q=in%20put") || env.effects.contains("openUrl:https://example.com/?q=in put"))
        #expect(env.effects.contains("shell:/bin/bash:echo CLIP"))
        #expect(env.effects.contains("applescript:return \"shell-out\""))
        #expect(env.effects.contains("type:hello as-out"))
        #expect(env.effects.contains("clipboard:set CLIP"))
        #expect(env.effects.contains("notify:T|set CLIP"))
        #expect(env.slept == [2.5])
        #expect(env.effects.contains("http:POST https://api.example.com/x A=1,B=2 Hi typed answer"))
        #expect(env.effects.contains("show:Res|{\"ok\":true} 200"))
        #expect(env.effects.contains("openFile:\(NSHomeDirectory())/notes.txt"))
        #expect(env.effects.contains("sound:Ping"))
        #expect(env.effects.contains("selection"))
        #expect(r.variables["greeting"] == "Hi typed answer")
        #expect(r.variables["input"] == "typed answer")
        #expect(r.result == "{\"ok\":true} 200") // showResult output
    }

    @Test func conditionBranchesAndDisabled() async {
        let env = FakeWorkflowEnv()
        let w = wf("w", [
            act("c", "condition", ["left": "{{input}}", "operator": "equals", "right": "yes"],
                then: [act("t1", "notify", ["title": "then"]), act("t2", "notify", ["title": "skip"], disabled: true)],
                else: [act("e1", "notify", ["title": "else"])]),
        ])
        let yes = await runtime(env).run(w, input: "yes")
        #expect(env.effects == ["notify:then|"])
        #expect(yes.log.map(\.actionId) == ["t1", "t2", "c"])
        #expect(yes.log[1].status == .skipped)
        #expect(yes.log[0].depth == 1)
        env.effects = []
        _ = await runtime(env).run(w, input: "no")
        #expect(env.effects == ["notify:else|"])
    }

    @Test func failureStopsUnlessContinueOnError() async {
        let env = FakeWorkflowEnv()
        env.shellResult = ShellResult(status: 2, stdout: "", stderr: "boom\n")
        let stop = wf("w", [act("s", "runShell", ["command": "x"]), act("n", "notify", ["title": "after"])])
        let r = await runtime(env).run(stop)
        #expect(!r.ok && r.firstError == "boom" && !env.effects.contains("notify:after|"))
        let cont = wf("w", [act("s", "runShell", ["command": "x", "continueOnError": "true"]), act("n", "notify", ["title": "after"])])
        let r2 = await runtime(env).run(cont)
        #expect(r2.ok && env.effects.contains("notify:after|"))
        env.httpResult = (404, "nope")
        let h = await runtime(env).run(wf("h", [act("h", "httpRequest", ["url": "https://x.dev"])]))
        #expect(h.firstError == "HTTP 404: nope" && h.variables["status"] == "404")
        let bad = await runtime(env).run(wf("b", [act("u", "openUrl", ["url": "not a url"]), act("v", "setVariable", ["name": "bad name"])]))
        #expect(bad.firstError == "Invalid URL: not a url")
        let badVar = await runtime(env).run(wf("b", [act("v", "setVariable", ["name": "bad name"])]))
        #expect(badVar.firstError == "Invalid variable name \"bad name\"")
        let unknown = await runtime(env).run(wf("b", [act("v", "teleport")]))
        #expect(unknown.firstError?.contains("teleport") == true)
    }

    @Test func askInputCancelled() async {
        let env = FakeWorkflowEnv()
        let r = await runtime(env).run(wf("w", [act("a", "askInput", ["prompt": "Q"]), act("n", "notify", ["title": "x"])]))
        #expect(!r.ok && r.firstError == "Cancelled" && env.effects == ["ask:Q"])
    }

    @Test func nestedWorkflowsAndDepthLimit() async {
        let env = FakeWorkflowEnv()
        let child = wf("child", "Child", [act("c1", "setVariable", ["name": "x", "value": "child got {{input}}"])])
        env.workflows = [child, wf("loop", "Loop", [act("l", "runWorkflow", ["workflowId": "loop"])])]
        let parent = wf("p", [act("p0", "setVariable", ["name": "v", "value": "seed"]), act("p1", "runWorkflow", ["workflowId": "child"]), act("p2", "notify", ["title": "{{workflowResult}}"])])
        let r = await runtime(env).run(parent)
        #expect(r.ok)
        #expect(env.effects == ["notify:child got seed|"]) // input defaults to {{result}}
        #expect(r.log.map(\.actionId) == ["p0", "c1", "p1", "p2"])
        #expect(r.log[1].depth == 1)
        let loop = await runtime(env).run(env.workflows[1])
        #expect(!loop.ok)
        #expect(loop.firstError?.contains("deeper than 5") == true || loop.log.contains { $0.error?.contains("deeper than 5") == true })
        let missing = await runtime(env).run(wf("m", [act("x", "runWorkflow", ["workflowId": "nope"])]))
        #expect(missing.firstError == "Workflow not found: nope")
    }

    @Test func featureActionsRegistryAndOutputVar() async throws {
        let env = FakeWorkflowEnv()
        let reg = WorkflowActionRegistry()
        reg.registerDefault(feature: "demo", FeatureWorkflowAction(id: "shout", title: "Default", params: [WorkflowParamSpec("text", "Text", default: "{{input}}")]) { p, _ in
            FeatureActionOutput(result: "default \(p["text"] ?? "")")
        })
        // The feature's own registration replaces the host default; a later default never replaces it.
        let unregister = reg.register(feature: "demo", FeatureWorkflowAction(id: "shout", title: "Shout", params: [WorkflowParamSpec("text", "Text", default: "{{input}}")], outputVar: "shouted") { p, vars in
            FeatureActionOutput(result: (p["text"] ?? "").uppercased() + "!", vars: ["seen": vars["input"] ?? ""])
        })
        reg.registerDefault(feature: "demo", FeatureWorkflowAction(id: "shout", title: "Other") { _, _ in FeatureActionOutput(result: "other") })
        #expect(reg.featureSpecs.map(\.title) == ["Shout"])
        let spec = try #require(reg.featureSpecs.first)
        #expect(spec.id == "feature:demo.shout")
        #expect(spec.params.prefix(2).map(\.kind) == [.hidden, .hidden])
        #expect(spec.makeAction().param("feature") == "demo")
        let w = wf("w", [act("f", "feature", ["feature": "demo", "action": "shout"]), act("n", "notify", ["title": "{{shouted}} {{seen}} {{result}}"]),
                         WorkflowAction(id: "g", type: "feature:demo.shout", params: ["text": "compact"])])
        let r = await runtime(env, reg).run(w, input: "hey")
        #expect(r.ok)
        #expect(env.effects.contains("notify:HEY! hey HEY!|"))
        #expect(r.result == "COMPACT!")
        unregister()
        let gone = await runtime(env, reg).run(wf("w", [act("f", "feature", ["feature": "demo", "action": "shout"])]))
        #expect(gone.firstError?.contains("is not available") == true)
    }

    @Test func cancellation() async {
        let env = FakeWorkflowEnv()
        env.sleepHook = { try await Task.sleep(for: .seconds(30)) }
        let rt = runtime(env)
        let w = wf("w", [act("s", "wait", ["seconds": "30"]), act("n", "notify", ["title": "never"])])
        let task = Task { @MainActor in await rt.run(w) }
        try? await Task.sleep(for: .milliseconds(50))
        task.cancel()
        let r = await task.value
        #expect(!r.ok && r.cancelled == true && !env.effects.contains { $0.hasPrefix("notify") })
    }

    @Test func availableVariables() {
        let actions = [act("a", "runShell", ["command": "x"]), act("b", "setVariable", ["name": "foo"]),
                       act("c", "condition", ["left": "1"], then: [act("d", "httpRequest", ["url": "u"]), act("e", "notify")])]
        let names = WorkflowVariables.available(before: [.index(2), .then, .index(1)], in: actions, specs: WorkflowSpecs.builtins).map(\.name)
        #expect(names.contains("stdout") && names.contains("foo") && names.contains("response") && names.contains("status"))
        let early = WorkflowVariables.available(before: [.index(0)], in: actions, specs: WorkflowSpecs.builtins).map(\.name)
        #expect(!early.contains("stdout") && early.contains("input"))
    }
}

@Suite("workflow tree")
struct WorkflowTreeTests {
    let root = [act("a", "notify"), act("c", "condition", then: [act("t", "notify")], else: []), act("b", "notify")]

    @Test func paths() {
        #expect(WorkflowTree.flatten(root).map(WorkflowTree.key) == ["0", "1", "1/then/0", "2"])
        #expect(WorkflowTree.parse("1/then/0") == [.index(1), .then, .index(0)])
        #expect(WorkflowTree.action(root, [.index(1), .then, .index(0)])?.id == "t")
        #expect(WorkflowTree.count(root) == 4)
    }

    @Test func moveIntoAndOutOfBranches() {
        // a → into the If's else branch; the If shifts up to index 0.
        let r = WorkflowTree.move(root, from: [.index(0)], to: [.index(1), .else], index: 0)
        #expect(r.root.map(\.id) == ["c", "b"])
        #expect(r.root[0].else?.map(\.id) == ["a"])
        #expect(r.path == [.index(0), .else, .index(0)])
        // t → out to the end of the root.
        let o = WorkflowTree.move(root, from: [.index(1), .then, .index(0)], to: [], index: 3)
        #expect(o.root.map(\.id) == ["a", "c", "b", "t"] && o.root[1].then == [])
        // Moving down within one list accounts for the removal.
        let d = WorkflowTree.move(root, from: [.index(0)], to: [], index: 2)
        #expect(d.root.map(\.id) == ["c", "a", "b"])
        // Never into itself.
        let s = WorkflowTree.move(root, from: [.index(1)], to: [.index(1), .then], index: 0)
        #expect(s.root == root)
    }

    @Test func nudgeCloneInsert() {
        let n = WorkflowTree.nudge(root, [.index(2)], by: -1)
        #expect(n.root.map(\.id) == ["a", "b", "c"] && n.path == [.index(1)])
        #expect(WorkflowTree.nudge(root, [.index(0)], by: -1).root == root)
        let c = WorkflowTree.clone(root[1])
        #expect(c.id != "c" && c.then?.first?.id != "t" && c.then?.first?.type == "notify")
        let i = WorkflowTree.insert(root, [.index(1), .else], 0, act("x", "wait"))
        #expect(i[1].else?.map(\.id) == ["x"])
        #expect(WorkflowTree.remove(i, [.index(1), .else, .index(0)])[1].else == [])
    }
}

@Suite("builtin feature actions") @MainActor
struct BuiltinFeatureActionTests {
    @Test func parseDurations() {
        #expect(BuiltinFeatureActions.parseDuration("25m")?.ms == 25 * 60_000)
        #expect(BuiltinFeatureActions.parseDuration("1h30m")?.ms == 90 * 60_000)
        #expect(BuiltinFeatureActions.parseDuration("5:00")?.ms == 300_000)
        #expect(BuiltinFeatureActions.parseDuration("1:02:03")?.ms == 3_723_000)
        #expect(BuiltinFeatureActions.parseDuration("90s")?.ms == 90_000)
        let named = BuiltinFeatureActions.parseDuration("25 min tea")
        #expect(named?.ms == 25 * 60_000 && named?.name == "tea")
        let tail = BuiltinFeatureActions.parseDuration("tea 3m")
        #expect(tail?.ms == 180_000 && tail?.name == "tea")
        #expect(BuiltinFeatureActions.parseDuration("soon") == nil)
    }

    @Test func registersHostDefaultsAndRunsThem() async throws {
        let ctx = try FakeFeatureContext(featureId: "workflows")
        let reg = WorkflowActionRegistry()
        BuiltinFeatureActions.registerAll(reg, context: ctx)
        #expect(reg.has(feature: "transforms", action: "upper"))
        #expect(reg.has(feature: "timers", action: "start") && reg.has(feature: "layouts", action: "restore") && reg.has(feature: "ocr", action: "captureText"))
        #expect(reg.has(feature: "automations", action: "runNow") && reg.has(feature: "convert", action: "convert"))
        let env = FakeWorkflowEnv()
        let rt = WorkflowRuntime(env: env, registry: reg)
        var w = wf("w", [reg.featureSpecs.first { $0.action == "upper" }!.makeAction()])
        var r = await rt.run(w, input: "x")
        #expect(r.ok == false) // {{result}} is empty at the start: "No input text"
        w.actions.insert(act("s", "setVariable", ["name": "v", "value": "make me loud"]), at: 0)
        r = await rt.run(w)
        #expect(r.ok && r.result == "MAKE ME LOUD")
        // A missing feature fails the step with the callee's error.
        let t = await rt.run(wf("t", [act("t", "feature", ["feature": "timers", "action": "start", "duration": "25m"])]))
        #expect(t.firstError?.contains("timers") == true)
        let bad = await rt.run(wf("t", [act("t", "feature", ["feature": "timers", "action": "start", "duration": "whenever"])]))
        #expect(bad.firstError?.contains("Not a duration") == true)
        // Screen OCR never runs headless.
        let ocr = await rt.run(wf("o", [act("o", "feature", ["feature": "ocr", "action": "captureText", "source": "screen"])]))
        #expect(ocr.firstError == "Interactive screen capture is disabled in headless mode")
        // convert: first convert row of a launcher search.
        var conv = SearchItem(id: "convert:1", kind: .calculator, title: "10 km in mi", text: "6.2137 mi", feature: "convert")
        conv.subtitle = "6.2137 mi"
        ctx.items = [conv]
        let c = await rt.run(wf("c", [act("c", "feature", ["feature": "convert", "action": "convert", "query": "10 km in mi"]), act("n", "notify", ["title": "{{converted}}"])]))
        #expect(c.ok && env.effects.contains("notify:6.2137 mi|"))
    }
}
