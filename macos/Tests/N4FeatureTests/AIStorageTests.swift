import Foundation
import GlideCore
@testable import GlideFeatures
import GlideTestHarness
import Testing

private func hex(_ s: String) -> Data {
    var d = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        d.append(UInt8(s[i..<j], radix: 16) ?? 0)
        i = j
    }
    return d
}

@Suite("AI key store + Electron safeStorage migration")
@MainActor struct AIKeyTests {
    /// Synthetic vector produced independently with Python hashlib.pbkdf2_hmac + `openssl enc -aes-128-cbc`:
    ///   key = PBKDF2-SHA1("synthetic-password-42", "saltysalt", 1003, 16) = 34b64bb8376d952257e2823d2a84333c
    ///   ct  = AES-128-CBC(key, iv = 16 × 0x20, PKCS#7, "sk-ant-api03-SYNTHETIC-test-key")
    static let password = "synthetic-password-42"
    static let plain = "sk-ant-api03-SYNTHETIC-test-key"
    static let derived = "34b64bb8376d952257e2823d2a84333c"
    static let cipher = "ad1238debe06c088b670713d99dcc624d86f3bf2d1c5fa336b857603790f0b79"

    @Test func pbkdf2MatchesVector() throws {
        #expect(try SafeStorageCrypto.deriveKey(password: Self.password) == hex(Self.derived))
    }

    @Test func decryptsSyntheticVector() throws {
        let blob = Data("v10".utf8) + hex(Self.cipher)
        #expect(try SafeStorageCrypto.decrypt(blob, password: Self.password) == Self.plain)
        #expect(try SafeStorageCrypto.encrypt(Self.plain, password: Self.password) == blob)
        #expect(throws: AIError.self) { try SafeStorageCrypto.decrypt(blob, password: "wrong") }
        #expect(throws: AIError.self) { try SafeStorageCrypto.decrypt(hex(Self.cipher), password: Self.password) } // no v10 prefix
    }

    @Test func legacyImportFromKeyBin() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("n4-legacy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(!LegacyKeyImport.available(in: dir))
        try (Data("v10".utf8) + hex(Self.cipher)).write(to: LegacyKeyImport.file(in: dir))
        #expect(LegacyKeyImport.available(in: dir))
        #expect(try LegacyKeyImport.decrypt(dataDirectory: dir, passwords: FixedSafeStoragePassword(Self.password)) == Self.plain)
        #expect(throws: AIError.self) { try LegacyKeyImport.decrypt(dataDirectory: dir, passwords: FixedSafeStoragePassword(nil)) }
    }

    @Test func keyStoreValidation() throws {
        let store = AIKeyStore(store: MemorySecretStore())
        #expect(!store.status().hasKey)
        #expect(try store.set("  sk-ant-abc  ").hasKey)
        #expect(store.read() == "sk-ant-abc")
        #expect(throws: AIError.self) { try store.set("has space inside") }
        #expect(throws: AIError.self) { try store.set(String(repeating: "x", count: 513)) }
        #expect(try store.set("").hasKey == false) // empty clears
        #expect(store.read() == nil)
    }
}

@Suite("AI chats store")
struct AIChatStoreTests {
    @Test func roundTripAndElectronFiles() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("n4-chats-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = AIChatStore(directory: dir)
        let id = AIChats.newId()
        #expect(AIChats.isChatId(id))
        try store.save(AIChat(id: id, title: "T", model: "claude-opus-5-5", createdAt: 1, updatedAt: 1, messages: [AIChatMessage(role: "user", content: "hi", at: 5)]), now: 100)
        #expect(store.get(id)?.messages.first?.content == "hi")
        #expect(store.get(id)?.updatedAt == 100)
        // A file written by the Electron app (2-space JSON, extra keys, a bad message) loads.
        let electron = #"{"id":"lx9-abcdef","title":"","createdAt":1700000000000,"updatedAt":1700000005000,"messages":[{"role":"user","content":"What is   Glide?","at":1700000000000},{"role":"system","content":"x"},{"role":"assistant","content":"A launcher.","model":"claude-opus-5-5"}],"extra":true}"#
        try Data(electron.utf8).write(to: dir.appendingPathComponent("lx9-abcdef.json"))
        let c = try #require(store.get("lx9-abcdef"))
        #expect(c.title == "What is Glide?")
        #expect(c.messages.map(\.role) == ["user", "assistant"])
        #expect(c.updatedAt == 1700000005000)
        #expect(store.list().map(\.id) == ["lx9-abcdef", id])
        #expect(store.get("../etc/passwd") == nil)
        #expect(store.delete(id))
        #expect(store.list().count == 1)
    }

    @Test func titles() {
        #expect(AIChats.deriveTitle([]) == "New Chat")
        #expect(AIChats.deriveTitle([AIChatMessage(role: "user", content: String(repeating: "a", count: 80))]).count == 58)
    }
}

@Suite("AI markdown")
struct AIMarkdownTests {
    @Test func blocks() {
        let md = "# Title\n\nPara **bold**\nline two\n\n- one\n- two\n  cont\n1. a\n2. b\n> quote\n\n```swift\nlet x = 1\n```\n---\ntail"
        #expect(AIMarkdown.parse(md) == [
            .heading(level: 1, text: "Title"), .paragraph("Para **bold**\nline two"), .bullets(["one", "two cont"]), .numbered(start: 1, items: ["a", "b"]),
            .quote("quote"), .code(language: "swift", text: "let x = 1"), .rule, .paragraph("tail"),
        ])
    }

    @Test func unterminatedFenceWhileStreaming() {
        #expect(AIMarkdown.parse("Here:\n```sh\nls -la") == [.paragraph("Here:"), .code(language: "sh", text: "ls -la")])
    }

    @Test func inlineMarkdown() {
        let s = AIMarkdown.inline("a **b** `c`")
        #expect(String(s.characters) == "a b c")
    }
}

@Suite("selection input")
struct SelectionInputTests {
    @Test func resolveFallbacks() {
        #expect(SelectionInput.resolve(SelectionResult(text: "sel", app: "Notes", reason: nil), clipboard: "clip") == SelectionInput(text: "sel", source: .selection))
        let viaClip = SelectionInput.resolve(SelectionResult(text: nil, app: "Safari", reason: "no-selected-text"), clipboard: "clip")
        #expect(viaClip.source == .clipboard && viaClip.text == "clip")
        #expect(viaClip.note == "Couldn't read the selection in Safari (it didn't report a selection)")
        let none = SelectionInput.resolve(SelectionResult(text: "  ", app: nil, reason: "no-accessibility"), clipboard: nil)
        #expect(none.source == .none)
        #expect(none.note == "Couldn't read the selection (Glide needs Accessibility permission to read selected text)")
        #expect(SelectionInput.explain("timeout") == "it took too long to answer")
        #expect(SelectionInput.explain("secure-field") == "it is a password field")
    }
}
