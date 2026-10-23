import Foundation
import GlideCore

/// One editable parameter of an action (`ActionSpec.params[n]` in src/shared/types.ts).
public struct WorkflowParamSpec: Hashable, Sendable, Codable {
    /// "text" | "multiline" | "number" | "select" | "app" | "file" | "url" | "hidden"
    public enum Kind: String, Hashable, Sendable, Codable { case text, multiline, number, select, app, file, url, hidden }
    public var key: String
    public var label: String
    public var kind: Kind
    public var placeholder: String?
    public var options: [String]?
    public var required: Bool
    public var defaultValue: String?

    public init(_ key: String, _ label: String, _ kind: Kind = .text, placeholder: String? = nil, options: [String]? = nil, required: Bool = false, default defaultValue: String? = nil) {
        self.key = key
        self.label = label
        self.kind = kind
        self.placeholder = placeholder
        self.options = options
        self.required = required
        self.defaultValue = defaultValue
    }

    enum CodingKeys: String, CodingKey { case key, label, kind, placeholder, options, required, defaultValue = "default" }
}

/// Library group of an action, same ids as the Electron app.
public enum WorkflowCategory: String, Hashable, Sendable, Codable, CaseIterable {
    case apps, web, text, clipboard, scripting, control, system
    public var title: String {
        switch self {
        case .apps: return "Apps & Files"
        case .web: return "Web"
        case .text: return "Text"
        case .clipboard: return "Clipboard"
        case .scripting: return "Scripting"
        case .control: return "Control Flow"
        case .system: return "System"
        }
    }
    public var symbol: String {
        switch self {
        case .apps: return "square.grid.2x2"
        case .web: return "globe"
        case .text: return "text.alignleft"
        case .clipboard: return "doc.on.clipboard"
        case .scripting: return "terminal"
        case .control: return "arrow.triangle.branch"
        case .system: return "gearshape"
        }
    }
}

/// What the editor's library lists and the runtime validates against (`ActionSpec`).
public struct WorkflowActionSpec: Hashable, Sendable, Identifiable, Codable {
    public var type: String
    /// For type "feature": the owning feature id and its action id.
    public var feature: String?
    public var action: String?
    public var title: String
    public var description: String
    /// Emoji (the Electron spec icon) and the SF Symbol the native editor shows.
    public var emoji: String
    public var symbol: String
    public var category: WorkflowCategory
    public var params: [WorkflowParamSpec]
    /// The result is also stored as {{outputVar}}.
    public var outputVar: String?

    public init(type: String, feature: String? = nil, action: String? = nil, title: String, description: String, emoji: String, symbol: String,
                category: WorkflowCategory, params: [WorkflowParamSpec] = [], outputVar: String? = nil) {
        self.type = type
        self.feature = feature
        self.action = action
        self.title = title
        self.description = description
        self.emoji = emoji
        self.symbol = symbol
        self.category = category
        self.params = params
        self.outputVar = outputVar
    }

    /// Unique key: the type, or "feature:<feature>.<action>" (specKey in src/shared/workflow-specs.ts).
    public var id: String { type == "feature" ? "feature:\(feature ?? "").\(action ?? "")" : type }
    public var visibleParams: [WorkflowParamSpec] { params.filter { $0.kind != .hidden } }
    public var isContainer: Bool { type == "condition" }

    /// A new action with the spec's defaults (createAction in lib/workflowTree.ts).
    public func makeAction(id: String = WorkflowIDs.newActionId()) -> WorkflowAction {
        var params: [String: JSONValue] = [:]
        for p in self.params { if let d = p.defaultValue { params[p.key] = .string(d) } }
        var a = WorkflowAction(id: id, type: type, params: params)
        if type == "condition" {
            a.then = []
            a.else = []
        }
        return a
    }
}

public enum WorkflowIDs {
    /// `a-<base36 time>-<4 random>` like newActionId() in the renderer.
    public static func newActionId() -> String {
        let t = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        let r = String((0..<4).map { _ in alphabet.randomElement() ?? "x" })
        return "a-\(t)-\(r)"
    }
    public static func newWorkflowId() -> String { "wf-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))\(Int.random(in: 0..<1296))" }
}

/// The 17 built-in actions (src/main/workflows/specs.ts), in library order.
public enum WorkflowSpecs {
    public static let systemSounds = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"]
    public static let continueOnError = WorkflowParamSpec("continueOnError", "Continue on error", .select, options: ["false", "true"], default: "false")

    public static let builtins: [WorkflowActionSpec] = [
        .init(type: "openApp", title: "Open Application", description: "Launch or activate an application", emoji: "🚀", symbol: "app.badge", category: .apps,
              params: [.init("app", "Application", .app, placeholder: "Safari", required: true)]),
        .init(type: "openUrl", title: "Open URL", description: "Open a link in the default browser", emoji: "🌐", symbol: "safari", category: .web,
              params: [.init("url", "URL", .url, placeholder: "https://example.com/?q={{input}}", required: true)]),
        .init(type: "runShell", title: "Run Shell Script", description: "Run a command in your login shell; stdout becomes {{result}}", emoji: "💻", symbol: "terminal", category: .scripting,
              params: [.init("command", "Command", .multiline, placeholder: "echo {{input}}", required: true),
                       .init("shell", "Shell", .select, options: ["/bin/zsh", "/bin/bash", "/bin/sh"], default: "/bin/zsh"), continueOnError],
              outputVar: "stdout"),
        .init(type: "runAppleScript", title: "Run AppleScript", description: "Run an AppleScript; its return value becomes {{result}}", emoji: "📜", symbol: "applescript", category: .scripting,
              params: [.init("script", "Script", .multiline, placeholder: "display dialog \"{{input}}\"", required: true), continueOnError],
              outputVar: "scriptResult"),
        .init(type: "typeText", title: "Type Text", description: "Paste text into the frontmost app", emoji: "⌨️", symbol: "keyboard", category: .text,
              params: [.init("text", "Text", .multiline, placeholder: "Hello {{input}}", required: true)]),
        .init(type: "setClipboard", title: "Set Clipboard", description: "Copy text to the clipboard", emoji: "📋", symbol: "doc.on.clipboard", category: .clipboard,
              params: [.init("text", "Text", .multiline, placeholder: "{{result}}", required: true)]),
        .init(type: "getClipboard", title: "Get Clipboard", description: "Read the clipboard into {{clipboard}}", emoji: "📥", symbol: "clipboard", category: .clipboard,
              outputVar: "clipboard"),
        .init(type: "notify", title: "Show Notification", description: "Post a macOS notification", emoji: "🔔", symbol: "bell.badge", category: .system,
              params: [.init("title", "Title", placeholder: "Done", required: true), .init("body", "Body", .multiline, placeholder: "{{result}}")]),
        .init(type: "wait", title: "Wait", description: "Pause before the next action", emoji: "⏳", symbol: "hourglass", category: .control,
              params: [.init("seconds", "Seconds", .number, placeholder: "1", required: true, default: "1")]),
        .init(type: "askInput", title: "Ask for Input", description: "Prompt in the launcher; the answer becomes {{input}}", emoji: "❓", symbol: "questionmark.bubble", category: .control,
              params: [.init("prompt", "Prompt", placeholder: "What would you like to do?", required: true), .init("placeholder", "Placeholder", placeholder: "Type here…")],
              outputVar: "input"),
        .init(type: "setVariable", title: "Set Variable", description: "Store a value as {{name}}", emoji: "🏷️", symbol: "tag", category: .control,
              params: [.init("name", "Name", placeholder: "greeting", required: true), .init("value", "Value", .multiline, placeholder: "Hello {{input}}")]),
        .init(type: "condition", title: "If", description: "Run the Then or Else branch depending on a comparison", emoji: "🔀", symbol: "arrow.triangle.branch", category: .control,
              params: [.init("left", "Value", placeholder: "{{input}}", required: true),
                       .init("operator", "Operator", .select, options: WorkflowTemplate.conditionOperators, required: true, default: "equals"),
                       .init("right", "Compare to", placeholder: "yes")]),
        .init(type: "httpRequest", title: "HTTP Request", description: "Fetch a URL; the response body becomes {{response}}", emoji: "📡", symbol: "network", category: .web,
              params: [.init("method", "Method", .select, options: ["GET", "POST", "PUT", "PATCH", "DELETE"], required: true, default: "GET"),
                       .init("url", "URL", .url, placeholder: "https://api.example.com/items", required: true),
                       .init("headers", "Headers", .multiline, placeholder: "Content-Type: application/json\nAuthorization: Bearer …"),
                       .init("body", "Body", .multiline, placeholder: "{\"text\": \"{{input}}\"}"), continueOnError],
              outputVar: "response"),
        .init(type: "runWorkflow", title: "Run Workflow", description: "Run another workflow and use its result", emoji: "🧩", symbol: "square.stack.3d.up", category: .control,
              params: [.init("workflowId", "Workflow", placeholder: "workflow id", required: true), .init("input", "Input", placeholder: "{{result}}")],
              outputVar: "workflowResult"),
        .init(type: "showResult", title: "Show Result", description: "Display text in the launcher window", emoji: "🪟", symbol: "macwindow", category: .text,
              params: [.init("text", "Text", .multiline, placeholder: "{{result}}", required: true), .init("title", "Title", placeholder: "Result")]),
        .init(type: "openFile", title: "Open File", description: "Open a file or folder with its default app", emoji: "📂", symbol: "folder", category: .apps,
              params: [.init("path", "Path", .file, placeholder: "~/Documents/todo.md", required: true)]),
        .init(type: "playSound", title: "Play Sound", description: "Play a macOS system sound", emoji: "🔊", symbol: "speaker.wave.2", category: .system,
              params: [.init("name", "Sound", .select, options: systemSounds, required: true, default: "Glass")]),
    ]

    public static func builtin(_ type: String) -> WorkflowActionSpec? { builtins.first { $0.type == type } }

    /// specForAction: feature actions are matched by params.feature + params.action.
    public static func spec(for action: WorkflowAction, in specs: [WorkflowActionSpec]) -> WorkflowActionSpec? {
        guard action.type == "feature" else { return specs.first { $0.type == action.type } }
        let f = action.param(FeatureActionKeys.feature)
        let a = action.param(FeatureActionKeys.action)
        return specs.first { $0.type == "feature" && $0.feature == f && $0.action == a }
    }

    /// Params whose text is code (monospaced in the editor).
    public static let monoParams: Set<String> = ["runShell:command", "runAppleScript:script", "httpRequest:headers", "httpRequest:body"]
}

public enum FeatureActionKeys {
    public static let feature = "feature"
    public static let action = "action"
    public static let reserved: Set<String> = [feature, action]
}
