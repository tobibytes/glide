import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Themes & Appearance (feature id "appearance", same bag as the Electron app): Switch Theme (pushed view with
/// live preview on j/k), Toggle Light/Dark, the Appearance settings page (presets, accent, density, font size,
/// radius, width, translucency + vibrancy material, animations).
@MainActor public final class AppearanceFeature: Feature, FeatureUI {
    public let id = "appearance"
    public let title = "Appearance"
    private weak var context: FeatureContext?
    private var switcher: ThemeSwitcherModel?
    private weak var host: LauncherViewHost?
    public static let switchView = ViewID(feature: "appearance", name: "switch")

    public init() {}

    var appearance: AppearanceStore? { context.map { AppearanceStore(store: $0.store) } }

    public func start(context: FeatureContext) async { self.context = context }
    public func stop() async { setPreview(nil) }

    // MARK: catalogue

    private func item(_ action: String, _ title: String, _ subtitle: String, _ symbol: String, _ keywords: [String]) -> SearchItem {
        SearchItem(id: "appearance:\(action)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol), keywords: keywords,
                   source: "appearance", feature: id, data: ["action": .string(action)])
    }

    public func items() -> [SearchItem] {
        guard let a = appearance else { return [] }
        let modeName = a.mode == "system" ? "System" : a.mode == "dark" ? "Dark" : "Light"
        return [
            item("switch", "Switch Theme", a.active.name, "paintpalette", ["theme", "appearance", "color", "scheme", "dark", "light"] + Themes.presets.map { $0.name.lowercased() }),
            item("toggle", "Toggle Light/Dark Appearance", "Now: \(modeName)", "circle.lefthalf.filled", ["dark mode", "light mode", "appearance", "theme", "night"]),
            item("settings", "Appearance Settings", "Themes, accent, density, fonts", "paintbrush", ["appearance", "theme", "font", "density", "accent", "translucency", "vibrancy"]),
        ]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "switch": return [ItemAction(id: "switch", title: "Switch Theme", shortcut: "↩", icon: "paintpalette"), ItemAction(id: "settings", title: "Open Appearance Settings", shortcut: "⌘↩", icon: "gearshape")]
        case "toggle": return [ItemAction(id: "toggle", title: "Toggle Light/Dark", shortcut: "↩", icon: "circle.lefthalf.filled"), ItemAction(id: "system", title: "Follow System Appearance", shortcut: "⌘↩", icon: "desktopcomputer")]
        case "settings": return [ItemAction(id: "settings", title: "Open Appearance Settings", shortcut: "↩", icon: "gearshape")]
        default: return []
        }
    }

    public func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let a = appearance else { return .error("Appearance is not ready") }
        switch action {
        case "switch": return .pushView(Self.switchView)
        case "settings": return .openSettings(page: "appearance")
        case "system":
            a.setMode("system")
            return .stay(message: "Following the system appearance")
        case "toggle":
            let m = a.toggleLightDark()
            return .stay(message: "Appearance: \(m == "dark" ? "Dark" : "Light")")
        default: return .error("Unknown action \(action)")
        }
    }

    // MARK: Switch Theme view

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard vid == Self.switchView, let a = appearance else { return nil }
        self.host = host
        let m: ThemeSwitcherModel
        if let existing = switcher { m = existing } else {
            m = ThemeSwitcherModel(activeId: a.active.id)
            switcher = m
            host.setPlaceholder("Search themes… (moving the selection previews it)")
            host.setFooter(primary: "Use Theme", hasActions: false)
        }
        let s = a.settings
        return AnyView(ThemeSwitchView(model: m, settings: s, darkSlot: s.darkTheme, lightSlot: s.lightTheme, host: host)
            .onDisappear { [weak self] in self?.closeSwitcher() })
    }

    private func closeSwitcher() {
        switcher = nil
        setPreview(nil)
    }

    /// Preview `id` on the launcher itself (nil = back to the saved theme).
    func setPreview(_ id: String?) {
        guard ThemePreview.presetId != id else { return }
        ThemePreview.presetId = id
        context?.refreshCatalogue() // rebuild → LauncherController.refreshTheme picks up the preview
    }

    private func ensureSwitcher() -> ThemeSwitcherModel? {
        if let s = switcher { return s }
        guard let a = appearance else { return nil }
        let m = ThemeSwitcherModel(activeId: a.active.id)
        switcher = m
        return m
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        guard view == Self.switchView, let m = ensureSwitcher() else { return false }
        if m.query != (host?.query ?? m.query) { m.query = host?.query ?? ""; m.selectedIndex = 0 }
        let plain = !key.meta && !key.ctrl && !key.alt && !key.shift
        let queryEmpty = (host?.query ?? "").isEmpty
        var delta: Int?
        if key.key == "ArrowDown" && plain || key.ctrl && ["j", "n"].contains(key.key) || plain && queryEmpty && key.key == "j" { delta = 1 }
        if key.key == "ArrowUp" && plain || key.ctrl && ["k", "p"].contains(key.key) || plain && queryEmpty && key.key == "k" { delta = -1 }
        if let delta {
            m.move(delta)
            setPreview(m.selected?.preset.id)
            return true
        }
        if key.key == "Enter" && !key.ctrl && !key.alt {
            guard let r = m.selected, let a = appearance else { return true }
            if key.meta {
                a.setSlot(r.preset.id)
                host?.toast("\(r.preset.scheme == .dark ? "Dark" : "Light") theme: \(r.preset.name)", style: .success)
            } else {
                a.applyPreset(r.preset.id)
                host?.toast("Theme: \(r.preset.name)", style: .success)
            }
            m.activeId = a.active.id
            m.selectedIndex = 0
            setPreview(nil)
            return true
        }
        if key.meta && !key.ctrl && !key.alt, let a = appearance {
            switch key.key.lowercased() {
            case "t": a.toggleLightDark(); m.activeId = a.active.id; setPreview(nil); return true
            case "y": a.setMode("system"); m.activeId = a.active.id; setPreview(nil); return true
            case ",": setPreview(nil); context?.openSettings(page: "appearance"); return true
            default: break
            }
        }
        return false
    }

    // MARK: settings page

    public var settingsPage: SettingsPage? {
        SettingsPage(id: "appearance", title: "Appearance", symbol: "paintpalette", order: 1) { [weak self] in
            guard let a = self?.appearance else { return AnyView(Text("Appearance is starting…")) }
            return AnyView(AppearanceSettingsView(model: AppearancePageModel(appearance: a)))
        }
    }

    // MARK: methods (renderer API + test channel)

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        guard let a = appearance else { throw FeatureError.failed("Appearance is not ready") }
        switch method {
        case "get": return a.stateJSON()
        case "set": a.set(args.objectValue ?? [:]); return a.stateJSON()
        case "setMode": return .string(a.setMode(args.stringValue ?? args["mode"]?.stringValue ?? ""))
        case "applyPreset":
            let r = a.applyPreset(args.stringValue ?? args["id"]?.stringValue ?? "")
            return ["ok": .bool(r.ok), "mode": .string(r.mode)]
        case "toggle": return .string(a.toggleLightDark())
        case "reset": a.reset(); return a.stateJSON()
        case "switcherState":
            let m = switcher
            return ["open": .bool(m != nil), "selected": m?.selected.map { .string($0.preset.id) } ?? .null,
                    "rows": .array((m?.rows ?? []).map { .string($0.preset.id) }), "preview": ThemePreview.presetId.map(JSONValue.string) ?? .null]
        case "snapshot":
            let path = args["path"]?.stringValue ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-appearance.png").path
            let url = URL(fileURLWithPath: path)
            switch args["view"]?.stringValue ?? "settings" {
            case "switch":
                let m = ThemeSwitcherModel(activeId: a.active.id)
                m.selectedIndex = args["selected"]?.intValue ?? 1
                let theme = GlideTheme(tokens: Themes.tokens(m.selected?.preset ?? a.active, a.settings), opaqueBackground: true)
                let v = ThemeSwitchView(model: m, settings: a.settings, darkSlot: a.settings.darkTheme, lightSlot: a.settings.lightTheme, host: SnapshotHost())
                    .background(theme.panelSolid).glideTheme(theme)
                return OffscreenSnapshot.result(path: path, size: try OffscreenSnapshot.render(v, size: CGSize(width: 760, height: 420), to: url))
            default:
                let v = AppearanceSettingsView(model: AppearancePageModel(appearance: a))
                let dark = a.isDark
                return OffscreenSnapshot.result(path: path, size: try OffscreenSnapshot.render(v, size: CGSize(width: 640, height: 2150), to: url, appearance: dark ? .darkAqua : .aqua))
            }
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

/// Host stand-in for offscreen snapshots of launcher views.
@MainActor final class SnapshotHost: LauncherViewHost {
    var query: String = ""
    func setPlaceholder(_ text: String) {}
    func push(_ view: ViewID, payload: JSONValue) {}
    func pop() {}
    func close() {}
    func toast(_ message: String, style: ToastStyle) {}
    func setFooter(primary: String?, hasActions: Bool) {}
}
