import Foundation
import GlideCore

/// Raycast `MenuBarExtra` (serialised by the JS runtime as a `{type: "menubar", title?, icon?, tooltip?, isLoading,
/// items}` view) → a shared `StatusItemSpec`. Port of src/main/features/extensions/menubar-ext.ts. Pure: clicks are
/// routed through `invoke(handler)`.
enum MenuBarExtraModel {
    /// Status item id of a menu-bar command (Electron `menuBarId`).
    static func itemId(_ ext: String, _ command: String) -> String { "ext:\(ext)/\(command)" }

    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "tif", "tiff", "icns", "pdf", "svg", "heic", "webp"]

    /// Status items take SF Symbols, emoji or absolute image paths. `file://` URLs become paths, asset names resolve
    /// against the extension's assets folder; remote URLs, data URLs and colours are dropped.
    static func menuIcon(_ src: String?, assetsPath: String?) -> String? {
        guard let raw = src?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        if raw.lowercased().hasPrefix("file://") {
            let p = URL(string: raw)?.path ?? String(raw.dropFirst(7)).removingPercentEncoding ?? ""
            return p.hasPrefix("/") ? p : nil
        }
        if raw.range(of: "^(https?:|data:|#)", options: [.regularExpression, .caseInsensitive]) != nil { return nil }
        if raw.hasPrefix("/") { return raw }
        let ext = (raw as NSString).pathExtension.lowercased()
        if raw.contains("/") || imageExtensions.contains(ext) {
            guard let assetsPath, !raw.hasPrefix(".."), !raw.contains("/../") else { return nil }
            let p = (assetsPath as NSString).appendingPathComponent(raw)
            return FileManager.default.fileExists(atPath: p) ? p : nil
        }
        return raw
    }

    /// MenuBarExtra.Item / Section / Submenu / Separator entries → menu rows.
    static func entries(_ list: [JSONValue], assetsPath: String?, invoke: @escaping @MainActor (String) -> Void) -> [StatusMenuItem] {
        var out: [StatusMenuItem] = []
        for e in list {
            let kind = e["kind"]?.stringValue ?? "item"
            switch kind {
            case "separator":
                if !out.isEmpty, out.last?.kind != .separator { out.append(.separator) }
            case "section":
                let children = entries(e["children"]?.arrayValue ?? [], assetsPath: assetsPath, invoke: invoke)
                let title = e["title"]?.stringValue ?? ""
                if children.isEmpty && title.isEmpty { continue }
                if !out.isEmpty, out.last?.kind != .separator { out.append(.separator) }
                if !title.isEmpty { out.append(.header(title)) }
                out += children
                out.append(.separator)
            default:
                var item = StatusMenuItem(e["title"]?.stringValue ?? "", subtitle: e["subtitle"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
                                          icon: menuIcon(e["icon"]?.stringValue, assetsPath: assetsPath), tooltip: e["tooltip"]?.stringValue)
                if kind == "submenu" {
                    item.submenu = entries(e["children"]?.arrayValue ?? [], assetsPath: assetsPath, invoke: invoke)
                } else {
                    if let sc = e["shortcut"]?.stringValue, !sc.isEmpty { item.shortcut = sc }
                    if let h = e["handler"]?.stringValue, !h.isEmpty { item.onClick = { invoke(h) } } else { item.enabled = false }
                }
                out.append(item)
            }
        }
        while out.last?.kind == .separator { out.removeLast() }
        return out
    }

    /// The status item for a rendered `menubar` view. A status item needs something visible: the command title
    /// when there is neither title nor icon.
    static func spec(_ view: JSONValue, fallbackTitle: String, assetsPath: String?, invoke: @escaping @MainActor (String) -> Void) -> StatusItemSpec {
        var menu = entries(view["items"]?.arrayValue ?? [], assetsPath: assetsPath, invoke: invoke)
        let loading = view["isLoading"]?.boolValue == true
        if loading && menu.isEmpty { menu = [.info("Loading…")] }
        let icon = menuIcon(view["icon"]?.stringValue, assetsPath: assetsPath)
        let title = view["title"]?.stringValue ?? ""
        return StatusItemSpec(title: title.isEmpty && icon == nil ? fallbackTitle : title, icon: icon,
                              tooltip: view["tooltip"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }, menu: menu, isLoading: loading, section: fallbackTitle)
    }

    /// What a menu-bar command shows when it crashed or rendered something other than a MenuBarExtra.
    static func errorSpec(commandTitle: String, message: String) -> StatusItemSpec {
        StatusItemSpec(title: "⚠️", tooltip: "\(commandTitle) failed", menu: [.info("\(commandTitle) failed"), .info(String(message.prefix(120)))], section: commandTitle)
    }

    /// The first line of an error detail view's markdown (ExtensionSession.errorView).
    static func errorMessage(_ view: JSONValue) -> String {
        guard view["type"]?.stringValue == "detail", let md = view["markdown"]?.stringValue else { return "A menu-bar command must render <MenuBarExtra>" }
        let lines = md.split(separator: "\n", omittingEmptySubsequences: true).map(String.init).filter { !$0.hasPrefix("#") }
        return lines.first ?? "The command failed"
    }
}
