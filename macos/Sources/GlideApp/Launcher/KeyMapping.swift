import AppKit
import GlideCore
import GlideSystem

enum KeyMapping {
    /// NSEvent → the DOM-style key names the vim model uses.
    static func vimKey(_ e: NSEvent) -> VimKey? {
        guard e.type == .keyDown else { return nil }
        let f = e.modifierFlags
        let name: String
        switch e.keyCode {
        case 125: name = "ArrowDown"
        case 126: name = "ArrowUp"
        case 123: name = "ArrowLeft"
        case 124: name = "ArrowRight"
        case 36, 76: name = "Enter"
        case 53: name = "Escape"
        case 51: name = "Backspace"
        case 117: name = "Delete"
        case 48: name = "Tab"
        default:
            guard let c = e.charactersIgnoringModifiers, !c.isEmpty else { return nil }
            // ⌘K / ⌃J on a Cyrillic, Greek… layout: match shortcuts by the US key at that position.
            name = f.contains(.command) || f.contains(.control) ? PanelKeyInput.shortcutKey(keyCode: e.keyCode, characters: c) : c
        }
        return VimKey(name, ctrl: f.contains(.control), meta: f.contains(.command), shift: f.contains(.shift), alt: f.contains(.option))
    }

    /// Test-channel key names: "down", "up", "enter", "esc", "tab", "backspace", "cmdK", "cmdEnter", "ctrlJ",
    /// "cmd+1", "shift+tab", or a single character ("j", "G", "/").
    static func parse(_ raw: String) -> VimKey? {
        let aliases: [String: String] = ["cmdK": "cmd+k", "cmdEnter": "cmd+enter", "ctrlJ": "ctrl+j", "ctrlK": "ctrl+k", "ctrlN": "ctrl+n", "ctrlP": "ctrl+p",
                                         "ctrlD": "ctrl+d", "ctrlU": "ctrl+u", "shiftEnter": "shift+enter", "cmdE": "cmd+e"]
        var s = aliases[raw] ?? raw
        if s.count == 1 { return VimKey(s, shift: s.first!.isUppercase || "{}?:\"<>|~!@#$%^&*()_+".contains(s)) }
        if s.hasPrefix("cmd") && s.count == 4, let d = s.last, d.isNumber { s = "cmd+\(d)" }
        var parts = s.split(separator: "+").map(String.init)
        guard let last = parts.popLast() else { return nil }
        var k = VimKey("")
        for p in parts {
            switch p.lowercased() {
            case "cmd", "meta", "command": k.meta = true
            case "ctrl", "control": k.ctrl = true
            case "alt", "option", "opt": k.alt = true
            case "shift": k.shift = true
            default: return nil
            }
        }
        switch last.lowercased() {
        case "down": k.key = "ArrowDown"
        case "up": k.key = "ArrowUp"
        case "left": k.key = "ArrowLeft"
        case "right": k.key = "ArrowRight"
        case "enter", "return": k.key = "Enter"
        case "esc", "escape": k.key = "Escape"
        case "backspace": k.key = "Backspace"
        case "tab": k.key = "Tab"
        case "space": k.key = " "
        default:
            guard last.count == 1 else { return nil }
            k.key = last
        }
        return k
    }

    /// Display string of a key press for matching action shortcuts ("⌘E", "⇧⌘C", "⌃X").
    static func shortcutString(_ k: VimKey) -> String {
        var s = ""
        if k.ctrl { s += "⌃" }
        if k.alt { s += "⌥" }
        if k.shift { s += "⇧" }
        if k.meta { s += "⌘" }
        let key: String
        switch k.key {
        case "Enter": key = "↩"
        case "Backspace": key = "⌫"
        default: key = k.key.uppercased()
        }
        return s + key
    }

    static func normalizeShortcut(_ s: String) -> String { s.replacingOccurrences(of: "⏎", with: "↩") }
}
