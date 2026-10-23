import Foundation
import GlideTestHarness
import Testing

/// N4 end-to-end: the real Glide binary (headless) + a 127.0.0.1 fake Anthropic server. Never the real API,
/// never the user's key or Keychain (GLIDE_AI_TEST_KEY seeds an in-memory key store in headless mode).
@Suite("AI + Text Transforms via test channel", .serialized)
struct AITransformsE2E {
    private func effects(_ d: GlideDriver, _ kind: String) -> [String] { d.sideEffects.filter { $0.kind == kind }.map(\.detail) }
    private func result(_ r: [String: Any]) -> [String: Any] { (r["result"] as? [String: Any]) ?? [:] }

    private func driver(_ server: FakeAnthropicServer?, selection: String? = nil, key: Bool = true, extra: [String: String] = [:], seed: [String: Data] = [:]) throws -> GlideDriver {
        var env = extra
        if let server { env["GLIDE_AI_BASE_URL"] = server.baseURL }
        if key { env["GLIDE_AI_TEST_KEY"] = "sk-ant-test-FAKE" }
        if let selection { env["GLIDE_HEADLESS_SELECTION"] = selection }
        return try GlideDriver(seed: seed, environment: env)
    }

    @Test func aiCommandOnSelectionReplacesIt() throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "Their going → They're going.", pieces: 4) }
        defer { server.stop() }
        let d = try driver(server, selection: "Their going")
        defer { d.stop() }
        _ = try d.show()
        try d.type("fix spelling")
        #expect(try d.selectedTitle() == "Fix Spelling and Grammar")
        let s = try d.key("enter")
        #expect(s["view"] as? String == "ai.chat")
        let q = result(try d.invoke("ai", "quickState", ["wait": true]))
        #expect(q["answer"] as? String == "Their going → They're going.")
        #expect(q["replaces"] as? Bool == true)
        #expect(q["primary"] as? String == "Replace Selection")
        let body = String(decoding: server.requests.first?.body ?? Data(), as: UTF8.self)
        #expect(body.contains("Their going"))
        #expect(server.requests.first?.headers["x-api-key"] == "sk-ant-test-FAKE")
        _ = try d.snapshot("\(snapshotDir)/n4-quick-ai-command.png")
        // ⏎ (empty field) → hide + paste-back to the still-frontmost app
        let after = try d.key("enter")
        #expect(after["visible"] as? Bool == false)
        #expect(effects(d, "paste").contains { $0.contains("They're going.") })
    }

    @Test func quickAIWithTabArgumentAndFollowUp() throws {
        let server = try FakeAnthropicServer { r in
            let n = ((r.json?["messages"] as? [Any]) ?? []).count
            return .sse(text: n > 1 ? "Follow-up answer" : "**Glide** is a launcher.\n\n- fast\n- keyboard-first")
        }
        defer { server.stop() }
        let d = try driver(server)
        defer { d.stop() }
        _ = try d.show()
        let rows = (try d.type("quick ai")["rows"] as? [[String: Any]]) ?? []
        let index = try #require(rows.firstIndex { $0["id"] as? String == "ai:quick" })
        for _ in 0..<index { try d.key("down") }
        #expect(try d.selectedTitle() == "Quick AI")
        try d.key("tab")
        try d.type("What is Glide?")
        let s = try d.key("enter")
        #expect(s["view"] as? String == "ai.chat")
        var q = result(try d.invoke("ai", "quickState", ["wait": true]))
        #expect((q["answer"] as? String)?.hasPrefix("**Glide**") == true)
        _ = try d.snapshot("\(snapshotDir)/n4-quick-ai.png")
        try d.send(["cmd": "setQuery", "text": "Tell me more"])
        let afterEnter = try d.key("enter")
        #expect(afterEnter["query"] as? String == "")
        q = result(try d.invoke("ai", "quickState", ["wait": true]))
        #expect(q["answer"] as? String == "Follow-up answer")
        #expect((q["messages"] as? [Any])?.count == 4)
        // ⌘K opens the view's own action panel; esc closes it; ⌘C copies the answer
        try d.key("cmdK")
        #expect(result(try d.invoke("ai", "quickState"))["panelOpen"] as? Bool == true)
        try d.key("esc")
        #expect(result(try d.invoke("ai", "quickState"))["panelOpen"] as? Bool == false)
        try d.key("cmd+c")
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "Follow-up answer")
    }

    @Test func missingKeyAndHeadlessSafety() throws {
        let d = try driver(nil, key: false)
        defer { d.stop() }
        let st = result(try d.invoke("ai", "hasApiKey"))
        #expect(st["hasKey"] as? Bool == false)
        let r = result(try d.invoke("ai", "ask", ["prompt": "hi"]))
        #expect(r["ok"] as? Bool == false) // no key + no fake server: never reaches the network
    }

    @Test func importKeyFromPreviousGlide() throws {
        // key.bin written by Electron safeStorage ("v10" + AES-128-CBC) — synthetic vector, password via env.
        var blob = Data("v10".utf8)
        let hex = "ad1238debe06c088b670713d99dcc624d86f3bf2d1c5fa336b857603790f0b79"
        var i = hex.startIndex
        while i < hex.endIndex { let j = hex.index(i, offsetBy: 2); blob.append(UInt8(hex[i..<j], radix: 16) ?? 0); i = j }
        let server = try FakeAnthropicServer { r in
            r.path.hasPrefix("/v1/models") ? .json(200, ["id": "claude-opus-5-5", "display_name": "Claude Opus 5.5"]) : .sse(text: "ok")
        }
        defer { server.stop() }
        let d = try driver(server, key: false, extra: ["GLIDE_AI_TEST_SAFE_STORAGE_PASSWORD": "synthetic-password-42"])
        defer { d.stop() }
        let dir = d.dataDirectory.appendingPathComponent("features/ai")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try blob.write(to: dir.appendingPathComponent("key.bin"))
        #expect(result(try d.invoke("ai", "hasApiKey"))["legacyKeyAvailable"] as? Bool == true)
        #expect(result(try d.invoke("ai", "importLegacyKey"))["ok"] as? Bool == true)
        #expect(result(try d.invoke("ai", "hasApiKey"))["hasKey"] as? Bool == true)
        let t = result(try d.invoke("ai", "testConnection"))
        #expect(t["message"] as? String == "Connected — Claude Opus 5.5 is available.")
        #expect(server.requests.last?.headers["x-api-key"] == "sk-ant-api03-SYNTHETIC-test-key")
        _ = try d.invoke("ai", "snapshotSettings", ["path": "\(snapshotDir)/n4-settings-ai.png"])
    }

    @Test func chatWindowModelPersistsAndRenders() throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "Here is a list:\n\n1. one\n2. two\n\n```swift\nprint(\"hi\")\n```") }
        defer { server.stop() }
        let d = try driver(server)
        defer { d.stop() }
        _ = try d.invoke("ai", "openChatWindow", ["prompt": "Show me code"])
        let st = result(try d.invoke("ai", "chatState", ["wait": true]))
        #expect(st["title"] as? String == "Show me code")
        #expect((st["messages"] as? [[String: Any]])?.last?["content"] as? String == "Here is a list:\n\n1. one\n2. two\n\n```swift\nprint(\"hi\")\n```")
        let chats = (try d.invoke("ai", "listChats")["result"] as? [[String: Any]]) ?? []
        #expect(chats.count == 1)
        let file = d.dataDirectory.appendingPathComponent("features/ai/chats/\(chats.first?["id"] as? String ?? "").json")
        #expect(FileManager.default.fileExists(atPath: file.path))
        _ = try d.invoke("ai", "snapshotChat", ["path": "\(snapshotDir)/n4-ai-chat.png"])
        #expect(effects(d, "open-url").isEmpty)
    }

    @Test func transformTextViewPreviewsAndPastes() throws {
        let d = try driver(nil, selection: "helloBigWorld")
        defer { d.stop() }
        _ = try d.show()
        try d.type("transform text")
        #expect(try d.selectedTitle() == "Transform Text")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "transforms.transform")
        var st = result(try d.invoke("transforms", "state"))
        #expect(st["source"] as? String == "selection")
        _ = try d.snapshot("\(snapshotDir)/n4-transforms.png")
        try d.type("snake")
        st = result(try d.invoke("transforms", "state"))
        #expect(((st["rows"] as? [[String: Any]])?.first)?["preview"] as? String == "hello_big_world")
        s = try d.key("enter")
        #expect(s["visible"] as? Bool == false)
        #expect(effects(d, "paste").contains { $0.contains("hello_big_world") })
    }

    @Test func rootTransformCommandCopies() throws {
        let d = try driver(nil, selection: "{\"a\":[1,2]}")
        defer { d.stop() }
        _ = try d.show()
        try d.type("json minify")
        #expect(try d.selectedTitle() == "JSON Minify")
        try d.key("cmdK")
        try d.type("copy")
        try d.key("enter")
        #expect(try d.invoke("headless", "pasteboard")["result"] as? String == "{\"a\":[1,2]}")
    }
}
