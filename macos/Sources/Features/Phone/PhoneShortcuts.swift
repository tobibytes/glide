import Foundation

// Generates the iPhone Shortcuts that talk to the iCloud Drive relay (docs/PHONE.md, "Shortcuts").
//
// A .shortcut file is a property list: WFWorkflowActions is an array of {WFWorkflowActionIdentifier,
// WFWorkflowActionParameters}. Variables are attachments: one action's output is referenced by the action's UUID
// ({"Type":"ActionOutput","OutputUUID":…}), "Shortcut Input" is {"Type":"ExtensionInput"}. Text with variables is a
// WFTextTokenString (U+FFFC marks each attachment's place). Control flow (If, Repeat) is a start and an end action
// that share a GroupingIdentifier (WFControlFlowMode 0 = start, 1 = otherwise, 2 = end).
//
// File actions run without a folder picker, which Shortcuts resolves inside its own iCloud Drive folder
// ("iCloud Drive/Shortcuts"), so these shortcuts use "Glide/Phone/…" there; Glide watches that folder too
// (PhoneRelayPaths.roots). Files are unsigned here; `PhoneShortcutSigner` signs them only when the user asks.

/// A plist value (only the types Shortcuts uses), Sendable so generation runs anywhere.
public indirect enum ShortcutValue: Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([ShortcutValue])
    case dict([String: ShortcutValue])

    var plist: Any {
        switch self {
        case let .string(s): return s
        case let .int(i): return NSNumber(value: i)
        case let .double(d): return NSNumber(value: d)
        case let .bool(b): return NSNumber(value: b)
        case let .array(a): return a.map(\.plist)
        case let .dict(d): return d.mapValues(\.plist) as NSDictionary
        }
    }
}

/// A reference to a value inside a shortcut.
public enum ShortcutVar: Sendable, Equatable {
    case output(uuid: String, name: String)
    case shortcutInput
    case clipboard
    case currentDate

    var attachment: ShortcutValue {
        switch self {
        case let .output(uuid, name): return .dict(["Type": .string("ActionOutput"), "OutputUUID": .string(uuid), "OutputName": .string(name)])
        case .shortcutInput: return .dict(["Type": .string("ExtensionInput")])
        case .clipboard: return .dict(["Type": .string("Clipboard")])
        case .currentDate: return .dict(["Type": .string("CurrentDate")])
        }
    }
}

/// One piece of text: literal or a variable.
public enum ShortcutTextPart: Sendable, Equatable {
    case text(String)
    case variable(ShortcutVar)
}

/// Builds one workflow. UUIDs are deterministic (seeded by the shortcut name) so output is stable for tests.
public struct ShortcutBuilder: Sendable {
    public private(set) var actions: [ShortcutValue] = []
    private let seed: String
    private var counter = 0

    public init(seed: String) { self.seed = seed }

    mutating func uuid() -> String {
        counter += 1
        // Stable, UUID-shaped: FNV-1a of seed + counter, spread over 128 bits.
        var h1: UInt64 = 0xcbf29ce484222325, h2: UInt64 = 0x84222325cbf29ce4
        for b in "\(seed)#\(counter)".utf8 {
            h1 = (h1 ^ UInt64(b)) &* 0x100000001b3
            h2 = (h2 ^ UInt64(b)) &* 0x100000001b3 &+ 0x9e3779b97f4a7c15
        }
        func mix(_ x: UInt64) -> UInt64 { // splitmix64 finalizer
            var z = x &+ 0x9e3779b97f4a7c15
            z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
            z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
            return z ^ (z >> 31)
        }
        let hex = String(format: "%016llX%016llX", mix(h1), mix(h2 ^ h1))
        let c = Array(hex)
        return "\(String(c[0..<8]))-\(String(c[8..<12]))-4\(String(c[13..<16]))-A\(String(c[17..<20]))-\(String(c[20..<32]))"
    }

    // MARK: parameter encodings

    /// WFTextTokenString: text with embedded variables.
    public static func tokenString(_ parts: [ShortcutTextPart]) -> ShortcutValue {
        var s = ""
        var attachments: [String: ShortcutValue] = [:]
        for p in parts {
            switch p {
            case let .text(t): s += t
            case let .variable(v):
                let loc = (s as NSString).length
                attachments["{\(loc), 1}"] = v.attachment
                s += "\u{FFFC}"
            }
        }
        var value: [String: ShortcutValue] = ["string": .string(s)]
        if !attachments.isEmpty { value["attachmentsByRange"] = .dict(attachments) }
        return .dict(["Value": .dict(value), "WFSerializationType": .string("WFTextTokenString")])
    }

    /// WFTextTokenAttachment: a parameter that is exactly one variable.
    public static func attachment(_ v: ShortcutVar) -> ShortcutValue {
        .dict(["Value": v.attachment, "WFSerializationType": .string("WFTextTokenAttachment")])
    }

    /// Dictionary action items. Kinds: 0 text, 1 dictionary, 3 number.
    public indirect enum Field: Sendable {
        case text(String, [ShortcutTextPart])
        case number(String, Int)
        case dict(String, [Field])
    }

    static func fieldValue(_ items: [Field]) -> ShortcutValue {
        .dict(["Value": .dict(["WFDictionaryFieldValueItems": .array(items.map(fieldItem))]),
               "WFSerializationType": .string("WFDictionaryFieldValue")])
    }

    static func fieldItem(_ f: Field) -> ShortcutValue {
        switch f {
        case let .text(k, parts):
            return .dict(["WFItemType": .int(0), "WFKey": tokenString([.text(k)]), "WFValue": tokenString(parts)])
        case let .number(k, n):
            return .dict(["WFItemType": .int(3), "WFKey": tokenString([.text(k)]), "WFValue": tokenString([.text(String(n))])])
        case let .dict(k, items):
            return .dict(["WFItemType": .int(1), "WFKey": tokenString([.text(k)]), "WFValue": fieldValue(items)])
        }
    }

    // MARK: actions

    @discardableResult
    mutating func add(_ id: String, _ params: [String: ShortcutValue] = [:], output: String? = nil) -> ShortcutVar? {
        var p = params
        var out: ShortcutVar?
        if let output {
            let u = uuid()
            p["UUID"] = .string(u)
            out = .output(uuid: u, name: output)
        }
        actions.append(.dict(["WFWorkflowActionIdentifier": .string("is.workflow.actions." + id), "WFWorkflowActionParameters": .dict(p)]))
        return out
    }

    mutating func comment(_ text: String) { add("comment", ["WFCommentActionText": .string(text)]) }

    mutating func text(_ parts: [ShortcutTextPart], name: String = "Text") -> ShortcutVar {
        add("gettext", ["WFTextActionText": Self.tokenString(parts)], output: name)!
    }

    /// A request id: yyyyMMddHHmmssSSS-<random 100000…999999>.
    mutating func requestId() -> ShortcutVar {
        let date = add("format.date", ["WFDateFormatStyle": .string("Custom"), "WFDateFormat": .string("yyyyMMddHHmmssSSS"),
                                       "WFDate": Self.tokenString([.variable(.currentDate)])], output: "Formatted Date")!
        let rnd = add("number.random", ["WFRandomNumberMinimum": .int(100000), "WFRandomNumberMaximum": .int(999999)], output: "Random Number")!
        return text([.variable(date), .text("-"), .variable(rnd)], name: "Request ID")
    }

    /// Writes `inbox/<id>.json` = {"v":1,"id","action","args":{…},"from":"Shortcuts"}.
    mutating func sendRequest(id: ShortcutVar, action: String, args: [Field]) {
        let dict = add("dictionary", ["WFItems": Self.fieldValue([
            .number("v", 1),
            .text("id", [.variable(id)]),
            .text("action", [.text(action)]),
            .dict("args", args),
            .text("from", [.text("Shortcuts")]),
        ])], output: "Dictionary")!
        let named = add("setitemname", ["WFInput": Self.attachment(dict), "WFName": Self.tokenString([.variable(id), .text(".json")]),
                                        "WFDontIncludeFileExtension": .bool(true)], output: "Renamed Item")!
        add("documentpicker.save", ["WFInput": Self.attachment(named), "WFAskWhereToSave": .bool(false),
                                    "WFFileDestinationPath": .string(PhoneShortcuts.folder + "/inbox/"), "WFSaveFileOverwrite": .bool(true)],
            output: "Saved File")
    }

    mutating func getFile(_ path: [ShortcutTextPart], errorIfMissing: Bool) -> ShortcutVar {
        add("documentpicker.open", ["WFGetFilePath": Self.tokenString(path), "WFFileErrorIfNotFound": .bool(errorIfMissing),
                                    "WFShowFilePicker": .bool(false)], output: "File")!
    }

    mutating func dictionaryValue(_ of: ShortcutVar, key: String) -> ShortcutVar {
        let d = add("detect.dictionary", ["WFInput": Self.attachment(of)], output: "Dictionary")!
        return add("getvalueforkey", ["WFInput": Self.attachment(d), "WFDictionaryKey": .string(key),
                                      "WFGetDictionaryValueType": .string("Value")], output: "Dictionary Value")!
    }

    mutating func ifHasValue(_ v: ShortcutVar, then: (inout ShortcutBuilder) -> Void, otherwise: ((inout ShortcutBuilder) -> Void)? = nil,
                             output: String? = nil) -> ShortcutVar? {
        let group = uuid()
        add("conditional", ["GroupingIdentifier": .string(group), "WFControlFlowMode": .int(0), "WFCondition": .int(100),
                            "WFInput": .dict(["Type": .string("Variable"), "Variable": Self.attachment(v)])])
        then(&self)
        if let otherwise {
            add("conditional", ["GroupingIdentifier": .string(group), "WFControlFlowMode": .int(1)])
            otherwise(&self)
        }
        return add("conditional", ["GroupingIdentifier": .string(group), "WFControlFlowMode": .int(2)], output: output)
    }

    mutating func repeatCount(_ n: Int, body: (inout ShortcutBuilder) -> Void) {
        let group = uuid()
        add("repeat.count", ["GroupingIdentifier": .string(group), "WFControlFlowMode": .int(0), "WFRepeatCount": .int(n)])
        body(&self)
        add("repeat.count", ["GroupingIdentifier": .string(group), "WFControlFlowMode": .int(2)])
    }

    mutating func ask(_ prompt: String) -> ShortcutVar {
        add("ask", ["WFAskActionPrompt": .string(prompt), "WFInputType": .string("Text")], output: "Provided Input")!
    }

    mutating func notify(_ title: String, _ body: [ShortcutTextPart]) {
        add("notification", ["WFNotificationActionTitle": .string(title), "WFNotificationActionBody": Self.tokenString(body)])
    }

    mutating func showResult(_ parts: [ShortcutTextPart]) { add("showresult", ["Text": Self.tokenString(parts)]) }

    mutating func alert(_ title: String, _ message: String) {
        add("alert", ["WFAlertActionTitle": .string(title), "WFAlertActionMessage": .string(message), "WFAlertActionCancelButtonShown": .bool(false)])
    }

    mutating func delete(_ v: ShortcutVar) { add("file.delete", ["WFInput": Self.attachment(v), "WFDeleteFileConfirmDeletion": .bool(false)]) }
    mutating func stop() { add("exit") }
    mutating func wait(_ seconds: Int) { add("delay", ["WFDelayTime": .int(seconds)]) }

    /// Waits for `outbox/<id>.json` (polling every 2 s up to `seconds`), shows its `text`, deletes it, and stops.
    /// Falls through (to the caller's "no answer" step) when the reply never comes.
    mutating func awaitReply(id: ShortcutVar, seconds: Int, onReply: (inout ShortcutBuilder, ShortcutVar) -> Void) {
        repeatCount(max(1, seconds / 2)) { b in
            b.wait(2)
            let f = b.getFile([.text(PhoneShortcuts.folder + "/outbox/"), .variable(id), .text(".json")], errorIfMissing: false)
            _ = b.ifHasValue(f, then: { b in
                let text = b.dictionaryValue(f, key: "text")
                onReply(&b, text)
                b.delete(f)
                b.stop()
            })
        }
    }
}

public struct GeneratedShortcut: Sendable {
    public var fileName: String
    public var name: String
    public var workflow: ShortcutValue

    /// The unsigned .shortcut (binary plist), ready for `shortcuts sign`.
    public func data(format: PropertyListSerialization.PropertyListFormat = .binary) throws -> Data {
        try PropertyListSerialization.data(fromPropertyList: workflow.plist, format: format, options: 0)
    }
}

public enum PhoneShortcuts {
    /// Folder inside the Shortcuts iCloud Drive folder (= `<relay root>`).
    public static let folder = "Glide/Phone"

    static func workflow(_ b: ShortcutBuilder, color: Int, glyph: Int, types: [String] = [], input: [String] = []) -> ShortcutValue {
        .dict([
            "WFWorkflowClientVersion": .string("2302.0.4"),
            "WFWorkflowMinimumClientVersion": .int(900),
            "WFWorkflowMinimumClientVersionString": .string("900"),
            "WFWorkflowIcon": .dict(["WFWorkflowIconStartColor": .int(color), "WFWorkflowIconGlyphNumber": .int(glyph)]),
            "WFWorkflowImportQuestions": .array([]),
            "WFWorkflowTypes": .array(types.map(ShortcutValue.string)),
            "WFWorkflowInputContentItemClasses": .array(input.map(ShortcutValue.string)),
            "WFWorkflowOutputContentItemClasses": .array([]),
            "WFWorkflowHasShortcutInputVariables": .bool(!input.isEmpty),
            "WFQuickActionSurfaces": .array([]),
            "WFWorkflowActions": .array(b.actions),
        ])
    }

    static let blue = 463_140_863
    static let purple = 2_071_128_575
    static let green = 2_481_914_879
    static let orange = 4_251_333_119

    /// Share sheet: text, links and photos → `send`, after asking where it should go on the Mac.
    public static func sendToGlide() -> GeneratedShortcut {
        var b = ShortcutBuilder(seed: "Send to Glide")
        b.comment("Sends what you share to Glide on your Mac through iCloud Drive (\(folder)). Made by Glide.")
        let choices = b.add("dictionary", ["WFItems": ShortcutBuilder.fieldValue([
            .text("Copy to the Mac clipboard", [.text("clipboard")]),
            .text("Open on the Mac", [.text("open")]),
            .text("Add to a Glide note", [.text("note")]),
        ])], output: "Dictionary")!
        let chosen = b.add("choosefromlist", ["WFInput": ShortcutBuilder.attachment(choices), "WFChooseFromListActionPrompt": .string("Send to your Mac")],
                           output: "Chosen Item")!
        let to = b.add("getvalueforkey", ["WFInput": ShortcutBuilder.attachment(choices), "WFDictionaryKey": ShortcutBuilder.tokenString([.variable(chosen)]),
                                          "WFGetDictionaryValueType": .string("Value")], output: "Dictionary Value")!
        let id = b.requestId()
        let images = b.add("detect.images", ["WFInput": ShortcutBuilder.attachment(.shortcutInput)], output: "Images")!
        _ = b.ifHasValue(images, then: { b in
            let jpeg = b.add("image.convert", ["WFInput": ShortcutBuilder.attachment(images), "WFImageFormat": .string("JPEG"),
                                               "WFImageCompressionQuality": .double(0.8), "WFImagePreserveMetadata": .bool(false)], output: "Converted Image")!
            let b64 = b.add("base64encode", ["WFInput": ShortcutBuilder.attachment(jpeg), "WFEncodeMode": .string("Encode"),
                                             "WFBase64LineBreakMode": .string("None")], output: "Base64 Encoded")!
            b.sendRequest(id: id, action: "send", args: [.text("image", [.variable(b64)]), .text("to", [.variable(to)])])
        }, otherwise: { b in
            let text = b.add("detect.text", ["WFInput": ShortcutBuilder.attachment(.shortcutInput)], output: "Text")!
            b.sendRequest(id: id, action: "send", args: [.text("text", [.variable(text)]), .text("to", [.variable(to)])])
        })
        b.notify("Sent to your Mac", [.text("Glide picks it up as soon as iCloud Drive syncs.")])
        return GeneratedShortcut(fileName: "Send to Glide.shortcut", name: "Send to Glide",
                                 workflow: workflow(b, color: blue, glyph: 61_440, types: ["ActionExtension"],
                                                    input: ["WFStringContentItem", "WFURLContentItem", "WFImageContentItem", "WFRichTextContentItem"]))
    }

    /// iPhone clipboard → Mac clipboard (`clipboard.set`, needs the Clipboard group).
    public static func sendClipboardToMac() -> GeneratedShortcut {
        var b = ShortcutBuilder(seed: "Send Clipboard to Mac")
        b.comment("Puts the iPhone clipboard on your Mac's clipboard through iCloud Drive. Needs Clipboard turned on in Glide → Settings → iPhone.")
        let clip = b.add("getclipboard", [:], output: "Clipboard")!
        let id = b.requestId()
        b.sendRequest(id: id, action: "clipboard.set", args: [.text("text", [.variable(clip)])])
        b.awaitReply(id: id, seconds: 30) { b, text in b.notify("Glide", [.variable(text)]) }
        b.notify("Sent to your Mac", [.text("Glide puts it on the clipboard as soon as iCloud Drive syncs.")])
        return GeneratedShortcut(fileName: "Send Clipboard to Mac.shortcut", name: "Send Clipboard to Mac",
                                 workflow: workflow(b, color: green, glyph: 59_511))
    }

    /// Reads `clipboard.json` (the Mac keeps it up to date when the clipboard mirror is on) onto the iPhone clipboard.
    public static func getMacClipboard() -> GeneratedShortcut {
        var b = ShortcutBuilder(seed: "Get Mac Clipboard")
        b.comment("Copies your Mac's clipboard to this iPhone. Turn on \"Share the Mac clipboard\" in Glide → Settings → iPhone.")
        let f = b.getFile([.text(folder + "/clipboard.json")], errorIfMissing: false)
        _ = b.ifHasValue(f, then: { b in
            let text = b.dictionaryValue(f, key: "text")
            b.add("setclipboard", ["WFInput": ShortcutBuilder.attachment(text), "WFLocalOnly": .bool(true)])
            b.notify("Copied from your Mac", [.variable(text)])
        }, otherwise: { b in
            b.alert("No Mac clipboard yet", "Turn on \"Share the Mac clipboard\" in Glide → Settings → iPhone, then wait for iCloud Drive to sync.")
        })
        return GeneratedShortcut(fileName: "Get Mac Clipboard.shortcut", name: "Get Mac Clipboard",
                                 workflow: workflow(b, color: green, glyph: 59_511))
    }

    /// Runs a Glide workflow by name. Takes the name as input (phone automations: leave home, CarPlay, alarm), else asks.
    public static func runWorkflow() -> GeneratedShortcut {
        var b = ShortcutBuilder(seed: "Run Glide Workflow")
        b.comment("Runs a Glide workflow on your Mac. Pass the workflow name as input (for automations), or it asks.")
        let input = b.add("detect.text", ["WFInput": ShortcutBuilder.attachment(.shortcutInput)], output: "Text")!
        let name = b.ifHasValue(input, then: { b in
            _ = b.text([.variable(input)], name: "Workflow")
        }, otherwise: { b in
            _ = b.ask("Which Glide workflow?")
        }, output: "If Result")!
        let id = b.requestId()
        b.sendRequest(id: id, action: "workflows.run", args: [.text("name", [.variable(name)])])
        return GeneratedShortcut(fileName: "Run Glide Workflow.shortcut", name: "Run Glide Workflow",
                                 workflow: workflow(b, color: orange, glyph: 59_446, input: ["WFStringContentItem"]))
    }

    /// Asks Glide Agent (`agent.ask`) and shows the answer, waiting up to 2 minutes (Ask on the Mac can take one).
    public static func askAgent() -> GeneratedShortcut {
        var b = ShortcutBuilder(seed: "Ask Glide Agent")
        b.comment("Asks Glide Agent on your Mac and shows the answer. Needs Glide Agent turned on in Glide → Settings → iPhone.")
        let input = b.add("detect.text", ["WFInput": ShortcutBuilder.attachment(.shortcutInput)], output: "Text")!
        let prompt = b.ifHasValue(input, then: { b in
            _ = b.text([.variable(input)], name: "Prompt")
        }, otherwise: { b in
            _ = b.ask("Ask Glide")
        }, output: "If Result")!
        let id = b.requestId()
        b.sendRequest(id: id, action: "agent.ask", args: [.text("prompt", [.variable(prompt)])])
        b.awaitReply(id: id, seconds: 120) { b, text in b.showResult([.variable(text)]) }
        b.alert("No answer yet", "Glide did not answer in two minutes. Check that your Mac is awake and that iCloud Drive is syncing, then try again.")
        return GeneratedShortcut(fileName: "Ask Glide Agent.shortcut", name: "Ask Glide Agent",
                                 workflow: workflow(b, color: purple, glyph: 59_771, input: ["WFStringContentItem"]))
    }

    public static func all() -> [GeneratedShortcut] {
        [sendToGlide(), sendClipboardToMac(), getMacClipboard(), runWorkflow(), askAgent()]
    }
}
