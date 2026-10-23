import AppKit
import CoreGraphics
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Observable state of the tour (shared by the window, the headless test channel and snapshots).
@MainActor @Observable public final class OnboardingModel {
    public var flow = FlowState()
    public var windowOpen = false
    /// Selection inside the current step's list (hotkey options, permission rows, theme list).
    public var listIndex = 0
    public var hotkey = "Alt+Space"
    public var hotkeyMessage: (ok: Bool, text: String)?
    public var permissions: PermissionsSnapshot?
    public var openedPermission: OnboardingPermission?
    public var aiHasKey: Bool?
    public var aiMessage: (ok: Bool, text: String)?
    public var aiAvailable = true
    public var aiKeyDraft = ""
    public var textFocused = false
    public var vimMode = true
    public var keepOpenAfterRun = true
    public var activeThemeId = "glide-dark"
    public var spotlightTakeover = false
    public init() {}

    public var hotkeyChoice: HotkeyAdvice.Choice { HotkeyAdvice.choice(for: hotkey) }

    /// Rows of the current step's j/k list.
    public var listCount: Int {
        switch flow.step {
        case .hotkey: return 3
        case .permissions: return OnboardingPermission.allCases.count
        case .look: return Themes.presets.count
        default: return 0
        }
    }
}

/// First-run onboarding (feature id "onboarding", same bag as the Electron app): a dedicated window walking a
/// new user through the hotkey, permissions (live, read-only status), an optional AI key, look & feel and a cheat
/// sheet. Shown once on a fresh install; reopen with "Welcome to Glide". Headless: state only, no window.
@MainActor public final class OnboardingFeature: Feature, FeatureUI {
    public let id = "onboarding"
    public let title = "Onboarding"
    public let model = OnboardingModel()
    private weak var context: FeatureContext?
    public private(set) var decision: FirstRunDecision?
    private var openTask: Task<Void, Never>?
    private var pollTimer: Timer?
    private var window: NSWindow?
    private var keyMonitor: Any?
    private var closeObserver: NSObjectProtocol?
    private let launchedAtMs = FirstRun.processStartMs()

    public init() {}

    private var isHeadless: Bool { context?.services.isHeadless ?? true }
    var settings: OnboardingSettings { OnboardingSettings(bag: context?.settings(defaults: OnboardingSettings.defaults) ?? [:]) }

    public func start(context: FeatureContext) async {
        self.context = context
        syncFromStore()
        let env = ProcessInfo.processInfo.environment
        let d = FirstRun.decide(FirstRunSignals(
            onboarding: settings, envSkip: env["GLIDE_SKIP_ONBOARDING"] == "1",
            dataPredatesLaunch: FirstRun.predatesLaunch(FirstRun.dataMtimes(root: context.store.directory), launchedAtMs: launchedAtMs),
            usageCount: context.store.usage.count, settingsCustomised: FirstRun.settingsCustomised(context.store.settings)))
        decision = d
        context.log("first run: \(d.reason.rawValue)\(d.show ? " (opening)" : "")")
        if d.show {
            // After the launcher exists, so the tour is the window in front.
            openTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(900))
                guard !Task.isCancelled else { return }
                self?.openWindow()
            }
        }
    }

    public func stop() async {
        openTask?.cancel()
        closeWindow()
    }

    private func syncFromStore() {
        guard let c = context else { return }
        let s = c.store.settings
        model.hotkey = s.hotkey
        model.vimMode = s.vimMode
        model.keepOpenAfterRun = s.keepOpenAfterRun
        model.activeThemeId = AppearanceStore(store: c.store).active.id
        model.spotlightTakeover = s.features["keyboard"]?["spotlightTakeover"]?.boolValue == true
    }

    private func persist(_ patch: [String: JSONValue]) { context?.setSettings(patch) }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        [SearchItem(id: "onboarding.welcome", kind: .command, title: "Welcome to Glide", subtitle: "Setup tour: hotkey, permissions, AI and themes",
                    icon: .symbol("hand.wave"), keywords: ["onboarding", "welcome", "tour", "setup", "getting started", "intro", "permissions", "first run"],
                    source: "onboarding", feature: id, kindLabel: "Onboarding")]
    }

    public func actions(for item: SearchItem) -> [ItemAction] { [ItemAction(id: "open", title: "Open Welcome Tour", shortcut: "↩", icon: "hand.wave")] }

    public func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        openWindow(restart: true)
        return .hide()
    }

    // MARK: window

    public func openWindow(restart: Bool = false) {
        guard let c = context else { return }
        syncFromStore()
        let s = settings
        if !s.completed && !s.skipped {
            persist(["started": true])
            if !model.windowOpen { model.flow = FlowState(step: s.step) }
        } else if restart {
            persist(["step": "welcome"])
            model.flow = FlowState()
        }
        if restart && model.windowOpen { model.flow = FlowState() }
        model.listIndex = defaultListIndex()
        model.windowOpen = true
        refreshPermissions()
        refreshAI()
        startPolling()
        if c.services.isHeadless { return } // state only: never a window in headless runs
        if let w = window {
            NSApp.activate(ignoringOtherApps: true)
            w.makeKeyAndOrderFront(nil)
            return
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 560), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: true)
        w.title = "Welcome to Glide"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: OnboardingRootView(model: model, actions: self))
        w.center()
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.windowClosed() }
        }
        // Local (in-app) key monitor for the tour's keyboard model — not a global tap.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self, weak w] e in
            guard let self, let w, e.window === w else { return e }
            return self.handleWindowKey(e) ? nil : e
        }
        window = w
        NSApp.activate(ignoringOtherApps: true) // a normal, activating window like Settings
        w.makeKeyAndOrderFront(nil)
    }

    public func closeWindow() {
        window?.close()
        windowClosed()
    }

    private func windowClosed() {
        if let m = keyMonitor { NSEvent.removeMonitor(m) }
        keyMonitor = nil
        if let o = closeObserver { NotificationCenter.default.removeObserver(o) }
        closeObserver = nil
        window = nil
        model.windowOpen = false
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func startPolling() {
        pollTimer?.invalidate()
        // Live: users flip switches in System Settings and come back (read-only status, never prompts).
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.model.windowOpen, self.model.flow.step == .permissions else { return }
                self.refreshPermissions()
            }
        }
    }

    private func handleWindowKey(_ e: NSEvent) -> Bool {
        let f = e.modifierFlags
        let named: [UInt16: String] = [36: "Enter", 76: "Enter", 53: "Escape", 125: "ArrowDown", 126: "ArrowUp", 49: " "]
        let key = named[e.keyCode] ?? (e.charactersIgnoringModifiers ?? "")
        let vk = VimKey(key, ctrl: f.contains(.control), meta: f.contains(.command), shift: f.contains(.shift), alt: f.contains(.option))
        let responder = e.window?.firstResponder
        let target: TourKeyTarget = responder is NSTextView ? .text : responder is NSButton ? .button : responder is HotkeyRecorderField.RecorderView ? .text : .option
        return handleKey(vk, target: target)
    }

    // MARK: flow

    private func defaultListIndex() -> Int {
        switch model.flow.step {
        case .hotkey: return ["alt": 0, "cmd": 1, "custom": 2][model.hotkeyChoice.rawValue] ?? 0
        case .look: return Themes.presets.firstIndex { $0.id == model.activeThemeId } ?? 0
        default: return 0
        }
    }

    public func dispatch(_ a: FlowAction) {
        let before = model.flow
        let next = OnboardingFlow.reduce(before, a)
        guard next != before else { return }
        model.flow = next
        model.listIndex = defaultListIndex()
        let now = Date().timeIntervalSince1970 * 1000
        switch next.status {
        case .active:
            let s = settings
            // After completion the tour can be replayed without becoming "in progress" again.
            if !s.completed && !s.skipped { persist(OnboardingFlow.persistPatch(next, now: now)) }
            if next.step == .permissions { refreshPermissions() }
            if next.step == .ai { refreshAI() }
        case .completed:
            persist(OnboardingFlow.persistPatch(next, now: now))
            closeWindow()
            context?.showLauncher()
        case .skipped:
            persist(OnboardingFlow.persistPatch(next, now: now))
            closeWindow()
        }
    }

    /// The tour's keyboard model (window key monitor and the test channel share it). true = handled.
    @discardableResult
    public func handleKey(_ k: VimKey, target: TourKeyTarget = .option) -> Bool {
        if k.key == " " && target == .option && !k.meta && !k.ctrl { activateListItem(continueAfter: false); return model.listCount > 0 }
        guard let cmd = TourKeys.command(k, target: target) else { return false }
        switch cmd {
        case .listNext, .listPrev:
            guard model.listCount > 0 else { return false }
            model.listIndex = min(model.listCount - 1, max(0, model.listIndex + (cmd == .listNext ? 1 : -1)))
            // Themes apply as they get focus (live preview of the whole app).
            if model.flow.step == .look { pickTheme(Themes.presets[model.listIndex].id) }
        case .back: dispatch(.back)
        case .next:
            if model.flow.step == .hotkey && k.key == "Enter" && !k.meta { activateListItem(continueAfter: true) }
            else if model.flow.step == .ai && !model.aiKeyDraft.trimmingCharacters(in: .whitespaces).isEmpty && k.key == "Enter" && !k.meta { Task { await saveAIKey() } }
            else { dispatch(.next) }
        }
        return true
    }

    /// Space / Enter on the selected list row.
    public func activateListItem(continueAfter: Bool) {
        switch model.flow.step {
        case .hotkey:
            let choice: HotkeyAdvice.Choice = [.alt, .cmd, .custom][min(2, max(0, model.listIndex))]
            // Enter on the current choice just continues; on another one it applies it first.
            if continueAfter && choice == model.hotkeyChoice && choice != .custom { dispatch(.next); return }
            Task { @MainActor in
                let ok = await self.choose(choice)
                if ok && continueAfter { self.dispatch(.next) }
            }
        case .permissions:
            let kind = OnboardingPermission.allCases[min(model.listCount - 1, max(0, model.listIndex))]
            Task { await openPermissionSettings(kind) }
        case .look: pickTheme(Themes.presets[min(model.listCount - 1, max(0, model.listIndex))].id)
        default: if continueAfter { dispatch(.next) }
        }
    }

    // MARK: hotkey step

    public func choose(_ c: HotkeyAdvice.Choice) async -> Bool {
        switch c {
        case .alt: return apply(await setHotkey("Alt+Space"))
        case .cmd: return apply(await useCommandSpace())
        case .custom:
            model.hotkeyMessage = (true, "Focus the recorder and press a combination with a modifier.")
            return false
        }
    }

    private func apply(_ r: (ok: Bool, hotkey: String, error: String?)) -> Bool {
        model.hotkeyMessage = r.ok ? (true, "Glide opens with \(Accelerator.display(r.hotkey))") : (false, r.error ?? "That shortcut couldn't be registered.")
        syncFromStore()
        return r.ok
    }

    /// Recorder input (the custom row).
    public func record(_ accel: String) {
        if HotkeyAdvice.canonical(accel) == "command+space" {
            model.hotkeyMessage = (false, "To use ⌘Space, pick “Use ⌘Space” above so Spotlight's shortcut is turned off first.")
            return
        }
        if let conflict = HotkeyAdvice.conflict(accel) { model.hotkeyMessage = (false, conflict); return }
        Task { _ = apply(await setHotkey(accel)) }
    }

    /// Set the launcher hotkey; refuses known conflicts and unparseable accelerators.
    public func setHotkey(_ accel: String) async -> (ok: Bool, hotkey: String, error: String?) {
        guard let c = context else { return (false, "", "Onboarding is not ready") }
        let previous = c.store.settings.hotkey
        let next = accel.trimmingCharacters(in: .whitespaces)
        if next.isEmpty { return (false, previous, "Press a key combination.") }
        if HotkeyAdvice.canonical(next) == "command+space" { return await useCommandSpace() }
        if let conflict = HotkeyAdvice.conflict(next) { return (false, previous, conflict) }
        if case let .failure(e) = HotkeyParser.parse(next) { return (false, previous, e.localizedDescription) }
        // Leaving ⌘Space: give Spotlight its shortcut back (the user picked another hotkey on purpose).
        if c.store.settings.features["keyboard"]?["spotlightTakeover"]?.boolValue == true {
            _ = try? await c.callFeature("keyboard", method: "setUseCommandSpace", args: false)
        }
        c.store.setSettings { $0.hotkey = next } // the launcher re-registers its hotkeys on the store change
        return (true, next, nil)
    }

    /// Hand ⌘Space to Glide: the keyboard feature's takeover when present, else turn Spotlight's shortcut off here.
    public func useCommandSpace() async -> (ok: Bool, hotkey: String, error: String?) {
        guard let c = context else { return (false, "", "Onboarding is not ready") }
        do {
            _ = try await c.callFeature("keyboard", method: "setUseCommandSpace", args: true)
        } catch let FeatureError.unknownFeature(f) where f == "keyboard" {
            let r = c.services.spotlight.setEnabled(false)
            if !r.ok { return (false, c.store.settings.hotkey, r.error ?? "Could not turn off Spotlight's ⌘Space shortcut") }
            c.store.setSettings { $0.hotkey = "Command+Space" }
        } catch let FeatureError.unknownMethod(f, _) where f == "keyboard" {
            let r = c.services.spotlight.setEnabled(false)
            if !r.ok { return (false, c.store.settings.hotkey, r.error ?? "Could not turn off Spotlight's ⌘Space shortcut") }
            c.store.setSettings { $0.hotkey = "Command+Space" }
        } catch {
            return (false, c.store.settings.hotkey, error.localizedDescription)
        }
        return (true, c.store.settings.hotkey, nil)
    }

    // MARK: permissions step

    /// Read-only status for the checklist (never prompts).
    public func permissionsSnapshot() -> PermissionsSnapshot {
        let now = Date().timeIntervalSince1970 * 1000
        if isHeadless, let file = ProcessInfo.processInfo.environment["GLIDE_ONBOARDING_FAKE_PERMISSIONS"],
           let data = FileManager.default.contents(atPath: file), let raw = try? JSONDecoder().decode(JSONValue.self, from: data),
           let fake = PermissionMapping.parseFake(raw) {
            return PermissionsSnapshot(source: "fake", status: fake, checkedAt: now)
        }
        let s = context?.services.permissions.status()
        return PermissionsSnapshot(source: "system", status: PermissionMapping.map(s, screenRecording: CGPreflightScreenCaptureAccess()), checkedAt: now)
    }

    public func refreshPermissions() {
        let snap = permissionsSnapshot()
        if snap.status != model.permissions?.status || model.permissions == nil { model.permissions = snap }
    }

    /// "Open Settings" on a row (explicit action only): register Glide in the pane's list once, open the pane.
    @discardableResult
    public func openPermissionSettings(_ kind: OnboardingPermission) async -> String {
        guard let c = context else { return "" }
        model.openedPermission = kind
        let current = permissionsSnapshot().status[kind]
        if let req = kind.requestKind, current != .granted { _ = await c.services.permissions.request(req) }
        if let url = URL(string: kind.paneURL) { _ = c.services.workspace.open(url: url) }
        refreshPermissions()
        return kind.paneURL
    }

    // MARK: AI step (the AI feature's own methods)

    public func refreshAI() {
        guard let c = context else { return }
        Task { @MainActor in
            do {
                let r = try await c.callFeature("ai", method: "hasApiKey", args: .null)
                self.model.aiHasKey = r["hasKey"]?.boolValue ?? r.boolValue ?? false
                self.model.aiAvailable = true
            } catch {
                self.model.aiAvailable = false
                self.model.aiHasKey = nil
            }
        }
    }

    public func saveAIKey() async {
        guard let c = context else { return }
        let key = model.aiKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { dispatch(.next); return }
        model.aiMessage = (true, "Saving and checking your key…")
        do {
            let r = try await c.callFeature("ai", method: "setApiKey", args: .string(key))
            model.aiHasKey = r["hasKey"]?.boolValue ?? true
            model.aiKeyDraft = ""
            let t = try await c.callFeature("ai", method: "testConnection", args: .null)
            model.aiMessage = (t["ok"]?.boolValue ?? false, t["message"]?.stringValue ?? "Key saved.")
        } catch {
            model.aiMessage = (false, error.localizedDescription)
        }
    }

    public func removeAIKey() async {
        guard let c = context else { return }
        if let r = try? await c.callFeature("ai", method: "clearApiKey", args: .null) { model.aiHasKey = r["hasKey"]?.boolValue ?? false }
        model.aiMessage = (true, "Key removed.")
    }

    func openURL(_ s: String) { if let u = URL(string: s) { _ = context?.services.workspace.open(url: u) } }

    // MARK: look step

    public func pickTheme(_ id: String) {
        guard let c = context, model.activeThemeId != id else { return }
        AppearanceStore(store: c.store).applyPreset(id)
        syncFromStore()
    }

    public func setVim(_ on: Bool) { context?.store.setSettings { $0.vimMode = on }; model.vimMode = on }
    public func setKeepOpen(_ on: Bool) { context?.store.setSettings { $0.keepOpenAfterRun = on }; model.keepOpenAfterRun = on }

    // MARK: methods

    func stateJSON() -> JSONValue {
        var o: [String: JSONValue] = [
            "settings": settings.json, "hotkey": .string(model.hotkey), "spotlightTakeover": .bool(model.spotlightTakeover),
            "firstRun": decision.map { ["show": .bool($0.show), "reason": .string($0.reason.rawValue)] } ?? .null,
            "windowOpen": .bool(model.windowOpen), "step": .string(model.flow.step.rawValue), "status": .string(model.flow.status.rawValue),
            "listIndex": .int(Int64(model.listIndex)), "activeTheme": .string(model.activeThemeId), "aiAvailable": .bool(model.aiAvailable),
            "primary": .string(model.flow.step.primaryLabel),
        ]
        if let m = model.hotkeyMessage { o["hotkeyMessage"] = ["ok": .bool(m.ok), "text": .string(m.text)] }
        if let p = model.permissions { o["permissions"] = p.json }
        if let a = model.aiMessage { o["aiMessage"] = ["ok": .bool(a.ok), "text": .string(a.text)] }
        return .object(o)
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "getState": syncFromStore(); return stateJSON()
        case "setStep":
            guard let step = (args.stringValue ?? args["step"]?.stringValue).flatMap(OnboardingStep.init(rawValue:)) else { throw FeatureError.invalidArguments("Unknown step") }
            dispatch(.goto(step))
            return settings.json
        case "next": dispatch(.next); return stateJSON()
        case "back": dispatch(.back); return stateJSON()
        case "finish":
            dispatch(.finish)
            if model.flow.status != .completed { // finished from a closed window
                persist(OnboardingFlow.persistPatch(FlowState(step: .done, status: .completed), now: Date().timeIntervalSince1970 * 1000))
            }
            return settings.json
        case "skip":
            dispatch(.skip)
            if model.flow.status != .skipped { persist(OnboardingFlow.persistPatch(FlowState(status: .skipped), now: Date().timeIntervalSince1970 * 1000)) }
            return settings.json
        case "open": openWindow(restart: true); return true
        case "close": closeWindow(); return true
        case "key":
            let k = VimKey(args["key"]?.stringValue ?? "", ctrl: args["ctrl"]?.boolValue ?? false, meta: args["meta"]?.boolValue ?? false,
                           shift: args["shift"]?.boolValue ?? false, alt: args["alt"]?.boolValue ?? false)
            let handled = handleKey(k, target: TourKeyTarget(rawValue: args["target"]?.stringValue ?? "option") ?? .option)
            try? await Task.sleep(for: .milliseconds(30))
            guard case var .object(o) = stateJSON() else { return stateJSON() }
            o["handled"] = .bool(handled)
            return .object(o)
        case "setHotkey":
            let r = await setHotkey(args.stringValue ?? args["accelerator"]?.stringValue ?? "")
            return ["ok": .bool(r.ok), "hotkey": .string(r.hotkey), "error": r.error.map(JSONValue.string) ?? .null]
        case "useCommandSpace":
            let r = await useCommandSpace()
            return ["ok": .bool(r.ok), "hotkey": .string(r.hotkey), "error": r.error.map(JSONValue.string) ?? .null]
        case "checkHotkey": return HotkeyAdvice.conflict(args.stringValue ?? "").map(JSONValue.string) ?? .null
        case "permissions": refreshPermissions(); return permissionsSnapshot().json
        case "openPermissionSettings":
            guard let k = (args.stringValue ?? args["kind"]?.stringValue).flatMap(OnboardingPermission.init(rawValue:)) else { throw FeatureError.invalidArguments("Unknown permission") }
            return ["ok": true, "url": .string(await openPermissionSettings(k))]
        case "snapshot":
            let path = args["path"]?.stringValue ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-onboarding.png").path
            let snapModel = OnboardingModel()
            snapModel.flow = FlowState(step: (args["step"]?.stringValue).flatMap(OnboardingStep.init(rawValue:)) ?? model.flow.step)
            snapModel.hotkey = model.hotkey
            snapModel.hotkeyMessage = model.hotkeyMessage
            snapModel.permissions = permissionsSnapshot()
            snapModel.activeThemeId = model.activeThemeId
            snapModel.vimMode = model.vimMode
            snapModel.keepOpenAfterRun = model.keepOpenAfterRun
            snapModel.aiHasKey = model.aiHasKey
            snapModel.aiAvailable = model.aiAvailable
            snapModel.listIndex = model.listIndex
            let view = OnboardingRootView(model: snapModel, actions: self, snapshot: true)
            let size = try OffscreenSnapshot.render(view, size: CGSize(width: 720, height: 560), to: URL(fileURLWithPath: path))
            return OffscreenSnapshot.result(path: path, size: size)
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}
