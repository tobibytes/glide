import GlideCore
import GlideUI
import Observation
import SwiftUI

/// View model of the Quick AI launcher view. The launcher search field is the follow-up input.
@MainActor @Observable final class QuickAISession {
    let nonce = UUID().uuidString
    let props: QuickAIProps
    let conversation: AIConversation
    var panelOpen = false
    var panelIndex = 0
    @ObservationIgnored weak var feature: AIFeature?
    @ObservationIgnored private var started = false
    @ObservationIgnored var hostProvider: () -> LauncherViewHost? = { LauncherHosts.current }

    init(feature: AIFeature, props: QuickAIProps) {
        self.feature = feature
        self.props = props
        conversation = AIConversation(provider: feature, model: props.model)
    }

    /// A saved key, or a local server (Ollama, LM Studio) that needs none.
    var hasKey: Bool { feature?.isReady ?? false }

    func start() {
        guard !started else { return }
        started = true
        if let p = props.prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty, hasKey {
            conversation.send([AIChatMessage(role: "user", content: props.prompt ?? p, at: AIChats.nowMs())])
        }
    }

    struct Action: Identifiable, Equatable {
        let id: String
        let title: String
        let shortcut: String?
        let icon: String
    }

    var actions: [Action] {
        guard hasKey else { return [Action(id: "settings", title: "Open Settings → AI", shortcut: "↩", icon: "gearshape")] }
        var a: [Action] = []
        if props.replaces { a.append(Action(id: "replace", title: "Replace Selection", shortcut: "↩", icon: "text.insert")) }
        a.append(Action(id: "copy", title: "Copy Answer", shortcut: "⌘C", icon: "doc.on.doc"))
        a.append(Action(id: "paste", title: props.replaces ? "Paste Answer" : "Paste to Frontmost App", shortcut: "⇧⌘V", icon: "doc.on.clipboard"))
        a.append(Action(id: "chat", title: "Continue in AI Chat", shortcut: "⌘↩", icon: "bubble.left.and.bubble.right"))
        a.append(Action(id: "regen", title: "Regenerate", shortcut: "⌘R", icon: "arrow.clockwise"))
        if conversation.streaming { a.append(Action(id: "stop", title: "Stop Generating", shortcut: "esc", icon: "stop.circle")) }
        a.append(Action(id: "settings", title: "AI Settings…", shortcut: nil, icon: "gearshape"))
        return a
    }

    var primaryTitle: String {
        if !hasKey { return "Open Settings" }
        if conversation.streaming { return "Generating…" }
        if props.replaces && conversation.lastAnswer != nil { return "Replace Selection" }
        return conversation.messages.isEmpty ? "Ask" : "Ask Follow-up"
    }

    func perform(_ id: String) {
        panelOpen = false
        guard let f = feature else { return }
        let answer = conversation.lastAnswer
        switch id {
        case "settings": f.openSettingsPage()
        case "replace", "paste":
            guard let answer, !conversation.streaming || id == "paste" else { f.toast("No answer yet", .info); return }
            f.paste(answer)
        case "copy":
            guard let answer else { f.toast("No answer yet", .info); return }
            f.copy(answer)
        case "chat":
            let msgs = conversation.messages.filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            conversation.stop()
            if msgs.isEmpty { f.openChatWindow(prompt: hostProvider()?.query, messages: nil, title: nil) } else { f.openChatWindow(prompt: nil, messages: msgs, title: props.title) }
        case "regen": conversation.regenerate()
        case "stop": conversation.stop()
        default: break
        }
    }

    /// ⏎: follow-up when the field has text; otherwise Replace Selection (AI Commands that replace).
    func activate() {
        guard hasKey else { feature?.openSettingsPage(); return }
        let q = (hostProvider()?.query ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty {
            conversation.ask(q)
            clearQuery()
        } else if props.replaces, conversation.lastAnswer != nil, !conversation.streaming {
            perform("replace")
        }
    }

    /// The field holds the follow-up; empty it after sending.
    private func clearQuery() { hostProvider()?.setQuery("") }

    func handleKey(_ k: VimKey) -> Bool {
        let plain = !k.meta && !k.ctrl && !k.alt
        if panelOpen {
            let list = actions
            switch Vim.panelKey(k) {
            case let .move(d)?: panelIndex = min(list.count - 1, max(0, panelIndex + d))
            case .run?: if panelIndex < list.count { perform(list[panelIndex].id) }
            case .close?: panelOpen = false
            default:
                if let a = list.first(where: { $0.shortcut == KeyChord.display(k) && (k.meta || k.ctrl) }) { perform(a.id) }
            }
            return true
        }
        if k.key == "Escape" && plain && conversation.streaming {
            conversation.stop()
            return true
        }
        guard hasKey else { return false }
        switch KeyChord.display(k) {
        case "⇧⌘V": perform("paste"); return true
        case "⌘R": perform("regen"); return true
        case "⌘C":
            guard conversation.lastAnswer != nil else { return false }
            perform("copy")
            return true
        default: return false
        }
    }

    func handleCommand(_ c: VimCommand) -> Bool {
        switch c {
        case .actions:
            panelIndex = 0
            panelOpen.toggle()
        case .activate: activate()
        case .secondary: perform("chat")
        case .copy: perform("copy")
        case .paste: perform("paste")
        case .move, .goto, .halfPage, .section: return true // nothing to navigate; keep the root list still
        default: return false
        }
        return true
    }

    func stateJSON() -> JSONValue {
        [
            "title": props.title.map(JSONValue.string) ?? .null, "notice": props.notice.map(JSONValue.string) ?? .null,
            "replaces": .bool(props.replaces), "hasKey": .bool(hasKey), "streaming": .bool(conversation.streaming),
            "answer": conversation.lastAnswer.map(JSONValue.string) ?? .null, "model": conversation.lastModel.map(JSONValue.string) ?? .null,
            "error": conversation.error.map { ["message": .string($0.message), "kind": .string($0.kind.rawValue)] } ?? .null,
            "messages": .array(conversation.messages.map { ["role": .string($0.role), "content": .string($0.content)] }),
            "panelOpen": .bool(panelOpen), "actions": .array(actions.map { .string($0.title) }), "primary": .string(primaryTitle),
        ]
    }
}

struct QuickAIView: View {
    @Environment(\.glideTheme) private var theme
    let session: QuickAISession
    let host: LauncherViewHost

    var body: some View {
        let conv = session.conversation
        ZStack(alignment: .bottomTrailing) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let title = session.props.title {
                            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.text3).textCase(.uppercase)
                        }
                        if let notice = session.props.notice {
                            Label(notice, systemImage: "info.circle").font(.system(size: 12)).foregroundStyle(theme.warning)
                        }
                        if !session.hasKey {
                            AddKeyNote()
                        } else if conv.messages.isEmpty && conv.error == nil {
                            HStack(spacing: 6) {
                                Text("Type a question and press").foregroundStyle(theme.text3)
                                Kbd("↩")
                            }
                            .font(.system(size: 13))
                        }
                        ForEach(Array(conv.messages.enumerated()), id: \.offset) { i, m in
                            if m.role == "user" {
                                if !(session.props.title != nil && i == 0) {
                                    Text(m.content).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text2)
                                        .padding(.horizontal, 10).padding(.vertical, 6)
                                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(theme.surface2))
                                }
                            } else if m.content.isEmpty {
                                if conv.streaming { ThinkingDots() }
                            } else {
                                AIMarkdownView(text: m.content)
                            }
                        }
                        if let e = conv.error { AIErrorNote(error: e) }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: conv.messages.last?.content.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            if session.panelOpen {
                ActionPanel(title: "Quick AI", actions: session.actions.map { ItemAction(id: $0.id, title: $0.title, shortcut: $0.shortcut, icon: $0.icon) },
                            selectedIndex: session.panelIndex, filter: "")
                    .padding(10)
            }
        }
        .onAppear {
            host.setPlaceholder(session.props.prompt == nil ? "Ask AI anything…" : "Ask a follow-up…")
            host.setFooter(primary: session.primaryTitle, hasActions: true)
        }
        .onChange(of: session.primaryTitle) { _, t in host.setFooter(primary: t, hasActions: true) }
    }
}

struct ThinkingDots: View {
    @Environment(\.glideTheme) private var theme
    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text("Thinking…").font(.system(size: 12.5)).foregroundStyle(theme.text3)
        }
    }
}

struct AIErrorNote: View {
    @Environment(\.glideTheme) private var theme
    let error: AIError
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: error.kind == .noKey || error.kind == .auth ? "key.slash" : "exclamationmark.triangle.fill").foregroundStyle(theme.danger)
            VStack(alignment: .leading, spacing: 2) {
                Text(error.message).font(.system(size: 12.5)).foregroundStyle(theme.text)
                if error.kind == .noKey || error.kind == .auth {
                    Text("Open Settings → AI from the actions (⌘K).").font(.system(size: 11.5)).foregroundStyle(theme.text3)
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(theme.danger.opacity(0.1)))
    }
}

struct AddKeyNote: View {
    @Environment(\.glideTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Add an AI API key", systemImage: "key.fill").font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.text)
            Text("Glide AI uses your own Anthropic or OpenAI key, stored in the macOS Keychain. Press ↩ to open Settings → AI.")
                .font(.system(size: 12.5)).foregroundStyle(theme.text2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface2))
    }
}
