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
    /// The running Glide's answer to `showNotification` ("I'm alive and showed the launcher").
    static let shownNotification = Notification.Name("dev.glide.native.shown")

    static func lockPath(_ dir: URL) -> String { dir.appendingPathComponent("glide-native.lock").path }

    /// true when this process holds the lock (it then records its pid in the lock file).
    static func acquire(in dir: URL) -> Bool {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if fd < 0 { fd = open(lockPath(dir), O_CREAT | O_RDWR, 0o644) }
        guard fd >= 0 else { return true }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { return false }
        let pid = Array("\(getpid())\n".utf8)
        ftruncate(fd, 0)
        _ = pid.withUnsafeBufferPointer { pwrite(fd, $0.baseAddress, $0.count, 0) }
        return true
    }

    /// The pid recorded by the Glide that holds the lock, if any.
    static func holderPID(in dir: URL) -> pid_t? {
        guard let s = try? String(contentsOfFile: lockPath(dir), encoding: .utf8), let pid = pid_t(s.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 0, pid != getpid() else { return nil }
        return pid
    }
}
