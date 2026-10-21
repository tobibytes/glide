import AppKit
import ApplicationServices

enum Menus {
    private static let lock = NSLock()
    private static var cache: [pid_t: (Date, [[String: Any]])] = [:]
    private static let maxDepth = 4

    static func list(pid requested: pid_t?) throws -> [[String: Any]] {
        guard AXIsProcessTrusted() else { return [] }
        guard let app = Apps.shared.app(pid: requested) else { return [] }
        let pid = app.processIdentifier
        lock.lock()
        if let hit = cache[pid], Date().timeIntervalSince(hit.0) < 5 { lock.unlock(); return hit.1 }
        lock.unlock()

        var out: [[String: Any]] = []
        var seen = Set<String>()
        let axApp = AX.app(pid)
        guard let bar = AX.element(axApp, kAXMenuBarAttribute) else { return [] }
        for (i, barItem) in AX.children(bar).enumerated() where i > 0 { // index 0 is the Apple menu
            guard let title = AX.attr(barItem, kAXTitleAttribute) as? String, !title.isEmpty,
                  let menu = AX.children(barItem).first else { continue }
            walk(menu, path: [title], into: &out, seen: &seen)
        }
        lock.lock()
        cache[pid] = (Date(), out)
        lock.unlock()
        return out
    }

    private static let itemAttrs = [kAXTitleAttribute, kAXEnabledAttribute, kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute, kAXMenuItemCmdVirtualKeyAttribute, kAXMenuItemCmdGlyphAttribute, kAXChildrenAttribute]

    private static func walk(_ menu: AXUIElement, path: [String], into out: inout [[String: Any]], seen: inout Set<String>) {
        for item in AX.children(menu) {
            let v = AX.attrs(item, itemAttrs)
            guard let title = v[0] as? String, !title.isEmpty else { continue } // separators have no title
            let p = path + [title]
            let kids = (v[6] as? [AXUIElement]) ?? []
            if let sub = kids.first {
                if p.count < maxDepth { walk(sub, path: p, into: &out, seen: &seen) }
                continue
            }
            let key = p.joined(separator: "\u{1F}")
            if seen.contains(key) { continue }
            seen.insert(key)
            var entry: [String: Any] = ["path": p, "enabled": (v[1] as? Bool) ?? true]
            if let s = shortcut(char: v[2] as? String, modifiers: (v[3] as? NSNumber)?.intValue, virtualKey: (v[4] as? NSNumber)?.intValue, glyph: (v[5] as? NSNumber)?.intValue) {
                entry["shortcut"] = s
            }
            out.append(entry)
        }
    }

    private static let virtualKeys: [Int: String] = [
        36: "↩", 48: "⇥", 49: "Space", 51: "⌫", 53: "⎋", 117: "⌦", 123: "←", 124: "→", 125: "↓", 126: "↑",
        115: "↖", 119: "↘", 116: "⇞", 121: "⇟", 76: "⌤",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
    ]
    private static let glyphs: [Int: String] = [
        0x02: "⇥", 0x04: "⌤", 0x09: "Space", 0x0A: "⌦", 0x0B: "↩", 0x17: "⌫", 0x1B: "⎋",
        0x64: "←", 0x65: "→", 0x68: "↑", 0x6A: "↓", 0x6F: "F1", 0x70: "F2", 0x71: "F3", 0x72: "F4",
        0x73: "F5", 0x74: "F6", 0x75: "F7", 0x76: "F8", 0x77: "F9", 0x78: "F10", 0x79: "F11", 0x7A: "F12",
    ]

    /// kAXMenuItemCmdModifiers bits: 1 shift, 2 option, 4 control, 8 = no ⌘.
    static func shortcut(char: String?, modifiers: Int?, virtualKey: Int?, glyph: Int?) -> String? {
        var key: String?
        if let c = char, !c.isEmpty, c.unicodeScalars.first.map({ $0.value >= 0x20 && $0.value != 0x7F }) == true {
            key = c == " " ? "Space" : c.uppercased()
        } else if let g = glyph, let s = glyphs[g] {
            key = s
        } else if let vk = virtualKey, let s = virtualKeys[vk] {
            key = s
        }
        guard let key else { return nil }
        let m = modifiers ?? 0
        var s = ""
        if m & 4 != 0 { s += "⌃" }
        if m & 2 != 0 { s += "⌥" }
        if m & 1 != 0 { s += "⇧" }
        if m & 8 == 0 { s += "⌘" }
        return s + key
    }

    static func press(pid requested: pid_t?, path: [String]) -> [String: Any] {
        func fail(_ m: String) -> [String: Any] { ["ok": false, "error": m] }
        guard AXIsProcessTrusted() else { return fail("Accessibility permission required") }
        guard path.count >= 2 else { return fail("Invalid menu path") }
        guard let app = Apps.shared.app(pid: requested) else { return fail("No application to act on") }
        let axApp = AX.app(app.processIdentifier)
        guard let bar = AX.element(axApp, kAXMenuBarAttribute) else { return fail("This app has no menu bar") }
        var container: AXUIElement = bar
        var current: AXUIElement?
        for (i, title) in path.enumerated() {
            let items = i == 0 ? AX.children(container) : AX.children(container)
            guard let match = items.first(where: { (AX.attr($0, kAXTitleAttribute) as? String) == title }) else {
                return fail("Menu item “\(path.joined(separator: " › "))” no longer exists")
            }
            current = match
            if i < path.count - 1 {
                guard let sub = AX.children(match).first else { return fail("Menu “\(title)” has no submenu") }
                container = sub
            }
        }
        guard let item = current else { return fail("Menu item not found") }
        if let enabled = AX.attr(item, kAXEnabledAttribute) as? Bool, !enabled { return fail("That menu item is disabled") }
        lock.lock(); cache[app.processIdentifier] = nil; lock.unlock()
        let err = AXUIElementPerformAction(item, kAXPressAction as CFString)
        // cannotComplete usually means the action opened something modal and the reply timed out.
        return err == .success || err == .cannotComplete ? ["ok": true] : fail("Could not press the menu item (AX error \(err.rawValue))")
    }
}
