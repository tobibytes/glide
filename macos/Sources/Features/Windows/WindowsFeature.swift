import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Window management (port of src/main/features/windows): one command per WindowService action on the app
/// behind the launcher, plus default-off suggested hotkeys (⌃⌥ arrows / Return). Item ids `windows.<action>`.
@MainActor public final class WindowsFeature: Feature, FeatureUI {
    public let id = "windows"
    public let title = "Window Management"
    private weak var context: FeatureContext?
    private var registered: [String: Bool] = [:]
    /// Delay between hiding the launcher and moving the window (the panel is non-activating, so the target
    /// app stays frontmost; the delay only lets the panel order out). Tests set 0.
    var hideDelay: Duration = .milliseconds(60)

    public struct Command: Sendable, Hashable {
        public let action: String
        public let title: String
        public let symbol: String
        public let keywords: [String]
    }

    static let snap = ["snap", "resize", "tile", "window", "move"]
    static func cmd(_ a: String, _ t: String, _ s: String, _ k: [String], snap: Bool = true) -> Command {
        Command(action: a, title: t, symbol: s, keywords: (snap ? Self.snap : ["window"]) + k)
    }

    /// One launcher command per action, in the order Raycast lists them (WINDOW_COMMANDS).
    public static let commands: [Command] = [
        cmd("left-half", "Left Half", "rectangle.lefthalf.filled", ["left", "half", "split"]),
        cmd("right-half", "Right Half", "rectangle.righthalf.filled", ["right", "half", "split"]),
        cmd("top-half", "Top Half", "rectangle.tophalf.filled", ["top", "upper", "half"]),
        cmd("bottom-half", "Bottom Half", "rectangle.bottomhalf.filled", ["bottom", "lower", "half"]),
        cmd("top-left", "Top Left Quarter", "rectangle.inset.topleft.filled", ["quarter", "corner"]),
        cmd("top-right", "Top Right Quarter", "rectangle.inset.topright.filled", ["quarter", "corner"]),
        cmd("bottom-left", "Bottom Left Quarter", "rectangle.inset.bottomleft.filled", ["quarter", "corner"]),
        cmd("bottom-right", "Bottom Right Quarter", "rectangle.inset.bottomright.filled", ["quarter", "corner"]),
        cmd("left-third", "First Third", "rectangle.leadingthird.inset.filled", ["left", "third"]),
        cmd("center-third", "Center Third", "rectangle.center.inset.filled", ["middle", "third"]),
        cmd("right-third", "Last Third", "rectangle.trailingthird.inset.filled", ["right", "third"]),
        cmd("left-two-thirds", "First Two Thirds", "rectangle.leadinghalf.inset.filled", ["left", "two thirds"]),
        cmd("right-two-thirds", "Last Two Thirds", "rectangle.trailinghalf.inset.filled", ["right", "two thirds"]),
        cmd("maximize", "Maximize", "rectangle.inset.filled", ["fill", "zoom", "full"]),
        cmd("almost-maximize", "Almost Maximize", "rectangle.dashed", ["fill", "large"]),
        cmd("center", "Center", "rectangle.center.inset.filled", ["middle", "centre"]),
        cmd("reasonable-size", "Reasonable Size", "rectangle.ratio.4.to.3", ["medium", "default"]),
        cmd("restore", "Restore", "arrow.uturn.backward", ["undo", "previous", "original"]),
        cmd("next-display", "Next Display", "display.2", ["monitor", "screen", "display"]),
        cmd("previous-display", "Previous Display", "display.2", ["monitor", "screen", "display"]),
        cmd("make-larger", "Make Larger", "plus.rectangle", ["bigger", "grow", "increase"]),
        cmd("make-smaller", "Make Smaller", "minus.rectangle", ["shrink", "decrease"]),
        cmd("toggle-fullscreen", "Toggle Fullscreen", "arrow.up.left.and.arrow.down.right", ["fullscreen", "full screen", "zoom"], snap: false),
        cmd("minimize", "Minimize", "minus.square", ["minimise", "hide", "dock"], snap: false),
    ]

    public struct Suggested: Sendable, Hashable {
        public let accelerator: String
        public let display: String
        public let action: String
    }

    /// Default-off suggested hotkeys, enabled with one toggle (SUGGESTED_HOTKEYS).
    public static let suggested: [Suggested] = [
        Suggested(accelerator: "Control+Alt+Left", display: "⌃⌥←", action: "left-half"),
        Suggested(accelerator: "Control+Alt+Right", display: "⌃⌥→", action: "right-half"),
        Suggested(accelerator: "Control+Alt+Up", display: "⌃⌥↑", action: "top-half"),
        Suggested(accelerator: "Control+Alt+Down", display: "⌃⌥↓", action: "bottom-half"),
        Suggested(accelerator: "Control+Alt+Enter", display: "⌃⌥↩", action: "maximize"),
    ]

    public static func itemId(_ action: String) -> String { "windows.\(action)" }
    static let needsAccessibility = "Glide needs Accessibility permission to move windows. Press ⌘K → Open Accessibility Settings, enable Glide, then try again."

    public init() {}

    var suggestedOn: Bool { context?.settings(defaults: ["suggestedHotkeys": false])["suggestedHotkeys"]?.boolValue == true }

    public func start(context: FeatureContext) async {
        self.context = context
        syncSuggestedHotkeys()
    }

    public func stop() async {
        for h in Self.suggested { context?.registerHotkey(key: h.action, accelerator: nil) {} }
    }

    func syncSuggestedHotkeys() {
        guard let ctx = context else { return }
        let on = suggestedOn
        registered = [:]
        for h in Self.suggested {
            let ok = ctx.registerHotkey(key: h.action, accelerator: on ? h.accelerator : nil) { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    if case let .error(m) = await self.apply(h.action, hideFirst: false) { self.context?.log(m) }
                }
            }
            if on { registered[h.accelerator] = ok }
        }
    }

    public func items() -> [SearchItem] {
        let on = suggestedOn
        return Self.commands.map { c in
            SearchItem(id: Self.itemId(c.action), kind: .command, title: c.title, subtitle: "Window Management", icon: .symbol(c.symbol),
                       keywords: c.keywords, hotkey: on ? Self.suggested.first { $0.action == c.action }?.display : nil,
                       feature: id, data: ["action": .string(c.action)], kindLabel: "Window")
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        [ItemAction(id: "apply", title: item.title, shortcut: "↩", icon: "macwindow"),
         ItemAction(id: "open-accessibility", title: "Open Accessibility Settings", shortcut: "⌘↩", icon: "lock.shield"),
         ItemAction(id: "window-settings", title: "Window Management Settings…", icon: "gearshape")]
    }

    /// Apply a window action to the app behind the launcher.
    public func apply(_ action: String, hideFirst: Bool = true) async -> ActionResult {
        guard let ctx = context else { return .error("Window management is not ready") }
        guard Self.commands.contains(where: { $0.action == action }) else { return .error("Unknown window action") }
        if !ctx.services.isHeadless && !ctx.services.permissions.status().accessibility { return .error(Self.needsAccessibility) }
        if hideFirst {
            ctx.hideLauncher()
            if hideDelay > .zero { try? await Task.sleep(for: hideDelay) }
        }
        let r = await ctx.services.windows.apply(action)
        if !r.ok { return .error(r.error == "Accessibility permission required" ? Self.needsAccessibility : (r.error ?? "Could not move the window")) }
        return .hide()
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        switch action {
        case "open-accessibility": return await openAccessibility()
        case "window-settings": return .openSettings(page: id)
        default:
            guard let a = scored.item.data?["action"]?.stringValue else { return .error("Unknown window action") }
            return await apply(a)
        }
    }

    func state() -> JSONValue {
        let on = suggestedOn
        return ["suggestedHotkeys": .bool(on), "hotkeys": .array(Self.suggested.map { h in
            ["display": .string(h.display), "action": .string(h.action), "title": .string(Self.commands.first { $0.action == h.action }?.title ?? h.action),
             "registered": .bool(on && registered[h.accelerator] == true)]
        })]
    }

    func setSuggested(_ on: Bool) {
        context?.setSettings(["suggestedHotkeys": .bool(on)])
        syncSuggestedHotkeys()
        context?.refreshCatalogue()
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "getState": return state()
        case "setSuggestedHotkeys":
            setSuggested(args.boolValue ?? args["on"]?.boolValue ?? false)
            return state()
        case "apply":
            guard let a = args.stringValue ?? args["action"]?.stringValue else { throw FeatureError.invalidArguments("Invalid action") }
            switch await apply(a, hideFirst: false) {
            case let .error(m): return ["ok": false, "error": .string(m)]
            default: return ["ok": true]
            }
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Window Management", symbol: "macwindow.on.rectangle", order: 40) { [weak self] in
            AnyView(WindowsSettingsView(feature: self))
        }
    }
}

struct WindowsSettingsView: View {
    weak var feature: WindowsFeature?
    @State private var on = false
    @State private var accessibility = false

    var body: some View {
        Form {
            Section {
                Toggle("Use suggested hotkeys (⌃⌥ + arrows / Return)", isOn: $on)
                    .onChange(of: on) { _, v in if v != feature?.suggestedOn { feature?.setSuggested(v) } }
                ForEach(WindowsFeature.suggested, id: \.accelerator) { h in
                    HStack {
                        Text(WindowsFeature.commands.first { $0.action == h.action }?.title ?? h.action)
                        Spacer()
                        Kbd(h.display)
                    }
                    .foregroundStyle(on ? .primary : .secondary)
                }
            } header: { Text("Hotkeys") } footer: {
                Text("Every window command can also get its own hotkey from the launcher: select it, ⌘K → Set Hotkey.")
            }
            Section("Permission") {
                HStack {
                    Image(systemName: accessibility ? "checkmark.seal.fill" : "exclamationmark.triangle.fill").foregroundStyle(accessibility ? .green : .orange)
                    Text(accessibility ? "Accessibility is granted" : "Accessibility is required to move other apps' windows")
                    Spacer()
                    if !accessibility { Button("Open Accessibility Settings") { Task { _ = await feature?.openAccessibility() } } }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            on = feature?.suggestedOn ?? false
            accessibility = feature?.accessibilityGranted ?? false
        }
        .task {
            // Live: the user grants it in System Settings and comes back to this page (read-only, never prompts).
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.5))
                let now = feature?.accessibilityGranted ?? false
                if now != accessibility { accessibility = now }
            }
        }
    }
}

extension WindowsFeature {
    var accessibilityGranted: Bool { context?.services.permissions.status().accessibility ?? false }
    func run(openPane: String) -> ActionResult { SettingsPanes.open(openPane, context) }

    /// "Open Accessibility Settings" (explicit action): ask once first — until Glide has asked, it is not even
    /// listed in the pane and the user would have to add it with +. Then open the pane.
    func openAccessibility() async -> ActionResult {
        guard let ctx = context else { return .error("Window management is not ready") }
        if !ctx.services.permissions.status().accessibility { _ = await ctx.services.permissions.request(.accessibility) }
        return SettingsPanes.open(SettingsPanes.accessibility, ctx)
    }
}
