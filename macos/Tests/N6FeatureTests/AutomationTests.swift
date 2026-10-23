import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

@Suite("automation model")
struct AutomationModelTests {
    @Test func validatesElectronJSON() throws {
        let raw = #"""
        {"id":"a1","name":"","enabled":true,"askBeforeRunning":false,"trigger":{"kind":"time","time":"7:05","days":[5,1,1,9]},
         "target":{"kind":"workflow","workflowId":"wf-1"},"createdAt":1,"updatedAt":2,
         "log":[{"id":"r1","at":1700000000000,"trigger":"Run Now","status":"ok","message":"Finished","durationMs":12,"manual":true},{"bogus":true}],
         "futureField":"kept by the engine? no — Electron drops it too"}
        """#
        let v = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
        guard case let .ok(a) = AutomationModel.validate(v, now: 99) else { Issue.record("invalid"); return }
        #expect(a.trigger == .time(time: "07:05", days: [1, 5]))
        #expect(a.name == "Mon, Fri at 07:05")
        #expect(a.log.count == 1 && a.log[0].manual == true)
        // Re-encodes to the same shape the Electron app reads.
        let j = a.json
        #expect(j["trigger"]?["time"]?.stringValue == "07:05")
        #expect(j["target"]?["workflowId"]?.stringValue == "wf-1")
        #expect(j["log"]?.arrayValue?.first?["at"]?.intValue == 1_700_000_000_000)
        guard case let .ok(b) = AutomationModel.validate(j, now: 0) else { Issue.record("roundtrip"); return }
        #expect(b == a)
    }

    @Test func rejectsAndClamps() {
        func err(_ s: String) -> String? {
            let v = (try? JSONDecoder().decode(JSONValue.self, from: Data(s.utf8))) ?? .null
            if case let .error(e) = AutomationModel.validate(v, now: 0) { return e }
            return nil
        }
        #expect(err(#"{"trigger":{"kind":"time","time":"25:00"},"target":{"kind":"workflow","workflowId":"x"}}"#) == "Enter a time like 09:00")
        #expect(err(#"{"trigger":{"kind":"folder","path":" "},"target":{"kind":"workflow","workflowId":"x"}}"#) == "Choose a folder")
        #expect(err(#"{"trigger":{"kind":"hotkey"},"target":{"kind":"workflow","workflowId":"x"}}"#) == "Record a hotkey")
        #expect(err(#"{"trigger":{"kind":"launch"},"target":{"kind":"command"}}"#) == "Choose a workflow or command to run")
        #expect(AutomationModel.normalizeTrigger(["kind": "interval", "minutes": "0"]) == .interval(minutes: 1))
        #expect(AutomationModel.normalizeTrigger(["kind": "interval", "minutes": 99999999]) == .interval(minutes: 10080))
        #expect(AutomationModel.normalizeTrigger(["kind": "power", "event": "nope", "percent": 300]) == .power(event: "below", percent: 100))
        #expect(AutomationModel.normalizeTrigger(["kind": "time", "time": "09:00", "days": [0, 1, 2, 3, 4, 5, 6]]) == .time(time: "09:00", days: []))
    }

    @Test func describes() {
        #expect(AutomationModel.describe(.interval(minutes: 120)) == "Every 2 hours")
        #expect(AutomationModel.describe(.interval(minutes: 60)) == "Every hour")
        #expect(AutomationModel.describe(.time(time: "09:00", days: [1, 2, 3, 4, 5])) == "Weekdays at 09:00")
        #expect(AutomationModel.describe(.time(time: "09:00", days: [0, 6])) == "Weekends at 09:00")
        #expect(AutomationModel.describe(.app(event: "quit", app: "")) == "When any app quits")
        #expect(AutomationModel.describe(.power(event: "below", percent: 20)) == "When battery drops to 20%")
        #expect(AutomationModel.describe(.command(itemId: "x", title: "Sleep", argument: "now"), workflows: []) == "Run “Sleep” with “now”")
    }

    @Test func matchesEvents() {
        let m = AutomationModel.match
        #expect(m(.app(event: "launched", app: "google chrome"), .app(event: "launched", name: "Google_Chrome", bundleId: nil), "a", "/h") == "Google_Chrome")
        #expect(m(.app(event: "launched", app: "com.apple.Safari"), .app(event: "launched", name: "Safari", bundleId: "com.apple.safari"), "a", "/h") == "Safari")
        #expect(m(.app(event: "quit", app: ""), .app(event: "launched", name: "X", bundleId: nil), "a", "/h") == nil)
        #expect(m(.wifi(event: "joined", network: "Home"), .wifi(from: nil, to: "home"), "a", "/h") == "home")
        #expect(m(.wifi(event: "left", network: "Home"), .wifi(from: "Home", to: "Cafe"), "a", "/h") == "Home")
        #expect(m(.wifi(event: "changed", network: ""), .wifi(from: "A", to: "A"), "a", "/h") == nil)
        // Battery thresholds fire on the crossing only.
        #expect(m(.power(event: "below", percent: 20), .power(source: "battery", percent: 20, prevSource: "battery", prevPercent: 21), "a", "/h") == "20")
        #expect(m(.power(event: "below", percent: 20), .power(source: "battery", percent: 19, prevSource: "battery", prevPercent: 20), "a", "/h") == nil)
        #expect(m(.power(event: "ac", percent: 0), .power(source: "ac", percent: 50, prevSource: "battery", prevPercent: 50), "a", "/h") == "50")
        #expect(m(.power(event: "above", percent: 80), .power(source: "ac", percent: 80, prevSource: "ac", prevPercent: 79), "a", "/h") == "80")
        #expect(m(.display(event: "any"), .display(event: "disconnected", name: "LG"), "a", "/h") == "LG")
        #expect(m(.folder(path: "~/Downloads/", event: "added"), .folder(path: "/h/Downloads", event: "added", file: "/h/Downloads/f.pdf"), "a", "/h") == "/h/Downloads/f.pdf")
        #expect(m(.folder(path: "~/Downloads", event: "added"), .folder(path: "/h/Downloads", event: "changed", file: "/h/Downloads"), "a", "/h") == nil)
        #expect(m(.hotkey(accelerator: "X"), .hotkey(automationId: "a"), "a", "/h") == "")
        #expect(m(.hotkey(accelerator: "X"), .hotkey(automationId: "b"), "a", "/h") == nil)
        #expect(m(.launch, .launch, "a", "/h") == "")
        #expect(m(.time(time: "09:00", days: []), .launch, "a", "/h") == nil)
    }

    @Test func risk() {
        let safe = wf("s", [act("n", "notify")])
        let risky = wf("r", [act("c", "condition", then: [act("x", "runShell")])])
        let nested = wf("n", [act("w", "runWorkflow", ["workflowId": "r"])])
        let disabled = wf("d", [act("x", "runShell", disabled: true)])
        let all = [safe, risky, nested, disabled]
        #expect(!AutomationModel.isRisky(.workflow(workflowId: "s"), workflows: all))
        #expect(AutomationModel.isRisky(.workflow(workflowId: "r"), workflows: all))
        #expect(AutomationModel.isRisky(.workflow(workflowId: "n"), workflows: all))
        #expect(!AutomationModel.isRisky(.workflow(workflowId: "d"), workflows: all))
        #expect(AutomationModel.isRisky(.workflow(workflowId: "missing"), workflows: all))
        #expect(!AutomationModel.isRisky(.command(itemId: "app:/Applications/Safari.app", title: "", argument: ""), workflows: []))
        #expect(AutomationModel.isRisky(.command(itemId: "system:sleep", title: "", argument: ""), workflows: []))
    }

    @Test func schedule() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        // Thu 2026-10-22 10:00 local
        let base = cal.date(from: DateComponents(year: 2026, month: 10, day: 22, hour: 10))!.timeIntervalSince1970 * 1000
        let today = AutomationModel.nextTimeOfDay("11:30", days: [], after: base, calendar: cal)
        #expect(today - base == 90 * 60_000)
        let tomorrow = AutomationModel.nextTimeOfDay("09:00", days: [], after: base, calendar: cal)
        #expect(tomorrow - base == 23 * 3_600_000)
        let monday = AutomationModel.nextTimeOfDay("09:00", days: [1], after: base, calendar: cal) // next Mon 26th
        #expect(cal.component(.weekday, from: Date(timeIntervalSince1970: monday / 1000)) == 2)
        // DST ends Sun 2026-11-01 in New York: 09:00 is still 09:00 local.
        let sun = AutomationModel.nextTimeOfDay("09:00", days: [0], after: base, calendar: cal)
        #expect(cal.dateComponents([.day, .hour], from: Date(timeIntervalSince1970: sun / 1000)) == DateComponents(day: 25, hour: 9))
        #expect(AutomationModel.nextFire(.interval(minutes: 5), since: 1000) == 301_000)
        #expect(AutomationModel.nextFire(.launch, since: 0) == nil)
        #expect(AutomationModel.due(100, now: 99, graceMs: 10) == .wait)
        #expect(AutomationModel.due(100, now: 105, graceMs: 10) == .fire)
        #expect(AutomationModel.due(100, now: 200, graceMs: 10) == .missed)
    }
}

@Suite("automation engine") @MainActor
struct AutomationEngineTests {
    final class Harness {
        var now: Double = 1_000_000
        var runs: [(String, String)] = []
        var confirmAnswer = true
        var confirms = 0
        var persisted = 0
        var outcome = AutomationRunOutcome(ok: true, message: "done")
        var runHook: (() async -> Void)?
    }

    func make(_ h: Harness, _ list: [JSONValue]) -> AutomationEngine {
        var deps = AutomationEngineDeps(now: { h.now }, run: { a, input in
            h.runs.append((a.id, input))
            await h.runHook?()
            return h.outcome
        }, confirm: { _, _, _ in h.confirms += 1; return h.confirmAnswer }, persist: { _ in h.persisted += 1 })
        deps.home = "/h"
        let e = AutomationEngine(deps: deps)
        for j in list { _ = e.upsert(j) }
        return e
    }

    let interval: JSONValue = ["id": "i", "name": "Every 5", "trigger": ["kind": "interval", "minutes": 5], "target": ["kind": "workflow", "workflowId": "w"]]
    let app: JSONValue = ["id": "app", "name": "Safari", "trigger": ["kind": "app", "event": "launched", "app": "Safari"], "target": ["kind": "command", "itemId": "x", "title": "X", "argument": "{{input}}"]]

    @Test func intervalTicksAndMissedSlots() async {
        let h = Harness()
        let e = make(h, [interval])
        #expect(await e.tick().isEmpty)
        #expect(e.nextRun("i") == h.now + 300_000)
        h.now += 300_000
        let r = await e.tick()
        #expect(r.count == 1 && h.runs.count == 1)
        guard case let .record(rec)? = r.first else { Issue.record("no record"); return }
        #expect(rec.status == "ok" && rec.trigger == "Every 5 minutes")
        // Slept through two slots: skipped, not replayed, then rescheduled from now.
        h.now += 900_000
        #expect(await e.tick().isEmpty)
        #expect(e.nextRun("i") == h.now + 300_000)
        #expect(e.get("i")?.log.count == 1)
    }

    @Test func eventsRateLimitAndInput() async {
        let h = Harness()
        let e = make(h, [app])
        let ev = AutomationEvent.app(event: "launched", name: "Safari", bundleId: "com.apple.Safari")
        #expect(await e.handle(ev).count == 1)
        #expect(h.runs.first?.1 == "Safari")
        h.now += 5_000
        #expect(await e.handle(ev) == [.rateLimited])
        h.now += 6_000
        #expect(await e.handle(ev).count == 1 && h.runs.count == 2)
        _ = e.setEnabled("app", false)
        h.now += 20_000
        #expect(await e.handle(ev).isEmpty)
        // Run Now ignores enabled and the rate limit.
        if case let .record(r) = await e.runNow("app") { #expect(r.manual == true && r.trigger == "Run Now") } else { Issue.record("runNow") }
    }

    @Test func askBeforeRunning() async {
        let h = Harness()
        var a = app.objectValue!
        a["askBeforeRunning"] = true
        let e = make(h, [.object(a)])
        h.confirmAnswer = false
        let r = await e.handle(.app(event: "launched", name: "Safari", bundleId: nil))
        guard case let .record(rec)? = r.first else { Issue.record("no record"); return }
        #expect(rec.status == "skipped" && h.runs.isEmpty && h.confirms == 1)
        _ = await e.runNow("app") // manual never asks
        #expect(h.confirms == 1 && h.runs.count == 1)
    }

    @Test func busyAndLogLimitAndUpsertKeepsLog() async {
        let h = Harness()
        let e = make(h, [interval])
        for _ in 0..<60 { _ = await e.runNow("i") }
        #expect(e.get("i")?.log.count == AutomationModel.logLimit)
        var edited = interval.objectValue!
        edited["name"] = "Renamed"
        _ = e.upsert(.object(edited))
        #expect(e.get("i")?.name == "Renamed" && e.get("i")?.log.count == 50)
        // Overlap guard
        h.runHook = { try? await Task.sleep(for: .milliseconds(80)) }
        async let first = e.runNow("i")
        try? await Task.sleep(for: .milliseconds(10))
        let second = await e.runNow("i")
        #expect(second == .busy)
        _ = await first
        #expect(e.remove("i") && e.get("i") == nil)
        let gone = await e.runNow("i")
        #expect(gone == .missing)
    }
}

@Suite("automations feature") @MainActor
struct AutomationsFeatureTests {
    func setup(_ workflows: [Workflow] = []) async throws -> (AutomationsFeature, FakeFeatureContext, WorkflowEngineFeature, FakeWorkflowEnv) {
        let ctx = try FakeFeatureContext(featureId: "automations", workflows: workflows)
        let env = FakeWorkflowEnv()
        env.workflows = workflows
        let wfs = WorkflowEngineFeature(registry: WorkflowActionRegistry(), environment: env)
        let wctx = try FakeFeatureContext(featureId: "workflows", root: ctx.root, workflows: workflows)
        await wfs.start(context: wctx)
        let f = AutomationsFeature()
        f.autoTick = false
        ctx.features = ["workflows": wfs]
        ctx.retained.append(wctx)
        await f.start(context: ctx)
        return (f, ctx, wfs, env)
    }

    @Test func saveRunPersistAndHotkey() async throws {
        let (f, ctx, _, env) = try await setup([wf("w1", "Note", [act("n", "notify", ["title": "got {{input}}"])])])
        var r = try await f.invoke(method: "save", args: ["automation": ["name": "Hot", "trigger": ["kind": "hotkey", "accelerator": "Control+Alt+M"], "target": ["kind": "workflow", "workflowId": "w1"]]])
        #expect(r["ok"]?.boolValue == true)
        let id = r["automation"]?["id"]?.stringValue ?? ""
        #expect(r["automation"]?["askBeforeRunning"]?.boolValue == false) // notify-only workflow is not risky
        #expect(ctx.hotkeys["automation:\(id)"] == "Control+Alt+M")
        ctx.hotkeyHandlers["automation:\(id)"]?()
        // Integration: poll instead of a fixed 50 ms sleep (the full parallel suite is slow enough to lose that
        // race, after which the second event saw "busy" instead of "rate-limited").
        await eventually {
            let running = (try? await f.invoke(method: "state", args: .null))?["automations"]?.arrayValue?.contains { $0["running"]?.boolValue == true } ?? false
            return env.effects == ["notify:got |"] && !running
        }
        #expect(env.effects == ["notify:got |"])
        r = try await f.invoke(method: "debugEvent", args: ["event": ["type": "hotkey", "automationId": .string(id)]])
        #expect(r["results"]?.arrayValue?.first?.stringValue == "rate-limited")
        f.flush()
        let file = ctx.dataDirectory().appendingPathComponent("automations.json")
        let disk = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
        #expect(disk["version"]?.intValue == 1)
        #expect(disk["automations"]?.arrayValue?.first?["log"]?.arrayValue?.first?["status"]?.stringValue == "ok")
        // Reload from disk: same automation, log kept.
        #expect(AutomationsFeature.load(file).first?.log.count == 1)
        // Disabling unregisters the hotkey.
        _ = try await f.invoke(method: "setEnabled", args: ["id": .string(id), "enabled": false])
        #expect(ctx.hotkeys["automation:\(id)"] == nil)
        await f.stop()
    }

    @Test func riskyTargetsAskAndPendingAnswer() async throws {
        let (f, ctx, _, env) = try await setup([wf("w2", "Shell", [act("s", "runShell", ["command": "echo {{input}}"])])])
        let r = try await f.invoke(method: "save", args: ["name": "Folder", "trigger": ["kind": "app", "event": "launched", "app": "Mail"], "target": ["kind": "workflow", "workflowId": "w2"]])
        #expect(r["automation"]?["askBeforeRunning"]?.boolValue == true)
        let fire = Task { @MainActor in try await f.invoke(method: "debugEvent", args: ["event": ["type": "app", "event": "launched", "name": "Mail"]]) }
        // Integration: poll (a fixed 30 ms sleep lost the race under load and the unanswered ask then waited out
        // its 300 s timeout).
        await eventually { !f.pending.isEmpty }
        let state = try await f.invoke(method: "state", args: .null)
        let pid = state["pending"]?.arrayValue?.first?["id"]?.stringValue ?? ""
        #expect(!pid.isEmpty)
        if pid.isEmpty { fire.cancel(); return }
        #expect(f.items().contains { $0.id == "automations:p:\(pid)" })
        #expect(ctx.effectLog.all.contains { $0.kind == "notify" && $0.detail["title"]?.stringValue == "Run “Folder”?" })
        _ = try await f.invoke(method: "answer", args: ["pendingId": .string(pid), "run": true])
        _ = try await fire.value
        #expect(env.effects == ["shell:/bin/zsh:echo Mail"])
        #expect(f.pending.isEmpty)
    }

    @Test func commandTargetsAndFolderProblems() async throws {
        let (f, ctx, _, _) = try await setup()
        ctx.items = [SearchItem(id: "quicklink:g", kind: .quicklink, title: "Google", feature: "quicklinks")]
        _ = try await f.invoke(method: "save", args: ["id": "c", "name": "C", "trigger": ["kind": "launch"], "target": ["kind": "command", "itemId": "quicklink:g", "title": "Google", "argument": "q={{input}}"]])
        _ = try await f.invoke(method: "save", args: ["id": "d", "name": "D", "trigger": ["kind": "folder", "path": "/nonexistent-n6-folder"], "target": ["kind": "command", "itemId": "x", "title": "X"]])
        let r = try await f.invoke(method: "runNow", args: ["id": "c"])
        #expect(r["ok"]?.boolValue == true)
        #expect(ctx.executed.first?.0 == "quicklink:g" && ctx.executed.first?.1 == "q=")
        let s = try await f.invoke(method: "state", args: .null)
        let d = s["automations"]?.arrayValue?.first { $0["id"]?.stringValue == "d" }
        #expect(d?["problem"]?.stringValue?.contains("Can't watch") == true)
        let missing = try await f.invoke(method: "runNow", args: ["id": "d"])
        #expect(missing["error"]?.stringValue?.contains("no longer available") == true)
        // Launch event fires launch automations (debugEvent).
        let l = try await f.invoke(method: "debugEvent", args: ["event": ["type": "launch"]])
        #expect(l["results"]?.arrayValue?.count == 1)
        // Catalogue: create, list, one row per automation — Electron ids.
        #expect(f.items().map(\.id).prefix(4) == ["automations:create", "automations:list", "automations:a:c", "automations:a:d"])
    }

    @Test func folderWatcherDiff() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("n6-folder-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var events: [AutomationEvent] = []
        let w = FolderWatcher(dir: dir.path) { events.append($0) }
        #expect(w.start())
        try Data("x".utf8).write(to: dir.appendingPathComponent("report.pdf"))
        try Data("x".utf8).write(to: dir.appendingPathComponent(".hidden"))
        try Data("x".utf8).write(to: dir.appendingPathComponent("big.crdownload"))
        w.scan()
        #expect(events == [.folder(path: dir.path, event: "added", file: dir.appendingPathComponent("report.pdf").path)])
        w.scan()
        #expect(events.last == .folder(path: dir.path, event: "changed", file: dir.path))
        w.stop()
    }
}

@Suite("workflows feature") @MainActor
struct WorkflowsFeatureTests {
    @Test func launcherRunAndHistory() async throws {
        let w1 = wf("w1", "Greet", [act("a", "setVariable", ["name": "g", "value": "Hi {{input}}"]), act("b", "setClipboard", ["text": "{{g}}"])], acceptsInput: true)
        let w2 = wf("w2", "Opener", [act("a", "openApp", ["app": "Notes"])])
        let w3 = wf("w3", "Broken", [act("a", "runShell", ["command": "x"])])
        let ctx = try FakeFeatureContext(featureId: "workflows", workflows: [w1, w2, w3])
        let env = FakeWorkflowEnv()
        env.workflows = [w1, w2, w3]
        env.shellResult = ShellResult(status: 1, stdout: "", stderr: "nope")
        let f = WorkflowEngineFeature(registry: WorkflowActionRegistry(), environment: env)
        await f.start(context: ctx)
        let items = f.items()
        #expect(items.map(\.id) == ["workflow:w1", "workflow:w2", "workflow:w3"])
        #expect(items[0].acceptsArgument == true && items[0].subtitle == "Workflow · 2 actions")
        var s = ScoredItem(item: items[0], score: 1)
        s.argument = "Ann"
        #expect(await f.run(action: "run", on: s, modifiers: []) == .hide(message: "✓ Greet"))
        #expect(env.clipboard == "Hi Ann")
        // Steps that switch apps step the launcher aside instead of re-showing it.
        #expect(await f.run(action: "run", on: ScoredItem(item: items[1], score: 1), modifiers: []) == .stay(message: nil))
        #expect(ctx.hidden == 1)
        #expect(await f.run(action: "run", on: ScoredItem(item: items[2], score: 1), modifiers: []) == .error("Run Shell Script failed: nope"))
        #expect(f.history.runs.count == 3 && f.history.last("w1")?.ok == true)
        let last = try await f.invoke(method: "lastRun", args: ["workflowId": "w3"])
        #expect(last["ok"]?.boolValue == false)
        // Duplicate gives fresh ids.
        _ = await f.run(action: "duplicate", on: ScoredItem(item: items[0], score: 1), modifiers: [])
        let copy = ctx.store.data.workflows.last
        #expect(copy?.name == "Greet Copy" && copy?.id != "w1" && copy?.actions.first?.id != "a")
        f.history.flush()
        let disk = try Data(contentsOf: ctx.dataDirectory().appendingPathComponent("runs.json"))
        #expect(String(decoding: disk, as: UTF8.self).contains("\"workflowId\""))
        #expect(!String(decoding: disk, as: UTF8.self).contains("Hi Ann\",\"input")) // variables are not persisted
    }

    @Test func promptsResolveThroughFeature() async throws {
        let ctx = try FakeFeatureContext(featureId: "workflows")
        let prompts = WorkflowPrompts()
        prompts.context = ctx
        let t = Task { @MainActor in await prompts.ask(prompt: "Name?", placeholder: "you") }
        try await Task.sleep(for: .milliseconds(20))
        #expect(ctx.pushed.first?.0.rawValue == "workflows.prompt")
        #expect(prompts.pending?.prompt == "Name?")
        #expect(prompts.answer("Bo"))
        #expect(await t.value == "Bo")
        let t2 = Task { @MainActor in await prompts.ask(prompt: "Again?", placeholder: nil) }
        try await Task.sleep(for: .milliseconds(20))
        prompts.viewGone(token: prompts.pending?.token ?? "")
        #expect(await t2.value == nil)
        prompts.showResult(text: "R", title: nil)
        #expect(ctx.pushed.last?.0.rawValue == "workflows.result" && prompts.lastResult?.text == "R")
    }

    @Test func editorModelKeyboard() async throws {
        let w = wf("w", "Edit", [act("a", "notify"), act("c", "condition", then: [], else: [])])
        let ctx = try FakeFeatureContext(featureId: "workflows", workflows: [w])
        let f = WorkflowEngineFeature(registry: WorkflowActionRegistry(), environment: FakeWorkflowEnv())
        await f.start(context: ctx)
        let m = WorkflowsEditorModel(feature: f)
        m.reload(select: "w")
        #expect(m.selection == [.index(0)])
        #expect(m.handleKey("j", "j", modifiers: []))
        #expect(m.selection == [.index(1)])
        // Library: search, ⏎ inserts after the selection.
        #expect(m.handleKey("a", "a", modifiers: []))
        #expect(m.libraryOpen)
        m.libraryQuery = "clipboard set"
        #expect(m.librarySpecs.first?.type == "setClipboard")
        #expect(m.handleKey("\r", .return, modifiers: []))
        #expect(m.actions.map(\.type) == ["notify", "condition", "setClipboard"])
        #expect(m.selection == [.index(2)])
        // Into the If's Then branch.
        m.openLibrary(container: [.index(1), .then], index: 0)
        m.add(WorkflowSpecs.builtin("wait")!)
        #expect(m.actions[1].then?.first?.type == "wait" && m.selection == [.index(1), .then, .index(0)])
        // ⌘D duplicates, ⌥⌘↑ moves, space disables, ⌫ deletes.
        m.select([.index(0)])
        #expect(m.handleKey("d", "d", modifiers: .command))
        #expect(m.actions.count == 4 && m.selection == [.index(1)])
        #expect(m.handleKey("", .downArrow, modifiers: [.command, .option]))
        #expect(m.selection == [.index(2)] && m.actions[2].type == "notify")
        #expect(m.handleKey(" ", " ", modifiers: []))
        #expect(m.actions[2].disabled == true)
        #expect(m.handleKey("", .delete, modifiers: []))
        #expect(m.actions.count == 3)
        m.setParam([.index(0)], "title", "Hello {{input}}")
        m.flush()
        #expect(ctx.store.data.workflows.first?.actions.first?.param("title") == "Hello {{input}}")
        // Drag-drop into a branch.
        m.drop(from: [.index(0)], container: [.index(1), .else], index: 0)
        #expect(m.actions[0].type == "condition" && m.actions[0].else?.first?.param("title") == "Hello {{input}}")
    }
}

/// Polls `condition` every 10 ms for up to `timeout` (timing-robust replacement for fixed sleeps).
@MainActor func eventually(timeout: Duration = .seconds(30), _ condition: () async -> Bool) async {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return }
        try? await Task.sleep(for: .milliseconds(10))
    }
}
