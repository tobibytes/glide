import AppKit
import GlideCore

/// NSStatusItem adapter for MenuBarManager (live app only — the feature never creates one in headless mode).
@MainActor final class StatusItemTray: NSObject, TrayHandle, NSMenuDelegate {
    private var item: NSStatusItem?
    private var actions: [Int: @MainActor () -> Void] = [:]

    override init() {
        super.init()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    }

    func setTitle(_ title: String) {
        item?.button?.title = title
        item?.button?.imagePosition = title.isEmpty ? .imageOnly : .imageLeading
        item?.button?.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
    }

    func setIcon(_ icon: String?) { item?.button?.image = icon.flatMap(Self.image) }

    func setTooltip(_ tooltip: String) { item?.button?.toolTip = tooltip.isEmpty ? nil : tooltip }

    func setMenu(_ menu: [MenuBarMenuItem]) {
        actions = [:]
        item?.menu = build(menu)
    }

    func destroy() {
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
        actions = [:]
    }

    /// SF Symbol (template) or emoji rendered as text.
    static func image(_ icon: String) -> NSImage? {
        if let img = NSImage(systemSymbolName: icon, accessibilityDescription: nil) {
            img.isTemplate = true
            return img
        }
        if icon.hasPrefix("/"), let img = NSImage(contentsOfFile: icon) {
            img.isTemplate = icon.hasSuffix("Template.png")
            img.size = NSSize(width: 18, height: 18)
            return img
        }
        let s = NSAttributedString(string: icon, attributes: [.font: NSFont.systemFont(ofSize: 14)])
        let size = s.size()
        let img = NSImage(size: size, flipped: false) { r in s.draw(in: r); return true }
        return img
    }

    private func build(_ items: [MenuBarMenuItem]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for m in items {
            if m.separator { menu.addItem(.separator()); continue }
            let mi = NSMenuItem(title: m.title ?? "", action: nil, keyEquivalent: "")
            if let sub = m.subtitle, !sub.isEmpty {
                if #available(macOS 14.4, *) { mi.subtitle = sub } else { mi.toolTip = sub }
            }
            if let icon = m.icon, let img = Self.image(icon) { mi.image = img }
            if let sc = m.shortcut { Self.applyShortcut(sc, to: mi) }
            mi.isEnabled = m.enabled ?? true
            mi.state = m.checked == true ? .on : .off
            if let sub = m.submenu { mi.submenu = build(sub) }
            if let click = m.onClick {
                let tag = actions.count + 1
                actions[tag] = click
                mi.tag = tag
                mi.target = self
                mi.action = #selector(clicked(_:))
            }
            menu.addItem(mi)
        }
        return menu
    }

    @objc private func clicked(_ sender: NSMenuItem) { actions[sender.tag]?() }

    /// "CommandOrControl+J" → ⌘J key equivalent (display only: menus handle it while open).
    static func applyShortcut(_ accel: String, to mi: NSMenuItem) {
        let parts = accel.split(separator: "+").map { $0.lowercased() }
        guard let key = parts.last else { return }
        var mask: NSEvent.ModifierFlags = []
        for p in parts.dropLast() {
            switch p {
            case "commandorcontrol", "cmdorctrl", "command", "cmd": mask.insert(.command)
            case "alt", "option": mask.insert(.option)
            case "shift": mask.insert(.shift)
            case "control", "ctrl": mask.insert(.control)
            default: break
            }
        }
        mi.keyEquivalent = key
        mi.keyEquivalentModifierMask = mask
    }
}
