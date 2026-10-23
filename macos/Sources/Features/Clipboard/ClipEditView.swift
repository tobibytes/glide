import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// "Edit and Paste": a multi-line editor for a text entry. ⌘↩ pastes the edited text (it joins the history),
/// ⌘S saves it into the entry, Esc goes back. The launcher routes keys to features before any text view, so
/// editing keys are forwarded to the editor's NSTextView explicitly.
@MainActor @Observable final class ClipEditModel {
    @ObservationIgnored weak var feature: ClipboardFeature?
    @ObservationIgnored weak var host: (any LauncherViewHost)?
    @ObservationIgnored weak var textView: NSTextView?
    @ObservationIgnored private var nonce: String?
    var entryId: String?
    var text = ""

    init(feature: ClipboardFeature) { self.feature = feature }

    var currentHost: (any LauncherViewHost)? { host ?? LauncherHosts.current }

    func prepare(payload: JSONValue, host: (any LauncherViewHost)?) {
        if let host { self.host = host }
        let n = payload["nonce"]?.stringValue
        guard n == nil || n != nonce else { return }
        nonce = n
        entryId = payload["id"]?.stringValue
        text = feature?.entry(entryId)?.text ?? payload["text"]?.stringValue ?? ""
        textView?.string = text
        currentHost?.setFooter(primary: "Paste Edited", hasActions: false)
    }

    func pasteEdited() {
        guard let f = feature, !text.isEmpty else { currentHost?.toast("Nothing to paste", style: .error); return }
        n2Apply(f.pasteEntry(f.recordText(text), plain: false), host: currentHost, context: f.context)
    }

    func save() {
        guard let f = feature, let id = entryId, f.update(id, text: text) != nil else { currentHost?.toast("Could not save", style: .error); return }
        currentHost?.toast("Saved", style: .success)
    }

    func handleKey(_ k: VimKey) -> Bool {
        if k.meta && k.key == "Enter" { pasteEdited(); return true }
        if k.meta && !k.shift && k.key.lowercased() == "s" { save(); return true }
        if k.key == "Escape" && !k.meta && !k.ctrl { currentHost?.pop(); return true }
        // Forward editing keys (typing, arrows, ↩, ⌫, ⌘A/⌘C/⌘V/⌘X/⌘Z) to the editor.
        guard let tv = textView, let event = NSApp.currentEvent, event.type == .keyDown else { return false }
        if tv.window?.firstResponder !== tv { tv.window?.makeFirstResponder(tv) }
        if k.meta {
            switch k.key.lowercased() {
            case "a": tv.selectAll(nil)
            case "c": tv.copy(nil)
            case "v": tv.paste(nil)
            case "x": tv.cut(nil)
            case "z": if k.shift { tv.undoManager?.redo() } else { tv.undoManager?.undo() }
            default: break
            }
            return true
        }
        tv.keyDown(with: event)
        return true
    }

    func state() -> JSONValue { ["entryId": entryId.map(JSONValue.string) ?? .null, "text": .string(text)] }
}

struct ClipEditView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: ClipEditModel
    var body: some View {
        VStack(spacing: 0) {
            ClipTextEditor(model: model, font: .monospacedSystemFont(ofSize: 13, weight: .regular), textColor: NSColor(theme.tokens.text))
                .padding(12)
            N2HintBar(hints: [("⌘↩", "paste edited"), ("⌘S", "save to history"), ("Esc", "back")])
        }
        .onAppear { model.currentHost?.setPlaceholder("Edit, then ⌘↩ to paste") }
    }
}

/// NSTextView wrapper whose view the model can drive directly.
struct ClipTextEditor: NSViewRepresentable {
    let model: ClipEditModel
    let font: NSFont
    let textColor: NSColor

    final class Coordinator: NSObject, NSTextViewDelegate {
        let model: ClipEditModel
        init(_ m: ClipEditModel) { model = m }
        func textDidChange(_ n: Notification) {
            guard let tv = n.object as? NSTextView else { return }
            MainActor.assumeIsolated { model.text = tv.string }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(model) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        if let tv = scroll.documentView as? NSTextView {
            tv.isRichText = false
            tv.allowsUndo = true
            tv.drawsBackground = false
            tv.font = font
            tv.textColor = textColor
            tv.insertionPointColor = .controlAccentColor
            tv.string = model.text
            tv.delegate = context.coordinator
            tv.setAccessibilityIdentifier("glide.clipboard.editor")
            model.textView = tv
            DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        if tv.string != model.text { tv.string = model.text }
        tv.textColor = textColor
    }
}
