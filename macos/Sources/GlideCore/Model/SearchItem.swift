import Foundation

/// Mirrors `ItemKind` in src/shared/types.ts. A struct (not an enum) so unknown kinds written by a newer
/// Glide survive a round trip. Feature-provided rows use `.command` + `feature` + `kindLabel`.
public struct ItemKind: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ raw: String) { rawValue = raw }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var description: String { rawValue }

    public static let app = ItemKind("app")
    public static let system = ItemKind("system")
    public static let workflow = ItemKind("workflow")
    public static let quicklink = ItemKind("quicklink")
    public static let snippet = ItemKind("snippet")
    public static let file = ItemKind("file")
    public static let calculator = ItemKind("calculator")
    public static let setting = ItemKind("setting")
    public static let fallback = ItemKind("fallback")
    public static let command = ItemKind("command")

    /// Label for the kind column (src/renderer/lib/icons.ts KIND_LABEL).
    public var label: String {
        switch rawValue {
        case "app": return "Application"
        case "system": return "Command"
        case "workflow": return "Workflow"
        case "quicklink": return "Quicklink"
        case "snippet": return "Snippet"
        case "file": return "File"
        case "calculator": return "Calculator"
        case "setting": return "Setting"
        case "fallback": return "Fallback"
        default: return "Command"
        }
    }
}

/// `ItemIcon`: emoji | symbol (SF Symbol name) | app (bundle path) | file (path) | url | color (#rrggbb).
public struct ItemIcon: Hashable, Codable, Sendable {
    public var kind: String
    public var value: String
    public var tint: String?
    public var extra: [String: JSONValue] = [:]

    public init(kind: String, value: String, tint: String? = nil) {
        self.kind = kind
        self.value = value
        self.tint = tint
    }

    public static func emoji(_ v: String) -> ItemIcon { ItemIcon(kind: "emoji", value: v) }
    public static func symbol(_ v: String, tint: String? = nil) -> ItemIcon { ItemIcon(kind: "symbol", value: v, tint: tint) }
    public static func app(_ path: String) -> ItemIcon { ItemIcon(kind: "app", value: path) }
    public static func file(_ path: String) -> ItemIcon { ItemIcon(kind: "file", value: path) }
    /// An image URL: `data:image/…;base64,…`, `file://…`, or an http(s) favicon/page URL (Electron kind "url").
    public static func url(_ url: String) -> ItemIcon { ItemIcon(kind: "url", value: url) }

    static let knownKeys: Set<String> = ["kind", "value", "tint"]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        kind = r.string("kind") ?? "emoji"
        value = r.string("value") ?? ""
        tint = r.string("tint")
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("kind", kind)
        try w.set("value", value)
        try w.set("tint", tint)
        try w.finish()
    }
}

/// `SearchItem` from src/shared/types.ts. Item ids keep the Electron scheme (`app:<path>`, `system:<id>`,
/// `workflow:<id>`, `quicklink:<id>`, `snippet:<id>`, `setting:<id>`, feature ids) so usage.json, favorites,
/// aliases and hotkeys carry over.
public struct SearchItem: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var kind: ItemKind
    public var title: String
    public var subtitle: String?
    public var icon: ItemIcon?
    public var keywords: [String]?
    public var alias: String?
    public var hotkey: String?
    public var favorite: Bool?
    public var path: String?
    public var url: String?
    public var text: String?
    public var workflowId: String?
    public var command: String?
    public var source: String?
    public var acceptsArgument: Bool?
    public var feature: String?
    public var data: [String: JSONValue]?
    public var kindLabel: String?
    public var extra: [String: JSONValue] = [:]

    public init(
        id: String, kind: ItemKind, title: String, subtitle: String? = nil, icon: ItemIcon? = nil,
        keywords: [String]? = nil, alias: String? = nil, hotkey: String? = nil, favorite: Bool? = nil,
        path: String? = nil, url: String? = nil, text: String? = nil, workflowId: String? = nil,
        command: String? = nil, source: String? = nil, acceptsArgument: Bool? = nil, feature: String? = nil,
        data: [String: JSONValue]? = nil, kindLabel: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
        self.keywords = keywords
        self.alias = alias
        self.hotkey = hotkey
        self.favorite = favorite
        self.path = path
        self.url = url
        self.text = text
        self.workflowId = workflowId
        self.command = command
        self.source = source
        self.acceptsArgument = acceptsArgument
        self.feature = feature
        self.data = data
        self.kindLabel = kindLabel
    }

    /// Kind column text: the feature's kindLabel wins over the generic kind name.
    public var displayKind: String { kindLabel?.isEmpty == false ? kindLabel! : kind.label }

    static let knownKeys: Set<String> = [
        "id", "kind", "title", "subtitle", "icon", "keywords", "alias", "hotkey", "favorite", "path", "url", "text",
        "workflowId", "command", "source", "acceptsArgument", "feature", "data", "kindLabel",
    ]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        id = r.string("id") ?? ""
        kind = ItemKind(r.string("kind") ?? "command")
        title = r.string("title") ?? ""
        subtitle = r.string("subtitle")
        icon = r.value(ItemIcon.self, "icon")
        keywords = r.strings("keywords")
        alias = r.string("alias")
        hotkey = r.string("hotkey")
        favorite = r.bool("favorite")
        path = r.string("path")
        url = r.string("url")
        text = r.string("text")
        workflowId = r.string("workflowId")
        command = r.string("command")
        source = r.string("source")
        acceptsArgument = r.bool("acceptsArgument")
        feature = r.string("feature")
        data = r.object("data")
        kindLabel = r.string("kindLabel")
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("id", id)
        try w.set("kind", kind)
        try w.set("title", title)
        try w.set("subtitle", subtitle)
        try w.set("icon", icon)
        try w.set("keywords", keywords)
        try w.set("alias", alias)
        try w.set("hotkey", hotkey)
        try w.set("favorite", favorite)
        try w.set("path", path)
        try w.set("url", url)
        try w.set("text", text)
        try w.set("workflowId", workflowId)
        try w.set("command", command)
        try w.set("source", source)
        try w.set("acceptsArgument", acceptsArgument)
        try w.set("feature", feature)
        try w.set("data", data)
        try w.set("kindLabel", kindLabel)
        try w.finish()
    }
}

/// Character range in the title, in UTF-16 code units (the engine's index space, same as the TS port).
public struct MatchRange: Hashable, Codable, Sendable {
    public var start: Int
    public var end: Int
    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }
}

public enum MatchKind: String, Codable, Sendable {
    case alias, exact, prefix, wordPrefix = "word-prefix", acronym, fuzzy, keyword, none
}

public struct ScoredItem: Hashable, Codable, Sendable, Identifiable {
    public var item: SearchItem
    public var score: Double
    public var matchScore: Double
    public var matchKind: MatchKind
    public var frecency: Double
    public var ranges: [MatchRange]
    public var argument: String?
    public var arguments: [String: String]?

    public var id: String { item.id }

    public init(item: SearchItem, score: Double, matchScore: Double = 0, matchKind: MatchKind = .none, frecency: Double = 0,
                ranges: [MatchRange] = [], argument: String? = nil, arguments: [String: String]? = nil) {
        self.item = item
        self.score = score
        self.matchScore = matchScore
        self.matchKind = matchKind
        self.frecency = frecency
        self.ranges = ranges
        self.argument = argument
        self.arguments = arguments
    }
}

public struct SectionID: RawRepresentable, Hashable, Codable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public static let favorites = SectionID(rawValue: "favorites")
    public static let suggestions = SectionID(rawValue: "suggestions")
    public static let results = SectionID(rawValue: "results")
    public static let workflows = SectionID(rawValue: "workflows")
    public static let apps = SectionID(rawValue: "apps")
    public static let files = SectionID(rawValue: "files")
    public static let calculator = SectionID(rawValue: "calculator")
    public static let fallbacks = SectionID(rawValue: "fallbacks")
}

public struct ResultSection: Hashable, Codable, Sendable {
    public var id: SectionID
    public var title: String
    public var items: [ScoredItem]
    public init(id: SectionID, title: String, items: [ScoredItem]) {
        self.id = id
        self.title = title
        self.items = items
    }
}

public struct SearchResponse: Hashable, Codable, Sendable {
    public var query: String
    public var sections: [ResultSection]
    public var total: Int
    public var tookMs: Double
    public init(query: String, sections: [ResultSection], total: Int, tookMs: Double) {
        self.query = query
        self.sections = sections
        self.total = total
        self.tookMs = tookMs
    }
    public var flattened: [ScoredItem] { sections.flatMap(\.items) }
}

/// usage.json entry. `searchTerms` is the engine's additive field (frecency.ts UsageRecordWithTerms).
public struct UsageRecord: Hashable, Codable, Sendable {
    public var itemId: String
    /// Unix ms timestamps of the most recent launches (bounded ring of 10).
    public var launches: [Double]
    public var count: Int
    public var lastLaunchedAt: Double
    public var searchTerms: [String]?
    public var extra: [String: JSONValue] = [:]

    public init(itemId: String, launches: [Double], count: Int, lastLaunchedAt: Double, searchTerms: [String]? = nil) {
        self.itemId = itemId
        self.launches = launches
        self.count = count
        self.lastLaunchedAt = lastLaunchedAt
        self.searchTerms = searchTerms
    }

    static let knownKeys: Set<String> = ["itemId", "launches", "count", "lastLaunchedAt", "searchTerms"]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        guard let id = r.string("itemId") else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "usage record without itemId"))
        }
        itemId = id
        launches = r.value([Double].self, "launches") ?? []
        count = r.int("count") ?? launches.count
        lastLaunchedAt = r.double("lastLaunchedAt") ?? (launches.max() ?? 0)
        searchTerms = r.strings("searchTerms")
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("itemId", itemId)
        try w.set("launches", launches.map { JSONValue.double($0) })
        try w.set("count", count)
        try w.set("lastLaunchedAt", JSONValue.double(lastLaunchedAt))
        try w.set("searchTerms", searchTerms)
        try w.finish()
    }
}
