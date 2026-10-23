import AppKit
import GlideCore

// Headless implementations: never touch the screen, pasteboard, other apps, hotkeys, taps or TCC prompts.
// Side effects are recorded in SideEffectLog. Only harmless read-only calls hit the real system
// (permission status, frontmost app info, Wi-Fi info, display list, Spotlight pref read, Vision OCR on a file).

@MainActor public final class HeadlessWorkspace: WorkspaceService {
    let log: SideEffectLog
    public init(log: SideEffectLog) { self.log = log }
    public func open(url: URL, withApp: String?) -> ServiceResult {
        log.record("open-url", ["url": .string(url.absoluteString), "app": withApp.map(JSONValue.string) ?? .null])
        return .success
    }
    public func open(path: String) -> ServiceResult {
        log.record("open-path", ["path": .string(path)])
        return .success
    }
    public func reveal(path: String) { log.record("reveal", ["path": .string(path)]) }
    public func launchApplication(_ app: String) -> ServiceResult {
        log.record("launch-app", ["app": .string(app)])
        return .success
    }
}

/// In-memory pasteboard (the real one is never read or written in headless mode).
@MainActor public final class FakePasteboard: PasteboardService {
    let log: SideEffectLog
    public private(set) var text: String?
    public private(set) var html: String?
    public private(set) var changeCount = 0
    public init(log: SideEffectLog) { self.log = log }
    public func string() -> String? { text }
    public func setString(_ text: String, html: String?, transient: Bool) {
        self.text = text
        self.html = html
        changeCount += 1
        image = nil
        files = []
        log.record("pasteboard-set", ["text": .string(text), "transient": .bool(transient)])
    }
    public private(set) var image: Data?
    public private(set) var files: [URL] = []
    public func imagePNG() -> Data? { image }
    public func setImagePNG(_ png: Data, transient: Bool) {
        text = nil; html = nil; files = []
        image = png
        changeCount += 1
        log.record("pasteboard-image", ["bytes": .int(Int64(png.count)), "transient": .bool(transient)])
    }
    public func fileURLs() -> [URL] { files }
    public func setFileURLs(_ urls: [URL]) {
        text = nil; html = nil; image = nil
        files = urls
        changeCount += 1
        log.record("pasteboard-files", ["paths": .array(urls.map { .string($0.path) })])
    }
}

@MainActor public final class HeadlessPaste: PasteService {
    let log: SideEffectLog
    public init(log: SideEffectLog) { self.log = log }
    public func paste(text: String, html: String?) { log.record("paste", ["text": .string(text), "html": html.map(JSONValue.string) ?? .null]) }
}

@MainActor public final class HeadlessNotifications: NotificationService {
    let log: SideEffectLog
    public init(log: SideEffectLog) { self.log = log }
    public func notify(title: String, body: String?) { log.record("notify", ["title": .string(title), "body": body.map(JSONValue.string) ?? .null]) }
}

/// AppleScript / shell are NOT executed (they launch and drive other apps).
@MainActor public final class HeadlessScripts: ScriptService {
    let log: SideEffectLog
    public init(log: SideEffectLog) { self.log = log }
    public func runAppleScript(_ source: String) async throws -> String {
        log.record("applescript", ["source": .string(source)])
        return ""
    }
    public func runShell(_ command: String, shell: String, timeout: TimeInterval) async throws -> ShellResult {
        log.record("shell", ["command": .string(command), "shell": .string(shell)])
        return ShellResult(status: 0, stdout: "", stderr: "")
    }
}

/// Answers confirmations without UI. GLIDE_HEADLESS_CONFIRM=0 answers "Cancel".
@MainActor public final class HeadlessConfirmation: ConfirmationService {
    let log: SideEffectLog
    public var answer: Bool
    public init(log: SideEffectLog, answer: Bool) {
        self.log = log
        self.answer = answer
    }
    public func confirm(title: String, message: String, confirmButton: String) async -> Bool {
        log.record("confirm", ["title": .string(title), "message": .string(message), "answer": .bool(answer)])
        return answer
    }
}

/// Selection comes from GLIDE_HEADLESS_SELECTION (never reads or wakes another app's AX tree).
@MainActor public final class HeadlessSelection: SelectionService {
    public var text: String?
    public init(text: String?) { self.text = text }
    public func selectedText() async -> SelectionResult {
        SelectionResult(text: text, app: text == nil ? nil : "Headless", reason: text == nil ? "no-selected-text" : nil)
    }
}

@MainActor public final class HeadlessWindows: WindowService {
    let log: SideEffectLog
    public init(log: SideEffectLog) { self.log = log }
    public func apply(_ action: String) async -> ServiceResult {
        log.record("window", ["action": .string(action)])
        return .success
    }
}

@MainActor public final class HeadlessMenus: MenuService {
    let log: SideEffectLog
    public init(log: SideEffectLog) { self.log = log }
    public func list(pid: Int32?) async -> [MenuItemInfo] {
        [MenuItemInfo(path: ["File", "New Window"], enabled: true, shortcut: "⌘N"), MenuItemInfo(path: ["Edit", "Copy"], enabled: true, shortcut: "⌘C")]
    }
    public func press(pid: Int32?, path: [String]) async -> ServiceResult {
        log.record("menu-press", ["path": .array(path.map(JSONValue.string))])
        return .success
    }
}

/// Parses bindings (so errors surface) but registers nothing. `simulate(id:)` fires a press.
@MainActor public final class HeadlessHotkeys: HotkeyService {
    let log: SideEffectLog
    public var onPress: ((String) -> Void)?
    public private(set) var bindings: [HotkeyBinding] = []
    public init(log: SideEffectLog) { self.log = log }
    public func set(_ bindings: [HotkeyBinding]) -> HotkeyRegistration {
        self.bindings = bindings
        var out = HotkeyRegistration()
        for b in bindings {
            switch HotkeyParser.parse(b.accelerator) {
            case .success: out.registered.append(b.id)
            case let .failure(e): out.failed.append(.init(id: b.id, reason: e.localizedDescription))
            }
        }
        log.record("hotkeys-set", .array(bindings.map { ["id": .string($0.id), "accelerator": .string($0.accelerator)] }))
        return out
    }
    public func unregisterAll() { bindings = [] }
    public func simulate(id: String) { onPress?(id) }
}

@MainActor public final class HeadlessKeyboardTap: KeyboardTapService {
    let log: SideEffectLog
    public var onEvent: ((KeyboardTapEvent) -> Void)?
    public init(log: SideEffectLog) { self.log = log }
    public func configure(_ config: KeyboardTapConfig) -> String? {
        log.record("keyboard-tap-config", ["snippets": .int(Int64(config.snippets.count)), "hyper": .bool(config.hyperKey), "pasteStack": .bool(config.pasteStack)])
        return nil
    }
    public func finishExpansion(reqId: Int, text: String?, html: String?, cursorLeft: Int?) -> Bool { false }
    public func applyStackReply(reqId: Int, text: String?, html: String?, passthrough: Bool, empty: Bool, active: Bool?) -> Bool { false }
    public func shutdown() {}
}

/// Real read-only status; `request` never prompts (recorded instead).
@MainActor public final class HeadlessPermissions: PermissionService {
    let log: SideEffectLog
    public var onChange: ((PermissionsStatus) -> Void)?
    public init(log: SideEffectLog) { self.log = log }
    public func status() -> PermissionsStatus {
        PermissionsStatus(accessibility: AXIsProcessTrusted(), inputMonitoring: CGPreflightListenEventAccess(),
                          calendar: EventKitStore.status(.event), reminders: EventKitStore.status(.reminder), location: "notDetermined")
    }
    public func request(_ kind: PermissionKind) async -> PermissionsStatus {
        log.record("permission-request", ["kind": .string(kind.rawValue)])
        return status()
    }
}

@MainActor public final class HeadlessEventKit: EventKitService {
    public init() {}
    private func unavailable() -> FeatureError { .failed("EventKit is not available in headless mode") }
    public func calendarEvents(from: Date, to: Date) async throws -> JSONValue { throw unavailable() }
    public func reminderLists() async throws -> JSONValue { throw unavailable() }
    public func reminders(listId: String?, includeCompleted: Bool) async throws -> JSONValue { throw unavailable() }
    public func createReminder(_ params: JSONValue) async throws -> JSONValue { throw unavailable() }
    public func completeReminder(id: String, completed: Bool) async throws -> JSONValue { throw unavailable() }
}

@MainActor public final class HeadlessFinder: FinderService {
    public init() {}
    public func selection() async -> FinderSelectionResult { .init(paths: [], folder: nil, source: "none", error: "headless") }
    public func selectionViaAutomation() async -> FinderSelectionResult { .init(paths: [], folder: nil, source: "none", error: "headless") }
}

@MainActor public final class HeadlessColorPicker: ColorPickerService {
    let log: SideEffectLog
    public init(log: SideEffectLog) { self.log = log }
    public func pick(timeout: TimeInterval) async -> PickedColor {
        log.record("color-pick")
        return PickedColor(hex: "#F5A524", r: 245, g: 165, b: 36, a: 1)
    }
}

/// Real displays/apps listing (read-only); capture/move/quit are recorded.
@MainActor public final class HeadlessLayouts: LayoutService {
    let log: SideEffectLog
    let real: AXLayoutService
    public init(log: SideEffectLog, frontmost: FrontmostTracker) {
        self.log = log
        real = AXLayoutService(frontmost: frontmost)
    }
    public func displays() -> JSONValue { real.displays() }
    public func runningApps() -> JSONValue { real.runningApps() }
    public func capture(includeHidden: Bool) async -> JSONValue { ["ok": true, "displays": real.displays(), "windows": []] }
    public func move(_ moves: JSONValue) async -> JSONValue {
        log.record("layout-move", moves)
        return ["ok": true, "results": []]
    }
    public func quit(bundleIds: [String]) -> JSONValue {
        log.record("quit-apps", .array(bundleIds.map(JSONValue.string)))
        return ["ok": true, "asked": []]
    }
}

@MainActor public final class HeadlessSpotlight: SpotlightShortcutService {
    let log: SideEffectLog
    public init(log: SideEffectLog) { self.log = log }
    public func isEnabled() -> Bool { SpotlightShortcut().isEnabled() }
    public func setEnabled(_ enabled: Bool) -> ServiceResult {
        log.record("spotlight-shortcut", ["enabled": .bool(enabled)])
        return .success
    }
}

@MainActor public final class HeadlessWiFi: WiFiService {
    public init() {}
    public func info() -> JSONValue { ["ssid": .null, "connected": false, "locationStatus": "notDetermined", "needsLocation": false, "headless": true] }
}
