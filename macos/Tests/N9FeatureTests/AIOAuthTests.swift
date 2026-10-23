import Foundation
@testable import GlideFeatures
import GlideCore
import GlideSystem
import GlideTestHarness
import Testing

/// A FeatureContext over a temp Store + headless services whose callFeature routes to sibling features.
@MainActor final class AIOAuthContext: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    let root: URL
    let sideLog: SideEffectLog
    var peers: [String: any Feature] = [:]

    init(featureId: String, root: URL, store: Store, sideLog: SideEffectLog) {
        self.featureId = featureId
        self.root = root
        self.store = store
        self.sideLog = sideLog
        services = SystemServicesFactory.headless(log: sideLog, environment: [:])
    }

    func dataDirectory() -> URL {
        let d = GlidePaths.featureDirectory(featureId, root: root)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue] { store.settings.featureSettings(featureId, defaults: defaults) }
    func setSettings(_ patch: [String: JSONValue]) { store.setFeatureSettings(featureId, patch) }
    func refreshCatalogue() {}
    func showLauncher() {}
    func hideLauncher() {}
    func push(_ view: ViewID, payload: JSONValue) {}
    func openSettings(page: String?) {}
    func toast(_ message: String, style: ToastStyle) {}
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool { true }
    func executeItem(id: String, argument: String?) async -> ActionResult { .stay(message: nil) }
    func search(_ query: String) async -> [ScoredItem] { [] }
    func findItem(id: String) -> SearchItem? { nil }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue {
        guard let f = peers[featureId] else { throw FeatureError.failed("no feature \(featureId)") }
        return try await f.invoke(method: method, args: args)
    }
    func log(_ message: String) {}
}

/// ExtensionsFeature + AIFeature wired together (AI on a loopback fake server, tokens in memory).
@MainActor struct AIOAuthRig {
    let root = tempDir("n9-ai-oauth")
    let sideLog = SideEffectLog(echo: false)
    let ext = ExtensionsFeature()
    let ai: AIFeature
    let tokenBackend = MemoryTokenBackend()

    init(aiBaseURL: String?, key: String? = "sk-ant-test-key") async throws {
        let store = Store(directory: root, debounce: 0)
        try store.load()
        var env: [String: String] = [:]
        if let aiBaseURL { env["GLIDE_AI_BASE_URL"] = aiBaseURL }
        if let key { env["GLIDE_AI_TEST_KEY"] = key }
        ai = AIFeature(environment: env)
        let ec = AIOAuthContext(featureId: "extensions", root: root, store: store, sideLog: sideLog)
        let ac = AIOAuthContext(featureId: "ai", root: root, store: store, sideLog: sideLog)
        ec.peers = ["ai": ai, "extensions": ext]
        ac.peers = ec.peers
        contexts = [ec, ac]
        ext.examplesDirOverride = examplesDir
        ext.tokenBackendOverride = tokenBackend
        await ai.start(context: ac)
        await ext.start(context: ec)
    }

    /// Keeps the (weakly held) contexts alive.
    let contexts: [AIOAuthContext]

    func install(_ rel: String) async throws {
        _ = try await ext.invoke(method: "installFolder", args: ["path": .string(examplesDir.appendingPathComponent(rel).path)])
    }

    func markdown() async -> String { (try? await ext.invoke(method: "view", args: .null))?["view"]?["markdown"]?.stringValue ?? "" }

    func stop() async {
        await ext.stop()
        await ai.stop()
        try? FileManager.default.removeItem(at: root)
    }
}

/// Token endpoint stub: answers POST /token and records the form body.
final class TokenStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var bodies: [String] = []
    nonisolated(unsafe) static var response: [String: Any] = ["access_token": "at-123", "refresh_token": "rt-456", "expires_in": 3600, "token_type": "bearer"]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let s = request.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            s.close()
        }
        Self.bodies.append(String(decoding: body, as: UTF8.self))
        let ok = request.url?.path == "/token"
        let data = ok ? ((try? JSONSerialization.data(withJSONObject: Self.response)) ?? Data()) : Data("{}".utf8)
        guard let url = request.url, let resp = HTTPURLResponse(url: url, statusCode: ok ? 200 : 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]) else { return }
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [TokenStub.self]
        return URLSession(configuration: c)
    }
}

/// Answers ai.ask with scripted chunks (JS streaming path without the AI feature) and records each render.
@MainActor final class StreamingDelegate: ExtensionSessionDelegate {
    var chunks = ["Hel", "lo ", "Glide"]
    var askParams: [JSONValue] = []
    var markdowns: [String] = []
    func session(_ s: ExtensionSession, request method: String, params: [JSONValue]) async throws -> JSONValue { .null }
    func session(_ s: ExtensionSession, request method: String, params: [JSONValue], stream: @escaping @MainActor (String) -> Void) async throws -> JSONValue {
        guard method == "ai.ask" else { return .null }
        askParams = params
        for c in chunks {
            stream(c)
            try? await Task.sleep(for: .milliseconds(60))
        }
        return .string(chunks.joined())
    }
    func sessionDidChange(_ s: ExtensionSession, _ event: ExtensionSession.Event) {
        if case .render = event, let md = s.view(0)?["markdown"]?.stringValue { markdowns.append(md) }
    }
}

@Suite("Extensions AI.ask + OAuth (pure logic)")
@MainActor struct ExtensionAIOAuthLogicTests {
    @Test func modelMapping() {
        #expect(ExtensionAI.mapModel("anthropic-claude-haiku", provider: "anthropic") == "claude-haiku-4-5")
        #expect(ExtensionAI.mapModel("Anthropic_Claude_Sonnet", provider: "anthropic") == "claude-sonnet-5-5")
        #expect(ExtensionAI.mapModel("claude-opus-5-5", provider: "anthropic") == "claude-opus-5-5")
        #expect(ExtensionAI.mapModel("OpenAI_GPT4o", provider: "anthropic") == nil)
        #expect(ExtensionAI.mapModel(nil, provider: "anthropic") == nil)
        // OpenAI: never a Claude id; Raycast names become plausible OpenAI ids, others the default.
        #expect(ExtensionAI.mapModel("anthropic-claude-sonnet", provider: "openai") == nil)
        #expect(ExtensionAI.mapModel("claude-opus-5-5", provider: "openai") == nil)
        #expect(ExtensionAI.mapModel("openai-gpt-4o", provider: "openai") == "gpt-4o")
        #expect(ExtensionAI.mapModel("OpenAI_GPT4o", provider: "openai") == "gpt-4o")
        #expect(ExtensionAI.mapModel("gpt-5-mini", provider: "openai") == "gpt-5-mini")
        #expect(ExtensionAI.mapModel("perplexity-sonar", provider: "openai") == nil)
    }

    @Test func creativity() {
        #expect(ExtensionAI.creativityNote("low")?.contains("precisely") == true)
        #expect(ExtensionAI.creativityNote("none")?.contains("precisely") == true)
        #expect(ExtensionAI.creativityNote("maximum")?.contains("creative") == true)
        #expect(ExtensionAI.creativityNote("1.8")?.contains("creative") == true)
        #expect(ExtensionAI.creativityNote("0.1")?.contains("precisely") == true)
        #expect(ExtensionAI.creativityNote("medium") == nil)
        #expect(ExtensionAI.creativityNote(nil) == nil)
    }

    @Test func tokenStorePerExtensionAndProvider() throws {
        let b = MemoryTokenBackend()
        let t = ExtensionTokenStore(backend: b)
        try t.set("ext-a", "github", ["accessToken": "a1"])
        try t.set("ext-a", "google", ["accessToken": "a2"])
        try t.set("ext-b", "github", ["accessToken": "b1"])
        #expect(t.get("ext-a", "github")?["accessToken"] == "a1")
        #expect(t.get("ext-b", "github")?["accessToken"] == "b1")
        #expect(b.items.count == 2)
        try t.remove("ext-a", "github")
        #expect(t.get("ext-a", "github") == nil)
        #expect(t.get("ext-a", "google")?["accessToken"] == "a2")
        try t.remove("ext-a", "google")
        #expect(b.items["ext-a"] == nil)
        #expect(throws: (any Error).self) { try t.set("../evil", "x", ["accessToken": "z"]) }
        #expect(throws: (any Error).self) { try t.set("ext-b", "x", "not an object") }
        t.clear("ext-b")
        #expect(b.items.isEmpty)
    }

    @Test func flowsValidateStateRedirectErrorTimeoutAndCancel() async throws {
        let f = OAuthFlows()
        // https only (http on loopback), and a state is required.
        await #expect(throws: (any Error).self) { _ = try await f.authorize(extName: "e", sessionId: "s", url: "http://evil.example/a", state: "x", providerName: "P") { _, _ in } }
        await #expect(throws: (any Error).self) { _ = try await f.authorize(extName: "e", sessionId: "s", url: "https://ok.example/a", state: "", providerName: "P") { _, _ in } }

        var opened: [URL] = []
        let ok = Task { @MainActor in try await f.authorize(extName: "e", sessionId: "s1", url: "https://ok.example/a?state=st1", state: "st1", providerName: "P") { _, u in opened.append(u) } }
        #expect(await waitUntil { f.requests.count == 1 })
        #expect(opened.map(\.host) == ["ok.example"])
        #expect(f.handleRedirect("glide://oauth?package_name=e&code=c1&state=WRONG") == nil)
        #expect(f.handleRedirect("glide://oauth?package_name=other&code=c1&state=st1") == nil)
        #expect(f.handleRedirect("https://oauth?code=c1&state=st1") == nil)
        #expect(f.handleRedirect("glide://oauth?package_name=e&code=c1&state=st1") != nil)
        #expect(try await ok.value == "c1")
        #expect(f.requests.isEmpty)

        // Fragment response + provider error.
        let err = Task { @MainActor in try await f.authorize(extName: "e", sessionId: "s1", url: "https://ok.example/a", state: "st2", providerName: "P") { _, _ in } }
        #expect(await waitUntil { f.requests.count == 1 })
        #expect(f.handleRedirect("glide://oauth#state=st2&error=access_denied&error_description=User%20said%20no") != nil)
        await #expect { try await err.value } throws: { ($0 as? ExtensionError)?.localizedDescription == "User said no" }

        // Timeout.
        f.timeout = .milliseconds(100)
        let slow = Task { @MainActor in try await f.authorize(extName: "e", sessionId: "s2", url: "https://ok.example/a", state: "st3", providerName: "P") { _, _ in } }
        await #expect { try await slow.value } throws: { $0.localizedDescription.contains("timed out") }

        // Session end cancels.
        f.timeout = .seconds(300)
        let gone = Task { @MainActor in try await f.authorize(extName: "e", sessionId: "s3", url: "https://ok.example/a", state: "st4", providerName: "P") { _, _ in } }
        #expect(await waitUntil { f.requests.count == 1 })
        f.cancelSession("s3")
        await #expect { try await gone.value } throws: { $0.localizedDescription == "The command stopped" }
        #expect(f.requests.isEmpty)

        // A failing browser open rejects immediately.
        await #expect(throws: (any Error).self) {
            _ = try await f.authorize(extName: "e", sessionId: "s", url: "https://ok.example/a", state: "st5", providerName: "P") { _, _ in throw ExtensionError("no browser") }
        }
        #expect(f.requests.isEmpty)
    }
}

@Suite("Extensions AI.ask + OAuth on JavaScriptCore", .serialized)
@MainActor struct ExtensionAIOAuthRuntimeTests {
    init() throws {
        try #require(RaycastBuilder.esbuildBinary() != nil, "esbuild (node_modules) is needed to build the .tsx fixtures")
    }

    @Test func aiAskStreamsDataEventsThroughTheBridge() async throws {
        let reg = ExtensionRegistry(base: tempDir())
        let ext = try reg.install(folder: examplesDir.appendingPathComponent("raycast-fixtures/rc-compat"), source: ["kind": "folder"])
        let m = try #require(ext.manifest)
        let cmd = try #require(m.commands.first { $0.name == "ai-demo" })
        let d = StreamingDelegate()
        let info = SessionInfo(id: "t1", extName: m.name, extTitle: m.title, commandName: cmd.name, commandTitle: cmd.title, mode: cmd.mode,
                               runtime: m.runtime, launchType: "userInitiated", assetsPath: "")
        let s = ExtensionSession(info: info, delegate: d, options: JSHost.Options())
        s.start(initPayload: InitPayload.make(ext: ext, manifest: m, command: cmd, arguments: [:], preferences: [:], supportPath: reg.supportDir(m.name).path, aiAvailable: true))
        #expect(await waitUntil { d.markdowns.last?.hasSuffix("Hello Glide") == true }, "\(s.logs) \(d.markdowns)")
        #expect(d.markdowns.last?.hasPrefix("canAccess=true") == true)
        // Partial renders while streaming: "Hel", then "Hello ".
        #expect(d.markdowns.contains { $0.hasSuffix("\n\nHel") }, "\(d.markdowns)")
        #expect(d.askParams.first == "Say hello to Glide")
        #expect(d.askParams.count > 1 && d.askParams[1]["creativity"] == "low")
        s.kill()
    }

    @Test func aiAskThroughGlideAIOnLoopbackServer() async throws {
        let server = try FakeAnthropicServer { _ in .sse(text: "Hello from fake Claude", pieces: 4, delay: 0.03) }
        defer { server.stop() }
        let rig = try await AIOAuthRig(aiBaseURL: server.baseURL)
        defer { Task { await rig.stop() } }
        try await rig.install("raycast-fixtures/rc-compat")
        let r = await rig.ext.runCommand("rc-compat", "ai-demo")
        guard case .pushView = r else { Issue.record("expected a pushed view, got \(r)"); return }
        var md = ""
        #expect(await waitUntilAsync { md = await rig.markdown(); return md.contains("Hello from fake Claude") }, "\(md)")
        #expect(md.hasPrefix("canAccess=true"))
        let req = try #require(server.requests.first { $0.path.hasSuffix("/messages") })
        #expect("\(req.json?["system"] ?? "")".contains("Answer precisely"), "creativity: low → precise instructions")
        #expect(req.json?["model"] as? String == AIModels.defaultModel)

        // The AI feature's stream API directly: several deltas, then done with the full text.
        let start = try await rig.ai.invoke(method: "askStream", args: ["prompt": "hi"])
        let sid = try #require(start["id"]?.stringValue)
        var deltas: [String] = []
        var last: JSONValue = .null
        for _ in 0..<200 {
            last = try await rig.ai.invoke(method: "askStreamPoll", args: ["id": .string(sid), "wait": 200])
            if let dd = last["delta"]?.stringValue, !dd.isEmpty { deltas.append(dd) }
            if last["done"]?.boolValue == true { break }
        }
        #expect(last["ok"] == true)
        #expect(deltas.joined() == "Hello from fake Claude")
        #expect(deltas.count >= 2, "\(deltas)")
        #expect(last["text"] == "Hello from fake Claude")
    }

    @Test func aiAskWithoutKeyRejectsWithGlideMessage() async throws {
        let rig = try await AIOAuthRig(aiBaseURL: nil, key: nil)
        defer { Task { await rig.stop() } }
        try await rig.install("raycast-fixtures/rc-compat")
        _ = await rig.ext.runCommand("rc-compat", "ai-demo")
        // canAccess(AI) is false and useAI's failure surfaces Glide's message as a failure toast effect.
        var md = ""
        #expect(await waitUntilAsync { md = await rig.markdown(); return md.hasPrefix("canAccess=false") }, "\(md)")
        #expect(await waitUntil { rig.ext.effects.contains { "\($0)".contains("Glide AI is not set up") } }, "\(rig.ext.effects)")
    }

    @Test func oauthPKCERoundTripWithSimulatedRedirectAndPersistedTokens() async throws {
        TokenStub.bodies = []
        let rig = try await AIOAuthRig(aiBaseURL: nil)
        defer { Task { await rig.stop() } }
        var o = JSHost.Options()
        o.urlSession = TokenStub.session()
        rig.ext.hostOptions = o
        try await rig.install("raycast-fixtures/rc-compat")
        _ = try await rig.ext.invoke(method: "setPreferences", args: ["name": "rc-compat", "values": ["server": "https://auth.test"]])
        _ = await rig.ext.runCommand("rc-compat", "oauth-demo")

        // The sign-in is pending and the browser was asked to open the authorization URL.
        var pending: [JSONValue] = []
        #expect(await waitUntilAsync { pending = (try? await rig.ext.invoke(method: "oauthPending", args: .null))?.arrayValue ?? []; return pending.count == 1 })
        let p = try #require(pending.first)
        let state = try #require(p["state"]?.stringValue)
        let authURL = try #require(URLComponents(string: p["url"]?.stringValue ?? ""))
        let q = Dictionary(uniqueKeysWithValues: (authURL.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(authURL.host == "auth.test" && authURL.path == "/authorize")
        #expect(q["client_id"] == "compat-client" && q["code_challenge_method"] == "S256" && q["state"] == state)
        #expect(q["redirect_uri"] == "glide://oauth?package_name=rc-compat")
        #expect(rig.sideLog.all.contains { $0.kind == "open-url" && $0.detail["url"]?.stringValue?.hasPrefix("https://auth.test/authorize") == true })

        // Wrong state is ignored; the right one completes the flow.
        #expect(try await rig.ext.invoke(method: "oauthRedirect", args: ["url": "glide://oauth?package_name=rc-compat&code=zzz&state=nope"])["handled"] == false)
        #expect(try await rig.ext.invoke(method: "oauthRedirect", args: ["url": .string("glide://oauth?package_name=rc-compat&code=the-code&state=\(state)")])["handled"] == true)
        var md = ""
        #expect(await waitUntilAsync { md = await rig.markdown(); return md.contains("token=at-123") }, "\(md)")

        // Token request carried the code and the PKCE verifier (whose S256 is the challenge).
        let body = try #require(TokenStub.bodies.first)
        let form = Dictionary(uniqueKeysWithValues: (URLComponents(string: "?" + body)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(form["code"] == "the-code" && form["grant_type"] == "authorization_code")
        #expect(form["code_verifier"]?.isEmpty == false)

        // Persisted per extension + provider id; a second run signs in without the browser.
        let saved = try await rig.ext.invoke(method: "oauthTokens", args: ["name": "rc-compat", "provider": "test"])
        #expect(saved["accessToken"] == "at-123" && saved["refreshToken"] == "rt-456")
        #expect(rig.tokenBackend.items["rc-compat"] != nil)
        let opens = rig.sideLog.all.filter { $0.kind == "open-url" }.count
        _ = await rig.ext.runCommand("rc-compat", "oauth-demo")
        #expect(await waitUntilAsync { await rig.markdown().contains("token=at-123") })
        #expect(rig.sideLog.all.filter { $0.kind == "open-url" }.count == opens)
        #expect(((try? await rig.ext.invoke(method: "oauthPending", args: .null))?.arrayValue ?? []).isEmpty)

        // Uninstall drops the tokens.
        _ = try await rig.ext.invoke(method: "uninstall", args: ["name": "rc-compat"])
        #expect(rig.tokenBackend.items["rc-compat"] == nil)
    }
}

/// waitUntil for async conditions.
@MainActor func waitUntilAsync(_ timeout: Duration = .seconds(10), _ cond: () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await cond() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return await cond()
}
