import AppKit
import ApplicationServices
import GlideCore

/// The target app's menu bar via Accessibility (helper Menus.swift). Cached for 5 s per pid.
@MainActor public final class AXMenuService: MenuService {
    private let frontmost: FrontmostTracker
    private var cache: [pid_t: (Date, [MenuItemInfo])] = [:]
    public init(frontmost: FrontmostTracker) { self.frontmost = frontmost }

    public func list(pid requested: Int32?) async -> [MenuItemInfo] {
        guard AXIsProcessTrusted(), let app = frontmost.app(pid: requested) else { return [] }
        let pid = app.processIdentifier
        if let hit = cache[pid], Date().timeIntervalSince(hit.0) < 5 { return hit.1 }
        let items = await offMain { MenuReader.read(pid: pid) }
        cache[pid] = (Date(), items)
        return items
    }

    public func press(pid requested: Int32?, path: [String]) async -> ServiceResult {
        guard AXIsProcessTrusted() else { return .failure("Accessibility permission required") }
        guard path.count >= 2 else { return .failure("Invalid menu path") }
        guard let app = frontmost.app(pid: requested) else { return .failure("No application to act on") }
        let pid = app.processIdentifier
        cache[pid] = nil
        return await offMain { MenuReader.press(pid: pid, path: path) }
    }
}

public enum MenuReader {
    static let maxDepth = 4
    private static let itemAttrs = [kAXTitleAttribute, kAXEnabledAttribute, kAXMenuItemCmdCharAttribute, kAXMenuItemCmdModifiersAttribute,
                                    kAXMenuItemCmdVirtualKeyAttribute, kAXMenuItemCmdGlyphAttribute, kAXChildrenAttribute]

    static func read(pid: pid_t) -> [MenuItemInfo] {
        var out: [MenuItemInfo] = []
        var seen = Set<String>()
        let axApp = AX.app(pid)
        guard let bar = AX.element(axApp, kAXMenuBarAttribute) else { return [] }
        for (i, barItem) in AX.children(bar).enumerated() where i > 0 { // 0 is the Apple menu
            guard let title = AX.attr(barItem, kAXTitleAttribute) as? String, !title.isEmpty, let menu = AX.children(barItem).first else { continue }
            walk(menu, path: [title], into: &out, seen: &seen)
        }
        return out
    }

    private static func walk(_ menu: AXUIElement, path: [String], into out: inout [MenuItemInfo], seen: inout Set<String>) {
        for item in AX.children(menu) {
            let v = AX.attrs(item, itemAttrs)
            guard let title = v[0] as? String, !title.isEmpty else { continue }
            let p = path + [title]
            let kids = (v[6] as? [AXUIElement]) ?? []
            if let sub = kids.first {
                if p.count < maxDepth { walk(sub, path: p, into: &out, seen: &seen) }
                continue
            }
            guard seen.insert(p.joined(separator: "\u{1F}")).inserted else { continue }
            out.append(MenuItemInfo(path: p, enabled: (v[1] as? Bool) ?? true,
                                    shortcut: shortcut(char: v[2] as? String, modifiers: (v[3] as? NSNumber)?.intValue,
                                                       virtualKey: (v[4] as? NSNumber)?.intValue, glyph: (v[5] as? NSNumber)?.intValue)))
        }
    }

    static func press(pid: pid_t, path: [String]) -> ServiceResult {
        let axApp = AX.app(pid)
        guard let bar = AX.element(axApp, kAXMenuBarAttribute) else { return .failure("This app has no menu bar") }
        var container: AXUIElement = bar
        var current: AXUIElement?
        for (i, title) in path.enumerated() {
            guard let match = AX.children(container).first(where: { (AX.attr($0, kAXTitleAttribute) as? String) == title }) else {
                return .failure("Menu item “\(path.joined(separator: " › "))” no longer exists")
            }
            current = match
            if i < path.count - 1 {
                guard let sub = AX.children(match).first else { return .failure("Menu “\(title)” has no submenu") }
                container = sub
            }
        }
        guard let item = current else { return .failure("Menu item not found") }
        if let enabled = AX.attr(item, kAXEnabledAttribute) as? Bool, !enabled { return .failure("That menu item is disabled") }
        let err = AXUIElementPerformAction(item, kAXPressAction as CFString)
        return err == .success || err == .cannotComplete ? .success : .failure("Could not press the menu item (AX error \(err.rawValue))")
    }

    static let virtualKeys: [Int: String] = [
        36: "↩", 48: "⇥", 49: "Space", 51: "⌫", 53: "⎋", 117: "⌦", 123: "←", 124: "→", 125: "↓", 126: "↑",
        115: "↖", 119: "↘", 116: "⇞", 121: "⇟", 76: "⌤",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
    ]
    static let glyphs: [Int: String] = [
        0x02: "⇥", 0x04: "⌤", 0x09: "Space", 0x0A: "⌦", 0x0B: "↩", 0x17: "⌫", 0x1B: "⎋",
        0x64: "←", 0x65: "→", 0x68: "↑", 0x6A: "↓", 0x6F: "F1", 0x70: "F2", 0x71: "F3", 0x72: "F4",
        0x73: "F5", 0x74: "F6", 0x75: "F7", 0x76: "F8", 0x77: "F9", 0x78: "F10", 0x79: "F11", 0x7A: "F12",
    ]

    /// kAXMenuItemCmdModifiers bits: 1 shift, 2 option, 4 control, 8 = no ⌘.
    public static func shortcut(char: String?, modifiers: Int?, virtualKey: Int?, glyph: Int?) -> String? {
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
}
