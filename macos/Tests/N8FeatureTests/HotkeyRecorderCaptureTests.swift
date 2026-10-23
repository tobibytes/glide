import AppKit
import Foundation
@testable import GlideFeatures
import GlideSystem
import Testing

/// An offscreen window that reports itself key (never ordered on screen).
private final class PretendKeyWindow: NSWindow {
    var pretendKey = true
    override var isKeyWindow: Bool { pretendKey }
}

@Suite("hotkey recorder suspends Glide's global hotkeys while it records (offscreen)", .serialized)
@MainActor struct HotkeyRecorderCaptureTests {
    @Test func recordingInTheKeyWindowSuspendsAndLeavingResumes() throws {
        _ = NSApplication.shared
        var events: [Bool] = []
        let saved = HotkeyCapture.onChange
        HotkeyCapture.onChange = { events.append($0) }
        defer { HotkeyCapture.onChange = saved }

        let w = PretendKeyWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 80), styleMask: [.titled], backing: .buffered, defer: true)
        w.isReleasedWhenClosed = false
        let field = HotkeyRecorderField.RecorderView(frame: NSRect(x: 10, y: 10, width: 200, height: 26))
        w.contentView?.addSubview(field)
        #expect(events.isEmpty)

        #expect(w.makeFirstResponder(field))
        #expect(field.capturing && events == [true])

        // The user switches to another app with the field still focused: hotkeys come back.
        w.pretendKey = false
        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: w)
        #expect(!field.capturing && events == [true, false])
        w.pretendKey = true
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: w)
        #expect(events == [true, false, true])

        // Esc / focus moving away ends the recording.
        #expect(w.makeFirstResponder(nil))
        #expect(events == [true, false, true, false])

        // Removed from the window (Settings page switched) while recording: resumes too.
        #expect(w.makeFirstResponder(field))
        field.removeFromSuperview()
        #expect(events == [true, false, true, false, true, false])
        #expect(!HotkeyCapture.isCapturing)
    }
}
