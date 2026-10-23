import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// The always-on-top Floating Notes panel (never created in headless runs). A non-activating floating NSPanel
/// that joins all Spaces (incl. full-screen apps), remembers its frame in notes.json `bounds` and autosaves.
@MainActor final class NotesPanelController: NSObject, NSWindowDelegate {
    private unowned let feature: NotesFeature
    private let panel: NotesPanel
    private let ui = NotesPanelUI()
    private var boundsTask: Task<Void, Never>?

    init(feature: NotesFeature) {
        self.feature = feature
        panel = NotesPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 420),
                           styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: true)
        super.init()
        panel.title = "Floating Notes"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.minSize = NSSize(width: 240, height: 200)
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.backgroundColor = .clear
        panel.isOpaque = false
        ui.feature = feature
        ui.onHide = { [weak self] in self?.hide() }
        let host = NSHostingView(rootView: NotesPanelView(ui: ui, store: feature.store))
        panel.contentView = host
        panel.setFrame(restoredFrame(), display: false)
    }

    var isVisible: Bool { panel.isVisible }
    var isKey: Bool { panel.isKeyWindow }

    func show() {
        ui.load()
        panel.makeKeyAndOrderFront(nil)
        ui.focusToken += 1
    }

    func hide() {
        ui.flush()
        panel.orderOut(nil)
    }

    private func restoredFrame() -> NSRect {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let def = NSRect(x: screen.maxX - 360 - 24, y: screen.maxY - 420 - 24, width: 360, height: 420)
        guard let b = feature.store.file.bounds else { return def }
        // Electron bounds are top-left origin; convert to AppKit's bottom-left.
        let primary = NSScreen.screens.first?.frame.height ?? screen.maxY
        let r = NSRect(x: b.x, y: primary - b.y - b.height, width: b.width, height: b.height)
        return NSScreen.screens.contains { $0.visibleFrame.insetBy(dx: 40, dy: 40).intersects(r) } ? r : def
    }

    private func saveBounds() {
        boundsTask?.cancel()
        boundsTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard let self, !Task.isCancelled else { return }
            let f = self.panel.frame
            let primary = NSScreen.screens.first?.frame.height ?? f.maxY
            self.feature.setBounds(NoteBounds(x: f.minX, y: primary - f.maxY, width: f.width, height: f.height))
        }
    }

    func windowDidMove(_ notification: Notification) { saveBounds() }
    func windowDidResize(_ notification: Notification) { saveBounds() }
    func windowDidResignKey(_ notification: Notification) { ui.flush() }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide() // ⌘W hides; the note survives
        return false
    }
}

final class NotesPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// Editor state for the panel: current text, debounced saves, delete confirmation, switcher.
@MainActor @Observable final class NotesPanelUI {
    @ObservationIgnored weak var feature: NotesFeature?
    @ObservationIgnored var onHide: () -> Void = {}
    var noteId: String?
    var text = ""
    var confirmDelete = false
    var switcher = false
    var switcherQuery = ""
    var switcherSelection = 0
    var focusToken = 0
    @ObservationIgnored private var dirty = false
    @ObservationIgnored private var saveTask: Task<Void, Never>?

    func load() {
        guard let f = feature else { return }
        let n = f.ensureNote()
        noteId = n.id
        text = n.body
        dirty = false
        confirmDelete = false
    }

    func edited(_ value: String) {
        text = value
        dirty = true
        saveTask?.cancel()
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    func flush() {
        saveTask?.cancel()
        guard dirty, let id = noteId else { return }
        dirty = false
        feature?.save(id: id, body: text)
    }

    func switchTo(_ fn: (NotesFeature) -> Note) {
        flush()
        guard let f = feature else { return }
        let n = fn(f)
        noteId = n.id
        text = n.body
        confirmDelete = false
        focusToken += 1
    }

    func deleteCurrent() {
        guard let f = feature, let id = noteId else { return }
        dirty = false
        f.remove(id: id)
        load()
        focusToken += 1
    }

    var switcherResults: [Note] { feature.map { NotesModel.search($0.store.file.notes, switcherQuery) } ?? [] }

    /// Panel shortcuts. true = handled.
    func key(_ e: NSEvent) -> Bool {
        let flags = e.modifierFlags.intersection([.command, .control, .option, .shift])
        let chars = e.charactersIgnoringModifiers ?? ""
        if confirmDelete {
            if e.keyCode == 36 || chars.lowercased() == "y" { deleteCurrent() } else if e.keyCode == 53 || chars.lowercased() == "n" { confirmDelete = false }
            return true
        }
        if switcher {
            let list = switcherResults
            switch e.keyCode {
            case 125: switcherSelection = min(max(0, list.count - 1), switcherSelection + 1); return true
            case 126: switcherSelection = max(0, switcherSelection - 1); return true
            case 36:
                if switcherSelection < list.count { let id = list[switcherSelection].id; switcher = false; switchTo { $0.select(id: id) } }
                return true
            case 53: switcher = false; focusToken += 1; return true
            default: break
            }
            if flags == .control, ["j", "n"].contains(chars) { switcherSelection = min(max(0, list.count - 1), switcherSelection + 1); return true }
            if flags == .control, ["k", "p"].contains(chars) { switcherSelection = max(0, switcherSelection - 1); return true }
            if flags == .command, chars == "k" { switcher = false; focusToken += 1; return true }
            return false
        }
        if flags == .command {
            switch chars {
            case "n": switchTo { $0.create() }; return true
            case "]": switchTo { $0.cycle(1) }; return true
            case "[": switchTo { $0.cycle(-1) }; return true
            case "k":
                flush()
                switcherQuery = ""
                switcherSelection = max(0, switcherResults.firstIndex { $0.id == noteId } ?? 0)
                switcher = true
                return true
            default: break
            }
            if e.keyCode == 51 { confirmDelete = true; return true }
        }
        if e.keyCode == 53 && flags.isEmpty {
            flush()
            onHide()
            return true
        }
        return false
    }
}

struct NotesPanelView: View {
    @Bindable var ui: NotesPanelUI
    let store: NotesStore
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let theme = GlideTheme(tokens: Themes.tokens(mode: "system", systemDark: scheme == .dark, bag: [:]))
        let notes = store.file.notes
        let index = notes.firstIndex { $0.id == ui.noteId }
        ZStack {
            VibrancyBackground(material: .hudWindow)
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text(notes.first { $0.id == ui.noteId }.map { NotesModel.title(of: $0.body) } ?? "Floating Notes")
                        .font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    Spacer()
                    if let index { Text("\(index + 1) / \(notes.count)").font(.system(size: 11)).foregroundStyle(theme.text3).monospacedDigit() }
                    Button { ui.switchTo { $0.create() } } label: { Image(systemName: "plus") }.buttonStyle(.borderless).help("New note (⌘N)")
                    Button { ui.switcher = true } label: { Image(systemName: "magnifyingglass") }.buttonStyle(.borderless).help("Find note (⌘K)")
                }
                .padding(.leading, 74).padding(.trailing, 10).frame(height: 30)
                NotesEditor(ui: ui, theme: theme)
                Divider()
                HStack {
                    if ui.confirmDelete {
                        Text("Delete this note?").foregroundStyle(theme.danger)
                        Spacer()
                        Kbd("↩"); Text("delete").foregroundStyle(theme.text3)
                        Kbd("Esc"); Text("cancel").foregroundStyle(theme.text3)
                    } else {
                        let words = NotesModel.wordCount(ui.text)
                        Text("\(words) word\(words == 1 ? "" : "s") · \(ui.text.count) chars").foregroundStyle(theme.text3)
                        Spacer()
                        Text("⌘N new · ⌘[ ⌘] switch · ⌘K find · ⎋ hide").foregroundStyle(theme.text3)
                    }
                }
                .font(.system(size: 11)).padding(.horizontal, 12).frame(height: 28)
            }
            if ui.switcher { switcherOverlay(theme) }
        }
        .glideTheme(theme)
        .ignoresSafeArea()
    }

    private func switcherOverlay(_ theme: GlideTheme) -> some View {
        let list = ui.switcherResults
        return VStack(spacing: 0) {
            TextField("Find a note…", text: $ui.switcherQuery).textFieldStyle(.plain).font(.system(size: 13)).padding(10)
                .onChange(of: ui.switcherQuery) { _, _ in ui.switcherSelection = 0 }
            Divider()
            ScrollView {
                VStack(spacing: 2) {
                    if list.isEmpty { Text("No notes match").foregroundStyle(theme.text3).padding() }
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, n in
                        HStack {
                            Text(NotesModel.title(of: n.body)).lineLimit(1)
                            Spacer()
                            Text(N7Format.relative(n.updatedAt, now: Date().timeIntervalSince1970 * 1000)).font(.system(size: 11)).foregroundStyle(theme.text3)
                        }
                        .font(.system(size: 12.5)).padding(.horizontal, 10).frame(height: 28)
                        .background(RoundedRectangle(cornerRadius: 6).fill(i == ui.switcherSelection ? theme.selected : .clear))
                        .contentShape(Rectangle())
                        .onTapGesture { ui.switcher = false; ui.switchTo { $0.select(id: n.id) } }
                    }
                }.padding(6)
            }
            Divider()
            HStack(spacing: 6) { Kbd("↑"); Kbd("↓"); Text("select ·"); Kbd("↩"); Text("open ·"); Kbd("Esc"); Text("close") }
                .font(.system(size: 11)).foregroundStyle(theme.text3).padding(8)
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(theme.panelSolid))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(theme.borderStrong))
        .padding(16)
    }
}

/// NSTextView editor with live markdown styling; panel shortcuts are intercepted before typing.
struct NotesEditor: NSViewRepresentable {
    let ui: NotesPanelUI
    let theme: GlideTheme

    final class TextView: NSTextView {
        var onKey: ((NSEvent) -> Bool)?
        override func keyDown(with event: NSEvent) { if onKey?(event) != true { super.keyDown(with: event) } }
        override func performKeyEquivalent(with event: NSEvent) -> Bool { onKey?(event) == true || super.performKeyEquivalent(with: event) }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NotesEditor
        var lastFocus = -1
        init(_ p: NotesEditor) { parent = p }
        func textDidChange(_ n: Notification) {
            guard let tv = n.object as? NSTextView else { return }
            MainActor.assumeIsolated {
                parent.ui.edited(tv.string)
                parent.restyle(tv)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = TextView.scrollableTextView()
        scroll.drawsBackground = false
        guard let tv = scroll.documentView as? NSTextView else { return scroll }
        let custom = TextView(frame: tv.frame, textContainer: tv.textContainer)
        custom.autoresizingMask = tv.autoresizingMask
        custom.minSize = tv.minSize
        custom.maxSize = tv.maxSize
        custom.isVerticallyResizable = true
        custom.isHorizontallyResizable = false
        scroll.documentView = custom
        custom.delegate = context.coordinator
        custom.drawsBackground = false
        custom.isRichText = false
        custom.allowsUndo = true
        custom.isAutomaticQuoteSubstitutionEnabled = false
        custom.textContainerInset = NSSize(width: 10, height: 8)
        custom.font = .systemFont(ofSize: 13.5)
        custom.onKey = { [weak ui] e in MainActor.assumeIsolated { ui?.key(e) ?? false } }
        custom.setAccessibilityLabel("Note text")
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? NSTextView else { return }
        if tv.string != ui.text {
            tv.string = ui.text
            restyle(tv)
        }
        if context.coordinator.lastFocus != ui.focusToken {
            context.coordinator.lastFocus = ui.focusToken
            DispatchQueue.main.async { tv.window?.makeFirstResponder(tv) }
        }
    }

    func restyle(_ tv: NSTextView) {
        guard let storage = tv.textStorage else { return }
        let sel = tv.selectedRanges
        NotesMarkdown.highlight(storage, baseFont: .systemFont(ofSize: 13.5), text: NSColor(theme.tokens.text), faint: NSColor(theme.tokens.text3), accent: NSColor(theme.tokens.accent))
        tv.selectedRanges = sel
        tv.typingAttributes = [.font: NSFont.systemFont(ofSize: 13.5), .foregroundColor: NSColor(theme.tokens.text)]
    }
}
