import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Search Snippets: filterable list + preview pane (rendered with placeholder stand-ins), ⌘K actions.
@MainActor @Observable final class SnipSearchModel {
    @ObservationIgnored weak var feature: Snippets2Feature?
    @ObservationIgnored weak var host: (any LauncherViewHost)?
    @ObservationIgnored private var nonce: String?
    @ObservationIgnored private var pendingDeleteAt: Date?
    var selectedId: String?
    var panel: N2ActionPanelState?

    init(feature: Snippets2Feature) { self.feature = feature }

    var currentHost: (any LauncherViewHost)? { host ?? LauncherHosts.current }
    var query: String { currentHost?.query ?? "" }

    func prepare(payload: JSONValue, host: (any LauncherViewHost)?) {
        if let host { self.host = host }
        let n = payload["nonce"]?.stringValue
        guard n == nil || n != nonce else { return }
        nonce = n
        selectedId = nil
        panel = nil
        currentHost?.setFooter(primary: "Paste", hasActions: true)
    }

    /// Words must all appear in name, keyword or text; name matches first.
    func rows() -> [Snippet] {
        let all = feature?.snippets ?? []
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !words.isEmpty else { return all.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } }
        func hay(_ s: Snippet) -> String { "\(s.name)\n\(s.keyword ?? "")\n\(s.alias ?? "")\n\(s.text)".lowercased() }
        let hits = all.filter { s in let h = hay(s); return words.allSatisfy { h.contains($0) } }
        return hits.sorted { a, b in
            let an = words.allSatisfy { a.name.lowercased().contains($0) }, bn = words.allSatisfy { b.name.lowercased().contains($0) }
            return an != bn ? an : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    func index(_ rows: [Snippet]) -> Int { rows.isEmpty ? -1 : rows.firstIndex { $0.id == selectedId } ?? 0 }
    var selected: Snippet? { let r = rows(); let i = index(r); return i >= 0 ? r[i] : nil }

    func actions(_ s: Snippet) -> [ItemAction] {
        var a = [ItemAction(id: "paste", title: "Paste", shortcut: "↩", icon: "doc.on.clipboard"),
                 ItemAction(id: "copy", title: "Copy to Clipboard", shortcut: "⌘↩", icon: "doc.on.doc")]
        if s.html != nil { a.append(ItemAction(id: "plain", title: "Paste as Plain Text", shortcut: "⇧⌘↩", icon: "textformat")) }
        a += [ItemAction(id: "edit", title: "Edit Snippet", shortcut: "⌘E", icon: "pencil"),
              ItemAction(id: "new", title: "Create Snippet", shortcut: "⌘N", icon: "plus"),
              ItemAction(id: "duplicate", title: "Duplicate Snippet", shortcut: "⌘D", icon: "plus.square.on.square"),
              ItemAction(id: "delete", title: "Delete Snippet", shortcut: "⌃X", icon: "trash", destructive: true)]
        return a
    }

    func run(_ a: String) {
        guard let f = feature else { return }
        panel = nil
        if a == "new" { f.editor.startNew(); n2Apply(.openSettings(page: Snippets2Feature.settingsBag), host: currentHost, context: f.context); return }
        guard let s = selected else { return }
        switch a {
        case "paste", "plain":
            Task { let r = await f.paste(s, plain: a == "plain"); n2Apply(r, host: self.currentHost, context: f.context) }
        case "copy":
            Task { let r = await f.copy(s); n2Apply(r, host: self.currentHost, context: f.context) }
        case "edit":
            f.editor.select(s.id)
            n2Apply(.openSettings(page: Snippets2Feature.settingsBag), host: currentHost, context: f.context)
        case "duplicate":
            var c = s
            c.id = ""
            c.name = "\(s.name) Copy"
            c.keyword = nil
            if let saved = try? f.save(c) { selectedId = saved.id; currentHost?.toast("Duplicated", style: .success) }
        case "delete":
            let r = rows()
            let i = index(r)
            f.delete(s.id)
            let after = rows()
            selectedId = after.isEmpty ? nil : after[min(max(0, i), after.count - 1)].id
            currentHost?.toast("Snippet deleted", style: .info)
        default: break
        }
    }

    func handleKey(_ k: VimKey) -> Bool {
        if var p = panel {
            switch p.key(k) {
            case .none: panel = p
            case .close: panel = nil
            case let .run(a): run(a)
            }
            return true
        }
        if k.meta && !k.shift && !k.ctrl && !k.alt && k.key.lowercased() == "k" { openPanel(); return true }
        if (k.meta || k.ctrl) && !N2Keys.isVimControl(k) && k.key != "Enter" && !k.key.hasPrefix("Arrow") {
            if k.meta && k.key.lowercased() == "n" { run("new"); return true }
            if let s = selected, let a = actions(s).first(where: { N2Keys.matches($0, k) }) { run(a.id) }
            return true
        }
        return false
    }

    func handleCommand(_ c: VimCommand) -> Bool {
        let r = rows()
        let i = index(r)
        switch c {
        case .move, .goto, .halfPage, .section:
            let j = Vim.applyNav(c, index: i, shape: Vim.NavShape(length: r.count))
            selectedId = j >= 0 ? r[j].id : nil
        case let .activate(mods): run(mods.contains(.shift) ? "plain" : "paste")
        case .secondary, .copy: run("copy")
        case .paste: run("paste")
        case .actions: openPanel()
        case .delete:
            if let at = pendingDeleteAt, Date().timeIntervalSince(at) < 2 { pendingDeleteAt = nil; run("delete") }
            else { pendingDeleteAt = Date(); currentHost?.toast("Press x again to delete", style: .info) }
        default: return false
        }
        return true
    }

    func openPanel() {
        guard let s = selected else { return }
        panel = N2ActionPanelState(title: s.name, actions: actions(s))
    }

    func state() -> JSONValue {
        let r = rows()
        let i = index(r)
        return ["rows": .array(r.map { .string($0.name) }), "selected": .int(Int64(i)), "selectedId": i >= 0 ? .string(r[i].id) : .null, "query": .string(query),
                "panel": panel.map { ["open": true, "actions": .array($0.filtered.map { .string($0.title) })] } ?? ["open": false],
                "preview": i >= 0 ? .string(feature?.preview(text: r[i].text, html: r[i].html).text ?? "") : .null]
    }
}

struct SnipSearchView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: SnipSearchModel
    let changes: ClipChanges
    let query: String

    var body: some View {
        let _ = changes.version
        let rows = model.rows()
        let sel = model.index(rows)
        VStack(spacing: 0) {
            if rows.isEmpty {
                EmptyState(symbol: "text.quote", title: query.isEmpty ? "No snippets yet" : "No matching snippets", subtitle: "⌘N creates one")
                    .frame(maxHeight: .infinity)
            } else {
                DetailSplit(ratio: 0.4) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                ForEach(Array(rows.enumerated()), id: \.element.id) { i, s in
                                    HStack(spacing: 8) {
                                        ItemIconView(.symbol(s.html == nil ? "text.quote" : "textformat"), size: 22)
                                        Text(s.name).font(.system(size: 13)).foregroundStyle(theme.text).lineLimit(1)
                                        Spacer(minLength: 4)
                                        if let k = s.keyword, !k.isEmpty { Tag(SnipExpansion.effectiveKeyword(k, prefix: model.feature?.settings.keywordPrefix ?? ""), accent: true) }
                                    }
                                    .padding(.horizontal, 8)
                                    .frame(height: 36)
                                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(i == sel ? theme.selected : .clear))
                                    .id(s.id)
                                }
                            }
                            .padding(6)
                        }
                        .scrollIndicators(.never)
                        .onChange(of: sel) { _, i in if i >= 0, i < rows.count { proxy.scrollTo(rows[i].id) } }
                    }
                } detail: {
                    if sel >= 0 { SnipPreview(snippet: rows[sel], feature: model.feature) }
                }
            }
            N2HintBar(hints: [("↩", "paste"), ("⌘↩", "copy"), ("⌘E", "edit"), ("⌘N", "new"), ("⌃X", "delete")])
        }
        .overlay { N2PanelOverlay(panel: model.panel) }
        .onAppear { model.currentHost?.setPlaceholder("Search snippets…"); model.currentHost?.setFooter(primary: "Paste", hasActions: true) }
    }
}

struct SnipPreview: View {
    @Environment(\.glideTheme) private var theme
    let snippet: Snippet
    let feature: Snippets2Feature?

    var body: some View {
        let r = feature?.preview(text: snippet.text, html: snippet.html) ?? RenderedSnippet(text: snippet.text)
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                Text(r.text).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(theme.text).frame(maxWidth: .infinity, alignment: .topLeading).textSelection(.enabled)
            }
            .padding(12)
            Rectangle().fill(theme.border).frame(height: 1)
            VStack(spacing: 4) {
                row("Keyword", snippet.keyword.map { SnipExpansion.effectiveKeyword($0, prefix: feature?.settings.keywordPrefix ?? "") } ?? "—")
                row("Format", snippet.html == nil ? "Plain text" : "Rich text")
                if r.cursorLeft > 0 { row("Cursor", "\(r.cursorLeft) from the end") }
                if let ex = snippet.excludedApps, !ex.isEmpty { row("Not in", ex.joined(separator: ", ")) }
                row("Characters", "\(r.text.count)")
            }
            .padding(12)
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).font(.system(size: 11.5)).foregroundStyle(theme.text3)
            Spacer()
            Text(v).font(.system(size: 11.5)).foregroundStyle(theme.text2).lineLimit(1)
        }
    }
}
