import AppKit
import Foundation
import Testing
@testable import GlideCore
@testable import GlideSystem

/// Records what GlideWindows asks AppKit to do. Nothing reaches the real NSApp: the test runner's activation policy,
/// activation and window ordering are never touched, and no window is ever ordered on screen.
@MainActor final class FakeActivationHost: AppActivationHost {
    var activationPolicy: NSApplication.ActivationPolicy = .accessory
    var isActive = false
    var other: NSRunningApplication? = NSRunningApplication.current // stands in for "the user's app"
    var log: [String] = []
    func setActivationPolicy(_ policy: NSApplication.ActivationPolicy) {
        activationPolicy = policy
        log.append(policy == .regular ? "regular" : policy == .accessory ? "accessory" : "other")
    }
    func activateGlide() { isActive = true; log.append("activate") }
    func frontmostOtherApp() -> NSRunningApplication? { isActive ? nil : other }
    func reactivate(_ app: NSRunningApplication) { isActive = false; log.append("reactivate:\(app.processIdentifier)") }
    func orderFrontAndMakeKey(_ window: NSWindow) { log.append("key:\(window.title)") }
}

@MainActor private func window(_ title: String) -> NSWindow {
    _ = NSApplication.shared
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled, .closable], backing: .buffered, defer: true)
    w.title = title
    w.isReleasedWhenClosed = false
    return w
}

@MainActor private func postWillClose(_ w: NSWindow) {
    NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: w)
}

@Suite("regular windows: activation policy, key status, focus restore (offscreen, fake NSApp)", .serialized)
@MainActor struct GlideWindowsTests {
    @Test func presentMakesGlideRegularActiveAndTheWindowKey() {
        let host = FakeActivationHost()
        let g = GlideWindows(host: host)
        let w = window("Settings")
        g.present(w)
        #expect(host.log == ["regular", "activate", "key:Settings"])
        #expect(g.previousApp?.processIdentifier == NSRunningApplication.current.processIdentifier)
        #expect(g.isTracking(w) && g.openWindowCount == 1)
    }

    @Test func lastCloseGoesBackToAccessoryAndRefocusesTheUsersApp() {
        let host = FakeActivationHost()
        let g = GlideWindows(host: host)
        let a = window("Settings"), b = window("AI Chat")
        g.present(a)
        g.present(b) // Glide is active now: the remembered app stays the user's one
        #expect(g.previousApp != nil)
        host.log = []
        postWillClose(a) // through the NSWindow.willCloseNotification observer
        #expect(host.log.isEmpty, "another regular window is still open")
        #expect(host.activationPolicy == .regular)
        postWillClose(b)
        #expect(host.log == ["accessory", "reactivate:\(NSRunningApplication.current.processIdentifier)"])
        #expect(!g.hasOpenWindows && g.previousApp == nil)
        postWillClose(b) // a second close notification is ignored
        #expect(host.log.count == 2)
    }

    @Test func noRefocusWhenTheUserAlreadyLeftGlide() {
        let host = FakeActivationHost()
        let g = GlideWindows(host: host)
        let w = window("Settings")
        g.present(w)
        host.isActive = false // the user clicked another app, then closed Settings from its title bar
        host.log = []
        postWillClose(w)
        #expect(host.log == ["accessory"])
    }

    @Test func reopeningAClosedWindowTracksItAgain() {
        let host = FakeActivationHost()
        let g = GlideWindows(host: host)
        let w = window("Settings")
        g.present(w)
        g.present(w) // shown again while open: tracked once
        #expect(g.openWindowCount == 1)
        postWillClose(w)
        host.log = []
        g.present(w)
        #expect(host.log == ["regular", "activate", "key:Settings"])
        #expect(g.openWindowCount == 1)
    }

    @Test func headlessNeverPresents() {
        let host = FakeActivationHost()
        host.activationPolicy = .prohibited
        let g = GlideWindows(host: host)
        g.present(window("Settings"))
        #expect(host.log.isEmpty && !g.hasOpenWindows)
        #expect(g.runModal { 7 } == 7)
        #expect(host.log.isEmpty)
    }

    /// The launcher shown right after the last close would be un-keyed by the pending activation of the user's
    /// app: whenFocusRestored defers it until that activation (or a timeout).
    @Test func whenFocusRestoredWaitsForThePendingActivation() async throws {
        let host = FakeActivationHost()
        let g = GlideWindows(host: host)
        let w = window("Welcome")
        g.present(w)
        postWillClose(w)
        var ran = false
        g.whenFocusRestored { ran = true }
        #expect(!ran)
        try await Task.sleep(for: .milliseconds(800))
        #expect(ran)
        var now = false
        g.whenFocusRestored { now = true } // nothing pending: runs right away
        #expect(now)
    }

    @Test func modalDialogFromTheLauncherActivatesAndGivesTheFocusBack() {
        let host = FakeActivationHost()
        let g = GlideWindows(host: host)
        let r = g.runModal { () -> Bool in host.log.append("modal"); return true }
        #expect(r)
        #expect(host.log == ["activate", "modal", "reactivate:\(NSRunningApplication.current.processIdentifier)"])
        // With Settings open the focus stays in Glide after the dialog.
        g.present(window("Settings"))
        host.log = []
        g.runModal { host.log.append("modal") }
        #expect(host.log == ["activate", "modal"])
    }
}

@Suite("hotkey capture gate", .serialized)
@MainActor struct HotkeyCaptureTests {
    @Test func nestedBeginEndReportsOnce() {
        var events: [Bool] = []
        let saved = HotkeyCapture.onChange
        HotkeyCapture.onChange = { events.append($0) }
        defer { HotkeyCapture.onChange = saved }
        HotkeyCapture.begin()
        HotkeyCapture.begin()
        HotkeyCapture.end()
        #expect(HotkeyCapture.isCapturing)
        HotkeyCapture.end()
        HotkeyCapture.end() // unbalanced end is ignored
        #expect(events == [true, false])
        #expect(!HotkeyCapture.isCapturing)
    }

    /// While suspended, `set` only remembers the bindings (nothing is registered with Carbon).
    @Test func suspendedServiceDefersRegistration() {
        let hk = CarbonHotkeyService()
        hk.setSuspended(true)
        let r = hk.set([HotkeyBinding(id: "launcher", accelerator: "Alt+Space")])
        #expect(r.failed.isEmpty && r.conflicts.isEmpty)
    }
}
