import GlideCore
import GlideUI
import SwiftUI

/// List of transforms (with one-line previews) + detail pane showing the full output and the input.
struct TransformView: View {
    @Environment(\.glideTheme) private var theme
    let session: TransformSession
    let host: LauncherViewHost

    var body: some View {
        Group {
            if session.input == nil {
                VStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Reading selection…").font(.system(size: 12)).foregroundStyle(theme.text3)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                content
            }
        }
        .onAppear {
            host.setPlaceholder("Filter transforms…  (“wrap 60” sets the width)")
            host.setFooter(primary: "Paste Result", hasActions: true)
        }
    }

    private var content: some View {
        let rows = session.rows
        let selectedId = session.selected?.id
        return ZStack(alignment: .bottomTrailing) {
            DetailSplit(ratio: 0.46) {
                if rows.isEmpty {
                    EmptyState(symbol: "wand.and.stars", title: "No transform matches")
                } else {
                    list(rows, selectedId: selectedId)
                }
            } detail: {
                detail
            }
            if session.panelOpen {
                ActionPanel(title: "Transform",
                            actions: session.panelActions.map { ItemAction(id: $0.id, title: $0.title, shortcut: $0.shortcut, icon: $0.icon) },
                            selectedIndex: session.panelIndex, filter: "")
                    .padding(10)
            }
        }
    }

    private func list(_ rows: [TransformRow], selectedId: String?) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                        if i == 0 || rows[i - 1].section != row.section {
                            SectionHeader(row.section).frame(height: 28, alignment: .bottom)
                        }
                        rowView(row, selected: row.id == selectedId)
                            .id(row.id)
                            .onTapGesture { session.selectedIndex = i }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .scrollIndicators(.never)
            .onChange(of: selectedId) { _, id in if let id { proxy.scrollTo(id) } }
        }
    }

    private func rowView(_ row: TransformRow, selected: Bool) -> some View {
        let def = TextTransforms.byId(row.transform)
        let preview = session.preview(row.transform)
        return HStack(spacing: 10) {
            Text(String(def?.category.rawValue.prefix(1) ?? "?"))
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(theme.accentText)
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(theme.accentSoft))
            VStack(alignment: .leading, spacing: 1) {
                Text(def?.title ?? row.transform).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text).lineLimit(1)
                if let preview {
                    Text(preview.output.map { Self.oneLine($0, 40) } ?? "—")
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(preview.output == nil ? theme.danger.opacity(0.8) : theme.text3)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .frame(height: 42)
        .background(RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous).fill(selected ? theme.selected : .clear))
        .contentShape(Rectangle())
    }

    @ViewBuilder private var detail: some View {
        if let row = session.selected, let def = TextTransforms.byId(row.transform) {
            let res = session.result(row.transform)
            let input = session.input
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(def.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(theme.text2)
                    if def.id == "jwt" { Tag("signature not verified", accent: true) }
                    Spacer()
                }
                ScrollView {
                    Group {
                        if let out = res.output {
                            Text(out).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(theme.text).textSelection(.enabled)
                        } else {
                            Label(res.error ?? "", systemImage: "exclamationmark.triangle").font(.system(size: 12.5)).foregroundStyle(theme.danger)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .frame(maxHeight: .infinity)
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    Text("Input · \(Self.sourceLabel(input?.source ?? .none)) · \(session.text.unicodeScalars.count) chars")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.text3)
                    if let note = input?.note, input?.source != .selection {
                        Text(note).font(.system(size: 11)).foregroundStyle(theme.warning).lineLimit(2)
                    }
                    Text(session.text.isEmpty ? "(empty — copy or select text, or ⌘T to use the search text)" : String(session.text.prefix(600)))
                        .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(theme.text3).lineLimit(5)
                }
                HStack(spacing: 10) {
                    hint("↩", "paste"); hint("⌘C", "copy"); hint("⌘I", "chain"); hint("⌘K", "more")
                }
            }
            .padding(14)
        } else {
            EmptyState(symbol: "text.magnifyingglass", title: "Nothing selected")
        }
    }

    private func hint(_ key: String, _ label: String) -> some View {
        HStack(spacing: 4) { Kbd(key); Text(label).font(.system(size: 11)).foregroundStyle(theme.text3) }
    }

    static func sourceLabel(_ s: SelectionInput.Source) -> String {
        switch s {
        case .selection: return "Selected text"
        case .clipboard: return "Clipboard"
        case .none: return "No input"
        }
    }

    static func oneLine(_ s: String, _ max: Int) -> String {
        let flat = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return flat.count > max ? String(flat.prefix(max)) + "…" : flat
    }
}
