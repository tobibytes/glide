import AppKit
import GlideCore

/// NSStatusItem renderer for the shared status-item API (live app only; headless runs use `HeadlessStatusItems`).
/// One NSStatusItem per composed item, created lazily and diffed field by field; menus are rebuilt only when their
/// structure changes, never while open (the rebuild waits for `menuDidClose`). Clicks dispatch by path to the
/// latest composed menu, so a re-render with new handlers never leaves a stale action behind.
@MainActor public final class SystemStatusItemService: StatusItemHub {
    private var renderers: [String: StatusItemRenderer] = [:]

    override public init() { super.init() }

    override public func render(_ items: [ComposedStatusItem], removed: [String]) {
        for id in removed {
            renderers[id]?.destroy()
            renderers[id] = nil
        }
        for c in items {
            let r = renderers[c.id] ?? StatusItemRenderer(id: c.id, glide: c.id == StatusItemComposer.glideID, hub: self)
            renderers[c.id] = r
            r.apply(c)
        }
    }
}

@MainActor final class StatusItemRenderer: NSObject, NSMenuDelegate {
    let id: String
    private let glide: Bool
    private weak var hub: StatusItemHub?
    private var item: NSStatusItem?
    private var applied: (title: String?, icon: String??, tooltip: String?, menuKey: String?) = (nil, nil, nil, nil)
    private var pendingMenu: [StatusMenuItem]?
    private var open = false

    init(id: String, glide: Bool, hub: StatusItemHub) {
        self.id = id
        self.glide = glide
        self.hub = hub
        super.init()
        item = NSStatusBar.system.statusItem(withLength: glide ? NSStatusItem.squareLength : NSStatusItem.variableLength)
    }

    func apply(_ c: ComposedStatusItem) {
        guard let item, let button = item.button else { return }
        if applied.icon.map({ $0 != c.icon }) ?? true {
            applied.icon = .some(c.icon)
            button.image = c.icon.flatMap(StatusItemImages.image)
        }
        if applied.title != c.title {
            applied.title = c.title
            if glide { item.length = c.title.isEmpty ? NSStatusItem.squareLength : NSStatusItem.variableLength }
            button.imagePosition = c.title.isEmpty ? .imageOnly : (button.image == nil ? .noImage : .imageLeading)
            let text = c.title.isEmpty ? "" : (button.image == nil ? c.title : " \(c.title)")
            button.attributedTitle = NSAttributedString(string: text, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)])
        }
        let tip = c.tooltip ?? ""
        if applied.tooltip != tip {
            applied.tooltip = tip
            button.toolTip = tip.isEmpty ? nil : tip
        }
        let key = StatusMenuJSON.key(c.menu)
        if key != applied.menuKey {
            applied.menuKey = key
            if open { pendingMenu = c.menu } else { item.menu = build(c.menu, prefix: []) }
        }
    }

    func destroy() {
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
    }

    private func build(_ items: [StatusMenuItem], prefix: [Int]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        if prefix.isEmpty { menu.delegate = self }
        for (i, m) in items.enumerated() {
            switch m.kind {
            case .separator: menu.addItem(.separator()); continue
            case .header: menu.addItem(NSMenuItem.sectionHeader(title: m.title)); continue
            case .item: break
            }
            let mi = NSMenuItem(title: m.title, action: nil, keyEquivalent: "")
            if let sub = m.subtitle, !sub.isEmpty {
                if #available(macOS 14.4, *) { mi.subtitle = sub } else { mi.toolTip = sub }
            }
            if let t = m.tooltip, !t.isEmpty { mi.toolTip = t }
            if let icon = m.icon, let img = StatusItemImages.image(icon) {
                img.size = NSSize(width: 16, height: 16)
                mi.image = img
            }
            if let sc = m.shortcut, let k = StatusItemShortcut.parse(sc) {
                mi.keyEquivalent = k.key
                mi.keyEquivalentModifierMask = k.modifiers
            }
            mi.isEnabled = m.enabled
            mi.state = m.checked ? .on : .off
            let path = prefix + [i]
            if let sub = m.submenu { mi.submenu = build(sub, prefix: path) }
            if m.onClick != nil {
                mi.representedObject = path.map(String.init).joined(separator: ".")
                mi.target = self
                mi.action = #selector(clicked(_:))
            }
            menu.addItem(mi)
        }
        return menu
    }

    @objc private func clicked(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        let path = p.split(separator: ".").compactMap { Int($0) }
        let hub = hub, id = id
        // After the menu closed (handlers may open windows or rebuild this menu).
        DispatchQueue.main.async { MainActor.assumeIsolated { _ = hub?.click(id, path: path) } }
    }

    func menuWillOpen(_ menu: NSMenu) {
        open = true
        hub?.menuWillOpen(id)
    }

    func menuDidClose(_ menu: NSMenu) {
        open = false
        if let m = pendingMenu {
            pendingMenu = nil
            item?.menu = build(m, prefix: [])
        }
    }
}

public enum StatusItemImages {
    /// SF Symbol (template), an absolute image path ("…Template.png" stays a template), or text (emoji) drawn as an image.
    @MainActor public static func image(_ icon: String) -> NSImage? {
        let icon = icon.hasPrefix("file://") ? (URL(string: icon)?.path ?? String(icon.dropFirst(7))) : icon
        if icon.isEmpty { return nil }
        if icon.hasPrefix("/") {
            guard let img = NSImage(contentsOfFile: icon) else { return nil }
            img.isTemplate = icon.hasSuffix("Template.png") || icon.hasSuffix("Template@2x.png")
            img.size = NSSize(width: 18, height: 18)
            return img
        }
        if let img = NSImage(systemSymbolName: icon, accessibilityDescription: nil) {
            img.isTemplate = true
            return img
        }
        let s = NSAttributedString(string: icon, attributes: [.font: NSFont.systemFont(ofSize: 14)])
        let size = s.size()
        guard size.width > 0, size.height > 0 else { return nil }
        return NSImage(size: size, flipped: false) { r in s.draw(in: r); return true }
    }
}

public enum StatusItemShortcut {
    /// "⌘⇧R" (display glyphs) or "CommandOrControl+Shift+R" (accelerator) → key equivalent (display only: menus
    /// handle it while open).
    public static func parse(_ s: String) -> (key: String, modifiers: NSEvent.ModifierFlags)? {
        var mods: NSEvent.ModifierFlags = []
        let keyNames: [String: String] = ["return": "\r", "enter": "\r", "⏎": "\r", "↩": "\r", "tab": "\t", "⇥": "\t", "space": " ", "escape": "\u{1b}", "⎋": "\u{1b}",
                                          "backspace": "\u{8}", "⌫": "\u{8}", "delete": "\u{7f}", "⌦": "\u{7f}"]
        if s.contains("+"), s.count > 1 {
            let parts = s.split(separator: "+").map { $0.lowercased() }
            guard let key = parts.last, !key.isEmpty else { return nil }
            for p in parts.dropLast() {
                switch p {
                case "commandorcontrol", "cmdorctrl", "command", "cmd": mods.insert(.command)
                case "alt", "option", "opt": mods.insert(.option)
                case "shift": mods.insert(.shift)
                case "control", "ctrl": mods.insert(.control)
                default: break
                }
            }
            return (keyNames[key] ?? (key.count == 1 ? key : ""), mods)
        }
        var rest = Substring(s)
        let table: [(Character, NSEvent.ModifierFlags)] = [("⌃", .control), ("⌥", .option), ("⇧", .shift), ("⌘", .command)]
        while let c = rest.first, let hit = table.first(where: { $0.0 == c }) {
            mods.insert(hit.1)
            rest = rest.dropFirst()
        }
        let key = String(rest)
        guard !key.isEmpty else { return nil }
        if let k = keyNames[key] ?? keyNames[key.lowercased()] { return (k, mods) }
        return key.count == 1 ? (key.lowercased(), mods) : nil
    }
}
