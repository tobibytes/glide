import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Keyboard helpers shared by the Clipboard and Snippets 2.0 views (session N2).
enum N2Keys {
    /// "⌘E", "⇧⌘C", "⌃X", "⌘↩", "⌘." — the display form actions use.
    static func shortcut(_ k: VimKey) -> String {
        var s = ""
        if k.ctrl { s += "⌃" }
        if k.alt { s += "⌥" }
        if k.shift { s += "⇧" }
        if k.meta { s += "⌘" }
        switch k.key {
        case "Enter": s += "↩"
        case "Backspace": s += "⌫"
        case "ArrowUp": s += "↑"
        case "ArrowDown": s += "↓"
        case "ArrowLeft": s += "←"
        case "ArrowRight": s += "→"
        case "Escape": s += "⎋"
        case " ": s += "Space"
        default: s += k.key.uppercased()
        }
        return s
    }

    static func normalize(_ s: String) -> String { s.replacingOccurrences(of: "⏎", with: "↩") }

    static func matches(_ action: ItemAction, _ k: VimKey) -> Bool {
        guard let s = action.shortcut else { return false }
        return normalize(s) == shortcut(k)
    }

    static var plainNav: Set<String> { ["j", "k", "n", "p", "d", "u"] }

    /// ⌃J/⌃K/⌃N/⌃P/⌃D/⌃U belong to the shared vim navigation.
    static func isVimControl(_ k: VimKey) -> Bool { k.ctrl && !k.meta && !k.alt && plainNav.contains(k.key.lowercased()) }
}

/// A ⌘K panel a feature view draws itself (the launcher's panel acts on root rows only).
struct N2ActionPanelState: Equatable {
    var title: String
    var actions: [ItemAction]
    var filter = ""
    var selected = 0

    var filtered: [ItemAction] {
        guard !filter.isEmpty else { return actions }
        let q = filter.lowercased()
        return actions.filter { a in
            var it = a.title.lowercased().makeIterator()
            var cur = it.next()
            for c in q { while let x = cur, x != c { cur = it.next() }; if cur == nil { return false }; cur = it.next() }
            return true
        }
    }

    enum Outcome: Equatable { case none, close, run(String) }

    /// Keys while the panel is open (every key is consumed).
    mutating func key(_ k: VimKey) -> Outcome {
        let list = filtered
        func move(_ d: Int) { selected = list.isEmpty ? 0 : min(list.count - 1, max(0, selected + d)) }
        let plain = !k.meta && !k.ctrl && !k.alt
        switch k.key {
        case "ArrowDown": move(1); return .none
        case "ArrowUp": move(-1); return .none
        case "Enter": return selected < list.count ? .run(list[selected].id) : .none
        case "Escape": return .close
        case "Backspace":
            if filter.isEmpty { return .close }
            filter.removeLast()
            selected = 0
            return .none
        default: break
        }
        if k.ctrl && ["j", "n"].contains(k.key.lowercased()) { move(1); return .none }
        if k.ctrl && ["k", "p"].contains(k.key.lowercased()) { move(-1); return .none }
        if k.meta && k.key.lowercased() == "k" { return .close }
        if k.meta || k.ctrl { return actions.first { N2Keys.matches($0, k) }.map { .run($0.id) } ?? .none }
        if plain && k.key.count == 1 {
            filter += k.key
            selected = 0
        }
        return .none
    }
}

/// Applies an action result inside a pushed view.
@MainActor func n2Apply(_ r: ActionResult, host: (any LauncherViewHost)?, context: FeatureContext?) {
    let h = host ?? LauncherHosts.current
    switch r {
    case let .hide(m):
        h?.close()
        if let m { context?.toast(m, style: .success) }
    case let .stay(m): if let m { h?.toast(m, style: .info) }
    case let .error(m): h?.toast(m, style: .error)
    case let .pushView(v, p): h?.push(v, payload: p)
    case let .openSettings(p):
        context?.openSettings(page: p)
        h?.close()
    }
}

/// Bottom-trailing overlay for `N2ActionPanelState`.
struct N2PanelOverlay: View {
    let panel: N2ActionPanelState?
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Color.clear
            if let p = panel {
                ActionPanel(title: p.title, actions: p.filtered, selectedIndex: p.selected, filter: p.filter).padding(10)
            }
        }
        .allowsHitTesting(panel != nil)
    }
}

/// Little hint bar at the bottom of a feature view ("⌘G grid · ⌘P filter …").
struct N2HintBar: View {
    @Environment(\.glideTheme) private var theme
    let hints: [(String, String)]
    var body: some View {
        HStack(spacing: 12) {
            ForEach(Array(hints.enumerated()), id: \.offset) { _, h in
                HStack(spacing: 4) {
                    Kbd(h.0)
                    Text(h.1).font(.system(size: 11)).foregroundStyle(theme.text3)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .frame(height: 26)
        .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 1) }
    }
}
