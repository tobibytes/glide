import AppKit
import GlideCore
import GlideSystem
import GlideUI
import Observation
import SwiftUI

/// The AI Chat window's model: conversation list (chats/<id>.json), the open chat, draft and model picker.
@MainActor @Observable final class AIChatModel {
    @ObservationIgnored weak var feature: AIFeature?
    @ObservationIgnored let store: AIChatStore
    private(set) var summaries: [AIChatSummary] = []
    private(set) var currentId: String?
    private(set) var createdAt: Double = AIChats.nowMs()
    var title = "New Chat"
    var draft = ""
    var filter = ""
    /// Bumped each time the window is shown: moves the keyboard focus to the composer.
    var focusComposer = 0
    let conversation: AIConversation

    init(feature: AIFeature, store: AIChatStore) {
        self.feature = feature
        self.store = store
        conversation = AIConversation(provider: feature)
        conversation.onFinish = { [weak self] _ in self?.persist() }
        reload()
    }

    var model: String {
        get { conversation.effectiveModel }
        set { conversation.model = newValue }
    }

    var visibleSummaries: [AIChatSummary] {
        let f = filter.trimmingCharacters(in: .whitespaces).lowercased()
        return f.isEmpty ? summaries : summaries.filter { $0.title.lowercased().contains(f) || $0.preview.lowercased().contains(f) }
    }

    func reload() { summaries = store.list() }

    func newChat() {
        conversation.stop()
        currentId = nil
        createdAt = AIChats.nowMs()
        title = "New Chat"
        conversation.messages = []
        conversation.model = nil
        draft = ""
    }

    func select(_ id: String) {
        guard let c = store.get(id) else { return }
        conversation.stop()
        currentId = c.id
        createdAt = c.createdAt
        title = c.title
        conversation.messages = c.messages
        conversation.model = c.model
    }

    func delete(_ id: String) {
        store.delete(id)
        if currentId == id { newChat() }
        reload()
    }

    func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !conversation.streaming else { return }
        draft = ""
        if currentId == nil {
            currentId = AIChats.newId()
            title = AIChats.deriveTitle([AIChatMessage(role: "user", content: text)])
        }
        conversation.ask(text)
        persist()
    }

    func persist() {
        guard let id = currentId else { return }
        let msgs = conversation.messages.filter { !$0.content.isEmpty }
        _ = try? store.save(AIChat(id: id, title: title, model: conversation.model ?? feature?.currentModel, createdAt: createdAt, updatedAt: AIChats.nowMs(), messages: msgs))
        reload()
    }

    func stateJSON() -> JSONValue {
        [
            "chatId": currentId.map(JSONValue.string) ?? .null, "title": .string(title), "model": .string(model),
            "streaming": .bool(conversation.streaming), "draft": .string(draft),
            "error": conversation.error.map { .string($0.message) } ?? .null,
            "messages": .array(conversation.messages.map { ["role": .string($0.role), "content": .string($0.content)] }),
            "chats": .array(summaries.map { .string($0.title) }),
        ]
    }
}

/// A normal (activating) window — unlike the launcher it is meant to be typed into for a while.
@MainActor final class AIChatWindowController: NSObject, NSWindowDelegate {
    let window: NSWindow
    let model: AIChatModel

    init(model: AIChatModel) {
        self.model = model
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: 640), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: true)
        super.init()
        window.title = "AI Chat"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 620, height: 420)
        window.contentView = NSHostingView(rootView: SystemThemed { AIChatRootView(model: model) })
        window.setFrameAutosaveName("GlideAIChat")
        window.delegate = self
        window.center()
    }

    func show() {
        GlideWindows.shared.present(window) // activating: Dock + ⌘Tab while open, focus back to the user's app on close
        model.focusComposer += 1 // typing goes to the composer, also when the window is shown again
    }

    /// Offscreen render for headless evidence: the hosting view is never put in an on-screen window.
    static func snapshot(model: AIChatModel, to url: URL) throws -> NSSize {
        try snapshot(view: SystemThemed { AIChatRootView(model: model) }.frame(width: 880, height: 600), size: NSSize(width: 880, height: 600), to: url)
    }

    static func snapshot<V: View>(view: V, size: NSSize, to url: URL) throws -> NSSize {
        let hosting = NSHostingView(rootView: view.environment(\.colorScheme, .dark).background(Color(NSColor.windowBackgroundColor)))
        hosting.appearance = NSAppearance(named: .darkAqua)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { throw FeatureError.failed("no bitmap") }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw FeatureError.failed("png encoding failed") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
        return NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    }
}

struct AIChatRootView: View {
    @Bindable var model: AIChatModel
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationSplitView {
            sidebar.navigationSplitViewColumnWidth(min: 200, ideal: 240)
        } detail: {
            VStack(spacing: 0) {
                transcript
                Divider()
                composer
            }
            .toolbar {
                ToolbarItem(placement: .principal) { Text(model.title).font(.headline).lineLimit(1) }
                ToolbarItem {
                    Picker("Model", selection: $model.model) {
                        ForEach(model.feature?.modelChoices ?? AIModels.all) { m in Text(m.label).tag(m.id) }
                    }
                    .pickerStyle(.menu)
                    .help("Model for this chat")
                }
            }
        }
        .onAppear { inputFocused = true }
        .onChange(of: model.focusComposer) { _, _ in inputFocused = true }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("Search chats", text: $model.filter).textFieldStyle(.roundedBorder)
                Button { model.newChat(); inputFocused = true } label: { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("n", modifiers: .command)
                    .help("New Chat (⌘N)")
            }
            .padding(10)
            List(selection: Binding(get: { model.currentId }, set: { if let id = $0 { model.select(id) } })) {
                ForEach(model.visibleSummaries) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                        Text(s.preview).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .tag(s.id)
                    .contextMenu { Button("Delete Chat", role: .destructive) { model.delete(s.id) } }
                }
            }
            .listStyle(.sidebar)
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.conversation.messages.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 30, weight: .light)).foregroundStyle(.secondary)
                            Text("Ask Claude anything").font(.system(size: 14, weight: .medium)).foregroundStyle(.secondary)
                            Text("↩ to send · ⇧↩ new line · ⌘N new chat · esc stops").font(.system(size: 11.5)).foregroundStyle(.tertiary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 80)
                    }
                    ForEach(Array(model.conversation.messages.enumerated()), id: \.offset) { _, m in
                        if m.role == "user" {
                            HStack {
                                Spacer(minLength: 80)
                                Text(m.content).font(.system(size: 13.5)).textSelection(.enabled)
                                    .padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.accentColor.opacity(0.18)))
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 4) {
                                if m.content.isEmpty { ThinkingDots() } else { AIMarkdownView(text: m.content) }
                                if let mm = m.model, !m.content.isEmpty {
                                    Text(model.feature?.modelLabel(mm) ?? AIModels.label(mm)).font(.system(size: 10.5)).foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                    if let e = model.conversation.error { AIErrorNote(error: e) }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(20)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: model.conversation.messages.last?.content.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message Claude…", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5))
                .lineLimit(1...8)
                .focused($inputFocused)
                .onSubmit { model.sendDraft() }
                .onKeyPress(.escape) {
                    guard model.conversation.streaming else { return .ignored }
                    model.conversation.stop()
                    return .handled
                }
            if model.conversation.streaming {
                Button { model.conversation.stop() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 18)) }
                    .buttonStyle(.borderless).help("Stop (esc)")
            } else {
                Button { model.sendDraft() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 18)) }
                    .buttonStyle(.borderless)
                    .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("Send (↩)")
            }
        }
        .padding(12)
        .background(.bar)
    }
}

/// Glide theme tokens that follow the window's light/dark appearance (for normal windows and settings).
struct SystemThemed<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @ViewBuilder let content: () -> Content
    var body: some View {
        let dark = scheme == .dark
        content().environment(\.glideTheme, GlideTheme(tokens: Themes.tokens(mode: dark ? "dark" : "light", systemDark: dark, bag: [:])))
    }
}
