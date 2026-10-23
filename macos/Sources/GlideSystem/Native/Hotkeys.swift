import AppKit
import Carbon
import GlideCore

// Global hotkeys (helper Hotkeys.swift). Combos: Carbon RegisterEventHotKey (no permission needed; NSApp.run
// dispatches Carbon events, so the helper's run-loop pump is gone). Modifier-only shortcuts ("Double+Cmd",
// "Right+Alt"): listen-only event tap (Input Monitoring; created only when preflight says it is granted).
// The accelerator grammar mirrors src/main/hotkey-accelerator.ts; both are checked against
// Tests/GlideSystemTests/Fixtures/hotkey-accelerators.json.

public enum HotkeyMod: String, Sendable { case ctrl, alt, shift, cmd, hyper }

public enum HotkeySpec: Equatable, Sendable {
    case combo(mods: [HotkeyMod], key: String)
    case modifier(mod: HotkeyMod, side: String, double: Bool)
}

/// Pure accelerator parsing (thread-agnostic).
public enum HotkeyParser {
    static let modifierNames: [String: [HotkeyMod]] = [
        "command": [.cmd], "cmd": [.cmd], "super": [.cmd], "meta": [.cmd], "commandorcontrol": [.cmd], "cmdorctrl": [.cmd],
        "control": [.ctrl], "ctrl": [.ctrl], "alt": [.alt], "option": [.alt], "altgr": [.alt], "shift": [.shift],
        "hyper": [.ctrl, .alt, .shift, .cmd],
    ]
    static let modOrder: [HotkeyMod] = [.ctrl, .alt, .shift, .cmd]
    static let modDisplay: [HotkeyMod: String] = [.ctrl: "Ctrl", .alt: "Alt", .shift: "Shift", .cmd: "Cmd", .hyper: "Hyper"]

    /// Canonical name → virtual keycode for layout-independent keys.
    static let namedKeys: [String: (name: String, code: UInt32)] = {
        var m: [String: (String, UInt32)] = [
            "space": ("Space", 49), "tab": ("Tab", 48), "return": ("Return", 36), "enter": ("Return", 36),
            "escape": ("Escape", 53), "esc": ("Escape", 53), "backspace": ("Backspace", 51), "delete": ("Delete", 117),
            "insert": ("Insert", 114), "help": ("Insert", 114),
            "up": ("Up", 126), "down": ("Down", 125), "left": ("Left", 123), "right": ("Right", 124),
            "home": ("Home", 115), "end": ("End", 119), "pageup": ("PageUp", 116), "pagedown": ("PageDown", 121),
            "numdec": ("numdec", 65), "numadd": ("numadd", 69), "numsub": ("numsub", 78), "nummult": ("nummult", 67), "numdiv": ("numdiv", 75),
        ]
        let f: [UInt32] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
        for (i, code) in f.enumerated() { m["f\(i + 1)"] = ("F\(i + 1)", code) }
        let num: [UInt32] = [82, 83, 84, 85, 86, 87, 88, 89, 91, 92]
        for (i, code) in num.enumerated() { m["num\(i)"] = ("num\(i)", code) }
        return m
    }()
    static let unsupported: Set<String> = ["f21", "f22", "f23", "f24", "volumeup", "volumedown", "volumemute", "medianexttrack",
                                           "mediaprevioustrack", "mediastop", "mediaplaypause", "printscreen", "numlock", "scrolllock", "capslock"]

    static func tokenize(_ input: String) -> [String] {
        var s = ""
        for ch in input.trimmingCharacters(in: .whitespaces) {
            switch ch {
            case "⌘": s += "+Cmd+"
            case "⌥": s += "+Alt+"
            case "⌃": s += "+Ctrl+"
            case "⇧": s += "+Shift+"
            case "✦": s += "+Hyper+"
            default: s.append(ch)
            }
        }
        return s.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    public static func parse(_ input: String) -> Result<HotkeySpec, FeatureError> {
        func fail(_ m: String) -> Result<HotkeySpec, FeatureError> { .failure(.invalidArguments(m)) }
        let tokens = tokenize(input)
        guard let last = tokens.last else { return fail("Empty shortcut") }
        let lastLower = last.lowercased()
        if let m = modifierNames[lastLower] {
            let prefixes = tokens.dropLast().map { $0.lowercased() }
            if prefixes.contains(where: { !["double", "left", "right"].contains($0) }) {
                return fail("A shortcut needs a key besides modifiers (or use Double/Left/Right with one modifier)")
            }
            let double = prefixes.contains("double")
            let sides = prefixes.filter { $0 == "left" || $0 == "right" }
            if sides.count > 1 || Set(prefixes).count != prefixes.count { return fail("Invalid modifier-only shortcut") }
            let side = sides.first ?? "either"
            let mod: HotkeyMod = lastLower == "hyper" ? .hyper : m[0]
            if mod == .hyper && side != "either" { return fail("Hyper has no left/right side") }
            if !double && side == "either" && mod != .hyper { return fail("A modifier alone needs Left/Right or Double (e.g. Right+Alt, Double+Cmd)") }
            return .success(.modifier(mod: mod, side: side, double: double))
        }
        var mods = Set<HotkeyMod>()
        for t in tokens.dropLast() {
            guard let m = modifierNames[t.lowercased()] else { return fail("Unknown modifier \"\(t)\"") }
            mods.formUnion(m)
        }
        if unsupported.contains(lastLower) { return fail("\"\(last)\" cannot be used as a global hotkey on macOS") }
        let key: String
        if lastLower == "plus" { key = "Plus" } else if let named = namedKeys[lastLower] { key = named.name } else if last.count == 1 { key = last.uppercased() } else { return fail("Unknown key \"\(last)\"") }
        return .success(.combo(mods: modOrder.filter { mods.contains($0) }, key: key))
    }

    public static func canonical(_ spec: HotkeySpec) -> String {
        switch spec {
        case let .combo(mods, key): return (mods.map { modDisplay[$0]! } + [key]).joined(separator: "+")
        case let .modifier(mod, side, double):
            return [double ? "Double" : "", side == "left" ? "Left" : side == "right" ? "Right" : "", modDisplay[mod]!].filter { !$0.isEmpty }.joined(separator: "+")
        }
    }

    static func carbonModifiers(_ mods: [HotkeyMod]) -> UInt32 {
        var m: UInt32 = 0
        for x in mods {
            switch x {
            case .cmd: m |= UInt32(cmdKey)
            case .ctrl: m |= UInt32(controlKey)
            case .alt: m |= UInt32(optionKey)
            case .shift: m |= UInt32(shiftKey)
            case .hyper: m |= UInt32(cmdKey | controlKey | optionKey | shiftKey)
            }
        }
        return m
    }

    /// Enabled macOS shortcuts (System Settings → Keyboard → Shortcuts) as (keycode, carbon modifiers). Read-only.
    public static func systemShortcuts() -> [(UInt32, UInt32)] {
        var raw: Unmanaged<CFArray>?
        guard CopySymbolicHotKeys(&raw) == noErr, let list = raw?.takeRetainedValue() as? [[String: Any]] else { return [] }
        return list.compactMap { d in
            guard (d["kHISymbolicHotKeyEnabled"] as? Bool) == true, let code = (d["kHISymbolicHotKeyCode"] as? NSNumber)?.uint32Value,
                  let mods = (d["kHISymbolicHotKeyModifiers"] as? NSNumber)?.uint32Value else { return nil }
            return (code, mods & UInt32(cmdKey | controlKey | optionKey | shiftKey))
        }
    }
}

/// Character key → keycode on the current keyboard layout (TIS must run on the main thread).
@MainActor public final class KeyLayout {
    private static let keypadCodes: Set<UInt16> = [65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92]
    nonisolated static let ansi: [Character: UInt32] = [
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
        "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35, "L": 37, "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
        "N": 45, "M": 46, ".": 47, "`": 50,
    ]
    private struct LayoutMap { var plain: [String: UInt16] = [:]; var shifted: [String: UInt16] = [:] }
    private var cache: [LayoutMap]?
    private(set) var datas: [CFData] = []

    public init() {}
    public func invalidate() { cache = nil }

    private static func layoutData(_ source: TISInputSource?) -> CFData? {
        guard let source, let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
    }

    static func translate(_ data: CFData, _ code: UInt16, shift: Bool) -> String? {
        guard let bytes = CFDataGetBytePtr(data) else { return nil }
        return bytes.withMemoryRebound(to: UCKeyboardLayout.self, capacity: 1) { layout -> String? in
            var dead: UInt32 = 0
            var chars = [UniChar](repeating: 0, count: 4)
            var length = 0
            let mods: UInt32 = shift ? UInt32((shiftKey >> 8) & 0xFF) : 0
            let st = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDisplay), mods, UInt32(LMGetKbdType()),
                                    OptionBits(1 << kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
            guard st == noErr, length > 0 else { return nil }
            return String(utf16CodeUnits: chars, count: length).uppercased()
        }
    }

    private func layouts() -> [LayoutMap] {
        if let cache { return cache }
        var d: [CFData] = []
        if let x = Self.layoutData(TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()) { d.append(x) }
        if let x = Self.layoutData(TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()) { d.append(x) }
        datas = d
        let namedCodes = Set(HotkeyParser.namedKeys.values.map { UInt16($0.code) })
        let maps = d.map { data -> LayoutMap in
            var map = LayoutMap()
            for code in UInt16(0)..<UInt16(128) where !Self.keypadCodes.contains(code) && !namedCodes.contains(code) {
                if let s = Self.translate(data, code, shift: false), map.plain[s] == nil { map.plain[s] = code }
                if let s = Self.translate(data, code, shift: true), map.shifted[s] == nil { map.shifted[s] = code }
            }
            return map
        }
        cache = maps
        return maps
    }

    /// (keycode, needs Shift) for a canonical key.
    public func keyCode(for key: String) -> (UInt32, Bool)? {
        if let named = HotkeyParser.namedKeys[key.lowercased()] { return (named.code, false) }
        let ch = key == "Plus" ? "+" : key.uppercased()
        let maps = layouts()
        for m in maps { if let c = m.plain[ch] { return (UInt32(c), false) } }
        if let c = ch.first, ch.count == 1, let code = Self.ansi[c] { return (code, false) }
        for m in maps { if let c = m.shifted[ch] { return (UInt32(c), true) } }
        return nil
    }

    /// Self-test from the shared accelerator table (parsing + keycodes only; never registers anything).
    public func selftest(cases data: Data) -> (checked: Int, failures: [String]) {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let cases = root["cases"] as? [[String: Any]] else { return (0, ["unreadable fixture"]) }
        var failures: [String] = []
        var checked = 0
        _ = layouts()
        for c in cases {
            guard let accel = c["accel"] as? String else { continue }
            checked += 1
            let result = HotkeyParser.parse(accel)
            if (c["error"] as? Bool) == true {
                if case .success = result { failures.append("\(accel): expected an error") }
                continue
            }
            guard case let .success(spec) = result else {
                if case let .failure(e) = result { failures.append("\(accel): \(e.localizedDescription)") }
                continue
            }
            if let want = c["canonical"] as? String, HotkeyParser.canonical(spec) != want { failures.append("\(accel): canonical \(HotkeyParser.canonical(spec)) != \(want)") }
            switch spec {
            case let .combo(mods, key):
                if c["kind"] as? String != "combo" { failures.append("\(accel): kind combo"); continue }
                if let want = c["mods"] as? [String], mods.map(\.rawValue) != want { failures.append("\(accel): mods \(mods)") }
                if let want = c["key"] as? String, key != want { failures.append("\(accel): key \(key)") }
                guard let (code, shift) = keyCode(for: key) else { failures.append("\(accel): no keycode"); continue }
                if let want = (c["keyCode"] as? NSNumber)?.uint32Value {
                    if code != want { failures.append("\(accel): keyCode \(code) != \(want)") }
                } else if key.count == 1 || key == "Plus" {
                    let ch = key == "Plus" ? "+" : key
                    let ok = datas.contains { Self.translate($0, UInt16(code), shift: shift) == ch } || (datas.isEmpty && Self.ansi[Character(ch)] == code)
                        || (Self.ansi[Character(ch)] == code && !shift)
                    if !ok { failures.append("\(accel): keycode \(code) does not type \(ch)") }
                }
            case let .modifier(mod, side, double):
                if c["kind"] as? String != "modifier" { failures.append("\(accel): kind modifier"); continue }
                if c["mod"] as? String != mod.rawValue || c["side"] as? String != side || c["double"] as? Bool != double { failures.append("\(accel): \(mod) \(side) \(double)") }
            }
        }
        return (checked, failures)
    }
}

private let hotkeySignature: OSType = 0x474C_4448 // "GLDH"

private let carbonHotkeyHandler: EventHandlerUPP = { _, event, _ in
    guard let event else { return OSStatus(eventNotHandledErr) }
    var hk = EventHotKeyID()
    let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
    guard status == noErr, hk.signature == hotkeySignature else { return OSStatus(eventNotHandledErr) }
    let number = hk.id
    MainActor.assumeIsolated { CarbonHotkeyService.current?.carbonPressed(number) }
    return noErr
}

private let modifierTapCallback: CGEventTapCallBack = { _, type, event, _ in
    nonisolated(unsafe) let e = event
    MainActor.assumeIsolated { CarbonHotkeyService.current?.tapEvent(type: type, event: e) }
    return Unmanaged.passUnretained(event)
}

/// The real HotkeyService. NEVER constructed in headless mode.
@MainActor public final class CarbonHotkeyService: HotkeyService {
    nonisolated(unsafe) fileprivate static weak var current: CarbonHotkeyService?
    public var onPress: ((String) -> Void)?
    /// Set by the keyboard tap once it forwards Caps Lock (F18) taps to handleHyperTap(). Turning it on retries a
    /// "Hyper" binding refused earlier: the launcher never re-sends unchanged bindings (input-audit fix).
    public var keysTapHooked = false {
        didSet { if keysTapHooked && !oldValue && Self.wantsHyper(lastBindings) { _ = set(lastBindings) } }
    }
    /// Whether the Hyper key mapping is active (set by the keyboard tap service).
    public var hyperActive: () -> Bool = { false }

    private struct Registered { let id: String; let spec: HotkeySpec; let ref: EventHotKeyRef?; let number: UInt32 }
    private var combos: [String: Registered] = [:]
    private var registeredCodes: [String: (UInt32, UInt32)] = [:]
    private var byNumber: [UInt32: String] = [:]
    private var modifierBindings: [(id: String, mod: HotkeyMod, side: String, double: Bool)] = []
    private var nextNumber: UInt32 = 1
    private var handlerInstalled = false
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var lastBindings: [HotkeyBinding] = []
    private var layoutObserver: NSObjectProtocol?
    public let layout = KeyLayout()

    public init() { Self.current = self }

    /// While a hotkey recorder has the keyboard (HotkeyCapture) every Glide hotkey is unregistered, so the combo
    /// being recorded — often the current launcher hotkey — reaches the recorder instead of toggling the launcher.
    private var suspended = false
    public func setSuspended(_ on: Bool) {
        guard on != suspended else { return }
        suspended = on
        if on {
            let keep = lastBindings
            unregisterAll()
            lastBindings = keep
        } else {
            _ = set(lastBindings)
        }
    }

    /// Permissions changed (Input Monitoring granted after launch): register the modifier-only shortcuts that
    /// failed for want of the listen tap. No-op when nothing waits for it (input-audit fix).
    public func refresh() {
        guard tap == nil, lastBindings.contains(where: { Self.isModifierOnly($0.accelerator) }) else { return }
        _ = set(lastBindings)
    }

    nonisolated static func isModifierOnly(_ accelerator: String) -> Bool {
        if case .success(.modifier) = HotkeyParser.parse(accelerator) { return true }
        return false
    }

    nonisolated static func wantsHyper(_ bindings: [HotkeyBinding]) -> Bool {
        bindings.contains { b in
            if case .success(.modifier(.hyper, _, _)) = HotkeyParser.parse(b.accelerator) { return true }
            return false
        }
    }

    /// Permissions changed (Input Monitoring granted in System Settings): re-apply, so a modifier-only hotkey
    /// ("Double+Command") whose tap failed at launch starts working without a relaunch.
    public func permissionsChanged() {
        guard !suspended, !lastBindings.isEmpty else { return }
        _ = set(lastBindings)
    }

    public func set(_ bindings: [HotkeyBinding]) -> HotkeyRegistration {
        if suspended { lastBindings = bindings; return HotkeyRegistration() } // applied on resume
        installCarbon()
        startLayoutWatch()
        lastBindings = bindings
        var out = HotkeyRegistration()
        var wantedCombos: [String: (HotkeySpec, UInt32, UInt32)] = [:]
        var wantedMods: [(id: String, mod: HotkeyMod, side: String, double: Bool)] = []
        var seen: [String: String] = [:]
        for b in bindings {
            switch HotkeyParser.parse(b.accelerator) {
            case let .failure(err): out.failed.append(.init(id: b.id, reason: err.localizedDescription))
            case let .success(spec):
                let canon = HotkeyParser.canonical(spec)
                if seen[canon] != nil { out.failed.append(.init(id: b.id, reason: "used by another Glide hotkey")); continue }
                seen[canon] = b.id
                switch spec {
                case let .combo(mods, key):
                    guard let (code, shift) = layout.keyCode(for: key) else {
                        out.failed.append(.init(id: b.id, reason: "the key \"\(key)\" is not on the current keyboard layout"))
                        continue
                    }
                    wantedCombos[b.id] = (spec, code, HotkeyParser.carbonModifiers(mods + (shift ? [.shift] : [])))
                case let .modifier(mod, side, double): wantedMods.append((b.id, mod, side, double))
                }
            }
        }
        for (id, r) in combos {
            let want = wantedCombos[id]
            let changed = want?.0 != r.spec || registeredCodes[id].map { $0.0 != want?.1 || $0.1 != want?.2 } ?? true
            guard changed else { continue }
            if let ref = r.ref { UnregisterEventHotKey(ref) }
            byNumber[r.number] = nil
            combos[id] = nil
            registeredCodes[id] = nil
        }
        let system = HotkeyParser.systemShortcuts()
        for (id, want) in wantedCombos.sorted(by: { $0.key < $1.key }) {
            let (spec, code, mods) = want
            if combos[id] == nil {
                let number = nextNumber
                nextNumber &+= 1
                var ref: EventHotKeyRef?
                let status = RegisterEventHotKey(code, mods, EventHotKeyID(signature: hotkeySignature, id: number), GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &ref)
                if status != noErr || ref == nil {
                    let reason: String
                    switch Int(status) {
                    case eventHotKeyExistsErr: reason = "in use by another app"
                    case eventHotKeyInvalidErr: reason = "macOS rejected this shortcut"
                    default: reason = "macOS refused the shortcut (error \(status))"
                    }
                    out.failed.append(.init(id: id, reason: reason))
                    continue
                }
                combos[id] = Registered(id: id, spec: spec, ref: ref, number: number)
                registeredCodes[id] = (code, mods)
                byNumber[number] = id
            }
            out.registered.append(id)
            if system.contains(where: { $0.0 == code && $0.1 == mods }) {
                out.conflicts.append(.init(id: id, reason: "also a macOS shortcut (System Settings → Keyboard → Keyboard Shortcuts); macOS may handle it first"))
            }
        }
        modifierBindings = []
        var tapMods: [(id: String, mod: HotkeyMod, side: String, double: Bool)] = []
        for m in wantedMods {
            if m.mod == .hyper {
                if !keysTapHooked { out.failed.append(.init(id: m.id, reason: "turn on the Hyper key (Settings → Keyboard) first")) }
                else if !hyperActive() { out.failed.append(.init(id: m.id, reason: "turn on the Hyper key (Settings → Keyboard) first")) }
                else { modifierBindings.append(m); out.registered.append(m.id) }
            } else { tapMods.append(m) }
        }
        if !tapMods.isEmpty {
            if ensureTap() {
                modifierBindings += tapMods
                out.registered += tapMods.map(\.id)
            } else {
                out.failed += tapMods.map { .init(id: $0.id, reason: "needs Input Monitoring") }
            }
        } else {
            removeTap()
        }
        return out
    }

    public func unregisterAll() {
        for r in combos.values { if let ref = r.ref { UnregisterEventHotKey(ref) } }
        combos = [:]
        byNumber = [:]
        registeredCodes = [:]
        modifierBindings = []
        removeTap()
    }

    private func installCarbon() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), carbonHotkeyHandler, 1, &spec, nil, nil)
    }

    fileprivate func carbonPressed(_ number: UInt32) {
        guard let id = byNumber[number] else { return }
        onPress?(id)
    }

    private func startLayoutWatch() {
        guard layoutObserver == nil else { return }
        layoutObserver = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.layout.invalidate()
                _ = self.set(self.lastBindings)
            }
        }
    }

    // MARK: modifier-only taps

    private struct ModKey { let mod: HotkeyMod; let side: String; let mask: UInt64 }
    private static let modKeys: [Int64: ModKey] = [
        55: ModKey(mod: .cmd, side: "left", mask: 0x08), 54: ModKey(mod: .cmd, side: "right", mask: 0x10),
        56: ModKey(mod: .shift, side: "left", mask: 0x02), 60: ModKey(mod: .shift, side: "right", mask: 0x04),
        58: ModKey(mod: .alt, side: "left", mask: 0x20), 61: ModKey(mod: .alt, side: "right", mask: 0x40),
        59: ModKey(mod: .ctrl, side: "left", mask: 0x01), 62: ModKey(mod: .ctrl, side: "right", mask: 0x2000),
    ]
    private static let allDeviceMasks: UInt64 = 0x08 | 0x10 | 0x02 | 0x04 | 0x20 | 0x40 | 0x01 | 0x2000
    static let tapMaxHold: TimeInterval = 0.6
    static let doubleTapWindow: TimeInterval = 0.4
    private var candidate: (mod: HotkeyMod, side: String, at: TimeInterval)?
    private var lastTap: (mod: HotkeyMod, side: String, at: TimeInterval)?
    private var lastTimestamp: CGEventTimestamp = 0

    private func ensureTap() -> Bool {
        if let tap {
            if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
            return true
        }
        guard CGPreflightListenEventAccess() else { return false } // preflight never prompts
        let types: [CGEventType] = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask, callback: modifierTapCallback, userInfo: nil) else { return false }
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        tap = t
        tapSource = src
        return true
    }

    private func removeTap() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
        tap = nil
        tapSource = nil
        candidate = nil
        lastTap = nil
    }

    fileprivate func tapEvent(type: CGEventType, event: CGEvent) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput: if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        case .flagsChanged: handleFlagsChanged(event)
        case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown: handleKeyDown()
        default: break
        }
    }

    /// Hook for the keyboard tap. Safe to call for events this class's own tap also saw.
    public func handleFlagsChanged(_ event: CGEvent) {
        if event.timestamp != 0 && event.timestamp == lastTimestamp { return }
        lastTimestamp = event.timestamp
        guard let key = Self.modKeys[event.getIntegerValueField(.keyboardEventKeycode)] else { candidate = nil; return }
        let raw = event.flags.rawValue
        let now = ProcessInfo.processInfo.systemUptime
        let isDown = raw & key.mask != 0
        let othersHeld = raw & (Self.allDeviceMasks & ~key.mask) != 0
        if isDown {
            if othersHeld { candidate = nil; lastTap = nil } else { candidate = (key.mod, key.side, now) }
            return
        }
        if let c = candidate, c.mod == key.mod, c.side == key.side, !othersHeld, now - c.at < Self.tapMaxHold { tapped(mod: key.mod, side: key.side, now: now) }
        candidate = nil
    }

    public func handleKeyDown() {
        candidate = nil
        lastTap = nil
    }

    /// Caps Lock (as Hyper) tapped alone. True when a "Hyper" binding used it.
    public func handleHyperTap() -> Bool {
        guard modifierBindings.contains(where: { $0.mod == .hyper }) else { return false }
        tapped(mod: .hyper, side: "either", now: ProcessInfo.processInfo.systemUptime)
        return true
    }

    private func tapped(mod: HotkeyMod, side: String, now: TimeInterval) {
        let matches = modifierBindings.filter { $0.mod == mod && ($0.side == "either" || $0.side == side) }
        for b in matches where !b.double { onPress?(b.id) }
        if let lt = lastTap, lt.mod == mod, now - lt.at < Self.doubleTapWindow {
            for b in matches where b.double && (b.side == "either" || (b.side == side && lt.side == side)) { onPress?(b.id) }
            lastTap = nil
        } else {
            lastTap = (mod, side, now)
        }
    }
}
