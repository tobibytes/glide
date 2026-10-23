import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem
import Testing

private func items(_ s: JSONValue) -> [JSONValue] { s["items"]?.arrayValue ?? [] }
private func ids(_ s: JSONValue) -> [String] { items(s).compactMap { $0["id"]?.stringValue } }
private func item(_ s: JSONValue, _ id: String) -> JSONValue? { items(s).first { $0["id"]?.stringValue == id } }

@Suite("shared status items: composer + hub")
@MainActor struct StatusItemComposerTests {
    @Test func titlesJoinInOrderSkippingEmpty() {
        #expect(StatusItemComposer.joinTitles(["", "⏱ 3:00 +1", " ", "◷ 24:59"]) == "⏱ 3:00 +1  ◷ 24:59")
        #expect(StatusItemComposer.joinTitles([]) == "")
    }

    @Test func combinedVersusSeparate() {
        var clicks: [String] = []
        let glide = StatusItemSpec(icon: "sparkle.magnifyingglass", menu: [StatusMenuItem("Open Glide") { clicks.append("open") }, .separator, StatusMenuItem("Quit Glide")])
        let timers = StatusItemComposer.Entry(id: "timers", spec: StatusItemSpec(title: "⏱ 3:00", tooltip: "Glide Timers", menu: [StatusMenuItem("Tea") { clicks.append("tea") }], section: "Timers"),
                                              placement: .combinable)
        let focus = StatusItemComposer.Entry(id: "focus", spec: StatusItemSpec(title: "◷ 24:59", menu: [StatusMenuItem("Pause") { clicks.append("pause") }], section: "Focus"),
                                             placement: .combinable)
        let ext = StatusItemComposer.Entry(id: "ext:x/y", spec: StatusItemSpec(title: "", icon: "🧪", menu: []), placement: .separate)

        let on = StatusItemComposer.compose(glide: glide, entries: [timers, focus, ext], combine: true)
        #expect(on.map(\.id) == ["glide", "ext:x/y"])
        let g = on[0]
        #expect(g.title == "⏱ 3:00  ◷ 24:59")
        #expect(g.sources == ["timers", "focus"])
        #expect(g.icon == "sparkle.magnifyingglass")
        #expect(g.tooltip == "Glide · Glide Timers")
        // Sections: header + rows + separator per contributor, then Glide's own menu.
        #expect(StatusMenuJSON.strip(g.menu) == [["header": "Timers"], ["title": "Tea", "clickable": true], ["separator": true],
                                                  ["header": "Focus"], ["title": "Pause", "clickable": true], ["separator": true],
                                                  ["title": "Open Glide", "clickable": true], ["separator": true], ["title": "Quit Glide"]])

        let off = StatusItemComposer.compose(glide: glide, entries: [timers, focus, ext], combine: false)
        #expect(off.map(\.id) == ["glide", "timers", "focus", "ext:x/y"])
        #expect(off[0].title == "" && off[0].sources.isEmpty)
        #expect(off[1].title == "⏱ 3:00" && StatusMenuJSON.strip(off[1].menu) == [["title": "Tea", "clickable": true]])
        _ = clicks
    }

    @Test func noGlideItemStillHostsMergedEntriesAndLoadingRow() {
        let e = StatusItemComposer.Entry(id: "focus", spec: StatusItemSpec(title: "◷ 1:00", isLoading: true), placement: .combinable)
        let c = StatusItemComposer.compose(glide: nil, entries: [e], combine: true)
        #expect(c.map(\.id) == ["glide"])
        #expect(c[0].isLoading)
        #expect(StatusMenuJSON.strip(c[0].menu) == [["title": "Loading…", "enabled": false]])
        #expect(StatusItemComposer.compose(glide: nil, entries: [], combine: true).isEmpty)
    }

    @Test func hubRoutesClicksByPathAndMenuOpens() {
        let hub = StatusItemHub()
        var log: [String] = []
        hub.setGlideItem(StatusItemSpec(menu: [StatusMenuItem("Open") { log.append("open") }], onMenuOpen: { log.append("glide-open") }))
        hub.show("timers", StatusItemSpec(title: "⏱ 1:00", menu: [StatusMenuItem("Tea", submenu: [StatusMenuItem("Pause") { log.append("pause") }])], section: "Timers",
                                          onMenuOpen: { log.append("timers-open") }), placement: .combinable)
        // glide menu: [header Timers, Tea{Pause}, separator, Open]
        #expect(hub.click("glide", path: [1, 0]))
        #expect(hub.click("glide", path: [3]))
        #expect(!hub.click("glide", path: [0])) // header
        #expect(!hub.click("glide", path: [9]))
        hub.menuWillOpen("glide")
        #expect(log == ["pause", "open", "glide-open", "timers-open"])
        hub.combineWithGlideIcon = false
        #expect(ids(hub.state()) == ["glide", "timers"])
        #expect(hub.click("timers", path: [0, 0]))
        hub.remove("timers")
        #expect(ids(hub.state()) == ["glide"])
        #expect(hub.state()["menuOpens"]?["glide"] == 1)
    }

    @Test func headlessFakeRecordsChangesOnlyAndNeverRenders() {
        let log = SideEffectLog(echo: false)
        let fake = HeadlessStatusItems(log: log)
        fake.show("focus", StatusItemSpec(title: "◷ 1:00", section: "Focus"), placement: .combinable)
        fake.show("focus", StatusItemSpec(title: "◷ 1:00", section: "Focus"), placement: .combinable) // unchanged → not recorded again
        fake.show("focus", StatusItemSpec(title: "◷ 0:59", section: "Focus"), placement: .combinable)
        fake.remove("focus")
        let fx = log.all.filter { $0.kind == "status-item" }.map(\.detail)
        #expect(fx.count == 3)
        #expect(fx[0]["id"] == "glide" && fx[0]["title"] == "◷ 1:00" && fx[0]["sources"] == ["focus"])
        #expect(fx[1]["title"] == "◷ 0:59")
        #expect(fx[2] == ["id": "glide", "removed": true])
    }
}

@Suite("shared status items: Timers + Focus", .serialized)
@MainActor struct TimersFocusStatusItemTests {
    @Test func timersCountdownMergesIntoGlideIconAndSeparatesWhenOff() async throws {
        let ctx = N7TestContext("timers")
        defer { ctx.cleanup() }
        var clock = 1_000_000.0
        let f = TimersFeature()
        f.now = { clock }
        await f.start(context: ctx)
        let svc = ctx.services.statusItems
        #expect(ids(svc.state()).isEmpty) // nothing running → no item
        f.startTimer(180_000, "Tea")
        var st = svc.state()
        #expect(st["combineWithGlideIcon"] == true)
        #expect(ids(st) == ["glide"])
        #expect(item(st, "glide")?["title"] == "⏱ 3:00")
        #expect(item(st, "glide")?["sources"] == ["timers"])
        let menu = item(st, "glide")?["menu"]?.arrayValue ?? []
        #expect(menu.first == ["header": "Timers"])
        #expect(menu.dropFirst().first?["title"] == "Tea")
        // The countdown ticks in the title; the menu rows do not change.
        clock += 60_000
        f.tick()
        st = svc.state()
        #expect(item(st, "glide")?["title"] == "⏱ 2:00")
        // Pause from Glide's menu: Tea ▸ Pause.
        #expect(svc.click("glide", path: [1, 0]))
        #expect(f.data.timers.first?.pausedAt != nil)
        #expect(item(svc.state(), "glide")?["title"]?.stringValue?.hasSuffix("❚❚") == true)
        // Setting off → its own icon, same rows without the section header.
        svc.combineWithGlideIcon = false
        st = svc.state()
        #expect(ids(st) == ["timers"])
        #expect(item(st, "timers")?["menu"]?.arrayValue?.first?["title"] == "Tea")
        // "Show the next timer in the menu bar" off → removed.
        _ = try await f.invoke(method: "setSettings", args: ["showInMenuBar": false])
        #expect(ids(svc.state()).isEmpty)
        #expect(ctx.effects("status-item").contains { $0["id"] == "timers" && $0["removed"] == true })
    }

    @Test func claimedByMenuBarTimersExtraShowsNothingItself() async throws {
        let ctx = N7TestContext("timers")
        defer { ctx.cleanup(); StatusTitleRouting.claim = nil }
        StatusTitleRouting.claim = { feature, _ in feature == "timers" }
        let f = TimersFeature()
        await f.start(context: ctx)
        f.startTimer(60_000, "Egg")
        #expect(ids(ctx.services.statusItems.state()).isEmpty)
    }

    @Test func focusSessionInGlideMenuWithActions() async throws {
        let ctx = N7TestContext("focus")
        defer { ctx.cleanup() }
        var clock = 1_000_000.0
        let f = FocusFeature()
        f.now = { clock }
        await f.start(context: ctx)
        _ = await f.start(goal: "write", minutes: 25)
        let svc = ctx.services.statusItems
        var st = svc.state()
        #expect(item(st, "glide")?["title"] == "◷ 25:00")
        let menu = item(st, "glide")?["menu"]?.arrayValue ?? []
        #expect(menu.compactMap { $0["title"]?.stringValue } == ["Focus: write", "Pause", "Add 5 Minutes", "Stop Session", "Focus Statistics…"])
        // Pause (row 3: header, info, separator, Pause).
        #expect(svc.click("glide", path: [3]))
        #expect(f.session?.status == "paused")
        st = svc.state()
        #expect(item(st, "glide")?["title"] == "◷ 25:00 ❚❚")
        #expect(item(st, "glide")?["menu"]?.arrayValue?[3]["title"] == "Resume")
        // Statistics opens the stats view.
        #expect(svc.click("glide", path: [7]))
        #expect(ctx.pushes == ["focus.stats"])
        svc.combineWithGlideIcon = false
        #expect(ids(svc.state()) == ["focus"])
        clock += 1000
        _ = await f.stop(completed: false)
        #expect(ids(svc.state()).isEmpty)
    }

    @Test func timersAndFocusShareOneGlideTitle() async throws {
        let tctx = N7TestContext("timers"), fctx = N7TestContext("focus")
        defer { tctx.cleanup(); fctx.cleanup() }
        let t = TimersFeature(), fo = FocusFeature()
        t.now = { 0 }
        fo.now = { 0 }
        await t.start(context: tctx)
        await fo.start(context: fctx)
        t.startTimer(180_000, "Tea")
        _ = await fo.start(goal: "", minutes: 25)
        let hub = StatusItemHub()
        hub.setGlideItem(StatusItemSpec(icon: StatusItemComposer.glideIcon, menu: [StatusMenuItem("Open Glide")]))
        hub.show("timers", try #require(t.statusSpec(title: TimersModel.trayTitle(t.data, now: 0))), placement: .combinable)
        hub.show("focus", try #require(fo.statusSpec()), placement: .combinable)
        let g = try #require(item(hub.state(), "glide"))
        #expect(g["title"] == "⏱ 3:00  ◷ 25:00")
        #expect((g["menu"]?.arrayValue ?? []).filter { $0["header"] != nil } == [["header": "Timers"], ["header": "Focus"]])
        _ = await fo.stop(completed: false)
    }
}
