import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem
import Testing

/// FeatureContext over headless services (status items land in the recording fake, never an NSStatusItem).
@MainActor final class N9MenuBarContext: FeatureContext {
    let featureId = "extensions"
    let store: Store
    let services: SystemServices
    let log = SideEffectLog(echo: false)
    let root = tempDir("n9-menubar")
    var catalogueRefreshes = 0
    init() {
        store = Store(directory: root, debounce: 0)
        services = SystemServicesFactory.headless(log: log, environment: [:])
    }
    func dataDirectory() -> URL {
        let d = GlidePaths.featureDirectory(featureId, root: root)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue] { store.settings.featureSettings(featureId, defaults: defaults) }
    func setSettings(_ patch: [String: JSONValue]) { store.setFeatureSettings(featureId, patch) }
    func refreshCatalogue() { catalogueRefreshes += 1 }
    func showLauncher() {}
    func hideLauncher() {}
    func push(_ view: ViewID, payload: JSONValue) {}
    func openSettings(page: String?) {}
    func toast(_ message: String, style: ToastStyle) {}
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool { true }
    func executeItem(id: String, argument: String?) async -> ActionResult { .stay(message: nil) }
    func search(_ query: String) async -> [ScoredItem] { [] }
    func findItem(id: String) -> SearchItem? { nil }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue { .null }
    func log(_ message: String) {}
}

@Suite("menu-bar commands: MenuBarExtra → status item model")
@MainActor struct MenuBarExtraModelTests {
    @Test func treeToMenu() {
        var invoked: [String] = []
        let view: JSONValue = [
            "type": "menubar", "title": "C3", "icon": "🧪", "tooltip": "Compat Lab", "isLoading": false,
            "items": [
                ["kind": "section", "title": "Counter", "children": [
                    ["kind": "item", "title": "Increment", "icon": "➕", "shortcut": "⌘I", "handler": "h1"],
                    ["kind": "item", "title": "Read only", "subtitle": "no action"],
                ]],
                ["kind": "separator"],
                ["kind": "submenu", "title": "More", "children": [["kind": "item", "title": "Say Hi", "handler": "h2"]]],
                ["kind": "separator"],
                ["kind": "section", "children": []],
            ],
        ]
        let spec = MenuBarExtraModel.spec(view, fallbackTitle: "Compat Menu Bar", assetsPath: nil) { invoked.append($0) }
        #expect(spec.title == "C3" && spec.icon == "🧪" && spec.tooltip == "Compat Lab" && !spec.isLoading)
        #expect(StatusMenuJSON.strip(spec.menu) == [
            ["header": "Counter"],
            ["title": "Increment", "icon": "➕", "shortcut": "⌘I", "clickable": true],
            ["title": "Read only", "subtitle": "no action", "enabled": false],
            ["separator": true],
            ["title": "More", "submenu": [["title": "Say Hi", "clickable": true]]],
        ])
        spec.menu[1].onClick?()
        spec.menu[4].submenu?[0].onClick?()
        #expect(invoked == ["h1", "h2"])
    }

    @Test func fallbacksLoadingAndErrors() {
        let loading = MenuBarExtraModel.spec(["type": "menubar", "isLoading": true, "items": []], fallbackTitle: "Weather", assetsPath: nil) { _ in }
        #expect(loading.title == "Weather" && loading.isLoading)
        #expect(StatusMenuJSON.strip(loading.menu) == [["title": "Loading…", "enabled": false]])
        let err = MenuBarExtraModel.errorSpec(commandTitle: "Weather", message: "boom")
        #expect(err.title == "⚠️" && err.tooltip == "Weather failed")
        #expect(MenuBarExtraModel.errorMessage(["type": "detail", "markdown": "# Weather failed\n\nboom\n\n```\nstack\n```"]) == "boom")
        #expect(MenuBarExtraModel.errorMessage(["type": "list"]) == "A menu-bar command must render <MenuBarExtra>")
    }

    @Test func icons() throws {
        let assets = tempDir("n9-assets")
        try Data([0x89]).write(to: assets.appendingPathComponent("icon.png"))
        #expect(MenuBarExtraModel.menuIcon("icon.png", assetsPath: assets.path) == assets.appendingPathComponent("icon.png").path)
        #expect(MenuBarExtraModel.menuIcon("missing.png", assetsPath: assets.path) == nil)
        #expect(MenuBarExtraModel.menuIcon("../x.png", assetsPath: assets.path) == nil)
        #expect(MenuBarExtraModel.menuIcon("file:///tmp/a%20b.png", assetsPath: nil) == "/tmp/a b.png")
        #expect(MenuBarExtraModel.menuIcon("https://x/y.png", assetsPath: nil) == nil)
        #expect(MenuBarExtraModel.menuIcon("#ff0000", assetsPath: nil) == nil)
        #expect(MenuBarExtraModel.menuIcon("⭐️", assetsPath: nil) == "⭐️")
        #expect(MenuBarExtraModel.itemId("rc-compat", "menu-status") == "ext:rc-compat/menu-status")
    }
}

@Suite("menu-bar commands on JavaScriptCore", .serialized)
@MainActor struct MenuBarCommandRuntimeTests {
    init() throws {
        try #require(RaycastBuilder.esbuildBinary() != nil, "esbuild (node_modules) is needed to build the .tsx fixtures")
    }

    private func item(_ ctx: N9MenuBarContext) -> JSONValue? {
        ctx.services.statusItems.state()["items"]?.arrayValue?.first { $0["id"]?.stringValue == "ext:rc-compat/menu-status" }
    }

    @Test func runRenderClickRerunDeactivate() async throws {
        let ctx = N9MenuBarContext()
        defer { try? FileManager.default.removeItem(at: ctx.root) }
        let f = ExtensionsFeature()
        f.examplesDirOverride = examplesDir
        await f.start(context: ctx)
        defer { Task { await f.stop() } }
        _ = try await f.invoke(method: "installFolder", args: ["path": .string(examplesDir.appendingPathComponent("raycast-fixtures/rc-compat").path)])
        let r = try await f.invoke(method: "run", args: ["name": "rc-compat", "command": "menu-status"])
        #expect(r["result"] == "hide", "\(r)")
        // The MenuBarExtra renders into its own status item (separate, never merged into Glide's icon).
        #expect(await waitUntil { self.item(ctx)?["title"] == "C0" }, "\(ctx.services.statusItems.state()) \(f.menuBar.state())")
        let it = try #require(item(ctx))
        #expect(it["icon"] == "🧪" && it["tooltip"] == "Compat Lab")
        let menu = it["menu"]?.arrayValue ?? []
        #expect(menu.first == ["header": "Counter"])
        #expect(menu[1]["title"] == "Increment" && menu[1]["shortcut"] == "⌘I")
        #expect(menu.last?["title"] == "More")
        // Running it activated it (Electron bag key `background`).
        #expect(ctx.store.settings.features["extensions"]?["background"]?["rc-compat/menu-status"] == true)
        // onAction in the live session → LocalStorage + revalidate → re-render.
        #expect(try await f.invoke(method: "menuBarClick", args: ["ext": "rc-compat", "command": "menu-status", "path": [1]]) == true)
        #expect(await waitUntil { self.item(ctx)?["title"] == "C1" }, "\(item(ctx) ?? .null)")
        // Opening the menu re-runs the command (a fresh session, userInitiated); the count survives.
        f.menuBar.menuOpenRerunAfter = 0
        let before = f.menuBar.slots["rc-compat/menu-status"]?.runs ?? 0
        _ = try await f.invoke(method: "menuBarOpen", args: ["ext": "rc-compat", "command": "menu-status"])
        #expect(await waitUntil { (f.menuBar.slots["rc-compat/menu-status"]?.runs ?? 0) > before })
        #expect(await waitUntil { self.item(ctx)?["title"] == "C1" })
        // Interval re-run (launchType background).
        _ = try await f.invoke(method: "menuBarRefresh", args: ["ext": "rc-compat", "command": "menu-status"])
        let support = ctx.dataDirectory().appendingPathComponent("support/rc-compat/menu.log")
        #expect(await waitUntil { ((try? String(contentsOf: support, encoding: .utf8)) ?? "").contains("render background 1") },
                "\((try? String(contentsOf: support, encoding: .utf8)) ?? "no log at \(support.path)")")
        let state = try await f.invoke(method: "menuBarState", args: .null)
        let row = state.arrayValue?.first { $0["command"] == "menu-status" }
        #expect(row?["enabled"] == true && row?["active"] == true && row?["interval"] == "10s")
        // Deactivate → item removed, session stopped.
        _ = try await f.invoke(method: "setBackground", args: ["ext": "rc-compat", "command": "menu-status", "enabled": false])
        #expect(item(ctx) == nil)
        #expect(ctx.log.all.contains { $0.kind == "status-item" && $0.detail["id"] == "ext:rc-compat/menu-status" && $0.detail["removed"] == true })
    }
}
