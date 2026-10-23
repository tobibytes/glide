import AppKit
import GlideCore

public enum SystemServicesFactory {
    /// Real services (the app). Creating them registers nothing by itself: hotkeys/taps start only when
    /// `set` / `configure` is called; permissions are only prompted from `request`.
    @MainActor public static func live(frontmost: FrontmostTracker) -> SystemServices {
        let hotkeys = CarbonHotkeyService()
        let paste = SystemPasteService()
        let wifi = CoreWLANService()
        let eventKit = EventKitStore()
        let keyboard = EventTapKeyboardService(hotkeys: hotkeys, paster: paste)
        let permissions = SystemPermissionService(wifi: wifi, eventKit: eventKit)
        permissions.onChange = { _ in keyboard.retryIfNeeded(); hotkeys.refresh() } // + the Keyboard feature re-configures
        frontmost.onActivate = { keyboard.resetBuffer() }
        let services = SystemServices(
            workspace: SystemWorkspaceService(), pasteboard: SystemPasteboardService(), paste: paste,
            notifications: SystemNotificationService(), scripts: SystemScriptService(), confirmation: AlertConfirmationService(),
            frontmost: frontmost, selection: AXSelectionService(frontmost: frontmost), windows: AXWindowService(frontmost: frontmost),
            menus: AXMenuService(frontmost: frontmost), hotkeys: hotkeys, keyboardTap: keyboard, permissions: permissions,
            ocr: VisionOCRService(), eventKit: eventKit, finder: FinderSelectionService(), wifi: wifi, colorPicker: SamplerColorPicker(),
            layouts: AXLayoutService(frontmost: frontmost), spotlight: SpotlightShortcut(), isHeadless: false)
        services.statusItems = SystemStatusItemService() // NSStatusItems are created only when an item is shown
        return services
    }

    /// Headless services: fakes for every side effect, harmless real reads only.
    @MainActor public static func headless(log: SideEffectLog, environment: [String: String] = ProcessInfo.processInfo.environment) -> SystemServices {
        let frontmost = FrontmostTracker()
        let services = SystemServices(
            workspace: HeadlessWorkspace(log: log), pasteboard: FakePasteboard(log: log), paste: HeadlessPaste(log: log),
            notifications: HeadlessNotifications(log: log), scripts: HeadlessScripts(log: log),
            confirmation: HeadlessConfirmation(log: log, answer: environment["GLIDE_HEADLESS_CONFIRM"] != "0"),
            frontmost: frontmost, selection: HeadlessSelection(text: environment["GLIDE_HEADLESS_SELECTION"]), windows: HeadlessWindows(log: log),
            menus: HeadlessMenus(log: log), hotkeys: HeadlessHotkeys(log: log), keyboardTap: HeadlessKeyboardTap(log: log),
            permissions: HeadlessPermissions(log: log), ocr: VisionOCRService(), eventKit: HeadlessEventKit(), finder: HeadlessFinder(),
            wifi: HeadlessWiFi(), colorPicker: HeadlessColorPicker(log: log), layouts: HeadlessLayouts(log: log, frontmost: frontmost),
            spotlight: HeadlessSpotlight(log: log), isHeadless: true)
        services.statusItems = HeadlessStatusItems(log: log) // records only; never an NSStatusItem
        return services
    }
}
