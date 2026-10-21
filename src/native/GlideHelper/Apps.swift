import AppKit

/// Tracks the app the user was in before Glide came to the front.
final class Apps {
    static let shared = Apps()
    private let lock = NSLock()
    private var lastOther: NSRunningApplication?
    /// Glide's main process spawned us.
    let glidePid = getppid()
    /// Packaged Glide, and the stock Electron app that runs Glide in development.
    private let glideBundleIds: Set<String> = ["dev.glide.launcher", "com.github.Electron"]

    func isGlide(_ app: NSRunningApplication) -> Bool {
        app.processIdentifier == glidePid || app.processIdentifier == getpid() || glideBundleIds.contains(app.bundleIdentifier ?? "")
    }

    func start() {
        if let front = NSWorkspace.shared.frontmostApplication, !isGlide(front) { lastOther = front }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            if !self.isGlide(app) {
                self.lock.lock()
                self.lastOther = app
                self.lock.unlock()
            }
            Keys.shared.resetBuffer()
        }
    }

    /// Frontmost app, or the most recently active other app when Glide itself is in front.
    func target() -> NSRunningApplication? {
        if let front = NSWorkspace.shared.frontmostApplication, !isGlide(front) { return front }
        lock.lock()
        let last = lastOther
        lock.unlock()
        if let last, !last.isTerminated { return last }
        return frontmostByWindowList()
    }

    func app(pid: pid_t?) -> NSRunningApplication? {
        if let pid, pid > 0 { return NSRunningApplication(processIdentifier: pid) }
        return target()
    }

    /// Fallback: owner of the front-most normal-layer on-screen window that isn't Glide.
    private func frontmostByWindowList() -> NSRunningApplication? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in list {
            guard (info[kCGWindowLayer as String] as? Int) == 0, let pid = info[kCGWindowOwnerPID as String] as? pid_t,
                  let app = NSRunningApplication(processIdentifier: pid), !isGlide(app), app.activationPolicy == .regular else { continue }
            return app
        }
        return nil
    }

    static func describe(_ app: NSRunningApplication) -> [String: Any] {
        [
            "name": app.localizedName ?? app.bundleIdentifier ?? "Unknown",
            "bundleId": app.bundleIdentifier ?? NSNull(),
            "pid": Int(app.processIdentifier),
            "path": app.bundleURL?.path ?? NSNull(),
        ]
    }
}
