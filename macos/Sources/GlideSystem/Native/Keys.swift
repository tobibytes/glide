import AppKit
import ApplicationServices
import Carbon.HIToolbox
import GlideCore

private let keysTapCallback: CGEventTapCallBack = { _, type, event, _ in
    let box = UnsafeBox(event)
    let result = MainActor.assumeIsolated { UnsafeBox(EventTapKeyboardService.current?.handle(type: type, event: box.value) ?? Unmanaged.passUnretained(box.value)) }
    return result.value
}

/// Carries a non-Sendable value across an isolation boundary we know is the same thread.
struct UnsafeBox<T>: @unchecked Sendable {
    let value: T
    init(_ v: T) { value = v }
}

/// Keyboard event tap: live snippet expansion, the ⌘V Paste Stack and the Hyper key (helper Keys.swift).
/// Decisions come from the pure KeyEngine (KeysLogic.swift). NEVER constructed in headless mode.
@MainActor public final class EventTapKeyboardService: KeyboardTapService {
    nonisolated(unsafe) fileprivate static weak var current: EventTapKeyboardService?

    nonisolated static let syntheticMarker: Int64 = 0x474C_4944 // "GLID"
    private static let hyperFlags: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
    static let renderTimeout: TimeInterval = 0.3
    static let stackTimeout: TimeInterval = 0.5
    private static let maxQueued = 64

    public var onEvent: ((KeyboardTapEvent) -> Void)?
    private var engine = KeyEngine()
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var needsBundleId = false
    private var nextRequest = 1
    private var pendingExpansion: (reqId: Int, entry: SnippetEntry, backspaces: Int)?
    private var pendingPaste: Int?
    private var stackTimeouts = 0
    private var queued: [CGEvent] = []
    private weak var hotkeys: CarbonHotkeyService?
    private let paster: SystemPasteService

    public init(hotkeys: CarbonHotkeyService?, paster: SystemPasteService) {
        self.hotkeys = hotkeys
        self.paster = paster
        Self.current = self
        HID.recoverStale()
        hotkeys?.hyperActive = { HID.active }
    }

    public func configure(_ config: KeyboardTapConfig) -> String? {
        let list = config.snippets.map { SnippetEntry(keyword: $0.keyword, text: $0.text, id: $0.id, excludedBundleIds: $0.excludedBundleIds) }
        engine.setEntries(list)
        engine.globalExcluded = config.excludedBundleIds
        engine.hyper = config.hyperKey
        engine.pasteStack = config.pasteStack
        stackTimeouts = 0
        needsBundleId = !config.excludedBundleIds.isEmpty || list.contains { !$0.excludedBundleIds.isEmpty }
        let error = ensureTap()
        if engine.hyper && tap != nil { HID.enable() } else { HID.disable() }
        hotkeys?.keysTapHooked = engine.hyper && tap != nil
        return error
    }

    /// Permissions changed: retry a tap that failed earlier.
    public func retryIfNeeded() {
        guard tap == nil, engine.active else { return }
        if ensureTap() == nil, engine.hyper { HID.enable() }
        hotkeys?.keysTapHooked = engine.hyper && tap != nil
    }

    public func shutdown() {
        HID.disable()
        removeTap()
    }

    public func resetBuffer() { engine.resetBuffer() }

    private func ensureTap() -> String? {
        guard engine.active else { removeTap(); return nil }
        if let tap {
            if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
            return nil
        }
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: keysTapCallback, userInfo: nil) else {
            let reason = AXIsProcessTrusted()
                ? "Could not create the keyboard event tap. Grant Input Monitoring to Glide in System Settings."
                : "Accessibility permission is required for snippet expansion and the Hyper key."
            onEvent?(.tapFailed(reason: reason))
            return reason
        }
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        tap = t
        source = src
        return nil
    }

    private func removeTap() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
        hotkeys?.keysTapHooked = false
        engine.releaseHyper()
    }

    static func input(type: CGEventType, event: CGEvent) -> KeyInput {
        let kind: KeyKind
        switch type {
        case .keyDown: kind = .down
        case .keyUp: kind = .up
        case .flagsChanged: kind = .flags
        default: kind = .mouse
        }
        var mods: KeyMods = []
        let f = event.flags
        if f.contains(.maskCommand) { mods.insert(.command) }
        if f.contains(.maskControl) { mods.insert(.control) }
        if f.contains(.maskAlternate) { mods.insert(.option) }
        if f.contains(.maskShift) { mods.insert(.shift) }
        var input = KeyInput(kind: kind, mods: mods)
        guard kind == .down || kind == .up else { return input }
        input.code = event.getIntegerValueField(.keyboardEventKeycode)
        input.autorepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        if kind == .down {
            var length = 0
            var chars = [UniChar](repeating: 0, count: 8)
            event.keyboardGetUnicodeString(maxStringLength: chars.count, actualStringLength: &length, unicodeString: &chars)
            if length > 0 { input.chars = String(utf16CodeUnits: chars, count: length) }
        }
        return input
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let pass = Unmanaged.passUnretained(event)
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return pass
        }
        if event.getIntegerValueField(.eventSourceUserData) == Self.syntheticMarker { return pass }
        let input = Self.input(type: type, event: event)
        switch input.kind {
        case .flags: hotkeys?.handleFlagsChanged(event)
        case .down where input.code != KeyCodes.f18, .mouse: hotkeys?.handleKeyDown()
        default: break
        }
        var env = KeyEnv()
        if input.kind == .down {
            env.secureInput = IsSecureEventInputEnabled()
            if needsBundleId { env.bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier }
        }
        switch engine.handle(input, env) {
        case .pass: return pass
        case .passHyper:
            event.flags = event.flags.union(Self.hyperFlags)
            return pass
        case .swallow: return nil
        case .swallowPostEscape:
            if !(hotkeys?.handleHyperTap() ?? false) { postKey(CGKeyCode(KeyCodes.escape)) }
            return nil
        case .queue:
            if queued.count < Self.maxQueued, let copy = event.copy() { queued.append(copy) }
            return nil
        case let .expand(entry, backspaces):
            startExpansion(entry, backspaces: backspaces, bundleId: env.bundleId ?? NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
            return pass
        case .interceptPaste:
            startStackPaste()
            return nil
        }
    }

    private func startExpansion(_ entry: SnippetEntry, backspaces: Int, bundleId: String?) {
        guard let id = entry.id else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
                MainActor.assumeIsolated { self.perform(backspaces: backspaces, text: entry.text, html: nil, cursorLeft: 0, keyword: entry.keyword, live: false) }
            }
            return
        }
        let reqId = nextRequest
        nextRequest += 1
        pendingExpansion = (reqId, entry, backspaces)
        onEvent?(.snippetMatched(reqId: reqId, keyword: entry.keyword, id: id, bundleId: bundleId))
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.renderTimeout) {
            MainActor.assumeIsolated { _ = self.finishExpansion(reqId: reqId, text: nil, html: nil, cursorLeft: nil) }
        }
    }

    @discardableResult
    public func finishExpansion(reqId: Int, text: String?, html: String?, cursorLeft: Int?) -> Bool {
        guard let p = pendingExpansion, p.reqId == reqId else { return false }
        pendingExpansion = nil
        engine.expansionFinished()
        let r = renderDecision(fallback: p.entry.text, text: text, html: html, cursorLeft: cursorLeft)
        perform(backspaces: p.backspaces, text: r.text, html: r.html, cursorLeft: r.cursorLeft, keyword: p.entry.keyword, live: r.live)
        return true
    }

    private func perform(backspaces: Int, text: String, html: String?, cursorLeft: Int, keyword: String, live: Bool) {
        for _ in 0..<backspaces { postKey(CGKeyCode(KeyCodes.delete)) }
        if !text.isEmpty || html != nil { paster.paste(text: text, html: html) }
        let replay = takeQueue()
        let box = UnsafeBox(replay)
        DispatchQueue.main.asyncAfter(deadline: .now() + (cursorLeft > 0 || !replay.isEmpty ? 0.06 : 0)) {
            for _ in 0..<cursorLeft { postKey(CGKeyCode(KeyCodes.leftArrow)) }
            Self.replay(box.value)
        }
        onEvent?(.snippetExpanded(keyword: keyword, live: live))
    }

    private func startStackPaste() {
        let reqId = nextRequest
        nextRequest += 1
        pendingPaste = reqId
        onEvent?(.stackNext(reqId: reqId))
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stackTimeout) {
            MainActor.assumeIsolated {
                guard self.pendingPaste == reqId else { return }
                self.stackTimeouts += 1
                let keep = self.stackTimeouts < 2 && self.engine.pasteStack
                self.finishStackPaste(reqId, action: .passOriginal, pasteStack: keep)
            }
        }
    }

    @discardableResult
    public func applyStackReply(reqId: Int, text: String?, html: String?, passthrough: Bool, empty: Bool, active: Bool?) -> Bool {
        guard pendingPaste == reqId else {
            if empty || active == false { engine.pasteStack = false }
            return false
        }
        stackTimeouts = 0
        let d = stackReplyDecision(text: text, html: html, passthrough: passthrough, empty: empty, active: active, currentlyActive: engine.pasteStack)
        finishStackPaste(reqId, action: d.action, pasteStack: d.pasteStack)
        return true
    }

    private func finishStackPaste(_ reqId: Int, action: StackReplyAction, pasteStack: Bool) {
        guard pendingPaste == reqId else { return }
        pendingPaste = nil
        engine.pasteFinished()
        engine.pasteStack = pasteStack
        switch action {
        case let .paste(text, html): paster.paste(text: text, html: html)
        case .passOriginal: postKey(CGKeyCode(KeyCodes.v), flags: .maskCommand)
        }
        let replay = takeQueue()
        let box = UnsafeBox(replay)
        if !replay.isEmpty { DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { Self.replay(box.value) } }
    }

    private func takeQueue() -> [CGEvent] {
        defer { queued = [] }
        return queued
    }

    nonisolated private static func replay(_ events: [CGEvent]) {
        for e in events {
            e.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
            e.post(tap: .cghidEventTap)
        }
    }
}

/// Synthesize one key press (marked so our tap ignores it).
func postKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .privateState)
    for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { continue }
        e.flags = flags
        e.setIntegerValueField(.eventSourceUserData, value: EventTapKeyboardService.syntheticMarker)
        e.post(tap: .cghidEventTap)
    }
}

/// Caps Lock → F18 via hidutil; previous mapping saved (memory + marker file) and restored on disable,
/// exit and the next launch after a crash. GLIDE_HELPER_DRY_RUN=1 logs instead of calling hidutil.
@MainActor enum HID {
    static let capsLock: UInt64 = 0x7_0000_0039
    static let f18: UInt64 = 0x7_0000_006D
    static let dryRun = ProcessInfo.processInfo.environment["GLIDE_HELPER_DRY_RUN"] == "1"
    private static var previous: [(UInt64, UInt64)]?
    static var dryRunLog: [String] = []

    private static var markerURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("dev.glide.launcher", isDirectory: true).appendingPathComponent("hyper-key-previous-mapping.json")
    }

    static var active: Bool { previous != nil }

    static func enable() {
        guard previous == nil else { return }
        let current = currentMapping().filter { !($0.0 == capsLock && $0.1 == f18) }
        previous = current
        if !dryRun { writeMarker(current) }
        set(current.filter { $0.0 != capsLock } + [(capsLock, f18)])
    }

    static func disable() {
        guard let p = previous else { return }
        set(p)
        previous = nil
        if !dryRun { try? FileManager.default.removeItem(at: markerURL) }
    }

    static func recoverStale() {
        guard !dryRun, let data = try? Data(contentsOf: markerURL), let list = try? JSONSerialization.jsonObject(with: data) as? [[NSNumber]] else { return }
        set(list.compactMap { $0.count == 2 ? ($0[0].uint64Value, $0[1].uint64Value) : nil })
        try? FileManager.default.removeItem(at: markerURL)
    }

    private static func writeMarker(_ mapping: [(UInt64, UInt64)]) {
        try? FileManager.default.createDirectory(at: markerURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: mapping.map { [NSNumber(value: $0.0), NSNumber(value: $0.1)] }) { try? data.write(to: markerURL, options: .atomic) }
    }

    static func currentMapping() -> [(UInt64, UInt64)] {
        let (status, out) = runTool("/usr/bin/hidutil", ["property", "--get", "UserKeyMapping"])
        return status == 0 ? HIDMapping.parse(out) : []
    }

    private static func set(_ mapping: [(UInt64, UInt64)]) {
        let arg = HIDMapping.json(mapping)
        if dryRun { dryRunLog.append(arg); return }
        _ = runTool("/usr/bin/hidutil", ["property", "--set", arg])
    }
}

/// Pure hidutil text helpers (unit tested).
public enum HIDMapping {
    /// Parses hidutil's NSArray description.
    public static func parse(_ text: String) -> [(UInt64, UInt64)] {
        var result: [(UInt64, UInt64)] = []
        for block in text.components(separatedBy: "}") {
            func value(_ key: String) -> UInt64? {
                guard let r = block.range(of: key) else { return nil }
                let rest = block[r.upperBound...].drop { $0 == " " || $0 == "=" || $0 == "\"" }
                let token = rest.prefix { $0.isHexDigit || $0 == "x" || $0 == "X" }
                return token.lowercased().hasPrefix("0x") ? UInt64(token.dropFirst(2), radix: 16) : UInt64(token)
            }
            if let src = value("HIDKeyboardModifierMappingSrc"), let dst = value("HIDKeyboardModifierMappingDst") { result.append((src, dst)) }
        }
        return result
    }

    public static func json(_ mapping: [(UInt64, UInt64)]) -> String {
        "{\"UserKeyMapping\":[\(mapping.map { "{\"HIDKeyboardModifierMappingSrc\":\($0.0),\"HIDKeyboardModifierMappingDst\":\($0.1)}" }.joined(separator: ","))]}"
    }
}
