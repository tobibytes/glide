import AppKit
import GlideCore
import SwiftUI

public extension Color {
    init(_ c: RGBA) { self.init(.sRGB, red: c.r / 255, green: c.g / 255, blue: c.b / 255, opacity: c.a) }
}

public extension NSColor {
    convenience init(_ c: RGBA) { self.init(srgbRed: c.r / 255, green: c.g / 255, blue: c.b / 255, alpha: c.a) }
}

/// SwiftUI view of the design tokens (themes.ts). Injected with `.glideTheme(_:)`, read with
/// `@Environment(\.glideTheme)`.
public struct GlideTheme: Sendable, Equatable {
    public var tokens: ThemeTokens
    /// Snapshots / headless rendering: no behind-window vibrancy (it renders blank offscreen).
    public var opaqueBackground: Bool

    public init(tokens: ThemeTokens, opaqueBackground: Bool = false) {
        self.tokens = tokens
        self.opaqueBackground = opaqueBackground
    }

    public static let `default` = GlideTheme(tokens: Themes.tokens(mode: "dark", systemDark: true, bag: [:]))

    public var isDark: Bool { tokens.scheme == .dark }
    public var colorScheme: SwiftUI.ColorScheme { isDark ? .dark : .light }

    public var accent: Color { Color(tokens.accent) }
    public var accentSoft: Color { Color(tokens.accentSoft) }
    public var accentText: Color { Color(tokens.accentText) }
    public var accentContrast: Color { Color(tokens.accentContrast) }
    public var panel: Color { Color(tokens.panel) }
    public var panelSolid: Color { Color(tokens.panelSolid) }
    public var surface: Color { Color(tokens.surface) }
    public var surface2: Color { Color(tokens.surface2) }
    public var hover: Color { Color(tokens.hover) }
    public var selected: Color { Color(tokens.selected) }
    public var selectedRing: Color { Color(tokens.selectedRing) }
    public var border: Color { Color(tokens.border) }
    public var borderStrong: Color { Color(tokens.borderStrong) }
    public var text: Color { Color(tokens.text) }
    public var text2: Color { Color(tokens.text2) }
    public var text3: Color { Color(tokens.text3) }
    public var kbdBg: Color { Color(tokens.kbdBg) }
    public var kbdText: Color { Color(tokens.kbdText) }
    public var tagBg: Color { Color(tokens.tagBg) }
    public var danger: Color { Color(tokens.danger) }
    public var success: Color { Color(tokens.success) }
    public var warning: Color { Color(tokens.warning) }
    public var iconBg: Color { Color(tokens.iconBg) }
    public var sidebar: Color { Color(tokens.sidebar) }

    public var titleFont: Font { .system(size: tokens.fontTitle, weight: .medium) }
    public var subtitleFont: Font { .system(size: tokens.fontSubtitle) }
    public var inputFont: NSFont { .systemFont(ofSize: tokens.fontInput, weight: .regular) }
    public var sectionFont: Font { .system(size: tokens.fontSection, weight: .semibold) }
    /// nil when animations are off or rendering headless (snapshots must not catch a transition midway).
    public var animation: Animation? { tokens.animations && !opaqueBackground ? .easeOut(duration: 0.14) : nil }
}

private struct GlideThemeKey: EnvironmentKey {
    static let defaultValue = GlideTheme.default
}

public extension EnvironmentValues {
    var glideTheme: GlideTheme {
        get { self[GlideThemeKey.self] }
        set { self[GlideThemeKey.self] = newValue }
    }
}

public extension View {
    func glideTheme(_ theme: GlideTheme) -> some View {
        environment(\.glideTheme, theme).environment(\.colorScheme, theme.colorScheme).tint(theme.accent)
    }
}
