import GlideCore
import GlideUI
import SwiftUI

/// askInput: the question above the launcher's search field (the field is the answer). ⏎ continues, ⎋ cancels.
struct WorkflowPromptView: View {
    @Environment(\.glideTheme) private var theme
    let prompt: String
    let workflow: String?
    let token: String
    let prompts: WorkflowPrompts

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "questionmark.bubble.fill")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(theme.accent)
                .frame(width: 58, height: 58)
                .background(Circle().fill(theme.accentSoft))
            Text(prompt)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(theme.text)
                .multilineTextAlignment(.center)
            if let workflow { Text(workflow).font(theme.subtitleFont).foregroundStyle(theme.text3) }
            HStack(spacing: 14) {
                HStack(spacing: 5) { Kbd("↩"); Text("Continue").foregroundStyle(theme.text2) }
                HStack(spacing: 5) { Kbd("⎋"); Text("Cancel workflow").foregroundStyle(theme.text2) }
            }
            .font(.system(size: 12))
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onDisappear { [prompts, token] in prompts.viewGone(token: token) }
    }
}

/// showResult: the text, selectable, with ⏎ / ⌘C to copy.
struct WorkflowResultView: View {
    @Environment(\.glideTheme) private var theme
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title, trailing: "\(text.count) characters")
            ScrollView {
                Text(text.isEmpty ? "(empty)" : text)
                    .font(.system(size: 14, design: text.contains("\n") ? .monospaced : .default))
                    .foregroundStyle(text.isEmpty ? theme.text3 : theme.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface))
                    .padding(.horizontal, 12)
            }
            HStack(spacing: 14) {
                HStack(spacing: 5) { Kbd("↩"); Text("Copy") }
                HStack(spacing: 5) { Kbd("⌘C"); Text("Copy") }
                HStack(spacing: 5) { Kbd("⎋"); Text("Back") }
                Spacer()
            }
            .font(.system(size: 12))
            .foregroundStyle(theme.text2)
            .padding(12)
        }
    }
}

/// The last run of a workflow, step by step (⌘L on a workflow).
struct WorkflowRunLogLauncherView: View {
    @Environment(\.glideTheme) private var theme
    let name: String
    let run: WorkflowRunResult?
    let filter: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let run {
                SectionHeader("\(name) · \(run.ok ? "succeeded" : run.cancelled == true ? "cancelled" : "failed")", trailing: run.durationMs.map { "\(Int($0)) ms" })
                ScrollView {
                    WorkflowRunLogList(entries: run.log.filter { filter.isEmpty || ($0.title ?? $0.type).localizedCaseInsensitiveContains(filter) })
                        .padding(.horizontal, 12)
                    if let r = run.result, !r.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("RESULT").font(theme.sectionFont).foregroundStyle(theme.text3)
                            Text(r).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text).lineLimit(8).textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                    }
                }
            } else {
                EmptyState(symbol: "clock.arrow.circlepath", title: "No runs yet", subtitle: name)
            }
        }
    }
}

/// Shared run-log rows (launcher view and the editor's run panel).
struct WorkflowRunLogList: View {
    @Environment(\.glideTheme) private var theme
    let entries: [WorkflowRunLogEntry]
    /// Settings window: system colors instead of the launcher theme.
    var native = false

    private var c1: Color { native ? .primary : theme.text }
    private var c2: Color { native ? .secondary : theme.text2 }
    private var c3: Color { native ? Color.secondary.opacity(0.7) : theme.text3 }
    private var ok: Color { native ? .green : theme.success }
    private var bad: Color { native ? .red : theme.danger }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, e in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: e.status == .ok ? "checkmark.circle.fill" : e.status == .error ? "xmark.octagon.fill" : "minus.circle")
                        .foregroundStyle(e.status == .ok ? ok : e.status == .error ? bad : c3)
                        .font(.system(size: 12))
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(e.title ?? e.type).font(.system(size: 12.5, weight: .medium)).foregroundStyle(c1)
                            Spacer()
                            Text(e.status == .skipped ? "skipped" : "\(Int(e.endedAt - e.startedAt)) ms").font(.system(size: 11)).foregroundStyle(c3).monospacedDigit()
                        }
                        if let err = e.error { Text(err).font(.system(size: 11.5)).foregroundStyle(bad).lineLimit(4).textSelection(.enabled) }
                        else if let out = e.output, !out.isEmpty {
                            Text(out).font(.system(size: 11, design: .monospaced)).foregroundStyle(c2).lineLimit(3).textSelection(.enabled)
                        }
                    }
                }
                .padding(.leading, CGFloat(e.depth ?? 0) * 16)
                .padding(.vertical, 4)
            }
        }
    }
}
