import Foundation

public enum QuicklinkURL {
    /// encodeURIComponent: everything except A–Z a–z 0–9 - _ . ! ~ * ' ( ) is percent-encoded (UTF-8).
    public static func encodeComponent(_ s: String) -> String {
        var allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        allowed.remove(charactersIn: "")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    /// Whether the template takes the launcher argument (`{query}` or `{argument …}` placeholders).
    public static func acceptsArgument(_ template: String) -> Bool {
        template.contains("{query}") || template.range(of: "\\{argument[^}]*\\}", options: .regularExpression) != nil
    }

    /// Fill `{query}` (and, in phase 0, any `{argument …}` placeholder) with the URL-encoded argument.
    /// Full placeholder support (named arguments, dates, clipboard, selection) is a phase-1 task —
    /// see src/main/quicklinks/placeholders.ts.
    public static func fill(_ template: String, argument: String?) -> String {
        let enc = encodeComponent(argument ?? "")
        var out = template.replacingOccurrences(of: "{query}", with: enc)
        out = out.replacingOccurrences(of: "\\{argument[^}]*\\}", with: enc.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "$", with: "\\$"), options: .regularExpression)
        return out
    }
}

public enum Accelerator {
    private static let symbols: [String: String] = [
        "cmd": "⌘", "command": "⌘", "cmdorctrl": "⌘", "commandorcontrol": "⌘", "super": "⌘", "meta": "⌘",
        "ctrl": "⌃", "control": "⌃", "alt": "⌥", "option": "⌥", "shift": "⇧", "space": "␣", "enter": "⏎", "return": "⏎",
        "tab": "⇥", "esc": "⎋", "escape": "⎋", "backspace": "⌫", "delete": "⌦", "up": "↑", "down": "↓", "left": "←", "right": "→",
    ]
    private static let order = ["⌃", "⌥", "⇧", "⌘"]

    /// "Alt+Cmd+K" → "⌥⌘K" (src/main/util/accel.ts accelToDisplay).
    public static func display(_ accel: String) -> String {
        let parts = accel.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var mods: [String] = []
        var keys: [String] = []
        for p in parts {
            let sym = symbols[p.lowercased()]
            if let sym, order.contains(sym) { mods.append(sym) } else { keys.append(sym ?? p.uppercased()) }
        }
        mods.sort { order.firstIndex(of: $0)! < order.firstIndex(of: $1)! }
        return (mods + keys).joined()
    }
}
