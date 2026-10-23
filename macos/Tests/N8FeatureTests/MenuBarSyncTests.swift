import Foundation
import GlideCore
@testable import GlideFeatures
import Testing

@MainActor final class FakeTray: TrayHandle {
    var titles: [String] = []
    var menus = 0
    var destroyed = false
    func setTitle(_ title: String) { titles.append(title) }
    func setIcon(_ icon: String?) {}
    func setTooltip(_ tooltip: String) {}
    func setMenu(_ menu: [MenuBarMenuItem]) { menus += 1 }
    func destroy() { destroyed = true }
}

@Suite("menu bar manager + specs")
@MainActor struct MenuBarTests {
    @Test func diffsAndThrottles() {
        var clock = 0.0
        var queued: [(Double, @MainActor () -> Void)] = []
        let m = MenuBarManager(throttleMs: 250, now: { clock }, schedule: { ms, fn in queued.append((ms, fn)) })
        var trays: [FakeTray] = []
        m.activate { _ in let t = FakeTray(); trays.append(t); return t }
        var clicked = 0
        m.register(MenuBarItemSpec(id: "x", title: "1", menu: [MenuBarMenuItem(title: "Go") { clicked += 1 }]))
        #expect(trays.count == 1 && trays[0].titles == ["1"] && trays[0].menus == 1)
        // Within the throttle window: one trailing render with the latest spec.
        m.register(MenuBarItemSpec(id: "x", title: "2", menu: [MenuBarMenuItem(title: "Go") { clicked += 10 }]))
        m.register(MenuBarItemSpec(id: "x", title: "3", menu: [MenuBarMenuItem(title: "Go") { clicked += 100 }]))
        #expect(queued.count == 1 && trays[0].titles == ["1"])
        clock = 300
        queued.removeFirst().1()
        #expect(trays[0].titles == ["1", "3"])
        #expect(trays[0].menus == 1) // closure-only change: menu not rebuilt
        #expect(m.click("x", path: [0]) && clicked == 100) // latest handler
        #expect(!m.click("x", path: [5]))
        m.remove("x")
        #expect(trays[0].destroyed && m.ids.isEmpty)
    }

    @Test func headlessStateOnly() {
        let m = MenuBarManager()
        m.activate(nil)
        m.register(MenuBarItemSpec(id: "a", title: "T", icon: "timer", menu: [.info("x"), .separatorItem, MenuBarMenuItem(title: "Sub", submenu: [MenuBarMenuItem(title: "y") {}])]))
        let item = m.state().arrayValue?.first ?? .null
        let menu = item["menu"]?.arrayValue ?? []
        #expect(item["rendered"] == false)
        #expect(menu[0]["enabled"] == false)
        #expect(menu[1]["separator"] == true)
        #expect(menu[2]["submenu"]?.arrayValue?.first?["clickable"] == true)
    }

    @Test func timerSpecs() {
        let now = 1_000_000.0
        let input = TimersInput(json: ["timers": [["id": "t1", "name": "", "durationMs": 300_000, "startedAt": .double(now - 1_000), "pausedAt": nil, "pausedMs": 0],
                                                  ["id": "t2", "name": "Tea", "durationMs": 60_000, "startedAt": .double(now), "pausedAt": .double(now), "pausedMs": 0]],
                                       "stopwatches": [], "presets": [["id": "p", "name": "Pomodoro", "durationMs": 1_500_000]], "settings": ["showInMenuBar": true]])
        #expect(ExtraSpecs.timersTitle(input, now: now) == "⏱ 4:59 +1")
        let spec = ExtraSpecs.timers(input, now: now, .none)
        #expect(spec?.title == "⏱ 4:59 +1")
        #expect(spec?.menu.first?.title == "5 min Timer")
        #expect(spec?.menu[1].subtitle == "Paused")
        #expect(ExtraSpecs.timers(TimersInput(json: ["timers": []]), now: now, .none) == nil)
        #expect(MenuText.clock(3_723_000) == "1:02:03")
        #expect(MenuText.duration(90_000) == "1 min 30 s")
    }

    @Test func meetingSpecs() {
        let now = Date().timeIntervalSince1970 * 1000
        #expect(ExtraSpecs.until(now + 5 * 60_000, now: now) == "in 5m")
        #expect(ExtraSpecs.until(now + 80 * 60_000, now: now) == "in 1h 20m")
        #expect(ExtraSpecs.until(now - 1, now: now) == "now")
        let ev = ExtraSpecs.Event(title: "Standup with the whole team", start: now + 10 * 60_000, end: now + 40 * 60_000, meetingURL: "https://zoom.us/j/1", provider: "Zoom")
        let spec = ExtraSpecs.meeting(ExtraSpecs.Schedule(status: "ok", events: [ev]), now: now, .none)
        #expect(spec.title == "Standup with the… in 10m")
        #expect(spec.menu.first?.title?.hasPrefix("Join") == true)
        let denied = ExtraSpecs.meeting(ExtraSpecs.Schedule(status: "notDetermined", message: "Calendar access needed"), now: now, .none)
        #expect(denied.menu.contains { $0.title == "Grant Calendar Access…" })
        #expect(ExtraSpecs.meeting(nil, now: now, .none).menu.first?.title == "Loading calendar…")
    }

    @Test func otherSpecs() {
        let s = SystemSample(cpu: 0.423, cores: 8, load: [1, 2, 3], memory: .init(totalBytes: 16e9, usedBytes: 8e9))
        #expect(ExtraSpecs.sysmon(s, open: {}).title == "CPU 42% · MEM 50%")
        let clip = ExtraSpecs.clipboard([["id": "c1", "type": "link", "title": "https://x"], ["id": "c2", "pinned": true, "title": ""]], paste: { _ in }, open: {})
        #expect(clip.menu[1].icon == "link" && clip.menu[1].shortcut == "CommandOrControl+1" && clip.menu[2].title == "(empty)" && clip.menu[2].icon == "pin")
        let idle = ExtraSpecs.agent(nil, ask: { _ in }, cancel: { _ in })
        #expect(idle.title.isEmpty && idle.menu.count == 2)
        let busy = ExtraSpecs.agent(["runId": "r", "status": "running", "prompt": "do it"], ask: { _ in }, cancel: { _ in })
        #expect(busy.title == "…" && busy.menu[2].title == "Cancel Run")
        let a = SystemSample.cpuTicks()
        #expect(!a.isEmpty)
        #expect(SystemSample.cpuUsage(a, a) == 0)
        #expect((SystemSample.memory()?.totalBytes ?? 0) > 0)
    }

    @Test func featureTogglesAndHeadlessState() async throws {
        let ctx = try N8TestContext(featureId: "menubar")
        let f = MenuBarFeature()
        await f.start(context: ctx)
        _ = try await f.invoke(method: "inject", args: ["source": "timers.state", "data": ["timers": [["id": "t1", "name": "Focus", "durationMs": 60_000, "startedAt": .double(Date().timeIntervalSince1970 * 1000), "pausedMs": 0]]]])
        let st = try await f.invoke(method: "tick", args: .null)
        let items = st["items"]?.arrayValue ?? []
        #expect(items.count == 1 && items[0]["id"] == "timers" && items[0]["rendered"] == false)
        #expect(items[0]["title"]?.stringValue?.hasPrefix("⏱ ") == true)
        f.setEnabled(["sysmon": true, "timers": false])
        let st2 = try await f.invoke(method: "tick", args: .null)
        #expect(st2["items"]?.arrayValue?.map { $0["id"]?.stringValue } == ["sysmon"])
        #expect(ctx.store.settings.features["menubar"]?["sysmon"] == true)
        #expect(f.items().contains { $0.title == "Hide System Monitor in Menu Bar" })
        await f.stop()
    }
}

// MARK: - sync

private func wf(_ id: String, _ name: String) -> Workflow { Workflow(id: id, name: name, icon: .emoji("⚡"), actions: [], createdAt: 1, updatedAt: 1) }

private func data(vim: Bool = true, features: [String: [String: JSONValue]]? = nil) -> UserData {
    var d = UserData()
    d.settings.vimMode = vim
    d.settings.features = features ?? ["ai": ["model": "x", "apiKey": "sk-secret"], "sync": ["folder": "/Users/me/iCloud"], "appearance": ["darkTheme": "nord"]]
    d.workflows = [wf("w1", "One"), wf("w2", "Two")]
    d.quicklinks = [Quicklink(id: "q1", name: "Docs", url: "https://x/{query}")]
    d.snippets = [Snippet(id: "s1", name: "Sig", text: "Best")]
    d.favorites = ["app:safari"]
    d.aliases = ["app:safari": "sf"]
    d.hotkeys = ["wf:w1": "Alt+1"]
    return d
}

@Suite("sync merge (port of merge.test.ts)")
struct SyncMergeTests {
    @Test func roundTrip() {
        let d = data()
        #expect(SyncMerge.unflatten(d, SyncMerge.flatten(d)) == d)
    }

    @Test func secretsAndLocalOnly() {
        let flat = SyncMerge.flatten(data())
        #expect(flat["feature.ai"] == ["model": "x"])
        #expect(!SyncMerge.stableStringify(.object(flat)).contains("sk-secret"))
        #expect(flat["feature.sync"] == nil && flat["settings.launchAtLogin"] == nil && flat["settings.vimMode"] == true)
    }

    @Test func remoteKeepsLocalSecrets() {
        let remote = SyncMerge.flatten(data(vim: false, features: ["ai": ["model": "y"], "appearance": [:]]))
        let out = SyncMerge.unflatten(data(), remote)
        #expect(out.settings.vimMode == false)
        #expect(out.settings.features["ai"] == ["model": "y", "apiKey": "sk-secret"])
        #expect(out.settings.features["sync"] == ["folder": "/Users/me/iCloud"])
    }

    @Test func collections() {
        let d = data()
        var values = SyncMerge.flatten(d)
        values["workflow.w1"] = nil
        values["workflow.w0"] = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(wf("w0", "Zero")))
        values["favorite.app:notes"] = true
        let out = SyncMerge.unflatten(d, values)
        #expect(out.workflows.map(\.id) == ["w2", "w0"])
        #expect(out.favorites == ["app:safari", "app:notes"])
    }

    @Test func wrongTypesIgnored() {
        let out = SyncMerge.unflatten(data(), ["settings.sectionLimit": "lots", "workflow.bad": ["id": "bad"]])
        #expect(out.settings.sectionLimit == Settings.defaults.sectionLimit && out.workflows.isEmpty)
    }

    @Test func trackLocal() {
        let s1 = SyncMerge.trackLocal([:], ["a": 1, "b": ["x": 1, "y": 2]], now: 100, machine: "mac1")
        #expect(s1["a"] == SyncEntry(v: 1, t: 100, m: "mac1"))
        let s2 = SyncMerge.trackLocal(s1, ["a": 2, "b": ["y": 2, "x": 1]], now: 200, machine: "mac1")
        #expect(s2["a"]?.t == 200 && s2["b"]?.t == 100)
        let s3 = SyncMerge.trackLocal(s2, ["b": ["x": 1, "y": 2]], now: 300, machine: "mac1")
        #expect(s3["a"] == SyncEntry(v: .null, t: 300, m: "mac1", d: true))
        let s4 = SyncMerge.trackLocal(s3, ["b": ["x": 1, "y": 2]], now: 400, machine: "mac1")
        #expect(s4["a"]?.t == 300)
        let s5 = SyncMerge.trackLocal(s4, ["b": ["x": 1, "y": 2]], now: 300 + 91 * 24 * 3600 * 1000, machine: "mac1")
        #expect(s5["a"] == nil)
        let re = SyncMerge.trackLocal(["a": SyncEntry(v: .null, t: 50, m: "x", d: true)], ["a": 1], now: 60, machine: "mac1")
        #expect(re["a"] == SyncEntry(v: 1, t: 60, m: "mac1"))
    }

    static let A: SyncSnapshot = ["k1": .init(v: "a", t: 10, m: "alpha"), "k2": .init(v: "a", t: 30, m: "alpha"), "k3": .init(v: "a", t: 5, m: "alpha")]
    static let B: SyncSnapshot = ["k1": .init(v: "b", t: 20, m: "beta"), "k2": .init(v: .null, t: 25, m: "beta", d: true), "k4": .init(v: "b", t: 1, m: "beta")]
    static let C: SyncSnapshot = ["k3": .init(v: .null, t: 7, m: "gamma", d: true), "k1": .init(v: "c", t: 20, m: "gamma")]

    @Test func mergeNewestWins() {
        let m = SyncMerge.merge([Self.A, Self.B, Self.C])
        #expect(m["k1"] == SyncEntry(v: "c", t: 20, m: "gamma"))
        #expect(m["k2"]?.v == "a" && m["k3"]?.d == true)
        #expect(SyncMerge.values(m) == ["k1": "c", "k2": "a", "k4": "b"])
    }

    @Test func mergeDeterministicAndIdempotent() {
        let perms = [[Self.A, Self.B, Self.C], [Self.C, Self.B, Self.A], [Self.B, Self.A, Self.C], [Self.B, Self.C, Self.A]]
        let results = Set(perms.map { SyncMerge.stableStringify(.object(SyncMerge.merge($0).mapValues(\.json))) })
        #expect(results.count == 1)
        let m = SyncMerge.merge([Self.A, Self.B, Self.C])
        #expect(SyncMerge.merge([m, Self.A, Self.B, Self.C]) == m)
        #expect(SyncEntry(json: ["v": 1, "t": .double(.nan), "m": "x"]) == nil)
    }

    @Test func conflicts() {
        let local: SyncSnapshot = ["a": .init(v: 1, t: 150, m: "me"), "b": .init(v: 1, t: 50, m: "me"), "c": .init(v: ["name": "Same"], t: 150, m: "me")]
        let other: SyncSnapshot = ["a": .init(v: 2, t: 160, m: "you"), "b": .init(v: 2, t: 170, m: "you"), "c": .init(v: ["name": "Same"], t: 160, m: "you")]
        let merged = SyncMerge.merge([local, other])
        let c = SyncMerge.conflicts(local: local, others: [("you", other)], since: 100, merged: merged, now: 999)
        #expect(c.count == 1 && c[0].key == "a" && c[0].winner.machine == "you" && c[0].winner.t == 160 && c[0].loser.machine == "me")
    }

    @Test func previewAndFiles() throws {
        let cur = data()
        var target = SyncMerge.flatten(cur)
        target["quicklink.q1"] = nil
        target["snippet.s2"] = ["id": "s2", "name": "New", "text": "x"]
        target["workflow.w1"] = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(wf("w1", "One renamed")))
        let p = SyncMerge.preview(cur, target)
        #expect(p.added.map(\.label) == ["Snippet “New”"])
        #expect(p.removed.map(\.label) == ["Quicklink “Docs”"])
        #expect(p.changed.map(\.label) == ["Workflow “One renamed”"])
        #expect(SyncMerge.parseFile(["app": "other"]) == nil)
        #expect(SyncMerge.parseFile(["app": "glide", "version": 99, "machine": "m", "entries": [:]]) == nil)
        let f = SyncMerge.parseFile(["app": "glide", "version": 1, "machine": "m", "exportedAt": 5,
                                     "entries": ["a.b": ["v": 1, "t": 1, "m": "m"], "junk": ["v": 1, "t": 1, "m": "m"], "c.d": ["t": "x"]]])
        #expect(f?.entries == ["a.b": SyncEntry(v: 1, t: 1, m: "m")])
        #expect(SyncMerge.machineSlug("Tobi’s MacBook Pro.local") == "Tobi-s MacBook Pro")
        #expect(SyncMerge.machineSlug("///") == "Mac" && SyncMerge.machineSlug("") == "Mac")
        #expect(SyncMerge.stableStringify(["b": 1, "a": [true, .null, 1.5, "q\"\n"]]) == #"{"a":[true,null,1.5,"q\"\n"],"b":1}"#)
    }

    /// Reads a sync file the way the Electron app writes it (JSON.stringify of SyncFile).
    @Test func electronFileCompat() throws {
        let raw = #"{"app":"glide","version":1,"machine":"Work-Mac","exportedAt":1700000000000,"entries":{"settings.vimMode":{"v":false,"t":1700000000000,"m":"Work-Mac"},"quicklink.q9":{"v":{"id":"q9","name":"Nine","url":"https://9"},"t":1700000000001,"m":"Work-Mac"},"snippet.s1":{"v":null,"t":1700000000002,"m":"Work-Mac","d":true}}}"#
        let f = try #require(SyncMerge.parseFile(try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))))
        let out = SyncMerge.unflatten(data(), SyncMerge.values(SyncMerge.merge([SyncMerge.trackLocal([:], SyncMerge.flatten(data()), now: 1, machine: "me"), f.entries])))
        #expect(out.settings.vimMode == false && out.quicklinks.map(\.id) == ["q1", "q9"] && out.snippets.isEmpty)
    }
}

@Suite("sync feature (two machines through a folder)", .serialized)
@MainActor struct SyncFeatureTests {
    @Test func twoMachinesConverge() async throws {
        let folder = n8TempDir("syncfolder")
        defer { try? FileManager.default.removeItem(at: folder) }
        let c1 = try N8TestContext(featureId: "sync"), c2 = try N8TestContext(featureId: "sync")
        let f1 = SyncFeature(), f2 = SyncFeature()
        await f1.start(context: c1)
        await f2.start(context: c2)
        f1.setConfig(["folder": .string(folder.path), "machine": "alpha"])
        f2.setConfig(["folder": .string(folder.path), "machine": "beta"])
        #expect(await f1.syncNow().ok)
        c2.store.setSettings { $0.vimMode = false }
        c2.store.saveQuicklink(Quicklink(id: "ql-new", name: "New", url: "https://n"))
        try await Task.sleep(for: .milliseconds(10))
        f2.track(now: Date().timeIntervalSince1970 * 1000 + 1000)
        let r2 = await f2.syncNow()
        #expect(r2.ok)
        let r1 = await f1.syncNow()
        #expect(r1.ok && (r1.preview?.count ?? 0) >= 2)
        #expect(c1.store.settings.vimMode == false && c1.store.data.quicklinks.contains { $0.id == "ql-new" })
        #expect(c1.store.settings.features["sync"]?["machine"] == "alpha") // local bag untouched
        #expect(f1.listBackups().contains { $0.reason == "Before sync" })
        let files = try FileManager.default.contentsOfDirectory(atPath: folder.appendingPathComponent("Glide Sync").path).sorted()
        #expect(files == ["alpha.json", "beta.json"])
        // Restore the backup brings the old values back.
        let b = try #require(f1.listBackups().first)
        _ = try f1.restore(try f1.backupValues(b.id), reason: "Before restore")
        #expect(c1.store.settings.vimMode == true)
        await f1.stop()
        await f2.stop()
    }

    @Test func noFolder() async throws {
        let c = try N8TestContext(featureId: "sync")
        let f = SyncFeature()
        await f.start(context: c)
        #expect(await f.syncNow().message == "Choose a sync folder first")
        #expect(throws: (any Error).self) { try f.backupValues("../etc") }
        for _ in 0..<12 { _ = try f.makeBackup("Manual") }
        #expect(f.listBackups().count == 10)
        await f.stop()
    }
}
