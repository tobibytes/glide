import AppKit
import GlideCore
import GlideUI
import SwiftUI

@MainActor @Observable final class ClipSettingsModel {
    @ObservationIgnored weak var feature: ClipboardFeature?
    var s: ClipSettings
    var newIgnored = ""
    var stats: ClipModel.Stats?

    init(feature: ClipboardFeature) {
        self.feature = feature
        s = feature.settings
        stats = ClipModel.stats(feature.entries, feature.settings, now: feature.now)
    }

    func commit() {
        feature?.patchSettings(s.bag)
        if let f = feature { s = f.settings; stats = ClipModel.stats(f.entries, f.settings, now: f.now) }
    }

    func retention(_ t: ClipType) -> Binding<Int> {
        Binding(get: { self.s.retentionByType[t] ?? 0 }, set: { v in
            if v > 0 { self.s.retentionByType[t] = v } else { self.s.retentionByType[t] = nil }
            self.commit()
        })
    }
}

struct ClipSettingsView: View {
    @Bindable var model: ClipSettingsModel
    private static let retentionChoices = [(1, "1 day"), (7, "7 days"), (30, "30 days"), (90, "3 months"), (365, "1 year"), (0, "Forever")]

    var body: some View {
        Form {
            Section("Recording") {
                Toggle("Record clipboard history", isOn: bind(\.enabled))
                Toggle("Paused", isOn: bind(\.paused))
                if model.s.pausedUntil > Date().timeIntervalSince1970 * 1000 {
                    LabeledContent("Timed pause") {
                        Text("until \(Date(timeIntervalSince1970: model.s.pausedUntil / 1000).formatted(date: .omitted, time: .shortened))")
                        Button("Resume") { model.s.pausedUntil = 0; model.commit() }
                    }
                }
                Toggle("Recognise text in copied images (search inside images)", isOn: bind(\.ocrImages))
            }
            Section("Retention") {
                Picker("Keep history for", selection: bind(\.retentionDays)) {
                    ForEach(Self.retentionChoices, id: \.0) { Text($0.1).tag($0.0) }
                }
                ForEach(ClipType.allCases, id: \.self) { t in
                    Picker("\(t.label)", selection: model.retention(t)) {
                        Text("Same as above").tag(0)
                        ForEach(Self.retentionChoices.filter { $0.0 > 0 }, id: \.0) { Text($0.1).tag($0.0) }
                    }
                }
                Stepper("Maximum entries: \(model.s.maxEntries)", value: bind(\.maxEntries), in: 10...100_000, step: 100)
                Stepper("Maximum images: \(model.s.maxImages)", value: bind(\.maxImages), in: 0...10_000, step: 50)
                Stepper("Image storage: \(model.s.maxImageMB) MB", value: bind(\.maxImageMB), in: 0...100_000, step: 100)
            }
            Section("Ignored apps (never recorded)") {
                ForEach(model.s.ignoredApps, id: \.self) { b in
                    HStack {
                        Text(b).font(.system(.body, design: .monospaced))
                        Spacer()
                        Button(role: .destructive) { model.s.ignoredApps.removeAll { $0 == b }; model.commit() } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                    }
                }
                HStack {
                    TextField("Bundle id, e.g. com.apple.Terminal", text: $model.newIgnored).onSubmit(addIgnored)
                    Button("Add", action: addIgnored).disabled(model.newIgnored.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            Section("Paste Stack") {
                Picker("Paste order", selection: bind(\.stackOrder)) {
                    Text("First copied first (FIFO)").tag(StackOrder.fifo)
                    Text("Last copied first (LIFO)").tag(StackOrder.lifo)
                }
                Toggle("⌘V pastes the next item while the stack has items", isOn: bind(\.stackInterceptPaste))
            }
            Section("Hotkeys") {
                TextField("Open Clipboard History (e.g. Command+Shift+V)", text: $model.s.hotkey).onSubmit { model.commit() }
                TextField("Paste Next from Stack", text: $model.s.stackHotkey).onSubmit { model.commit() }
                if model.feature?.hotkeyOk == false || model.feature?.stackHotkeyOk == false {
                    Text("A hotkey could not be registered.").foregroundStyle(.red)
                }
            }
            if let st = model.stats {
                Section("History") {
                    LabeledContent("Entries", value: "\(st.total) (\(st.pinned) pinned)")
                    LabeledContent("Images", value: "\(st.byType[.image] ?? 0) · \(ByteCountFormatter.string(fromByteCount: Int64(st.imageBytes), countStyle: .file))")
                    Button("Clear Unpinned History", role: .destructive) { _ = model.feature?.clearHistory(keepPinned: true); model.commit() }
                }
            }
        }
        .formStyle(.grouped)
    }

    private func addIgnored() {
        let b = model.newIgnored.trimmingCharacters(in: .whitespaces)
        guard !b.isEmpty, !model.s.ignoredApps.contains(b) else { return }
        model.s.ignoredApps.append(b)
        model.newIgnored = ""
        model.commit()
    }

    private func bind<T>(_ kp: WritableKeyPath<ClipSettings, T>) -> Binding<T> {
        Binding(get: { model.s[keyPath: kp] }, set: { v in model.s[keyPath: kp] = v; model.commit() })
    }
}
