import AppKit
import ApplicationServices
import Carbon.HIToolbox

private let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    Keys.shared.handle(type: type, event: event)
}

/// Keyboard event tap: live snippet expansion, the ⌘V Paste Stack and the Hyper key.
/// Decisions come from the pure KeyEngine (KeysLogic.swift); this class performs them. All state lives on the main thread.
final class Keys {
    static let shared = Keys()

    /// Marks events we synthesize so the tap lets them through untouched.
    static let syntheticMarker: Int64 = 0x474C_4944 // "GLID"
    static let f18: Int64 = KeyCodes.f18
    private static let hyperFlags: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
    /// How long an expansion waits for main's snippet.render before pasting the pre-rendered text.
    static let renderTimeout: TimeInterval = 0.3
    /// Watchdog for stack.next: after this the original ⌘V goes through.
    static let stackTimeout: TimeInterval = 0.5
    private static let maxQueued = 64

    private var engine = KeyEngine()
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var needsBundleId = false
    private var nextRequest = 1
    private var pendingExpansion: (reqId: Int, entry: SnippetEntry, backspaces: Int)?
    private var pendingPaste: Int?
    private var stackTimeouts = 0
    /// Events typed while an expansion / stack paste was pending, replayed afterwards.
    private var queued: [CGEvent] = []

    // MARK: configuration

    /// Returns an error message when the tap could not be created.
    func configure(snippets list: [SnippetEntry], hyper wantsHyper: Bool, pasteStack: Bool, excluded: [String]) -> String? {
        engine.setEntries(list)
        engine.globalExcluded = excluded
        engine.hyper = wantsHyper
        engine.pasteStack = pasteStack
        stackTimeouts = 0
        needsBundleId = !excluded.isEmpty || list.contains { !$0.excludedBundleIds.isEmpty }
        let error = ensureTap()
        if engine.hyper && tap != nil { HID.enable() } else { HID.disable() }
        // "Hyper" alone as a global hotkey only works while this tap turns Caps Lock taps into handleHyperTap().
        Hotkeys.shared.keysTapHooked = engine.hyper && tap != nil
        return error
    }

    /// Called when permissions change: retry a tap that failed earlier.
    func retryIfNeeded() {
        guard tap == nil, engine.active else { return }
        if ensureTap() == nil, engine.hyper { HID.enable() }
        Hotkeys.shared.keysTapHooked = engine.hyper && tap != nil
    }

    func shutdown() {
        HID.disable()
        removeTap()
    }

    func resetBuffer() {
        if Thread.isMainThread { engine.resetBuffer() } else { DispatchQueue.main.async { self.engine.resetBuffer() } }
    }

    private func ensureTap() -> String? {
        guard engine.active else { removeTap(); return nil }
        if let tap {
            if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
            return nil
        }
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: tapCallback, userInfo: nil) else {
            let reason = AXIsProcessTrusted()
                ? "Could not create the keyboard event tap. Grant Input Monitoring to Glide in System Settings."
                : "Accessibility permission is required for snippet expansion and the Hyper key."
            Output.event("keys.tapFailed", ["reason": reason])
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
        Hotkeys.shared.keysTapHooked = false
        engine.releaseHyper()
    }

    // MARK: event handling

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

    func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let pass = Unmanaged.passUnretained(event)
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return pass
        }
        if event.getIntegerValueField(.eventSourceUserData) == Keys.syntheticMarker { return pass }

        let input = Keys.input(type: type, event: event)
        // K1's global hotkeys (Hotkeys.swift) see modifier-only shortcuts through this tap too.
        switch input.kind {
        case .flags: Hotkeys.shared.handleFlagsChanged(event)
        case .down where input.code != KeyCodes.f18, .mouse: Hotkeys.shared.handleKeyDown()
        default: break
        }
        var env = KeyEnv()
        if input.kind == .down {
            env.secureInput = IsSecureEventInputEnabled()
            if needsBundleId { env.bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier }
        }
        switch engine.handle(input, env) {
        case .pass:
            return pass
        case .passHyper:
            event.flags = event.flags.union(Keys.hyperFlags)
            return pass
        case .swallow:
            return nil
        case .swallowPostEscape:
            // Hyper tapped alone: a "Hyper" global hotkey wins, otherwise it is Escape.
            if !Hotkeys.shared.handleHyperTap() { postKey(CGKeyCode(KeyCodes.escape)) }
            return nil
        case .queue:
            if queued.count < Keys.maxQueued, let copy = event.copy() { queued.append(copy) }
            return nil
        case let .expand(entry, backspaces):
            startExpansion(entry, backspaces: backspaces, bundleId: env.bundleId ?? NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
            return pass
        case .interceptPaste:
            startStackPaste()
            return nil
        }
    }

    // MARK: snippet expansion

    private func startExpansion(_ entry: SnippetEntry, backspaces: Int, bundleId: String?) {
        guard let id = entry.id else {
            // Static entry: let the keystroke that completed the keyword reach the app first.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
                self.perform(backspaces: backspaces, text: entry.text, html: nil, cursorLeft: 0, keyword: entry.keyword, live: false)
            }
            return
        }
        let reqId = nextRequest
        nextRequest += 1
        pendingExpansion = (reqId, entry, backspaces)
        Output.event("snippet.matched", ["reqId": reqId, "keyword": entry.keyword, "id": id, "bundleId": bundleId.map { $0 as Any } ?? NSNull()])
        DispatchQueue.main.asyncAfter(deadline: .now() + Keys.renderTimeout) { self.finishExpansion(reqId, text: nil, html: nil, cursorLeft: nil) }
    }

    /// snippet.render from main (or the timeout with nil text). Returns false when the request is no longer pending.
    @discardableResult
    func finishExpansion(_ reqId: Int, text: String?, html: String?, cursorLeft: Int?) -> Bool {
        guard let p = pendingExpansion, p.reqId == reqId else { return false }
        pendingExpansion = nil
        engine.expansionFinished()
        let r = renderDecision(fallback: p.entry.text, text: text, html: html, cursorLeft: cursorLeft)
        perform(backspaces: p.backspaces, text: r.text, html: r.html, cursorLeft: r.cursorLeft, keyword: p.entry.keyword, live: r.live)
        return true
    }

    private func perform(backspaces: Int, text: String, html: String?, cursorLeft: Int, keyword: String, live: Bool) {
        for _ in 0..<backspaces { postKey(CGKeyCode(KeyCodes.delete)) }
        if !text.isEmpty || html != nil { Paste.paste(text, html: html) }
        let replay = takeQueue()
        // Give the app a moment to apply the paste before moving the caret / replaying typing.
        DispatchQueue.main.asyncAfter(deadline: .now() + (cursorLeft > 0 || !replay.isEmpty ? 0.06 : 0)) {
            for _ in 0..<cursorLeft { postKey(CGKeyCode(KeyCodes.leftArrow)) }
            Keys.replay(replay)
        }
        Output.event("snippet.expanded", ["keyword": keyword, "live": live])
    }

    // MARK: paste stack

    private func startStackPaste() {
        let reqId = nextRequest
        nextRequest += 1
        pendingPaste = reqId
        Output.event("stack.next", ["reqId": reqId])
        DispatchQueue.main.asyncAfter(deadline: .now() + Keys.stackTimeout) {
            guard self.pendingPaste == reqId else { return }
            self.stackTimeouts += 1
            // Main seems stuck: stop intercepting after two misses so ⌘V is never held hostage.
            let keep = self.stackTimeouts < 2 && self.engine.pasteStack
            self.finishStackPaste(reqId, action: .passOriginal, pasteStack: keep)
        }
    }

    /// stack.reply from main. Returns false when the request already timed out.
    @discardableResult
    func applyStackReply(_ reqId: Int, text: String?, html: String?, passthrough: Bool, empty: Bool, active: Bool?) -> Bool {
        guard pendingPaste == reqId else {
            // Late reply: still honour the new intercept state.
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
        case let .paste(text, html): Paste.paste(text, html: html)
        case .passOriginal: postKey(CGKeyCode(KeyCodes.v), flags: .maskCommand)
        }
        let replay = takeQueue()
        if !replay.isEmpty { DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { Keys.replay(replay) } }
    }

    private func takeQueue() -> [CGEvent] {
        defer { queued = [] }
        return queued
    }

    private static func replay(_ events: [CGEvent]) {
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
        e.setIntegerValueField(.eventSourceUserData, value: Keys.syntheticMarker)
        e.post(tap: .cghidEventTap)
    }
}

enum Paste {
    /// Put text (and HTML) on the pasteboard, press ⌘V, then restore the previous contents after 300 ms.
    /// The write is marked transient/auto-generated (nspasteboard.org) so clipboard managers, Glide's included, skip it.
    static func paste(_ text: String, html: String? = nil) {
        let pb = NSPasteboard.general
        let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
            item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
        }
        pb.clearContents()
        if let html, !html.isEmpty { pb.setString(html, forType: .html) }
        pb.setString(text, forType: .string)
        pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.AutoGeneratedType"))
        let ours = pb.changeCount
        postKey(CGKeyCode(KeyCodes.v), flags: .maskCommand)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            guard pb.changeCount == ours else { return } // something else wrote meanwhile: leave it
            pb.clearContents()
            guard !saved.isEmpty else { return }
            let items = saved.map { pairs -> NSPasteboardItem in
                let it = NSPasteboardItem()
                for (t, d) in pairs { it.setData(d, forType: t) }
                return it
            }
            pb.writeObjects(items)
        }
    }
}

/// Caps Lock → F18 remapping via hidutil. The previous mapping is saved (in memory and in a marker
/// file) so it is restored on disable, exit, signals, and on the next launch after a crash.
enum HID {
    static let capsLock: UInt64 = 0x7_0000_0039
    static let f18: UInt64 = 0x7_0000_006D
    static let dryRun = ProcessInfo.processInfo.environment["GLIDE_HELPER_DRY_RUN"] == "1"
    private static var previous: [(UInt64, UInt64)]?
    /// hidutil --set arguments that dry-run mode would have executed (for tests).
    static var dryRunLog: [String] = []

    private static var markerURL: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("dev.glide.launcher", isDirectory: true)
        return dir.appendingPathComponent("hyper-key-previous-mapping.json")
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

    /// A previous run died while the Hyper key was on: put the user's mapping back.
    static func recoverStale() {
        guard !dryRun, let data = try? Data(contentsOf: markerURL),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[NSNumber]] else { return }
        log("restoring key mapping left by a previous run")
        set(list.compactMap { $0.count == 2 ? ($0[0].uint64Value, $0[1].uint64Value) : nil })
        try? FileManager.default.removeItem(at: markerURL)
    }

    private static func writeMarker(_ mapping: [(UInt64, UInt64)]) {
        try? FileManager.default.createDirectory(at: markerURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: mapping.map { [NSNumber(value: $0.0), NSNumber(value: $0.1)] }) {
            try? data.write(to: markerURL, options: .atomic)
        }
    }

    static func currentMapping() -> [(UInt64, UInt64)] {
        let (status, out) = runTool("/usr/bin/hidutil", ["property", "--get", "UserKeyMapping"])
        guard status == 0 else { return [] }
        return parse(out)
    }

    /// Parses hidutil's NSArray description: `( { HIDKeyboardModifierMappingDst = 30064771181; HIDKeyboardModifierMappingSrc = 30064771129; } )`.
    static func parse(_ text: String) -> [(UInt64, UInt64)] {
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

    static func json(_ mapping: [(UInt64, UInt64)]) -> String {
        let entries = mapping.map { "{\"HIDKeyboardModifierMappingSrc\":\($0.0),\"HIDKeyboardModifierMappingDst\":\($0.1)}" }
        return "{\"UserKeyMapping\":[\(entries.joined(separator: ","))]}"
    }

    private static func set(_ mapping: [(UInt64, UInt64)]) {
        let arg = json(mapping)
        if dryRun {
            log("[dry-run] hidutil property --set \(arg)")
            dryRunLog.append(arg)
            return
        }
        let (status, _) = runTool("/usr/bin/hidutil", ["property", "--set", arg])
        if status != 0 { log("hidutil exited with \(status)") }
    }
}
