import AppKit
import GlideCore
import GlideSystem

/// Glide's own menu-bar icon, registered as the "glide" item of the shared status-item API
/// (`SystemServices.statusItems`). The live service renders it as an NSStatusItem; headless runs record it only.
/// Timers / Focus (and the Menu Bar feature's Timers extra) merge their titles and menus into it while
/// "Show timers and focus in Glide's menu bar icon" is on.
@MainActor final class StatusItemController {
    private let service: any StatusItemService
    private let hotkeyDisplay: String
    private let onShow: () -> Void
    private let onSettings: () -> Void
    private let onCheckUpdates: () -> Void
    private var title = ""

    init(service: any StatusItemService, hotkeyDisplay: String, onShow: @escaping () -> Void, onSettings: @escaping () -> Void,
         onCheckUpdates: @escaping () -> Void = {}) {
        self.service = service
        self.hotkeyDisplay = hotkeyDisplay
        self.onShow = onShow
        self.onSettings = onSettings
        self.onCheckUpdates = onCheckUpdates
        publish()
    }

    /// Feature titles (`FeatureContext.setStatusTitle`) next to the icon; "" shows the icon alone.
    func setTitle(_ title: String) {
        guard title != self.title else { return }
        self.title = title
        publish()
    }

    private func publish() {
        let show = onShow, settings = onSettings, checkUpdates = onCheckUpdates
        service.setGlideItem(StatusItemSpec(title: title, icon: StatusItemComposer.glideIcon, tooltip: "Glide", menu: [
            StatusMenuItem("Open Glide  \(hotkeyDisplay)") { show() },
            StatusMenuItem("Settings…", shortcut: "⌘,") { settings() },
            StatusMenuItem("Check for Updates…") { checkUpdates() },
            .separator,
            StatusMenuItem("Quit Glide", shortcut: "⌘Q") { GlideQuit.request() },
        ]))
    }
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
