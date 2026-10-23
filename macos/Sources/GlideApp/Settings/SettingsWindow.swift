import AppKit
import GlideCore
import GlideFeatures
import GlideSystem
import GlideUI
import SwiftUI

/// Settings window shell: sidebar with General, Appearance, every FeatureUI.settingsPage (sorted by order), About.
@MainActor final class SettingsWindowController {
    let window: NSWindow
    let model: SettingsModel

    init(core: AppCore) {
        model = SettingsModel(core: core)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 560), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: true)
        window.title = "Glide Settings"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SettingsRoot(model: model))
        window.center()
    }

    func show(page: String?) {
        if let page { model.route(page) }
        NSApp.activate(ignoringOtherApps: true) // Settings is a normal, activating window
        window.makeKeyAndOrderFront(nil)
    }
}

@MainActor @Observable final class SettingsModel {
    @ObservationIgnored let core: AppCore
    var selection: String? = "general"
    var settings: GlideCore.Settings
    @ObservationIgnored private var token: StoreObservation?

    init(core: AppCore) {
        self.core = core
        settings = core.store.settings
        token = core.store.observe { [weak self] d in Task { @MainActor in self?.settings = d.settings } }
    }

    var featurePages: [SettingsPage] {
        core.registry.features.compactMap { ($0 as? any FeatureUI)?.settingsPage }.filter { !Self.corePageIds.contains($0.id) }.sorted { ($0.order, $0.title) < ($1.order, $1.title) }
    }

    /// N8: General is drawn by the "app" feature and Appearance by the "appearance" feature (fallbacks below).
    static let corePageIds: Set<String> = ["general", "appearance"]
    var featureGeneralPage: AnyView? { (core.registry.feature("app") as? AppFeature)?.generalPage() }
    var featureAppearancePage: AnyView? { (core.registry.feature("appearance") as? any FeatureUI)?.settingsPage?.view() }

    /// Select `<id>` and deliver the sub-route of "<id>/<route>" / "<id>#<route>" to that page's `onRoute`.
    func route(_ page: String) {
        let (pid, sub) = SettingsPage.split(page)
        selection = pid.isEmpty ? "general" : pid
        if let sub { Self.deliver(core: core, page: pid, route: sub) }
    }

    static func deliver(core: AppCore, page: String, route: String) {
        let p = core.registry.features.lazy.compactMap { ($0 as? any FeatureUI)?.settingsPage }.first { $0.id == page }
        p?.onRoute?(route)
    }

    func update(_ fn: (inout GlideCore.Settings) -> Void) { core.store.setSettings(fn) }
    func appearance(_ key: String, _ value: JSONValue) { core.store.setFeatureSettings(AppearanceSettings.featureId, [key: value]) }
    var appearanceSettings: AppearanceSettings { AppearanceSettings(bag: settings.features[AppearanceSettings.featureId] ?? [:]) }
}

struct SettingsRoot: View {
    @Bindable var model: SettingsModel
    var body: some View {
        NavigationSplitView {
            List(selection: $model.selection) {
                Label("General", systemImage: "gearshape").tag("general")
                Label("Appearance", systemImage: "paintpalette").tag("appearance")
                Section("Features") {
                    ForEach(model.featurePages) { p in Label(p.title, systemImage: p.symbol).tag(p.id) }
                }
                Label("About", systemImage: "info.circle").tag("about")
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210)
        } detail: {
            Group {
                switch model.selection ?? "general" {
                case "general": model.featureGeneralPage ?? AnyView(GeneralPage(model: model))
                case "appearance": model.featureAppearancePage ?? AnyView(AppearancePage(model: model))
                case "about": AboutPage()
                case let id: model.featurePages.first { $0.id == id }.map { $0.view() } ?? AnyView(Text("Nothing here yet").foregroundStyle(.secondary))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct GeneralPage: View {
    let model: SettingsModel
    var body: some View {
        let s = model.settings
        Form {
            Section("Launcher") {
                LabeledContent("Hotkey") {
                    HotkeyRecorder(accelerator: s.hotkey) { v in model.update { $0.hotkey = v } }
                }
                Picker("Theme", selection: Binding(get: { s.theme }, set: { v in model.update { $0.theme = v } })) {
                    Text("System").tag("system")
                    Text("Dark").tag("dark")
                    Text("Light").tag("light")
                }
                Toggle("Vim mode", isOn: Binding(get: { s.vimMode }, set: { v in model.update { $0.vimMode = v } }))
                Toggle("Hide when focus is lost", isOn: Binding(get: { s.hideOnBlur }, set: { v in model.update { $0.hideOnBlur = v } }))
                Toggle("Keep open after running", isOn: Binding(get: { s.keepOpenAfterRun }, set: { v in model.update { $0.keepOpenAfterRun = v } }))
                Toggle("Calculator", isOn: Binding(get: { s.calculator }, set: { v in model.update { $0.calculator = v } }))
                Stepper("Results per section: \(s.sectionLimit)", value: Binding(get: { s.sectionLimit }, set: { v in model.update { $0.sectionLimit = v } }), in: 3...20)
            }
        }
        .formStyle(.grouped)
    }
}

struct AppearancePage: View {
    let model: SettingsModel
    var body: some View {
        let a = model.appearanceSettings
        Form {
            Section("Themes") {
                Picker("Dark theme", selection: Binding(get: { a.darkTheme }, set: { model.appearance("darkTheme", .string($0)) })) {
                    ForEach(Themes.presets.filter { $0.scheme == .dark }) { Text($0.name).tag($0.id) }
                }
                Picker("Light theme", selection: Binding(get: { a.lightTheme }, set: { model.appearance("lightTheme", .string($0)) })) {
                    ForEach(Themes.presets.filter { $0.scheme == .light }) { Text($0.name).tag($0.id) }
                }
                Picker("Density", selection: Binding(get: { a.density.rawValue }, set: { model.appearance("density", .string($0)) })) {
                    Text("Comfortable").tag("comfortable")
                    Text("Compact").tag("compact")
                }
                Toggle("Vibrancy", isOn: Binding(get: { a.vibrancy }, set: { model.appearance("vibrancy", .bool($0)) }))
                Toggle("Animations", isOn: Binding(get: { a.animations }, set: { model.appearance("animations", .bool($0)) }))
            }
        }
        .formStyle(.grouped)
    }
}

struct AboutPage: View {
    @Environment(\.openURL) private var openURL
    static let repo = URL(string: "https://github.com/tobibytes/glide")!
    static let author = URL(string: "https://github.com/tobibytes")!

    private var version: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "dev"
        let b = info?["CFBundleVersion"] as? String
        return b.map { $0 == v ? "Version \(v)" : "Version \(v) (\($0))" } ?? "Version \(v)"
    }

    var body: some View {
        VStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 96, height: 96)
            Text("Glide").font(.largeTitle.bold())
            Text(version).foregroundStyle(.secondary).textSelection(.enabled)
            Text("A keyboard-first launcher for macOS").foregroundStyle(.secondary)
            HStack(spacing: 4) {
                Text("Built by")
                Link("tobibytes", destination: Self.author).fontWeight(.semibold)
            }
            .padding(.top, 4)
            HStack(spacing: 10) {
                Button { openURL(Self.repo) } label: { Label("GitHub", systemImage: "chevron.left.forwardslash.chevron.right") }
                Button { openURL(Self.repo.appendingPathComponent("issues/new")) } label: { Label("Report an Issue", systemImage: "exclamationmark.bubble") }
            }
            .padding(.top, 6)
            Text("Open source · MIT License · © 2026 tobibytes").font(.caption).foregroundStyle(.tertiary).padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Launcher hotkey field: click (or focus + Space) to record the next key combination, or type an Electron-style
/// accelerator ("Alt+Space", "⌥Space", "Double+Cmd"). Validated with GlideSystem's HotkeyParser; the launcher
/// re-registers through `LauncherController.registerHotkeys()` when data.json changes.
struct HotkeyRecorder: View {
    let accelerator: String
    let onChange: (String) -> Void
    @State private var recording = false
    @State private var text = ""
    @State private var error: String?
    @State private var monitor: Any?

    var body: some View {
        HStack(spacing: 8) {
            Button {
                recording ? stop() : start()
            } label: {
                Label(recording ? "Press a shortcut…" : Accelerator.display(accelerator), systemImage: recording ? "record.circle" : "keyboard")
                    .font(.system(.body, design: .rounded))
                    .frame(minWidth: 120)
            }
            .help("Record the launcher hotkey (Esc cancels)")
            TextField("Accelerator", text: $text, prompt: Text("Alt+Space"))
                .labelsHidden()
                .frame(width: 130)
                .onSubmit { commit(text) }
            if let error { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).help(error) }
        }
        .onAppear { text = accelerator }
        .onChange(of: accelerator) { _, v in text = v }
        .onDisappear { stop() }
    }

    private func commit(_ raw: String) {
        switch HotkeyParser.parse(raw) {
        case let .success(spec):
            error = nil
            let canonical = HotkeyParser.canonical(spec)
            text = canonical
            onChange(canonical)
        case let .failure(e):
            error = e.localizedDescription
        }
    }

    private func start() {
        recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            if e.keyCode == 53 && e.modifierFlags.intersection(.deviceIndependentFlagsMask).isEmpty { stop(); return nil }
            if let accel = Self.accelerator(from: e) { commit(accel); stop() }
            return nil
        }
    }

    private func stop() {
        recording = false
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// NSEvent → "Cmd+Shift+K" style accelerator (nil for a bare key without modifiers, except F-keys).
    static func accelerator(from e: NSEvent) -> String? {
        let f = e.modifierFlags
        var parts: [String] = []
        if f.contains(.control) { parts.append("Ctrl") }
        if f.contains(.option) { parts.append("Alt") }
        if f.contains(.shift) { parts.append("Shift") }
        if f.contains(.command) { parts.append("Cmd") }
        let named: [UInt16: String] = [49: "Space", 36: "Return", 48: "Tab", 51: "Backspace", 117: "Delete", 123: "Left", 124: "Right",
                                       125: "Down", 126: "Up", 115: "Home", 119: "End", 116: "PageUp", 121: "PageDown",
                                       122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8",
                                       101: "F9", 109: "F10", 103: "F11", 111: "F12"]
        let key: String
        if let n = named[e.keyCode] { key = n } else if let c = e.charactersIgnoringModifiers?.uppercased(), c.count == 1 { key = c == "+" ? "Plus" : c } else { return nil }
        if parts.isEmpty && !key.hasPrefix("F") { return nil }
        return (parts + [key]).joined(separator: "+")
    }
}

/// Offscreen render of the Settings shell for the test channel (`{"cmd":"snapshot","target":"settings"}`).
@MainActor enum SettingsSnapshot {
    static func render(core: AppCore, page: String?, to url: URL) throws -> NSSize {
        let model = SettingsModel(core: core)
        if let page { model.route(page) }
        let view = NSHostingView(rootView: SettingsRoot(model: model).frame(width: 820, height: 560).background(Color(nsColor: .windowBackgroundColor)))
        view.frame = NSRect(x: 0, y: 0, width: 820, height: 560)
        view.appearance = NSAppearance(named: .darkAqua)
        view.layoutSubtreeIfNeeded()
        // Two run-loop passes so NavigationSplitView settles.
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { throw FeatureError.failed("no bitmap") }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw FeatureError.failed("png encoding failed") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
        return NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    }
}
