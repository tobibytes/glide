import Foundation
import GlideCore

// Port of src/main/features/menubar/core.ts + src/main/menubar.ts: every registration becomes its own status
// item once rendering is activated (never in headless mode: state only). Updates are diffed field by field and
// throttled per item; clicks dispatch by menu path from the *latest* spec.

public struct MenuBarMenuItem: @unchecked Sendable {
    public var title: String?
    public var subtitle: String?
    /// SF Symbol name or emoji.
    public var icon: String?
    /// Accelerator shown next to the item, e.g. "CommandOrControl+J".
    public var shortcut: String?
    public var enabled: Bool?
    public var checked: Bool?
    public var separator = false
    public var submenu: [MenuBarMenuItem]?
    public var onClick: (@MainActor () -> Void)?

    public init(title: String? = nil, subtitle: String? = nil, icon: String? = nil, shortcut: String? = nil, enabled: Bool? = nil, checked: Bool? = nil,
                submenu: [MenuBarMenuItem]? = nil, onClick: (@MainActor () -> Void)? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.shortcut = shortcut
        self.enabled = enabled
        self.checked = checked
        self.submenu = submenu
        self.onClick = onClick
    }

    public static var separatorItem: MenuBarMenuItem { var m = MenuBarMenuItem(); m.separator = true; return m }
    /// A disabled informational row.
    public static func info(_ title: String, _ subtitle: String? = nil) -> MenuBarMenuItem { MenuBarMenuItem(title: title, subtitle: subtitle, enabled: false) }
}

public struct MenuBarItemSpec: @unchecked Sendable {
    public var id: String
    public var title: String
    public var icon: String?
    public var tooltip: String?
    public var menu: [MenuBarMenuItem]
    public init(id: String, title: String = "", icon: String? = nil, tooltip: String? = nil, menu: [MenuBarMenuItem] = []) {
        self.id = id
        self.title = title
        self.icon = icon
        self.tooltip = tooltip
        self.menu = menu
    }
}

/// What a rendered status item can do (NSStatusItem adapter: StatusItemTray).
@MainActor public protocol TrayHandle: AnyObject {
    func setTitle(_ title: String)
    func setIcon(_ icon: String?)
    func setTooltip(_ tooltip: String)
    /// Items arrive with stable onClick wrappers (dispatching by path to the latest spec).
    func setMenu(_ menu: [MenuBarMenuItem])
    func destroy()
}

public typealias TrayFactory = @MainActor (String) -> TrayHandle

public enum MenuBarJSON {
    /// A menu without functions, as exposed to tests (`menubar.state`).
    public static func strip(_ items: [MenuBarMenuItem]) -> JSONValue {
        .array(items.map { m in
            if m.separator { return ["separator": true] }
            var o: [String: JSONValue] = [:]
            if let v = m.title { o["title"] = .string(v) }
            if let v = m.subtitle { o["subtitle"] = .string(v) }
            if let v = m.icon { o["icon"] = .string(v) }
            if let v = m.shortcut { o["shortcut"] = .string(v) }
            if let v = m.enabled { o["enabled"] = .bool(v) }
            if let v = m.checked { o["checked"] = .bool(v) }
            if m.onClick != nil { o["clickable"] = true }
            if let s = m.submenu { o["submenu"] = strip(s) }
            return .object(o)
        })
    }

    /// Structural key: equal keys mean the native menu does not need rebuilding.
    public static func key(_ items: [MenuBarMenuItem]) -> String {
        String(decoding: (try? JSONEncoder.glideCompact.encode(strip(items))) ?? Data(), as: UTF8.self)
    }
}

@MainActor public final class MenuBarManager {
    public struct Renders: Equatable, Sendable { public var title = 0, icon = 0, tooltip = 0, menu = 0 }

    private final class Entry {
        var spec: MenuBarItemSpec
        var tray: TrayHandle?
        var applied: (title: String?, icon: String??, tooltip: String?, menuKey: String?) = (nil, nil, nil, nil)
        var handlers: [String: @MainActor () -> Void] = [:]
        var lastApply = -Double.infinity
        var pending = false
        var generation = 0
        var renders = Renders()
        init(spec: MenuBarItemSpec) { self.spec = spec }
    }

    public static let defaultThrottleMs: Double = 250 // ≤ 4 renders per second per item
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var factory: TrayFactory?
    private var active = false
    private let throttleMs: Double
    private let now: () -> Double
    private let schedule: (Double, @escaping @MainActor () -> Void) -> Void
    public var onError: (String) -> Void = { _ in }

    /// `schedule(delayMs, fn)` defaults to the main queue; tests inject a manual clock.
    public init(throttleMs: Double = MenuBarManager.defaultThrottleMs, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
                schedule: ((Double, @escaping @MainActor () -> Void) -> Void)? = nil) {
        self.throttleMs = throttleMs
        self.now = now
        self.schedule = schedule ?? { ms, fn in
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) { MainActor.assumeIsolated { fn() } }
        }
    }

    private static func collect(_ items: [MenuBarMenuItem], _ prefix: String, _ out: inout [String: @MainActor () -> Void]) {
        for (i, m) in items.enumerated() {
            let p = prefix.isEmpty ? String(i) : "\(prefix).\(i)"
            if let f = m.onClick { out[p] = f }
            if let s = m.submenu { collect(s, p, &out) }
        }
    }

    private func wrap(_ items: [MenuBarMenuItem], _ prefix: String, id: String) -> [MenuBarMenuItem] {
        items.enumerated().map { i, m in
            let p = prefix.isEmpty ? String(i) : "\(prefix).\(i)"
            var out = m
            if m.onClick != nil { out.onClick = { [weak self] in _ = self?.click(id, path: p.split(separator: ".").compactMap { Int($0) }) } }
            if let s = m.submenu { out.submenu = wrap(s, p, id: id) }
            return out
        }
    }

    private func apply(_ e: Entry) {
        e.pending = false
        e.lastApply = now()
        guard active else { return }
        if let factory, e.tray == nil { e.tray = factory(e.spec.id) }
        let t = e.tray
        if e.spec.title != (e.applied.title ?? "") {
            e.applied.title = e.spec.title
            e.renders.title += 1
            t?.setTitle(e.spec.title)
        }
        if e.applied.icon == nil || e.applied.icon! != e.spec.icon {
            e.applied.icon = .some(e.spec.icon)
            e.renders.icon += 1
            t?.setIcon(e.spec.icon)
        }
        let tip = e.spec.tooltip ?? ""
        if tip != (e.applied.tooltip ?? "") {
            e.applied.tooltip = tip
            e.renders.tooltip += 1
            t?.setTooltip(tip)
        }
        let key = MenuBarJSON.key(e.spec.menu)
        if key != e.applied.menuKey {
            e.applied.menuKey = key
            e.renders.menu += 1
            t?.setMenu(wrap(e.spec.menu, "", id: e.spec.id))
        }
    }

    private func scheduleApply(_ e: Entry) {
        if e.pending { return } // a trailing render is queued; it picks up the latest spec
        let wait = e.lastApply + throttleMs - now()
        if wait <= 0 { apply(e); return }
        e.pending = true
        let gen = e.generation
        schedule(wait) { [weak self, weak e] in
            guard let self, let e, e.pending, e.generation == gen else { return }
            self.apply(e)
        }
    }

    private func setSpec(_ e: Entry, _ spec: MenuBarItemSpec) {
        e.spec = spec
        e.handlers = [:]
        Self.collect(spec.menu, "", &e.handlers)
    }

    private func destroy(_ e: Entry) {
        e.pending = false
        e.generation += 1
        e.tray?.destroy()
        e.tray = nil
        e.applied = (nil, nil, nil, nil)
        e.renders = Renders()
    }

    /// Register (or replace) a status item.
    public func register(_ spec: MenuBarItemSpec) {
        let e: Entry
        if let existing = entries[spec.id] { e = existing } else {
            e = Entry(spec: spec)
            entries[spec.id] = e
            order.append(spec.id)
        }
        setSpec(e, spec)
        scheduleApply(e)
    }

    /// Show (spec) or hide (nil) the item `id`.
    public func show(_ id: String, _ spec: MenuBarItemSpec?) {
        if var s = spec { s.id = id; register(s) } else { remove(id) }
    }

    public func remove(_ id: String) {
        guard let e = entries[id] else { return }
        destroy(e)
        entries[id] = nil
        order.removeAll { $0 == id }
    }

    public var ids: [String] { order }
    public func spec(_ id: String) -> MenuBarItemSpec? { entries[id]?.spec }
    public func renders(_ id: String) -> Renders? { entries[id]?.renders }

    /// Start rendering through `factory` (nil = keep state only, e.g. headless).
    public func activate(_ f: TrayFactory?) {
        factory = f
        active = true
        for id in order { if let e = entries[id] { apply(e) } }
    }

    public func deactivate() {
        active = false
        for e in entries.values { destroy(e) }
    }

    /// Apply pending throttled updates now.
    public func flush() { for id in order { if let e = entries[id], e.pending { apply(e) } } }

    @discardableResult
    public func click(_ id: String, path: [Int]) -> Bool {
        guard let fn = entries[id]?.handlers[path.map(String.init).joined(separator: ".")] else { return false }
        fn()
        return true
    }

    public func state() -> JSONValue {
        flush()
        return .array(order.compactMap { id in
            guard let e = entries[id] else { return nil }
            var o: [String: JSONValue] = ["id": .string(id), "title": .string(e.spec.title), "menu": MenuBarJSON.strip(e.spec.menu), "rendered": .bool(e.tray != nil),
                                          "renders": ["title": .int(Int64(e.renders.title)), "icon": .int(Int64(e.renders.icon)),
                                                      "tooltip": .int(Int64(e.renders.tooltip)), "menu": .int(Int64(e.renders.menu))]]
            if let i = e.spec.icon { o["icon"] = .string(i) }
            if let t = e.spec.tooltip, !t.isEmpty { o["tooltip"] = .string(t) }
            return .object(o)
        })
    }
}
