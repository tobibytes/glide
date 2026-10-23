import Foundation
import GlideCore
import GlideUI
import Observation

/// What a RunModel asks the feature to do (effects, navigation).
@MainActor protocol RunModelOwner: AnyObject {
    func perform(_ action: ExtAction, from model: RunModel, formValues: [String: JSONValue]?) async
    var vimEnabled: Bool { get }
}

/// ⌘K panel state shared by extension and Glide-owned views. Levels stack for ActionPanel.Submenu.
struct PanelLevel: Equatable {
    var title: String
    var actions: [ItemAction]
    var filter = ""
    var selected = 0
    var filtered: [ItemAction] {
        guard !filter.isEmpty else { return actions }
        let f = filter.lowercased()
        return actions.filter { $0.title.lowercased().contains(f) }
    }
}

/// Generic ⌘K panel key handling. Returns (consumed, chosen action id, closed).
enum PanelKeys {
    enum Outcome { case none, run(String), close, back }

    static func handle(_ k: VimKey, _ p: inout PanelLevel, vimNav: Bool) -> Outcome {
        let list = p.filtered
        func move(_ d: Int) { p.selected = list.isEmpty ? 0 : min(list.count - 1, max(0, p.selected + d)) }
        let plain = !k.meta && !k.ctrl && !k.alt
        if vimNav && p.filter.isEmpty, let c = Vim.panelKey(k) {
            switch c {
            case let .move(d): move(d); return .none
            case .run: return p.selected < list.count ? .run(list[p.selected].id) : .none
            case .close: return k.key == "h" || (k.key == "Escape") ? .back : .close
            case .filter: return .none
            }
        }
        switch k.key {
        case "ArrowDown": move(1); return .none
        case "ArrowUp": move(-1); return .none
        case "Enter": return p.selected < list.count ? .run(list[p.selected].id) : .none
        case "Escape": return .back
        case "Backspace":
            if p.filter.isEmpty { return .back }
            p.filter.removeLast(); p.selected = 0; return .none
        default: break
        }
        if k.ctrl && ["j", "n"].contains(k.key.lowercased()) { move(1); return .none }
        if k.ctrl && ["k", "p"].contains(k.key.lowercased()) { move(-1); return .none }
        if k.meta && k.key.lowercased() == "k" { return .close }
        if k.meta || k.ctrl {
            let s = shortcutString(k)
            if let a = p.actions.first(where: { normalize($0.shortcut ?? "") == s }) { return .run(a.id) }
            return .none
        }
        if plain && k.key.count == 1 { p.filter += k.key; p.selected = 0 }
        return .none
    }

    static func shortcutString(_ k: VimKey) -> String {
        var s = ""
        if k.ctrl { s += "⌃" }
        if k.alt { s += "⌥" }
        if k.shift { s += "⇧" }
        if k.meta { s += "⌘" }
        switch k.key {
        case "Enter": s += "↩"
        case "Backspace": s += "⌫"
        case "Delete": s += "⌦"
        case "ArrowUp": s += "↑"
        case "ArrowDown": s += "↓"
        case "ArrowLeft": s += "←"
        case "ArrowRight": s += "→"
        case "Escape": s += "⎋"
        case "Tab": s += "⇥"
        case " ": s += "Space"
        default: s += k.key.uppercased()
        }
        return s
    }

    static func normalize(_ s: String) -> String { s.replacingOccurrences(of: "⏎", with: "↩").replacingOccurrences(of: "␣", with: "Space") }
}

/// State of one extension view (session + depth) shown as a pushed launcher view.
@MainActor @Observable final class RunModel {
    let token: String
    let session: ExtensionSession
    let depth: Int
    @ObservationIgnored weak var owner: RunModelOwner?
    private(set) var view: JSONValue = .null
    private(set) var query = ""
    var selectedIndex = 0
    var panels: [PanelLevel] = []
    var formValues: [String: JSONValue] = [:]
    var focusedField = 0
    var detailAnchor = 0
    var alert: (id: Int, title: String, message: String?, primary: String, dismiss: String, destructive: Bool)?
    @ObservationIgnored var alertResolver: ((Bool) -> Void)?
    @ObservationIgnored private var lastSentSearch: String?
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var lastSelection: String??
    @ObservationIgnored private var appliedSelectedId: String?
    @ObservationIgnored private var paginationAskedAt = -1
    @ObservationIgnored private var initialisedFields = Set<String>()

    init(token: String, session: ExtensionSession, depth: Int) {
        self.token = token
        self.session = session
        self.depth = depth
        if let v = session.view(depth) { apply(v) }
    }

    var type: String { view.extType }
    var title: String { view["title"]?.stringValue ?? session.info.commandTitle }
    var isLoading: Bool { view.isNull || view.extLoading }
    var assets: String { session.info.assetsPath }
    var columns: Int { max(1, view["columns"]?.intValue ?? 5) }
    var placeholder: String {
        if type == "form" || type == "detail" { return title }
        return view["searchPlaceholder"]?.stringValue ?? "Search \(session.info.commandTitle)…"
    }

    // MARK: updates

    func apply(_ v: JSONValue) {
        let keep = selected?.id
        view = v
        if type == "form" { syncForm() }
        if let want = v["selectedItemId"]?.stringValue, want != appliedSelectedId, let i = rows.firstIndex(where: { $0.id == want }) {
            appliedSelectedId = want
            selectedIndex = i
        } else if let keep, let i = rows.firstIndex(where: { $0.id == keep }) {
            selectedIndex = i
        } else {
            selectedIndex = min(max(0, selectedIndex), max(0, rows.count - 1))
        }
        selectionMaybeChanged()
    }

    func setQuery(_ q: String) {
        guard q != query else { return }
        query = q
        selectedIndex = 0
        if let h = view["searchHandler"]?.stringValue, lastSentSearch != q {
            searchTask?.cancel()
            searchTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(140))
                guard let self, !Task.isCancelled else { return }
                self.lastSentSearch = q
                self.session.invoke(depth: self.depth, handler: h, args: [.string(q)])
            }
        }
        selectionMaybeChanged()
    }

    /// Send the pending search now (tests / Enter).
    func flushSearch() {
        guard let h = view["searchHandler"]?.stringValue, lastSentSearch != query else { return }
        searchTask?.cancel()
        lastSentSearch = query
        session.invoke(depth: depth, handler: h, args: [.string(query)])
    }

    // MARK: list / grid

    var filtering: Bool { view["filtering"]?.boolValue ?? (view["searchHandler"] == nil) }
    var rows: [ExtItem] {
        guard type == "list" || type == "grid" else { return [] }
        return filtering ? ExtFilter.filter(view.extItems, query) : view.extItems
    }
    var selected: ExtItem? { let r = rows; return selectedIndex >= 0 && selectedIndex < r.count ? r[selectedIndex] : nil }
    var showsDetail: Bool {
        if let s = view["showDetail"]?.boolValue { return s }
        return view.extItems.contains { $0.detail != nil }
    }
    var emptyActions: [ExtAction] {
        let e = (view["emptyView"]?["actions"]?.arrayValue ?? []).map(ExtAction.init)
        return e.isEmpty ? view.extActions : e
    }

    /// Actions in scope: the selected item's, else the view's (detail/form/empty list).
    var actions: [ExtAction] {
        switch type {
        case "list", "grid": return selected?.actions ?? emptyActions
        default: return view.extActions
        }
    }

    private func selectionMaybeChanged() {
        let id = selected?.id
        if lastSelection != .some(id) {
            lastSelection = .some(id)
            if let h = view["selectionHandler"]?.stringValue { session.invoke(depth: depth, handler: h, args: [id.map(JSONValue.string) ?? .null]) }
        }
        if let p = view["pagination"], p["hasMore"]?.boolValue == true, let h = p["handler"]?.stringValue,
           selectedIndex >= rows.count - 5, paginationAskedAt != rows.count {
            paginationAskedAt = rows.count
            session.invoke(depth: depth, handler: h)
        }
    }

    func move(_ c: VimCommand) {
        switch type {
        case "list", "grid":
            let items = rows
            var cmd = c
            if type == "grid", case let .move(d) = c { cmd = .move(delta: d * columns) }
            let shape = Vim.NavShape(length: items.count, sections: items.map { $0.section ?? "" }, halfPage: type == "grid" ? columns * 2 : 5)
            selectedIndex = max(0, Vim.applyNav(cmd, index: selectedIndex, shape: shape))
            selectionMaybeChanged()
        case "detail":
            let n = MarkdownBlock.parse(view["markdown"]?.stringValue ?? "").count
            switch c {
            case let .move(d): detailAnchor = min(max(0, n - 1), max(0, detailAnchor + d))
            case let .halfPage(dir, count): detailAnchor = min(max(0, n - 1), max(0, detailAnchor + dir * 4 * count))
            case let .goto(t): if case .last = t { detailAnchor = max(0, n - 1) } else { detailAnchor = 0 }
            default: break
            }
        case "form":
            let n = editableFields.count
            if case let .move(d) = c, n > 0 { focusedField = min(n - 1, max(0, focusedField + d)) }
        default: break
        }
    }

    func moveColumn(_ d: Int) {
        guard type == "grid", !rows.isEmpty else { return }
        selectedIndex = min(rows.count - 1, max(0, selectedIndex + d))
        selectionMaybeChanged()
    }

    // MARK: form

    var fields: [JSONValue] { view["fields"]?.arrayValue ?? [] }
    var editableFields: [JSONValue] { fields.filter { !["separator", "description"].contains($0["type"]?.stringValue ?? "") } }

    private func syncForm() {
        for f in fields {
            guard let id = f["id"]?.stringValue else { continue }
            if let v = f["value"], !v.isNull { formValues[id] = v; initialisedFields.insert(id); continue }
            if initialisedFields.contains(id) { continue }
            initialisedFields.insert(id)
            let t = f["type"]?.stringValue ?? "text"
            if let d = f["default"], !d.isNull { formValues[id] = d } else {
                formValues[id] = t == "checkbox" ? .bool(false) : (t == "tags" || t == "file") ? .array([]) : t == "dropdown" ? (f["options"]?.arrayValue?.first?["value"] ?? "") : ""
            }
        }
    }

    func setField(_ id: String, _ value: JSONValue) {
        formValues[id] = value
        if let f = fields.first(where: { $0["id"]?.stringValue == id }), let h = f["changeHandler"]?.stringValue {
            session.invoke(depth: depth, handler: h, args: [value])
        }
    }

    var submitValues: [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, v) in formValues {
            switch v {
            case .string, .bool, .array: out[k] = v
            case .null: break
            default: out[k] = .string(v.description)
            }
        }
        return out
    }

    // MARK: running actions

    func run(_ a: ExtAction) {
        if a.kind == "submenu" {
            panels.append(PanelLevel(title: a.title, actions: a.children.enumerated().map { $1.itemAction(index: $0 + 2) }))
            return
        }
        panels = []
        let values = type == "form" ? submitValues : nil
        Task { await owner?.perform(a, from: self, formValues: values) }
    }

    func activate(secondary: Bool) {
        if type == "form", !secondary, actions.isEmpty, let h = view["submitHandler"]?.stringValue {
            session.invoke(depth: depth, handler: h, args: [.object(submitValues)])
            return
        }
        let list = actions
        guard let a = secondary ? (list.count > 1 ? list[1] : list.first) : list.first else { return }
        run(a)
    }

    private func flatActions() -> [ExtAction] {
        func flat(_ l: [ExtAction]) -> [ExtAction] { l.flatMap { [$0] + flat($0.children) } }
        return flat(actions)
    }

    func togglePanel() {
        if !panels.isEmpty { panels = []; return }
        let list = actions
        guard !list.isEmpty else { return }
        panels = [PanelLevel(title: selected?.title ?? title, actions: list.enumerated().map { $1.itemAction(index: $0) })]
    }

    // MARK: keys

    /// Vim commands from the launcher (shared state). true = handled here.
    func handle(_ c: VimCommand) -> Bool {
        if alert != nil { return true }
        if !panels.isEmpty {
            if c.isNavigation, case let .move(d) = c, var p = panels.last {
                let n = p.filtered.count
                p.selected = n == 0 ? 0 : min(n - 1, max(0, p.selected + d))
                panels[panels.count - 1] = p
                return true
            }
        }
        if c.isNavigation { move(c); return true }
        switch c {
        case let .activate(mods): activate(secondary: mods.contains(.command)); return true
        case .secondary: activate(secondary: true); return true
        case .actions: togglePanel(); return true
        case .copy, .paste, .delete:
            let all = flatActions()
            let a: ExtAction? = c == .copy ? all.first { $0.kind == "copy" } : c == .paste ? all.first { $0.kind == "paste" } : all.first { $0.destructive }
            if let a { run(a) }
            return true
        default: return false
        }
    }

    /// Raw keys first (alert, panel, shortcuts, grid columns, form Tab). true = consumed.
    func handleKey(_ k: VimKey) -> Bool {
        if let a = alert {
            if k.key == "Enter" { resolveAlert(true); return true }
            if k.key == "Escape" { resolveAlert(false); return true }
            _ = a
            return true
        }
        if var p = panels.last {
            let out = PanelKeys.handle(k, &p, vimNav: (owner?.vimEnabled ?? false))
            panels[panels.count - 1] = p
            switch out {
            case .none: break
            case .close: panels = []
            case .back: panels.removeLast()
            case let .run(id):
                if let a = flatActions().first(where: { $0.id == id }) { run(a) }
            }
            return true
        }
        if type == "form" {
            if k.key == "Tab" {
                let n = editableFields.count
                if n > 0 { focusedField = (focusedField + (k.shift ? n - 1 : 1)) % n }
                return true
            }
            if k.key == "Enter" && k.meta { activate(secondary: false); return true }
        }
        if type == "grid" && !k.meta && !k.ctrl {
            if k.key == "ArrowLeft" { moveColumn(-1); return true }
            if k.key == "ArrowRight" { moveColumn(1); return true }
        }
        if (k.meta || k.ctrl) && k.key != "Enter" {
            let s = PanelKeys.shortcutString(k)
            if let a = flatActions().first(where: { PanelKeys.normalize($0.shortcut ?? "") == s }) { run(a); return true }
            if k.meta && k.key.lowercased() == "p", let dd = view["dropdown"], cycleDropdown(dd) { return true }
        }
        return false
    }

    /// ⌘P: next dropdown (searchBarAccessory) value.
    func cycleDropdown(_ dd: JSONValue) -> Bool {
        let opts = (dd["options"]?.arrayValue ?? []).compactMap { $0["value"]?.stringValue }
        guard !opts.isEmpty, let h = dd["handler"]?.stringValue else { return false }
        let cur = dd["value"]?.stringValue ?? opts[0]
        let next = opts[((opts.firstIndex(of: cur) ?? -1) + 1) % opts.count]
        session.invoke(depth: depth, handler: h, args: [.string(next)])
        return true
    }

    func resolveAlert(_ ok: Bool) {
        let r = alertResolver
        alert = nil
        alertResolver = nil
        r?(ok)
    }
}
