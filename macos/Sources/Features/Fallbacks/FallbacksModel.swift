import Foundation
import GlideCore

/// Pure model for fallback commands (port of src/main/features/fallbacks/model.ts): built-ins, user-added ones
/// and quicklinks, in a user-chosen order. Settings bag `settings.features.fallbacks` = {order, disabled, custom, quicklinks}.
public enum FallbacksModel {
    public enum Action: String, Sendable { case url, files, ai, agent }
    public enum Source: String, Sendable { case builtin, custom, quicklink }

    public struct Def: Equatable, Sendable {
        public var id: String
        public var name: String
        public var url: String?
        public var action: Action
        public var icon: ItemIcon
        public var source: Source
    }

    public struct Custom: Equatable, Sendable {
        public var id: String
        public var name: String
        public var url: String
    }

    public struct Prefs: Equatable, Sendable {
        public var order: [String] = []
        public var disabled: [String] = ["duckduckgo", "maps"]
        public var custom: [Custom] = []
        public var quicklinks: [String] = []
        public init() {}

        public init(bag: [String: JSONValue]) {
            func strings(_ k: String) -> [String]? { bag[k]?.arrayValue?.compactMap(\.stringValue) }
            order = strings("order") ?? []
            disabled = strings("disabled") ?? ["duckduckgo", "maps"]
            quicklinks = strings("quicklinks") ?? []
            custom = (bag["custom"]?.arrayValue ?? []).compactMap { c in
                guard let id = c["id"]?.stringValue, let n = c["name"]?.stringValue, let u = c["url"]?.stringValue else { return nil }
                return Custom(id: id, name: n, url: u)
            }
        }

        public var bag: [String: JSONValue] {
            ["order": .array(order.map(JSONValue.string)), "disabled": .array(disabled.map(JSONValue.string)), "quicklinks": .array(quicklinks.map(JSONValue.string)),
             "custom": .array(custom.map { ["id": .string($0.id), "name": .string($0.name), "url": .string($0.url)] })]
        }
    }

    public static let builtins: [Def] = [
        Def(id: "google", name: "Search Google", url: "https://www.google.com/search?q={query}", action: .url, icon: .emoji("🔎"), source: .builtin),
        Def(id: "files", name: "Search Files", url: nil, action: .files, icon: .emoji("📂"), source: .builtin),
        Def(id: "ai", name: "Ask AI", url: nil, action: .ai, icon: .emoji("✨"), source: .builtin),
        Def(id: "agent", name: "Ask Glide Agent", url: nil, action: .agent, icon: .emoji("🪄"), source: .builtin),
        Def(id: "duckduckgo", name: "Search DuckDuckGo", url: "https://duckduckgo.com/?q={query}", action: .url, icon: .emoji("🦆"), source: .builtin),
        Def(id: "github", name: "Search GitHub", url: "https://github.com/search?q={query}", action: .url, icon: .emoji("🐙"), source: .builtin),
        Def(id: "youtube", name: "Search YouTube", url: "https://www.youtube.com/results?search_query={query}", action: .url, icon: .emoji("▶️"), source: .builtin),
        Def(id: "maps", name: "Search Maps", url: "maps://?q={query}", action: .url, icon: .emoji("🗺️"), source: .builtin),
    ]

    public static func quicklinkFallbackId(_ id: String) -> String { "ql-\(id)" }

    /// Every known fallback (enabled or not) in the user's order.
    public static func ordered(_ p: Prefs, quicklinks: [Quicklink]) -> [Def] {
        var pool = builtins
        pool += p.custom.map { Def(id: $0.id, name: $0.name, url: $0.url, action: .url, icon: .emoji("🌐"), source: .custom) }
        pool += quicklinks.filter { p.quicklinks.contains($0.id) }.map {
            Def(id: quicklinkFallbackId($0.id), name: $0.name, url: $0.url, action: .url, icon: $0.icon ?? .emoji("🔗"), source: .quicklink)
        }
        var byId: [String: Def] = [:]
        for d in pool { byId[d.id] = d }
        var out: [Def] = []
        for id in p.order { if let d = byId.removeValue(forKey: id) { out.append(d) } }
        return out + pool.filter { byId[$0.id] != nil }
    }

    public static func enabled(_ p: Prefs, quicklinks: [Quicklink]) -> [Def] {
        let off = Set(p.disabled)
        return ordered(p, quicklinks: quicklinks).filter { !off.contains($0.id) }
    }

    /// Move `id` by `delta` positions (clamped).
    public static func move(_ ids: [String], _ id: String, by delta: Int) -> [String] {
        guard let from = ids.firstIndex(of: id) else { return ids }
        let to = min(ids.count - 1, max(0, from + delta))
        var next = ids
        next.remove(at: from)
        next.insert(id, at: to)
        return next
    }

    /// Fill `{query}` (URL-encoded, encodeURIComponent).
    public static func fill(_ url: String, query: String) -> String {
        url.replacingOccurrences(of: "{query}", with: QuicklinkURL.encodeComponent(query))
    }

    public static func validate(_ url: String) -> String? {
        let u = url.trimmingCharacters(in: .whitespaces)
        if u.isEmpty { return "URL is required" }
        if !u.contains("{query}") { return "URL must contain {query}" }
        if u.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*:", options: .regularExpression) == nil { return "URL needs a scheme, e.g. https://" }
        return nil
    }
}
