import AppKit
import GlideCore

/// Tracks the app the user is working in (helper Apps.swift). With the non-activating launcher panel the
/// user's app normally stays frontmost; `lastOther` covers Settings and other moments Glide is active.
@MainActor public final class FrontmostTracker: FrontmostAppService {
    private var lastOther: NSRunningApplication?
    private var observer: NSObjectProtocol?
    /// Packaged Glide (native and Electron share dev.glide.launcher) and Electron in development.
    public static let glideBundleIds: Set<String> = ["dev.glide.launcher", "com.github.Electron"]
    /// Called when another app activates (the keyboard tap resets its typed-word buffer).
    public var onActivate: (() -> Void)?

    public init() {}

    public func isGlide(bundleId: String?, pid: Int32) -> Bool {
        pid == getpid() || Self.glideBundleIds.contains(bundleId ?? "")
    }
    func isGlide(_ app: NSRunningApplication) -> Bool { isGlide(bundleId: app.bundleIdentifier, pid: app.processIdentifier) }

    public func start() {
        guard observer == nil else { return }
        if let front = NSWorkspace.shared.frontmostApplication, !isGlide(front) { lastOther = front }
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            MainActor.assumeIsolated {
                guard let self, let app else { return }
                if !self.isGlide(app) { self.lastOther = app }
                self.onActivate?()
            }
        }
    }

    public func runningTarget() -> NSRunningApplication? {
        if let front = NSWorkspace.shared.frontmostApplication, !isGlide(front) { return front }
        if let last = lastOther, !last.isTerminated { return last }
        return frontmostByWindowList()
    }

    public func targetApp() -> RunningAppInfo? { runningTarget().map(Self.describe) }

    public func app(pid: Int32?) -> NSRunningApplication? {
        if let pid, pid > 0 { return NSRunningApplication(processIdentifier: pid) }
        return runningTarget()
    }

    /// Owner of the front-most normal-layer on-screen window that isn't Glide.
    private func frontmostByWindowList() -> NSRunningApplication? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in list {
            guard (info[kCGWindowLayer as String] as? Int) == 0, let pid = info[kCGWindowOwnerPID as String] as? pid_t,
                  let app = NSRunningApplication(processIdentifier: pid), !isGlide(app), app.activationPolicy == .regular else { continue }
            return app
        }
        return nil
    }

    public nonisolated static func describe(_ app: NSRunningApplication) -> RunningAppInfo {
        RunningAppInfo(name: app.localizedName ?? app.bundleIdentifier ?? "Unknown", bundleId: app.bundleIdentifier, pid: app.processIdentifier, path: app.bundleURL?.path)
    }
}

/// Runs blocking work (AX, AppleScript, Vision) off the main thread.
func offMain<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
    await Task.detached(priority: .userInitiated) { work() }.value
}

func offMainThrowing<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
    try await Task.detached(priority: .userInitiated) { try work() }.value
}
