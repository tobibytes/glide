import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

/// Serves canned responses for https hosts so the network examples run without the internet.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var routes: [String: (Int, Data)] = [:]
    nonisolated(unsafe) static var seen: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url?.absoluteString ?? ""
        Self.seen.append(url)
        let hit = Self.routes.first { url.hasPrefix($0.key) }?.value ?? (404, Data("{}".utf8))
        let resp = HTTPURLResponse(url: request.url!, statusCode: hit.0, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: hit.1)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: c)
    }
}

private func json(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o) }

@Suite("network examples (stubbed fetch)", .serialized)
@MainActor struct NetworkExamplesTests {
    @Test func hackerNewsListDetailAndPushedComments() async throws {
        let api = "https://hacker-news.firebaseio.com/v0"
        StubProtocol.routes = [
            "\(api)/topstories.json": (200, json([1, 2])),
            "\(api)/item/1.json": (200, json(["id": 1, "title": "Native Glide", "by": "ada", "score": 42, "time": Int(Date().timeIntervalSince1970) - 120, "descendants": 1, "kids": [10], "url": "https://example.com/a"])),
            "\(api)/item/2.json": (200, json(["id": 2, "title": "JavaScriptCore", "by": "bob", "score": 7, "time": Int(Date().timeIntervalSince1970) - 7200, "descendants": 0])),
            "\(api)/item/10.json": (200, json(["id": 10, "by": "cat", "text": "Nice &amp; fast", "time": Int(Date().timeIntervalSince1970)])),
        ]
        var o = JSHost.Options()
        o.urlSession = StubProtocol.session()
        let h = Harness()
        let ext = try h.install("hacker-news")
        let s = try h.run(ext, "top-stories", options: o)
        #expect(await waitUntil { (s.view(0)?["items"]?.arrayValue ?? []).count == 2 }, "\(s.logs) \(s.view(0) ?? .null)")
        let first = try #require(s.view(0)?["items"]?.arrayValue?.first)
        #expect(first["title"] == "Native Glide")
        #expect(first["subtitle"] == "example.com")
        #expect(first["detail"]?["markdown"]?.stringValue?.contains("**42** points by **ada**") == true)
        let push = try #require(first["actions"]?.arrayValue?.first { $0["kind"] == "push" })
        #expect(push["shortcut"] == "⌘D")
        s.invoke(depth: 0, handler: try #require(push["handler"]?.stringValue))
        #expect(await waitUntil { s.view(1)?["markdown"]?.stringValue?.contains("Nice & fast") == true }, "\(s.view(1) ?? .null)")
        s.kill()
    }

    @Test func githubSearchAsYouTypeWithPasswordPreference() async throws {
        StubProtocol.routes = ["https://api.github.com/search/repositories": (200, json(["items": [["id": 1, "full_name": "tobibytes/glide", "description": "Launcher", "stargazers_count": 5, "html_url": "https://github.com/tobibytes/glide", "language": "Swift"]]]))]
        StubProtocol.seen = []
        var o = JSHost.Options()
        o.urlSession = StubProtocol.session()
        let h = Harness()
        let ext = try h.install("github-search")
        let s = try h.run(ext, "search-repositories", options: o)
        #expect(await waitUntil { s.view(0)?["type"] == "list" }, "\(s.logs)")
        let handler = try #require(s.view(0)?["searchHandler"]?.stringValue)
        s.invoke(depth: 0, handler: handler, args: ["glide"])
        #expect(await waitUntil { "\(s.view(0)?["items"] ?? .null)".contains("tobibytes/glide") }, "\(s.logs) \(s.view(0) ?? .null)")
        #expect(StubProtocol.seen.contains { $0.contains("q=glide") })
        s.kill()
    }

    @Test func timezonesLocalStorageAndIntl() async throws {
        let h = Harness()
        let ext = try h.install("timezones")
        let s = try h.run(ext, "world-clocks")
        #expect(await waitUntil { (s.view(0)?["items"]?.arrayValue ?? []).count > 5 }, "\(s.logs) \(s.view(0) ?? .null)")
        let titles = (s.view(0)?["items"]?.arrayValue ?? []).compactMap { $0["title"]?.stringValue }
        #expect(titles.contains("Tokyo"), "\(titles)")
        #expect(h.delegate.methods().contains("storage.get"))
        s.kill()
    }

    @Test func nodeShimsAndUnsupportedBuiltins() async throws {
        let dir = tempDir("n9-shim")
        try #"{"name":"shim-test","version":"1.0.0","glide":{"title":"Shim","commands":[{"name":"go","title":"Go","mode":"no-view"}]}}"#
            .write(to: dir.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try """
        const fs = require("fs"), path = require("node:path"), os = require("os"), crypto = require("crypto");
        const { EventEmitter } = require("events"); const util = require("util");
        const { Clipboard, environment } = require("@glide/api");
        module.exports = async function () {
          const p = path.join(environment.supportPath, "x.txt");
          fs.writeFileSync(p, "héllo");
          const out = [fs.readFileSync(p, "utf8"), crypto.createHash("sha256").update("abc").digest("hex").slice(0, 8),
            Buffer.from("hi").toString("base64"), new URL("https://a.b/c?d=1#e").searchParams.get("d"), typeof os.homedir(),
            new TextDecoder().decode(new TextEncoder().encode("ü")), util.format("%s-%d", "a", 3)];
          let err = ""; try { require("http"); } catch (e) { err = e.message; }
          const e = new EventEmitter(); let got = 0; e.on("x", (v) => (got = v)); e.emit("x", 5);
          await new Promise((r) => setTimeout(r, 10));
          await Clipboard.copy(JSON.stringify({ out, err, got }));
        };
        """.write(to: dir.appendingPathComponent("go.js"), atomically: true, encoding: .utf8)
        let h = Harness()
        let ext = try h.registry.install(folder: dir, source: ["kind": "folder"])
        let s = try h.run(ext, "go")
        let c = await s.waitForCompletion()
        #expect(c.ok, "\(c.error ?? "") \(s.logs)")
        let txt = h.delegate.requests.first { $0.method == "clipboard.copy" }?.params.first?.stringValue ?? ""
        let o = try JSONSerialization.jsonObject(with: Data(txt.utf8)) as? [String: Any]
        #expect(o?["out"] as? [String] == ["héllo", "ba7816bf", "aGk=", "1", "string", "ü", "a-3"], "\(txt)")
        #expect((o?["err"] as? String)?.contains("not supported") == true)
        #expect(o?["got"] as? Int == 5)
    }
}
