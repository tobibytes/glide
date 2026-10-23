import Foundation

// Port of src/main/features/appearance/themes.ts: 9 presets, appearance settings (feature bag "appearance"),
// and token generation. Pure; GlideUI turns `ThemeTokens` into SwiftUI colors and metrics.

public struct RGBA: Hashable, Sendable, Codable {
    public var r: Double, g: Double, b: Double, a: Double
    public init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        self.r = r
        self.g = g
        self.b = b
        self.a = a
    }
    public init?(hex: String) {
        var h = hex.trimmingCharacters(in: .whitespaces)
        if h.hasPrefix("#") { h.removeFirst() }
        guard h.count == 3 || h.count == 6, h.allSatisfy(\.isHexDigit) else { return nil }
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        let v = Int(h, radix: 16)!
        self.init(Double((v >> 16) & 0xFF), Double((v >> 8) & 0xFF), Double(v & 0xFF))
    }
    public var hex: String {
        String(format: "#%02x%02x%02x", Int(min(255, max(0, r)).rounded()), Int(min(255, max(0, g)).rounded()), Int(min(255, max(0, b)).rounded()))
    }
    public func alpha(_ a: Double) -> RGBA { RGBA(r, g, b, a) }
    public func mix(_ o: RGBA, _ t: Double) -> RGBA { RGBA(r + (o.r - r) * t, g + (o.g - g) * t, b + (o.b - b) * t, a) }
    public var luminance: Double {
        func lin(_ v: Double) -> Double { let c = v / 255; return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
    public func contrast(_ o: RGBA) -> Double {
        let a = luminance, b = o.luminance
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
    public static let white = RGBA(255, 255, 255)
    public static let black = RGBA(0, 0, 0)
}

public enum ColorScheme: String, Sendable, Codable { case dark, light }

public struct ThemePreset: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var scheme: ColorScheme
    public var bg: String, surface: String, surface2: String, surface3: String
    public var text: String, text2: String, text3: String
    public var accent: String, danger: String, success: String, warning: String
    public var contrast: Double = 1
}

public enum Density: String, Sendable, Codable { case compact, comfortable }

/// The "appearance" feature bag (same keys and limits as the Electron app).
public struct AppearanceSettings: Hashable, Sendable {
    public var darkTheme = "glide-dark"
    public var lightTheme = "glide-light"
    /// "" = preset accent, else #rrggbb
    public var accent = ""
    public var density = Density.comfortable
    public var fontSize = 14
    public var radius = 14
    public var width = 760
    public var translucency = 35
    public var vibrancy = true
    public var animations = true
    public init() {}

    public static let featureId = "appearance"
    public static let limits = (fontSize: 12...17, radius: 0...22, width: 640...980, translucency: 0...100)

    /// normalizeAppearance: validate an untrusted bag.
    public init(bag: [String: JSONValue]) {
        func num(_ k: String, _ r: ClosedRange<Int>, _ d: Int) -> Int {
            guard let v = bag[k]?.doubleValue, v.isFinite else { return d }
            return min(r.upperBound, max(r.lowerBound, Int(v.rounded())))
        }
        func theme(_ k: String, _ d: String) -> String {
            if let v = bag[k]?.stringValue, Themes.preset(v) != nil { return v }
            return d
        }
        let d = AppearanceSettings()
        darkTheme = theme("darkTheme", d.darkTheme)
        lightTheme = theme("lightTheme", d.lightTheme)
        accent = bag["accent"]?.stringValue.flatMap { RGBA(hex: $0)?.hex } ?? ""
        density = bag["density"]?.stringValue == "compact" ? .compact : .comfortable
        fontSize = num("fontSize", Self.limits.fontSize, d.fontSize)
        radius = num("radius", Self.limits.radius, d.radius)
        width = num("width", Self.limits.width, d.width)
        translucency = num("translucency", Self.limits.translucency, d.translucency)
        vibrancy = bag["vibrancy"]?.boolValue ?? d.vibrancy
        animations = bag["animations"]?.boolValue ?? d.animations
    }
}

/// Every design token, resolved for one preset + the user's adjustments. Colors are 0–255 RGBA.
public struct ThemeTokens: Hashable, Sendable {
    public var preset: ThemePreset
    public var scheme: ColorScheme
    public var accent, accentSoft, accentText, accentContrast, accentGlow: RGBA
    public var bg, panel, panelSolid, surface, surface2, surface3: RGBA
    public var hover, selected, selectedRing, border, borderStrong: RGBA
    public var text, text2, text3, kbdBg, kbdText, tagBg: RGBA
    public var danger, success, warning, sidebar, inputBg, iconBg: RGBA
    // metrics (points)
    public var launcherWidth: Double
    public var radius, radiusSm, radiusXs, rowRadius: Double
    public var rowHeight, rowGap, headHeight: Double
    public var fontTitle, fontSubtitle, fontInput, fontSection: Double
    public var iconSize: Double
    public var listPadding: (v: Double, h: Double)
    public var vibrancy: Bool
    public var animations: Bool
    /// 0…1: how see-through the panel is (translucency/100).
    public var translucency: Double

    public static func == (a: ThemeTokens, b: ThemeTokens) -> Bool { a.preset == b.preset && a.accent == b.accent && a.rowHeight == b.rowHeight && a.launcherWidth == b.launcherWidth && a.panel == b.panel && a.fontTitle == b.fontTitle && a.radius == b.radius && a.vibrancy == b.vibrancy }
    public func hash(into h: inout Hasher) { h.combine(preset); h.combine(accent); h.combine(rowHeight); h.combine(launcherWidth) }
}

public enum Themes {
    private static let status = (danger: "#ff6b5e", success: "#4ade80", warning: "#fbbf24")

    public static let presets: [ThemePreset] = [
        ThemePreset(id: "glide-dark", name: "Glide Dark", scheme: .dark, bg: "#161618", surface: "#202023", surface2: "#2a2a2e", surface3: "#343439", text: "#f4f4f6", text2: "#a9a9b3", text3: "#8b8b95", accent: "#f5a524", danger: status.danger, success: status.success, warning: status.warning),
        ThemePreset(id: "glide-light", name: "Glide Light", scheme: .light, bg: "#f6f6f8", surface: "#ffffff", surface2: "#f0f0f3", surface3: "#e4e4e9", text: "#18181c", text2: "#585862", text3: "#71717b", accent: "#e08e0b", danger: "#d63b2f", success: "#1f9d55", warning: "#c77700"),
        ThemePreset(id: "midnight", name: "Midnight", scheme: .dark, bg: "#0b0e17", surface: "#121726", surface2: "#1a2033", surface3: "#242b42", text: "#e8ebf5", text2: "#9aa3bd", text3: "#7f88a3", accent: "#7c8cff", danger: status.danger, success: status.success, warning: status.warning),
        ThemePreset(id: "nord", name: "Nord", scheme: .dark, bg: "#2e3440", surface: "#3b4252", surface2: "#434c5e", surface3: "#4c566a", text: "#eceff4", text2: "#c5cddb", text3: "#8a93a6", accent: "#88c0d0", danger: "#bf616a", success: "#a3be8c", warning: "#ebcb8b"),
        ThemePreset(id: "solarized", name: "Solarized", scheme: .dark, bg: "#002b36", surface: "#073642", surface2: "#0d4250", surface3: "#164e5c", text: "#eee8d5", text2: "#93a1a1", text3: "#839496", accent: "#268bd2", danger: "#dc322f", success: "#859900", warning: "#b58900"),
        ThemePreset(id: "dracula", name: "Dracula", scheme: .dark, bg: "#21222c", surface: "#282a36", surface2: "#343746", surface3: "#44475a", text: "#f8f8f2", text2: "#c6c8d6", text3: "#7a84b8", accent: "#bd93f9", danger: "#ff5555", success: "#50fa7b", warning: "#f1fa8c"),
        ThemePreset(id: "mocha", name: "Mocha", scheme: .dark, bg: "#181825", surface: "#1e1e2e", surface2: "#313244", surface3: "#45475a", text: "#cdd6f4", text2: "#a6adc8", text3: "#7f849c", accent: "#cba6f7", danger: "#f38ba8", success: "#a6e3a1", warning: "#f9e2af"),
        ThemePreset(id: "dawn", name: "Dawn", scheme: .light, bg: "#faf4ed", surface: "#fffaf3", surface2: "#f2e9e1", surface3: "#e4dcd6", text: "#4b466c", text2: "#6e6a88", text3: "#77738e", accent: "#d7827e", danger: "#b4637a", success: "#286983", warning: "#ea9d34"),
        ThemePreset(id: "high-contrast", name: "High Contrast", scheme: .dark, bg: "#000000", surface: "#0a0a0a", surface2: "#1a1a1a", surface3: "#2b2b2b", text: "#ffffff", text2: "#e8e8e8", text3: "#c2c2c2", accent: "#ffd60a", danger: "#ff6b6b", success: "#5dff9a", warning: "#ffd60a", contrast: 2.2),
    ]

    public static func preset(_ id: String) -> ThemePreset? { presets.first { $0.id == id } }

    /// "system" follows the OS appearance.
    public static func resolve(mode: String, systemDark: Bool, settings: AppearanceSettings) -> ThemePreset {
        let dark = mode == "dark" || (mode != "light" && systemDark)
        return preset(dark ? settings.darkTheme : settings.lightTheme) ?? preset(dark ? "glide-dark" : "glide-light")!
    }

    /// Readable accent text: nudge toward the text color until ~4.5:1.
    static func readable(_ color: RGBA, on bg: RGBA, text: RGBA, target: Double = 4.5) -> RGBA {
        var c = color
        var i = 0
        while i < 10 && c.contrast(bg) < target { c = c.mix(text, 0.15); i += 1 }
        return c
    }

    public static func tokens(_ p: ThemePreset, _ s: AppearanceSettings) -> ThemeTokens {
        let dark = p.scheme == .dark
        let k = p.contrast
        let bg = RGBA(hex: p.bg)!, surface = RGBA(hex: p.surface)!, text = RGBA(hex: p.text)!
        let accent = RGBA(hex: s.accent) ?? RGBA(hex: p.accent)!
        let ink: RGBA = dark ? .white : .black
        let panel = bg.mix(surface, 0.35)
        let alpha = 1 - (Double(s.translucency) / 100) * 0.5
        let onAccent: RGBA = accent.contrast(.white) >= 3 ? .white : RGBA(hex: "#16130c")!
        let compact = s.density == .compact
        let fs = Double(s.fontSize)
        let r = Double(s.radius)
        return ThemeTokens(
            preset: p, scheme: p.scheme,
            accent: accent, accentSoft: accent.alpha(dark ? 0.2 : 0.16), accentText: readable(accent, on: panel, text: text),
            accentContrast: onAccent, accentGlow: accent.alpha(0.35),
            bg: bg, panel: panel.alpha(alpha), panelSolid: panel.mix(surface, 0.4), surface: surface,
            surface2: RGBA(hex: p.surface2)!, surface3: RGBA(hex: p.surface3)!,
            hover: ink.alpha(min(0.2, (dark ? 0.045 : 0.04) * k)), selected: ink.alpha(min(0.3, (dark ? 0.085 : 0.065) * k)),
            selectedRing: ink.alpha(min(0.4, (dark ? 0.06 : 0.05) * k)), border: ink.alpha(min(0.35, (dark ? 0.08 : 0.085) * k)),
            borderStrong: ink.alpha(min(0.5, (dark ? 0.15 : 0.16) * k)),
            text: text, text2: RGBA(hex: p.text2)!, text3: RGBA(hex: p.text3)!, kbdBg: ink.alpha(dark ? 0.09 : 0.065), kbdText: RGBA(hex: p.text2)!,
            tagBg: ink.alpha(dark ? 0.1 : 0.07), danger: RGBA(hex: p.danger)!, success: RGBA(hex: p.success)!, warning: RGBA(hex: p.warning)!,
            sidebar: bg.mix(surface, 0.2).alpha(dark ? 0.6 : 0.7), inputBg: dark ? bg.mix(surface, 0.6) : surface, iconBg: ink.alpha(dark ? 0.07 : 0.05),
            launcherWidth: Double(s.width), radius: r, radiusSm: max(0, (r * 0.6).rounded()), radiusXs: max(0, (r * 0.36).rounded()),
            rowRadius: max(0, (r * 0.66).rounded()), rowHeight: (compact ? 34 : 42) + (fs - 14) * 2, rowGap: compact ? 8 : 12,
            headHeight: (compact ? 50 : 58) + (fs - 14) * 2, fontTitle: fs, fontSubtitle: fs - 1.25, fontInput: fs + (compact ? 4 : 6),
            fontSection: max(10.5, fs - 2.5), iconSize: compact ? 20 : 24, listPadding: compact ? (4, 6) : (6, 8),
            vibrancy: s.vibrancy, animations: s.animations, translucency: Double(s.translucency) / 100)
    }

    public static func tokens(mode: String, systemDark: Bool, bag: [String: JSONValue], previewId: String? = nil) -> ThemeTokens {
        let s = AppearanceSettings(bag: bag)
        let p = previewId.flatMap(preset) ?? resolve(mode: mode, systemDark: systemDark, settings: s)
        return tokens(p, s)
    }
}
