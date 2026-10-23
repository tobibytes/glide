import Foundation
import GlideCore
@testable import GlideFeatures
import GlideTestHarness
import Testing

@Suite("AI feature (headless context + loopback fake API)", .serialized)
@MainActor struct AIFeatureTests {
    func make(_ server: FakeAnthropicServer?, selection: String? = nil, clipboard: String? = nil, key: String? = "sk-ant-test-FAKE",
              password: String? = nil) async throws -> (AIFeature, N4TestContext) {
        let ctx = try N4TestContext(featureId: "ai", selection: selection, clipboard: clipboard)
        var env: [String: String] = [:]
        if let server { env["GLIDE_AI_BASE_URL"] = server.baseURL }
        if let key { env["GLIDE_AI_TEST_KEY"] = key }
        if let password { env["GLIDE_AI_TEST_SAFE_STORAGE_PASSWORD"] = password }
        let f = AIFeature(environment: env)
        await f.start(context: ctx)
        return (f, ctx)
    }

    @Test func baseURLPolicy() {
        #expect(AIFeature.resolveBaseURL("http://127.0.0.1:9", headless: true).0 != nil)
        #expect(AIFeature.resolveBaseURL("https://api.anthropic.com", headless: true).0 == nil) // headless: loopback only
        #expect(AIFeature.resolveBaseURL("https://proxy.example.com", headless: false).0 != nil)
        #expect(AIFeature.resolveBaseURL("http://example.com", headless: false).0 == nil)
    }

    @Test func headlessWithoutFakeServerNeverCallsTheNetwork() async throws {
        let (f, ctx) = try await make(nil)
        defer { ctx.cleanup() }
        #expect(throws: AIError.self) { try f.makeClient() }
    }

    @Test func catalogueAndActions() async throws {
        let (f, ctx) = try await make(nil)
        defer { ctx.cleanup() }
        let items = f.items()
        #expect(items.prefix(2).map(\.id) == ["ai:chat", "ai:quick"])
        #expect(items.contains { $0.id == "ai:command:translate" && $0.acceptsArgument == true })
        #expect(f.actions(for: items[1]).map(\.id) == ["ask", "askInChat"])
        _ = try await f.invoke(method: "setSettings", args: ["customCommands": [["name": "Pirate", "prompt": "Say {selection} like a pirate"]], "model": "claude-sonnet-5-5", "effort": "nope"])
        #expect(f.items().contains { $0.id == "ai:command:custom-pirate" })
        #expect(f.currentModel == "claude-sonnet-5-5")
        #expect(f.currentEffort == "medium")
        #expect(ctx.refreshes == 1)
        #expect(ctx.store.settings.features["ai"]?["customCommands"]?.arrayValue?.first?["id"]?.stringValue == "custom-pirate")
    }

    @Test func aiCommandOnSelectionStreamsAndReplaces() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "Hello, world.", pieces: 3) }
        defer { server.stop() }
        let (f, ctx) = try await make(server, selection: "helo wrld")
        defer { ctx.cleanup() }
        let item = try #require(f.items().first { $0.id == "ai:command:fix-spelling" })
        let r = await f.run(action: "run", on: ScoredItem(item: item, score: 0), modifiers: [])
        guard case let .pushView(view, payload) = r else { Issue.record("expected pushView, got \(r)"); return }
        #expect(view.rawValue == "ai.chat")
        #expect(payload["replaces"]?.boolValue == true)
        #expect(payload["title"]?.stringValue == "Fix Spelling and Grammar")
        let q = try #require(f.quick)
        await q.conversation.wait()
        #expect(q.conversation.lastAnswer == "Hello, world.")
        #expect(q.primaryTitle == "Replace Selection")
        let sent = try #require(server.requests.first?.json)
        let content = ((sent["messages"] as? [[String: Any]])?.first?["content"] as? String) ?? ""
        #expect(content.contains("<text>\nhelo wrld\n</text>"))
        // ⏎ with an empty field replaces the selection: hide + pasteboard + ⌘V
        q.hostProvider = { nil }
        #expect(f.handleCommand(.activate([]), view: view))
        #expect(ctx.hidden == 1)
        #expect(ctx.effects("paste").first?["text"]?.stringValue == "Hello, world.")
    }

    @Test func commandFallsBackToClipboardWithReason() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "• point") }
        defer { server.stop() }
        let (f, ctx) = try await make(server, clipboard: "copied text")
        defer { ctx.cleanup() }
        let item = try #require(f.items().first { $0.id == "ai:command:summarize" })
        let r = await f.run(action: "run", on: ScoredItem(item: item, score: 0), modifiers: [])
        guard case let .pushView(_, payload) = r else { Issue.record("expected pushView"); return }
        #expect(payload["notice"]?.stringValue == "Couldn't read the selection (it didn't report a selection) — used the clipboard instead.")
        #expect(payload["replaces"]?.boolValue == false)
    }

    @Test func translateNeedsArgument() async throws {
        let (f, ctx) = try await make(nil, selection: "hola")
        defer { ctx.cleanup() }
        let item = try #require(f.items().first { $0.id == "ai:command:translate" })
        #expect(await f.run(action: "run", on: ScoredItem(item: item, score: 0), modifiers: []) == .error("Translate to … needs an argument — press Tab and type it"))
    }

    @Test func quickAIFollowUpCopyAndErrors() async throws {
        let server = try FakeAnthropicServer { r in
            let msgs = (r.json?["messages"] as? [[String: Any]]) ?? []
            return .sse(text: msgs.count > 1 ? "Second answer" : "First answer")
        }
        defer { server.stop() }
        let (f, ctx) = try await make(server)
        defer { ctx.cleanup() }
        let item = try #require(f.items().first { $0.id == "ai:quick" })
        _ = await f.run(action: "ask", on: ScoredItem(item: item, score: 0, argument: "What is Glide?"), modifiers: [])
        let q = try #require(f.quick)
        await q.conversation.wait()
        #expect(q.conversation.lastAnswer == "First answer")
        // follow-up typed into the launcher field
        q.hostProvider = { nil }
        q.conversation.ask("And more?")
        await q.conversation.wait()
        #expect(q.conversation.lastAnswer == "Second answer")
        #expect(q.conversation.messages.map(\.role) == ["user", "assistant", "user", "assistant"])
        #expect(f.handleKey(VimKey("c", meta: true), view: AIFeature.quickViewId))
        #expect(ctx.services.pasteboard.string() == "Second answer")
        #expect(f.handleCommand(.actions, view: AIFeature.quickViewId) && q.panelOpen)
        #expect(q.actions.map(\.id) == ["copy", "paste", "chat", "regen", "settings"])
        // server failure → error kind shown, empty placeholder removed
        server.setHandler { _ in .json(401, ["type": "error", "error": ["type": "authentication_error", "message": "bad"]]) }
        q.conversation.regenerate()
        await q.conversation.wait()
        #expect(q.conversation.error?.kind == .auth)
        #expect(q.conversation.messages.last?.role == "user")
    }

    @Test func noKeyShowsSettingsAction() async throws {
        let (f, ctx) = try await make(nil, key: nil)
        defer { ctx.cleanup() }
        let r = f.pushQuick(QuickAIProps(prompt: "hi"))
        guard case .pushView = r else { Issue.record("expected push"); return }
        let q = try #require(f.quick)
        #expect(!q.hasKey)
        #expect(q.actions.map(\.id) == ["settings"])
        #expect(f.handleCommand(.activate([]), view: AIFeature.quickViewId))
        #expect(ctx.openedSettings == ["ai"])
    }

    @Test func stopKeepsPartialAnswer() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: String(repeating: "slow ", count: 60), pieces: 60, delay: 0.03) }
        defer { server.stop() }
        let (f, ctx) = try await make(server)
        defer { ctx.cleanup() }
        _ = f.pushQuick(QuickAIProps(prompt: "long"))
        let q = try #require(f.quick)
        while (q.conversation.lastAnswer ?? "").count < 10 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(f.handleKey(VimKey("Escape"), view: AIFeature.quickViewId)) // esc stops streaming first
        await q.conversation.wait()
        #expect(!q.conversation.streaming)
        #expect(q.conversation.cancelled)
        #expect((q.conversation.lastAnswer ?? "").count < 300)
    }

    @Test func chatWindowPersistsChats() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "Chat answer") }
        defer { server.stop() }
        let (f, ctx) = try await make(server)
        defer { ctx.cleanup() }
        f.openChatWindow(prompt: "Hello chat", messages: nil, title: nil) // headless: model only, no window
        let m = try #require(f.chatModel)
        await m.conversation.wait()
        #expect(m.conversation.lastAnswer == "Chat answer")
        let id = try #require(m.currentId)
        let saved = try #require(f.chats?.get(id))
        #expect(saved.title == "Hello chat")
        #expect(saved.messages.map(\.content) == ["Hello chat", "Chat answer"])
        // Continue in chat from Quick AI messages
        f.openChatWindow(prompt: nil, messages: [AIChatMessage(role: "user", content: "q"), AIChatMessage(role: "assistant", content: "a")], title: "From Quick AI")
        #expect(m.title == "From Quick AI")
        #expect(f.chats?.list().count == 2)
        let png = FileManager.default.temporaryDirectory.appendingPathComponent("n4-chat-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: png) }
        let size = try AIChatWindowController.snapshot(model: m, to: png)
        #expect(size.width > 0)
    }

    @Test func importLegacyKeyFromKeyBin() async throws {
        let (f, ctx) = try await make(nil, key: nil, password: "synthetic-password-42")
        defer { ctx.cleanup() }
        #expect(!f.legacyKeyAvailable)
        try SafeStorageCrypto.encrypt("sk-ant-api03-SYNTHETIC-test-key", password: "synthetic-password-42").write(to: LegacyKeyImport.file(in: ctx.dataDirectory()))
        #expect(f.legacyKeyAvailable)
        guard case .success(let s) = f.importLegacyKey() else { Issue.record("import failed"); return }
        #expect(s.hasKey)
        #expect(f.keys.read() == "sk-ant-api03-SYNTHETIC-test-key")
    }
}
