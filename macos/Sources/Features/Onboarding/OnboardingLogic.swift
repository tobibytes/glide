import Foundation
import GlideCore

// Pure onboarding model, ported from src/main/features/onboarding/{steps,firstrun,system}.ts and
// src/renderer/features/onboarding/keys.ts. No AppKit: unit-tested directly.

public enum OnboardingStep: String, CaseIterable, Sendable, Codable {
    case welcome, hotkey, permissions, ai, look, done

    public var label: String {
        switch self {
        case .welcome: return "Welcome"
        case .hotkey: return "Hotkey"
        case .permissions: return "Permissions"
        case .ai: return "AI"
        case .look: return "Look & Feel"
        case .done: return "Done"
        }
    }

    public var primaryLabel: String {
        switch self {
        case .welcome: return "Get Started"
        case .done: return "Open Glide"
        default: return "Continue"
        }
    }

    public var index: Int { Self.allCases.firstIndex(of: self) ?? 0 }
}

/// `settings.features.onboarding` (same keys as the Electron app).
public struct OnboardingSettings: Equatable, Sendable {
    public var completed = false
    public var skipped = false
    public var started = false
    public var step: OnboardingStep = .welcome
    public var finishedAt: Double = 0
    public init() {}

    public static let defaults: [String: JSONValue] = ["completed": false, "skipped": false, "started": false, "step": "welcome", "finishedAt": 0]

    /// normalizeOnboarding: tolerant of anything stored.
    public init(bag: [String: JSONValue]) {
        completed = bag["completed"]?.boolValue == true
        skipped = bag["skipped"]?.boolValue == true
        started = bag["started"]?.boolValue == true
        step = bag["step"]?.stringValue.flatMap(OnboardingStep.init(rawValue:)) ?? .welcome
        if let f = bag["finishedAt"]?.doubleValue, f.isFinite { finishedAt = f }
    }

    public var bag: [String: JSONValue] {
        ["completed": .bool(completed), "skipped": .bool(skipped), "started": .bool(started), "step": .string(step.rawValue), "finishedAt": .double(finishedAt)]
    }

    public var json: JSONValue { .object(bag) }
}

public enum FlowStatus: String, Sendable { case active, completed, skipped }

public struct FlowState: Equatable, Sendable {
    public var step: OnboardingStep
    public var status: FlowStatus
    public init(step: OnboardingStep = .welcome, status: FlowStatus = .active) {
        self.step = step
        self.status = status
    }
}

public enum FlowAction: Equatable, Sendable {
    case next, back, goto(OnboardingStep), skip, finish, restart
}

public enum OnboardingFlow {
    /// next on the last step finishes; back on the first stays; once finished only restart reopens.
    public static func reduce(_ s: FlowState, _ a: FlowAction) -> FlowState {
        if s.status != .active, a != .restart { return s }
        let all = OnboardingStep.allCases
        let i = s.step.index
        switch a {
        case .next: return i >= all.count - 1 ? FlowState(step: s.step, status: .completed) : FlowState(step: all[i + 1], status: .active)
        case .back: return i <= 0 ? s : FlowState(step: all[i - 1], status: .active)
        case let .goto(step): return FlowState(step: step, status: .active)
        case .skip: return FlowState(step: s.step, status: .skipped)
        case .finish: return FlowState(step: s.step, status: .completed)
        case .restart: return FlowState()
        }
    }

    /// Settings patch that persists a flow state.
    public static func persistPatch(_ s: FlowState, now: Double) -> [String: JSONValue] {
        switch s.status {
        case .completed: return ["completed": true, "started": false, "step": "done", "finishedAt": .double(now)]
        case .skipped: return ["skipped": true, "started": false, "finishedAt": .double(now)]
        case .active: return ["started": true, "step": .string(s.step.rawValue)]
        }
    }
}

// MARK: - first run

public enum FirstRunReason: String, Sendable { case completed, skipped, envSkip = "env-skip", resume, existingInstall = "existing-install", firstRun = "first-run" }

public struct FirstRunDecision: Equatable, Sendable {
    public var show: Bool
    public var reason: FirstRunReason
}

public struct FirstRunSignals: Sendable {
    public var onboarding: OnboardingSettings
    public var envSkip: Bool
    public var dataPredatesLaunch: Bool
    public var usageCount: Int
    public var settingsCustomised: Bool
    public init(onboarding: OnboardingSettings, envSkip: Bool, dataPredatesLaunch: Bool, usageCount: Int, settingsCustomised: Bool) {
        self.onboarding = onboarding
        self.envSkip = envSkip
        self.dataPredatesLaunch = dataPredatesLaunch
        self.usageCount = usageCount
        self.settingsCustomised = settingsCustomised
    }
}

public enum FirstRun {
    public static func decide(_ s: FirstRunSignals) -> FirstRunDecision {
        if s.onboarding.completed { return FirstRunDecision(show: false, reason: .completed) }
        if s.onboarding.skipped { return FirstRunDecision(show: false, reason: .skipped) }
        if s.envSkip { return FirstRunDecision(show: false, reason: .envSkip) }
        // Opened before but not finished (e.g. quit half-way): pick up where the user left off.
        if s.onboarding.started { return FirstRunDecision(show: true, reason: .resume) }
        if s.dataPredatesLaunch || s.usageCount > 0 || s.settingsCustomised { return FirstRunDecision(show: false, reason: .existingInstall) }
        return FirstRunDecision(show: true, reason: .firstRun)
    }

    /// True when a global setting (other than the feature bags) differs from the defaults.
    public static func settingsCustomised(_ s: Settings, defaults d: Settings = .defaults) -> Bool {
        s.hotkey != d.hotkey || s.theme != d.theme || s.disabledSources != d.disabledSources || s.appDirectories != d.appDirectories
            || s.fileSearch != d.fileSearch || s.calculator != d.calculator || s.sectionLimit != d.sectionLimit || s.hideOnBlur != d.hideOnBlur
            || s.keepOpenAfterRun != d.keepOpenAfterRun || s.frecencyHalfLifeDays != d.frecencyHalfLifeDays || s.vimMode != d.vimMode
            || s.launchAtLogin != d.launchAtLogin
    }

    /// Whether any mtime is older than the launch (with slack for clock/fs rounding).
    public static func predatesLaunch(_ mtimesMs: [Double], launchedAtMs: Double, slackMs: Double = 2000) -> Bool {
        mtimesMs.contains { $0 < launchedAtMs - slackMs }
    }

    /// mtimes (ms) of the data dir's files: top level and one level into features/.
    public static func dataMtimes(root: URL) -> [Double] {
        let fm = FileManager.default
        var out: [Double] = []
        func scan(_ dir: URL, _ depth: Int) {
            guard let names = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey]) else { return }
            for u in names {
                guard let v = try? u.resourceValues(forKeys: [.contentModificationDateKey, .isDirectoryKey]) else { continue }
                if v.isDirectory == true { if depth > 0 { scan(u, depth - 1) } }
                else if let d = v.contentModificationDate { out.append(d.timeIntervalSince1970 * 1000) }
            }
        }
        scan(root, 0)
        scan(root.appendingPathComponent("features", isDirectory: true), 1)
        return out
    }

    /// This process's start time (ms since 1970), from the kernel (sysctl KERN_PROC_PID).
    public static func processStartMs() -> Double {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let ok = mib.withUnsafeMutableBufferPointer { sysctl($0.baseAddress, 4, &info, &size, nil, 0) } == 0
        guard ok else { return (Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime.truncatingRemainder(dividingBy: 1)) * 1000 }
        let tv = info.kp_proc.p_starttime
        return Double(tv.tv_sec) * 1000 + Double(tv.tv_usec) / 1000
    }
}

// MARK: - hotkeys

public enum HotkeyAdvice {
    private static let modAliases: [String: String] = [
        "cmd": "command", "command": "command", "cmdorctrl": "command", "commandorcontrol": "command", "super": "command", "meta": "command",
        "ctrl": "control", "control": "control", "alt": "option", "option": "option", "altgr": "option", "shift": "shift",
    ]
    private static let modOrder = ["control", "option", "shift", "command"]

    /// Canonical lower-case form ("Cmd+Space" and "Command+Space" → "command+space").
    public static func canonical(_ accel: String) -> String {
        let parts = accel.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        var mods: [String] = []
        for p in parts { if let m = modAliases[p], !mods.contains(m) { mods.append(m) } }
        mods.sort { (modOrder.firstIndex(of: $0) ?? 0) < (modOrder.firstIndex(of: $1) ?? 0) }
        let keys = parts.filter { modAliases[$0] == nil }
        return (mods + keys).joined(separator: "+")
    }

    static let known: [String: String] = [
        "command+space": "Spotlight uses ⌘Space. Choose “Use ⌘Space” to hand it over to Glide.",
        "option+command+space": "Finder's search window uses ⌥⌘Space.",
        "control+space": "macOS uses ⌃Space to switch input sources.",
        "control+option+space": "macOS uses ⌃⌥Space to switch to the next input source.",
        "command+tab": "⌘Tab is the app switcher.",
        "command+q": "⌘Q quits the front app.",
        "command+w": "⌘W closes windows in every app.",
        "command+h": "⌘H hides the front app.",
        "command+m": "⌘M minimises windows in every app.",
        "command+c": "⌘C is Copy.",
        "command+v": "⌘V is Paste.",
        "command+x": "⌘X is Cut.",
        "command+z": "⌘Z is Undo.",
        "command+a": "⌘A is Select All.",
        "command+s": "⌘S is Save.",
        "shift+command+3": "⇧⌘3 takes a screenshot.",
        "shift+command+4": "⇧⌘4 takes a screenshot.",
        "shift+command+5": "⇧⌘5 opens the screenshot toolbar.",
    ]

    /// A known clash with a macOS or near-universal app shortcut, or nil.
    public static func conflict(_ accel: String) -> String? {
        let c = canonical(accel)
        if c.isEmpty { return "Press a key combination." }
        if let k = known[c] { return k }
        let parts = c.split(separator: "+").map(String.init)
        guard let key = parts.last else { return "Press a key combination." }
        let mods = parts.dropLast()
        let isFKey = key.hasPrefix("f") && key.count <= 3 && key.dropFirst().allSatisfy(\.isNumber) && key.count > 1
        if mods.isEmpty && !isFKey { return "Add a modifier (⌘, ⌥, ⌃ or ⇧) so typing isn't intercepted." }
        if mods.count == 1 && mods.first == "shift" { return "⇧ alone would capture capital letters while you type." }
        return nil
    }

    public enum Choice: String, Sendable { case alt, cmd, custom }
    public static func choice(for accel: String) -> Choice {
        switch canonical(accel) {
        case "option+space": return .alt
        case "command+space": return .cmd
        default: return .custom
        }
    }
}

// MARK: - permissions checklist

public enum OnboardingPermission: String, CaseIterable, Sendable {
    case accessibility, inputMonitoring, screenRecording, calendars, reminders

    public var title: String {
        switch self {
        case .accessibility: return "Accessibility"
        case .inputMonitoring: return "Input Monitoring"
        case .screenRecording: return "Screen Recording"
        case .calendars: return "Calendars"
        case .reminders: return "Reminders"
        }
    }
    public var why: String {
        switch self {
        case .accessibility: return "Move and resize windows, search menus, read selected text and paste into apps."
        case .inputMonitoring: return "Expand snippets as you type and turn Caps Lock into a Hyper key."
        case .screenRecording: return "Grab text and QR codes from anything on screen."
        case .calendars: return "Show today's events and join meetings from the launcher."
        case .reminders: return "Create and complete reminders without opening the app."
        }
    }
    public var symbol: String {
        switch self {
        case .accessibility: return "macwindow.on.rectangle"
        case .inputMonitoring: return "keyboard"
        case .screenRecording: return "rectangle.dashed.badge.record"
        case .calendars: return "calendar"
        case .reminders: return "checklist"
        }
    }
    public var paneURL: String {
        switch self {
        case .accessibility: return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .inputMonitoring: return "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        case .screenRecording: return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case .calendars: return "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
        case .reminders: return "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"
        }
    }
    /// The PermissionService kind that adds Glide to the pane's list (nil: screen recording has none).
    public var requestKind: PermissionKind? {
        switch self {
        case .accessibility: return .accessibility
        case .inputMonitoring: return .inputMonitoring
        case .calendars: return .calendar
        case .reminders: return .reminders
        case .screenRecording: return nil
        }
    }
}

public enum PermissionState: String, Sendable { case granted, denied, notDetermined, unknown
    public var pill: String {
        switch self {
        case .granted: return "Granted"
        case .denied: return "Not granted"
        case .notDetermined: return "Not asked yet"
        case .unknown: return "Unknown"
        }
    }
}

public struct PermissionsSnapshot: Equatable, Sendable {
    /// "system" (PermissionService) or "fake" (GLIDE_ONBOARDING_FAKE_PERMISSIONS, headless only).
    public var source: String
    public var status: [OnboardingPermission: PermissionState]
    public var checkedAt: Double
    public var grantedCount: Int { status.values.filter { $0 == .granted }.count }
    public var json: JSONValue {
        var s: [String: JSONValue] = [:]
        for k in OnboardingPermission.allCases { s[k.rawValue] = .string((status[k] ?? .unknown).rawValue) }
        return ["source": .string(source), "status": .object(s), "checkedAt": .double(checkedAt)]
    }
}

public enum PermissionMapping {
    public static func fromAuth(_ v: String?) -> PermissionState {
        switch v {
        case "authorized", "granted", "fullAccess": return .granted
        case "denied", "restricted": return .denied
        case "notDetermined", "not-determined": return .notDetermined
        default: return .unknown
        }
    }
    public static func fromBool(_ v: Bool?) -> PermissionState { v.map { $0 ? .granted : .denied } ?? .unknown }

    public static func map(_ s: PermissionsStatus?, screenRecording: Bool?) -> [OnboardingPermission: PermissionState] {
        [.accessibility: fromBool(s?.accessibility), .inputMonitoring: fromBool(s?.inputMonitoring), .screenRecording: fromBool(screenRecording),
         .calendars: fromAuth(s?.calendar), .reminders: fromAuth(s?.reminders)]
    }

    /// Test fake ({ "accessibility": "granted", … }); unknown kinds/values are ignored.
    public static func parseFake(_ raw: JSONValue) -> [OnboardingPermission: PermissionState]? {
        guard let o = raw.objectValue else { return nil }
        var out: [OnboardingPermission: PermissionState] = [:]
        for k in OnboardingPermission.allCases {
            switch o[k.rawValue] {
            case let .string(s): out[k] = PermissionState(rawValue: s) ?? .unknown
            case let .bool(b): out[k] = fromBool(b)
            default: out[k] = .unknown
            }
        }
        return out
    }
}

// MARK: - keyboard

public enum TourKeyCommand: String, Sendable { case next, back, listNext, listPrev }
public enum TourKeyTarget: String, Sendable { case text, button, option, other }

public enum TourKeys {
    /// Enter = continue (buttons and text fields keep their own Enter), ⌘⏎ / ⌘] = continue anywhere,
    /// Esc / ⌘[ = back, j/k or ↓/↑ (⌃J/⌃K, ⌃N/⌃P) = move within the step's list (not while typing).
    public static func command(_ k: VimKey, target: TourKeyTarget) -> TourKeyCommand? {
        let plain = !k.meta && !k.ctrl && !k.alt
        if k.meta && !k.ctrl && !k.alt && k.key == "[" { return .back }
        if k.meta && !k.ctrl && !k.alt && k.key == "]" { return .next }
        if k.meta && k.key == "Enter" { return .next }
        if k.key == "Escape" && plain { return .back }
        if k.key == "Enter" && plain && !k.shift { return target == .button || target == .text ? nil : .next }
        if target == .text { return nil }
        if plain && !k.shift && (k.key == "j" || k.key == "ArrowDown") { return .listNext }
        if plain && !k.shift && (k.key == "k" || k.key == "ArrowUp") { return .listPrev }
        if k.ctrl && !k.meta && !k.alt && (k.key == "j" || k.key == "n") { return .listNext }
        if k.ctrl && !k.meta && !k.alt && (k.key == "k" || k.key == "p") { return .listPrev }
        return nil
    }
}

/// The cheat sheet on the Done step.
public struct CheatSheetRow: Sendable, Hashable {
    public var keys: String
    public var typed: Bool
    public var title: String
    public var body: String
}

public enum CheatSheet {
    public static func rows(hotkey: String) -> [CheatSheetRow] {
        [CheatSheetRow(keys: Accelerator.display(hotkey), typed: false, title: "Open Glide", body: "From any app"),
         CheatSheetRow(keys: "⌘K", typed: false, title: "Actions", body: "Everything you can do here"),
         CheatSheetRow(keys: "⌘1 … ⌘9", typed: false, title: "Run by position", body: "Skip the arrow keys"),
         CheatSheetRow(keys: "⇥", typed: false, title: "Add an argument", body: "“g cats” searches Google"),
         CheatSheetRow(keys: "Esc j k", typed: false, title: "Vim navigation", body: "Normal mode, then move"),
         CheatSheetRow(keys: "clipboard", typed: true, title: "Clipboard History", body: "Search and paste past copies"),
         CheatSheetRow(keys: "left half", typed: true, title: "Window management", body: "Snap the front window"),
         CheatSheetRow(keys: "5 ft in cm", typed: true, title: "Calculator & units", body: "Answers as you type")]
    }
}
