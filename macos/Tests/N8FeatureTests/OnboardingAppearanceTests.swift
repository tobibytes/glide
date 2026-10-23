import Foundation
import GlideCore
@testable import GlideFeatures
import Testing

@Suite("onboarding logic")
struct OnboardingLogicTests {
    @Test func flowReducer() {
        var s = FlowState()
        s = OnboardingFlow.reduce(s, .back)
        #expect(s == FlowState(step: .welcome))
        for _ in 0..<5 { s = OnboardingFlow.reduce(s, .next) }
        #expect(s.step == .done && s.status == .active)
        s = OnboardingFlow.reduce(s, .next)
        #expect(s.status == .completed)
        #expect(OnboardingFlow.reduce(s, .back) == s) // finished: only restart reopens
        #expect(OnboardingFlow.reduce(s, .restart) == FlowState())
        #expect(OnboardingFlow.reduce(FlowState(), .goto(.look)).step == .look)
        #expect(OnboardingFlow.reduce(FlowState(step: .ai), .skip).status == .skipped)
    }

    @Test func persistPatches() {
        #expect(OnboardingFlow.persistPatch(FlowState(step: .ai), now: 5) == ["started": true, "step": "ai"])
        #expect(OnboardingFlow.persistPatch(FlowState(step: .look, status: .completed), now: 5) == ["completed": true, "started": false, "step": "done", "finishedAt": 5.0])
        #expect(OnboardingFlow.persistPatch(FlowState(status: .skipped), now: 7) == ["skipped": true, "started": false, "finishedAt": 7.0])
    }

    @Test func normalizeSettings() {
        let s = OnboardingSettings(bag: ["completed": "yes", "step": "nope", "started": true, "finishedAt": 12])
        #expect(!s.completed && s.started && s.step == .welcome && s.finishedAt == 12)
        #expect(OnboardingSettings(bag: ["step": "look"]).step == .look)
    }

    @Test func firstRunDecision() {
        func sig(_ o: OnboardingSettings = .init(), env: Bool = false, old: Bool = false, usage: Int = 0, custom: Bool = false) -> FirstRunSignals {
            FirstRunSignals(onboarding: o, envSkip: env, dataPredatesLaunch: old, usageCount: usage, settingsCustomised: custom)
        }
        #expect(FirstRun.decide(sig()) == FirstRunDecision(show: true, reason: .firstRun))
        #expect(FirstRun.decide(sig(old: true)).reason == .existingInstall)
        #expect(FirstRun.decide(sig(usage: 3)).reason == .existingInstall)
        #expect(FirstRun.decide(sig(custom: true)).reason == .existingInstall)
        #expect(FirstRun.decide(sig(env: true)).reason == .envSkip)
        var started = OnboardingSettings(); started.started = true
        #expect(FirstRun.decide(sig(started, old: true)) == FirstRunDecision(show: true, reason: .resume))
        var done = OnboardingSettings(); done.completed = true; done.started = true
        #expect(FirstRun.decide(sig(done)).reason == .completed)
        var skipped = OnboardingSettings(); skipped.skipped = true
        #expect(FirstRun.decide(sig(skipped)).reason == .skipped)
    }

    @Test func customisedAndMtimes() {
        #expect(!FirstRun.settingsCustomised(Settings()))
        var s = Settings(); s.features["x"] = ["a": 1]
        #expect(!FirstRun.settingsCustomised(s)) // feature bags do not count
        s.vimMode = false
        #expect(FirstRun.settingsCustomised(s))
        #expect(FirstRun.predatesLaunch([10_000], launchedAtMs: 13_000))
        #expect(!FirstRun.predatesLaunch([11_500], launchedAtMs: 13_000))
        #expect(FirstRun.processStartMs() <= Date().timeIntervalSince1970 * 1000)
        #expect(FirstRun.processStartMs() > Date().timeIntervalSince1970 * 1000 - 3_600_000 * 24)
    }

    @Test func hotkeyAdvice() {
        #expect(HotkeyAdvice.canonical("Cmd+Shift+K") == "shift+command+k")
        #expect(HotkeyAdvice.canonical("Command+Space") == HotkeyAdvice.canonical("cmd+space"))
        #expect(HotkeyAdvice.conflict("Alt+Space") == nil)
        #expect(HotkeyAdvice.conflict("Command+Space")?.contains("Spotlight") == true)
        #expect(HotkeyAdvice.conflict("K")?.contains("modifier") == true)
        #expect(HotkeyAdvice.conflict("F5") == nil)
        #expect(HotkeyAdvice.conflict("Shift+K")?.contains("capital") == true)
        #expect(HotkeyAdvice.conflict("Cmd+Q")?.contains("quits") == true)
        #expect(HotkeyAdvice.choice(for: "Option+Space") == .alt)
        #expect(HotkeyAdvice.choice(for: "Cmd+Space") == .cmd)
        #expect(HotkeyAdvice.choice(for: "Ctrl+Alt+G") == .custom)
    }

    @Test func tourKeys() {
        #expect(TourKeys.command(VimKey("Enter"), target: .option) == .next)
        #expect(TourKeys.command(VimKey("Enter"), target: .text) == nil)
        #expect(TourKeys.command(VimKey("Enter", meta: true), target: .text) == .next)
        #expect(TourKeys.command(VimKey("[", meta: true), target: .other) == .back)
        #expect(TourKeys.command(VimKey("Escape"), target: .option) == .back)
        #expect(TourKeys.command(VimKey("j"), target: .option) == .listNext)
        #expect(TourKeys.command(VimKey("j"), target: .text) == nil)
        #expect(TourKeys.command(VimKey("k", ctrl: true), target: .option) == .listPrev)
        #expect(TourKeys.command(VimKey("ArrowDown"), target: .button) == .listNext)
    }

    @Test func permissionMapping() {
        let s = PermissionsStatus(accessibility: true, inputMonitoring: false, calendar: "authorized", reminders: "notDetermined", location: "denied")
        let m = PermissionMapping.map(s, screenRecording: nil)
        #expect(m[.accessibility] == .granted && m[.inputMonitoring] == .denied && m[.calendars] == .granted && m[.reminders] == .notDetermined && m[.screenRecording] == .unknown)
        let fake = PermissionMapping.parseFake(["accessibility": "granted", "reminders": true, "calendars": "bogus"])
        #expect(fake?[.accessibility] == .granted && fake?[.reminders] == .granted && fake?[.calendars] == .unknown)
        #expect(PermissionMapping.parseFake("x") == nil)
        #expect(OnboardingPermission.allCases.allSatisfy { $0.paneURL.hasPrefix("x-apple.systempreferences:") })
    }

    @Test func cheatSheet() {
        let rows = CheatSheet.rows(hotkey: "Alt+Space")
        #expect(rows.count == 8 && rows[0].keys == "⌥␣")
    }

    @Test func recorder() {
        #expect(AcceleratorRecorder.accelerator(keyCode: 49, characters: " ", command: false, option: true, control: false, shift: false) == "Alt+Space")
        #expect(AcceleratorRecorder.accelerator(keyCode: 40, characters: "k", command: true, option: false, control: true, shift: true) == "Control+Shift+Command+K")
        #expect(AcceleratorRecorder.accelerator(keyCode: 999, characters: "\u{1}", command: true, option: false, control: false, shift: false) == nil)
    }
}

@Suite("onboarding feature (headless)", .serialized)
@MainActor struct OnboardingFeatureTests {
    @Test func freshInstallOpensStateOnlyAndPersists() async throws {
        let ctx = try N8TestContext(featureId: "onboarding")
        let f = OnboardingFeature()
        await f.start(context: ctx)
        #expect(f.decision == FirstRunDecision(show: true, reason: .firstRun))
        f.openWindow()
        #expect(f.model.windowOpen) // state only: services are headless, no NSWindow
        #expect(OnboardingSettings(bag: ctx.store.settings.features["onboarding"] ?? [:]).started)
        f.dispatch(.next)
        #expect(OnboardingSettings(bag: ctx.store.settings.features["onboarding"] ?? [:]).step == .hotkey)
        // j/k move within the hotkey options; Enter on the current choice continues.
        #expect(f.handleKey(VimKey("j")))
        #expect(f.model.listIndex == 1)
        #expect(f.handleKey(VimKey("k")))
        f.handleKey(VimKey("Enter"))
        #expect(f.model.flow.step == .permissions)
        #expect(f.model.permissions != nil)
        f.dispatch(.skip)
        let s = OnboardingSettings(bag: ctx.store.settings.features["onboarding"] ?? [:])
        #expect(s.skipped && !s.started && !f.model.windowOpen)
        await f.stop()
    }

    @Test func existingInstallSkips() async throws {
        let ctx = try N8TestContext(featureId: "onboarding")
        ctx.store.setUsage([UsageRecord(itemId: "app:/A.app", launches: [1], count: 1, lastLaunchedAt: 1)])
        let f = OnboardingFeature()
        await f.start(context: ctx)
        #expect(f.decision?.reason == .existingInstall)
        await f.stop()
    }

    @Test func setHotkeyRules() async throws {
        let ctx = try N8TestContext(featureId: "onboarding")
        let f = OnboardingFeature()
        await f.start(context: ctx)
        var r = await f.setHotkey("Cmd+Q")
        #expect(!r.ok && ctx.store.settings.hotkey == "Alt+Space")
        r = await f.setHotkey("Control+Alt+G")
        #expect(r.ok && ctx.store.settings.hotkey == "Control+Alt+G")
        // ⌘Space without the keyboard feature: Spotlight's shortcut is turned off (headless: recorded) and the hotkey set.
        r = await f.useCommandSpace()
        #expect(r.ok && ctx.store.settings.hotkey == "Command+Space")
        #expect(ctx.sideEffects.all.contains { $0.kind == "spotlight-shortcut" })
        await f.stop()
    }

    @Test func openPermissionSettingsOnlyOnRequest() async throws {
        let ctx = try N8TestContext(featureId: "onboarding")
        let f = OnboardingFeature()
        await f.start(context: ctx)
        #expect(!ctx.sideEffects.all.contains { $0.kind == "permission-request" })
        let url = await f.openPermissionSettings(.reminders)
        #expect(url.contains("Privacy_Reminders"))
        #expect(ctx.sideEffects.all.contains { $0.kind == "open-url" })
        await f.stop()
    }
}

@Suite("appearance", .serialized)
@MainActor struct AppearanceTests {
    @Test func setNormalisesAndKeepsMaterial() throws {
        let ctx = try N8TestContext(featureId: "appearance")
        let a = AppearanceStore(store: ctx.store, systemDark: { true })
        a.set(["fontSize": 99, "density": "compact", "accent": "#ABC", "material": "sidebar", "darkTheme": "nope"])
        let bag = ctx.store.settings.features["appearance"] ?? [:]
        #expect(bag["fontSize"] == 17 && bag["density"] == "compact" && bag["accent"] == "#aabbcc" && bag["darkTheme"] == "glide-dark")
        #expect(a.material == .sidebar)
        a.set(["radius": 3])
        #expect(a.material == .sidebar && a.settings.radius == 3)
        a.reset()
        #expect(a.isDefault)
    }

    @Test func applyPresetSwitchesSlotAndMode() throws {
        let ctx = try N8TestContext(featureId: "appearance")
        let a = AppearanceStore(store: ctx.store, systemDark: { true })
        #expect(a.applyPreset("nord").ok)
        #expect(a.settings.darkTheme == "nord" && a.mode == "system") // system already dark
        a.applyPreset("dawn")
        #expect(a.settings.lightTheme == "dawn" && a.mode == "light" && a.active.id == "dawn")
        #expect(a.toggleLightDark() == "dark")
        #expect(a.active.id == "nord")
        #expect(!a.applyPreset("missing").ok)
        a.setSlot("mocha")
        #expect(a.settings.darkTheme == "mocha" && a.mode == "dark")
    }

    @Test func switcherRows() {
        let rows = ThemeSwitcher.rows(query: "", activeId: "dracula")
        #expect(rows.count == 9 && rows[0].preset.id == "dracula" && rows[0].section == "Current")
        #expect(rows.dropFirst().prefix(6).allSatisfy { $0.preset.scheme == .dark })
        #expect(ThemeSwitcher.rows(query: "light", activeId: "nord").map(\.preset.id) == ["glide-light", "dawn"])
        let m = ThemeSwitcherModel(activeId: "nord")
        m.move(-1); #expect(m.selectedIndex == 0)
        m.move(20); #expect(m.selectedIndex == 8)
    }

    @Test func switchViewPreviewAndApply() async throws {
        let ctx = try N8TestContext(featureId: "appearance")
        let f = AppearanceFeature()
        await f.start(context: ctx)
        #expect(f.items().map(\.id) == ["appearance:switch", "appearance:toggle", "appearance:settings"])
        #expect(f.handleKey(VimKey("j"), view: AppearanceFeature.switchView))
        let first = ThemePreview.presetId
        #expect(first != nil && ctx.refreshes > 0)
        #expect(f.handleKey(VimKey("Enter"), view: AppearanceFeature.switchView))
        #expect(ThemePreview.presetId == nil)
        let st = try await f.invoke(method: "get", args: .null)
        #expect(st["active"]?.stringValue == first)
        #expect(!f.handleKey(VimKey("x"), view: AppearanceFeature.switchView))
        await f.stop()
    }

    @Test func materials() {
        #expect(VibrancyMaterial(bag: nil) == .hudWindow)
        #expect(VibrancyMaterial(bag: ["material": "menu"]).nsMaterial == .menu)
        #expect(VibrancyMaterial.allCases.count == 9)
    }
}
