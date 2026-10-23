import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// State of the Clipboard History view (list/grid ⌘G, filters ⌘P, marks, ⌘K panel, clear confirmation).
/// Works without the view ever rendering (headless key handling reads `host.query` / `LauncherHosts.current`).
@MainActor @Observable final class ClipHistoryModel {
    @ObservationIgnored weak var feature: ClipboardFeature?
    @ObservationIgnored weak var host: (any LauncherViewHost)?
    @ObservationIgnored private var nonce: String?
    @ObservationIgnored private var pendingDeleteAt: Date?
    var grid = false
    var filter: ClipFilter = .all
    var source: String?
    var selectedId: String?
    var marked: [String] = []
    var panel: N2ActionPanelState?
    var menu: Menu?
    var confirmClear = false
    static let columns = 5

    struct MenuOption: Equatable {
        var title: String
        var symbol: String
        var filter: ClipFilter?
        var source: String??
    }
    struct Menu: Equatable {
        var options: [MenuOption]
        var selected = 0
    }

    init(feature: ClipboardFeature) { self.feature = feature }

    /// Called when the view is pushed (`run` → pushView) and on every render (no-op for the same push).
    func prepare(payload: JSONValue, host: (any LauncherViewHost)?) {
        if let host { self.host = host }
        let n = payload["nonce"]?.stringValue
        guard n == nil || n != nonce else { return }
        nonce = n
        grid = feature?.settings.viewMode == "grid"
        filter = .all
        source = nil
        marked = []
        panel = nil
        menu = nil
        confirmClear = payload["confirmClear"]?.boolValue == true
        selectedId = payload["selectId"]?.stringValue
        pendingDeleteAt = nil
        updateFooter()
    }

    var currentHost: (any LauncherViewHost)? { host ?? LauncherHosts.current }
    var query: String { currentHost?.query ?? "" }

    func rows() -> [ClipEntry] {
        guard let f = feature else { return [] }
        return ClipModel.filter(f.entries, query: query, filter: filter, source: source, hay: f.hay)
    }

    func selectedIndex(in rows: [ClipEntry]) -> Int {
        guard !rows.isEmpty else { return -1 }
        return rows.firstIndex { $0.id == selectedId } ?? 0
    }

    var selected: ClipEntry? {
        let r = rows()
        let i = selectedIndex(in: r)
        return i >= 0 ? r[i] : nil
    }

    private func select(_ i: Int, _ rows: [ClipEntry]) {
        guard !rows.isEmpty else { selectedId = nil; return }
        selectedId = rows[min(rows.count - 1, max(0, i))].id
        updateFooter()
    }

    func updateFooter() {
        let s = selected
        currentHost?.setFooter(primary: s == nil ? nil : "Paste", hasActions: s != nil)
    }

    // MARK: actions

    func actions(for e: ClipEntry) -> [ItemAction] {
        var a = [ItemAction(id: "paste", title: "Paste", shortcut: "↩", icon: "doc.on.clipboard"),
                 ItemAction(id: "copy", title: "Copy to Clipboard", shortcut: "⌘↩", icon: "doc.on.doc"),
                 ItemAction(id: "plain", title: e.type == .file ? "Paste Paths as Text" : "Paste as Plain Text", shortcut: "⇧⌘↩", icon: "textformat")]
        if e.type != .image && e.type != .file { a.append(ItemAction(id: "edit", title: "Edit and Paste…", shortcut: "⌘E", icon: "pencil")) }
        if e.type == .link {
            a.append(ItemAction(id: "open-link", title: "Open Link", shortcut: "⌘O", icon: "safari"))
            a.append(ItemAction(id: "md-link", title: "Copy as Markdown Link", shortcut: "⇧⌘L", icon: "link"))
        }
        if e.type == .file { a.append(ItemAction(id: "reveal", title: "Reveal in Finder", shortcut: "⌘O", icon: "folder")) }
        if e.type != .image { a.append(ItemAction(id: "snippet", title: "Save as Snippet", shortcut: "⇧⌘S", icon: "text.quote")) }
        if marked.count >= 2 { a.append(ItemAction(id: "merge", title: "Merge \(marked.count) Selected Entries", shortcut: "⇧⌘M", icon: "arrow.triangle.merge")) }
        a.append(ItemAction(id: "stack-add", title: marked.isEmpty ? "Add to Paste Stack" : "Add \(marked.count) Selected to Paste Stack", shortcut: "⇧⌘A", icon: "square.stack.3d.down.right"))
        a.append(ItemAction(id: "stack-open", title: "Open Paste Stack", shortcut: "⇧⌘V", icon: "square.stack.3d.up"))
        a.append(ItemAction(id: "pin", title: e.pinned ? "Unpin" : "Pin", shortcut: "⌘.", icon: e.pinned ? "pin.slash" : "pin"))
        a.append(ItemAction(id: "mode", title: grid ? "Show as List" : "Show as Grid", shortcut: "⌘G", icon: grid ? "list.bullet" : "square.grid.3x3"))
        a.append(ItemAction(id: "filter", title: "Filter by Type or App…", shortcut: "⌘P", icon: "line.3.horizontal.decrease.circle"))
        let paused = feature?.settings.isPaused(now: feature?.now ?? 0) ?? false
        a.append(paused ? ItemAction(id: "resume", title: "Resume Clipboard History", icon: "play") : ItemAction(id: "pause5", title: "Pause for 5 Minutes", shortcut: "⇧⌘P", icon: "timer"))
        if e.source?.bundleId != nil { a.append(ItemAction(id: "ignore", title: "Ignore Copies from \(e.source?.name ?? "This App")", icon: "hand.raised")) }
        a.append(ItemAction(id: "delete", title: marked.count > 1 ? "Delete \(marked.count) Selected" : "Delete Entry", shortcut: "⌃X", icon: "trash", destructive: true))
        a.append(ItemAction(id: "delete-all", title: "Clear Unpinned…", shortcut: "⌃⇧X", icon: "trash.slash", destructive: true))
        return a
    }

    func run(_ action: String) {
        guard let f = feature else { return }
        panel = nil
        if action == "mode" { toggleGrid(); return }
        if action == "filter" { openMenu(); return }
        if action == "delete-all" { confirmClear = true; return }
        guard let e = selected else { return }
        let r: ActionResult
        switch action {
        case "paste": r = f.pasteEntry(e, plain: false)
        case "plain": r = f.pasteEntry(e, plain: true)
        case "copy": r = f.copyEntry(e)
        case "edit": r = .pushView("clipboard.edit", payload: ClipboardFeature.freshPayload(["id": .string(e.id)]))
        case "open-link":
            guard let url = URL(string: ClipModel.linkHref(e.text ?? "")) else { return }
            let o = f.context?.services.workspace.open(url: url, withApp: nil)
            r = o?.ok == true ? .hide(message: nil) : .error(o?.error ?? "Could not open the link")
        case "md-link":
            let md = ClipModel.markdownLink(e.text ?? "")
            f.watcher?.write(.init(text: md))
            r = .stay(message: "Copied Markdown link")
        case "reveal":
            if let p = e.files?.first { f.context?.services.workspace.reveal(path: p) }
            r = .hide(message: nil)
        case "snippet": r = f.saveAsSnippet(e.id)
        case "merge":
            guard let m = f.merge(marked) else { r = .error("Nothing to merge (images cannot be merged)"); break }
            f.putOnClipboard(m, plain: false)
            marked = []
            selectedId = m.id
            r = .stay(message: "Merged and copied")
        case "stack-add":
            let ids = marked.isEmpty ? [e.id] : rows().map(\.id).filter { marked.contains($0) }
            f.stackAdd(ids)
            marked = []
            r = .stay(message: "Paste Stack: \(f.stack.items.count) waiting — ⌘V pastes them in order")
        case "stack-open": r = .pushView("clipboard.stack", payload: ClipboardFeature.freshPayload())
        case "pin": r = .stay(message: f.togglePin(e.id) ? "Pinned" : "Unpinned")
        case "pause5": r = f.pauseFor(minutes: 5)
        case "resume": r = f.setPaused(false)
        case "ignore": r = f.ignoreSourceApp(e.id)
        case "delete":
            let ids = marked.count > 1 ? marked : [e.id]
            let rowsBefore = rows()
            let i = selectedIndex(in: rowsBefore)
            let n = f.delete(ids)
            marked = []
            select(i, rows())
            r = .stay(message: n == 1 ? "Entry deleted" : "Deleted \(n) entries")
        default: return
        }
        n2Apply(r, host: currentHost, context: f.context)
        updateFooter()
    }

    func toggleGrid() {
        grid.toggle()
        feature?.patchSettings(["viewMode": .string(grid ? "grid" : "list")])
    }

    func openMenu() {
        var opts = ClipFilter.menu.map { MenuOption(title: $0.label, symbol: $0 == .pinned ? "pin" : $0 == .all ? "tray.full" : ($0.typeValue?.symbol ?? "circle"), filter: $0, source: nil) }
        let apps = ClipModel.sourceApps(feature?.entries ?? []).prefix(8)
        if !apps.isEmpty {
            opts.append(MenuOption(title: "All Apps", symbol: "app.dashed", filter: nil, source: .some(nil)))
            for a in apps { opts.append(MenuOption(title: "\(a.name) (\(a.count))", symbol: "app", filter: nil, source: .some(a.key))) }
        }
        let current = opts.firstIndex { $0.filter == filter } ?? 0
        menu = Menu(options: opts, selected: current)
    }

    // MARK: keys

    func handleKey(_ k: VimKey) -> Bool {
        let plain = !k.meta && !k.ctrl && !k.alt
        if confirmClear {
            if k.key == "Enter" {
                let n = feature?.clearHistory(keepPinned: true) ?? 0
                confirmClear = false
                currentHost?.toast("Deleted \(n) \(n == 1 ? "entry" : "entries")", style: .info)
            } else if k.key == "Escape" || (k.key.lowercased() == "n" && plain) {
                confirmClear = false
            }
            return true
        }
        if var p = panel {
            switch p.key(k) {
            case .none: panel = p
            case .close: panel = nil
            case let .run(a): run(a)
            }
            return true
        }
        if var m = menu {
            switch k.key {
            case "ArrowDown": m.selected = min(m.options.count - 1, m.selected + 1); menu = m
            case "ArrowUp": m.selected = max(0, m.selected - 1); menu = m
            case "Enter":
                let o = m.options[m.selected]
                if let f = o.filter { filter = f }
                if let s = o.source { source = s }
                menu = nil
                selectedId = nil
                updateFooter()
            case "Escape": menu = nil
            default:
                if k.ctrl && ["j", "n"].contains(k.key.lowercased()) { m.selected = min(m.options.count - 1, m.selected + 1); menu = m }
                else if k.ctrl && ["k", "p"].contains(k.key.lowercased()) { m.selected = max(0, m.selected - 1); menu = m }
                else if (k.meta && k.key.lowercased() == "p") { menu = nil }
            }
            return true
        }
        let rows = rows()
        let i = selectedIndex(in: rows)
        if k.meta && !k.shift && !k.ctrl && !k.alt && k.key.lowercased() == "k" { openPanel(); return true }
        if k.meta && !k.shift && k.key.lowercased() == "g" { toggleGrid(); return true }
        if k.meta && !k.shift && k.key.lowercased() == "p" { openMenu(); return true }
        if grid && plain && !k.shift && query.isEmpty && (k.key == "ArrowLeft" || k.key == "ArrowRight") {
            select(i + (k.key == "ArrowLeft" ? -1 : 1), rows)
            return true
        }
        if plain && !k.shift && k.key == " " && query.isEmpty, let s = i >= 0 ? rows[i] : nil {
            toggleMark(s.id)
            return true
        }
        if !k.meta && !k.ctrl && !k.alt && k.shift && (k.key == "ArrowDown" || k.key == "ArrowUp"), i >= 0 {
            let step = (k.key == "ArrowDown" ? 1 : -1) * (grid ? Self.columns : 1)
            if !marked.contains(rows[i].id) { marked.append(rows[i].id) }
            let j = min(rows.count - 1, max(0, i + step))
            if !marked.contains(rows[j].id) { marked.append(rows[j].id) }
            select(j, rows)
            return true
        }
        if k.key == "Escape" && plain && !marked.isEmpty { marked = []; return true }
        if (k.meta || k.ctrl) && !N2Keys.isVimControl(k) && k.key != "Enter" && !k.key.hasPrefix("Arrow") {
            if let e = i >= 0 ? rows[i] : nil, let a = actions(for: e).first(where: { N2Keys.matches($0, k) }) {
                run(a.id)
            } else if k.ctrl && k.shift && k.key.lowercased() == "x" {
                confirmClear = true
            }
            // Never let a shortcut fall through to the root list's selected item.
            return true
        }
        return false
    }

    func handleCommand(_ c: VimCommand) -> Bool {
        let rows = rows()
        let i = selectedIndex(in: rows)
        switch c {
        case let .move(d):
            select(i + d * (grid ? Self.columns : 1), rows)
        case .goto, .halfPage, .section:
            select(Vim.applyNav(c, index: i, shape: Vim.NavShape(length: rows.count, halfPage: grid ? Self.columns * 2 : 5)), rows)
        case let .activate(mods): run(mods.contains(.shift) ? "plain" : "paste")
        case .secondary: run("copy")
        case .actions: openPanel()
        case .copy: run("copy")
        case .paste: run("paste")
        case .delete:
            if let at = pendingDeleteAt, Date().timeIntervalSince(at) < 2 {
                pendingDeleteAt = nil
                run("delete")
            } else {
                pendingDeleteAt = Date()
                currentHost?.toast("Press x again to delete", style: .info)
            }
        default: return false
        }
        return true
    }

    func openPanel() {
        guard let e = selected else { return }
        panel = N2ActionPanelState(title: ClipModel.title(e), actions: actions(for: e))
    }

    func toggleMark(_ id: String) {
        if let j = marked.firstIndex(of: id) { marked.remove(at: j) } else { marked.append(id) }
    }

    func state() -> JSONValue {
        let r = rows()
        let sel = selectedIndex(in: r)
        var o: [String: JSONValue] = [
            "rows": .array(r.map { .string(ClipModel.title($0)) }), "ids": .array(r.map { .string($0.id) }), "types": .array(r.map { .string($0.type.rawValue) }),
            "selected": .int(Int64(sel)), "selectedId": sel >= 0 ? .string(r[sel].id) : .null, "grid": .bool(grid), "filter": .string(filter.raw),
            "source": source.map(JSONValue.string) ?? .null, "marked": .int(Int64(marked.count)), "confirmClear": .bool(confirmClear), "query": .string(query),
        ]
        o["panel"] = panel.map { ["open": true, "actions": .array($0.filtered.map { .string($0.title) }), "selected": .int(Int64($0.selected)), "filter": .string($0.filter)] } ?? ["open": false]
        o["menu"] = menu.map { ["open": true, "options": .array($0.options.map { .string($0.title) }), "selected": .int(Int64($0.selected))] } ?? ["open": false]
        return .object(o)
    }
}

extension ClipFilter {
    var typeValue: ClipType? { if case let .type(t) = self { return t }; return nil }
}

// MARK: - views

struct ClipHistoryView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: ClipHistoryModel
    let changes: ClipChanges
    let query: String

    var body: some View {
        let _ = changes.version
        let rows = model.rows()
        let sel = model.selectedIndex(in: rows)
        VStack(spacing: 0) {
            header(count: rows.count)
            if rows.isEmpty {
                EmptyState(symbol: "clipboard", title: query.isEmpty && model.filter == .all ? "Nothing copied yet" : "No matching entries",
                           subtitle: model.feature?.settings.isPaused(now: model.feature?.now ?? 0) == true ? "Clipboard history is paused" : "Copy something and it shows up here")
                    .frame(maxHeight: .infinity)
            } else if model.grid {
                ClipGrid(rows: rows, selected: sel, marked: model.marked, feature: model.feature)
            } else {
                DetailSplit(ratio: 0.42) {
                    ClipList(rows: rows, selected: sel, marked: model.marked)
                } detail: {
                    if sel >= 0 { ClipDetail(entry: rows[sel], feature: model.feature) }
                }
            }
            N2HintBar(hints: [("Space", "select"), ("⇧⌘M", "merge"), ("⌘.", "pin"), ("⌘E", "edit"), ("⌃X", "delete"), ("⌘G", model.grid ? "list" : "grid"), ("⌘P", "filter")])
        }
        .overlay { N2PanelOverlay(panel: model.panel) }
        .overlay(alignment: .topTrailing) { if let m = model.menu { ClipFilterMenu(menu: m).padding(.top, 34).padding(.trailing, 10) } }
        .overlay { if model.confirmClear { ClipConfirm() } }
        .onAppear { model.updateFooter(); model.host?.setPlaceholder("Search clipboard history…") }
    }

    private func header(count: Int) -> some View {
        HStack(spacing: 8) {
            Text(model.filter == .all ? "Clipboard History" : model.filter.label).font(theme.sectionFont).foregroundStyle(theme.text3)
            Text("\(count)").font(.system(size: 11)).foregroundStyle(theme.text3)
            if let n = model.feature?.stack.items.count, n > 0 { Tag("Paste Stack · \(n)", accent: true) }
            if model.feature?.settings.isPaused(now: model.feature?.now ?? 0) == true { Tag("Paused") }
            Spacer()
            if let s = model.source { Tag(ClipModel.sourceApps(model.feature?.entries ?? []).first { $0.key == s }?.name ?? "App") }
            HStack(spacing: 4) { Text(model.grid ? "Grid" : "List").font(.system(size: 11)).foregroundStyle(theme.text3); Kbd("⌘G") }
            HStack(spacing: 4) { Text(model.filter.label).font(.system(size: 11)).foregroundStyle(theme.text3); Kbd("⌘P") }
        }
        .padding(.horizontal, 12)
        .frame(height: 30)
    }
}

struct ClipList: View {
    @Environment(\.glideTheme) private var theme
    let rows: [ClipEntry]
    let selected: Int
    let marked: [String]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in
                        ClipRow(entry: e, selected: i == selected, marked: marked.contains(e.id)).id(e.id)
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
            }
            .scrollIndicators(.never)
            .onChange(of: selected) { _, i in if i >= 0, i < rows.count { proxy.scrollTo(rows[i].id) } }
        }
    }
}

struct ClipRow: View {
    @Environment(\.glideTheme) private var theme
    let entry: ClipEntry
    let selected: Bool
    let marked: Bool

    var body: some View {
        HStack(spacing: 8) {
            ClipIcon(entry: entry, size: 22)
            Text(ClipModel.title(entry)).font(.system(size: 13)).foregroundStyle(theme.text).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            if entry.html != nil { Image(systemName: "textformat").font(.system(size: 10)).foregroundStyle(theme.text3) }
            if entry.pinned { Image(systemName: "pin.fill").font(.system(size: 10)).foregroundStyle(theme.accent) }
            if marked { Image(systemName: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(theme.accent) }
        }
        .padding(.horizontal, 8)
        .frame(height: 36)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(selected ? theme.selected : marked ? theme.accentSoft.opacity(0.5) : .clear))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct ClipIcon: View {
    @Environment(\.glideTheme) private var theme
    let entry: ClipEntry
    let size: CGFloat
    var body: some View {
        if entry.type == .color, let c = RGBA(hex: (entry.text ?? "").trimmingCharacters(in: .whitespaces)) {
            RoundedRectangle(cornerRadius: size * 0.25, style: .continuous).fill(Color(c)).frame(width: size, height: size)
                .overlay(RoundedRectangle(cornerRadius: size * 0.25).strokeBorder(theme.border, lineWidth: 1))
        } else if let app = entry.source?.bundleId.flatMap({ NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0)?.path }), entry.type == .text {
            ItemIconView(.app(app), size: size)
        } else {
            ItemIconView(.symbol(entry.type.symbol), size: size)
        }
    }
}

struct ClipThumb: View {
    @Environment(\.glideTheme) private var theme
    let entry: ClipEntry
    let feature: ClipboardFeature?
    var full = false
    var body: some View {
        if let img = entry.image, let st = feature?.storage,
           let url = full ? st.imageURL(img.sha1) : st.ensureThumb(img.sha1), let ns = NSImage(contentsOf: url) {
            Image(nsImage: ns).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
        } else {
            Image(systemName: "photo").font(.system(size: 24, weight: .light)).foregroundStyle(theme.text3)
        }
    }
}

struct ClipDetail: View {
    @Environment(\.glideTheme) private var theme
    let entry: ClipEntry
    let feature: ClipboardFeature?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(12)
            Rectangle().fill(theme.border).frame(height: 1)
            VStack(spacing: 4) {
                meta("Source", entry.source?.name ?? "Unknown")
                meta("Content type", entry.type.label.hasSuffix("s") && entry.type != .text ? String(entry.type.label.dropLast()) : entry.type.label)
                if let i = entry.image { meta("Dimensions", "\(i.width)×\(i.height) · \(ByteCountFormatter.string(fromByteCount: Int64(i.bytes), countStyle: .file))") }
                else if entry.type != .file { meta("Characters", "\((entry.text ?? "").count) · \(ClipModel.countWords(entry.text ?? "")) words") }
                if entry.type == .link, let d = ClipModel.linkDomain(entry.text ?? "") { meta("Domain", d) }
                meta("Times copied", "\(entry.count)")
                meta("Last copied", ClipModel.relative(entry.lastCopiedAt, now: feature?.now ?? entry.lastCopiedAt))
                meta("First copied", ClipModel.relative(entry.createdAt, now: feature?.now ?? entry.createdAt))
            }
            .padding(12)
        }
    }

    @ViewBuilder private var content: some View {
        switch entry.type {
        case .image:
            VStack(alignment: .leading, spacing: 8) {
                ClipThumb(entry: entry, feature: feature, full: true).frame(maxWidth: .infinity, maxHeight: 180)
                if let o = entry.ocrText, !o.isEmpty {
                    Text(o).font(.system(size: 11)).foregroundStyle(theme.text2).lineLimit(6)
                }
            }
        case .color:
            VStack(alignment: .leading, spacing: 10) {
                ClipIcon(entry: entry, size: 96)
                Text(entry.text ?? "").font(.system(size: 15, weight: .medium, design: .monospaced)).foregroundStyle(theme.text).textSelection(.enabled)
            }
        case .file:
            VStack(alignment: .leading, spacing: 6) {
                ForEach(entry.files ?? [], id: \.self) { p in
                    HStack(spacing: 8) {
                        ItemIconView(.file(p), size: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text((p as NSString).lastPathComponent).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text).lineLimit(1)
                            Text(p).font(.system(size: 11)).foregroundStyle(theme.text3).lineLimit(1).truncationMode(.middle)
                        }
                    }
                }
            }
        default:
            ScrollView {
                Text(String((entry.text ?? "").prefix(20_000))).font(.system(size: 12.5, design: entry.type == .link ? .default : .monospaced))
                    .foregroundStyle(entry.type == .link ? theme.accentText : theme.text).frame(maxWidth: .infinity, alignment: .topLeading).textSelection(.enabled)
            }
        }
    }

    private func meta(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).font(.system(size: 11.5)).foregroundStyle(theme.text3)
            Spacer()
            Text(v).font(.system(size: 11.5)).foregroundStyle(theme.text2).lineLimit(1)
        }
    }
}

struct ClipGrid: View {
    @Environment(\.glideTheme) private var theme
    let rows: [ClipEntry]
    let selected: Int
    let marked: [String]
    let feature: ClipboardFeature?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: ClipHistoryModel.columns), spacing: 8) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in
                        VStack(spacing: 4) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(theme.surface)
                                tile(e).padding(6)
                            }
                            .frame(height: 96)
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(i == selected ? theme.accent : marked.contains(e.id) ? theme.accentSoft : theme.border, lineWidth: i == selected ? 2 : 1))
                            Text(ClipModel.title(e)).font(.system(size: 10.5)).foregroundStyle(theme.text2).lineLimit(1)
                        }
                        .id(e.id)
                    }
                }
                .padding(10)
            }
            .onChange(of: selected) { _, i in if i >= 0, i < rows.count { proxy.scrollTo(rows[i].id) } }
        }
    }

    @ViewBuilder private func tile(_ e: ClipEntry) -> some View {
        switch e.type {
        case .image: ClipThumb(entry: e, feature: feature)
        case .color: ClipIcon(entry: e, size: 56)
        case .file: ItemIconView(.file(e.files?.first ?? "/"), size: 48)
        default: Text(String((e.text ?? "").prefix(160))).font(.system(size: 9.5, design: .monospaced)).foregroundStyle(theme.text2).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

struct ClipFilterMenu: View {
    @Environment(\.glideTheme) private var theme
    let menu: ClipHistoryModel.Menu
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(menu.options.enumerated()), id: \.offset) { i, o in
                HStack(spacing: 8) {
                    Image(systemName: o.symbol).font(.system(size: 12)).frame(width: 18).foregroundStyle(theme.text2)
                    Text(o.title).font(.system(size: 12.5)).foregroundStyle(theme.text)
                    Spacer()
                }
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(RoundedRectangle(cornerRadius: 6).fill(i == menu.selected ? theme.selected : .clear))
            }
        }
        .padding(6)
        .frame(width: 220)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.panelSolid))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.borderStrong, lineWidth: 1))
        .shadow(color: .black.opacity(0.3), radius: 14, y: 6)
    }
}

struct ClipConfirm: View {
    @Environment(\.glideTheme) private var theme
    var body: some View {
        ZStack {
            Color.black.opacity(0.25)
            VStack(spacing: 10) {
                Image(systemName: "trash").font(.system(size: 22)).foregroundStyle(theme.danger)
                Text("Clear clipboard history?").font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.text)
                Text("Pinned entries are kept.").font(.system(size: 12)).foregroundStyle(theme.text3)
                HStack(spacing: 14) {
                    HStack(spacing: 4) { Kbd("↩"); Text("Delete").font(.system(size: 12)).foregroundStyle(theme.text2) }
                    HStack(spacing: 4) { Kbd("Esc"); Text("Cancel").font(.system(size: 12)).foregroundStyle(theme.text2) }
                }
            }
            .padding(20)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.panelSolid))
        }
    }
}
