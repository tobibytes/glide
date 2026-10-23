import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// The tour window's content (OnboardingWindow.tsx + Steps.tsx), themed with the active Glide preset.
struct OnboardingRootView: View {
    let model: OnboardingModel
    let actions: OnboardingFeature
    var snapshot = false

    private var theme: GlideTheme {
        let p = Themes.preset(model.activeThemeId) ?? Themes.presets[0]
        return GlideTheme(tokens: Themes.tokens(p, AppearanceSettings()), opaqueBackground: true)
    }

    var body: some View {
        let t = theme
        VStack(spacing: 0) {
            header
            Divider().overlay(t.border)
            Group {
                switch model.flow.step {
                case .welcome: WelcomeStep()
                case .hotkey: HotkeyStep(model: model, actions: actions)
                case .permissions: PermissionsStep(model: model, actions: actions)
                case .ai: AIStep(model: model, actions: actions)
                case .look: LookStep(model: model, actions: actions)
                case .done: DoneStep(hotkey: model.hotkey)
                }
            }
            .padding(.horizontal, 36)
            .padding(.vertical, 22)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            Divider().overlay(t.border)
            footer
        }
        .frame(width: 720, height: 560)
        .background(t.panelSolid)
        .glideTheme(t)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Welcome to Glide")
    }

    private var header: some View {
        HStack(spacing: 6) {
            ForEach(OnboardingStep.allCases, id: \.self) { s in
                Button { actions.dispatch(.goto(s)) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Capsule().fill(s.index <= model.flow.step.index ? theme.accent : theme.border).frame(height: 3)
                        Text(s.label).font(.system(size: 11, weight: s == model.flow.step ? .semibold : .regular))
                            .foregroundStyle(s == model.flow.step ? theme.text : theme.text3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Step \(s.index + 1): \(s.label)")
                .accessibilityAddTraits(s == model.flow.step ? .isSelected : [])
            }
            Button("Skip setup") { actions.dispatch(.skip) }
                .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(theme.text3).padding(.leading, 12)
        }
        .padding(.horizontal, 24)
        .padding(.top, snapshot ? 18 : 34) // room for the traffic lights in the window
        .padding(.bottom, 12)
    }

    private var footer: some View {
        HStack(spacing: 14) {
            HStack(spacing: 4) { Kbd("⇥"); Text("move") }
            if model.flow.step != .welcome { HStack(spacing: 4) { Kbd("⌘["); Text("back") } }
            HStack(spacing: 4) { Kbd("j"); Kbd("k"); Text("lists") }
            Spacer()
            if model.flow.step.index > 0 {
                Button("Back") { actions.dispatch(.back) }.keyboardShortcut("[", modifiers: .command)
            }
            Button { actions.dispatch(.next) } label: { HStack(spacing: 6) { Text(model.flow.step.primaryLabel); Text("⏎").opacity(0.7) } }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return, modifiers: .command)
        }
        .font(.system(size: 11))
        .foregroundStyle(theme.text3)
        .padding(.horizontal, 24)
        .frame(height: 52)
    }
}

private struct StepTitle: View {
    @Environment(\.glideTheme) private var theme
    let eyebrow: String
    let title: String
    let lead: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(eyebrow.uppercased()).font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.accentText).tracking(0.6)
            Text(title).font(.system(size: 24, weight: .bold)).foregroundStyle(theme.text)
            Text(lead).font(.system(size: 13)).foregroundStyle(theme.text2).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 14)
    }
}

private struct StatusLine: View {
    @Environment(\.glideTheme) private var theme
    let message: (ok: Bool, text: String)?
    let fallback: String
    var body: some View {
        Text(message?.text ?? fallback)
            .font(.system(size: 12))
            .foregroundStyle(message.map { $0.ok ? theme.success : theme.danger } ?? theme.text3)
            .accessibilityAddTraits(.updatesFrequently)
            .padding(.top, 10)
    }
}

private struct WelcomeStep: View {
    @Environment(\.glideTheme) private var theme
    private let highlights: [(String, String, String)] = [
        ("bolt.fill", "One search for everything", "Apps, files, clipboard history, snippets, calculator, windows and your own workflows."),
        ("keyboard", "Keyboard-first, vim-friendly", "Every screen works without a mouse. j/k, gg/G and ⌘K actions everywhere."),
        ("sparkles", "Automate and ask AI", "Build workflows, run Raycast-style extensions and ask Claude about anything you select."),
    ]
    var body: some View {
        VStack(spacing: 14) {
            Text("G").font(.system(size: 34, weight: .heavy)).foregroundStyle(theme.accentContrast)
                .frame(width: 64, height: 64).background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(theme.accent))
            Text("Welcome to Glide").font(.system(size: 28, weight: .bold)).foregroundStyle(theme.text)
            Text("A keyboard-first launcher for your Mac. Press a shortcut, type a few letters, hit return.")
                .font(.system(size: 14)).foregroundStyle(theme.text2).multilineTextAlignment(.center)
            HStack(alignment: .top, spacing: 12) {
                ForEach(highlights, id: \.1) { h in
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: h.0).font(.system(size: 18)).foregroundStyle(theme.accent)
                        Text(h.1).font(.system(size: 13, weight: .semibold)).foregroundStyle(theme.text)
                        Text(h.2).font(.system(size: 12)).foregroundStyle(theme.text3).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.surface2.opacity(0.6)))
                }
            }
            .padding(.top, 8)
            Text("Takes about a minute. Everything here can be changed later in Settings.").font(.system(size: 12)).foregroundStyle(theme.text3)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct OptionRow<Trailing: View>: View {
    @Environment(\.glideTheme) private var theme
    let checked: Bool
    let focused: Bool
    let keys: String
    let title: String
    let detail: String
    let action: () -> Void
    @ViewBuilder var trailing: Trailing
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: checked ? "largecircle.fill.circle" : "circle").foregroundStyle(checked ? theme.accent : theme.text3)
                Text(keys).font(.system(size: 13, weight: .semibold, design: .rounded)).foregroundStyle(theme.text)
                    .frame(minWidth: 70).padding(.vertical, 4).background(RoundedRectangle(cornerRadius: 6).fill(theme.kbdBg))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text)
                    Text(detail).font(.system(size: 12)).foregroundStyle(theme.text3).fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                trailing
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(focused ? theme.selected : theme.surface2.opacity(0.35)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(focused ? theme.accent.opacity(0.7) : theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(checked ? .isSelected : [])
    }
}

private struct HotkeyStep: View {
    let model: OnboardingModel
    let actions: OnboardingFeature
    var body: some View {
        let current = model.hotkeyChoice
        VStack(alignment: .leading, spacing: 8) {
            StepTitle(eyebrow: "Step 1 · Hotkey", title: "Summon Glide from anywhere", lead: "Pick the shortcut that opens the launcher. You'll press it dozens of times a day, so make it comfortable.")
            OptionRow(checked: current == .alt, focused: model.listIndex == 0, keys: "⌥ Space", title: "Option + Space", detail: "Recommended. Works alongside Spotlight.",
                      action: { model.listIndex = 0; actions.activateListItem(continueAfter: false) }) { EmptyView() }
            OptionRow(checked: current == .cmd, focused: model.listIndex == 1, keys: "⌘ Space", title: "Use ⌘Space (replace Spotlight)",
                      detail: "Turns off Spotlight's ⌘Space shortcut so Glide can use it. Undo any time in Settings → Keyboard.",
                      action: { model.listIndex = 1; actions.activateListItem(continueAfter: false) }) { EmptyView() }
            OptionRow(checked: current == .custom, focused: model.listIndex == 2, keys: current == .custom ? Accelerator.display(model.hotkey) : "…", title: "Record your own",
                      detail: "Focus the recorder and press any combination with a modifier.", action: { model.listIndex = 2 }) {
                HotkeyRecorderField(value: current == .custom ? model.hotkey : nil, placeholder: "Click or Tab here, then press keys") { actions.record($0) }
                    .frame(width: 210, height: 26)
            }
            StatusLine(message: model.hotkeyMessage, fallback: "Glide currently opens with \(Accelerator.display(model.hotkey)).")
        }
    }
}

private struct PermissionsStep: View {
    @Environment(\.glideTheme) private var theme
    let model: OnboardingModel
    let actions: OnboardingFeature
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            StepTitle(eyebrow: "Step 2 · Permissions", title: "Grant only what you'll use",
                      lead: "Everything is optional. Glide works without these; features that need one will tell you. Status updates live.")
            ForEach(Array(OnboardingPermission.allCases.enumerated()), id: \.element) { i, kind in
                let status = model.permissions?.status[kind] ?? .unknown
                HStack(spacing: 12) {
                    Image(systemName: kind.symbol).font(.system(size: 16)).foregroundStyle(theme.text2).frame(width: 26)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(kind.title).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text)
                        Text(kind.why).font(.system(size: 11.5)).foregroundStyle(theme.text3).lineLimit(2)
                    }
                    Spacer()
                    Text(status.pill).font(.system(size: 11, weight: .medium))
                        .foregroundStyle(status == .granted ? theme.success : status == .denied ? theme.danger : theme.text3)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill((status == .granted ? theme.success : status == .denied ? theme.danger : theme.text3).opacity(0.14)))
                    Button("Open Settings") { model.listIndex = i; Task { await actions.openPermissionSettings(kind) } }
                        .controlSize(.small)
                        .accessibilityLabel("Open System Settings for \(kind.title)")
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(model.listIndex == i ? theme.selected : .clear))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(kind.title): \(status.pill)")
            }
            let snap = model.permissions
            StatusLine(message: nil, fallback: (snap.map { "\($0.grantedCount) of \(OnboardingPermission.allCases.count) granted" } ?? "Checking…")
                + (model.openedPermission.map { " · Opened \($0.title) in System Settings — turn on Glide there, then come back." } ?? ""))
        }
    }
}

private struct AIStep: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: OnboardingModel
    let actions: OnboardingFeature
    @FocusState private var fieldFocused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            StepTitle(eyebrow: "Step 3 · AI (optional)", title: "Bring Claude into Glide",
                      lead: "Paste an Anthropic API key to ask AI from the launcher, chat, and transform selected text. Skip this if you don't need it.")
            Text("Anthropic API key").font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text2)
            HStack {
                SecureField(model.aiHasKey == true ? "A key is saved — paste a new one to replace it" : "sk-ant-…", text: $model.aiKeyDraft)
                    .textFieldStyle(.roundedBorder)
                    .focused($fieldFocused)
                    .onSubmit { Task { await actions.saveAIKey() } }
                    .disabled(!model.aiAvailable)
                Button("Save & Test") { Task { await actions.saveAIKey() } }
                    .disabled(model.aiKeyDraft.trimmingCharacters(in: .whitespaces).isEmpty || !model.aiAvailable)
            }
            HStack(spacing: 8) {
                Tag(model.aiHasKey == true ? "Key saved" : "No key", accent: model.aiHasKey == true)
                if model.aiHasKey == true { Button("Remove key") { Task { await actions.removeAIKey() } }.controlSize(.small) }
                Button("Get a key ↗") { actions.openURL("https://console.anthropic.com/settings/keys") }.controlSize(.small)
            }
            StatusLine(message: model.aiMessage, fallback: model.aiAvailable ? "Your key is stored in the macOS Keychain and only sent to Anthropic."
                : "The AI feature isn't available in this build yet — you can add a key later in Settings → AI.")
        }
        .onChange(of: fieldFocused) { _, f in model.textFocused = f }
        .onAppear { if !actions.model.windowOpen { return }; fieldFocused = model.aiAvailable }
    }
}

private struct LookStep: View {
    @Environment(\.glideTheme) private var theme
    let model: OnboardingModel
    let actions: OnboardingFeature
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitle(eyebrow: "Step 4 · Look & feel", title: "Make it yours", lead: "Pick a theme — it applies instantly. Use j/k to flip through them.")
            HStack(alignment: .top, spacing: 18) {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(Array(Themes.presets.enumerated()), id: \.element.id) { i, p in
                            Button { model.listIndex = i; actions.pickTheme(p.id) } label: {
                                HStack(spacing: 10) {
                                    Swatches(preset: p)
                                    Text(p.name).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text)
                                    Spacer()
                                    Text(p.scheme == .dark ? "Dark" : "Light").font(.system(size: 11)).foregroundStyle(theme.text3)
                                }
                                .padding(.horizontal, 10).frame(height: 28)
                                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(p.id == model.activeThemeId ? theme.selected : .clear))
                                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(model.listIndex == i ? theme.accent.opacity(0.7) : .clear))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(p.id == model.activeThemeId ? .isSelected : [])
                        }
                    }
                }
                .frame(width: 270)
                VStack(alignment: .leading, spacing: 14) {
                    if let p = Themes.preset(model.activeThemeId) { MiniLauncher(preset: p, settings: AppearanceSettings(), large: true).frame(height: 190) }
                    Toggle(isOn: Binding(get: { model.vimMode }, set: { actions.setVim($0) })) {
                        VStack(alignment: .leading) { Text("Vim keys"); Text("Esc for normal mode, then j/k, gg, G, / …").font(.caption).foregroundStyle(theme.text3) }
                    }
                    .toggleStyle(.switch)
                    Toggle(isOn: Binding(get: { model.keepOpenAfterRun }, set: { actions.setKeepOpen($0) })) {
                        VStack(alignment: .leading) { Text("Keep open after running"); Text("Stay in Glide after a command (apps still close it).").font(.caption).foregroundStyle(theme.text3) }
                    }
                    .toggleStyle(.switch)
                }
                .foregroundStyle(theme.text)
            }
        }
    }
}

private struct DoneStep: View {
    @Environment(\.glideTheme) private var theme
    let hotkey: String
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitle(eyebrow: "All set", title: "You're ready to glide", lead: "Eight things worth remembering. Search “Welcome to Glide” to see this tour again.")
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 10) {
                ForEach(CheatSheet.rows(hotkey: hotkey), id: \.title) { r in
                    HStack(spacing: 10) {
                        Group {
                            if r.typed { Text(r.keys).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.accentText).padding(.horizontal, 6).padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: 5).fill(theme.accentSoft)) }
                            else { Kbd(r.keys) }
                        }
                        .frame(width: 92, alignment: .leading)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.title).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text)
                            Text(r.body).font(.system(size: 11.5)).foregroundStyle(theme.text3)
                        }
                        Spacer()
                    }
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(theme.surface2.opacity(0.35)))
                }
            }
        }
    }
}
