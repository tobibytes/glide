import Foundation

/// One workflow step (`WorkflowAction`). Params are strings in the Electron app; they are kept as JSON values
/// so nothing a feature stored is lost. Use `param(_:)` for the string view.
public struct WorkflowAction: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var type: String
    public var label: String?
    public var params: [String: JSONValue]
    public var then: [WorkflowAction]?
    public var `else`: [WorkflowAction]?
    public var disabled: Bool?
    public var extra: [String: JSONValue] = [:]

    public init(id: String, type: String, label: String? = nil, params: [String: JSONValue] = [:],
                then: [WorkflowAction]? = nil, else elseActions: [WorkflowAction]? = nil, disabled: Bool? = nil) {
        self.id = id
        self.type = type
        self.label = label
        self.params = params
        self.then = then
        self.else = elseActions
        self.disabled = disabled
    }

    public func param(_ key: String) -> String? { params[key].map(\.description) }

    static let knownKeys: Set<String> = ["id", "type", "label", "params", "then", "else", "disabled"]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        id = r.string("id") ?? UUID().uuidString
        type = r.string("type") ?? "notify"
        label = r.string("label")
        params = r.object("params") ?? [:]
        then = r.array(WorkflowAction.self, "then")
        self.else = r.array(WorkflowAction.self, "else")
        disabled = r.bool("disabled")
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("id", id)
        try w.set("type", type)
        try w.set("label", label)
        try w.set("params", params)
        try w.set("then", then)
        try w.set("else", self.else)
        try w.set("disabled", disabled)
        try w.finish()
    }
}

public struct Workflow: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var description: String?
    public var icon: ItemIcon
    public var alias: String?
    public var hotkey: String?
    public var keywords: [String]?
    public var acceptsInput: Bool?
    public var actions: [WorkflowAction]
    public var createdAt: Double
    public var updatedAt: Double
    public var extra: [String: JSONValue] = [:]

    public init(id: String, name: String, description: String? = nil, icon: ItemIcon = .emoji("⚡️"), alias: String? = nil,
                hotkey: String? = nil, keywords: [String]? = nil, acceptsInput: Bool? = nil, actions: [WorkflowAction] = [],
                createdAt: Double = 0, updatedAt: Double = 0) {
        self.id = id
        self.name = name
        self.description = description
        self.icon = icon
        self.alias = alias
        self.hotkey = hotkey
        self.keywords = keywords
        self.acceptsInput = acceptsInput
        self.actions = actions
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    static let knownKeys: Set<String> = ["id", "name", "description", "icon", "alias", "hotkey", "keywords", "acceptsInput", "actions", "createdAt", "updatedAt"]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        id = r.string("id") ?? UUID().uuidString
        name = r.string("name") ?? "Untitled Workflow"
        description = r.string("description")
        icon = r.value(ItemIcon.self, "icon") ?? .emoji("⚡️")
        alias = r.string("alias")
        hotkey = r.string("hotkey")
        keywords = r.strings("keywords")
        acceptsInput = r.bool("acceptsInput")
        actions = r.array(WorkflowAction.self, "actions") ?? []
        createdAt = r.double("createdAt") ?? 0
        updatedAt = r.double("updatedAt") ?? 0
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("id", id)
        try w.set("name", name)
        try w.set("description", description)
        try w.set("icon", icon)
        try w.set("alias", alias)
        try w.set("hotkey", hotkey)
        try w.set("keywords", keywords)
        try w.set("acceptsInput", acceptsInput)
        try w.set("actions", actions)
        try w.set("createdAt", JSONValue.double(createdAt))
        try w.set("updatedAt", JSONValue.double(updatedAt))
        try w.finish()
    }
}

public struct Quicklink: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var url: String
    public var icon: ItemIcon?
    public var alias: String?
    public var keywords: [String]?
    /// Open with this app (bundle path or bundle id) instead of the default handler.
    public var openWith: String?
    public var extra: [String: JSONValue] = [:]

    public init(id: String, name: String, url: String, icon: ItemIcon? = nil, alias: String? = nil, keywords: [String]? = nil, openWith: String? = nil) {
        self.id = id
        self.name = name
        self.url = url
        self.icon = icon
        self.alias = alias
        self.keywords = keywords
        self.openWith = openWith
    }

    static let knownKeys: Set<String> = ["id", "name", "url", "icon", "alias", "keywords", "openWith"]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        id = r.string("id") ?? UUID().uuidString
        name = r.string("name") ?? ""
        url = r.string("url") ?? ""
        icon = r.value(ItemIcon.self, "icon")
        alias = r.string("alias")
        keywords = r.strings("keywords")
        openWith = r.string("openWith")
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("id", id)
        try w.set("name", name)
        try w.set("url", url)
        try w.set("icon", icon)
        try w.set("alias", alias)
        try w.set("keywords", keywords)
        try w.set("openWith", openWith)
        try w.finish()
    }
}

public struct Snippet: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var text: String
    public var keyword: String?
    public var alias: String?
    public var html: String?
    public var excludedApps: [String]?
    public var extra: [String: JSONValue] = [:]

    public init(id: String, name: String, text: String, keyword: String? = nil, alias: String? = nil, html: String? = nil, excludedApps: [String]? = nil) {
        self.id = id
        self.name = name
        self.text = text
        self.keyword = keyword
        self.alias = alias
        self.html = html
        self.excludedApps = excludedApps
    }

    static let knownKeys: Set<String> = ["id", "name", "text", "keyword", "alias", "html", "excludedApps"]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        id = r.string("id") ?? UUID().uuidString
        name = r.string("name") ?? ""
        text = r.string("text") ?? ""
        keyword = r.string("keyword")
        alias = r.string("alias")
        html = r.string("html")
        excludedApps = r.strings("excludedApps")
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("id", id)
        try w.set("name", name)
        try w.set("text", text)
        try w.set("keyword", keyword)
        try w.set("alias", alias)
        try w.set("html", html)
        try w.set("excludedApps", excludedApps)
        try w.finish()
    }
}

/// `Settings` with `DEFAULT_SETTINGS` applied field by field (the Electron store spreads defaults under
/// the stored object). `features` holds per-feature bags keyed by feature id — the native features use the
/// SAME ids as the Electron ones so their settings carry over.
public struct Settings: Hashable, Codable, Sendable {
    /// Electron accelerator string, e.g. "Alt+Space" or "Command+Space".
    public var hotkey: String = "Alt+Space"
    /// "system" | "dark" | "light"
    public var theme: String = "system"
    public var disabledSources: [String] = []
    public var appDirectories: [String] = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "~/Applications"]
    public var fileSearch: Bool = true
    public var calculator: Bool = true
    public var sectionLimit: Int = 8
    public var hideOnBlur: Bool = true
    public var keepOpenAfterRun: Bool = true
    public var frecencyHalfLifeDays: Double = 10
    public var vimMode: Bool = true
    public var launchAtLogin: Bool = false
    public var features: [String: [String: JSONValue]] = [:]
    public var extra: [String: JSONValue] = [:]

    public init() {}

    public static let defaults = Settings()

    /// A feature's settings bag merged over `defaults` (FeatureContext.settings in the Electron host).
    public func featureSettings(_ featureId: String, defaults: [String: JSONValue] = [:]) -> [String: JSONValue] {
        defaults.merging(features[featureId] ?? [:]) { _, stored in stored }
    }

    static let knownKeys: Set<String> = [
        "hotkey", "theme", "disabledSources", "appDirectories", "fileSearch", "calculator", "sectionLimit", "hideOnBlur",
        "keepOpenAfterRun", "frecencyHalfLifeDays", "vimMode", "launchAtLogin", "features",
    ]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        let d = Settings.defaults
        hotkey = r.string("hotkey") ?? d.hotkey
        theme = r.string("theme") ?? d.theme
        disabledSources = r.strings("disabledSources") ?? d.disabledSources
        appDirectories = r.strings("appDirectories") ?? d.appDirectories
        fileSearch = r.bool("fileSearch") ?? d.fileSearch
        calculator = r.bool("calculator") ?? d.calculator
        sectionLimit = r.int("sectionLimit") ?? d.sectionLimit
        hideOnBlur = r.bool("hideOnBlur") ?? d.hideOnBlur
        keepOpenAfterRun = r.bool("keepOpenAfterRun") ?? d.keepOpenAfterRun
        frecencyHalfLifeDays = r.double("frecencyHalfLifeDays") ?? d.frecencyHalfLifeDays
        vimMode = r.bool("vimMode") ?? d.vimMode
        launchAtLogin = r.bool("launchAtLogin") ?? d.launchAtLogin
        var feats: [String: [String: JSONValue]] = [:]
        for (k, v) in r.object("features") ?? [:] { if let o = v.objectValue { feats[k] = o } }
        features = feats
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("hotkey", hotkey)
        try w.set("theme", theme)
        try w.set("disabledSources", disabledSources)
        try w.set("appDirectories", appDirectories)
        try w.set("fileSearch", fileSearch)
        try w.set("calculator", calculator)
        try w.set("sectionLimit", sectionLimit)
        try w.set("hideOnBlur", hideOnBlur)
        try w.set("keepOpenAfterRun", keepOpenAfterRun)
        try w.set("frecencyHalfLifeDays", JSONValue.double(frecencyHalfLifeDays))
        try w.set("vimMode", vimMode)
        try w.set("launchAtLogin", launchAtLogin)
        try w.set("features", features)
        try w.finish()
    }
}

/// Everything in data.json.
public struct UserData: Hashable, Codable, Sendable {
    public var settings = Settings()
    public var workflows: [Workflow] = []
    public var quicklinks: [Quicklink] = []
    public var snippets: [Snippet] = []
    /// Item ids, in favorite order.
    public var favorites: [String] = []
    /// item id → alias
    public var aliases: [String: String] = [:]
    /// item id → accelerator
    public var hotkeys: [String: String] = [:]
    public var extra: [String: JSONValue] = [:]

    public init() {}

    static let knownKeys: Set<String> = ["settings", "workflows", "quicklinks", "snippets", "favorites", "aliases", "hotkeys"]
    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        settings = r.value(Settings.self, "settings") ?? Settings()
        workflows = r.array(Workflow.self, "workflows") ?? []
        quicklinks = r.array(Quicklink.self, "quicklinks") ?? []
        snippets = r.array(Snippet.self, "snippets") ?? []
        favorites = r.strings("favorites") ?? []
        var aliases: [String: String] = [:]
        for (k, v) in r.object("aliases") ?? [:] { if let s = v.stringValue { aliases[k] = s } }
        self.aliases = aliases
        var hotkeys: [String: String] = [:]
        for (k, v) in r.object("hotkeys") ?? [:] { if let s = v.stringValue { hotkeys[k] = s } }
        self.hotkeys = hotkeys
        extra = r.extra
    }
    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("settings", settings)
        try w.set("workflows", workflows)
        try w.set("quicklinks", quicklinks)
        try w.set("snippets", snippets)
        try w.set("favorites", favorites)
        try w.set("aliases", aliases)
        try w.set("hotkeys", hotkeys)
        try w.finish()
    }
}

/// First-launch content, identical to src/main/seed.ts.
public enum Seed {
    public static func userData(now: Double) -> UserData {
        var d = UserData()
        d.workflows = [
            Workflow(id: "wf-morning-setup", name: "Morning Setup", description: "Open Calendar and Notes, then say hello", icon: .emoji("☀️"),
                     keywords: ["start", "day"], actions: [
                         WorkflowAction(id: "a1", type: "openApp", params: ["app": "Calendar"]),
                         WorkflowAction(id: "a2", type: "openApp", params: ["app": "Notes"]),
                         WorkflowAction(id: "a3", type: "notify", params: ["title": "Good morning", "body": "Calendar and Notes are ready. Today is {{date}}."]),
                     ], createdAt: now, updatedAt: now),
            Workflow(id: "wf-search-clipboard", name: "Search Clipboard on Google", description: "Google whatever is on the clipboard", icon: .emoji("🔎"),
                     keywords: ["google", "lookup"], actions: [
                         WorkflowAction(id: "a1", type: "getClipboard"),
                         WorkflowAction(id: "a2", type: "openUrl", params: ["url": "https://www.google.com/search?q={{clipboard}}"]),
                     ], createdAt: now, updatedAt: now),
            Workflow(id: "wf-quick-note", name: "Quick Note", description: "Append a line to ~/Desktop/notes.txt", icon: .emoji("📝"),
                     keywords: ["note", "jot"], acceptsInput: true, actions: [
                         WorkflowAction(id: "a1", type: "askInput", params: ["prompt": "What's on your mind?", "placeholder": "Note text"]),
                         WorkflowAction(id: "a2", type: "runShell", params: ["command": "printf \"%s  %s\\n\" \"{{date}} {{time}}\" \"{{input}}\" >> ~/Desktop/notes.txt", "shell": "/bin/zsh"]),
                         WorkflowAction(id: "a3", type: "notify", params: ["title": "Note saved", "body": "{{input}}"]),
                     ], createdAt: now, updatedAt: now),
        ]
        d.quicklinks = [
            Quicklink(id: "ql-google", name: "Google", url: "https://www.google.com/search?q={query}", icon: .emoji("🌐"), alias: "g"),
            Quicklink(id: "ql-github", name: "GitHub", url: "https://github.com/search?q={query}", icon: .emoji("🐙")),
            Quicklink(id: "ql-youtube", name: "YouTube", url: "https://www.youtube.com/results?search_query={query}", icon: .emoji("▶️")),
        ]
        d.snippets = [
            Snippet(id: "sn-email-sig", name: "Email signature", text: "Best regards,\n\n— sent from Glide", keyword: ";sig"),
            Snippet(id: "sn-shrug", name: "Shrug", text: "¯\\_(ツ)_/¯", keyword: ";shrug"),
        ]
        return d
    }
}
