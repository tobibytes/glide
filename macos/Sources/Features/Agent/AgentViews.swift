import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Offscreen render for headless evidence (never put in an on-screen window).
@MainActor enum AgentSnapshot {
    static func render(_ view: AnyView, size: NSSize, dark: Bool = true, to url: URL) throws -> NSSize {
        let root = view.frame(width: size.width, height: size.height)
            .environment(\.colorScheme, dark ? .dark : .light)
            .background(Color(NSColor.windowBackgroundColor))
        let hosting = NSHostingView(rootView: root)
        hosting.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
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

// MARK: - agent.run

struct AgentRunView: View {
    @Environment(\.glideTheme) private var theme
    let model: AgentViewModel
    let query: String

    var body: some View {
        VStack(spacing: 0) {
            if model.runs.isEmpty && model.error == nil {
                AgentEmptyState(query: query)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: 10) {
                            if let t = model.conversationTitle, model.runs.count > 1 {
                                Text(t).font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.text3).textCase(.uppercase)
                            }
                            ForEach(model.runs, id: \.runId) { run in
                                AgentRunTranscript(run: run, live: run.runId == model.current?.runId)
                            }
                            if let e = model.error {
                                AgentNotice(text: e, tone: "error")
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    }
                    .scrollIndicators(.never)
                    .onChange(of: model.revision) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                    .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            AgentHintBar(run: model.current)
        }
    }
}

struct AgentEmptyState: View {
    @Environment(\.glideTheme) private var theme
    let query: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "wand.and.stars").font(.system(size: 30, weight: .light)).foregroundStyle(theme.accent)
            Text("Glide Agent").font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
            Text(query.isEmpty ? "Describe what you want done, then press ⏎.\nState-changing steps ask first; ⌘Z undoes them."
                               : "Press ⏎ to send “\(query)”")
                .font(.system(size: 12)).foregroundStyle(theme.text3).multilineTextAlignment(.center)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(["Put Safari on the left and Notes on the right", "Start a 25 minute focus timer", "Save a snippet with my address"], id: \.self) { s in
                    Label(s, systemImage: "sparkle").font(.system(size: 12)).foregroundStyle(theme.text2)
                }
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct AgentRunTranscript: View {
    @Environment(\.glideTheme) private var theme
    let run: AgentRunSnapshot
    let live: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(run.entries, id: \.id) { entry in
                switch entry {
                case let .prompt(_, text):
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "person.crop.circle").foregroundStyle(theme.text3)
                        Text(text).font(.system(size: 13, weight: .semibold)).foregroundStyle(theme.text).textSelection(.enabled)
                    }
                case let .text(_, text):
                    Text(text).font(.system(size: 13)).foregroundStyle(theme.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                case let .plan(_, title, items):
                    AgentPlanView(title: title, items: items, steps: run.steps)
                case let .step(_, step):
                    AgentStepRow(step: step, awaiting: run.confirmation?.stepIds.contains(step.id) == true)
                case let .summary(_, text, undoable, saveable):
                    HStack(spacing: 8) {
                        Image(systemName: run.status == .done ? "checkmark.seal" : run.status == .cancelled ? "stop.circle" : "exclamationmark.octagon")
                            .foregroundStyle(run.status == .done ? theme.success : theme.warning)
                        Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text2)
                        Spacer(minLength: 6)
                        if live && undoable > 0 { HStack(spacing: 4) { Text("Undo").font(.system(size: 11)).foregroundStyle(theme.text3); Kbd("⌘Z") } }
                        if live && saveable { HStack(spacing: 4) { Text("Save as Workflow").font(.system(size: 11)).foregroundStyle(theme.text3); Kbd("⌘S") } }
                    }
                    .padding(.top, 2)
                case let .notice(_, text, tone):
                    AgentNotice(text: text, tone: tone)
                }
            }
            if run.status == .confirming, let c = run.confirmation {
                AgentConfirmCard(steps: run.steps.filter { c.stepIds.contains($0.id) })
            } else if run.status == .running && live {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Working… (\(run.toolCalls)/\(run.maxToolCalls) tool calls)").font(.system(size: 11)).foregroundStyle(theme.text3)
                }
            }
        }
        .padding(.bottom, 6)
    }
}

struct AgentPlanView: View {
    @Environment(\.glideTheme) private var theme
    let title: String
    let items: [AgentPlanItem]
    let steps: [AgentStep]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.text2)
            ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                let st = item.stepId.flatMap { id in steps.first { $0.id == id } }?.status
                HStack(spacing: 6) {
                    Image(systemName: st == .ok ? "checkmark.circle.fill" : st == .error ? "xmark.circle" : st == .declined || st == .skipped ? "minus.circle" : "circle")
                        .font(.system(size: 11)).foregroundStyle(st == .ok ? theme.success : st == .error ? theme.danger : theme.text3)
                    Text("\(i + 1). \(item.text)").font(.system(size: 12)).foregroundStyle(theme.text2)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(theme.surface))
    }
}

struct AgentStepRow: View {
    @Environment(\.glideTheme) private var theme
    let step: AgentStep
    let awaiting: Bool

    var symbol: (String, Color) {
        switch step.status {
        case .queued: return ("circle.dotted", theme.text3)
        case .awaiting: return ("hand.raised.fill", theme.warning)
        case .running: return ("arrow.triangle.2.circlepath", theme.accent)
        case .ok: return ("checkmark.circle.fill", theme.success)
        case .error: return ("xmark.octagon.fill", theme.danger)
        case .declined: return ("hand.thumbsdown", theme.text3)
        case .skipped: return ("forward.end", theme.text3)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol.0).font(.system(size: 12)).foregroundStyle(symbol.1).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(step.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.text3)
                    if step.autoApproved == true { Tag("allowed") }
                    if step.mutating { Tag("changes things") }
                    if let u = step.undo { Tag(u.state == "done" ? "undone" : u.state == "failed" ? "undo failed" : "undoable") }
                }
                Text(step.summary).font(.system(size: 12.5)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
                if let r = step.result, step.status != .running, !r.isEmpty {
                    Text(r.count > 240 ? "\(r.prefix(240))…" : r).font(.system(size: 11, design: .monospaced)).foregroundStyle(step.status == .error ? theme.danger : theme.text3)
                        .lineLimit(4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(awaiting ? theme.accentSoft : .clear))
    }
}

struct AgentConfirmCard: View {
    @Environment(\.glideTheme) private var theme
    let steps: [AgentStep]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(steps.count == 1 ? "Glide Agent wants to:" : "Glide Agent wants to do \(steps.count) things:", systemImage: "hand.raised.fill")
                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(theme.text)
            ForEach(steps, id: \.id) { s in
                Text("• \(s.summary)").font(.system(size: 12.5)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 14) {
                HStack(spacing: 4) { Kbd("↩"); Text("Run").font(.system(size: 11.5, weight: .medium)) }
                HStack(spacing: 4) { Kbd("⌘↩"); Text("Run & don't ask again").font(.system(size: 11.5)) }
                HStack(spacing: 4) { Kbd("Esc"); Text("Cancel").font(.system(size: 11.5)) }
            }
            .foregroundStyle(theme.text2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.accent.opacity(0.6), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Confirmation required")
    }
}

struct AgentNotice: View {
    @Environment(\.glideTheme) private var theme
    let text: String
    let tone: String
    var body: some View {
        Label(text, systemImage: tone == "error" ? "exclamationmark.triangle.fill" : tone == "warning" ? "exclamationmark.circle" : "info.circle")
            .font(.system(size: 12)).foregroundStyle(tone == "error" ? theme.danger : tone == "warning" ? theme.warning : theme.text2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct AgentHintBar: View {
    @Environment(\.glideTheme) private var theme
    let run: AgentRunSnapshot?
    var body: some View {
        HStack(spacing: 12) {
            switch run?.status {
            case .confirming?: hint("↩", "Run"); hint("⌘↩", "Always"); hint("Esc", "Cancel")
            case .running?: hint("Esc", "Stop")
            default:
                hint("↩", "Send"); hint("⌘N", "New"); hint("⌘Z", "Undo"); hint("⌘S", "Save as Workflow"); hint("⌘Y", "History")
            }
            Spacer()
            if let m = run?.model { Text(m).font(.system(size: 10.5)).foregroundStyle(theme.text3) }
            if run?.readOnly == true { Tag("read-only") }
        }
        .padding(.horizontal, 14)
        .frame(height: 26)
        .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 1) }
    }
    func hint(_ k: String, _ t: String) -> some View {
        HStack(spacing: 4) { Kbd(k); Text(t).font(.system(size: 11)).foregroundStyle(theme.text3) }
    }
}

// MARK: - agent.history

struct AgentHistoryView: View {
    @Environment(\.glideTheme) private var theme
    let model: AgentViewModel
    var body: some View {
        if model.history.isEmpty {
            EmptyState(symbol: "clock.arrow.circlepath", title: "No agent conversations", subtitle: model.historyQuery.isEmpty ? "Ask Glide Agent something first" : "Nothing matches “\(model.historyQuery)”")
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    SectionHeader("Conversations", trailing: "⏎ resume · ⌘⌫ delete")
                    ForEach(Array(model.history.enumerated()), id: \.element.id) { i, c in
                        HStack(spacing: 10) {
                            ItemIconView(.symbol("bubble.left.and.text.bubble.right"), size: 24)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(c.title).font(theme.titleFont).foregroundStyle(theme.text).lineLimit(1)
                                Text(c.preview).font(theme.subtitleFont).foregroundStyle(theme.text3).lineLimit(1)
                            }
                            Spacer()
                            Text("\(c.runs) request\(c.runs == 1 ? "" : "s") · \(Self.date(c.updatedAt))").font(.system(size: 11)).foregroundStyle(theme.text3)
                        }
                        .padding(.horizontal, 10)
                        .frame(height: CGFloat(theme.tokens.rowHeight))
                        .background(RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous).fill(i == model.historySelected ? theme.selected : .clear))
                    }
                }
                .padding(.horizontal, 8)
            }
        }
    }
    static func date(_ ms: Double) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
    }
}

// MARK: - settings

struct AgentSettingsView: View {
    let feature: AgentFeature
    @State private var revision = 0

    var body: some View {
        let s = feature.settings
        Form {
            Section("Glide Agent") {
                Toggle("Read-only mode (only look things up)", isOn: binding(s.readOnly) { feature.setSettings(["readOnly": .bool($0)]) })
                Toggle("Save conversations (searchable history)", isOn: binding(s.saveHistory) { feature.setSettings(["saveHistory": .bool($0)]) })
                Toggle("Keep clipboard and selection text in saved history", isOn: binding(s.keepSensitive) { feature.setSettings(["keepSensitive": .bool($0)]) })
                Toggle("⌘⏎ in the launcher sends the query to the agent", isOn: binding(s.launcherShortcut) { feature.setSettings(["launcherShortcut": .bool($0)]) })
                Text("The agent uses the model and API key from Settings → AI. kill_process and run_shortcut always ask and are limited to \(AgentSafety.destructiveLimit) per minute.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Run without asking") {
                ForEach(AgentTools.all().filter { $0.mutating && !$0.alwaysConfirm }, id: \.name) { t in
                    Toggle(isOn: binding(s.allow[t.name] == true) { feature.setAllowed(t.name, $0) }) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(t.title)
                            Text(t.name).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
                let mcpAllowed = s.allow.keys.filter(MCPSchema.isToolName).sorted()
                ForEach(mcpAllowed, id: \.self) { name in
                    Toggle(name, isOn: binding(true) { feature.setAllowed(name, $0) })
                }
            }
            MCPServersSection(model: feature.mcpSettingsModel, feature: feature)
        }
        .formStyle(.grouped)
        .id(revision)
    }

    private func binding(_ value: Bool, _ set: @escaping @MainActor (Bool) -> Void) -> Binding<Bool> {
        Binding(get: { value }, set: { v in set(v); revision += 1 })
    }
}
