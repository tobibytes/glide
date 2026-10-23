import Foundation
import GlideCore

/// Text to work on: the selection in the app behind the launcher (Accessibility), else the clipboard — with
/// the reason the selection could not be used (shared by Text Transforms and AI Commands).
public struct SelectionInput: Equatable, Sendable {
    public enum Source: String, Sendable { case selection, clipboard, none }
    public var text: String
    public var source: Source
    /// Why the selection was not used, e.g. "Couldn't read the selection in Safari (it didn't report a selection)".
    public var note: String?
    public init(text: String, source: Source, note: String? = nil) {
        self.text = text
        self.source = source
        self.note = note
    }

    public static let timeout: Duration = .seconds(3)

    /// Human explanation of a `SelectionResult.reason` (same wording as the Electron AI feature).
    public static func explain(_ reason: String?) -> String {
        switch reason ?? "" {
        case "no-accessibility": return "Glide needs Accessibility permission to read selected text"
        case "no-target-app": return "no app to read from"
        case "no-focused-element": return "nothing is focused there"
        case "secure-field": return "it is a password field"
        case "timeout": return "it took too long to answer"
        default: return "it didn't report a selection"
        }
    }

    /// Pure decision from a selection result and the clipboard text.
    public static func resolve(_ sel: SelectionResult, clipboard: String?) -> SelectionInput {
        if let t = sel.text, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return SelectionInput(text: t, source: .selection) }
        let note = "Couldn't read the selection\(sel.app.map { " in \($0)" } ?? "") (\(explain(sel.reason)))"
        if let clip = clipboard, !clip.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return SelectionInput(text: clip, source: .clipboard, note: note)
        }
        return SelectionInput(text: "", source: .none, note: note)
    }

    /// Reads the selection (bounded by `timeout`), falling back to the clipboard.
    @MainActor public static func read(_ services: SystemServices, timeout: Duration = SelectionInput.timeout) async -> SelectionInput {
        let selection = services.selection
        // Not a task group: a group would wait for a hung Accessibility call; whichever finishes first wins.
        @MainActor final class Once { var done = false }
        let once = Once()
        let sel: SelectionResult = await withCheckedContinuation { (cont: CheckedContinuation<SelectionResult, Never>) in
            Task { @MainActor in
                let r = await selection.selectedText()
                if !once.done { once.done = true; cont.resume(returning: r) }
            }
            Task { @MainActor in
                try? await Task.sleep(for: timeout)
                if !once.done { once.done = true; cont.resume(returning: SelectionResult(text: nil, app: nil, reason: "timeout")) }
            }
        }
        return resolve(sel, clipboard: services.pasteboard.string())
    }
}
