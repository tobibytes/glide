import AppKit
import GlideCore
import GlideUI
import Observation
import SwiftUI

// Shared helpers for the N7 features (Notes, Timers, Focus, Calendar, Reminders, Color, OCR, Browser):
// JSON/file helpers, clock formatting, and a keyboard-first list for pushed launcher views (`N7ListModel` +
// `N7ListView`) with its own ⌘K action panel, sections, detail pane and the launcher's shared vim commands
// (via `FeatureCommandHandling`).

// MARK: - JSON / files

public enum N7JSON {
    /// Encodable → JSONValue (for `invoke` results and the test channel).
    public static func value<T: Encodable>(_ v: T) -> JSONValue {
        guard let data = try? JSONEncoder().encode(v), let out = try? JSONDecoder().decode(JSONValue.self, from: data) else { return .null }
        return out
    }

    public static func decode<T: Decodable>(_ v: JSONValue, as type: T.Type = T.self) -> T? {
        guard let data = try? JSONEncoder().encode(v) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    public static func read(_ url: URL) -> JSONValue? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Atomic write (temp file + rename, like the Electron features).
    @discardableResult
    public static func write<T: Encodable>(_ v: T, to url: URL, pretty: Bool = false) -> Bool {
        let enc = JSONEncoder()
        enc.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
        guard let data = try? enc.encode(v) else { return false }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}

public extension JSONValue {
    /// Numbers stored as int or double (Electron writes both).
    var number: Double? { doubleValue ?? intValue.map(Double.init) }
}

/// Wall clock in unix ms (the Electron data format).
public typealias N7Now = @MainActor () -> Double
@MainActor public let n7SystemNow: N7Now = { Date().timeIntervalSince1970 * 1000 }

public enum N7Format {
    static let enUS = Locale(identifier: "en_US")

    /// "9:05 AM"
    public static func time(_ ms: Double) -> String {
        let f = DateFormatter()
        f.locale = enUS
        f.dateFormat = "h:mm a"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// "just now", "5m ago", "3h ago", or a date.
    public static func relative(_ ms: Double, now: Double) -> String {
        let s = Int(((now - ms) / 1000).rounded())
        if s < 10 { return "just now" }
        if s < 60 { return "\(s)s ago" }
        if s < 3600 { return "\(Int((Double(s) / 60).rounded()))m ago" }
        if s < 86400 { return "\(Int((Double(s) / 3600).rounded()))h ago" }
        let f = DateFormatter()
        f.locale = enUS
        f.dateFormat = "MMM d"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}

// MARK: - list rows and actions

/// One action of a pushed-view row. The first is primary (⏎); "⌘⏎" is secondary.
public struct N7Action {
    public var id: String
    public var title: String
    public var shortcut: String?
    public var icon: String?
    public var destructive: Bool
    public var run: @MainActor () async -> Void
    public init(_ id: String, _ title: String, shortcut: String? = nil, icon: String? = nil, destructive: Bool = false, run: @escaping @MainActor () async -> Void) {
        self.id = id
        self.title = title
        self.shortcut = shortcut
        self.icon = icon
        self.destructive = destructive
        self.run = run
    }
    var itemAction: ItemAction { ItemAction(id: id, title: title, shortcut: shortcut, icon: icon, destructive: destructive) }
}

public struct N7Row: Identifiable {
    public var id: String
    public var section: String
    public var icon: ItemIcon?
    public var title: String
    public var subtitle: String?
    /// Accent tag after the title (provider, list…).
    public var tag: String?
    /// Small text at the right (time, list name, clock).
    public var trailing: String?
    /// Large monospaced clock at the right (timers, stopwatches).
    public var clock: String?
    /// 0…1 progress bar left of the clock.
    public var progress: Double?
    public var actions: [N7Action]
    public var detail: (@MainActor () -> AnyView)?
    public init(id: String, section: String = "", icon: ItemIcon? = nil, title: String, subtitle: String? = nil, tag: String? = nil, trailing: String? = nil,
                clock: String? = nil, progress: Double? = nil, actions: [N7Action] = [], detail: (@MainActor () -> AnyView)? = nil) {
        self.id = id
        self.section = section
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.tag = tag
        self.trailing = trailing
        self.clock = clock
        self.progress = progress
        self.actions = actions
        self.detail = detail
    }
}

/// Selection, ⌘K panel and key handling for a pushed list view. Rows are rebuilt from the current query on
/// demand (`build`), so the model works headless (no render needed) and stays in sync with the search field.
@MainActor @Observable public final class N7ListModel {
    public struct Panel: Equatable {
        public var title: String
        public var actions: [ItemAction]
        public var selected: Int
        public var filter: String
        public var filtered: [ItemAction] {
            filter.isEmpty ? actions : actions.filter { $0.title.localizedCaseInsensitiveContains(filter) }
        }
    }

    public private(set) var panel: Panel?
    /// Bumped on every visible change so SwiftUI re-renders (rows are computed, not stored).
    public private(set) var revision = 0
    @ObservationIgnored public var build: @MainActor (String) -> [N7Row]
    @ObservationIgnored public var placeholder: String
    @ObservationIgnored public var emptyTitle: String
    @ObservationIgnored public var emptySubtitle: String?
    @ObservationIgnored public var banner: @MainActor () -> (String, Bool)? = { nil }
    @ObservationIgnored public var header: (@MainActor () -> AnyView)?
    @ObservationIgnored private var selectedId: String?
    @ObservationIgnored private var lastQuery: String?
    @ObservationIgnored private var pendingDelete: (id: String, at: Date)?
    /// Explicit host (tests); defaults to the launcher's.
    @ObservationIgnored public var hostOverride: (any LauncherViewHost)?

    public init(placeholder: String, emptyTitle: String, emptySubtitle: String? = nil, build: @escaping @MainActor (String) -> [N7Row]) {
        self.placeholder = placeholder
        self.emptyTitle = emptyTitle
        self.emptySubtitle = emptySubtitle
        self.build = build
    }

    public var host: (any LauncherViewHost)? { hostOverride ?? LauncherHosts.current }
    public var query: String { host?.query ?? "" }

    public func rows() -> [N7Row] { build(query) }

    /// Index of the selected row (first row after the query changed).
    public func selectedIndex(_ rows: [N7Row]) -> Int {
        guard !rows.isEmpty else { return -1 }
        if let id = selectedId, lastQuery == query, let i = rows.firstIndex(where: { $0.id == id }) { return i }
        return 0
    }

    public func selectedRow() -> N7Row? {
        let r = rows()
        let i = selectedIndex(r)
        return i >= 0 ? r[i] : nil
    }

    func select(_ rows: [N7Row], _ i: Int) {
        guard i >= 0, i < rows.count else { return }
        selectedId = rows[i].id
        lastQuery = query
        changed()
    }

    public func select(id: String) {
        selectedId = id
        lastQuery = query
        changed()
    }

    /// Re-render and refresh footer/placeholder (call after data changes).
    public func changed() {
        revision &+= 1
        syncHost()
    }

    /// Placeholder + footer of the top view. Never call from a SwiftUI body.
    public func syncHost() {
        guard let host else { return }
        host.setPlaceholder(placeholder)
        let row = selectedRow()
        host.setFooter(primary: row?.actions.first?.title, hasActions: !(row?.actions.isEmpty ?? true))
    }

    // MARK: vim commands (from the launcher)

    public func handle(_ c: VimCommand) -> Bool {
        let rows = rows()
        if c.isNavigation {
            let shape = Vim.NavShape(length: rows.count, sections: rows.map(\.section), halfPage: 5)
            let next = Vim.applyNav(c, index: max(0, selectedIndex(rows)), shape: shape)
            if next >= 0 { select(rows, next) }
            return true
        }
        let i = selectedIndex(rows)
        let row = i >= 0 ? rows[i] : nil
        switch c {
        case let .activate(mods):
            guard let row else { return true }
            if mods.contains(.command) { runSecondary(row) } else { run(row.actions.first) }
            return true
        case .secondary:
            if let row { runSecondary(row) }
            return true
        case .actions:
            openPanel(row)
            return true
        case .delete, .copy, .paste:
            guard let row else { return true }
            let kind = c == .delete ? "delete" : c == .copy ? "copy" : "paste"
            guard let a = Vim.findAction(row.actions.map(\.itemAction), kind: kind), let action = row.actions.first(where: { $0.id == a.id }) else {
                host?.toast("No \(kind) action", style: .info)
                return true
            }
            if c == .delete { confirmDelete(row, action) } else { run(action) }
            return true
        default:
            return false
        }
    }

    private func runSecondary(_ row: N7Row) {
        run(row.actions.first { ["⌘⏎", "⌘↩"].contains($0.shortcut ?? "") } ?? row.actions.first)
    }

    /// Destructive actions need a second press within 2.5 s.
    private func confirmDelete(_ row: N7Row, _ action: N7Action) {
        if let p = pendingDelete, p.id == row.id, Date().timeIntervalSince(p.at) < 2.5 {
            pendingDelete = nil
            run(action)
        } else {
            pendingDelete = (row.id, Date())
            host?.toast("Press again to \(action.title.lowercased())", style: .info)
        }
    }

    public func run(_ action: N7Action?) {
        guard let action else { return }
        panel = nil
        Task { @MainActor in
            await action.run()
            self.changed()
        }
    }

    /// Run an action by id on the selected row (tests, driver).
    public func run(actionId: String) async -> Bool {
        guard let a = selectedRow()?.actions.first(where: { $0.id == actionId }) else { return false }
        panel = nil
        await a.run()
        changed()
        return true
    }

    func openPanel(_ row: N7Row?) {
        guard let row, !row.actions.isEmpty else { return }
        panel = Panel(title: row.title, actions: row.actions.map(\.itemAction), selected: 0, filter: "")
    }

    // MARK: raw keys (before vim)

    public func handleKey(_ k: VimKey) -> Bool {
        if panel != nil { return panelKey(k) }
        // ⌘N, ⌃X, ⇧⌘C … run the selected row's action with that shortcut (⌘K / ⌘⏎ / ⌘↑↓ stay with vim).
        if (k.meta || k.ctrl), k.key.count == 1, !(k.meta && !k.ctrl && !k.alt && k.key.lowercased() == "k") {
            let s = Self.shortcutString(k)
            let rows = rows()
            let i = selectedIndex(rows)
            if i >= 0, let a = rows[i].actions.first(where: { Self.normalize($0.shortcut ?? "") == s }) {
                if a.destructive { confirmDelete(rows[i], a) } else { run(a) }
                return true
            }
            // Shortcuts that do not depend on a row (⌘N …) are matched against the first row too.
            if i < 0 { return false }
        }
        return false
    }

    private func panelKey(_ k: VimKey) -> Bool {
        guard var p = panel else { return false }
        let list = p.filtered
        func move(_ d: Int) {
            p.selected = list.isEmpty ? 0 : min(list.count - 1, max(0, p.selected + d))
            panel = p
        }
        func runSelected() {
            guard p.selected < list.count, let row = selectedRow() else { return }
            let wanted = list[p.selected].id // copy out: the release optimizer flags capturing `p` in the closure
            guard let a = row.actions.first(where: { $0.id == wanted }) else { return }
            run(a)
        }
        let plain = !k.meta && !k.ctrl && !k.alt
        switch k.key {
        case "ArrowDown": move(1); return true
        case "ArrowUp": move(-1); return true
        case "Enter": runSelected(); return true
        case "Escape": panel = nil; return true
        case "Backspace":
            if p.filter.isEmpty { panel = nil } else { p.filter.removeLast(); p.selected = 0; panel = p }
            return true
        default: break
        }
        if k.ctrl && ["j", "n"].contains(k.key.lowercased()) { move(1); return true }
        if k.ctrl && ["k", "p"].contains(k.key.lowercased()) { move(-1); return true }
        if k.meta && k.key.lowercased() == "k" { panel = nil; return true }
        if k.meta || k.ctrl {
            let s = Self.shortcutString(k)
            if let row = selectedRow(), let a = row.actions.first(where: { Self.normalize($0.shortcut ?? "") == s }) { run(a) }
            return true
        }
        if plain && k.key.count == 1 {
            p.filter += k.key
            p.selected = 0
            panel = p
        }
        return true
    }

    static func shortcutString(_ k: VimKey) -> String {
        var s = ""
        if k.ctrl { s += "⌃" }
        if k.alt { s += "⌥" }
        if k.shift { s += "⇧" }
        if k.meta { s += "⌘" }
        switch k.key {
        case "Enter": return s + "↩"
        case "Backspace": return s + "⌫"
        default: return s + k.key.uppercased()
        }
    }

    static func normalize(_ s: String) -> String { s.replacingOccurrences(of: "⏎", with: "↩") }

    // MARK: test channel

    /// What the view shows (rows, sections, selection, panel) for driver checks.
    public func snapshot() -> JSONValue {
        let rows = rows()
        let sel = selectedIndex(rows)
        var o: [String: JSONValue] = [
            "query": .string(query),
            "selected": .int(Int64(sel)),
            "rows": .array(rows.enumerated().map { i, r in
                var row: [String: JSONValue] = ["id": .string(r.id), "title": .string(r.title), "section": .string(r.section), "selected": .bool(i == sel),
                                                "actions": .array(r.actions.map { .string($0.title) })]
                if let s = r.subtitle { row["subtitle"] = .string(s) }
                if let t = r.trailing { row["trailing"] = .string(t) }
                if let t = r.tag { row["tag"] = .string(t) }
                if let c = r.clock { row["clock"] = .string(c) }
                return .object(row)
            }),
        ]
        if let p = panel { o["panel"] = ["title": .string(p.title), "actions": .array(p.filtered.map { .string($0.title) }), "selected": .int(Int64(p.selected))] }
        if let b = banner() { o["banner"] = .string(b.0) }
        return .object(o)
    }
}

// MARK: - view

/// The list UI for `N7ListModel`: optional header/banner, sectioned rows (GlideUI `ResultRow` look), a detail
/// pane when the selected row has one, and the ⌘K panel.
public struct N7ListView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: N7ListModel
    public init(model: N7ListModel) { self.model = model }

    public var body: some View {
        let _ = model.revision
        let rows = model.rows()
        let sel = model.selectedIndex(rows)
        let detail = sel >= 0 ? rows[sel].detail : nil
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                if let h = model.header { h() }
                if let (msg, isError) = model.banner() {
                    HStack(spacing: 8) {
                        Image(systemName: isError ? "exclamationmark.triangle.fill" : "info.circle.fill").foregroundStyle(isError ? theme.danger : theme.accent)
                        Text(msg).font(.system(size: 12)).foregroundStyle(theme.text2).lineLimit(2)
                        Spacer()
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(theme.hover)
                }
                if rows.isEmpty {
                    EmptyState(symbol: "tray", title: model.emptyTitle, subtitle: model.emptySubtitle).frame(maxHeight: .infinity)
                } else if let detail {
                    DetailSplit(ratio: 0.5) { list(rows, sel) } detail: {
                        ScrollView { detail().padding(14).frame(maxWidth: .infinity, alignment: .topLeading) }
                    }
                } else {
                    list(rows, sel)
                }
            }
            if let p = model.panel {
                ActionPanel(title: p.title, actions: p.filtered, selectedIndex: p.selected, filter: p.filter)
                    .padding(.trailing, 10).padding(.bottom, 6)
            }
        }
    }

    private func list(_ rows: [N7Row], _ sel: Int) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, r in
                        if !r.section.isEmpty, i == 0 || rows[i - 1].section != r.section {
                            SectionHeader(r.section).frame(height: 30, alignment: .bottom)
                        }
                        N7RowView(row: r, selected: i == sel).id(r.id)
                            .onTapGesture { model.select(id: r.id) }
                            .onTapGesture(count: 2) { model.run(r.actions.first) }
                    }
                }
                .padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 8)
            }
            .scrollIndicators(.never)
            .onChange(of: sel) { _, i in if i >= 0, i < rows.count { proxy.scrollTo(rows[i].id) } }
        }
    }
}

struct N7RowView: View {
    @Environment(\.glideTheme) private var theme
    let row: N7Row
    let selected: Bool

    var body: some View {
        HStack(spacing: theme.tokens.rowGap) {
            ItemIconView(row.icon, size: theme.tokens.iconSize, fallbackSymbol: "circle.dashed")
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.title).font(theme.titleFont).foregroundStyle(theme.text).lineLimit(1).truncationMode(.tail).layoutPriority(1)
                if let s = row.subtitle, !s.isEmpty {
                    Text(s).font(theme.subtitleFont).foregroundStyle(theme.text3).lineLimit(1).truncationMode(.tail)
                }
                if let t = row.tag, !t.isEmpty { Tag(t, accent: true) }
            }
            Spacer(minLength: 8)
            if let p = row.progress {
                ZStack(alignment: .leading) {
                    Capsule().fill(theme.tagBg)
                    Capsule().fill(theme.accent).frame(width: 64 * max(0, min(1, p)))
                }
                .frame(width: 64, height: 4)
            }
            if let c = row.clock {
                Text(c).font(.system(size: 15, weight: .semibold, design: .monospaced)).monospacedDigit().foregroundStyle(theme.text)
            }
            if let t = row.trailing {
                Text(t).font(.system(size: theme.tokens.fontSubtitle - 0.5)).foregroundStyle(theme.text3).lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: theme.tokens.rowHeight)
        .background(
            RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous)
                .fill(selected ? theme.selected : .clear)
                .overlay(RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous).strokeBorder(selected ? theme.selectedRing : .clear, lineWidth: 1))
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Settings-page building block: a grouped Form section with a caption.
struct N7SettingsNote: View {
    let text: String
    var body: some View { Text(text).font(.callout).foregroundStyle(.secondary) }
}

/// Runs `body` after the current SwiftUI update (state changes from inside `launcherView`).
@MainActor func n7AfterUpdate(_ body: @escaping @MainActor () -> Void) {
    DispatchQueue.main.async { MainActor.assumeIsolated { body() } }
}
