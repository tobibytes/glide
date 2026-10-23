import AppKit
import GlideCore
import GlideUI
import Observation
import SwiftUI

/// Observable notes data shared by the search view and the floating panel.
@MainActor @Observable final class NotesStore {
    var file = NotesFile()
    var current: Note? { file.notes.first { $0.id == file.currentId } }
}

/// Floating Notes (src/main/features/notes): an always-on-top note panel with a markdown-aware editor,
/// "Search Notes" (launcher view with a rendered markdown preview) and "New Note". Same notes.json as Electron.
@MainActor public final class NotesFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "notes"
    public let title = "Floating Notes"
    private weak var context: FeatureContext?
    let store = NotesStore()
    var now: N7Now = n7SystemNow
    private var writeTask: Task<Void, Never>?
    private var panel: NotesPanelController?
    /// Headless: what the panel would have done (never shown).
    public private(set) var panelEvents: [String] = []
    lazy var searchModel = N7ListModel(placeholder: "Search notes…", emptyTitle: "No notes yet",
                                       emptySubtitle: "Type something and press ⏎ to create one") { [weak self] q in self?.searchRows(q) ?? [] }

    public init() {}

    var file: URL? { context?.dataDirectory().appendingPathComponent("notes.json") }
    public var data: NotesFile { store.file }

    public func start(context: FeatureContext) async {
        self.context = context
        store.file = NotesModel.sanitize(file.flatMap(N7JSON.read))
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.writeNow() }
        }
    }

    public func stop() async { writeNow() }

    func writeNow() {
        writeTask?.cancel()
        writeTask = nil
        if let file { N7JSON.write(store.file, to: file, pretty: true) }
    }

    private func persist() {
        writeTask?.cancel()
        writeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            self?.writeNow()
        }
    }

    func changed() {
        persist()
        context?.refreshCatalogue()
        searchModel.changed()
    }

    // MARK: operations (the methods of the Electron feature)

    @discardableResult func ensureNote() -> Note {
        if let c = store.current { return c }
        if let first = store.file.notes.first {
            store.file.currentId = first.id
            return first
        }
        return create()
    }

    @discardableResult func create(body: String = "") -> Note {
        let n = NotesModel.newNote(now: now(), body: body)
        store.file = NotesModel.add(store.file, n)
        changed()
        return n
    }

    @discardableResult func save(id: String, body: String) -> Bool {
        guard store.file.notes.contains(where: { $0.id == id }) else { return false }
        store.file = NotesModel.update(store.file, id: id, body: body, now: now())
        changed()
        return true
    }

    func remove(id: String) {
        store.file = NotesModel.delete(store.file, id: id)
        if store.file.notes.isEmpty, panel?.isVisible == true { create() }
        changed()
    }

    @discardableResult func select(id: String) -> Note {
        if store.file.notes.contains(where: { $0.id == id }) { store.file.currentId = id }
        changed()
        return ensureNote()
    }

    @discardableResult func cycle(_ delta: Int) -> Note {
        if let id = NotesModel.cycle(store.file, delta: delta) { store.file.currentId = id }
        changed()
        return ensureNote()
    }

    func setBounds(_ b: NoteBounds) {
        store.file.bounds = b
        persist()
    }

    /// Show the floating panel on a note (never on screen in headless runs).
    func show(noteId: String? = nil) {
        ensureNote()
        if let noteId, store.file.notes.contains(where: { $0.id == noteId }) { store.file.currentId = noteId }
        changed()
        if context?.services.isHeadless ?? true {
            panelEvents.append("show:\(store.file.currentId ?? "")")
            return
        }
        if panel == nil { panel = NotesPanelController(feature: self) }
        panel?.show()
    }

    func hidePanel() {
        if context?.services.isHeadless ?? true { panelEvents.append("hide"); return }
        panel?.hide()
    }

    func toggle() {
        if let p = panel, p.isVisible, p.isKey {
            hidePanel()
            return
        }
        context?.hideLauncher()
        show()
    }

    // MARK: catalogue

    private func item(_ action: String, _ title: String, _ subtitle: String, _ symbol: String, _ keywords: [String], argument: Bool = false) -> SearchItem {
        SearchItem(id: "notes:\(action)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol, tint: "#FFD60A"), keywords: keywords,
                   acceptsArgument: argument ? true : nil, feature: id, data: ["action": .string(action)], kindLabel: "Notes")
    }

    public func items() -> [SearchItem] {
        let n = store.file.notes.count
        return [item("toggle", "Toggle Floating Notes", "Floating Notes", "note.text", ["notes", "sticky", "scratchpad", "float"]),
                item("new", "New Note", "Floating Notes", "square.and.pencil", ["notes", "create", "sticky"], argument: true),
                item("search", "Search Notes", "\(n) note\(n == 1 ? "" : "s")", "magnifyingglass", ["notes", "find", "floating"], argument: true)] // fix round: Tab → query
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "toggle": return [ItemAction(id: "toggle", title: "Toggle Floating Notes", shortcut: "↩", icon: "note.text")]
        case "new": return [ItemAction(id: "new", title: "Create Note", shortcut: "↩", icon: "square.and.pencil")]
        default: return [ItemAction(id: "search", title: "Search Notes", shortcut: "↩", icon: "magnifyingglass")]
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        switch action {
        case "toggle":
            toggle()
            return .hide()
        case "new":
            let n = create(body: scored.argument ?? "")
            context?.hideLauncher()
            show(noteId: n.id)
            return .hide()
        case "search":
            n7AfterUpdate { [weak self] in self?.searchModel.syncHost() }
            return .pushView(ViewID(feature: id, name: "search"), payload: scored.argument.map { ["query": .string($0)] } ?? .null) // fix round
        default: return .error("Unknown action \(action)")
        }
    }

    // MARK: search view

    func searchRows(_ query: String) -> [N7Row] {
        let t = now()
        var rows: [N7Row] = NotesModel.search(store.file.notes, query).map { n in
            let s = NotesModel.summarize(n)
            return N7Row(id: n.id, section: "Notes", icon: .symbol("note.text", tint: "#FFD60A"), title: s.title, subtitle: s.preview,
                         trailing: N7Format.relative(n.updatedAt, now: t), actions: [
                             N7Action("open", "Open in Floating Notes", shortcut: "↩", icon: "macwindow.on.rectangle") { [weak self] in
                                 self?.context?.hideLauncher()
                                 self?.show(noteId: n.id)
                             },
                             N7Action("copy", "Copy Note Text", shortcut: "⌘↩", icon: "doc.on.doc") { [weak self] in
                                 self?.context?.services.pasteboard.setString(n.body, html: nil, transient: false)
                                 LauncherHosts.current?.toast("Copied", style: .success)
                             },
                             N7Action("paste", "Paste Note Text", shortcut: "⇧⌘V", icon: "doc.on.clipboard") { [weak self] in
                                 self?.context?.hideLauncher()
                                 self?.context?.services.paste.paste(text: n.body, html: nil)
                             },
                             N7Action("delete", "Delete Note", shortcut: "⌃X", icon: "trash", destructive: true) { [weak self] in
                                 self?.remove(id: n.id)
                                 LauncherHosts.current?.toast("Note deleted", style: .info)
                             },
                         ], detail: { AnyView(NoteMarkdownPreview(note: n, now: t)) })
        }
        let text = query.trimmingCharacters(in: .whitespaces)
        if !text.isEmpty {
            rows.append(N7Row(id: "__create", section: "Create", icon: .symbol("square.and.pencil", tint: "#FFD60A"), title: "Create Note “\(text)”",
                              actions: [N7Action("create", "Create Note", shortcut: "↩", icon: "square.and.pencil") { [weak self] in
                                  guard let self else { return }
                                  let n = self.create(body: text)
                                  self.context?.hideLauncher()
                                  self.show(noteId: n.id)
                              }], detail: { AnyView(Text("Creates a new note with “\(text)” and opens it.").foregroundStyle(.secondary)) }))
        }
        return rows
    }

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard id.name == "search" else { return nil }
        n7AfterUpdate { [weak self] in self?.searchModel.syncHost() }
        return AnyView(N7ListView(model: searchModel))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { view.name == "search" && searchModel.handleKey(key) }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { view.name == "search" && searchModel.handle(command) }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Floating Notes", symbol: "note.text", order: 110) { [weak self] in
            AnyView(Form {
                Section("Floating Notes") {
                    LabeledContent("Notes", value: "\(self?.store.file.notes.count ?? 0)")
                    N7SettingsNote(text: "The panel stays above other windows. ⌘N new note · ⌘[ ⌘] switch · ⌘K find · ⌘⌫ delete · ⎋ hide. Markdown headings, lists, checkboxes, **bold**, *italic* and `code` are styled as you type.")
                }
            }.formStyle(.grouped))
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        let idArg = args["id"]?.stringValue ?? args.stringValue
        switch method {
        case "state": return ["notes": N7JSON.value(store.file.notes.map(NotesModel.summarize)), "currentId": store.file.currentId.map(JSONValue.string) ?? .null]
        case "get": return N7JSON.value(idArg.flatMap { i in store.file.notes.first { $0.id == i } } ?? store.current)
        case "current": return N7JSON.value(ensureNote())
        case "create": return N7JSON.value(create(body: args["body"]?.stringValue ?? args["text"]?.stringValue ?? ""))
        case "save": return .bool(save(id: idArg ?? "", body: args["body"]?.stringValue ?? args["text"]?.stringValue ?? ""))
        case "remove":
            // Contract (n5.md): bool — whether the note existed.
            let existed = store.file.notes.contains { $0.id == idArg }
            remove(id: idArg ?? "")
            return .bool(existed)
        case "select": return N7JSON.value(select(id: idArg ?? ""))
        case "cycle": return N7JSON.value(cycle(args["delta"]?.intValue ?? args.intValue ?? 1))
        case "search": return N7JSON.value(NotesModel.search(store.file.notes, args["query"]?.stringValue ?? args.stringValue ?? "").map(NotesModel.summarize))
        case "open":
            context?.hideLauncher()
            show(noteId: idArg)
            return true
        case "hide":
            hidePanel()
            return true
        case "flush":
            writeNow()
            return true
        case "panelEvents": return .array(panelEvents.map(JSONValue.string))
        case "viewState": return searchModel.snapshot()
        case "viewAction": return .bool(await searchModel.run(actionId: args["id"]?.stringValue ?? ""))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

/// Rendered markdown (headings, lists, emphasis, code) for the search detail pane.
struct NoteMarkdownPreview: View {
    @Environment(\.glideTheme) private var theme
    let note: Note
    let now: Double
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(note.body.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                NotesMarkdown.lineView(line, theme: theme)
            }
            Divider().padding(.vertical, 4)
            Text("Edited \(N7Format.relative(note.updatedAt, now: now)) · \(note.body.count) chars · \(NotesModel.wordCount(note.body)) words")
                .font(.system(size: 11)).foregroundStyle(theme.text3)
        }
    }
}

enum NotesMarkdown {
    /// Inline markdown (bold, italic, code, links) via AttributedString.
    static func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    @MainActor @ViewBuilder static func lineView(_ raw: String, theme: GlideTheme) -> some View {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("#") {
            let level = line.prefix { $0 == "#" }.count
            let text = String(line.dropFirst(level)).trimmingCharacters(in: .whitespaces)
            Text(inline(text)).font(.system(size: level == 1 ? 18 : level == 2 ? 15.5 : 13.5, weight: .bold)).foregroundStyle(theme.text)
        } else if line.hasPrefix("- [ ] ") || line.hasPrefix("- [x] ") || line.hasPrefix("* [ ] ") || line.hasPrefix("* [x] ") {
            let done = line.dropFirst(3).hasPrefix("x")
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: done ? "checkmark.square.fill" : "square").foregroundStyle(done ? theme.accent : theme.text3)
                Text(inline(String(line.dropFirst(6)))).strikethrough(done).foregroundStyle(done ? theme.text3 : theme.text)
            }.font(.system(size: 13))
        } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("•").foregroundStyle(theme.text3)
                Text(inline(String(line.dropFirst(2)))).foregroundStyle(theme.text)
            }.font(.system(size: 13))
        } else if line.hasPrefix("> ") {
            Text(inline(String(line.dropFirst(2)))).font(.system(size: 13).italic()).foregroundStyle(theme.text2)
                .padding(.leading, 8).overlay(alignment: .leading) { Rectangle().fill(theme.accent).frame(width: 2) }
        } else if line.isEmpty {
            Color.clear.frame(height: 4)
        } else {
            Text(inline(raw)).font(.system(size: 13)).foregroundStyle(theme.text).textSelection(.enabled)
        }
    }

    /// Styles markdown in the editor's text storage (headings, list markers, checkboxes, emphasis, code).
    static func highlight(_ storage: NSTextStorage, baseFont: NSFont, text: NSColor, faint: NSColor, accent: NSColor) {
        let s = storage.string as NSString
        let full = NSRange(location: 0, length: s.length)
        storage.beginEditing()
        storage.setAttributes([.font: baseFont, .foregroundColor: text], range: full)
        func apply(_ pattern: String, options: NSRegularExpression.Options = [.anchorsMatchLines], _ attrs: (NSTextCheckingResult) -> [(NSRange, [NSAttributedString.Key: Any])]) {
            guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return }
            for m in re.matches(in: storage.string, range: full) { for (r, a) in attrs(m) where r.location != NSNotFound { storage.addAttributes(a, range: r) } }
        }
        let bold = NSFontManager.shared.convert(baseFont, toHaveTrait: .boldFontMask)
        apply("^(#{1,6})\\s+(.*)$") { m in
            let level = m.range(at: 1).length
            let size = baseFont.pointSize + CGFloat(max(0, 4 - level) * 2)
            return [(m.range(at: 0), [.font: NSFontManager.shared.convert(bold, toSize: size)]), (m.range(at: 1), [.foregroundColor: faint])]
        }
        apply("^\\s*([-*]|\\d+\\.)\\s") { m in [(m.range(at: 1), [.foregroundColor: accent])] }
        apply("^\\s*[-*]\\s(\\[x\\])(.*)$") { m in [(m.range(at: 2), [.strikethroughStyle: NSUnderlineStyle.single.rawValue, .foregroundColor: faint]), (m.range(at: 1), [.foregroundColor: accent])] }
        apply("^\\s*[-*]\\s(\\[ \\])") { m in [(m.range(at: 1), [.foregroundColor: accent])] }
        apply("\\*\\*([^*\\n]+)\\*\\*") { m in [(m.range(at: 0), [.font: bold])] }
        apply("(?<![*\\w])\\*([^*\\n]+)\\*(?![*\\w])") { m in [(m.range(at: 0), [.font: NSFontManager.shared.convert(baseFont, toHaveTrait: .italicFontMask)])] }
        apply("`([^`\\n]+)`") { m in [(m.range(at: 0), [.font: NSFont.monospacedSystemFont(ofSize: baseFont.pointSize - 1, weight: .regular), .foregroundColor: accent])] }
        apply("^>\\s.*$") { m in [(m.range(at: 0), [.foregroundColor: faint])] }
        storage.endEditing()
    }
}
