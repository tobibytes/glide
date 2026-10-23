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
    private(set) var anthropicKeys = AIKeyStore(store: MemorySecretStore())
    private(set) var openaiKeys = AIKeyStore(store: MemorySecretStore())
    /// The active provider's key store.
    var keys: AIKeyStore { provider == .openai ? openaiKeys : anthropicKeys }
    func keys(for p: AIProvider) -> AIKeyStore { p == .openai ? openaiKeys : anthropicKeys }
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
    /// One-shot streamed answers for other features (extensions' AI.ask): id → conversation + characters already handed out.
    private var askStreams: [String: (conv: AIConversation, sent: Int)] = [:]
    private var askStreamSeq = 0

    private let environment: [String: String]

    public init(environment: [String: String] = ProcessInfo.processInfo.environment) { self.environment = environment }

    public func start(context: FeatureContext) async {
        self.context = context
        headless = context.services.isHeadless
        chats = AIChatStore(directory: context.dataDirectory().appendingPathComponent("chats", isDirectory: true))
        (baseURL, baseURLRejected) = Self.resolveBaseURL(environment["GLIDE_AI_BASE_URL"], headless: headless)
        if headless {
            anthropicKeys = AIKeyStore(store: MemorySecretStore(environment["GLIDE_AI_TEST_KEY"].flatMap { $0.isEmpty ? nil : $0 }))
            openaiKeys = AIKeyStore(store: MemorySecretStore(environment["GLIDE_AI_TEST_OPENAI_KEY"].flatMap { $0.isEmpty ? nil : $0 }))
            passwords = FixedSafeStoragePassword(environment["GLIDE_AI_TEST_SAFE_STORAGE_PASSWORD"])
        } else {
            anthropicKeys = AIKeyStore(store: KeychainSecretStore(account: AIProvider.anthropic.keychainAccount))
            openaiKeys = AIKeyStore(store: KeychainSecretStore(account: AIProvider.openai.keychainAccount))
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
        context?.settings(defaults: ["provider": "anthropic", "model": .string(AIModels.defaultModel), "openaiModel": .string(OpenAIModels.defaultModel),
                                     "openaiBaseURL": "", "effort": "medium", "customCommands": []]) ?? [:]
    }
    var provider: AIProvider { bag["provider"]?.stringValue.flatMap(AIProvider.init(rawValue:)) ?? .anthropic }
    var anthropicModel: String { bag["model"]?.stringValue.flatMap { AIModels.isKnown($0) ? $0 : nil } ?? AIModels.defaultModel }
    var openaiModel: String { bag["openaiModel"]?.stringValue.flatMap { OpenAIModels.isValid($0) ? $0 : nil } ?? OpenAIModels.defaultModel }
    /// Optional OpenAI-compatible server (OpenRouter, Ollama, LM Studio); empty = api.openai.com.
    var openaiBaseURL: String { bag["openaiBaseURL"]?.stringValue ?? "" }
    var currentModel: String { provider == .openai ? openaiModel : anthropicModel }
    var currentEffort: String { bag["effort"]?.stringValue.flatMap { AIModels.efforts.contains($0) ? $0 : nil } ?? "medium" }
    var customCommands: [AICommandDef] { (bag["customCommands"]?.arrayValue ?? []).compactMap(AITemplates.sanitize) }
    var allCommands: [AICommandDef] { AITemplates.builtins + (context == nil ? [] : customCommands) }

    /// A per-request model override if it fits the active provider (AI Commands pin Claude ids), else the default.
    func resolveModel(_ id: String?) -> String {
        switch provider {
        case .anthropic: return id.flatMap { AIModels.isKnown($0) ? $0 : nil } ?? anthropicModel
        case .openai: return id.flatMap { OpenAIModels.isValid($0) ? $0 : nil } ?? openaiModel
        }
    }

    /// Models for pickers (chat window, command editor): the active provider's list (plus the custom OpenAI id).
    var modelChoices: [AIModelInfo] {
        guard provider == .openai else { return AIModels.all }
        var list = OpenAIModels.suggested
        if !list.contains(where: { $0.id == openaiModel }) { list.insert(AIModelInfo(id: openaiModel, label: openaiModel, description: "Custom"), at: 0) }
        return list
    }

    func modelLabel(_ id: String?) -> String {
        guard let id else { return provider.label }
        return AIModels.isKnown(id) ? AIModels.label(id) : OpenAIModels.label(id)
    }

    func settingsJSON() -> JSONValue {
        ["provider": .string(provider.rawValue), "model": .string(anthropicModel), "openaiModel": .string(openaiModel),
         "openaiBaseURL": .string(openaiBaseURL), "effort": .string(currentEffort), "customCommands": .array(customCommands.map(\.json))]
    }

    nonisolated static func validOpenAIBaseURL(_ raw: String) -> Bool {
        if raw.isEmpty { return true }
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return false }
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(host)
        return scheme == "https" || (scheme == "http" && loopback)
    }

    @discardableResult
    func applySettings(_ patch: JSONValue) -> JSONValue {
        var out: [String: JSONValue] = [:]
        if let p = patch["provider"]?.stringValue, AIProvider(rawValue: p) != nil { out["provider"] = .string(p) }
        if let m = patch["openaiModel"]?.stringValue?.trimmingCharacters(in: .whitespaces), OpenAIModels.isValid(m) { out["openaiModel"] = .string(m) }
        if let u = patch["openaiBaseURL"]?.stringValue?.trimmingCharacters(in: .whitespaces), Self.validOpenAIBaseURL(u) {
            out["openaiBaseURL"] = .string(u.hasSuffix("/") ? String(u.dropLast()) : u)
        }
        if let m = patch["model"]?.stringValue, AIModels.isKnown(m) { out["model"] = .string(m) }
        if let e = patch["effort"]?.stringValue, AIModels.efforts.contains(e) { out["effort"] = .string(e) }
        if let list = patch["customCommands"]?.arrayValue { out["customCommands"] = .array(AITemplates.sanitizeList(list).map(\.json)) }
        context?.setSettings(out)
        if out["customCommands"] != nil { context?.refreshCatalogue() }
        settingsModel.revision += 1
        return settingsJSON()
    }

    // MARK: client

    func makeClient() throws -> any AIChatClient {
        if let baseURLRejected, headless { throw AIError(.network, "AI requests are disabled: \(baseURLRejected)") }
        if headless && baseURL == nil { throw AIError(.network, "AI requests are disabled in headless mode (set GLIDE_AI_BASE_URL to a local test server)") }
        switch provider {
        case .anthropic:
            guard let key = anthropicKeys.read() else { throw AIError.noKey }
            return AnthropicClient(apiKey: key, baseURL: baseURL)
        case .openai:
            // Headless: only the loopback test server. Real app: the custom server if set, else api.openai.com.
            let custom = headless ? nil : (openaiBaseURL.isEmpty ? nil : OpenAIClient.normalizedBaseURL(openaiBaseURL))
            let url = baseURL.map { $0.appendingPathComponent("v1") } ?? custom
            let local = url.map { ["127.0.0.1", "localhost", "::1"].contains($0.host?.lowercased() ?? "") } ?? false
            // Local servers (Ollama, LM Studio) usually need no key.
            guard let key = openaiKeys.read() ?? (local && !headless ? "local" : nil) else { throw AIError.noKey }
            return OpenAIClient(apiKey: key, baseURL: url)
        }
    }

    /// Saves a key. A recognisable key for the other provider is stored there and that provider is selected.
    @discardableResult
    func saveKey(_ raw: String) throws -> AIKeyStatus {
        let target = AIProvider.detect(key: raw) ?? provider
        let s = try keys(for: target).set(raw)
        if target != provider && s.hasKey { applySettings(["provider": .string(target.rawValue)]) }
        settingsModel.revision += 1
        return s
    }

    var dataDirectory: URL? { context?.dataDirectory() }
    var legacyKeyAvailable: Bool { dataDirectory.map(LegacyKeyImport.available(in:)) ?? false }

    /// "Import key from previous Glide": the ONLY place the Electron safe-storage Keychain item is read.
    func importLegacyKey() -> Result<AIKeyStatus, AIError> {
        guard let dir = dataDirectory else { return .failure(AIError(.other, "Not started")) }
        do {
            let key = try LegacyKeyImport.decrypt(dataDirectory: dir, passwords: passwords)
            let status = try anthropicKeys.set(key)
            settingsModel.revision += 1
            return .success(status)
        } catch {
            return .failure(AIError.from(error))
        }
    }

    func testConnection(model: String?) async -> (ok: Bool, message: String, kind: AIErrorKind?) {
        do {
            let client = try makeClient()
            let name = try await client.testKey(model: resolveModel(model))
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
        case "listModels": return .array(modelChoices.map { ["id": .string($0.id), "label": .string($0.label), "description": .string($0.description)] })
        case "listCommands": return .array(allCommands.map(\.json))
        case "hasApiKey":
            let s = keys.status()
            return ["hasKey": .bool(s.hasKey), "encryptionAvailable": .bool(s.encryptionAvailable), "legacyKeyAvailable": .bool(legacyKeyAvailable),
                    "provider": .string(provider.rawValue)]
        case "setApiKey":
            let s = try saveKey(args["key"]?.stringValue ?? args.stringValue ?? "")
            return ["hasKey": .bool(s.hasKey), "provider": .string(provider.rawValue)]
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
        case "askStream":
            // Streamed one-shot answer: {prompt, system?, model?} → {ok, id}; then poll with askStreamPoll {id, wait?}.
            let conv = AIConversation(provider: self, model: args["model"]?.stringValue)
            conv.system = args["system"]?.stringValue
            askStreamSeq += 1
            let sid = "as\(askStreamSeq)"
            askStreams[sid] = (conv, 0)
            conv.ask(args["prompt"]?.stringValue ?? "")
            return ["ok": true, "id": .string(sid)]
        case "askStreamPoll":
            // {id, wait? (ms, default 1000)} → {delta, done, ok, text?, model?, error?, kind?}; waits for new text or the end.
            guard let sid = args["id"]?.stringValue, askStreams[sid] != nil else { return ["ok": false, "done": true, "delta": "", "error": "Unknown AI stream", "kind": "other"] }
            let deadline = ContinuousClock.now + .milliseconds(Int(args["wait"]?.intValue ?? 1000))
            func pending() -> String {
                guard let e = askStreams[sid], let m = e.conv.messages.last, m.role == "assistant", m.content.count > e.sent else { return "" }
                return String(m.content.dropFirst(e.sent))
            }
            while let e = askStreams[sid], e.conv.streaming, pending().isEmpty, ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(15))
            }
            guard let e = askStreams[sid] else { return ["ok": false, "done": true, "delta": "", "error": "Cancelled", "kind": "other"] }
            let delta = pending()
            askStreams[sid]?.sent += delta.count
            if e.conv.streaming { return ["ok": true, "done": false, "delta": .string(delta)] }
            askStreams[sid] = nil
            if let err = e.conv.error { return ["ok": false, "done": true, "delta": .string(delta), "error": .string(err.message), "kind": .string(err.kind.rawValue)] }
            if e.conv.cancelled { return ["ok": false, "done": true, "delta": .string(delta), "error": "Cancelled", "kind": "other"] }
            return ["ok": true, "done": true, "delta": .string(delta), "text": .string(e.conv.lastAnswer ?? ""), "model": .string(e.conv.lastModel ?? e.conv.effectiveModel)]
        case "askStreamCancel":
            if let sid = args["id"]?.stringValue, let e = askStreams.removeValue(forKey: sid) { e.conv.stop() }
            return true
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
