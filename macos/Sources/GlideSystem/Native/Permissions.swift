import AppKit
import ApplicationServices
import GlideCore

/// TCC status (never prompts) and explicit requests (helper Services.swift Permissions). Polls every 2 s.
@MainActor public final class SystemPermissionService: PermissionService {
    private let wifi: CoreWLANService
    private let eventKit: EventKitStore
    private var timer: Timer?
    private var last: PermissionsStatus?
    public var onChange: ((PermissionsStatus) -> Void)?

    public init(wifi: CoreWLANService, eventKit: EventKitStore) {
        self.wifi = wifi
        self.eventKit = eventKit
    }

    public func status() -> PermissionsStatus {
        PermissionsStatus(accessibility: AXIsProcessTrusted(), inputMonitoring: CGPreflightListenEventAccess(),
                          calendar: EventKitStore.status(.event), reminders: EventKitStore.status(.reminder), location: wifi.locationStatus())
    }

    public func request(_ kind: PermissionKind) async -> PermissionsStatus {
        switch kind {
        case .accessibility:
            _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        case .inputMonitoring:
            _ = CGRequestListenEventAccess()
        case .calendar: await eventKit.requestAccess(.event)
        case .reminders: await eventKit.requestAccess(.reminder)
        case .location: _ = await wifi.requestLocation()
        }
        return status()
    }

    public func startWatching() {
        guard timer == nil else { return }
        last = status()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = self.status()
                if now != self.last {
                    self.last = now
                    self.onChange?(now)
                }
            }
        }
    }
}

/// The ⌘Space Spotlight shortcut (symbolic hotkey 64).
@MainActor public final class SpotlightShortcut: SpotlightShortcutService {
    private let domain = "com.apple.symbolichotkeys" as CFString
    private let key = "AppleSymbolicHotKeys" as CFString
    public init() {}

    private func hotkeys() -> [String: Any] {
        (CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? [String: Any]) ?? [:]
    }

    public func isEnabled() -> Bool {
        guard let entry = hotkeys()["64"] as? [String: Any] else { return true }
        return (entry["enabled"] as? NSNumber)?.boolValue ?? true
    }

    public func setEnabled(_ on: Bool) -> ServiceResult {
        var all = hotkeys()
        var entry = (all["64"] as? [String: Any]) ?? ["value": ["parameters": [32, 49, 1_048_576], "type": "standard"] as [String: Any]]
        entry["enabled"] = on
        all["64"] = entry
        CFPreferencesSetValue(key, all as CFDictionary, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { return .failure("Could not save the keyboard shortcut preference") }
        let tool = "/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings"
        if FileManager.default.isExecutableFile(atPath: tool) { _ = runTool(tool, ["-u"]) }
        return .success
    }
}

/// Run a command-line tool, returning (status, stdout).
@discardableResult
func runTool(_ path: String, _ args: [String]) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return (-1, "") }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}
