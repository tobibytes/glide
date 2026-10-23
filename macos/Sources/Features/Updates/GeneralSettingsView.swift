import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Live view of the global settings for the General page.
@MainActor @Observable final class GeneralSettingsModel {
    @ObservationIgnored let store: Store
    @ObservationIgnored weak var app: AppFeature?
    var settings: GlideCore.Settings
    var loginMessage: String?
    var newDirectory = ""
    @ObservationIgnored private var token: StoreObservation?

    init(store: Store, app: AppFeature?) {
        self.store = store
        self.app = app
        settings = store.settings
        token = store.observe { [weak self] d in Task { @MainActor in self?.settings = d.settings } }
    }

    func update(_ fn: (inout GlideCore.Settings) -> Void) {
        store.setSettings(fn)
        settings = store.settings
    }

    static let sources: [(id: String, label: String)] = [("apps", "Applications"), ("system", "System commands"), ("workflows", "Workflows"), ("quicklinks", "Quicklinks"),
                                                         ("snippets", "Snippets"), ("files", "Files"), ("calculator", "Calculator")]

    func setSource(_ id: String, enabled: Bool) {
        update { s in
            var set = Set(s.disabledSources)
            if enabled { set.remove(id) } else { set.insert(id) }
            s.disabledSources = Self.sources.map(\.id).filter { set.contains($0) } + set.subtracting(Self.sources.map(\.id)).sorted()
        }
    }

    /// Hotkey hint: a known conflict, else the usage tip.
    var hotkeyHint: (text: String, warning: Bool) {
        if let c = HotkeyAdvice.conflict(settings.hotkey), HotkeyAdvice.canonical(settings.hotkey) != "command+space" { return (c, true) }
        return ("Click the field and press a combination (⌘, ⌥, ⌃ or ⇧ plus a key).", false)
    }

    func setHotkey(_ accel: String) {
        if let c = HotkeyAdvice.conflict(accel), HotkeyAdvice.canonical(accel) != "command+space" { loginMessage = nil; hotkeyError = c; return }
        hotkeyError = nil
        update { $0.hotkey = accel }
    }
    var hotkeyError: String?
}

/// Settings → General (GeneralPage.tsx): hotkey, appearance mode, launcher behaviour, launch at login (explicit
/// toggle → SMAppService), vim mode, search, frecency half-life, sources, application folders.
struct GeneralSettingsView: View {
    @State var model: GeneralSettingsModel

    var body: some View {
        let s = model.settings
        Form {
            Section("Launcher") {
                LabeledContent("Global hotkey") {
                    VStack(alignment: .trailing, spacing: 4) {
                        HotkeyRecorderField(value: s.hotkey) { model.setHotkey($0) }.frame(width: 200, height: 26)
                        let hint = model.hotkeyError.map { ($0, true) } ?? model.hotkeyHint
                        Text(hint.0).font(.caption).foregroundStyle(hint.1 ? .orange : .secondary).multilineTextAlignment(.trailing)
                    }
                }
                Picker("Appearance", selection: Binding(get: { s.theme }, set: { v in model.update { $0.theme = v } })) {
                    Text("Match system").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                Toggle(isOn: Binding(get: { s.keepOpenAfterRun }, set: { v in model.update { $0.keepOpenAfterRun = v } })) {
                    Text("Keep open after running a command")
                    Text("Commands that open an app, file or link still close it.")
                }
                Toggle(isOn: Binding(get: { s.hideOnBlur }, set: { v in model.update { $0.hideOnBlur = v } })) {
                    Text("Hide when it loses focus")
                    Text("Clicking outside the launcher closes it.")
                }
                Toggle(isOn: Binding(get: { s.launchAtLogin }, set: { v in
                    let r = model.app?.setLaunchAtLogin(v)
                    model.loginMessage = r?.ok == false ? (r?.message ?? "Could not change the login item") : r?.message
                    model.settings = model.store.settings
                })) {
                    Text("Launch at login")
                    Text(model.loginMessage ?? "Start Glide when you log in (registered with macOS only when you flip this).")
                }
            }
            Section("Keyboard") {
                Toggle(isOn: Binding(get: { s.vimMode }, set: { v in model.update { $0.vimMode = v } })) {
                    Text("Vim mode")
                    Text("Esc enters NORMAL mode: j/k move, gg/G jump, l opens, h goes back, i types.")
                }
            }
            Section("Search") {
                Toggle("Search files", isOn: Binding(get: { s.fileSearch }, set: { v in model.update { $0.fileSearch = v } }))
                Toggle("Calculator", isOn: Binding(get: { s.calculator }, set: { v in model.update { $0.calculator = v } }))
                Stepper("Results per section: \(s.sectionLimit)", value: Binding(get: { s.sectionLimit }, set: { v in model.update { $0.sectionLimit = v } }), in: 1...30)
                LabeledContent("Usage half-life") {
                    HStack {
                        Slider(value: Binding(get: { s.frecencyHalfLifeDays }, set: { v in model.update { $0.frecencyHalfLifeDays = v.rounded() } }), in: 1...30, step: 1)
                            .frame(width: 200).accessibilityLabel("Usage half-life in days")
                        Text("\(Int(s.frecencyHalfLifeDays)) \(Int(s.frecencyHalfLifeDays) == 1 ? "day" : "days")").monospacedDigit().foregroundStyle(.secondary).frame(width: 60, alignment: .trailing)
                    }
                }
            }
            Section {
                ForEach(GeneralSettingsModel.sources, id: \.id) { src in
                    Toggle(src.label, isOn: Binding(get: { !s.disabledSources.contains(src.id) }, set: { model.setSource(src.id, enabled: $0) }))
                }
            } header: { Text("Sources") } footer: { Text("Unchecked sources are hidden from search results.") }
            Section {
                ForEach(s.appDirectories, id: \.self) { dir in
                    HStack {
                        Text(dir).font(.system(.body, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Button("Remove") { model.update { $0.appDirectories.removeAll { $0 == dir } } }.accessibilityLabel("Remove \(dir)")
                    }
                }
                HStack {
                    TextField("/path/to/folder", text: $model.newDirectory).font(.system(.body, design: .monospaced))
                        .onSubmit(addDirectory)
                    Button("Add", action: addDirectory).disabled(model.newDirectory.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } header: { Text("Applications") } footer: { Text("Folders scanned for .app bundles. Changes take effect on the next rescan.") }
        }
        .formStyle(.grouped)
    }

    private func addDirectory() {
        let v = model.newDirectory.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty, !model.settings.appDirectories.contains(v) else { return }
        model.update { $0.appDirectories.append(v) }
        model.newDirectory = ""
    }
}
