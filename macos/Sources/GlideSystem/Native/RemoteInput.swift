import AppKit
import ApplicationServices
import CoreGraphics
import GlideCore

// Remote control from a paired phone (Glide on iPhone, docs/PHONE.md "Remote control"): pointer moves, clicks,
// scrolling, key presses and typed text, posted as CGEvents. The protocol has a headless fake
// (Headless/HeadlessRemoteInput.swift) that only records what it would have done; tests never post events.

public enum RemoteMouseButton: String, Sendable, CaseIterable { case left, right, middle }

public struct RemoteModifiers: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let command = RemoteModifiers(rawValue: 1)
    public static let shift = RemoteModifiers(rawValue: 2)
    public static let option = RemoteModifiers(rawValue: 4)
    public static let control = RemoteModifiers(rawValue: 8)

    /// "cmd", "command", "⌘", "shift", "alt", "option", "opt", "ctrl", "control" (case-insensitive). nil when a name is unknown.
    public static func parse(_ names: [String]) -> RemoteModifiers? {
        var m: RemoteModifiers = []
        for raw in names {
            switch raw.lowercased().trimmingCharacters(in: .whitespaces) {
            case "cmd", "command", "meta", "⌘": m.insert(.command)
            case "shift", "⇧": m.insert(.shift)
            case "alt", "option", "opt", "⌥": m.insert(.option)
            case "ctrl", "control", "⌃": m.insert(.control)
            case "": continue
            default: return nil
            }
        }
        return m
    }

    public var names: [String] {
        var out: [String] = []
        if contains(.control) { out.append("ctrl") }
        if contains(.option) { out.append("alt") }
        if contains(.shift) { out.append("shift") }
        if contains(.command) { out.append("cmd") }
        return out
    }

    var cgFlags: CGEventFlags {
        var f: CGEventFlags = []
        if contains(.command) { f.insert(.maskCommand) }
        if contains(.shift) { f.insert(.maskShift) }
        if contains(.option) { f.insert(.maskAlternate) }
        if contains(.control) { f.insert(.maskControl) }
        return f
    }
}

/// Key names the phone sends → macOS virtual key codes (ANSI layout positions).
public enum RemoteKeys {
    public static let codes: [String: UInt16] = {
        var m: [String: UInt16] = [
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
            "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "left": 123, "right": 124, "down": 125, "up": 126,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
            "f11": 103, "f12": 111,
            "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50,
        ]
        let letters: [(Character, UInt16)] = [("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9),
                                              ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("o", 31), ("u", 32),
                                              ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("k", 40), ("n", 45), ("m", 46)]
        for (c, code) in letters { m[String(c)] = code }
        let digits: [(Character, UInt16)] = [("1", 18), ("2", 19), ("3", 20), ("4", 21), ("5", 23), ("6", 22), ("7", 26), ("8", 28), ("9", 25), ("0", 29)]
        for (c, code) in digits { m[String(c)] = code }
        return m
    }()

    /// The virtual key code for a key name ("left", "return", "k", "f5"), nil when unknown.
    public static func code(for name: String) -> UInt16? {
        let n = name.count == 1 ? name.lowercased() : name.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "_", with: "")
        return codes[n]
    }
}

@MainActor public protocol RemoteInputService: AnyObject {
    /// Whether Glide may post events (Accessibility). Never prompts.
    var isTrusted: Bool { get }
    /// Move the pointer by a delta in points, clamped to the screens.
    func movePointer(dx: Double, dy: Double)
    /// Click at the pointer (`count` 2 = double click).
    func click(button: RemoteMouseButton, count: Int)
    /// Scroll by a delta in pixels (positive dy scrolls content up, like a trackpad swipe down).
    func scroll(dx: Double, dy: Double)
    /// Press and release one key with modifiers.
    func press(keyCode: UInt16, modifiers: RemoteModifiers)
    /// Type text into the focused field (Unicode key events, independent of the keyboard layout).
    func type(text: String)
}

/// The live implementation: CGEvents posted at the HID tap, marked so Glide's own keyboard tap ignores them.
@MainActor public final class CGEventRemoteInput: RemoteInputService {
    public init() {}

    public var isTrusted: Bool { AXIsProcessTrusted() }

    private var source: CGEventSource? { CGEventSource(stateID: .privateState) }

    private func post(_ e: CGEvent) {
        e.setIntegerValueField(.eventSourceUserData, value: EventTapKeyboardService.syntheticMarker)
        e.post(tap: .cghidEventTap)
    }

    private var location: CGPoint { CGEvent(source: nil)?.location ?? .zero }

    /// The union of the active displays (global coordinates, origin top-left of the main display).
    private func screenBounds() -> CGRect {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return CGDisplayBounds(CGMainDisplayID()) }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return CGDisplayBounds(CGMainDisplayID()) }
        return ids.prefix(Int(count)).map { CGDisplayBounds($0) }.reduce(CGRect.null) { $0.union($1) }
    }

    public func movePointer(dx: Double, dy: Double) {
        let b = screenBounds()
        let p = location
        let to = CGPoint(x: min(max(p.x + dx, b.minX), b.maxX - 1), y: min(max(p.y + dy, b.minY), b.maxY - 1))
        guard let e = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: to, mouseButton: .left) else { return }
        post(e)
    }

    public func click(button: RemoteMouseButton, count: Int) {
        let p = location
        let (down, up, cg): (CGEventType, CGEventType, CGMouseButton) = switch button {
        case .left: (.leftMouseDown, .leftMouseUp, .left)
        case .right: (.rightMouseDown, .rightMouseUp, .right)
        case .middle: (.otherMouseDown, .otherMouseUp, .center)
        }
        for n in 1...max(1, min(count, 3)) {
            for type in [down, up] {
                guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: cg) else { continue }
                e.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                post(e)
            }
        }
    }

    public func scroll(dx: Double, dy: Double) {
        guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                              wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0) else { return }
        post(e)
    }

    public func press(keyCode: UInt16, modifiers: RemoteModifiers) {
        let src = source
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(keyCode), keyDown: down) else { continue }
            e.flags = modifiers.cgFlags
            post(e)
        }
    }

    public func type(text: String) {
        let units = Array(text.utf16)
        let src = source
        var i = 0
        while i < units.count {
            // CGEvent carries at most 20 UTF-16 units per event; don't split a surrogate pair.
            var end = min(i + 16, units.count)
            if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
            let chunk = Array(units[i..<end])
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { continue }
                chunk.withUnsafeBufferPointer { e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                post(e)
            }
            i = end
        }
    }
}
