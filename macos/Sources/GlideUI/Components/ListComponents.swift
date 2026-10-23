import AppKit
import GlideCore
import SwiftUI

public struct SectionHeader: View {
    @Environment(\.glideTheme) private var theme
    let title: String
    let trailing: String?
    public init(_ title: String, trailing: String? = nil) {
        self.title = title
        self.trailing = trailing
    }
    public var body: some View {
        HStack {
            Text(title).font(theme.sectionFont).foregroundStyle(theme.text3)
            Spacer()
            if let trailing { Text(trailing).font(.system(size: 11)).foregroundStyle(theme.text3) }
        }
        .padding(.horizontal, 10)
        .padding(.top, 10)
        .padding(.bottom, 3)
    }
}

/// One result row: icon, highlighted title, subtitle, alias/argument tags, hotkey (selected), star, kind.
public struct ResultRow: View {
    @Environment(\.glideTheme) private var theme
    let scored: ScoredItem
    let selected: Bool
    let index: Int?

    public init(_ scored: ScoredItem, selected: Bool, index: Int? = nil) {
        self.scored = scored
        self.selected = selected
        self.index = index
    }

    private var item: SearchItem { scored.item }
    private var isCalc: Bool { item.kind == .calculator }

    public var body: some View {
        HStack(spacing: theme.tokens.rowGap) {
            if isCalc {
                ZStack {
                    RoundedRectangle(cornerRadius: 9, style: .continuous).fill(theme.accentSoft)
                    Image(systemName: "equal").font(.system(size: 18, weight: .semibold)).foregroundStyle(theme.accentText)
                }
                .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.system(size: 26, weight: .semibold)).foregroundStyle(theme.text).lineLimit(1)
                    if let s = item.subtitle { Text(s).font(theme.subtitleFont).foregroundStyle(theme.text3) }
                }
                Spacer(minLength: 8)
            } else {
                ItemIconView(item.icon, size: theme.tokens.iconSize, fallbackSymbol: item.kind == .file ? "doc" : "app.dashed")
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    HighlightedText(item.title, ranges: scored.ranges, font: theme.titleFont).layoutPriority(1)
                    if let s = item.subtitle, !s.isEmpty {
                        Text(s).font(theme.subtitleFont).foregroundStyle(theme.text3).lineLimit(1).truncationMode(.tail)
                    }
                    if let a = item.alias, !a.isEmpty { Tag(a, accent: true) }
                    if let arg = scored.argument, !arg.isEmpty { Tag(arg) }
                }
                Spacer(minLength: 8)
                HStack(spacing: 8) {
                    if selected, let hk = item.hotkey { Kbd(hk) }
                    if item.favorite == true { Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(theme.accent) }
                    if !selected, let index, index < 9 { Text("⌘\(index + 1)").font(.system(size: 11)).foregroundStyle(theme.text3.opacity(0.0)) }
                    Text(item.displayKind).font(.system(size: theme.tokens.fontSubtitle - 0.5)).foregroundStyle(theme.text3).frame(minWidth: 70, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: isCalc ? 64 : theme.tokens.rowHeight)
        .background(
            RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous)
                .fill(selected ? theme.selected : .clear)
                .overlay(RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous).strokeBorder(selected ? theme.selectedRing : .clear, lineWidth: 1))
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

public struct EmptyState: View {
    @Environment(\.glideTheme) private var theme
    let symbol: String
    let title: String
    let subtitle: String?
    public init(symbol: String = "magnifyingglass", title: String, subtitle: String? = nil) {
        self.symbol = symbol
        self.title = title
        self.subtitle = subtitle
    }
    public var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 28, weight: .light)).foregroundStyle(theme.text3)
            Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text2)
            if let subtitle { Text(subtitle).font(.system(size: 12)).foregroundStyle(theme.text3).multilineTextAlignment(.center) }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
    }
}

/// List + detail pane (clipboard history, files, emoji…).
public struct DetailSplit<List: View, Detail: View>: View {
    @Environment(\.glideTheme) private var theme
    let ratio: CGFloat
    let list: List
    let detail: Detail
    public init(ratio: CGFloat = 0.42, @ViewBuilder list: () -> List, @ViewBuilder detail: () -> Detail) {
        self.ratio = ratio
        self.list = list()
        self.detail = detail()
    }
    public var body: some View {
        GeometryReader { geo in
            HStack(spacing: 0) {
                list.frame(width: geo.size.width * ratio)
                Rectangle().fill(theme.border).frame(width: 1)
                detail.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }
}

public struct ToastData: Equatable, Sendable {
    public var message: String
    public var style: ToastStyle
    public init(message: String, style: ToastStyle = .info) {
        self.message = message
        self.style = style
    }
}

public struct ToastView: View {
    @Environment(\.glideTheme) private var theme
    let toast: ToastData
    public init(_ toast: ToastData) { self.toast = toast }
    public var body: some View {
        HStack(spacing: 7) {
            Image(systemName: toast.style == .error ? "exclamationmark.triangle.fill" : toast.style == .success ? "checkmark.circle.fill" : "info.circle.fill")
                .foregroundStyle(toast.style == .error ? theme.danger : toast.style == .success ? theme.success : theme.accent)
            Text(toast.message).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text).lineLimit(1)
        }
        .font(.system(size: 12))
    }
}

/// Bottom bar: toast or context on the left; primary action + ⏎, Actions ⌘K and the vim pill on the right.
public struct Footer: View {
    @Environment(\.glideTheme) private var theme
    let toast: ToastData?
    let contextTitle: String?
    let contextIcon: ItemIcon?
    let primaryTitle: String?
    let hasActions: Bool
    let actionsOpen: Bool
    let vimMode: VimMode?

    public init(toast: ToastData?, contextTitle: String?, contextIcon: ItemIcon?, primaryTitle: String?, hasActions: Bool, actionsOpen: Bool = false, vimMode: VimMode?) {
        self.toast = toast
        self.contextTitle = contextTitle
        self.contextIcon = contextIcon
        self.primaryTitle = primaryTitle
        self.hasActions = hasActions
        self.actionsOpen = actionsOpen
        self.vimMode = vimMode
    }

    public var body: some View {
        HStack(spacing: 8) {
            if let toast {
                ToastView(toast).transition(.opacity)
            } else {
                HStack(spacing: 7) {
                    if let contextIcon { ItemIconView(contextIcon, size: 16) } else {
                        Image(systemName: "sparkle").font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.accent)
                    }
                    Text(contextTitle ?? "Glide").font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text2).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if let primaryTitle {
                HStack(spacing: 6) {
                    Text(primaryTitle).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text)
                    Kbd("↩")
                }
            }
            if hasActions {
                Rectangle().fill(theme.borderStrong).frame(width: 1, height: 14).padding(.horizontal, 2)
                HStack(spacing: 6) {
                    Text("Actions").font(.system(size: 12, weight: .medium)).foregroundStyle(actionsOpen ? theme.text : theme.text2)
                    Kbd("⌘K")
                }
                .padding(.horizontal, 6)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(actionsOpen ? theme.selected : .clear))
            }
            if let vimMode { VimPill(vimMode) }
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .frame(height: 38)
        .background(theme.hover)
        .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 1) }
    }
}

/// ⌘K panel: title, actions with shortcuts, filter field.
public struct ActionPanel: View {
    @Environment(\.glideTheme) private var theme
    let title: String
    let actions: [ItemAction]
    let selectedIndex: Int
    let filter: String

    public init(title: String, actions: [ItemAction], selectedIndex: Int, filter: String) {
        self.title = title
        self.actions = actions
        self.selectedIndex = selectedIndex
        self.filter = filter
    }

    public var body: some View {
        VStack(spacing: 0) {
            Text(title.uppercased())
                .font(.system(size: 10.5, weight: .semibold)).tracking(0.6).foregroundStyle(theme.text3).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.top, 9).padding(.bottom, 4)
            if actions.isEmpty {
                Text("No matching actions").font(.system(size: 12.5)).foregroundStyle(theme.text3).padding(14)
            }
            VStack(spacing: 1) {
                ForEach(Array(actions.enumerated()), id: \.element.id) { i, a in
                    HStack(spacing: 8) {
                        if let icon = a.icon {
                            if NSImage(systemSymbolName: icon, accessibilityDescription: nil) != nil {
                                Image(systemName: icon).font(.system(size: 12)).frame(width: 18).foregroundStyle(a.destructive ? theme.danger : theme.text2)
                            } else {
                                Text(icon).font(.system(size: 12)).frame(width: 18)
                            }
                        } else {
                            Color.clear.frame(width: 18, height: 1)
                        }
                        Text(a.title).font(.system(size: 13)).foregroundStyle(a.destructive ? theme.danger : theme.text).lineLimit(1)
                        Spacer(minLength: 6)
                        if let s = a.shortcut { Kbd(s) }
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 32)
                    .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(i == selectedIndex ? theme.selected : .clear))
                }
            }
            .padding(6)
            HStack {
                Text(filter.isEmpty ? "Search for actions…" : filter).font(.system(size: 13)).foregroundStyle(filter.isEmpty ? theme.text3 : theme.text)
                Spacer()
            }
            .padding(.horizontal, 14)
            .frame(height: 36)
            .overlay(alignment: .top) { Rectangle().fill(theme.border).frame(height: 1) }
        }
        .frame(width: 320)
        .background(RoundedRectangle(cornerRadius: theme.tokens.radiusSm + 3, style: .continuous).fill(theme.panelSolid))
        .overlay(RoundedRectangle(cornerRadius: theme.tokens.radiusSm + 3, style: .continuous).strokeBorder(theme.borderStrong, lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 20, y: 10)
    }
}
