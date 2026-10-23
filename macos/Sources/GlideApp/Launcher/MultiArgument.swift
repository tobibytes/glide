import GlideCore
import GlideUI
import SwiftUI

// Multi-argument entry (port of src/renderer/screens/launcher/quicklinkArgs.tsx), added by phase-1 session N1.
// An item opts in by putting argument definitions in `item.data["arguments"]`:
//   [{name, placeholder, default?, options?: [String], optional: Bool}]
// In argument mode Tab / ⇧Tab step through the fields, ↑/↓ cycle a field's options, Backspace on an empty field
// goes back; the search field edits the current argument and the other values show as pills. The action receives
// `ScoredItem.arguments` (name → value) and `ScoredItem.argument` (first value).

struct LauncherArgDef: Equatable {
    var name: String
    var placeholder: String
    var defaultValue: String?
    var options: [String]?
    var optional: Bool
}

struct MultiArgumentState: Equatable {
    var defs: [LauncherArgDef]
    var values: [String]
    var index: Int
}

enum MultiArgument {
    static func defs(_ s: ScoredItem?) -> [LauncherArgDef] {
        (s?.item.data?["arguments"]?.arrayValue ?? []).compactMap { d in
            guard let name = d["name"]?.stringValue, let ph = d["placeholder"]?.stringValue else { return nil }
            let opts = d["options"]?.arrayValue?.compactMap(\.stringValue)
            return LauncherArgDef(name: name, placeholder: ph, defaultValue: d["default"]?.stringValue, options: opts?.isEmpty == false ? opts : nil,
                                  optional: d["optional"]?.boolValue ?? false)
        }
    }

    /// Legacy single-`{query}` items keep the classic one-field entry.
    static func wants(_ s: ScoredItem?) -> Bool {
        let d = defs(s)
        return d.count > 1 || (d.count == 1 && (d[0].name != "query" || d[0].options != nil || d[0].defaultValue != nil))
    }

    /// ⏎ on the row should open the argument fields first (a required argument is still empty).
    static func needsEntry(_ s: ScoredItem?) -> Bool {
        guard let s, wants(s) else { return false }
        let d = defs(s)
        let typed = s.argument?.trimmingCharacters(in: .whitespaces).isEmpty == false
        return d.enumerated().contains { i, def in !def.optional && !(i == 0 && typed) }
    }

    static func initial(_ s: ScoredItem) -> (MultiArgumentState, String)? {
        guard wants(s) else { return nil }
        let d = defs(s)
        let first = s.argument?.trimmingCharacters(in: .whitespaces) ?? ""
        let values = d.enumerated().map { i, def in i == 0 && !first.isEmpty ? first : (def.defaultValue ?? "") }
        return (MultiArgumentState(defs: d, values: values, index: 0), values.first ?? "")
    }

    static func values(_ m: MultiArgumentState, text: String) -> [String: String] {
        var out: [String: String] = [:]
        for (i, d) in m.defs.enumerated() {
            let v = i == m.index ? text : (i < m.values.count ? m.values[i] : "")
            if !v.isEmpty { out[d.name] = v }
        }
        return out
    }

    /// A key in multi-argument mode; nil when it is not ours.
    static func key(_ m: MultiArgumentState, _ k: VimKey, text: String) -> (MultiArgumentState, String)? {
        if k.meta || k.ctrl || k.alt { return nil }
        var next = m
        if next.index < next.values.count { next.values[next.index] = text }
        func go(_ i: Int) -> (MultiArgumentState, String) {
            var g = next
            g.index = i
            return (g, i < g.values.count ? g.values[i] : "")
        }
        if k.key == "Tab" {
            let i = k.shift ? m.index - 1 : m.index + 1
            return i >= 0 && i < m.defs.count ? go(i) : (next, text)
        }
        if k.key == "Backspace" && text.isEmpty && m.index > 0 { return go(m.index - 1) }
        if let opts = m.defs[safe: m.index]?.options, !opts.isEmpty, k.key == "ArrowDown" || k.key == "ArrowUp" {
            let step = k.key == "ArrowDown" ? 1 : -1
            let cur = opts.firstIndex(of: text)
            let n = cur.map { ($0 + step + opts.count) % opts.count } ?? (step > 0 ? 0 : opts.count - 1)
            next.values[m.index] = opts[n]
            return (next, opts[n])
        }
        return nil
    }

    static func placeholder(_ m: MultiArgumentState) -> String {
        guard let d = m.defs[safe: m.index] else { return "Argument…" }
        if let o = d.options, !o.isEmpty { return "\(d.placeholder): \(o.joined(separator: " / ")) (↑↓)" }
        if let def = d.defaultValue { return "\(d.placeholder) (default \(def.isEmpty ? "empty" : def))" }
        return d.placeholder + (d.optional ? "" : " *")
    }

    /// Test-channel view of the pills.
    static func json(_ m: MultiArgumentState, text: String) -> JSONValue {
        .array(m.defs.enumerated().map { i, d in
            let v = i == m.index ? text : (m.values[safe: i] ?? "")
            return ["name": .string(d.name), "placeholder": .string(d.placeholder), "value": .string(v), "current": .bool(i == m.index),
                    "missing": .bool(v.isEmpty && !d.optional)]
        })
    }
}

/// Pills for every argument; the current one is highlighted, missing required ones are outlined.
struct ArgumentPills: View {
    @Environment(\.glideTheme) private var theme
    let state: MultiArgumentState
    let text: String
    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(state.defs.enumerated()), id: \.offset) { i, d in
                let v = i == state.index ? text : (state.values[safe: i] ?? "")
                let missing = v.isEmpty && !d.optional
                HStack(spacing: 4) {
                    Text(d.placeholder).font(.system(size: 11, weight: .semibold)).foregroundStyle(i == state.index ? theme.accentText : theme.text3)
                    Text(v.isEmpty ? (d.defaultValue ?? "…") : v).font(.system(size: 12)).foregroundStyle(i == state.index ? theme.accentText : theme.text2).lineLimit(1)
                }
                .padding(.horizontal, 7)
                .frame(height: 22)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(i == state.index ? theme.accentSoft : theme.surface2))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(missing ? theme.warning : .clear, lineWidth: 1))
            }
            Kbd("⇥")
        }
    }
}
