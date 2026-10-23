import Foundation

// Shared menu-bar (status item) API. Features show / update / remove a titled status item with a menu through
// `SystemServices.statusItems`; the app registers Glide's own icon as the "glide" item. Items placed
// `.combinable` (Timers, Focus, the Menu Bar feature's Timers extra) merge into Glide's icon while
// `combineWithGlideIcon` is on: their titles join the Glide icon's title and their rows become a section of
// Glide's menu. GlideSystem renders composed items as NSStatusItems (live) or records them (headless fake).

/// One row of a status item menu.
public struct StatusMenuItem: @unchecked Sendable {
    public enum Kind: String, Sendable { case item, separator, header }
    public var kind: Kind
    public var title: String
    public var subtitle: String?
    /// SF Symbol name, emoji, or an absolute image path.
    public var icon: String?
    /// "⌘⇧R" (display glyphs) or "CommandOrControl+Shift+R" (accelerator).
    public var shortcut: String?
    public var enabled: Bool
    public var checked: Bool
    public var tooltip: String?
    public var submenu: [StatusMenuItem]?
    public var onClick: (@MainActor () -> Void)?

    public init(_ title: String, subtitle: String? = nil, icon: String? = nil, shortcut: String? = nil, enabled: Bool = true, checked: Bool = false,
                tooltip: String? = nil, submenu: [StatusMenuItem]? = nil, onClick: (@MainActor () -> Void)? = nil) {
        kind = .item
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.shortcut = shortcut
        self.enabled = enabled
        self.checked = checked
        self.tooltip = tooltip
        self.submenu = submenu
        self.onClick = onClick
    }

    public static var separator: StatusMenuItem { var m = StatusMenuItem(""); m.kind = .separator; return m }
    /// A section heading (non-clickable).
    public static func header(_ title: String) -> StatusMenuItem { var m = StatusMenuItem(title, enabled: false); m.kind = .header; return m }
    /// A disabled informational row.
    public static func info(_ title: String, _ subtitle: String? = nil) -> StatusMenuItem { StatusMenuItem(title, subtitle: subtitle, enabled: false) }
}

/// What a status item shows.
public struct StatusItemSpec: @unchecked Sendable {
    public var title: String
    public var icon: String?
    public var tooltip: String?
    public var menu: [StatusMenuItem]
    public var isLoading: Bool
    /// Heading of this item's rows when merged into Glide's menu (default: none).
    public var section: String?
    /// Called when the item's menu is about to open (refresh data, re-run a command).
    public var onMenuOpen: (@MainActor () -> Void)?

    public init(title: String = "", icon: String? = nil, tooltip: String? = nil, menu: [StatusMenuItem] = [], isLoading: Bool = false,
                section: String? = nil, onMenuOpen: (@MainActor () -> Void)? = nil) {
        self.title = title
        self.icon = icon
        self.tooltip = tooltip
        self.menu = menu
        self.isLoading = isLoading
        self.section = section
        self.onMenuOpen = onMenuOpen
    }
}

public enum StatusItemPlacement: String, Sendable {
    /// Always its own icon (extension menu-bar commands, system monitor, …).
    case separate
    /// Merged into Glide's icon while `combineWithGlideIcon` is on, its own icon otherwise.
    case combinable
}

/// A status item as it appears in the menu bar after merging.
public struct ComposedStatusItem: @unchecked Sendable {
    public var id: String
    public var title: String
    public var icon: String?
    public var tooltip: String?
    public var menu: [StatusMenuItem]
    public var isLoading: Bool
    /// Item ids that make up this one (the Glide icon lists its merged contributors).
    public var sources: [String]
    public init(id: String, title: String, icon: String?, tooltip: String?, menu: [StatusMenuItem], isLoading: Bool, sources: [String]) {
        self.id = id
        self.title = title
        self.icon = icon
        self.tooltip = tooltip
        self.menu = menu
        self.isLoading = isLoading
        self.sources = sources
    }
}

public enum StatusItemComposer {
    public static let glideID = "glide"
    public static let glideIcon = "sparkle.magnifyingglass"
    public static let titleSeparator = "  "

    public struct Entry: @unchecked Sendable {
        public var id: String
        public var spec: StatusItemSpec
        public var placement: StatusItemPlacement
        public init(id: String, spec: StatusItemSpec, placement: StatusItemPlacement) {
            self.id = id
            self.spec = spec
            self.placement = placement
        }
    }

    /// Titles next to one icon, in order, empty ones skipped.
    public static func joinTitles(_ titles: [String]) -> String {
        titles.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: titleSeparator)
    }

    /// Drop leading / trailing / doubled separators.
    public static func tidy(_ items: [StatusMenuItem]) -> [StatusMenuItem] {
        var out: [StatusMenuItem] = []
        for m in items {
            if m.kind == .separator, out.isEmpty || out.last?.kind == .separator { continue }
            out.append(m)
        }
        while out.last?.kind == .separator { out.removeLast() }
        return out
    }

    /// Merge `entries` (in order) with Glide's own item. With `combine` on, `.combinable` entries become sections of
    /// the Glide item; everything else (and every entry with `combine` off) is its own item. The Glide item is listed
    /// first when it exists (registered by the app, or needed for merged entries).
    public static func compose(glide: StatusItemSpec?, entries: [Entry], combine: Bool) -> [ComposedStatusItem] {
        let merged = combine ? entries.filter { $0.placement == .combinable } : []
        var out: [ComposedStatusItem] = []
        if glide != nil || !merged.isEmpty {
            let base = glide ?? StatusItemSpec(icon: glideIcon)
            var menu: [StatusMenuItem] = []
            for e in merged {
                if let s = e.spec.section, !s.isEmpty { menu.append(.header(s)) }
                menu += e.spec.menu.isEmpty && e.spec.isLoading ? [.info("Loading…")] : e.spec.menu
                menu.append(.separator)
            }
            menu += base.menu
            let tips = merged.compactMap(\.spec.tooltip).filter { !$0.isEmpty }
            out.append(ComposedStatusItem(id: glideID, title: joinTitles([base.title] + merged.map(\.spec.title)), icon: base.icon ?? glideIcon,
                                          tooltip: tips.isEmpty ? base.tooltip : ([base.tooltip ?? "Glide"] + tips).joined(separator: " · "),
                                          menu: tidy(menu), isLoading: merged.contains { $0.spec.isLoading }, sources: merged.map(\.id)))
        }
        for e in entries where !(combine && e.placement == .combinable) {
            let menu = e.spec.menu.isEmpty && e.spec.isLoading ? [StatusMenuItem.info("Loading…")] : e.spec.menu
            // A status item needs something visible.
            let title = e.spec.title.isEmpty && e.spec.icon == nil ? (e.spec.section ?? e.id) : e.spec.title
            out.append(ComposedStatusItem(id: e.id, title: title, icon: e.spec.icon, tooltip: e.spec.tooltip, menu: tidy(menu), isLoading: e.spec.isLoading, sources: [e.id]))
        }
        return out
    }

    /// The row at `path` (indices into nested submenus).
    public static func item(_ menu: [StatusMenuItem], path: [Int]) -> StatusMenuItem? {
        guard let first = path.first, first >= 0, first < menu.count else { return nil }
        let m = menu[first]
        if path.count == 1 { return m }
        return item(m.submenu ?? [], path: Array(path.dropFirst()))
    }
}

public enum StatusMenuJSON {
    /// A menu without functions (tests, diffing).
    public static func strip(_ items: [StatusMenuItem]) -> JSONValue {
        .array(items.map { m in
            switch m.kind {
            case .separator: return ["separator": true]
            case .header: return ["header": .string(m.title)]
            case .item: break
            }
            var o: [String: JSONValue] = ["title": .string(m.title)]
            if let v = m.subtitle { o["subtitle"] = .string(v) }
            if let v = m.icon { o["icon"] = .string(v) }
            if let v = m.shortcut { o["shortcut"] = .string(v) }
            if !m.enabled { o["enabled"] = false }
            if m.checked { o["checked"] = true }
            if let v = m.tooltip { o["tooltip"] = .string(v) }
            if m.onClick != nil { o["clickable"] = true }
            if let s = m.submenu { o["submenu"] = strip(s) }
            return .object(o)
        })
    }

    /// Structural key: equal keys mean a native menu does not need rebuilding.
    public static func key(_ items: [StatusMenuItem]) -> String {
        String(decoding: (try? JSONEncoder.glideCompact.encode(strip(items))) ?? Data(), as: UTF8.self)
    }

    public static func item(_ c: ComposedStatusItem) -> JSONValue {
        var o: [String: JSONValue] = ["id": .string(c.id), "title": .string(c.title), "menu": strip(c.menu), "isLoading": .bool(c.isLoading),
                                      "sources": .array(c.sources.map(JSONValue.string))]
        if let i = c.icon { o["icon"] = .string(i) }
        if let t = c.tooltip, !t.isEmpty { o["tooltip"] = .string(t) }
        return .object(o)
    }
}

/// Status items for features (`context.services.statusItems`).
@MainActor public protocol StatusItemService: AnyObject {
    /// Merge `.combinable` items into Glide's icon (setting "Show timers and focus in Glide's menu bar icon").
    var combineWithGlideIcon: Bool { get set }
    /// Glide's own icon (the app sets it; nil removes it).
    func setGlideItem(_ spec: StatusItemSpec?)
    /// Show or update the item `id` (ids are global: prefix them with the feature id).
    func show(_ id: String, _ spec: StatusItemSpec, placement: StatusItemPlacement)
    func remove(_ id: String)
    /// Composed items as rendered (`{combineWithGlideIcon, items, entries}`).
    func state() -> JSONValue
    /// Click the row at `path` of composed item `id` (its menu, after merging). False when there is no handler.
    @discardableResult func click(_ id: String, path: [Int]) -> Bool
    /// The composed item's menu is opening: notifies `onMenuOpen` of the item (and of everything merged into it).
    func menuWillOpen(_ id: String)
}

/// The shared bookkeeping (composition, clicks, menu-open callbacks). Subclasses render: GlideSystem's
/// `SystemStatusItemService` (NSStatusItem) and `HeadlessStatusItems` (records only). Used as is it keeps state
/// only (unit tests building `SystemServices` by hand).
@MainActor open class StatusItemHub: StatusItemService {
    private var glide: StatusItemSpec?
    private var entries: [StatusItemComposer.Entry] = []
    public private(set) var composed: [ComposedStatusItem] = []
    public private(set) var menuOpens: [String: Int] = [:]
    public var combineWithGlideIcon = true { didSet { if oldValue != combineWithGlideIcon { recompose() } } }

    public init() {}

    public func setGlideItem(_ spec: StatusItemSpec?) {
        glide = spec
        recompose()
    }

    public func show(_ id: String, _ spec: StatusItemSpec, placement: StatusItemPlacement) {
        let e = StatusItemComposer.Entry(id: id, spec: spec, placement: placement)
        if let i = entries.firstIndex(where: { $0.id == id }) { entries[i] = e } else { entries.append(e) }
        recompose()
    }

    public func remove(_ id: String) {
        guard entries.contains(where: { $0.id == id }) else { return }
        entries.removeAll { $0.id == id }
        recompose()
    }

    public func entry(_ id: String) -> StatusItemComposer.Entry? { entries.first { $0.id == id } }

    private func recompose() {
        let next = StatusItemComposer.compose(glide: glide, entries: entries, combine: combineWithGlideIcon)
        let gone = composed.map(\.id).filter { id in !next.contains { $0.id == id } }
        composed = next
        render(next, removed: gone)
    }

    /// Override to put `items` on screen; `removed` ids are no longer shown.
    open func render(_ items: [ComposedStatusItem], removed: [String]) {}

    @discardableResult public func click(_ id: String, path: [Int]) -> Bool {
        guard let c = composed.first(where: { $0.id == id }), let m = StatusItemComposer.item(c.menu, path: path), m.enabled, let f = m.onClick else { return false }
        f()
        return true
    }

    public func menuWillOpen(_ id: String) {
        guard let c = composed.first(where: { $0.id == id }) else { return }
        menuOpens[id, default: 0] += 1
        if id == StatusItemComposer.glideID { glide?.onMenuOpen?() }
        for s in c.sources { entries.first { $0.id == s }?.spec.onMenuOpen?() }
    }

    public func state() -> JSONValue {
        ["combineWithGlideIcon": .bool(combineWithGlideIcon),
         "items": .array(composed.map(StatusMenuJSON.item)),
         "entries": .array(entries.map { ["id": .string($0.id), "placement": .string($0.placement.rawValue), "title": .string($0.spec.title)] }),
         "menuOpens": .object(menuOpens.mapValues { .int(Int64($0)) })]
    }
}
