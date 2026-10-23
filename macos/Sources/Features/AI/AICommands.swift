import Foundation
import GlideCore

/// An AI Command (built-in or custom) — the `AiCommandDef` shape stored in `settings.features.ai.customCommands`.
public struct AICommandDef: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    /// Emoji.
    public var icon: String
    /// Uses {selection} and optionally {argument}.
    public var prompt: String
    /// Model override; nil = the default model.
    public var model: String?
    public var acceptsArgument: Bool
    public var argumentPlaceholder: String?
    /// The result is meant to replace the selected text (offer "Replace Selection").
    public var replaces: Bool
    public var builtin: Bool

    public init(id: String, name: String, icon: String, prompt: String, model: String? = nil, acceptsArgument: Bool = false,
                argumentPlaceholder: String? = nil, replaces: Bool = false, builtin: Bool = false) {
        self.id = id
        self.name = name
        self.icon = icon
        self.prompt = prompt
        self.model = model
        self.acceptsArgument = acceptsArgument
        self.argumentPlaceholder = argumentPlaceholder
        self.replaces = replaces
        self.builtin = builtin
    }

    /// JSON as stored in data.json (same keys as the Electron app; `builtin` omitted for custom commands).
    public var json: JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "name": .string(name), "icon": .string(icon), "prompt": .string(prompt),
                                      "acceptsArgument": .bool(acceptsArgument), "replaces": .bool(replaces)]
        if let model { o["model"] = .string(model) }
        if let argumentPlaceholder { o["argumentPlaceholder"] = .string(argumentPlaceholder) }
        if builtin { o["builtin"] = true } else { o["builtin"] = false }
        return .object(o)
    }
}

public enum AITemplates {
    static let text = "<text>\n{selection}\n</text>"
    static let code = "<code>\n{selection}\n</code>"
    static let only = "Reply with only the rewritten text — no preamble, no quotes, no explanation. Keep the original language and formatting (Markdown, line breaks) unless asked otherwise."

    /// Same ids, names, icons and prompts as templates.ts.
    public static let builtins: [AICommandDef] = [
        AICommandDef(id: "fix-spelling", name: "Fix Spelling and Grammar", icon: "✏️", prompt: "Fix the spelling, grammar and punctuation of the text below. Do not change its meaning or tone. \(only)\n\n\(text)", replaces: true, builtin: true),
        AICommandDef(id: "improve-writing", name: "Improve Writing", icon: "✨", prompt: "Improve the writing of the text below: make it clearer and more fluent while keeping its meaning and voice. \(only)\n\n\(text)", replaces: true, builtin: true),
        AICommandDef(id: "make-shorter", name: "Make Shorter", icon: "➖", prompt: "Make the text below noticeably shorter while keeping every key point. \(only)\n\n\(text)", replaces: true, builtin: true),
        AICommandDef(id: "make-longer", name: "Make Longer", icon: "➕", prompt: "Expand the text below with relevant detail so it is roughly twice as long, keeping its tone. \(only)\n\n\(text)", replaces: true, builtin: true),
        AICommandDef(id: "tone-friendly", name: "Change Tone to Friendly", icon: "😊", prompt: "Rewrite the text below in a warm, friendly tone. \(only)\n\n\(text)", replaces: true, builtin: true),
        AICommandDef(id: "tone-professional", name: "Change Tone to Professional", icon: "👔", prompt: "Rewrite the text below in a clear, professional tone. \(only)\n\n\(text)", replaces: true, builtin: true),
        AICommandDef(id: "summarize", name: "Summarize", icon: "📝", prompt: "Summarize the text below in a few concise bullet points.\n\n\(text)", builtin: true),
        AICommandDef(id: "explain-simply", name: "Explain This in Simple Terms", icon: "💡", prompt: "Explain the text below in simple terms a curious 12-year-old would understand.\n\n\(text)", builtin: true),
        AICommandDef(id: "translate", name: "Translate to …", icon: "🌐", prompt: "Translate the text below into {argument}. \(only)\n\n\(text)", acceptsArgument: true, argumentPlaceholder: "Language", replaces: true, builtin: true),
        AICommandDef(id: "explain-code", name: "Explain Code", icon: "🧑‍💻", prompt: "Explain what the code below does, step by step. Mention the language, inputs/outputs and anything surprising.\n\n\(code)", builtin: true),
        AICommandDef(id: "find-bugs", name: "Find Bugs in Code", icon: "🐞", prompt: "Review the code below for bugs. List each real problem with the line, why it is wrong and a fix. If you find none, say so.\n\n\(code)", builtin: true),
    ]

    private static let placeholder = try? NSRegularExpression(pattern: "\\{(selection|argument)\\}")

    /// Fill {selection} and {argument} in one pass so "{argument}" inside the selection is never substituted.
    public static func fill(_ template: String, selection: String?, argument: String?) -> String {
        guard let re = placeholder else { return template }
        let ns = template as NSString
        var out = ""
        var cursor = 0
        for m in re.matches(in: template, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            out += ns.substring(with: m.range(at: 1)) == "selection" ? (selection ?? "") : (argument ?? "")
            cursor = m.range.location + m.range.length
        }
        return out + ns.substring(from: cursor)
    }

    public static func uses(_ template: String, _ key: String) -> Bool { template.contains("{\(key)}") }

    private static let idPattern = try? NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{0,63}$")

    /// Validate and normalise a user-defined command (sanitizeCommand in templates.ts).
    public static func sanitize(_ raw: JSONValue) -> AICommandDef? {
        guard let r = raw.objectValue else { return nil }
        let name = String((r["name"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        let prompt = String((r["prompt"]?.stringValue ?? "").prefix(20_000))
        guard !name.isEmpty, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var id = slug(name)
        if let rid = r["id"]?.stringValue, let re = idPattern, re.firstMatch(in: rid, range: NSRange(location: 0, length: (rid as NSString).length)) != nil { id = rid }
        let iconRaw = (r["icon"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let icon = iconRaw.isEmpty ? "🤖" : String(String.UnicodeScalarView(iconRaw.unicodeScalars.prefix(4)))
        let model = r["model"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        let placeholderText = r["argumentPlaceholder"]?.stringValue.map { String($0.prefix(40)) }
        return AICommandDef(id: id, name: name, icon: icon, prompt: prompt, model: model, acceptsArgument: uses(prompt, "argument"),
                            argumentPlaceholder: placeholderText, replaces: r["replaces"]?.boolValue == true, builtin: false)
    }

    public static func slug(_ name: String) -> String {
        var s = ""
        var dash = false
        for u in name.lowercased().unicodeScalars {
            if ("a"..."z").contains(u) || ("0"..."9").contains(u) {
                s.unicodeScalars.append(u)
                dash = false
            } else if !dash {
                s += "-"
                dash = true
            }
        }
        while s.hasPrefix("-") { s.removeFirst() }
        while s.hasSuffix("-") { s.removeLast() }
        s = String(s.prefix(48))
        return "custom-\(s.isEmpty ? "command" : s)"
    }

    /// Sanitise a full custom-command list: ids made unique against built-ins and each other (setSettings).
    public static func sanitizeList(_ raw: [JSONValue]) -> [AICommandDef] {
        var seen = Set(builtins.map(\.id))
        var out: [AICommandDef] = []
        for r in raw {
            guard var cmd = sanitize(r) else { continue }
            var id = cmd.id
            var n = 2
            while seen.contains(id) { id = "\(cmd.id)-\(n)"; n += 1 }
            seen.insert(id)
            cmd.id = id
            out.append(cmd)
        }
        return out
    }
}
