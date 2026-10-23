import AppKit

/// Menu bar item (never created in headless mode).
@MainActor final class StatusItemController: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength) // length grows with a feature title
    private let onShow: () -> Void
    private let onSettings: () -> Void

    init(hotkeyDisplay: String, onShow: @escaping () -> Void, onSettings: @escaping () -> Void) {
        self.onShow = onShow
        self.onSettings = onSettings
        super.init()
        item.button?.image = NSImage(systemSymbolName: "sparkle.magnifyingglass", accessibilityDescription: "Glide")
        let menu = NSMenu()
        let open = NSMenuItem(title: "Open Glide  \(hotkeyDisplay)", action: #selector(openLauncher), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        let settings = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Glide", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
    }

    /// Feature titles (e.g. a running timer) next to the icon; "" shows the icon alone.
    func setTitle(_ title: String) {
        item.length = title.isEmpty ? NSStatusItem.squareLength : NSStatusItem.variableLength
        item.button?.imagePosition = title.isEmpty ? .imageOnly : .imageLeading
        item.button?.attributedTitle = NSAttributedString(string: title.isEmpty ? "" : " \(title)", attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)])
    }

    @objc private func openLauncher() { onShow() }
    @objc private func openSettings() { onSettings() }
}

/// One native Glide per data directory: an flock'ed lock file (the Electron app shares the bundle id, so
/// NSRunningApplication can't tell the two apart).
enum SingleInstance {
    nonisolated(unsafe) private static var fd: Int32 = -1
    static let showNotification = Notification.Name("dev.glide.native.show")

    /// true when this process holds the lock.
    static func acquire(in dir: URL) -> Bool {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("glide-native.lock").path
        fd = open(path, O_CREAT | O_RDWR, 0o644)
        guard fd >= 0 else { return true }
        return flock(fd, LOCK_EX | LOCK_NB) == 0
    }
}
