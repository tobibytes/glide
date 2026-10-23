import Foundation
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem
import Testing

/// layouts.json exactly as the Electron app writes it (JSON.stringify(f, null, 2)).
let electronLayoutsJSON = """
{
  "version": 1,
  "layouts": [
    {
      "id": "layout-mabc-x1y2z3",
      "name": "Coding",
      "createdAt": 1729500000000,
      "updatedAt": 1729500100000,
      "displays": [
        { "id": 1, "uuid": "A", "name": "Built-in", "frame": { "x": 0, "y": 0, "width": 1440, "height": 900 },
          "visible": { "x": 0, "y": 25, "width": 1440, "height": 875 }, "main": true }
      ],
      "windows": [
        { "bundleId": "com.microsoft.VSCode", "appName": "Code", "appPath": "/Applications/Visual Studio Code.app", "title": "glide — main.swift",
          "frame": { "x": 0, "y": 25, "width": 720, "height": 875 }, "display": 0, "order": 0 },
        { "bundleId": "com.apple.Terminal", "appName": "Terminal", "appPath": null, "title": "zsh",
          "frame": { "x": 720, "y": 25, "width": 720, "height": 875 }, "display": 3, "order": 0 },
        { "bundleId": "", "appName": "broken", "frame": { "x": 0, "y": 0, "width": 1, "height": 1 } }
      ]
    },
    { "id": "", "name": "no id" }
  ],
  "workspaces": [
    { "id": "ws-1", "name": "  Deep Work ", "layoutId": "layout-mabc-x1y2z3", "relaunchLayoutApps": true,
      "launchApps": [{ "name": "Code", "bundleId": "com.microsoft.VSCode", "path": null }, { "name": "Dup", "bundleId": "com.microsoft.VSCode" }],
      "quitApps": [{ "name": "Slack", "bundleId": "com.tinyspeck.slackmacgap", "path": null }],
      "urls": ["github.com/tobibytes/glide", "https://example.com", "not a url", "~/Projects"],
      "focus": { "goal": "Ship", "minutes": 50 }, "shortcut": " Focus On ", "noteId": null, "createdAt": 1, "updatedAt": 2 },
    { "id": "ws-2", "name": "Stale", "layoutId": "gone", "createdAt": 1 }
  ]
}
"""

@Suite("layouts model")
struct LayoutsModelTests {
    @Test func parsesElectronFile() throws {
        let f = LayoutsCodec.parse(Data(electronLayoutsJSON.utf8))
        #expect(f.layouts.count == 1)
        let l = try #require(f.layouts.first)
        #expect(l.name == "Coding")
        #expect(l.windows.count == 2) // the window without bundle id is dropped
        #expect(l.windows[1].display == 0) // out-of-range display index → 0
        #expect(l.displays.first?.uuid == "A")
        #expect(f.workspaces.count == 2)
        let ws = f.workspaces[0]
        #expect(ws.name == "Deep Work")
        #expect(ws.launchApps.count == 1) // de-duplicated by bundle id
        #expect(ws.urls == ["https://github.com/tobibytes/glide", "https://example.com", "~/Projects"])
        #expect(ws.focus == .init(goal: "Ship", minutes: 50))
        #expect(ws.shortcut == "Focus On")
        #expect(f.workspaces[1].layoutId == nil) // dangling layout reference cleared
    }

    @Test func roundTripsThroughEncode() {
        let f = LayoutsCodec.parse(Data(electronLayoutsJSON.utf8))
        let again = LayoutsCodec.parse(LayoutsCodec.encode(f))
        #expect(again == f)
    }

    @Test func badFileIsEmpty() {
        #expect(LayoutsCodec.parse(Data("nope".utf8)) == LayoutsFile())
        #expect(LayoutsCodec.parse(Data("[1,2]".utf8)) == LayoutsFile())
    }

    @Test func titles() {
        #expect(LayoutsLogic.normalizeTitle("● Notes.md — Edited") == "notes.md")
        #expect(LayoutsLogic.titleSimilarity("Inbox (3) - Mail", "Inbox (3) - Mail") == 1)
        #expect(LayoutsLogic.titleSimilarity("main.swift", "glide — main.swift") == 0.8)
        #expect(LayoutsLogic.titleSimilarity("a b", "") == 0)
    }

    func saved(_ bid: String, _ title: String, order: Int, x: Double = 0) -> SavedWindow {
        SavedWindow(bundleId: bid, appName: bid, appPath: nil, title: title, frame: Rect(x: x, y: 25, width: 500, height: 400), display: 0, order: order)
    }
    func live(_ ref: Int, _ bid: String, _ title: String, order: Int, full: Bool = false) -> LiveWindow {
        LiveWindow(ref: ref, bundleId: bid, appName: bid, appPath: nil, title: title, frame: Rect(x: 10, y: 30, width: 300, height: 300), display: 0, order: order, fullScreen: full)
    }

    @Test func matchesByTitleThenSimilarThenOrder() {
        let s = [saved("code", "README.md — glide", order: 0), saved("code", "Package.swift — glide", order: 1), saved("code", "scratch", order: 2), saved("term", "zsh", order: 0)]
        let l = [live(1, "code", "Package.swift — glide", order: 0), live(2, "code", "README.md — glide — Edited", order: 1), live(3, "code", "Untitled", order: 2),
                 live(4, "term", "zsh", order: 0, full: true)]
        let m = LayoutsLogic.matchWindows(saved: s, live: l)
        let how = Dictionary(uniqueKeysWithValues: m.pairs.map { ($0.saved.title, ($0.live.ref, $0.how)) })
        #expect(how["Package.swift — glide"]?.0 == 1)
        #expect(how["Package.swift — glide"]?.1 == .title)
        #expect(how["README.md — glide"]?.0 == 2)
        #expect(how["README.md — glide"]?.1 == .title)
        #expect(how["scratch"]?.1 == .order)
        #expect(m.unmatched.map(\.title) == ["zsh"]) // full-screen windows are never moved
    }

    @Test func mapsFramesAcrossDisplays() {
        let small = SavedDisplay(id: 1, uuid: "A", name: "A", frame: Rect(x: 0, y: 0, width: 1440, height: 900), visible: Rect(x: 0, y: 0, width: 1440, height: 900), main: true)
        let big = SavedDisplay(id: 2, uuid: "B", name: "B", frame: Rect(x: 0, y: 0, width: 2880, height: 1800), visible: Rect(x: 0, y: 0, width: 2880, height: 1800), main: true)
        let half = Rect(x: 720, y: 0, width: 720, height: 900)
        // Same display, same place: unchanged.
        #expect(LayoutsLogic.mapFrame(half, savedDisplay: small, live: [small]) == half)
        // Display changed: scaled relative to the visible area.
        #expect(LayoutsLogic.mapFrame(half, savedDisplay: small, live: [big]) == Rect(x: 1440, y: 0, width: 1440, height: 1800))
        // UUID wins over the main display.
        #expect(LayoutsLogic.findDisplay(big, live: [small, big])?.uuid == "B")
        // Too big for the target: clamped into the visible area.
        let r = LayoutsLogic.mapFrame(Rect(x: -100, y: 0, width: 5000, height: 5000), savedDisplay: nil, live: [small])
        #expect(r == Rect(x: 0, y: 0, width: 1440, height: 900))
    }

    @Test func missingApps() {
        let s = [saved("a", "1", order: 0), saved("b", "1", order: 0), saved("c", "1", order: 0)]
        #expect(LayoutsLogic.missingApps(s, live: [live(1, "a", "x", order: 0)], running: ["a", "b"]) == ["b", "c"])
    }

    @Test @MainActor func engineSavesAndRestores() async throws {
        let fake = FakeLayouts()
        fake.windows = [FakeLayouts.window(1, "com.apple.Terminal", "zsh", x: 0), FakeLayouts.window(2, "com.apple.Safari", "Apple", x: 700)]
        var launched: [String] = []
        var engine = LayoutsEngine(service: fake) { app in launched.append(app.bundleId); return .success }
        engine.sleep = { _ in }
        let layout = try await engine.captureLayout(name: " Two ")
        #expect(layout.name == "Two")
        #expect(layout.windows.count == 2)
        // Windows moved since: restore puts them back.
        fake.windows = [FakeLayouts.window(7, "com.apple.Safari", "Apple", x: 10), FakeLayouts.window(8, "com.apple.Terminal", "zsh", x: 20)]
        let r = await engine.restore(layout, relaunch: false, launchTimeout: .seconds(2))
        #expect(r.ok)
        #expect(r.moved == 2)
        let moved = fake.moves.first?.arrayValue ?? []
        #expect(moved.count == 2)
        let safari = moved.first { $0["ref"]?.intValue == 7 }
        #expect(safari?["frame"]?["x"]?.doubleValue == 700)
        #expect(launched.isEmpty)
        #expect(r.summary("Two") == "Restored Two: 2/2 windows")
    }

    @Test @MainActor func engineRelaunchesMissingApps() async {
        let fake = FakeLayouts()
        fake.running = ["com.apple.Terminal"]
        fake.windows = [FakeLayouts.window(1, "com.apple.Terminal", "zsh")]
        let layout = WindowLayout(id: "l", name: "L", createdAt: 0, updatedAt: 0, displays: LayoutsCodec.displays(fake.displaysValue),
                                  windows: [SavedWindow(bundleId: "com.apple.Terminal", appName: "Terminal", appPath: nil, title: "zsh", frame: Rect(x: 0, y: 25, width: 600, height: 400), display: 0, order: 0),
                                            SavedWindow(bundleId: "com.apple.Notes", appName: "Notes", appPath: nil, title: "Notes", frame: Rect(x: 600, y: 25, width: 600, height: 400), display: 0, order: 0)])
        var launched: [String] = []
        var t = 0.0
        var engine = LayoutsEngine(service: fake) { app in launched.append(app.bundleId); return .success }
        engine.sleep = { _ in t += 500 }
        engine.now = { t }
        let r = await engine.restore(layout, relaunch: true, launchTimeout: .seconds(2))
        #expect(launched == ["com.apple.Notes"])
        #expect(r.launched == ["Notes"])
        #expect(r.moved == 1)
        #expect(r.unmatched.count == 1) // Notes never opened a window within the timeout
    }

    @Test @MainActor func featureReadsExistingDataAndConfirmsQuits() async throws {
        let ctx = N3Context("layouts")
        try Data(electronLayoutsJSON.utf8).write(to: ctx.dataDirectory().appendingPathComponent("layouts.json"))
        let f = LayoutsFeature()
        f.hideDelay = .zero
        await f.start(context: ctx)
        let ids = f.items().map(\.id)
        #expect(ids.contains("layouts.layout.layout-mabc-x1y2z3"))
        #expect(ids.contains("layouts.workspace.ws-1"))
        // A workspace whose quit list has a running app pushes the confirmation view first.
        _ = try await f.invoke(method: "saveWorkspace", args: ["id": "ws-q", "name": "Quit Finder", "quitApps": [["name": "Finder", "bundleId": "com.apple.finder"]],
                                                               "urls": ["example.com"]])
        let running = (ctx.services.layouts.runningApps().arrayValue ?? []).contains { $0["bundleId"]?.stringValue == "com.apple.finder" }
        let r = await f.openWorkspace("ws-q")
        if running {
            #expect(r == .pushView("layouts.confirm", payload: ["workspaceId": "ws-q"]))
            #expect(ctx.effects("quit-apps").isEmpty) // nothing quit before the user confirms
            #expect(f.handleCommand(.activate([]), view: "layouts.confirm"))
            try await Task.sleep(for: .milliseconds(100))
            #expect(ctx.effects("quit-apps").first == ["com.apple.finder"])
        }
        // Saved back in the same format.
        let saved = LayoutsCodec.parse(try Data(contentsOf: ctx.dataDirectory().appendingPathComponent("layouts.json")))
        #expect(saved.workspaces.map(\.id).sorted() == ["ws-1", "ws-2", "ws-q"])
        #expect(saved.workspaces.first { $0.id == "ws-q" }?.urls == ["https://example.com"])
    }
}
