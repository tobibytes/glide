import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Keyboard settings (port of src/main/features/keyboard): launcher hotkey recorder (combos, Double+⌘,
/// Right+⌥), "Use ⌘Space for Glide" (turns Spotlight's symbolic hotkey 64 off — only from an explicit user
/// action), the Hyper key (Caps Lock → ⌃⌥⇧⌘ via the keyboard tap + hidutil), snippet expansion and the
/// permission status. Owns the KeyboardTapService config (snippets + Hyper + Paste Stack contributions).
@MainActor public final class KeyboardFeature: Feature, FeatureUI {
    public let id = "keyboard"
    public let title = "Keyboard"
    private weak var context: FeatureContext?
    private var observation: StoreObservation?
    private var lastConfig: KeyboardTapConfig?
    private(set) var active = false
    private(set) var lastError: String?
    private(set) var expansions = 0
    /// Paste Stack contribution from the clipboard feature (`invoke("keyboard","setPasteStack", true)`).
    private var pasteStack = false
    /// Snippet list contributed by another feature; nil = build it from data.json snippets.
    private var contributedSnippets: [KeyboardTapConfig.SnippetEntry]?

    public static let spotlightHotkey = "Command+Space"
    public static let fallbackHotkey = "Alt+Space"
    static let defaults: [String: JSONValue] = ["expandSnippets": true, "hyperKey": "off", "spotlightTakeover": false, "previousHotkey": ""]

    public init() {}

    var settings: [String: JSONValue] { context?.settings(defaults: Self.defaults) ?? Self.defaults }
    var expandSnippets: Bool { settings["expandSnippets"]?.boolValue != false }
    var hyperKey: String { settings["hyperKey"]?.stringValue == "capslock" ? "capslock" : "off" }
    var takeover: Bool { settings["spotlightTakeover"]?.boolValue == true }

    public func start(context: FeatureContext) async {
        self.context = context
        let tapEvents = KeyboardTapComposer.shared(for: context.services) // N2: snippet matches / ⌘V go to Snippets 2.0 and Clipboard
        context.services.keyboardTap.onEvent = { [weak self] e in
            tapEvents.dispatch(e)
            guard let self else { return }
            switch e {
            case let .tapFailed(reason):
                self.lastError = reason
                self.active = false
            case .snippetExpanded: self.expansions += 1
            default: break
            }
        }
        observation = context.store.observe { [weak self] _ in Task { @MainActor in self?.configure() } }
        configure()
    }

    public func stop() async { observation?.cancel() }

    /// Hotkey to restore when the ⌘Space takeover is turned off.
    public static func hotkeyAfterTakeover(_ previous: String) -> String { !previous.isEmpty && previous != spotlightHotkey ? previous : fallbackHotkey }

    /// The tap config. Without Accessibility nothing is enabled (the tap would fail) — except headless, where
    /// the fake records the config and never touches hidutil or the event tap.
    public static func buildConfig(expandSnippets: Bool, hyperKey: String, snippets: [Snippet], contributed: [KeyboardTapConfig.SnippetEntry]?,
                                   accessibility: Bool, pasteStack: Bool) -> KeyboardTapConfig {
        var c = KeyboardTapConfig()
        guard accessibility else { return c }
        if expandSnippets {
            c.snippets = contributed ?? snippets.compactMap { s in
                guard let k = s.keyword?.trimmingCharacters(in: .whitespaces), !k.isEmpty else { return nil }
                return .init(keyword: k, text: s.text, id: s.id, excludedBundleIds: s.excludedApps ?? [])
            }.sorted { $0.keyword.count > $1.keyword.count }
        }
        c.hyperKey = hyperKey == "capslock"
        c.pasteStack = pasteStack
        return c
    }

    func configure(force: Bool = false) {
        guard let ctx = context else { return }
        let ax = ctx.services.isHeadless || ctx.services.permissions.status().accessibility
        let config = Self.buildConfig(expandSnippets: expandSnippets, hyperKey: hyperKey, snippets: ctx.store.data.snippets, contributed: contributedSnippets,
                                      accessibility: ax, pasteStack: pasteStack)
        if !force, config == lastConfig { return }
        lastConfig = config
        let err = ctx.services.keyboardTap.configure(config)
        lastError = err
        active = err == nil && (!config.snippets.isEmpty || config.hyperKey || config.pasteStack)
    }

    // MARK: operations (explicit user actions only)

    func setUseCommandSpace(_ on: Bool) throws {
        guard let ctx = context else { throw FeatureError.failed("Keyboard feature is not ready") }
        let r = ctx.services.spotlight.setEnabled(!on)
        if !r.ok { throw FeatureError.failed(r.error ?? (on ? "Could not turn off Spotlight's shortcut" : "Could not restore Spotlight's shortcut")) }
        let current = ctx.store.settings.hotkey
        if on {
            ctx.setSettings(["spotlightTakeover": true, "previousHotkey": .string(takeover ? (settings["previousHotkey"]?.stringValue ?? "") : current)])
            ctx.store.setSettings { $0.hotkey = Self.spotlightHotkey }
        } else {
            let restore = Self.hotkeyAfterTakeover(settings["previousHotkey"]?.stringValue ?? "")
            ctx.setSettings(["spotlightTakeover": false, "previousHotkey": ""])
            if current == Self.spotlightHotkey { ctx.store.setSettings { $0.hotkey = restore } }
        }
    }

    func setHotkey(_ accel: String) throws {
        guard let ctx = context else { throw FeatureError.failed("Not ready") }
        if case let .failure(e) = HotkeyParser.parse(accel) { throw e }
        if accel == Self.spotlightHotkey && ctx.services.spotlight.isEnabled() {
            throw FeatureError.failed("⌘Space belongs to Spotlight. Turn on “Use ⌘Space for Glide” instead.")
        }
        ctx.store.setSettings { $0.hotkey = accel }
    }

    func setHyperKey(_ mode: String) throws {
        guard mode == "off" || mode == "capslock" else { throw FeatureError.invalidArguments("Invalid Hyper key mode") }
        context?.setSettings(["hyperKey": .string(mode)])
        configure()
    }

    func setExpandSnippets(_ on: Bool) {
        context?.setSettings(["expandSnippets": .bool(on)])
        configure()
    }

    func requestPermission(_ kind: String) async throws {
        guard let ctx = context else { return }
        let k: PermissionKind = kind == "inputMonitoring" ? .inputMonitoring : .accessibility
        guard kind == "accessibility" || kind == "inputMonitoring" else { throw FeatureError.invalidArguments("Unknown permission") }
        _ = await ctx.services.permissions.request(k)
        _ = SettingsPanes.open(k == .accessibility ? SettingsPanes.accessibility : SettingsPanes.inputMonitoring, ctx)
        configure(force: true)
    }

    func state() -> JSONValue {
        let p = context?.services.permissions.status()
        return [
            "permissions": p.map { ["accessibility": .bool($0.accessibility), "inputMonitoring": .bool($0.inputMonitoring)] } ?? .null,
            "settings": .object(settings),
            "keywordCount": .int(Int64(lastConfig?.snippets.count ?? 0)),
            "active": .bool(active),
            "spotlightShortcutEnabled": context.map { .bool($0.services.spotlight.isEnabled()) } ?? .null,
            "hotkey": .string(context?.store.settings.hotkey ?? ""),
            "lastError": lastError.map(JSONValue.string) ?? .null,
            "expansions": .int(Int64(expansions)),
            "pasteStack": .bool(active && pasteStack),
        ]
    }

    // MARK: items

    public func items() -> [SearchItem] {
        [SearchItem(id: "keyboard.toggle-expansion", kind: .command, title: "Toggle Snippet Expansion",
                    subtitle: expandSnippets ? "Keyword expansion is on" : "Keyword expansion is off", icon: .symbol("keyboard"),
                    keywords: ["snippet", "expand", "expansion", "keyword", "text replacement", "typing"], feature: id, kindLabel: "Keyboard"),
         SearchItem(id: "keyboard.settings", kind: .command, title: "Open Keyboard Settings", subtitle: "Hotkey, Hyper key, ⌘Space, snippet expansion",
                    icon: .symbol("keyboard.badge.ellipsis"),
                    keywords: ["hyper", "caps lock", "spotlight", "command space", "hotkey", "permissions", "input monitoring", "accessibility"], feature: id, kindLabel: "Keyboard")]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        item.id == "keyboard.toggle-expansion"
            ? [ItemAction(id: "toggle", title: "Toggle Snippet Expansion", shortcut: "↩", icon: "keyboard"),
               ItemAction(id: "settings", title: "Open Keyboard Settings", shortcut: "⌘↩", icon: "gearshape")]
            : [ItemAction(id: "settings", title: "Open Keyboard Settings", shortcut: "↩", icon: "gearshape")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        if action == "toggle" {
            let on = !expandSnippets
            setExpandSnippets(on)
            context?.refreshCatalogue()
            if on, let ctx = context, !ctx.services.isHeadless, !ctx.services.permissions.status().accessibility {
                return .stay(message: "Snippet expansion is on — grant Accessibility in Keyboard settings for it to work")
            }
            return .stay(message: on ? "Snippet expansion turned on" : "Snippet expansion turned off")
        }
        return .openSettings(page: id)
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "getState": return state()
        case "setExpandSnippets": setExpandSnippets(args.boolValue ?? args["on"]?.boolValue ?? false)
        case "setHyperKey": try setHyperKey(args.stringValue ?? args["mode"]?.stringValue ?? "")
        case "setUseCommandSpace": try setUseCommandSpace(args.boolValue ?? args["on"]?.boolValue ?? false)
        case "setHotkey": try setHotkey(args.stringValue ?? args["accelerator"]?.stringValue ?? "")
        case "requestPermission": try await requestPermission(args.stringValue ?? args["kind"]?.stringValue ?? "")
        case "setPasteStack":
            pasteStack = args.boolValue ?? args["on"]?.boolValue ?? false
            configure()
        case "setSnippets":
            // Another feature (snippets) may own placeholder rendering / case variants: it hands its list here.
            if args.isNull { contributedSnippets = nil } else {
                contributedSnippets = (args.arrayValue ?? []).compactMap { v in
                    guard let k = v["keyword"]?.stringValue, let t = v["text"]?.stringValue else { return nil }
                    return .init(keyword: k, text: t, id: v["id"]?.stringValue, excludedBundleIds: v["excludedBundleIds"]?.arrayValue?.compactMap(\.stringValue) ?? [])
                }
            }
            configure()
        case "openKeyboardShortcuts": return SettingsPanes.open(SettingsPanes.keyboardShortcuts, context) == .hide() ? true : false
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
        return state()
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Keyboard", symbol: "keyboard", order: 15) { [weak self] in AnyView(KeyboardSettingsView(feature: self)) }
    }
}

struct KeyboardSettingsView: View {
    weak var feature: KeyboardFeature?
    @State private var hotkey = ""
    @State private var takeover = false
    @State private var hyper = false
    @State private var expand = true
    @State private var ax = false
    @State private var input = false
    @State private var error: String?
    @State private var keywordCount = 0

    var body: some View {
        Form {
            Section {
                LabeledContent("Launcher hotkey") {
                    KeyboardHotkeyField(current: hotkey) { a in act { try feature?.setHotkey(a) } }
                }
                Toggle("Use ⌘Space for Glide (turns off Spotlight’s shortcut)", isOn: Binding(get: { takeover }, set: { v in act { try feature?.setUseCommandSpace(v) } }))
            } header: { Text("Hotkey") } footer: {
                Text("Record a combination such as ⌥Space, or double-tap a modifier (⌘⌘) / tap a right-side modifier (Right ⌥). Modifier-only shortcuts need Input Monitoring.")
            }
            Section("Keys") {
                Toggle("Hyper key: Caps Lock acts as ⌃⌥⇧⌘", isOn: Binding(get: { hyper }, set: { v in act { try feature?.setHyperKey(v ? "capslock" : "off") } }))
                Toggle("Expand snippet keywords as you type (\(keywordCount) keywords)", isOn: Binding(get: { expand }, set: { v in act { feature?.setExpandSnippets(v) } }))
            }
            Section("Permissions") {
                permissionRow("Accessibility", granted: ax, kind: "accessibility", why: "Snippet expansion, window management, menus")
                permissionRow("Input Monitoring", granted: input, kind: "inputMonitoring", why: "Modifier-only hotkeys (⌘⌘, Right ⌥)")
            }
            if let error { Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) } }
        }
        .formStyle(.grouped)
        .onAppear(perform: reload)
    }

    private func permissionRow(_ title: String, granted: Bool, kind: String, why: String) -> some View {
        HStack {
            Image(systemName: granted ? "checkmark.seal.fill" : "exclamationmark.triangle.fill").foregroundStyle(granted ? .green : .orange)
            VStack(alignment: .leading) {
                Text(title)
                Text(why).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if !granted { Button("Grant…") { Task { @MainActor in try? await feature?.requestPermission(kind); reload() } } }
        }
    }

    private func act(_ f: () throws -> Void) {
        do { try f(); error = nil } catch { self.error = error.localizedDescription }
        reload()
    }

    private func reload() {
        guard let s = feature?.state() else { return }
        hotkey = s["hotkey"]?.stringValue ?? ""
        takeover = s["settings"]?["spotlightTakeover"]?.boolValue == true
        hyper = s["settings"]?["hyperKey"]?.stringValue == "capslock"
        expand = s["settings"]?["expandSnippets"]?.boolValue != false
        ax = s["permissions"]?["accessibility"]?.boolValue == true
        input = s["permissions"]?["inputMonitoring"]?.boolValue == true
        keywordCount = s["keywordCount"]?.intValue ?? 0
        if let e = s["lastError"]?.stringValue { error = e }
    }
}
