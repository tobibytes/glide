import AppKit
import Carbon

// Global hotkeys (methods "hotkeys.set", event "hotkey.pressed"). See src/native/PROTOCOL.md.
//
// - Combos use Carbon RegisterEventHotKey (no Accessibility / Input Monitoring needed). The helper runs
//   CFRunLoopRun() instead of NSApp.run(), which never dispatches Carbon events, so a run-loop observer
//   drains hot-key events from the main event queue and dispatches them (verified: < 1 ms latency).
// - Modifier-only shortcuts ("Double+Cmd", "Right+Alt") use a listen-only event tap (Input Monitoring).
//   Keys.swift's tap may forward the same events through handleFlagsChanged/handleKeyDown; duplicates are
//   ignored by timestamp. "Hyper" alone (Caps Lock tapped) needs Keys.swift to call handleHyperTap().
// - The accelerator grammar mirrors src/main/hotkey-accelerator.ts; both are checked against
//   src/native/hotkey-accelerators.json (`glide-helper --selftest-hotkeys <json>`).

enum HotkeyMod: String { case ctrl, alt, shift, cmd, hyper }

enum HotkeySpec: Equatable {
    case combo(mods: [HotkeyMod], key: String)
    case modifier(mod: HotkeyMod, side: String, double: Bool)
}

private let hotkeyEventSignature: OSType = 0x474C_4448 // "GLDH"

private let carbonHotkeyHandler: EventHandlerUPP = { _, event, _ in
    guard let event else { return OSStatus(eventNotHandledErr) }
    var hk = EventHotKeyID()
    let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
    guard status == noErr, hk.signature == hotkeyEventSignature else { return OSStatus(eventNotHandledErr) }
    Hotkeys.shared.carbonPressed(hk.id)
    return noErr
}

private let modifierTapCallback: CGEventTapCallBack = { _, type, event, _ in
    Hotkeys.shared.tapEvent(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

final class Hotkeys {
    static let shared = Hotkeys()

    /// Keys.swift sets this once its tap forwards the Caps Lock (F18) tap to handleHyperTap().
    var keysTapHooked = false

    private struct Registered {
        let id: String
        let spec: HotkeySpec
        let ref: EventHotKeyRef?
        let number: UInt32
    }

    private var combos: [String: Registered] = [:] // by binding id
    private var byNumber: [UInt32: String] = [:]
    private var modifierBindings: [(id: String, mod: HotkeyMod, side: String, double: Bool)] = []
    private var nextNumber: UInt32 = 1
    private var handlerInstalled = false
    private var pump: CFRunLoopObserver?
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var lastBindings: [(id: String, accelerator: String)] = []
    private var layoutObserver: NSObjectProtocol?

    // MARK: parsing (mirror of src/main/hotkey-accelerator.ts)

    static let modifierNames: [String: [HotkeyMod]] = [
        "command": [.cmd], "cmd": [.cmd], "super": [.cmd], "meta": [.cmd],
        "commandorcontrol": [.cmd], "cmdorctrl": [.cmd],
        "control": [.ctrl], "ctrl": [.ctrl],
        "alt": [.alt], "option": [.alt], "altgr": [.alt],
        "shift": [.shift],
        "hyper": [.ctrl, .alt, .shift, .cmd],
    ]
    static let modOrder: [HotkeyMod] = [.ctrl, .alt, .shift, .cmd]
    static let modDisplay: [HotkeyMod: String] = [.ctrl: "Ctrl", .alt: "Alt", .shift: "Shift", .cmd: "Cmd", .hyper: "Hyper"]

    /// Canonical name → virtual keycode for keys whose position does not depend on the layout.
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

    static func parse(_ input: String) -> Result<HotkeySpec, HelperError> {
        let tokens = tokenize(input)
        guard let last = tokens.last else { return .failure(HelperError("Empty shortcut")) }
        let lastLower = last.lowercased()
        if let m = modifierNames[lastLower] {
            let prefixes = tokens.dropLast().map { $0.lowercased() }
            if prefixes.contains(where: { !["double", "left", "right"].contains($0) }) {
                return .failure(HelperError("A shortcut needs a key besides modifiers (or use Double/Left/Right with one modifier)"))
            }
            let double = prefixes.contains("double")
            let sides = prefixes.filter { $0 == "left" || $0 == "right" }
            if sides.count > 1 || Set(prefixes).count != prefixes.count { return .failure(HelperError("Invalid modifier-only shortcut")) }
            let side = sides.first ?? "either"
            let mod: HotkeyMod = lastLower == "hyper" ? .hyper : m[0]
            if mod == .hyper && side != "either" { return .failure(HelperError("Hyper has no left/right side")) }
            if !double && side == "either" && mod != .hyper { return .failure(HelperError("A modifier alone needs Left/Right or Double (e.g. Right+Alt, Double+Cmd)")) }
            return .success(.modifier(mod: mod, side: side, double: double))
        }
        var mods = Set<HotkeyMod>()
        for t in tokens.dropLast() {
            guard let m = modifierNames[t.lowercased()] else { return .failure(HelperError("Unknown modifier \"\(t)\"")) }
            mods.formUnion(m)
        }
        if unsupported.contains(lastLower) { return .failure(HelperError("\"\(last)\" cannot be used as a global hotkey on macOS")) }
        let key: String
        if lastLower == "plus" { key = "Plus" }
        else if let named = namedKeys[lastLower] { key = named.name }
        else if last.count == 1 { key = last.uppercased() }
        else { return .failure(HelperError("Unknown key \"\(last)\"")) }
        return .success(.combo(mods: modOrder.filter { mods.contains($0) }, key: key))
    }

    static func canonical(_ spec: HotkeySpec) -> String {
        switch spec {
        case let .combo(mods, key):
            return (mods.map { modDisplay[$0]! } + [key]).joined(separator: "+")
        case let .modifier(mod, side, double):
            return [double ? "Double" : "", side == "left" ? "Left" : side == "right" ? "Right" : "", modDisplay[mod]!].filter { !$0.isEmpty }.joined(separator: "+")
        }
    }

    // MARK: keycodes (current keyboard layout)

    private static let keypadCodes: Set<UInt16> = [65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92]
    /// US ANSI positions: the fallback when no installed layout produces the character.
    private static let ansi: [Character: UInt32] = [
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
        "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35, "L": 37, "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
        "N": 45, "M": 46, ".": 47, "`": 50,
    ]

    private struct LayoutMap { var plain: [String: UInt16] = [:]; var shifted: [String: UInt16] = [:] }
    private var layoutCache: [LayoutMap]?

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

    /// Current layout first, then the current ASCII-capable layout (Cyrillic, Greek, IMEs).
    private func layouts() -> [LayoutMap] {
        if let layoutCache { return layoutCache }
        var datas: [CFData] = []
        if let d = Self.layoutData(TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()) { datas.append(d) }
        if let d = Self.layoutData(TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()) { datas.append(d) }
        let maps = datas.map { data -> LayoutMap in
            var map = LayoutMap()
            for code in UInt16(0)..<UInt16(128) where !Self.keypadCodes.contains(code) && !Self.namedKeys.values.contains(where: { $0.code == UInt32(code) }) {
                if let s = Self.translate(data, code, shift: false), map.plain[s] == nil { map.plain[s] = code }
                if let s = Self.translate(data, code, shift: true), map.shifted[s] == nil { map.shifted[s] = code }
            }
            return map
        }
        layoutCache = maps
        return maps
    }

    /// (keycode, needs Shift) for a canonical key.
    func keyCode(for key: String) -> (UInt32, Bool)? {
        if let named = Self.namedKeys[key.lowercased()] { return (named.code, false) }
        let ch = key == "Plus" ? "+" : key.uppercased()
        let maps = layouts()
        for m in maps { if let c = m.plain[ch] { return (UInt32(c), false) } }
        if let c = ch.first, ch.count == 1, let code = Self.ansi[c] { return (code, false) }
        for m in maps { if let c = m.shifted[ch] { return (UInt32(c), true) } }
        return nil
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

    /// Enabled macOS shortcuts (System Settings → Keyboard → Shortcuts) as (keycode, carbon modifiers).
    static func systemShortcuts() -> [(UInt32, UInt32)] {
        var raw: Unmanaged<CFArray>?
        guard CopySymbolicHotKeys(&raw) == noErr, let list = raw?.takeRetainedValue() as? [[String: Any]] else { return [] }
        return list.compactMap { d in
            guard (d["kHISymbolicHotKeyEnabled"] as? Bool) == true,
                  let code = (d["kHISymbolicHotKeyCode"] as? NSNumber)?.uint32Value,
                  let mods = (d["kHISymbolicHotKeyModifiers"] as? NSNumber)?.uint32Value else { return nil }
            let relevant = UInt32(cmdKey | controlKey | optionKey | shiftKey)
            return (code, mods & relevant)
        }
    }

    // MARK: hotkeys.set (main thread)

    func set(_ bindings: [(id: String, accelerator: String)]) -> [String: Any] {
        installCarbon()
        startLayoutWatch()
        lastBindings = bindings
        var registered: [String] = []
        var failed: [[String: String]] = []
        var conflicts: [[String: String]] = []
        var wantedCombos: [String: (HotkeySpec, UInt32, UInt32)] = [:]
        var wantedMods: [(id: String, mod: HotkeyMod, side: String, double: Bool)] = []
        var seen: [String: String] = [:]

        for b in bindings {
            switch Self.parse(b.accelerator) {
            case let .failure(err):
                failed.append(["id": b.id, "reason": err.description])
            case let .success(spec):
                let canon = Self.canonical(spec)
                if seen[canon] != nil { failed.append(["id": b.id, "reason": "used by another Glide hotkey"]); continue }
                seen[canon] = b.id
                switch spec {
                case let .combo(mods, key):
                    guard let (code, shift) = keyCode(for: key) else {
                        failed.append(["id": b.id, "reason": "the key \"\(key)\" is not on the current keyboard layout"])
                        continue
                    }
                    wantedCombos[b.id] = (spec, code, Self.carbonModifiers(mods + (shift ? [.shift] : [])))
                case let .modifier(mod, side, double):
                    wantedMods.append((b.id, mod, side, double))
                }
            }
        }

        // Keep unchanged registrations (no gap in which the key is unbound); drop the rest first so a
        // binding that moved to a different id can be re-registered.
        for (id, r) in combos where wantedCombos[id]?.0 != r.spec || keyChanged(r, wantedCombos[id]) {
            if let ref = r.ref { UnregisterEventHotKey(ref) }
            byNumber[r.number] = nil
            combos[id] = nil
        }
        let system = Self.systemShortcuts()
        for (id, want) in wantedCombos.sorted(by: { $0.key < $1.key }) {
            let (spec, code, mods) = want
            if combos[id] == nil {
                let number = nextNumber
                nextNumber &+= 1
                var ref: EventHotKeyRef?
                let hkID = EventHotKeyID(signature: hotkeyEventSignature, id: number)
                let status = RegisterEventHotKey(code, mods, hkID, GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &ref)
                if status != noErr || ref == nil {
                    let reason: String
                    switch Int(status) {
                    case eventHotKeyExistsErr: reason = "in use by another app"
                    case eventHotKeyInvalidErr: reason = "macOS rejected this shortcut"
                    default: reason = "macOS refused the shortcut (error \(status))"
                    }
                    failed.append(["id": id, "reason": reason])
                    continue
                }
                combos[id] = Registered(id: id, spec: spec, ref: ref, number: number)
                registeredCodes[id] = (code, mods)
                byNumber[number] = id
            }
            registered.append(id)
            if system.contains(where: { $0.0 == code && $0.1 == mods }) {
                conflicts.append(["id": id, "reason": "also a macOS shortcut (System Settings → Keyboard → Keyboard Shortcuts); macOS may handle it first"])
            }
        }

        // Modifier-only.
        modifierBindings = []
        var tapMods: [(id: String, mod: HotkeyMod, side: String, double: Bool)] = []
        for m in wantedMods {
            if m.mod == .hyper {
                if !keysTapHooked { failed.append(["id": m.id, "reason": "Hyper alone is not supported by this helper build"]) }
                else if !HID.active { failed.append(["id": m.id, "reason": "turn on the Hyper key (Settings → Keyboard) first"]) }
                else { modifierBindings.append(m); registered.append(m.id) }
            } else {
                tapMods.append(m)
            }
        }
        if !tapMods.isEmpty {
            if ensureTap() {
                modifierBindings += tapMods
                registered += tapMods.map { $0.id }
            } else {
                failed += tapMods.map { ["id": $0.id, "reason": "needs Input Monitoring"] }
            }
        } else {
            removeTap()
        }
        return ["registered": registered, "failed": failed, "conflicts": conflicts]
    }

    private var registeredCodes: [String: (UInt32, UInt32)] = [:]

    private func keyChanged(_ r: Registered, _ want: (HotkeySpec, UInt32, UInt32)?) -> Bool {
        guard let want, let have = registeredCodes[r.id] else { return true }
        return have.0 != want.1 || have.1 != want.2
    }

    func unregisterAll() {
        for r in combos.values { if let ref = r.ref { UnregisterEventHotKey(ref) } }
        combos = [:]
        byNumber = [:]
        registeredCodes = [:]
        modifierBindings = []
        removeTap()
    }

    // MARK: Carbon dispatch

    private func installCarbon() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), carbonHotkeyHandler, 1, &spec, nil, nil)
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, _ in
            var specs = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                         EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
            var event: EventRef?
            while ReceiveNextEvent(specs.count, &specs, kEventDurationNoWait, true, &event) == noErr, let e = event {
                SendEventToEventTarget(e, GetEventDispatcherTarget())
                ReleaseEvent(e)
                event = nil
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        pump = observer
    }

    fileprivate func carbonPressed(_ number: UInt32) {
        guard let id = byNumber[number] else { return }
        Output.event("hotkey.pressed", ["id": id])
    }

    /// Keyboard layout switched: character keys may live elsewhere now.
    private func startLayoutWatch() {
        guard layoutObserver == nil else { return }
        layoutObserver = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String), object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.layoutCache = nil
            let result = self.set(self.lastBindings)
            Output.event("hotkeys.changed", result)
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
        // Preflight never prompts; creating a listen-only tap without the grant could.
        guard CGPreflightListenEventAccess() else { return false }
        let types: [CGEventType] = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                        eventsOfInterest: mask, callback: modifierTapCallback, userInfo: nil) else { return false }
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
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        case .flagsChanged:
            handleFlagsChanged(event)
        case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown:
            handleKeyDown()
        default:
            break
        }
    }

    // --- Hook API for Keys.swift (see CONTRACT-K1.md). Main thread only. ---

    /// Feed a .flagsChanged event. Safe to call for events this class's own tap also saw.
    func handleFlagsChanged(_ event: CGEvent) {
        if event.timestamp != 0 && event.timestamp == lastTimestamp { return }
        lastTimestamp = event.timestamp
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        guard let key = Self.modKeys[code] else { candidate = nil; return }
        modifierChanged(key: key, rawFlags: event.flags.rawValue, now: ProcessInfo.processInfo.systemUptime)
    }

    /// Any non-modifier key or mouse button cancels a pending modifier tap.
    func handleKeyDown() {
        candidate = nil
        lastTap = nil
    }

    /// Caps Lock (as Hyper) was tapped alone. Returns true when a "Hyper" binding used the tap, so the
    /// caller skips its Escape fallback.
    func handleHyperTap() -> Bool {
        let hyper = modifierBindings.filter { $0.mod == .hyper }
        guard !hyper.isEmpty else { return false }
        tapped(mod: .hyper, side: "either", now: ProcessInfo.processInfo.systemUptime)
        return true
    }

    private func modifierChanged(key: ModKey, rawFlags: UInt64, now: TimeInterval) {
        let isDown = rawFlags & key.mask != 0
        let othersHeld = rawFlags & (Self.allDeviceMasks & ~key.mask) != 0
        if isDown {
            if othersHeld { candidate = nil; lastTap = nil } else { candidate = (key.mod, key.side, now) }
            return
        }
        if let c = candidate, c.mod == key.mod, c.side == key.side, !othersHeld, now - c.at < Self.tapMaxHold {
            tapped(mod: key.mod, side: key.side, now: now)
        }
        candidate = nil
    }

    private func tapped(mod: HotkeyMod, side: String, now: TimeInterval) {
        let matches = modifierBindings.filter { $0.mod == mod && ($0.side == "either" || $0.side == side) }
        for b in matches where !b.double { Output.event("hotkey.pressed", ["id": b.id]) }
        if let lt = lastTap, lt.mod == mod, now - lt.at < Self.doubleTapWindow {
            for b in matches where b.double && (b.side == "either" || (b.side == side && lt.side == side)) {
                Output.event("hotkey.pressed", ["id": b.id])
            }
            lastTap = nil
        } else {
            lastTap = (mod, side, now)
        }
    }

    // MARK: self-test (parsing only; never registers anything)

    static func selftest(casesPath: String?) -> Int32 {
        var failures: [String] = []
        var checked = 0
        let path = casesPath ?? "src/native/hotkey-accelerators.json"
        guard let data = FileManager.default.contents(atPath: path),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cases = root["cases"] as? [[String: Any]] else {
            print("{\"ok\":false,\"error\":\"cannot read \(path)\"}")
            return 2
        }
        let layoutDatas = [layoutData(TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()),
                           layoutData(TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue())].compactMap { $0 }
        for c in cases {
            guard let accel = c["accel"] as? String else { continue }
            checked += 1
            let result = parse(accel)
            if (c["error"] as? Bool) == true {
                if case .success = result { failures.append("\(accel): expected an error") }
                continue
            }
            guard case let .success(spec) = result else {
                if case let .failure(e) = result { failures.append("\(accel): \(e.description)") }
                continue
            }
            if let want = c["canonical"] as? String, canonical(spec) != want { failures.append("\(accel): canonical \(canonical(spec)) != \(want)") }
            switch spec {
            case let .combo(mods, key):
                if c["kind"] as? String != "combo" { failures.append("\(accel): kind combo"); continue }
                if let want = c["mods"] as? [String], mods.map(\.rawValue) != want { failures.append("\(accel): mods \(mods)") }
                if let want = c["key"] as? String, key != want { failures.append("\(accel): key \(key)") }
                guard let (code, shift) = shared.keyCode(for: key) else { failures.append("\(accel): no keycode"); continue }
                if let want = (c["keyCode"] as? NSNumber)?.uint32Value {
                    if code != want { failures.append("\(accel): keyCode \(code) != \(want)") }
                } else if key.count == 1 || key == "Plus" {
                    // Round trip: the resolved key must type the character on some active layout.
                    let ch = key == "Plus" ? "+" : key
                    let ok = layoutDatas.contains { translate($0, UInt16(code), shift: shift) == ch } || (layoutDatas.isEmpty && ansi[Character(ch)] == code)
                        || (ansi[Character(ch)] == code && !shift)
                    if !ok { failures.append("\(accel): keycode \(code) does not type \(ch)") }
                }
            case let .modifier(mod, side, double):
                if c["kind"] as? String != "modifier" { failures.append("\(accel): kind modifier"); continue }
                if c["mod"] as? String != mod.rawValue || c["side"] as? String != side || c["double"] as? Bool != double {
                    failures.append("\(accel): \(mod) \(side) \(double)")
                }
            }
        }
        let system = systemShortcuts()
        let cmdSpace = system.contains { $0.0 == 49 && $0.1 == UInt32(cmdKey) }
        let out: [String: Any] = ["ok": failures.isEmpty, "checked": checked, "failures": failures,
                                  "layouts": layoutDatas.count, "systemShortcuts": system.count, "cmdSpaceIsSystemShortcut": cmdSpace]
        if let json = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), let s = String(data: json, encoding: .utf8) { print(s) }
        return failures.isEmpty ? 0 : 1
    }
}
