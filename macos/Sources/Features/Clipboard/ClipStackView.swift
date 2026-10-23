import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Paste Stack view: items in paste order, reorder with ⌘↑/⌘↓, FIFO/LIFO, start/stop collecting.
@MainActor @Observable final class ClipStackModel {
    @ObservationIgnored weak var feature: ClipboardFeature?
    @ObservationIgnored weak var host: (any LauncherViewHost)?
    @ObservationIgnored private var nonce: String?
    var selectedId: String?
    var panel: N2ActionPanelState?

    init(feature: ClipboardFeature) { self.feature = feature }

    func prepare(payload: JSONValue, host: (any LauncherViewHost)?) {
        if let host { self.host = host }
        let n = payload["nonce"]?.stringValue
        guard n == nil || n != nonce else { return }
        nonce = n
        selectedId = nil
        panel = nil
        currentHost?.setFooter(primary: "Paste Next", hasActions: true)
    }

    var currentHost: (any LauncherViewHost)? { host ?? LauncherHosts.current }

    func rows() -> [ClipEntry] { feature.map { f in f.stack.items.compactMap(f.entry) } ?? [] }
    func index(_ rows: [ClipEntry]) -> Int { rows.isEmpty ? -1 : rows.firstIndex { $0.id == selectedId } ?? 0 }

    func actions() -> [ItemAction] {
        let collecting = feature?.stack.collecting ?? false
        let lifo = feature?.stack.order == .lifo
        return [
            ItemAction(id: "next", title: "Paste Next from Stack", shortcut: "↩", icon: "arrow.down.doc"),
            ItemAction(id: "paste-selected", title: "Paste Selected and Remove", shortcut: "⌘↩", icon: "doc.on.clipboard"),
            ItemAction(id: "up", title: "Move Up", shortcut: "⌘↑", icon: "arrow.up"),
            ItemAction(id: "down", title: "Move Down", shortcut: "⌘↓", icon: "arrow.down"),
            ItemAction(id: "collect", title: collecting ? "Stop Collecting" : "Start Collecting Copies", shortcut: "⇧⌘S", icon: collecting ? "stop.circle" : "record.circle"),
            ItemAction(id: "order", title: lifo ? "Paste in Copy Order (FIFO)" : "Paste Last Copy First (LIFO)", shortcut: "⇧⌘O", icon: "arrow.up.arrow.down"),
            ItemAction(id: "history", title: "Open Clipboard History", shortcut: "⇧⌘V", icon: "clipboard"),
            ItemAction(id: "remove", title: "Remove from Stack", shortcut: "⌃X", icon: "minus.circle", destructive: true),
            ItemAction(id: "clear", title: "Clear Paste Stack", shortcut: "⌃⇧X", icon: "trash", destructive: true),
        ]
    }

    func run(_ a: String) {
        guard let f = feature else { return }
        panel = nil
        let rows = rows()
        let i = index(rows)
        let sel = i >= 0 ? rows[i] : nil
        switch a {
        case "next": n2Apply(f.pasteNextFromStack(), host: currentHost, context: f.context)
        case "paste-selected":
            guard let e = sel else { return }
            f.stackRemove(e.id)
            n2Apply(f.pasteEntry(e, plain: false), host: currentHost, context: f.context)
        case "up", "down":
            guard let e = sel else { return }
            f.stackMove(e.id, by: a == "up" ? -1 : 1)
            selectedId = e.id
        case "collect":
            if f.stack.collecting { f.stopPasteStack(); currentHost?.toast("Stopped collecting", style: .info) }
            else {
                // Keep what is waiting; new copies are added.
                f.resumeCollecting()
                currentHost?.toast("Collecting copies — ⌘V pastes them in order", style: .info)
            }
        case "order": f.stackSetOrder(f.stack.order == .fifo ? .lifo : .fifo)
        case "history": currentHost?.push("clipboard.history", payload: ClipboardFeature.freshPayload())
        case "remove":
            guard let e = sel else { return }
            f.stackRemove(e.id)
            let after = self.rows()
            selectedId = after.isEmpty ? nil : after[min(i, after.count - 1)].id
        case "clear": f.stackClear()
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
        if k.meta && !k.shift && !k.ctrl && !k.alt && k.key.lowercased() == "k" { panel = N2ActionPanelState(title: "Paste Stack", actions: actions()); return true }
        if k.meta && !k.shift && (k.key == "ArrowUp" || k.key == "ArrowDown") { run(k.key == "ArrowUp" ? "up" : "down"); return true }
        if (k.meta || k.ctrl) && !N2Keys.isVimControl(k) && k.key != "Enter" && !k.key.hasPrefix("Arrow") {
            if let a = actions().first(where: { N2Keys.matches($0, k) }) { run(a.id) }
            return true
        }
        return false
    }

    func handleCommand(_ c: VimCommand) -> Bool {
        let rows = rows()
        let i = index(rows)
        switch c {
        case .move, .goto, .halfPage, .section:
            let j = Vim.applyNav(c, index: i, shape: Vim.NavShape(length: rows.count))
            selectedId = j >= 0 ? rows[j].id : nil
        case .activate: run("next")
        case .secondary: run("paste-selected")
        case .actions: panel = N2ActionPanelState(title: "Paste Stack", actions: actions())
        case .delete: run("remove")
        case .paste: run("next")
        default: return false
        }
        return true
    }

    func state() -> JSONValue {
        let r = rows()
        return ["rows": .array(r.map { .string(ClipModel.title($0)) }), "selected": .int(Int64(index(r))), "collecting": .bool(feature?.stack.collecting ?? false),
                "order": .string(feature?.stack.order.rawValue ?? "fifo"), "panel": .bool(panel != nil)]
    }
}

struct ClipStackView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: ClipStackModel
    let changes: ClipChanges

    var body: some View {
        let _ = changes.version
        let rows = model.rows()
        let sel = model.index(rows)
        let stack = model.feature?.stack ?? PasteStack()
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "square.stack.3d.up").foregroundStyle(theme.accent)
                Text("Paste Stack").font(.system(size: 13, weight: .semibold)).foregroundStyle(theme.text)
                Tag(stack.order == .fifo ? "First copied first" : "Last copied first")
                if stack.collecting { Tag(stack.limit > 0 ? "Collecting \(stack.collected)/\(stack.limit)" : "Collecting", accent: true) }
                Spacer()
                Text(rows.isEmpty ? "Empty" : "\(rows.count) waiting · ⌘V pastes the next").font(.system(size: 11.5)).foregroundStyle(theme.text3)
            }
            .padding(.horizontal, 14)
            .frame(height: 38)
            if rows.isEmpty {
                EmptyState(symbol: "square.stack.3d.up.slash", title: stack.collecting ? "Copy something to add it" : "The Paste Stack is empty",
                           subtitle: "Start collecting (⇧⌘S), copy several items, then press ⌘V in any app to paste them one by one.")
                    .frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { i, e in
                            HStack(spacing: 10) {
                                Text("\(i + 1)").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(i == 0 ? theme.accentContrast : theme.text3)
                                    .frame(width: 20, height: 20).background(Circle().fill(i == 0 ? theme.accent : theme.kbdBg))
                                ClipIcon(entry: e, size: 20)
                                Text(ClipModel.title(e)).font(.system(size: 13)).foregroundStyle(theme.text).lineLimit(1)
                                Spacer()
                                if i == 0 { Text("Next").font(.system(size: 11)).foregroundStyle(theme.accentText) }
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 38)
                            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(i == sel ? theme.selected : .clear))
                        }
                    }
                    .padding(.horizontal, 8)
                }
            }
            N2HintBar(hints: [("↩", "paste next"), ("⌘↑⌘↓", "reorder"), ("⇧⌘S", stack.collecting ? "stop" : "collect"), ("⇧⌘O", "order"), ("⌃X", "remove")])
        }
        .overlay { N2PanelOverlay(panel: model.panel) }
        .onAppear { model.currentHost?.setFooter(primary: "Paste Next", hasActions: true) }
    }
}

extension ClipboardFeature {
    /// Start collecting again without dropping what is waiting.
    func resumeCollecting() {
        let waiting = stack.items
        var s = PasteStack.start(order: settings.stackOrder, limit: 0)
        s.items = waiting
        setStack(s)
    }
}
