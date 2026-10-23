import AppKit
import Foundation
import Testing
@testable import GlideCore
@testable import GlideSystem

/// Real-app-only input paths (input-audit). AppKit objects are created offscreen: no window is ordered on screen,
/// no event is posted, no hotkey or tap is registered.
@Suite("input audit: launcher key routing, tap buffer, hotkey retry", .serialized)
@MainActor struct InputAuditTests {
    private func keyDown(_ chars: String, keyCode: UInt16, flags: NSEvent.ModifierFlags = [], window: NSWindow) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: keyCode)!
    }

    /// Japanese IME composing in the launcher's search field: the field editor has marked text, so ↩ / ⌫ / ⎋ /
    /// arrows must reach the input method, not the launcher model (which would run the item / pop the view).
    @Test func imeCompositionKeepsKeysInTheField() throws {
        _ = NSApplication.shared
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 80), styleMask: [.nonactivatingPanel, .titled], backing: .buffered, defer: true)
        let field = NSTextField(frame: NSRect(x: 10, y: 10, width: 300, height: 24))
        window.contentView?.addSubview(field)
        #expect(window.makeFirstResponder(field))
        let editor = try #require(window.firstResponder as? NSTextView, "the field editor takes first responder")
        let enter = keyDown("\r", keyCode: 36, window: window)

        #expect(!PanelKeyInput.isComposing(window.firstResponder))
        #expect(PanelKeyInput.routesToModel(enter, firstResponder: window.firstResponder))

        editor.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(editor.hasMarkedText())
        #expect(PanelKeyInput.isComposing(window.firstResponder))
        for (c, code) in [("\r", UInt16(36)), ("\u{7f}", 51), ("\u{1b}", 53), ("\u{f701}", 125), (" ", 49)] {
            #expect(!PanelKeyInput.routesToModel(keyDown(c, keyCode: code, window: window), firstResponder: window.firstResponder), "key \(code) must go to the IME")
        }

        editor.unmarkText() // committed
        #expect(!PanelKeyInput.isComposing(window.firstResponder))
        #expect(PanelKeyInput.routesToModel(enter, firstResponder: window.firstResponder))
        #expect(field.stringValue == "にほん" || editor.string == "にほん")
        // Key-ups and non-text responders never count as composing.
        #expect(!PanelKeyInput.isComposing(nil))
        #expect(!PanelKeyInput.isComposing(window))
    }

    /// Dead key (⌥E on US, ´ on US-International) shows as marked text until its letter: same rule.
    @Test func deadKeyAccentIsComposition() {
        let tv = NSTextView(frame: NSRect(x: 0, y: 0, width: 200, height: 40))
        tv.setMarkedText("´", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(PanelKeyInput.isComposing(tv))
        tv.insertText("é", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(!PanelKeyInput.isComposing(tv))
    }

    /// ⌘K / ⌃J on a Russian layout arrive as "л" / "о": shortcut matching uses the US key at that position.
    @Test func nonLatinLayoutShortcutsUseUSKeys() {
        #expect(PanelKeyInput.shortcutKey(keyCode: 40, characters: "л") == "k")
        #expect(PanelKeyInput.shortcutKey(keyCode: 38, characters: "о") == "j")
        #expect(PanelKeyInput.shortcutKey(keyCode: 8, characters: "с") == "c")
        #expect(PanelKeyInput.shortcutKey(keyCode: 0, characters: "α") == "a") // Greek
        // ASCII layouts keep their own letters (Dvorak ⌘K is wherever K is), digits and symbols untouched.
        #expect(PanelKeyInput.shortcutKey(keyCode: 9, characters: "k") == "k")
        #expect(PanelKeyInput.shortcutKey(keyCode: 18, characters: "1") == "1")
        #expect(PanelKeyInput.shortcutKey(keyCode: 40, characters: "K") == "K")
        #expect(PanelKeyInput.shortcutKey(keyCode: 200, characters: "л") == "л") // unknown key code
    }

    /// The tap config is re-sent while the user types (dynamic snippets every 20 s, after each expansion, on Paste
    /// Stack changes). Re-sending the same keywords used to clear the typed word, so ";date" typed across a refresh
    /// never expanded.
    @Test func reconfiguringSameKeywordsKeepsTheTypedWord() {
        var engine = KeyEngine()
        let entries = [SnippetEntry(keyword: ";date", text: "2026-10-23", id: "d", excludedBundleIds: [])]
        engine.setEntries(entries)
        func type(_ s: String) -> KeyDecision {
            var last = KeyDecision.pass
            for ch in s { last = engine.handle(KeyInput(kind: .down, code: 0, mods: [], chars: String(ch)), KeyEnv()) }
            return last
        }
        #expect(type(";da") == .pass)
        engine.setEntries([SnippetEntry(keyword: ";date", text: "2026-10-24", id: "d", excludedBundleIds: [])]) // re-render
        #expect(type("te") == .expand(SnippetEntry(keyword: ";date", text: "2026-10-24", id: "d", excludedBundleIds: []), backspaces: 5))
        engine.expansionFinished()
        // A different keyword set does restart the word.
        #expect(type(";da") == .pass)
        engine.setEntries([SnippetEntry(keyword: ";dt", text: "x", id: nil, excludedBundleIds: [])])
        #expect(engine.buffer.isEmpty)
    }

    /// Bindings that need the Hyper key / Input Monitoring are retried when those come alive (pure checks; the
    /// retry itself registers real hotkeys and is verified live).
    @Test func retryTriggersRecognizeModifierOnlyBindings() {
        #expect(CarbonHotkeyService.wantsHyper([HotkeyBinding(id: "launcher", accelerator: "Hyper")]))
        #expect(!CarbonHotkeyService.wantsHyper([HotkeyBinding(id: "launcher", accelerator: "Hyper+K")])) // a Carbon combo
        #expect(!CarbonHotkeyService.wantsHyper([HotkeyBinding(id: "launcher", accelerator: "Double+Command")]))
        #expect(CarbonHotkeyService.isModifierOnly("Double+Command"))
        #expect(CarbonHotkeyService.isModifierOnly("Right+Alt"))
        #expect(!CarbonHotkeyService.isModifierOnly("Alt+Space"))
        #expect(!CarbonHotkeyService.isModifierOnly("Bogus+"))
    }

    @Test func pasteWaitsForFocusHandoffBeforeRestore() {
        #expect(PasteTiming.focusHandoff > 0 && PasteTiming.focusHandoff < PasteTiming.standard)
    }
}
