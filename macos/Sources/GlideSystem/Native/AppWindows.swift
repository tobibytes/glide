import AppKit

/// What `GlideWindows` needs from AppKit (a fake in tests: a test must never change the test runner's activation
/// policy, activate it, or order a window on screen).
@MainActor public protocol AppActivationHost: AnyObject {
    var activationPolicy: NSApplication.ActivationPolicy { get }
    func setActivationPolicy(_ policy: NSApplication.ActivationPolicy)
    var isActive: Bool { get }
    func activateGlide()
    /// The frontmost app when it is not Glide (the app to give the focus back to).
    func frontmostOtherApp() -> NSRunningApplication?
    func reactivate(_ app: NSRunningApplication)
    func orderFrontAndMakeKey(_ window: NSWindow)
}

@MainActor public final class LiveActivationHost: AppActivationHost {
    public init() {}
    public var activationPolicy: NSApplication.ActivationPolicy { NSApp.activationPolicy() }
    public func setActivationPolicy(_ policy: NSApplication.ActivationPolicy) { NSApp.setActivationPolicy(policy) }
    public var isActive: Bool { NSApp.isActive }
    public func activateGlide() { NSApp.activate(ignoringOtherApps: true) }
    public func frontmostOtherApp() -> NSRunningApplication? {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid(), !app.isTerminated else { return nil }
        return app
    }
    public func reactivate(_ app: NSRunningApplication) {
        NSApp.yieldActivation(to: app)
        app.activate(from: NSRunningApplication.current, options: [])
    }
    public func orderFrontAndMakeKey(_ window: NSWindow) { window.makeKeyAndOrderFront(nil) }
}

/// Glide's regular (activating) windows: Settings, AI Chat, the welcome tour. Glide is an LSUIElement agent whose
/// launcher and Floating Notes are non-activating panels; a regular window is different, the user works in it for
/// a while and must be able to find it again. So, consistently for every such window:
/// - while at least one is open Glide is a `.regular` app (Dock icon, ⌘Tab, its menu bar); with the last one
///   closed it goes back to `.accessory`;
/// - presenting activates Glide and makes the window key, so typing works immediately;
/// - closing the last one gives the focus back to the app the user was in before (when Glide still has it).
/// Never does anything in headless runs (policy `.prohibited`).
@MainActor public final class GlideWindows {
    public static let shared = GlideWindows(host: LiveActivationHost())

    let host: AppActivationHost
    private struct Entry { weak var window: NSWindow?; let observer: NSObjectProtocol }
    private var entries: [ObjectIdentifier: Entry] = [:]
    public private(set) var previousApp: NSRunningApplication?
    private var focusWaiters: [@MainActor () -> Void] = []
    private var activationObserver: NSObjectProtocol?

    public init(host: AppActivationHost) { self.host = host }

    public var openWindowCount: Int { entries.values.filter { $0.window != nil }.count }
    public var hasOpenWindows: Bool { openWindowCount > 0 }
    public func isTracking(_ w: NSWindow) -> Bool { entries[ObjectIdentifier(w)] != nil }

    /// Bring a regular window to the front as the key window (see the type comment).
    public func present(_ window: NSWindow) {
        guard host.activationPolicy != .prohibited else { return } // headless: never on screen
        // Remember where the user was, unless Glide is already in front (then keep the earlier app).
        if !host.isActive || !hasOpenWindows, let other = host.frontmostOtherApp() { previousApp = other }
        track(window)
        if host.activationPolicy != .regular { host.setActivationPolicy(.regular) }
        host.activateGlide()
        host.orderFrontAndMakeKey(window)
    }

    private func track(_ window: NSWindow) {
        let id = ObjectIdentifier(window)
        guard entries[id] == nil else { return }
        let observer = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self, weak window] _ in
            MainActor.assumeIsolated {
                guard let self, let window else { return }
                self.windowWillClose(window)
            }
        }
        entries[id] = Entry(window: window, observer: observer)
    }

    /// Called from the window's willClose notification.
    public func windowWillClose(_ window: NSWindow) {
        guard let e = entries.removeValue(forKey: ObjectIdentifier(window)) else { return }
        NotificationCenter.default.removeObserver(e.observer)
        entries = entries.filter { $0.value.window != nil }
        guard entries.isEmpty else { return }
        if host.activationPolicy == .regular { host.setActivationPolicy(.accessory) }
        let back = previousApp
        previousApp = nil
        if host.isActive, let back, !back.isTerminated {
            host.reactivate(back)
            waitForActivation(of: back)
        } else {
            runFocusWaiters()
        }
    }

    /// Runs `body` once the focus is back in the user's app after the last regular window closed (or right away).
    /// Showing the non-activating launcher before that activation lands would lose the key status to it.
    public func whenFocusRestored(_ body: @escaping @MainActor () -> Void) {
        if activationObserver == nil { body() } else { focusWaiters.append(body) }
    }

    private func waitForActivation(of app: NSRunningApplication) {
        let pid = app.processIdentifier
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let activated = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated { if activated == pid { self?.runFocusWaiters() } }
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            self?.runFocusWaiters() // the activation may never be reported (app busy, user clicked elsewhere)
        }
    }

    private func runFocusWaiters() {
        if let o = activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        activationObserver = nil
        let waiters = focusWaiters
        focusWaiters = []
        for w in waiters { w() }
    }

    /// Run an app-modal dialog (NSAlert, NSOpenPanel) from anywhere, including the non-activating launcher: Glide is
    /// activated first so the dialog is in front and key, and the focus goes back to the user's app afterwards
    /// unless a regular Glide window is open.
    public func runModal<T>(_ body: () -> T) -> T {
        guard host.activationPolicy != .prohibited else { return body() }
        let back = host.isActive ? nil : host.frontmostOtherApp()
        host.activateGlide()
        let result = body()
        if !hasOpenWindows, host.isActive, let back, !back.isTerminated { host.reactivate(back) }
        return result
    }
}
