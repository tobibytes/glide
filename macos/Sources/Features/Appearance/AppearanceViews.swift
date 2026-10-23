import AppKit
import GlideCore
import GlideUI
import SwiftUI

// MARK: - preview pieces (Preview.tsx)

/// A miniature launcher painted with `preset` + the user's adjustments (theme cards and the live preview).
public struct MiniLauncher: View {
    let theme: GlideTheme
    let large: Bool
    public init(preset: ThemePreset, settings: AppearanceSettings, large: Bool = false) {
        theme = GlideTheme(tokens: Themes.tokens(preset, settings), opaqueBackground: true)
        self.large = large
    }

    private static let rows: [(symbol: String, title: String, sub: String, kind: String)] = [
        ("safari", "Safari", "Application", "App"),
        ("sun.max", "Morning Setup", "Open Calendar and Notes", "Workflow"),
        ("doc.on.clipboard", "Clipboard History", "42 items", "Clipboard"),
    ]

    public var body: some View {
        let t = theme.tokens
        let s: CGFloat = large ? 1 : 0.62
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4 * s) {
                Rectangle().fill(theme.accent).frame(width: 2, height: 16 * s)
                (Text("Sa").foregroundColor(theme.accentText).bold() + Text("fari").foregroundColor(theme.text))
                    .font(.system(size: t.fontInput * 0.8 * s))
                Spacer()
            }
            .padding(.horizontal, 12 * s)
            .frame(height: t.headHeight * 0.75 * s)
            Rectangle().fill(theme.border).frame(height: 1)
            Text("Results").font(.system(size: t.fontSection * s, weight: .semibold)).foregroundStyle(theme.text3)
                .padding(.horizontal, 12 * s).padding(.top, 6 * s).padding(.bottom, 2 * s)
            ForEach(Array(Self.rows.prefix(large ? 3 : 2).enumerated()), id: \.offset) { i, r in
                HStack(spacing: 8 * s) {
                    Image(systemName: r.symbol).font(.system(size: 12 * s)).foregroundStyle(theme.text2)
                        .frame(width: t.iconSize * 0.8 * s, height: t.iconSize * 0.8 * s)
                        .background(RoundedRectangle(cornerRadius: 5 * s).fill(theme.iconBg))
                    Text(r.title).font(.system(size: t.fontTitle * s, weight: .medium)).foregroundStyle(theme.text).lineLimit(1)
                    if large { Text(r.sub).font(.system(size: t.fontSubtitle * s)).foregroundStyle(theme.text3).lineLimit(1) }
                    Spacer(minLength: 4)
                    Text(r.kind).font(.system(size: (t.fontSubtitle - 1) * s)).foregroundStyle(theme.text3)
                }
                .padding(.horizontal, 8 * s)
                .frame(height: t.rowHeight * 0.8 * s)
                .background(RoundedRectangle(cornerRadius: t.rowRadius * s, style: .continuous).fill(i == 0 ? theme.selected : .clear))
                .padding(.horizontal, 4 * s)
            }
            if large {
                Spacer(minLength: 4)
                Rectangle().fill(theme.border).frame(height: 1)
                HStack(spacing: 6) {
                    Circle().fill(theme.accent).frame(width: 6, height: 6)
                    Spacer()
                    Text("Open Application").font(.system(size: 11)).foregroundStyle(theme.text2)
                    Kbd("⏎")
                    Rectangle().fill(theme.border).frame(width: 1, height: 12)
                    Text("Actions").font(.system(size: 11)).foregroundStyle(theme.text2)
                    Kbd("⌘K")
                }
                .padding(.horizontal, 10).frame(height: 28)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(theme.panelSolid)
        .clipShape(RoundedRectangle(cornerRadius: t.radius * s, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: t.radius * s, style: .continuous).strokeBorder(theme.borderStrong, lineWidth: 1))
        .glideTheme(theme)
        .accessibilityHidden(true)
    }
}

public struct Swatches: View {
    let preset: ThemePreset
    let accent: String
    public init(preset: ThemePreset, accent: String = "") {
        self.preset = preset
        self.accent = accent
    }
    public var body: some View {
        HStack(spacing: 0) {
            ForEach([preset.bg, preset.surface2, preset.text3, preset.text, accent.isEmpty ? preset.accent : accent], id: \.self) { hex in
                Rectangle().fill(Color(RGBA(hex: hex) ?? .black))
            }
        }
        .frame(width: 60, height: 14)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .accessibilityHidden(true)
    }
}

// MARK: - Switch Theme (launcher view "appearance.switch")

/// State of the pushed Switch Theme view; the feature's handleKey drives it (j/k move + live preview).
@MainActor @Observable public final class ThemeSwitcherModel {
    public var selectedIndex = 0
    /// The theme that was active when the view opened (stays first in the list).
    public var activeId: String
    public var query = ""
    public init(activeId: String) { self.activeId = activeId }
    public var rows: [ThemeSwitcher.Row] { ThemeSwitcher.rows(query: query, activeId: activeId) }
    public var selected: ThemeSwitcher.Row? { rows.indices.contains(selectedIndex) ? rows[selectedIndex] : rows.first }
    public func move(_ d: Int) {
        let n = rows.count
        guard n > 0 else { return }
        selectedIndex = min(n - 1, max(0, selectedIndex + d))
    }
}

struct ThemeSwitchView: View {
    @Environment(\.glideTheme) private var theme
    let model: ThemeSwitcherModel
    let settings: AppearanceSettings
    let darkSlot: String
    let lightSlot: String
    let host: LauncherViewHost

    var body: some View {
        // Reading host.query here subscribes this view to the launcher's query (Observation).
        let q = host.query
        let _ = syncQuery(q)
        let rows = model.rows
        DetailSplit(ratio: 0.46) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.preset.id) { i, r in
                            if i == 0 || rows[i - 1].section != r.section { SectionHeader(r.section) }
                            row(r, selected: i == model.selectedIndex).id(r.preset.id)
                        }
                        if rows.isEmpty { EmptyState(symbol: "paintpalette", title: "No theme matches") }
                    }
                    .padding(.horizontal, CGFloat(theme.tokens.listPadding.h)).padding(.vertical, 6)
                }
                .onChange(of: model.selectedIndex) { _, i in if rows.indices.contains(i) { proxy.scrollTo(rows[i].preset.id) } }
            }
        } detail: {
            if let r = model.selected {
                VStack(alignment: .leading, spacing: 12) {
                    MiniLauncher(preset: r.preset, settings: settings, large: true).frame(height: 230)
                    Text(r.preset.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
                    Text("\(r.preset.scheme == .dark ? "Dark" : "Light") theme · ⏎ apply · ⌘⏎ only set the \(r.preset.scheme.rawValue) slot · ⌘T toggle light/dark · ⌘Y follow system")
                        .font(.system(size: 12)).foregroundStyle(theme.text3).fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
            }
        }
    }

    private func syncQuery(_ q: String) {
        if model.query != q {
            DispatchQueue.main.async {
                model.query = q
                model.selectedIndex = 0
            }
        }
    }

    private func row(_ r: ThemeSwitcher.Row, selected: Bool) -> some View {
        HStack(spacing: 10) {
            Circle().fill(Color(RGBA(hex: settings.accent.isEmpty ? r.preset.accent : settings.accent) ?? .white)).frame(width: 14, height: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(r.preset.name).font(theme.titleFont).foregroundStyle(theme.text)
                Text(r.preset.scheme == .dark ? "Dark" : "Light").font(theme.subtitleFont).foregroundStyle(theme.text3)
            }
            Spacer()
            if r.preset.id == darkSlot { Tag("Dark slot") }
            if r.preset.id == lightSlot { Tag("Light slot") }
            if r.preset.id == model.activeId { Tag("Active", accent: true) }
        }
        .padding(.horizontal, 10)
        .frame(height: theme.tokens.rowHeight)
        .background(RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous).fill(selected ? theme.selected : .clear))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Settings page (AppearancePage.tsx)

@MainActor @Observable final class AppearancePageModel {
    @ObservationIgnored let appearance: AppearanceStore
    var settings: AppearanceSettings
    var material: VibrancyMaterial
    var mode: String
    var systemDark: Bool
    @ObservationIgnored private var token: StoreObservation?

    init(appearance: AppearanceStore) {
        self.appearance = appearance
        settings = appearance.settings
        material = appearance.material
        mode = appearance.mode
        systemDark = appearance.systemDark()
        token = appearance.store.observe { [weak self] _ in Task { @MainActor in self?.reload() } }
    }

    func reload() {
        settings = appearance.settings
        material = appearance.material
        mode = appearance.mode
        systemDark = appearance.systemDark()
    }

    var active: ThemePreset { Themes.resolve(mode: mode, systemDark: systemDark, settings: settings) }
    func patch(_ p: [String: JSONValue]) {
        appearance.set(p)
        reload()
    }
}

struct AppearanceSettingsView: View {
    @State var model: AppearancePageModel
    @FocusState private var focusedGrid: String?

    var body: some View {
        let s = model.settings
        Form {
            Section {
                HStack(alignment: .top, spacing: 16) {
                    MiniLauncher(preset: model.active, settings: s, large: true).frame(width: 340, height: 220)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(model.active.name).font(.headline)
                        Text(model.mode == "system" ? "Following the system (\(model.systemDark ? "dark" : "light"))" : "Always \(model.mode)")
                            .foregroundStyle(.secondary)
                        Text("Every change applies live. Tab between controls; in a theme grid h/j/k/l or the arrows move. From the launcher, “Switch Theme” previews themes as you move with j/k.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 4)
            }
            Section("Theme") {
                Picker("Appearance", selection: Binding(get: { model.mode }, set: { model.appearance.setMode($0); model.reload() })) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.segmented)
                themeGrid("Dark theme", key: "darkTheme", value: s.darkTheme, presets: Themes.presets.filter { $0.scheme == .dark } + Themes.presets.filter { $0.scheme == .light })
                themeGrid("Light theme", key: "lightTheme", value: s.lightTheme, presets: Themes.presets.filter { $0.scheme == .light } + Themes.presets.filter { $0.scheme == .dark })
            }
            Section("Accent") {
                LabeledContent("Accent color") {
                    HStack(spacing: 6) {
                        Button { model.patch(["accent": ""]) } label: {
                            Text("A").font(.caption.bold()).frame(width: 20, height: 20)
                                .overlay(Circle().strokeBorder(s.accent.isEmpty ? Color.accentColor : .secondary, lineWidth: s.accent.isEmpty ? 2 : 1))
                        }
                        .buttonStyle(.plain).help("Theme default").accessibilityLabel("Theme default accent")
                        ForEach(AppearanceStore.presetAccents, id: \.self) { hex in
                            Button { model.patch(["accent": .string(hex)]) } label: {
                                Circle().fill(Color(RGBA(hex: hex) ?? .white)).frame(width: 20, height: 20)
                                    .overlay(Circle().strokeBorder(.primary, lineWidth: s.accent == hex ? 2 : 0))
                            }
                            .buttonStyle(.plain).accessibilityLabel(hex)
                        }
                        ColorPicker("Custom", selection: Binding(get: { Color(RGBA(hex: s.accent.isEmpty ? model.active.accent : s.accent) ?? .white) },
                                                                 set: { c in if let hex = Self.hex(c) { model.patch(["accent": .string(hex)]) } }), supportsOpacity: false)
                            .labelsHidden()
                    }
                }
            }
            Section("Layout") {
                Picker("Density", selection: Binding(get: { s.density.rawValue }, set: { model.patch(["density": .string($0)]) })) {
                    Text("Compact").tag("compact")
                    Text("Comfortable").tag("comfortable")
                }
                .pickerStyle(.segmented)
                slider("Text size", value: s.fontSize, range: AppearanceSettings.limits.fontSize, unit: " pt", key: "fontSize")
                slider("Corner radius", value: s.radius, range: AppearanceSettings.limits.radius, unit: " pt", key: "radius")
                slider("Launcher width", value: s.width, range: AppearanceSettings.limits.width, unit: " pt", key: "width", step: 10)
            }
            Section {
                slider("Translucency", value: s.translucency, range: AppearanceSettings.limits.translucency, unit: "%", key: "translucency")
                Toggle("Vibrancy", isOn: Binding(get: { s.vibrancy }, set: { model.patch(["vibrancy": .bool($0)]) }))
                Picker("Material", selection: Binding(get: { model.material.rawValue }, set: { model.patch(["material": .string($0)]) })) {
                    ForEach(VibrancyMaterial.allCases) { Text($0.title).tag($0.rawValue) }
                }
                .disabled(!s.vibrancy || s.translucency == 0)
                Toggle("Animations", isOn: Binding(get: { s.animations }, set: { model.patch(["animations": .bool($0)]) }))
            } header: { Text("Window") } footer: {
                Text("Vibrancy blurs the desktop behind the launcher with the chosen NSVisualEffectView material. With translucency at 0 the panel is opaque and vibrancy is off. Animations are always off when “Reduce motion” is on.")
            }
            Section {
                Button("Reset to Defaults") { model.appearance.reset(); model.reload() }
                    .disabled(model.appearance.isDefault)
            }
        }
        .formStyle(.grouped)
    }

    private func slider(_ title: String, value: Int, range: ClosedRange<Int>, unit: String, key: String, step: Double = 1) -> some View {
        LabeledContent(title) {
            HStack {
                Slider(value: Binding(get: { Double(value) }, set: { model.patch([key: .int(Int64(($0 / step).rounded() * step))]) }),
                       in: Double(range.lowerBound)...Double(range.upperBound), step: step)
                    .frame(width: 220)
                    .accessibilityLabel(title)
                Text("\(value)\(unit)").monospacedDigit().frame(width: 60, alignment: .trailing).foregroundStyle(.secondary)
            }
        }
    }

    private func themeGrid(_ title: String, key: String, value: String, presets: [ThemePreset]) -> some View {
        let cols = 3
        return VStack(alignment: .leading, spacing: 6) {
            Text(title)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: cols), spacing: 10) {
                ForEach(presets) { p in
                    Button { model.patch([key: .string(p.id)]) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            MiniLauncher(preset: p, settings: model.settings).frame(height: 78)
                            HStack {
                                Text(p.name).font(.caption.weight(.medium))
                                Spacer()
                                Text(p.scheme == .dark ? "Dark" : "Light").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .padding(4)
                        .background(RoundedRectangle(cornerRadius: 10).strokeBorder(p.id == value ? Color.accentColor : .clear, lineWidth: 2))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(title): \(p.name)")
                    .accessibilityAddTraits(p.id == value ? .isSelected : [])
                }
            }
            .focusable()
            .focused($focusedGrid, equals: key)
            .onKeyPress { press in
                // Roving selection like a macOS radio group: ←/→/↑/↓ and h/j/k/l.
                let step: [String: Int] = ["l": 1, "h": -1, "j": cols, "k": -cols]
                var d: Int?
                switch press.key {
                case .rightArrow: d = 1
                case .leftArrow: d = -1
                case .downArrow: d = cols
                case .upArrow: d = -cols
                default: d = step[press.characters]
                }
                guard let d, press.modifiers.isEmpty || press.modifiers == .numericPad || press.modifiers == .function else { return .ignored }
                let i = presets.firstIndex { $0.id == value } ?? 0
                let next = presets[min(presets.count - 1, max(0, i + d))]
                model.patch([key: .string(next.id)])
                return .handled
            }
        }
    }

    static func hex(_ c: Color) -> String? {
        guard let ns = NSColor(c).usingColorSpace(.sRGB) else { return nil }
        return RGBA(Double(ns.redComponent * 255), Double(ns.greenComponent * 255), Double(ns.blueComponent * 255)).hex
    }
}
