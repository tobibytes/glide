import GlideCore
import GlideFeatures
import GlideUI
import SwiftUI

/// Metrics shared by the view and the panel sizing.
enum LauncherMetrics {
    static let footer: CGFloat = 38
    static let sectionHeader: CGFloat = 30
    static let maxList: CGFloat = 420
    static let emptyList: CGFloat = 120
    static let listPadding: CGFloat = 14

    @MainActor static func height(_ c: LauncherController) -> CGFloat {
        let t = c.theme.tokens
        let head = CGFloat(t.headHeight) + 1
        if c.top != nil { return head + maxList + footer }
        if c.rows.isEmpty { return c.query.isEmpty && c.argument == nil ? head : head + emptyList + footer }
        var list: CGFloat = listPadding
        for r in c.rows {
            switch r.kind {
            case .header: list += sectionHeader
            case let .item(s, _): list += s.item.kind == .calculator ? 64 : CGFloat(t.rowHeight)
            }
        }
        let minForPanel: CGFloat = c.actionPanel != nil ? 330 : 0
        return head + max(minForPanel, min(maxList, list)) + footer
    }
}

/// Bridges a pushed feature view to the controller.
@MainActor final class ViewHostAdapter: LauncherViewHost {
    weak var controller: LauncherController?
    init(_ c: LauncherController) { controller = c }
    var query: String { controller?.query ?? "" }
    func setPlaceholder(_ text: String) { controller?.setTopPlaceholder(text) }
    func push(_ view: ViewID, payload: JSONValue) { controller?.push(view, payload: payload) }
    func pop() { controller?.pop() }
    func close() { controller?.hide() }
    func toast(_ message: String, style: ToastStyle) { controller?.showToast(message, style) }
    func setFooter(primary: String?, hasActions: Bool) { controller?.setTopFooter(primary: primary, hasActions: hasActions) }
    func setQuery(_ text: String) { controller?.query = text }
    func setTitle(_ title: String) { controller?.setTopTitle(title) }
    var viewStack: [ViewID] { controller?.stack.map(\.id) ?? [] }
    func setContextTitle(_ title: String) { controller?.setTopTitle(title) }
    var vimMode: VimMode? { controller.flatMap { $0.vimEnabled ? $0.mode : nil } }
    func popAndClose() { controller?.pop(); controller?.hide() }
}

struct LauncherView: View {
    @Bindable var controller: LauncherController
    let host: ViewHostAdapter

    private var theme: GlideTheme { controller.theme }

    var body: some View {
        let height = LauncherMetrics.height(controller)
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                SearchBar(text: $controller.query, placeholder: controller.placeholder, showsBack: controller.top != nil,
                          editable: !(controller.vimEnabled && controller.mode == .normal), focusToken: controller.focusToken) {
                    if let arg = controller.argument {
                        HStack(spacing: 6) {
                            ItemIconView(arg.item.item.icon, size: 16)
                            Text(arg.item.item.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                        }
                        .foregroundStyle(theme.accentText)
                        .padding(.horizontal, 8)
                        .frame(height: 26)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(theme.accentSoft))
                        if let m = arg.multi { ArgumentPills(state: m, text: controller.query) }
                    }
                }
                if height > CGFloat(theme.tokens.headHeight) + 1 {
                    Rectangle().fill(theme.border).frame(height: 1)
                    content.frame(maxHeight: .infinity)
                    Footer(toast: controller.toast, contextTitle: contextTitle, contextIcon: controller.top == nil ? controller.active?.item.icon : nil, primaryTitle: controller.primaryTitle,
                           hasActions: controller.top?.footerHasActions ?? (controller.active != nil), actionsOpen: controller.actionPanel != nil,
                           vimMode: controller.vimEnabled ? controller.mode : nil)
                }
            }
            if let p = controller.actionPanel {
                ActionPanel(title: p.item.item.title, actions: p.filtered, selectedIndex: p.selected, filter: p.filter)
                    .padding(.trailing, 10)
                    .padding(.bottom, LauncherMetrics.footer + 6)
                    .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottomTrailing)))
            }
        }
        .frame(width: CGFloat(theme.tokens.launcherWidth), height: height)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: CGFloat(theme.tokens.radius), style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CGFloat(theme.tokens.radius), style: .continuous).strokeBorder(theme.border, lineWidth: 1))
        .ignoresSafeArea()
        .glideTheme(theme)
        .animation(theme.animation, value: controller.actionPanel != nil)
    }

    private var contextTitle: String? { controller.contextTitle }

    @ViewBuilder private var background: some View {
        if theme.opaqueBackground || !theme.tokens.vibrancy {
            Color(theme.tokens.panelSolid)
        } else {
            ZStack {
                VibrancyBackground(material: VibrancyMaterial(bag: controller.settings.features[AppearanceSettings.featureId]).nsMaterial) // N8: appearance material
                theme.panel
            }
        }
    }

    @ViewBuilder private var content: some View {
        if let top = controller.top {
            pushed(top)
        } else if controller.rows.isEmpty {
            EmptyState(symbol: "magnifyingglass", title: "No results", subtitle: controller.query.isEmpty ? nil : "Nothing matches “\(controller.query)”")
        } else {
            list
        }
    }

    @ViewBuilder private func pushed(_ top: PushedView) -> some View {
        if let f = controller.registry.feature(top.id.feature) as? any FeatureUI, let v = f.launcherView(top.id, payload: top.payload, host: host) {
            v
        } else if top.id.rawValue == "glide.shortcuts" {
            ShortcutsView(filter: controller.query)
        } else {
            EmptyState(symbol: "questionmark.square.dashed", title: "Unknown view", subtitle: top.id.rawValue)
        }
    }

    private var list: some View {
        let selectedId = controller.itemRows[safe: controller.selectedIndex]?.row.id
        return ScrollViewReader { proxy in
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(controller.rows) { row in
                        switch row.kind {
                        case let .header(title): SectionHeader(title).frame(height: LauncherMetrics.sectionHeader, alignment: .bottom)
                        case let .item(s, index):
                            ResultRow(s, selected: row.id == selectedId, index: index)
                                .id(row.id)
                                .onTapGesture { Task { await controller.execute(s) } }
                        }
                    }
                }
                .padding(.horizontal, CGFloat(theme.tokens.listPadding.h))
                .padding(.top, 6)
                .padding(.bottom, 8)
            }
            .scrollIndicators(.never)
            .onChange(of: selectedId) { _, id in if let id { proxy.scrollTo(id) } }
        }
    }
}

/// Built-in pushed view: the vim / keyboard cheat sheet (exercise for the view stack).
struct ShortcutsView: View {
    @Environment(\.glideTheme) private var theme
    let filter: String
    var body: some View {
        let rows = Vim.cheatsheet.filter { filter.isEmpty || $0.0.localizedCaseInsensitiveContains(filter) }
        ScrollView {
            VStack(spacing: 0) {
                SectionHeader("Keyboard")
                ForEach(rows, id: \.0) { r in
                    HStack {
                        Text(r.0).font(theme.titleFont).foregroundStyle(theme.text)
                        Spacer()
                        HStack(spacing: 4) { ForEach(r.1.split(separator: " ").map(String.init), id: \.self) { Kbd($0) } }
                    }
                    .padding(.horizontal, 10)
                    .frame(height: CGFloat(theme.tokens.rowHeight))
                }
            }
            .padding(.horizontal, 8)
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { i >= 0 && i < count ? self[i] : nil }
}
