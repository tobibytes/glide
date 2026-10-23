import AppKit

/// Key routing decisions for Glide's own panels (launcher). They intercept keyDown before the text field (arrows,
/// ↩, ⎋, ⌫ drive the list), which must never break text input (input-audit).
@MainActor public enum PanelKeyInput {
    /// The responder is composing with an input method — Japanese/Chinese/Korean IME candidates, or a dead-key
    /// accent (⌥E, US-International ´) waiting for its letter. Until the composition is committed or cancelled
    /// every key (↩ commit, ⎋ cancel, ⌫, arrows / Space for candidates, ⌃J…) belongs to the input method.
    public static func isComposing(_ responder: NSResponder?) -> Bool {
        guard let client = responder as? NSTextInputClient else { return false }
        return client.hasMarkedText()
    }

    /// May the panel's model see this keyDown before the first responder?
    public static func routesToModel(_ event: NSEvent, firstResponder: NSResponder?) -> Bool {
        event.type == .keyDown && !isComposing(firstResponder)
    }

    /// The key name for ⌘ / ⌃ shortcut matching. On a non-Latin layout (Russian, Greek, Hebrew, Arabic…)
    /// `charactersIgnoringModifiers` is the native letter ("л" for ⌘K), so shortcuts and ⌃J / ⌃K navigation never
    /// matched; fall back to the US key at that position, as AppKit's own menu matching does. ASCII stays as is
    /// (Dvorak / AZERTY keep their own letters).
    public nonisolated static func shortcutKey(keyCode: UInt16, characters: String) -> String {
        guard characters.count == 1, let ch = characters.first, !ch.isASCII, ch.isLetter else { return characters }
        guard let ascii = KeyLayout.ansi.first(where: { $0.value == UInt32(keyCode) })?.key else { return characters }
        return String(ascii).lowercased()
    }
}
