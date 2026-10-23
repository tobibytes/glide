import Foundation
import GlideTestHarness
import Testing

// Raycast AI.ask + OAuth (PKCE, glide://oauth redirect) through the real headless app. One loopback server plays
// both the Anthropic API (/v1/messages) and the OAuth token endpoint (/token): nothing leaves the machine.
@Suite("Extensions AI + OAuth via test channel", .serialized)
struct ExtensionsAIOAuthE2E {
    private func markdown(_ d: GlideDriver) throws -> String {
        let v = (try d.invoke("extensions", "view")["result"] as? [String: Any]) ?? [:]
        return ((v["view"] as? [String: Any])?["markdown"] as? String) ?? ""
    }

    private func poll(_ timeout: TimeInterval = 10, _ cond: () throws -> Bool) rethrows -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if try cond() { return true }
            usleep(50_000)
        }
        return try cond()
    }

    @Test func aiAskAndOAuthRoundTrip() throws {
        let server = try FakeAnthropicServer { req in
            if req.path.hasSuffix("/token") { return .json(200, ["access_token": "e2e-token", "refresh_token": "e2e-refresh", "expires_in": 3600]) }
            return .sse(text: "Hi from the fake API", pieces: 3)
        }
        defer { server.stop() }
        let d = try GlideDriver(environment: ["GLIDE_AI_BASE_URL": server.baseURL, "GLIDE_AI_TEST_KEY": "sk-ant-e2e"])
        defer { d.stop() }
        _ = try d.show()
        try d.invoke("extensions", "installExample", ["path": "raycast-fixtures/rc-compat"])

        // AI.ask (useAI) streams Glide AI's answer into the Detail.
        try d.invoke("extensions", "run", ["name": "rc-compat", "command": "ai-demo"])
        let answered = try poll { try markdown(d).contains("Hi from the fake API") }
        let aiMarkdown = try markdown(d)
        #expect(answered, "\(aiMarkdown)")
        #expect(try markdown(d).hasPrefix("canAccess=true"))

        // OAuth: the authorization URL is "opened" (headless: logged), the redirect is simulated.
        try d.invoke("extensions", "setPreferences", ["name": "rc-compat", "values": ["server": server.baseURL]])
        try d.invoke("extensions", "run", ["name": "rc-compat", "command": "oauth-demo"])
        var pending: [[String: Any]] = []
        let waiting = try poll { pending = (try d.invoke("extensions", "oauthPending")["result"] as? [[String: Any]]) ?? []; return pending.count == 1 }
        #expect(waiting)
        let state = try #require(pending.first?["state"] as? String)
        let effects = (try d.invoke("headless", "effects")["result"] as? [[String: Any]]) ?? []
        #expect(effects.contains { $0["kind"] as? String == "open-url" && "\($0["detail"] ?? "")".contains("/authorize") })
        let r = try d.invoke("extensions", "oauthRedirect", ["url": "glide://oauth?package_name=rc-compat&code=e2e-code&state=\(state)"])
        #expect((r["result"] as? [String: Any])?["handled"] as? Bool == true)
        let signedIn = try poll { try markdown(d).contains("token=e2e-token") }
        let oauthMarkdown = try markdown(d)
        #expect(signedIn, "\(oauthMarkdown)")
        let tokens = (try d.invoke("extensions", "oauthTokens", ["name": "rc-compat", "provider": "test"])["result"] as? [String: Any]) ?? [:]
        #expect(tokens["accessToken"] as? String == "e2e-token")
        let tokenReq = server.requests.first { $0.path.hasSuffix("/token") }
        let tokenBody = String(decoding: tokenReq?.body ?? Data(), as: UTF8.self)
        #expect(tokenBody.contains("code=e2e-code"), "\(tokenBody)")
    }
}
