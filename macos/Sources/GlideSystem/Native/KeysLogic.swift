import Foundation

// Copied verbatim from glide-helper KeysLogic.swift. Pure keyboard-tap decision logic (no CGEvent, no AppKit): what to do with each key event.
// Keys.swift turns decisions into side effects; KeysSelfTest.swift feeds synthetic sequences
// through this engine (`glide-helper --selftest-keys`) so the logic is testable without a tap.

/// One expansion entry from keys.configure. `id` set = live rendering (ask main via snippet.matched).
struct SnippetEntry: Equatable {
    let keyword: String
    /// Pre-rendered plain text, used when main does not answer in time (or for entries without id).
    let text: String
    let id: String?
    let excludedBundleIds: [String]
}

struct KeyMods: OptionSet, Equatable {
    let rawValue: Int
    static let command = KeyMods(rawValue: 1)
    static let control = KeyMods(rawValue: 2)
    static let option = KeyMods(rawValue: 4)
    static let shift = KeyMods(rawValue: 8)
}

enum KeyKind: String { case down, up, flags, mouse }

/// A key event reduced to what the decision needs.
struct KeyInput {
    var kind: KeyKind
    var code: Int64 = -1
    var mods: KeyMods = []
    /// Characters the event types (keyboardGetUnicodeString); "" for function keys and dead keys.
    var chars: String = ""
    var autorepeat = false
}

/// Environment at the time of the event.
struct KeyEnv {
    /// IsSecureEventInputEnabled(): a password field (or similar) is focused.
    var secureInput = false
    /// Bundle id of the frontmost app (nil = unknown).
    var bundleId: String?
}

enum KeyDecision: Equatable {
    /// Let the event through unchanged.
    case pass
    /// Let it through with ⌃⌥⇧⌘ added (Hyper held).
    case passHyper
    /// Drop it.
    case swallow
    /// Drop it and post Escape (Hyper tapped alone).
    case swallowPostEscape
    /// Drop it now and replay it after the pending expansion / stack paste finished.
    case queue
    /// Let it through (it completed the keyword), then expand: delete `backspaces` characters and paste.
    case expand(SnippetEntry, backspaces: Int)
    /// Drop this ⌘V and ask main for the next Paste Stack item.
    case interceptPaste
}

enum KeyCodes {
    static let f18: Int64 = 79
    static let delete: Int64 = 51
    static let v: Int64 = 9
    static let escape: Int64 = 53
    static let leftArrow: Int64 = 123
    /// Return, Enter, Tab, Escape, arrows, Home/End, Page Up/Down, forward delete: end the typed word.
    static let reset: Set<Int64> = [36, 76, 48, 53, 123, 124, 125, 126, 115, 119, 116, 121, 117]
}

/// Backspaces that delete `keyword` once typed: one per grapheme cluster (é, 👍🏽 and 🇫🇷 are one each).
func backspaceCount(_ keyword: String) -> Int { keyword.count }

/// Case-insensitive bundle-id exclusion: per snippet or global.
func isExcluded(_ entry: SnippetEntry, bundleId: String?, global: [String]) -> Bool {
    guard let b = bundleId?.lowercased(), !b.isEmpty else { return false }
    return global.contains { $0.lowercased() == b } || entry.excludedBundleIds.contains { $0.lowercased() == b }
}

/// ⌘V with no other modifier (by character, so non-QWERTY layouts work; key code 9 when no character).
func isPlainCommandV(_ input: KeyInput) -> Bool {
    guard input.kind == .down, input.mods == [.command] else { return false }
    let c = input.chars.lowercased()
    return c.isEmpty ? input.code == KeyCodes.v : c == "v"
}

struct KeyEngine {
    private(set) var entries: [SnippetEntry] = []
    var globalExcluded: [String] = []
    var hyper = false
    /// The clipboard's Paste Stack has items: ⌘V pastes the next one.
    var pasteStack = false
    private(set) var buffer = ""
    private(set) var hyperDown = false
    private(set) var hyperUsed = false
    /// An expansion is waiting for main's render (≤ 300 ms): typing is queued meanwhile.
    private(set) var expansionPending = false
    /// A stack ⌘V is waiting for main's reply (≤ 500 ms watchdog).
    private(set) var pastePending = false
    /// The V key-up that belongs to an intercepted ⌘V must be swallowed too.
    private var swallowVUp = false
    private var maxKeyword = 0

    var active: Bool { hyper || pasteStack || !entries.isEmpty }

    mutating func setEntries(_ list: [SnippetEntry]) {
        // Longest keyword first so ";sig2" wins over ";sig"; empty ones are dropped.
        let next = list.filter { !$0.keyword.isEmpty && (!$0.text.isEmpty || $0.id != nil) }.sorted { $0.keyword.count > $1.keyword.count }
        // The config is re-sent often while typing ({time}/{clipboard} snippets re-render every 20 s, 400 ms after
        // each expansion, on every Paste Stack change): only a different keyword set restarts the typed word, so
        // a keyword typed across a refresh still expands (input-audit fix).
        if next.map(\.keyword) != entries.map(\.keyword) { buffer = "" }
        entries = next
        maxKeyword = entries.map { $0.keyword.count }.max() ?? 0
    }

    mutating func resetBuffer() { buffer = "" }
    mutating func releaseHyper() { hyperDown = false }
    mutating func expansionFinished() { expansionPending = false }
    mutating func pasteFinished() { pastePending = false }

    mutating func handle(_ input: KeyInput, _ env: KeyEnv) -> KeyDecision {
        switch input.kind {
        case .mouse:
            buffer = ""
            return .pass
        case .flags:
            if !input.mods.intersection([.command, .control, .option]).isEmpty { buffer = "" }
            return .pass
        case .down, .up:
            break
        }
        let down = input.kind == .down
        if hyper && input.code == KeyCodes.f18 {
            if down {
                if !input.autorepeat { hyperDown = true; hyperUsed = false }
                return .swallow
            }
            hyperDown = false
            return hyperUsed ? .swallow : .swallowPostEscape
        }
        if !down && swallowVUp && input.code == KeyCodes.v {
            swallowVUp = false
            return .swallow
        }
        if hyper && hyperDown {
            if down { hyperUsed = true }
            buffer = ""
            return .passHyper
        }
        if expansionPending || pastePending {
            // Keep keystroke order: anything typed while we wait is replayed after the paste.
            return .queue
        }
        guard down else { return .pass }
        if pasteStack && !env.secureInput && !input.autorepeat && isPlainCommandV(input) {
            pastePending = true
            swallowVUp = true
            buffer = ""
            return .interceptPaste
        }
        guard !entries.isEmpty else { return .pass }
        if env.secureInput {
            buffer = ""
            return .pass
        }
        return track(input, env)
    }

    private mutating func track(_ input: KeyInput, _ env: KeyEnv) -> KeyDecision {
        if KeyCodes.reset.contains(input.code) || !input.mods.intersection([.command, .control, .option]).isEmpty {
            buffer = ""
            return .pass
        }
        if input.code == KeyCodes.delete {
            if !buffer.isEmpty { buffer.removeLast() }
            return .pass
        }
        guard !input.chars.isEmpty else { return .pass }
        buffer += input.chars
        let cap = max(64, maxKeyword * 2)
        if buffer.count > cap { buffer = String(buffer.suffix(cap)) }
        for e in entries where buffer.hasSuffix(e.keyword) {
            if isExcluded(e, bundleId: env.bundleId, global: globalExcluded) { continue }
            buffer = ""
            if e.id != nil { expansionPending = true }
            return .expand(e, backspaces: backspaceCount(e.keyword))
        }
        return .pass
    }
}

/// What the helper does with main's reply to a stack.next request.
enum StackReplyAction: Equatable {
    /// Paste this text (and HTML) through the transient pasteboard path.
    case paste(text: String, html: String?)
    /// Re-post the original ⌘V (main prepared the clipboard, the stack is empty, or main timed out).
    case passOriginal
}

/// Pure mapping of a stack.reply (nil = watchdog fired) to the paste action and the new intercept state.
func stackReplyDecision(text: String?, html: String?, passthrough: Bool, empty: Bool, active: Bool?, currentlyActive: Bool) -> (action: StackReplyAction, pasteStack: Bool) {
    let nextActive = empty ? false : (active ?? currentlyActive)
    if !empty, !passthrough, let text, !text.isEmpty || html?.isEmpty == false {
        return (.paste(text: text, html: html), nextActive)
    }
    return (.passOriginal, nextActive)
}

/// Pure mapping of a snippet.render reply (nil text = timeout or main had nothing) to what gets pasted.
func renderDecision(fallback: String, text: String?, html: String?, cursorLeft: Int?) -> (text: String, html: String?, cursorLeft: Int, live: Bool) {
    guard let text, !text.isEmpty || html?.isEmpty == false else { return (fallback, nil, 0, false) }
    return (text, html?.isEmpty == true ? nil : html, max(0, min(cursorLeft ?? 0, 2000)), true)
}
