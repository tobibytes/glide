import Foundation
import GlideCore
import GlideUI
import Observation

/// A Glide-owned form (extension preferences, command arguments, script arguments): fields edited with
/// SwiftUI controls, Tab / ⇧Tab move focus, ⌘⏎ submits, ⎋ goes back.
@MainActor @Observable final class FieldsFormModel {
    struct Field: Identifiable, Equatable {
        var id: String
        var title: String
        /// "textfield" | "password" | "checkbox" | "dropdown"
        var type: String
        var required: Bool
        var placeholder: String?
        var info: String?
        var options: [ExtOption] = []
    }

    let token: String
    let title: String
    let submitTitle: String
    var fields: [Field]
    var values: [String: JSONValue]
    var focused = 0
    var error: String?
    @ObservationIgnored var onSubmit: (([String: JSONValue]) async -> String?)?

    init(token: String, title: String, submitTitle: String, fields: [Field], values: [String: JSONValue]) {
        self.token = token
        self.title = title
        self.submitTitle = submitTitle
        self.fields = fields
        self.values = values
        for f in fields where values[f.id] == nil {
            self.values[f.id] = f.type == "checkbox" ? .bool(false) : f.type == "dropdown" ? .string(f.options.first?.value ?? "") : .string("")
        }
    }

    func string(_ id: String) -> String { values[id]?.stringValue ?? "" }

    var missing: [Field] { fields.filter { $0.required && $0.type != "checkbox" && string($0.id).trimmingCharacters(in: .whitespaces).isEmpty } }

    func submit() {
        if let m = missing.first {
            error = "\(m.title) is required"
            focused = fields.firstIndex(of: m) ?? focused
            return
        }
        error = nil
        Task {
            if let err = await onSubmit?(values) { error = err }
        }
    }

    func handleKey(_ k: VimKey) -> Bool {
        if k.key == "Tab", !fields.isEmpty {
            focused = (focused + (k.shift ? fields.count - 1 : 1)) % fields.count
            return true
        }
        if k.key == "Enter" && k.meta { submit(); return true }
        if k.key == "Enter" && !k.meta && !k.shift {
            if focused >= fields.count - 1 { submit() } else { focused += 1 }
            return true
        }
        if k.key == " " && fields.indices.contains(focused) && fields[focused].type == "checkbox" {
            let id = fields[focused].id
            values[id] = .bool(!(values[id]?.boolValue ?? false))
            return true
        }
        return false
    }
}

/// A Glide-owned list (Manage Extensions, Store): filtered rows, selection, ⌘K panel, shortcuts.
@MainActor @Observable final class SimpleListModel {
    struct Row: Identifiable, Equatable {
        var id: String
        var title: String
        var subtitle: String?
        var icon: ItemIcon?
        var accessory: String?
        var section: String?
        var detail: String?
        var actions: [ItemAction]
    }

    let token: String
    let kind: String
    var title: String
    var rows: [Row] = [] { didSet { clamp() } }
    var query = "" { didSet { if query != oldValue { selected = 0 } } }
    var selected = 0
    var panel: PanelLevel?
    var banner: String?
    /// Store install confirmation card.
    var confirm: (rowId: String, actionId: String, title: String, message: String)?
    var busy: String?
    @ObservationIgnored var onRun: ((String, Row) async -> Void)?
    @ObservationIgnored var vimNav: () -> Bool = { false }

    init(token: String, kind: String, title: String) {
        self.token = token
        self.kind = kind
        self.title = title
    }

    var filtered: [Row] {
        let words = ExtFilter.norm(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !words.isEmpty else { return rows }
        return rows.filter { r in
            let hay = ExtFilter.norm([r.title, r.subtitle ?? "", r.accessory ?? "", r.section ?? "", r.detail ?? ""].joined(separator: " "))
            return words.allSatisfy { hay.contains($0) }
        }
    }

    var current: Row? { let f = filtered; return selected >= 0 && selected < f.count ? f[selected] : nil }

    private func clamp() { selected = min(max(0, selected), max(0, filtered.count - 1)) }

    func run(_ actionId: String) {
        guard let r = current else { return }
        panel = nil
        Task { await onRun?(actionId, r) }
    }

    func handle(_ c: VimCommand) -> Bool {
        if confirm != nil { return true }
        if c.isNavigation {
            if var p = panel, case let .move(d) = c {
                p.selected = min(max(0, p.selected + d), max(0, p.filtered.count - 1))
                panel = p
                return true
            }
            let f = filtered
            selected = max(0, Vim.applyNav(c, index: selected, shape: Vim.NavShape(length: f.count, sections: f.map { $0.section ?? "" })))
            return true
        }
        switch c {
        case let .activate(mods):
            guard let r = current else { return true }
            let a = mods.contains(.command) ? (r.actions.count > 1 ? r.actions[1] : r.actions.first) : r.actions.first
            if let a { run(a.id) }
            return true
        case .secondary:
            if let r = current, let a = r.actions.count > 1 ? r.actions[1] : r.actions.first { run(a.id) }
            return true
        case .actions:
            if panel != nil { panel = nil } else if let r = current { panel = PanelLevel(title: r.title, actions: r.actions) }
            return true
        case .delete:
            if let r = current, let a = r.actions.first(where: \.destructive) { run(a.id) }
            return true
        default: return false
        }
    }

    func handleKey(_ k: VimKey) -> Bool {
        if let c = confirm {
            if k.key == "Enter" {
                confirm = nil
                if let r = rows.first(where: { $0.id == c.rowId }) { Task { await onRun?("confirmed:" + c.actionId, r) } }
                return true
            }
            if k.key == "Escape" { confirm = nil; return true }
            return true
        }
        if var p = panel {
            let out = PanelKeys.handle(k, &p, vimNav: vimNav())
            panel = p
            switch out {
            case .none: break
            case .close, .back: panel = nil
            case let .run(id): run(id)
            }
            return true
        }
        if (k.meta || k.ctrl) && k.key != "Enter", let r = current {
            let s = PanelKeys.shortcutString(k)
            if let a = r.actions.first(where: { PanelKeys.normalize($0.shortcut ?? "") == s }) { run(a.id); return true }
        }
        return false
    }
}
