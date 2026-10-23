import AppKit
import GlideCore
import SwiftUI

/// Electron-style accelerator from a key press ("Command+Shift+K", "Alt+Space"). Pure (unit-tested).
public enum AcceleratorRecorder {
    public static func accelerator(keyCode: UInt16, characters: String?, command: Bool, option: Bool, control: Bool, shift: Bool) -> String? {
        let named: [UInt16: String] = [49: "Space", 36: "Enter", 48: "Tab", 51: "Backspace", 117: "Delete", 53: "Escape",
                                       123: "Left", 124: "Right", 125: "Down", 126: "Up", 115: "Home", 119: "End", 116: "PageUp", 121: "PageDown",
                                       122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12"]
        let key: String
        if let n = named[keyCode] { key = n }
        else if let c = characters?.uppercased(), c.count == 1, let ch = c.first, ch.isLetter || ch.isNumber || "`-=[]\\;',./".contains(ch) { key = String(ch) }
        else { return nil }
        var parts: [String] = []
        if control { parts.append("Control") }
        if option { parts.append("Alt") }
        if shift { parts.append("Shift") }
        if command { parts.append("Command") }
        return (parts + [key]).joined(separator: "+")
    }
}

/// A focusable field that records the next key combination (local to this view: no global tap).
public struct HotkeyRecorderField: NSViewRepresentable {
    public var value: String?
    public var placeholder: String
    public var onChange: (String) -> Void
    public init(value: String?, placeholder: String = "Click, then press keys", onChange: @escaping (String) -> Void) {
        self.value = value
        self.placeholder = placeholder
        self.onChange = onChange
    }
    public func makeNSView(context: Context) -> RecorderView {
        let v = RecorderView()
        v.onChange = onChange
        return v
    }
    public func updateNSView(_ v: RecorderView, context: Context) {
        v.onChange = onChange
        v.value = value
        v.placeholder = placeholder
        v.needsDisplay = true
    }

    public final class RecorderView: NSView {
        var value: String?
        var placeholder = ""
        var onChange: (String) -> Void = { _ in }
        private var recording = false { didSet { needsDisplay = true } }
        override public var acceptsFirstResponder: Bool { true }
        override public var canBecomeKeyView: Bool { true }
        override public var intrinsicContentSize: NSSize { NSSize(width: 200, height: 26) }
        override public func becomeFirstResponder() -> Bool { recording = true; return true }
        override public func resignFirstResponder() -> Bool { recording = false; return true }
        override public func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }
        override public func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard window?.firstResponder === self else { return false }
            keyDown(with: event)
            return true
        }
        override public func keyDown(with event: NSEvent) {
            let f = event.modifierFlags
            if event.keyCode == 48 && f.intersection([.command, .option, .control]).isEmpty { // plain Tab moves focus
                f.contains(.shift) ? window?.selectPreviousKeyView(self) : window?.selectNextKeyView(self)
                return
            }
            if event.keyCode == 53 && f.intersection([.command, .option, .control, .shift]).isEmpty { window?.makeFirstResponder(nil); return }
            if let a = AcceleratorRecorder.accelerator(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers, command: f.contains(.command),
                                                       option: f.contains(.option), control: f.contains(.control), shift: f.contains(.shift)) {
                value = a
                onChange(a)
                needsDisplay = true
            }
        }
        override public func draw(_ dirtyRect: NSRect) {
            let r = bounds.insetBy(dx: 1, dy: 1)
            let path = NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6)
            NSColor.controlBackgroundColor.setFill()
            path.fill()
            (recording ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
            path.lineWidth = recording ? 2 : 1
            path.stroke()
            let text = recording ? "Press a shortcut…  (Esc to cancel)" : value.map(Accelerator.display) ?? placeholder
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .medium),
                                                        .foregroundColor: value == nil || recording ? NSColor.secondaryLabelColor : NSColor.labelColor]
            let s = NSAttributedString(string: text, attributes: attrs)
            let size = s.size()
            s.draw(at: NSPoint(x: r.midX - size.width / 2, y: r.midY - size.height / 2))
        }
        override public func isAccessibilityElement() -> Bool { true }
        override public func accessibilityRole() -> NSAccessibility.Role? { .button }
        override public func accessibilityLabel() -> String? { "Hotkey recorder: \(value.map(Accelerator.display) ?? "none")" }
    }
}
