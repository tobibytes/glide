import AppKit
import GlideCore
import SwiftUI

/// The launcher's search field: a borderless NSTextField (precise focus/caret control in a non-activating
/// panel). Keyboard navigation is NOT handled here — the launcher panel intercepts keys first
/// (LauncherPanel.sendEvent) and only plain text editing reaches the field.
public struct SearchFieldRepresentable: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var font: NSFont
    var textColor: NSColor
    var placeholderColor: NSColor
    var caretColor: NSColor
    /// false in vim NORMAL mode: read-only, no caret.
    var editable: Bool
    var focusToken: Int

    public init(text: Binding<String>, placeholder: String, font: NSFont, textColor: NSColor, placeholderColor: NSColor, caretColor: NSColor, editable: Bool, focusToken: Int) {
        _text = text
        self.placeholder = placeholder
        self.font = font
        self.textColor = textColor
        self.placeholderColor = placeholderColor
        self.caretColor = caretColor
        self.editable = editable
        self.focusToken = focusToken
    }

    public final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: SearchFieldRepresentable
        var lastFocusToken = -1
        init(_ p: SearchFieldRepresentable) { parent = p }
        public func controlTextDidChange(_ note: Notification) {
            guard let f = note.object as? NSTextField else { return }
            if parent.text != f.stringValue { parent.text = f.stringValue }
        }
    }

    public func makeCoordinator() -> Coordinator { Coordinator(self) }

    public func makeNSView(context: Context) -> NSTextField {
        let f = GlideTextField()
        f.isBordered = false
        f.drawsBackground = false
        f.focusRingType = .none
        f.cell?.wraps = false
        f.cell?.isScrollable = true
        f.lineBreakMode = .byClipping
        f.delegate = context.coordinator
        f.setAccessibilityIdentifier("glide.search")
        return f
    }

    public func updateNSView(_ f: NSTextField, context: Context) {
        context.coordinator.parent = self
        if f.stringValue != text {
            f.stringValue = text
            if let ed = f.currentEditor() { ed.selectedRange = NSRange(location: (text as NSString).length, length: 0) }
        }
        f.font = font
        f.textColor = textColor
        f.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [.foregroundColor: placeholderColor, .font: font])
        f.isEditable = editable
        f.isSelectable = editable
        (f as? GlideTextField)?.caretColor = editable ? caretColor : .clear
        if context.coordinator.lastFocusToken != focusToken, let window = f.window {
            context.coordinator.lastFocusToken = focusToken
            if editable { window.makeFirstResponder(f) }
            (f.currentEditor() as? NSTextView)?.insertionPointColor = editable ? caretColor : .clear
            (f.currentEditor() as? NSTextView)?.moveToEndOfDocument(nil)
        }
        (f.currentEditor() as? NSTextView)?.insertionPointColor = editable ? caretColor : .clear
    }
}

final class GlideTextField: NSTextField {
    var caretColor: NSColor = .controlAccentColor
    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        (currentEditor() as? NSTextView)?.insertionPointColor = caretColor
        return ok
    }
}

/// Header bar: glyph (search or back), field, trailing accessories (argument pill, vim pill).
public struct SearchBar<Trailing: View>: View {
    @Environment(\.glideTheme) private var theme
    @Binding var text: String
    let placeholder: String
    let showsBack: Bool
    let editable: Bool
    let focusToken: Int
    let trailing: Trailing

    public init(text: Binding<String>, placeholder: String, showsBack: Bool = false, editable: Bool = true, focusToken: Int = 0, @ViewBuilder trailing: () -> Trailing) {
        _text = text
        self.placeholder = placeholder
        self.showsBack = showsBack
        self.editable = editable
        self.focusToken = focusToken
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 12) {
            Image(systemName: showsBack ? "chevron.left" : "magnifyingglass")
                .font(.system(size: showsBack ? 15 : 17, weight: .medium))
                .foregroundStyle(theme.text3)
                .frame(width: 22, height: 22)
                .background(showsBack ? RoundedRectangle(cornerRadius: 6).fill(theme.kbdBg) : nil)
            SearchFieldRepresentable(text: $text, placeholder: placeholder, font: theme.inputFont, textColor: NSColor(theme.tokens.text),
                                     placeholderColor: NSColor(theme.tokens.text3), caretColor: NSColor(theme.tokens.accent), editable: editable, focusToken: focusToken)
                .frame(height: 30)
            trailing
        }
        .padding(.horizontal, 18)
        .frame(height: theme.tokens.headHeight)
    }
}

/// The vim mode pill shown in the header / footer.
public struct VimPill: View {
    @Environment(\.glideTheme) private var theme
    let mode: VimMode
    public init(_ mode: VimMode) { self.mode = mode }
    public var body: some View {
        Text(mode == .normal ? "NORMAL" : "INSERT")
            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
            .tracking(0.8)
            .foregroundStyle(mode == .normal ? theme.accentContrast : theme.text3)
            .padding(.horizontal, 7)
            .frame(height: 20)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(mode == .normal ? theme.accent : theme.kbdBg))
    }
}
