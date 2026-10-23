import AppKit
import GlideCore

/// Behind-window material for the launcher's vibrancy (NSVisualEffectView). Stored in the appearance bag as
/// "material" (a native-only key; the Electron app ignores it).
public enum VibrancyMaterial: String, CaseIterable, Sendable, Identifiable {
    case hudWindow, popover, menu, sidebar, headerView, sheet, windowBackground, underWindowBackground, fullScreenUI

    public static let defaultValue = VibrancyMaterial.hudWindow
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .hudWindow: return "HUD (default)"
        case .popover: return "Popover"
        case .menu: return "Menu"
        case .sidebar: return "Sidebar"
        case .headerView: return "Header"
        case .sheet: return "Sheet"
        case .windowBackground: return "Window"
        case .underWindowBackground: return "Under Window"
        case .fullScreenUI: return "Full Screen UI"
        }
    }

    public var nsMaterial: NSVisualEffectView.Material {
        switch self {
        case .hudWindow: return .hudWindow
        case .popover: return .popover
        case .menu: return .menu
        case .sidebar: return .sidebar
        case .headerView: return .headerView
        case .sheet: return .sheet
        case .windowBackground: return .windowBackground
        case .underWindowBackground: return .underWindowBackground
        case .fullScreenUI: return .fullScreenUI
        }
    }

    public init(bag: [String: JSONValue]?) {
        self = bag?["material"]?.stringValue.flatMap(VibrancyMaterial.init(rawValue:)) ?? .defaultValue
    }
}

/// Live theme preview (Switch Theme view): the launcher renders this preset instead of the resolved one
/// while it is set. Read by LauncherController.refreshTheme.
@MainActor public enum ThemePreview {
    public static var presetId: String?
}

public extension AppearanceSettings {
    /// The bag the Electron app writes (`{ ...normalizeAppearance(x) }`).
    var bag: [String: JSONValue] {
        ["darkTheme": .string(darkTheme), "lightTheme": .string(lightTheme), "accent": .string(accent), "density": .string(density.rawValue),
         "fontSize": .int(Int64(fontSize)), "radius": .int(Int64(radius)), "width": .int(Int64(width)), "translucency": .int(Int64(translucency)),
         "vibrancy": .bool(vibrancy), "animations": .bool(animations)]
    }
}

/// Appearance operations on the store (src/main/features/appearance/index.ts), shared by the feature, its
/// settings page, the Switch Theme view and onboarding's Look step.
@MainActor public struct AppearanceStore {
    public let store: Store
    public var systemDark: @MainActor () -> Bool
    public init(store: Store, systemDark: @escaping @MainActor () -> Bool = { AppearanceStore.currentSystemDark() }) {
        self.store = store
        self.systemDark = systemDark
    }

    public static func currentSystemDark() -> Bool {
        NSApp?.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            || (NSApp == nil && UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark")
    }

    public static let presetAccents = ["#f5a524", "#ff6b5e", "#f472b6", "#bd93f9", "#7c8cff", "#38bdf8", "#2dd4bf", "#4ade80"]

    public var rawBag: [String: JSONValue] { store.settings.features[AppearanceSettings.featureId] ?? [:] }
    public var settings: AppearanceSettings { AppearanceSettings(bag: rawBag) }
    public var material: VibrancyMaterial { VibrancyMaterial(bag: rawBag) }
    /// "system" | "dark" | "light" (the global Settings.theme).
    public var mode: String { store.settings.theme }
    public var active: ThemePreset { Themes.resolve(mode: mode, systemDark: systemDark(), settings: settings) }
    public var isDark: Bool { mode == "dark" || (mode != "light" && systemDark()) }

    /// Merge a patch, normalise (untrusted input), write the whole bag back.
    @discardableResult
    public func set(_ patch: [String: JSONValue]) -> AppearanceSettings {
        var merged = settings.bag
        for (k, v) in patch where k != "material" { merged[k] = v }
        let next = AppearanceSettings(bag: merged)
        var bag = next.bag
        let mat = patch["material"].map { VibrancyMaterial(bag: ["material": $0]) } ?? material
        bag["material"] = .string(mat.rawValue)
        // Keep any other keys a newer Glide may have stored.
        let previous = rawBag
        store.setSettings { s in
            var b = previous
            for (k, v) in bag { b[k] = v }
            s.features[AppearanceSettings.featureId] = b
        }
        return next
    }

    @discardableResult
    public func setMode(_ m: String) -> String {
        if ["system", "dark", "light"].contains(m) { store.setSettings { $0.theme = m } }
        return mode
    }

    /// The preset becomes the dark or light slot (by its scheme); the mode follows unless "system" already shows it.
    @discardableResult
    public func applyPreset(_ id: String) -> (ok: Bool, mode: String) {
        guard let p = Themes.preset(id) else { return (false, mode) }
        set(p.scheme == .dark ? ["darkTheme": .string(p.id)] : ["lightTheme": .string(p.id)])
        let systemScheme: GlideCore.ColorScheme = systemDark() ? .dark : .light
        let m = mode
        if !(m == "system" && systemScheme == p.scheme) && m != p.scheme.rawValue { setMode(p.scheme.rawValue) }
        return (true, mode)
    }

    /// Only set the slot for the preset's scheme (no mode change).
    public func setSlot(_ id: String) {
        guard let p = Themes.preset(id) else { return }
        set(p.scheme == .dark ? ["darkTheme": .string(p.id)] : ["lightTheme": .string(p.id)])
    }

    @discardableResult
    public func toggleLightDark() -> String { setMode(isDark ? "light" : "dark") }

    public func reset() {
        var bag = AppearanceSettings().bag
        bag["material"] = .string(VibrancyMaterial.defaultValue.rawValue)
        store.setSettings { $0.features[AppearanceSettings.featureId] = bag }
    }

    public var isDefault: Bool { settings == AppearanceSettings() && material == .defaultValue }

    public func stateJSON() -> JSONValue {
        var s = settings.bag
        s["material"] = .string(material.rawValue)
        return ["settings": .object(s), "mode": .string(mode), "systemDark": .bool(systemDark()), "active": .string(active.id),
                "presets": .array(Themes.presets.map { ["id": .string($0.id), "name": .string($0.name), "scheme": .string($0.scheme.rawValue)] })]
    }
}

/// Theme switcher ordering (SwitchThemeView.tsx): the active theme first, then dark, then light; query filters
/// by name or scheme.
public enum ThemeSwitcher {
    public struct Row: Hashable, Sendable {
        public var preset: ThemePreset
        public var section: String
    }

    public static func rows(query: String, activeId: String) -> [Row] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let list = Themes.presets.filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.scheme.rawValue.contains(q) }
        let rest = list.filter { $0.id != activeId }
        let ordered = list.filter { $0.id == activeId } + rest.filter { $0.scheme == .dark } + rest.filter { $0.scheme == .light }
        return ordered.map { Row(preset: $0, section: $0.id == activeId ? "Current" : $0.scheme == .dark ? "Dark Themes" : "Light Themes") }
    }
}
