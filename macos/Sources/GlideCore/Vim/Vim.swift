import Foundation

// Port of src/renderer/lib/vim.ts — the pure keyboard model shared by the root list and every launcher view.
// `Vim.key(state, key, context)` → (state, command, consumed). INSERT mode (typing) always has ↑/↓, ⌃J/⌃K,
// ⌃N/⌃P, ⌃D/⌃U, ⌥↑/⌥↓, ⌘↑/⌘↓, ⏎/⌘⏎, ⌘K, ⌫-on-empty pops. NORMAL mode (vim on, after Esc): j k gg G ⌃D ⌃U
// { } l o O h x y p / i a . q Esc + counts.

public enum VimMode: String, Sendable, Codable { case insert, normal }

/// A key press. `key` uses DOM names: "ArrowDown", "Enter", "Escape", "Backspace", "Tab", "Shift", or the
/// typed character ("j", "G", "{").
public struct VimKey: Hashable, Sendable {
    public var key: String
    public var ctrl = false
    public var meta = false
    public var shift = false
    public var alt = false
    public init(_ key: String, ctrl: Bool = false, meta: Bool = false, shift: Bool = false, alt: Bool = false) {
        self.key = key
        self.ctrl = ctrl
        self.meta = meta
        self.shift = shift
        self.alt = alt
    }
}

public enum GotoTarget: Hashable, Sendable { case index(Int), last }

public enum VimCommand: Hashable, Sendable {
    case move(delta: Int)
    case goto(GotoTarget)
    case halfPage(dir: Int, count: Int)
    case section(dir: Int, count: Int)
    case activate(ActionModifiers)
    case secondary
    case actions
    case delete
    case copy
    case paste
    case pop
    case clearQuery
    case hide
    case normal
    case insert(clear: Bool)

    public var isNavigation: Bool {
        switch self {
        case .move, .goto, .halfPage, .section: return true
        default: return false
        }
    }
}

public struct VimContext: Sendable {
    public var enabled: Bool
    public var mode: VimMode
    public var queryEmpty: Bool
    public var viewPushed: Bool
    /// ms timestamp of the key press (gg window)
    public var now: Double
    public init(enabled: Bool, mode: VimMode, queryEmpty: Bool, viewPushed: Bool, now: Double) {
        self.enabled = enabled
        self.mode = mode
        self.queryEmpty = queryEmpty
        self.viewPushed = viewPushed
        self.now = now
    }
}

public struct VimState: Hashable, Sendable {
    public var count: String
    public var gAt: Double?
    public init(count: String = "", gAt: Double? = nil) {
        self.count = count
        self.gAt = gAt
    }
    public static let initial = VimState()
}

public struct VimResult: Hashable, Sendable {
    public var state: VimState
    public var command: VimCommand?
    /// The key must not reach the text field.
    public var consumed: Bool
}

public enum Vim {
    public static let ggWindowMs: Double = 500

    private static func none(_ s: VimState, consumed: Bool = false) -> VimResult { VimResult(state: s, command: nil, consumed: consumed) }
    private static func cmd(_ c: VimCommand) -> VimResult { VimResult(state: .initial, command: c, consumed: true) }

    private static func commonKey(_ k: VimKey, _ n: Int) -> VimCommand? {
        let key = k.key
        let ctrl = k.ctrl && !k.meta && !k.alt
        if key == "ArrowDown" || key == "ArrowUp" {
            let dir = key == "ArrowDown" ? 1 : -1
            if k.meta { return .section(dir: dir, count: n) }
            if k.alt { return .move(delta: dir * 5 * n) }
            if k.ctrl { return nil }
            return .move(delta: dir * n)
        }
        if ctrl {
            switch key.lowercased() {
            case "j", "n": return .move(delta: n)
            case "k", "p": return .move(delta: -n)
            case "d": return .halfPage(dir: 1, count: n)
            case "u": return .halfPage(dir: -1, count: n)
            default: break
            }
        }
        if k.meta && !k.ctrl && !k.alt && key.lowercased() == "k" { return .actions }
        if key == "Enter" {
            if k.meta && !k.shift && !k.alt && !k.ctrl { return .secondary }
            var m: ActionModifiers = []
            if k.meta { m.insert(.command) }
            if k.shift { m.insert(.shift) }
            if k.alt { m.insert(.option) }
            return .activate(m)
        }
        return nil
    }

    public static func key(_ state: VimState, _ k: VimKey, _ ctx: VimContext) -> VimResult {
        if ctx.enabled && ctx.mode == .normal { return normalKey(state, k, ctx) }
        return insertKey(state, k, ctx)
    }

    private static func insertKey(_ state: VimState, _ k: VimKey, _ ctx: VimContext) -> VimResult {
        let plain = !k.meta && !k.ctrl && !k.alt
        if k.key == "Escape" && plain {
            if ctx.enabled { return cmd(!ctx.queryEmpty || ctx.viewPushed ? .normal : .hide) }
            if !ctx.queryEmpty { return cmd(.clearQuery) }
            return cmd(ctx.viewPushed ? .pop : .hide)
        }
        if k.key == "Backspace" && ctx.queryEmpty && ctx.viewPushed && plain { return cmd(.pop) }
        if let c = commonKey(k, 1) { return cmd(c) }
        return none(.initial)
    }

    private static func normalKey(_ state: VimState, _ k: VimKey, _ ctx: VimContext) -> VimResult {
        let key = k.key
        let n = max(1, Int(state.count) ?? 1)
        let plain = !k.meta && !k.ctrl && !k.alt
        if ["Shift", "Control", "Alt", "Meta"].contains(key) { return none(state) }
        if key == "Escape" && plain { return cmd(.hide) }
        if let c = commonKey(k, n) { return cmd(c) }
        if !plain { return none(.initial) }
        if key.count == 1, let ch = key.first, ch.isASCII, ch.isNumber, key != "0" || !state.count.isEmpty {
            return VimResult(state: VimState(count: state.count + key, gAt: nil), command: nil, consumed: true)
        }
        if key == "g" {
            if let g = state.gAt, ctx.now - g <= ggWindowMs { return cmd(.goto(state.count.isEmpty ? .index(0) : .index(n - 1))) }
            return VimResult(state: VimState(count: state.count, gAt: ctx.now), command: nil, consumed: true)
        }
        switch key {
        case "j": return cmd(.move(delta: n))
        case "k": return cmd(.move(delta: -n))
        case "G": return cmd(.goto(state.count.isEmpty ? .last : .index(n - 1)))
        case "}": return cmd(.section(dir: 1, count: n))
        case "{": return cmd(.section(dir: -1, count: n))
        case "l", "o": return cmd(.activate([]))
        case "O": return cmd(.secondary)
        case "h", "Backspace": return cmd(ctx.viewPushed ? .pop : .clearQuery)
        case "x": return cmd(.delete)
        case "y": return cmd(.copy)
        case "p": return cmd(.paste)
        case "i", "a": return cmd(.insert(clear: false))
        case "/": return cmd(.insert(clear: true))
        case ".": return cmd(.actions)
        case "q": return cmd(.hide)
        case "Tab": return none(.initial)
        default: break
        }
        // Any other printable key is swallowed so NORMAL mode never types into the field.
        return none(.initial, consumed: key.count == 1)
    }

    // MARK: mode transitions

    public enum ModeEvent: Sendable { case command(VimCommand), push, pop, show, needsInput }

    /// Pushing, popping and showing always land in INSERT so the field is never left read-only.
    public static func modeAfter(_ mode: VimMode, _ ev: ModeEvent) -> VimMode {
        switch ev {
        case .push, .pop, .show, .needsInput: return .insert
        case let .command(c):
            switch c {
            case .normal: return .normal
            case .insert, .pop: return .insert
            default: return mode
            }
        }
    }

    // MARK: action panel keys (NORMAL mode, not filtering)

    public enum PanelCommand: Hashable, Sendable { case move(Int), run, close, filter }

    public static func panelKey(_ k: VimKey) -> PanelCommand? {
        let plain = !k.meta && !k.ctrl && !k.alt
        if k.key == "ArrowDown" || (plain && k.key == "j") || (k.ctrl && (k.key == "j" || k.key == "n")) { return .move(1) }
        if k.key == "ArrowUp" || (plain && k.key == "k") || (k.ctrl && (k.key == "k" || k.key == "p")) { return .move(-1) }
        if k.key == "Enter" || (plain && k.key == "l") { return .run }
        if k.key == "Escape" || (plain && k.key == "h") || (k.meta && k.key.lowercased() == "k") { return .close }
        if plain && (k.key == "/" || k.key == "i") { return .filter }
        return nil
    }

    // MARK: keyboard core

    public struct NavShape: Sendable {
        public var length: Int
        /// Section key per row; consecutive equal keys form a section.
        public var sections: [String]?
        public var halfPage: Int
        public init(length: Int, sections: [String]? = nil, halfPage: Int = 5) {
            self.length = length
            self.sections = sections
            self.halfPage = halfPage
        }
    }

    /// Next selected index (clamped; -1 when empty).
    public static func applyNav(_ command: VimCommand, index: Int, shape: NavShape) -> Int {
        let length = shape.length
        if length <= 0 { return -1 }
        func clamp(_ i: Int) -> Int { min(length - 1, max(0, i)) }
        let cur = clamp(index < 0 ? 0 : index)
        switch command {
        case let .move(delta): return clamp(cur + delta)
        case let .goto(t):
            switch t {
            case .last: return length - 1
            case let .index(i): return clamp(i)
            }
        case let .halfPage(dir, count): return clamp(cur + dir * max(1, shape.halfPage) * count)
        case let .section(dir, count):
            var i = cur
            for _ in 0..<count { i = sectionJump(i, dir, shape) }
            return i
        default: return cur
        }
    }

    private static func sectionJump(_ index: Int, _ dir: Int, _ shape: NavShape) -> Int {
        let last = shape.length - 1
        guard let secs = shape.sections, secs.count == shape.length else { return dir > 0 ? last : 0 }
        func start(_ i0: Int) -> Int {
            var i = i0
            while i > 0 && secs[i - 1] == secs[i] { i -= 1 }
            return i
        }
        if dir > 0 {
            var i = index
            while i <= last && secs[i] == secs[index] { i += 1 }
            return i > last ? last : i
        }
        let s = start(index)
        if s < index { return s }
        return s == 0 ? 0 : start(s - 1)
    }

    /// Classify actions for x / y / p.
    public static func findAction(_ actions: [ItemAction], kind: String) -> ItemAction? {
        func starts(_ t: String, _ words: [String]) -> Bool {
            let lower = t.lowercased()
            return words.contains { w in lower == w || lower.hasPrefix(w + " ") }
        }
        switch kind {
        case "delete": return actions.first { $0.destructive } ?? actions.first { starts($0.title, ["delete", "remove", "clear"]) }
        case "copy": return actions.first { starts($0.title, ["copy"]) }
        default: return actions.first { starts($0.title, ["paste"]) }
        }
    }

    public static let cheatsheet: [(String, String)] = [
        ("Enter NORMAL mode", "⎋"), ("Down / up", "j k"), ("Top / bottom", "gg G"), ("Half page down / up", "⌃D ⌃U"),
        ("Next / previous section", "} {"), ("Run primary action", "l o ⏎"), ("Run secondary action", "O ⌘⏎"),
        ("Back (pop view / clear query)", "h ⌫"), ("Delete (press twice)", "x"), ("Copy / paste action", "y p"),
        ("Insert (keep / clear query)", "i /"), ("Action panel", ". ⌘K"), ("Repeat (e.g. 5j)", "1-9"), ("Hide launcher", "q ⎋"),
        ("Move in any mode", "⌃J ⌃K ⌃N ⌃P"),
    ]
}
