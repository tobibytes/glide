import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// AI (feature id "ai", like src/main/features/ai): Quick AI (launcher view "ai.chat"), the AI Chat window,
/// AI Commands over the selected text (built-ins + custom commands with {selection} / {argument}) and the
/// Settings → AI page. The API key lives in the Keychain and only ever leaves this module in a request header.
///
/// Environment (tests / headless): GLIDE_AI_BASE_URL (a 127.0.0.1 fake server; required for any request in
/// headless mode), GLIDE_AI_TEST_KEY (seeds the in-memory key store), GLIDE_AI_TEST_SAFE_STORAGE_PASSWORD
/// (stands in for the Electron safe-storage Keychain password during "Import key from previous Glide").
@MainActor public final class AIFeature: Feature, FeatureUI, FeatureCommandHandling, AIClientProvider {
    public let id = "ai"
    public let title = "AI"
    public static let quickViewName = "chat"
    public static var quickViewId: ViewID { ViewID(feature: "ai", name: quickViewName) }

    private(set) weak var context: FeatureContext?
    private(set) var keys = AIKeyStore(store: MemorySecretStore())
    private(set) var chats: AIChatStore?
    private var passwords: SafeStoragePasswordSource = FixedSafeStoragePassword(nil)
    private(set) var baseURL: URL?
    private(set) var headless = false
    private(set) var baseURLRejected: String?
    /// The pushed Quick AI view's model (created when pushing so keys and streaming work before rendering).
    private(set) var quick: QuickAISession?
    private(set) var chatModel: AIChatModel?
    private var chatWindow: AIChatWindowController?
    /// Bumped when the settings page should re-read key status.
    let settingsModel = AISettingsModel()

    private let environment: [String: String]

    public init(environment: [String: String] = ProcessInfo.processInfo.environment) { self.environment = environment }

    public func start(context: FeatureContext) async {
        self.context = context
        headless = context.services.isHeadless
        chats = AIChatStore(directory: context.dataDirectory().appendingPathComponent("chats", isDirectory: true))
        (baseURL, baseURLRejected) = Self.resolveBaseURL(environment["GLIDE_AI_BASE_URL"], headless: headless)
        if headless {
            keys = AIKeyStore(store: MemorySecretStore(environment["GLIDE_AI_TEST_KEY"].flatMap { $0.isEmpty ? nil : $0 }))
            passwords = FixedSafeStoragePassword(environment["GLIDE_AI_TEST_SAFE_STORAGE_PASSWORD"])
        } else {
            keys = AIKeyStore(store: KeychainSecretStore())
            passwords = KeychainSafeStoragePassword()
        }
        settingsModel.feature = self
    }

    public func stop() async {
        quick?.conversation.stop()
        chatModel?.conversation.stop()
    }

    /// Tests and headless runs may only talk to a loopback server; the real app may override to any https URL.
    nonisolated static func resolveBaseURL(_ raw: String?, headless: Bool) -> (URL?, String?) {
        guard let raw, !raw.isEmpty else { return (nil, nil) }
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return (nil, "invalid GLIDE_AI_BASE_URL") }
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(host)
        if headless && !loopback { return (nil, "headless runs only allow a loopback GLIDE_AI_BASE_URL") }
        if scheme == "https" || (scheme == "http" && loopback) { return (url, nil) }
        return (nil, "GLIDE_AI_BASE_URL must be https (or http on loopback)")
    }

    // MARK: settings

    var bag: [String: JSONValue] {
        context?.settings(defaults: ["model": .string(AIModels.defaultModel), "effort": "medium", "customCommands": []]) ?? [:]
    }
    var currentModel: String { bag["model"]?.stringValue.flatMap { AIModels.isKnown($0) ? $0 : nil } ?? AIModels.defaultModel }
    var currentEffort: String { bag["effort"]?.stringValue.flatMap { AIModels.efforts.contains($0) ? $0 : nil } ?? "medium" }
    var customCommands: [AICommandDef] { (bag["customCommands"]?.arrayValue ?? []).compactMap(AITemplates.sanitize) }
    var allCommands: [AICommandDef] { AITemplates.builtins + (context == nil ? [] : customCommands) }

    func settingsJSON() -> JSONValue {
        ["model": .string(currentModel), "effort": .string(currentEffort), "customCommands": .array(customCommands.map(\.json))]
    }

    @discardableResult
    func applySettings(_ patch: JSONValue) -> JSONValue {
        var out: [String: JSONValue] = [:]
        if let m = patch["model"]?.stringValue, AIModels.isKnown(m) { out["model"] = .string(m) }
        if let e = patch["effort"]?.stringValue, AIModels.efforts.contains(e) { out["effort"] = .string(e) }
        if let list = patch["customCommands"]?.arrayValue { out["customCommands"] = .array(AITemplates.sanitizeList(list).map(\.json)) }
        context?.setSettings(out)
        if out["customCommands"] != nil { context?.refreshCatalogue() }
        settingsModel.revision += 1
        return settingsJSON()
    }

    // MARK: client

    func makeClient() throws -> AnthropicClient {
        if let baseURLRejected, headless { throw AIError(.network, "AI requests are disabled: \(baseURLRejected)") }
        if headless && baseURL == nil { throw AIError(.network, "AI requests are disabled in headless mode (set GLIDE_AI_BASE_URL to a local test server)") }
        guard let key = keys.read() else { throw AIError.noKey }
        return AnthropicClient(apiKey: key, baseURL: baseURL)
    }

    var dataDirectory: URL? { context?.dataDirectory() }
    var legacyKeyAvailable: Bool { dataDirectory.map(LegacyKeyImport.available(in:)) ?? false }

    /// "Import key from previous Glide": the ONLY place the Electron safe-storage Keychain item is read.
    func importLegacyKey() -> Result<AIKeyStatus, AIError> {
        guard let dir = dataDirectory else { return .failure(AIError(.other, "Not started")) }
        do {
            let key = try LegacyKeyImport.decrypt(dataDirectory: dir, passwords: passwords)
            let status = try keys.set(key)
            settingsModel.revision += 1
            return .success(status)
        } catch {
            return .failure(AIError.from(error))
        }
    }

    func testConnection(model: String?) async -> (ok: Bool, message: String, kind: AIErrorKind?) {
        do {
            let client = try makeClient()
            let name = try await client.testKey(model: model.flatMap { AIModels.isKnown($0) ? $0 : nil } ?? currentModel)
            return (true, "Connected — \(name) is available.", nil)
        } catch {
            let e = AIError.from(error)
            return (false, e.kind == .noKey ? "No API key saved yet." : e.message, e.kind)
        }
    }

    // MARK: catalogue

    func commandItem(_ cmd: AICommandDef) -> SearchItem {
        SearchItem(id: "ai:command:\(cmd.id)", kind: .command, title: cmd.name, subtitle: cmd.builtin ? "AI Command · uses selected text" : "Custom AI Command",
                   icon: .emoji(cmd.icon), keywords: ["ai", "selection", "text"] + (cmd.acceptsArgument ? ["translate"] : []),
                   acceptsArgument: cmd.acceptsArgument, feature: id, data: ["type": "command", "commandId": .string(cmd.id)], kindLabel: "AI Command")
    }

    public func items() -> [SearchItem] {
        [SearchItem(id: "ai:chat", kind: .command, title: "AI Chat", subtitle: "Chat with Claude in a window", icon: .emoji("💬"),
                    keywords: ["ai", "claude", "chat", "gpt", "assistant"], feature: id, data: ["type": "chat"], kindLabel: "AI"),
         SearchItem(id: "ai:quick", kind: .command, title: "Quick AI", subtitle: "Ask Claude right here", icon: .emoji("✨"),
                    keywords: ["ai", "ask", "claude", "question"], acceptsArgument: true, feature: id, data: ["type": "quick"], kindLabel: "AI")]
            + allCommands.map(commandItem)
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["type"]?.stringValue {
        case "chat": return [ItemAction(id: "open", title: "Open AI Chat", shortcut: "↩", icon: "bubble.left.and.bubble.right")]
        case "quick", "ask":
            return [ItemAction(id: "ask", title: "Ask AI", shortcut: "↩", icon: "sparkles"),
                    ItemAction(id: "askInChat", title: "Ask in AI Chat", shortcut: "⌘↩", icon: "bubble.left.and.bubble.right")]
        case "command":
            return [ItemAction(id: "run", title: "Run AI Command", shortcut: "↩", icon: "sparkles"),
                    ItemAction(id: "editCommands", title: "Edit AI Commands…", shortcut: "⌘E", icon: "pencil")]
        default: return []
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let item = scored.item
        let argument = (scored.argument?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
        let prompt = argument ?? item.data?["prompt"]?.stringValue ?? ""
        switch action {
        case "open":
            openChatWindow(prompt: nil, messages: nil, title: nil)
            return .hide()
        case "ask":
            return pushQuick(QuickAIProps(prompt: prompt.isEmpty ? nil : prompt))
        case "askInChat":
            openChatWindow(prompt: prompt.isEmpty ? nil : prompt, messages: nil, title: nil)
            return .hide()
        case "editCommands": return .openSettings(page: "ai")
        case "run":
            guard let cmd = allCommands.first(where: { $0.id == item.data?["commandId"]?.stringValue }) else { return .error("AI command not found") }
            return await runCommand(cmd, argument: argument)
        default: return .error("Unknown action \(action)")
        }
    }

    func runCommand(_ cmd: AICommandDef, argument: String?) async -> ActionResult {
        guard let ctx = context else { return .error("Not started") }
        if cmd.acceptsArgument && argument == nil { return .error("\(cmd.name) needs an argument — press Tab and type it") }
        let sel = await SelectionInput.read(ctx.services)
        if sel.source == .none { return .error("Select some text (or copy it) first, then run the command again.") }
        let baseName = cmd.name.replacingOccurrences(of: " …", with: "").replacingOccurrences(of: "…", with: "").trimmingCharacters(in: .whitespaces)
        let props = QuickAIProps(prompt: AITemplates.fill(cmd.prompt, selection: sel.text, argument: argument),
                                 title: cmd.acceptsArgument && argument != nil ? "\(baseName) \(argument ?? "")" : cmd.name,
                                 model: cmd.model, replaces: cmd.replaces && sel.source == .selection,
                                 notice: sel.source == .clipboard ? "\(sel.note ?? "No selected text found") — used the clipboard instead." : nil)
        return pushQuick(props)
    }

    // MARK: Quick AI

    func pushQuick(_ props: QuickAIProps) -> ActionResult {
        let s = makeQuick(props)
        s.start()
        var payload = props.json
        if case var .object(o) = payload { o["session"] = .string(s.nonce); payload = .object(o) }
        return .pushView(Self.quickViewId, payload: payload)
    }

    @discardableResult
    func makeQuick(_ props: QuickAIProps) -> QuickAISession {
        quick?.conversation.stop()
        let s = QuickAISession(feature: self, props: props)
        quick = s
        return s
    }

    /// Paste into the app behind the (non-activating) launcher: hide the panel, pasteboard + ⌘V.
    func paste(_ text: String) {
        guard let ctx = context else { return }
        ctx.hideLauncher()
        ctx.services.paste.paste(text: text, html: nil)
    }

    func copy(_ text: String) {
        context?.services.pasteboard.setString(text, html: nil, transient: false)
        context?.toast("Answer copied", style: .success)
    }

    func toast(_ m: String, _ s: ToastStyle) { context?.toast(m, style: s) }
    func openSettingsPage() { context?.openSettings(page: "ai") }

    // MARK: chat window

    func openChatWindow(prompt: String?, messages: [AIChatMessage]?, title: String?) {
        guard let ctx = context, let chats else { return }
        let model = chatModel ?? AIChatModel(feature: self, store: chats)
        chatModel = model
        if let messages, !messages.isEmpty {
            let saved = try? chats.save(AIChat(id: AIChats.newId(), title: title ?? AIChats.deriveTitle(messages), model: currentModel,
                                               createdAt: AIChats.nowMs(), updatedAt: AIChats.nowMs(), messages: messages))
            model.reload()
            if let saved { model.select(saved.id) }
        } else if let prompt {
            model.newChat()
            model.draft = prompt
            model.sendDraft()
        }
        ctx.hideLauncher()
        if headless {
            ctx.log("chat window requested (headless: not shown)")
            return
        }
        if chatWindow == nil { chatWindow = AIChatWindowController(model: model) }
        chatWindow?.show()
    }

    // MARK: UI

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "AI", symbol: "sparkles", order: 60) { [weak self] in
            guard let self else { return AnyView(EmptyView()) }
            return AnyView(AISettingsView(model: self.settingsModel))
        }
    }

    public func launcherView(_ view: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard view.name == Self.quickViewName else { return nil }
        let s: QuickAISession
        if let cur = quick, payload["session"]?.stringValue == nil || payload["session"]?.stringValue == cur.nonce {
            s = cur
        } else {
            s = makeQuick(QuickAIProps(payload))
            s.start()
        }
        return AnyView(QuickAIView(session: s, host: host))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        guard view.name == Self.quickViewName, let q = quick else { return false }
        return q.handleKey(key)
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        guard view.name == Self.quickViewName, let q = quick else { return false }
        return q.handleCommand(command)
    }

    // MARK: methods (other features, test channel)

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "getSettings": return settingsJSON()
        case "setSettings": return applySettings(args)
        case "listModels": return .array(AIModels.all.map { ["id": .string($0.id), "label": .string($0.label), "description": .string($0.description)] })
        case "listCommands": return .array(allCommands.map(\.json))
        case "hasApiKey":
            let s = keys.status()
            return ["hasKey": .bool(s.hasKey), "encryptionAvailable": .bool(s.encryptionAvailable), "legacyKeyAvailable": .bool(legacyKeyAvailable)]
        case "setApiKey":
            let s = try keys.set(args["key"]?.stringValue ?? args.stringValue ?? "")
            return ["hasKey": .bool(s.hasKey)]
        case "clearApiKey": return ["hasKey": .bool(try keys.clear().hasKey)]
        case "importLegacyKey":
            switch importLegacyKey() {
            case let .success(s): return ["ok": true, "hasKey": .bool(s.hasKey)]
            case let .failure(e): return ["ok": false, "error": .string(e.message)]
            }
        case "testConnection":
            let r = await testConnection(model: args["model"]?.stringValue)
            return ["ok": .bool(r.ok), "message": .string(r.message), "kind": r.kind.map { .string($0.rawValue) } ?? .null]
        case "ask":
            // One-shot answer (workflows' askAI): {prompt, system?, model?} → {text, model}.
            let conv = AIConversation(provider: self, model: args["model"]?.stringValue)
            conv.system = args["system"]?.stringValue
            conv.ask(args["prompt"]?.stringValue ?? "")
            await conv.wait()
            if let e = conv.error { return ["ok": false, "error": .string(e.message), "kind": .string(e.kind.rawValue)] }
            return ["ok": true, "text": .string(conv.lastAnswer ?? ""), "model": .string(conv.lastModel ?? conv.effectiveModel)]
        case "quickState":
            guard let q = quick else { return .null }
            if args["wait"]?.boolValue == true { await q.conversation.wait() }
            return q.stateJSON()
        case "listChats":
            return .array((chats?.list() ?? []).map { ["id": .string($0.id), "title": .string($0.title), "messageCount": .int(Int64($0.messageCount)), "preview": .string($0.preview)] })
        case "getChat":
            guard let id = args["id"]?.stringValue ?? args.stringValue, let c = chats?.get(id) else { return .null }
            return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(c))
        case "deleteChat":
            return .bool(chats?.delete(args["id"]?.stringValue ?? args.stringValue ?? "") ?? false)
        case "openChatWindow":
            let msgs = args["messages"]?.arrayValue.map(AIChats.sanitize(messages:))
            openChatWindow(prompt: args["prompt"]?.stringValue, messages: msgs, title: args["title"]?.stringValue)
            return ["ok": true, "chatId": chatModel?.currentId.map(JSONValue.string) ?? .null]
        case "chatState":
            guard let m = chatModel else { return .null }
            if args["wait"]?.boolValue == true { await m.conversation.wait() }
            return m.stateJSON()
        case "chatSend":
            guard let m = chatModel else { throw FeatureError.failed("No chat window") }
            m.draft = args["text"]?.stringValue ?? ""
            m.sendDraft()
            if args["wait"]?.boolValue != false { await m.conversation.wait() }
            return m.stateJSON()
        case "snapshotChat":
            guard let m = chatModel, let path = args["path"]?.stringValue else { throw FeatureError.invalidArguments("path required") }
            let size = try AIChatWindowController.snapshot(model: m, to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .int(Int64(size.width)), "height": .int(Int64(size.height))]
        case "snapshotSettings":
            guard let path = args["path"]?.stringValue else { throw FeatureError.invalidArguments("path required") }
            let size = try AIChatWindowController.snapshot(view: AISettingsView(model: settingsModel).frame(width: 640, height: 720), size: NSSize(width: 640, height: 720), to: URL(fileURLWithPath: path))
            return ["path": .string(path), "width": .int(Int64(size.width)), "height": .int(Int64(size.height))]
        case "getSelection":
            guard let ctx = context else { throw FeatureError.failed("Not started") }
            let s = await SelectionInput.read(ctx.services)
            return ["text": .string(s.text), "source": .string(s.source.rawValue), "note": s.note.map(JSONValue.string) ?? .null]
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

/// Props of the "ai.chat" launcher view (QuickAiProps).
struct QuickAIProps: Equatable {
    var prompt: String?
    /// Shown above the answer (AI command name); the first user turn is then hidden.
    var title: String?
    var model: String?
    /// Offer "Replace Selection" (⏎ with an empty field).
    var replaces = false
    /// e.g. "No selection found — used clipboard text".
    var notice: String?

    init(prompt: String? = nil, title: String? = nil, model: String? = nil, replaces: Bool = false, notice: String? = nil) {
        self.prompt = prompt
        self.title = title
        self.model = model
        self.replaces = replaces
        self.notice = notice
    }

    init(_ p: JSONValue) {
        self.init(prompt: p["prompt"]?.stringValue, title: p["title"]?.stringValue, model: p["model"]?.stringValue,
                  replaces: p["replaces"]?.boolValue == true, notice: p["notice"]?.stringValue)
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["replaces": .bool(replaces)]
        if let prompt { o["prompt"] = .string(prompt) }
        if let title { o["title"] = .string(title) }
        if let model { o["model"] = .string(model) }
        if let notice { o["notice"] = .string(notice) }
        return .object(o)
    }
}
