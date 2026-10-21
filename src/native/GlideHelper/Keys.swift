import AppKit
import ApplicationServices

private let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    Keys.shared.handle(type: type, event: event)
}

/// Keyboard event tap: snippet expansion and the Hyper key. All state lives on the main thread.
final class Keys {
    static let shared = Keys()

    /// Marks events we synthesize so the tap lets them through untouched.
    static let syntheticMarker: Int64 = 0x474C_4944 // "GLID"
    static let f18: Int64 = 79
    private static let hyperFlags: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
    private static let resetKeys: Set<Int64> = [36, 76, 48, 53, 123, 124, 125, 126, 115, 119, 116, 121, 117]

    private var snippets: [(keyword: String, text: String)] = []
    private var hyper = false
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var buffer = ""
    private var maxKeyword = 0
    private var hyperDown = false
    private var hyperUsed = false

    // MARK: configuration

    /// Returns an error message when the tap could not be created.
    func configure(snippets list: [(String, String)], hyper wantsHyper: Bool) -> String? {
        snippets = list.filter { !$0.0.isEmpty && !$0.1.isEmpty }.map { (keyword: $0.0, text: $0.1) }.sorted { $0.keyword.count > $1.keyword.count }
        maxKeyword = snippets.map { $0.keyword.count }.max() ?? 0
        buffer = ""
        hyper = wantsHyper
        let error = ensureTap()
        if hyper && tap != nil { HID.enable() } else { HID.disable() }
        return error
    }

    /// Called when permissions change: retry a tap that failed earlier.
    func retryIfNeeded() {
        guard tap == nil, hyper || !snippets.isEmpty else { return }
        if ensureTap() == nil, hyper { HID.enable() }
    }

    func shutdown() {
        HID.disable()
        removeTap()
    }

    func resetBuffer() {
        if Thread.isMainThread { buffer = "" } else { DispatchQueue.main.async { self.buffer = "" } }
    }

    private func ensureTap() -> String? {
        guard hyper || !snippets.isEmpty else { removeTap(); return nil }
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
        hyperDown = false
    }

    // MARK: event handling

    func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let pass = Unmanaged.passUnretained(event)
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return pass
        }
        if event.getIntegerValueField(.eventSourceUserData) == Keys.syntheticMarker { return pass }

        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            buffer = ""
            return pass
        case .flagsChanged:
            if !event.flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty { buffer = "" }
            return pass
        case .keyDown, .keyUp:
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            if hyper && code == Keys.f18 {
                if type == .keyDown {
                    if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { hyperDown = true; hyperUsed = false }
                } else {
                    hyperDown = false
                    if !hyperUsed { postKey(53) } // tapped alone: Escape
                }
                return nil
            }
            if hyper && hyperDown {
                event.flags = event.flags.union(Keys.hyperFlags)
                if type == .keyDown { hyperUsed = true }
                buffer = ""
                return pass
            }
            if type == .keyDown && !snippets.isEmpty { track(event, code: code) }
            return pass
        default:
            return pass
        }
    }

    private func track(_ event: CGEvent, code: Int64) {
        if Keys.resetKeys.contains(code) || !event.flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty {
            buffer = ""
            return
        }
        if code == 51 { // delete
            if !buffer.isEmpty { buffer.removeLast() }
            return
        }
        var length = 0
        var chars = [UniChar](repeating: 0, count: 8)
        event.keyboardGetUnicodeString(maxStringLength: chars.count, actualStringLength: &length, unicodeString: &chars)
        guard length > 0 else { return }
        buffer += String(utf16CodeUnits: chars, count: length)
        let cap = max(64, maxKeyword * 2)
        if buffer.count > cap { buffer = String(buffer.suffix(cap)) }
        for s in snippets where buffer.hasSuffix(s.keyword) {
            buffer = ""
            let keyword = s.keyword, text = s.text
            // Let the keystroke that completed the keyword reach the app first.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { self.expand(keyword: keyword, text: text) }
            return
        }
    }

    private func expand(keyword: String, text: String) {
        for _ in 0..<keyword.count { postKey(51) }
        Paste.paste(text)
        Output.event("snippet.expanded", ["keyword": keyword])
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
    /// Put text on the pasteboard, press ⌘V, then restore the previous contents after 300 ms.
    static func paste(_ text: String) {
        let pb = NSPasteboard.general
        let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { item in
            item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }
        }
        pb.clearContents()
        pb.setString(text, forType: .string)
        // Convention (nspasteboard.org) so clipboard managers skip this transient write.
        pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        pb.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.AutoGeneratedType"))
        let ours = pb.changeCount
        postKey(9, flags: .maskCommand)
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
