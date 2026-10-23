import AppKit
import Foundation
import GlideCore
@testable import GlideFeatures
import GlideUI
import Testing

/// Replays NSApplication's keyDown routing on a window that is never ordered on screen:
/// key window performKeyEquivalent → main menu → window.sendEvent (first responder keyDown).
@MainActor enum KeyRouting {
    static func event(_ chars: String, keyCode: UInt16, flags: NSEvent.ModifierFlags = .command, window: NSWindow) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: keyCode)!
    }

    @discardableResult
    static func dispatch(_ e: NSEvent, to window: NSWindow) -> String {
        if e.modifierFlags.contains(.command) || e.modifierFlags.contains(.control) {
            if window.performKeyEquivalent(with: e) { return "window" }
            if NSApp.mainMenu?.performKeyEquivalent(with: e) == true { return "menu" }
        }
        window.sendEvent(e)
        return "sendEvent"
    }

    static func textView(in view: NSView) -> NSTextView? {
        if let t = view as? NSTextView { return t }
        for s in view.subviews { if let t = textView(in: s) { return t } }
        return nil
    }
}

@Suite("key routing through AppKit (offscreen)", .serialized)
@MainActor struct KeyRoutingTests {
    /// Floating Notes: ⌘N / ⌘] / ⌘K reach the panel whether or not the editor has focus, and the Edit menu makes
    /// ⌘A / ⌘C / ⌘V / ⌘Z work in the editor.
    @Test func notesPanelShortcutsAndEditMenu() async throws {
        _ = NSApplication.shared
        let saved = NSApp.mainMenu
        NSApp.mainMenu = GlideMainMenu.make()
        defer { NSApp.mainMenu = saved }
        let ctx = N7TestContext("notes")
        defer { ctx.cleanup() }
        let f = NotesFeature()
        await f.start(context: ctx)
        let c = NotesPanelController(feature: f)
        let panel = c.panel
        panel.contentView?.layoutSubtreeIfNeeded()
        let content = try #require(panel.contentView)
        let tv = try #require(KeyRouting.textView(in: content))

        _ = panel.makeFirstResponder(tv)
        #expect(KeyRouting.dispatch(KeyRouting.event("n", keyCode: 45, window: panel), to: panel) == "window")
        #expect(f.data.notes.count == 1)
        _ = panel.makeFirstResponder(nil)
        KeyRouting.dispatch(KeyRouting.event("n", keyCode: 45, window: panel), to: panel)
        #expect(f.data.notes.count == 2)

        _ = panel.makeFirstResponder(tv)
        tv.string = "hello"
        #expect(KeyRouting.dispatch(KeyRouting.event("a", keyCode: 0, window: panel), to: panel) == "menu")
        // Offscreen there is no key window to send the action to, so check the editor answers each Edit action.
        for item in (NSApp.mainMenu?.items[1].submenu?.items ?? []) where item.action != nil {
            // undo:/redo: are answered further up the chain (the window's undo manager).
            let up = ["Undo", "Redo"].contains(item.title)
            #expect(up ? panel.responds(to: item.action) : tv.responds(to: item.action), "editor doesn't handle \(item.title)")
        }
        tv.selectAll(nil)
        #expect(tv.selectedRange() == NSRange(location: 0, length: 5))
        let edit = try #require(NSApp.mainMenu?.items[1].submenu)
        let titles = edit.items.map(\.title)
        #expect(titles.contains("Copy") && titles.contains("Paste") && titles.contains("Undo") && titles.contains("Select All"))
        // No ⌘Q: a key Glide panel must never quit Glide.
        let all: [NSMenuItem] = GlideMainMenu.make().items.flatMap { $0.submenu?.items ?? [] }
        let quits = all.filter { $0.keyEquivalent == "q" }
        #expect(quits.isEmpty)
    }
}
