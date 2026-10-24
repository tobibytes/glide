import Darwin
import Foundation
import GlideCore
@testable import GlideFeatures
import Testing

/// A tiny HTTP/1.1 server on 127.0.0.1 (ephemeral port) serving fixed routes. Never touches the network.
final class StubHTTPServer: @unchecked Sendable {
    let port: UInt16
    private let fd: Int32
    private let lock = NSLock()
    private var routes: [String: (status: Int, body: Data)] = [:]
    private(set) var requests: [String] = []

    init() throws {
        let s = socket(AF_INET, SOCK_STREAM, 0)
        var yes: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, len) } } == 0
        guard ok, listen(s, 16) == 0 else { close(s); throw FeatureError.failed("bind failed") }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) } }
        fd = s
        port = UInt16(bigEndian: addr.sin_port)
        Thread.detachNewThread { [weak self] in self?.loop() }
    }

    var base: String { "http://127.0.0.1:\(port)" }

    func route(_ path: String, status: Int = 200, _ body: Data) {
        lock.lock(); routes[path] = (status, body); lock.unlock()
    }

    private func loop() {
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 { return }
            var buf = [UInt8](repeating: 0, count: 8192)
            let n = read(c, &buf, buf.count)
            let req = n > 0 ? String(decoding: buf[0..<n], as: UTF8.self) : ""
            let path = req.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            lock.lock()
            requests.append(path)
            let r = routes[path] ?? (404, Data("not found".utf8))
            lock.unlock()
            var head = "HTTP/1.1 \(r.status) X\r\nContent-Length: \(r.body.count)\r\nConnection: close\r\nContent-Type: application/octet-stream\r\n\r\n"
            head.withUTF8 { p in _ = write(c, p.baseAddress, p.count) }
            r.body.withUnsafeBytes { p in
                var off = 0
                while off < p.count { let w = write(c, p.baseAddress! + off, p.count - off); if w <= 0 { break }; off += w }
            }
            close(c)
        }
    }

    deinit { close(fd) }
}

private func sh(_ args: [String]) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: args[0])
    p.arguments = Array(args.dropFirst())
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw FeatureError.failed("\(args[0]) failed") }
}

/// A minimal ad-hoc signed Glide.app in `dir`.
private func makeApp(in dir: URL, version: String, bundleId: String = "dev.glide.launcher", sign: Bool = true) throws -> URL {
    let app = dir.appendingPathComponent("Glide.app", isDirectory: true)
    let macos = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
    try FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
    let plist: [String: Any] = ["CFBundleIdentifier": bundleId, "CFBundleShortVersionString": version, "CFBundleExecutable": "Glide", "CFBundlePackageType": "APPL", "CFBundleName": "Glide"]
    try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
    try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: macos.appendingPathComponent("Glide"))
    if sign { try sh(["/usr/bin/codesign", "--force", "--sign", "-", app.path]) }
    return app
}

private func release(_ tag: String, assets: [String], base: String) -> JSONValue {
    ["tag_name": .string(tag), "name": .string("Glide \(tag)"), "body": "notes", "html_url": "https://example.invalid/r", "draft": false, "prerelease": false,
     "assets": .array(assets.map { ["name": .string($0), "browser_download_url": .string("\(base)/dl/\($0)"), "size": 1] })]
}

@Suite("updates: semver, feed, assets")
struct ReleasesTests {
    @Test func semver() {
        #expect(SemVer.compare("1.2.3", "1.2.4") == -1)
        #expect(SemVer.compare("v2.0.0", "1.9.9") == 1)
        #expect(SemVer.compare("1.0.0-alpha", "1.0.0") == -1)
        #expect(SemVer.compare("1.0.0-alpha.1", "1.0.0-alpha.beta") == -1)
        #expect(SemVer.compare("1.0.0-2", "1.0.0-10") == -1)
        #expect(SemVer.compare("1.0.0+build", "1.0.0") == 0)
        #expect(SemVer.compare("junk", "1.0.0") == -1)
        #expect(SemVer.normalise("v1.2.3") == "1.2.3" && SemVer.normalise("x") == nil)
    }

    @Test func feeds() {
        #expect(Releases.parseFeed("tobibytes/glide") == "tobibytes/glide")
        #expect(Releases.parseFeed("https://github.com/tobibytes/glide.git") == "tobibytes/glide")
        #expect(Releases.parseFeed("github.com/a/b") == "a/b")
        #expect(Releases.parseFeed("../x") == nil && Releases.parseFeed("a/..") == nil && Releases.parseFeed("") == nil && Releases.parseFeed("a/b/c") == nil)
        #expect(Releases.latestReleaseURL(feed: "a/b", baseUrl: "http://127.0.0.1:9/")?.absoluteString == "http://127.0.0.1:9/repos/a/b/releases/latest")
        #expect(Releases.defaultFeed == "tobibytes/glide")
    }

    @Test func assetsByArch() throws {
        let all = ["Glide-darwin-arm64.zip", "Glide-darwin-arm64.zip.sha256", "Glide-darwin-x64.zip", "Glide-darwin-universal.zip", "Glide-darwin-universal.zip.sha256"]
        let r = try #require(Releases.parseRelease(release("v2.0.0", assets: all, base: "http://h")))
        #expect(Releases.selectAssets(r, arch: "arm64")?.zip.name == "Glide-darwin-arm64.zip")
        #expect(Releases.selectAssets(r, arch: "x64")?.zip.name == "Glide-darwin-universal.zip") // x64 zip lacks its .sha256
        #expect(Releases.selectAssets(r, arch: "ppc")?.zip.name == "Glide-darwin-universal.zip")
        let armOnly = try #require(Releases.parseRelease(release("v2.0.0", assets: Array(all.prefix(2)), base: "http://h")))
        #expect(Releases.selectAssets(armOnly, arch: "x64") == nil) // never another arch's build
        #expect(Releases.pickUpdate(r, current: "2.0.0", arch: "arm64") == nil)
        #expect(Releases.pickUpdate(r, current: "1.9.0", arch: "arm64")?.release.version == "2.0.0")
        var draft = release("v3.0.0", assets: all, base: "h"); if case var .object(o) = draft { o["draft"] = true; draft = .object(o) }
        #expect(Releases.parseRelease(draft) == nil)
        #expect(Releases.parseSha256File("\(String(repeating: "AB", count: 32))  Glide.zip\n") == String(repeating: "ab", count: 32))
        #expect(Releases.parseSha256File("nope") == nil)
    }

    @Test func networkPolicy() throws {
        #expect(Releases.networkAllowed(url: try #require(URL(string: "http://127.0.0.1:1/x")), headless: true))
        #expect(!Releases.networkAllowed(url: try #require(URL(string: "https://api.github.com/x")), headless: true))
        #expect(Releases.networkAllowed(url: try #require(URL(string: "https://api.github.com/x")), headless: false))
        #expect(!Releases.backgroundChecksAllowed(packaged: false, headless: false, testBaseUrl: nil))
        #expect(!Releases.backgroundChecksAllowed(packaged: true, headless: true, testBaseUrl: nil))
        #expect(Releases.backgroundChecksAllowed(packaged: false, headless: true, testBaseUrl: "http://127.0.0.1:1"))
    }
}

@Suite("updates: installer against a 127.0.0.1 stub", .serialized)
struct InstallerTests {
    struct Fixture {
        let server: StubHTTPServer
        let root: URL
        let installed: URL
        let trash: URL
        let candidate: UpdateCandidate
    }

    func fixture(newVersion: String = "2.0.0", releaseVersion: String = "2.0.0", bundleId: String = "dev.glide.launcher", corruptSha: Bool = false, sign: Bool = true) throws -> Fixture {
        let root = n8TempDir("installer")
        let server = try StubHTTPServer()
        let build = root.appendingPathComponent("build", isDirectory: true)
        let newApp = try makeApp(in: build, version: newVersion, bundleId: bundleId, sign: sign)
        let zip = root.appendingPathComponent("Glide-darwin-arm64.zip")
        try sh(["/usr/bin/ditto", "-c", "-k", "--keepParent", newApp.path, zip.path])
        let digest = corruptSha ? String(repeating: "0", count: 64) : try UpdateInstaller.sha256(file: zip)
        server.route("/dl/Glide-darwin-arm64.zip", try Data(contentsOf: zip))
        server.route("/dl/Glide-darwin-arm64.zip.sha256", Data("\(digest)  Glide-darwin-arm64.zip\n".utf8))
        let installDir = root.appendingPathComponent("Applications", isDirectory: true)
        let installed = try makeApp(in: installDir, version: "1.0.0")
        let r = try #require(Releases.parseRelease(release("v\(releaseVersion)", assets: ["Glide-darwin-arm64.zip", "Glide-darwin-arm64.zip.sha256"], base: server.base)))
        let c = try #require(Releases.pickUpdate(r, current: "1.0.0", arch: "arm64"))
        return Fixture(server: server, root: root, installed: installed, trash: root.appendingPathComponent("Trash", isDirectory: true), candidate: c)
    }

    func options(_ f: Fixture) -> UpdateInstaller.Options {
        let trash = f.trash
        return .init(candidate: f.candidate, currentAppPath: f.installed, workDir: f.root.appendingPathComponent("work"), headless: true, trash: { url in
            try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: url, to: trash.appendingPathComponent(url.lastPathComponent))
        })
    }

    @Test func installsVerifiedUpdate() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let v = try await UpdateInstaller.install(options(f))
        #expect(v == "2.0.0")
        #expect(UpdateInstaller.plistValue(f.installed, "CFBundleShortVersionString") == "2.0.0")
        #expect(UpdateInstaller.plistValue(f.trash.appendingPathComponent("Glide.app"), "CFBundleShortVersionString") == "1.0.0")
        #expect(f.server.requests.contains("/dl/Glide-darwin-arm64.zip.sha256"))
    }

    @Test func checksumMismatchLeavesAppUntouched() async throws {
        let f = try fixture(corruptSha: true)
        defer { try? FileManager.default.removeItem(at: f.root) }
        await #expect(throws: (any Error).self) { try await UpdateInstaller.install(options(f)) }
        #expect(UpdateInstaller.plistValue(f.installed, "CFBundleShortVersionString") == "1.0.0")
    }

    @Test func bundleIdMismatchRefused() async throws {
        let f = try fixture(bundleId: "com.evil.app")
        defer { try? FileManager.default.removeItem(at: f.root) }
        do { _ = try await UpdateInstaller.install(options(f)); Issue.record("should fail") } catch {
            #expect(error.localizedDescription.contains("Bundle identifier mismatch"))
        }
        #expect(UpdateInstaller.plistValue(f.installed, "CFBundleShortVersionString") == "1.0.0")
    }

    @Test func versionMismatchRefused() async throws {
        let f = try fixture(newVersion: "1.5.0", releaseVersion: "2.0.0")
        defer { try? FileManager.default.removeItem(at: f.root) }
        do { _ = try await UpdateInstaller.install(options(f)); Issue.record("should fail") } catch {
            #expect(error.localizedDescription.contains("reports version 1.5.0"))
        }
    }

    @Test func unsignedRefused() async throws {
        let f = try fixture(sign: false)
        defer { try? FileManager.default.removeItem(at: f.root) }
        do { _ = try await UpdateInstaller.install(options(f)); Issue.record("should fail") } catch {
            #expect(error.localizedDescription.contains("code signature"))
        }
        #expect(UpdateInstaller.plistValue(f.installed, "CFBundleShortVersionString") == "1.0.0")
    }

    @Test func headlessRefusesRealHosts() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        var o = options(f)
        o.candidate.sha256.url = "https://github.com/tobibytes/glide/releases/download/v2/x.sha256"
        do { _ = try await UpdateInstaller.install(o); Issue.record("should fail") } catch {
            #expect(error.localizedDescription.contains("headless"))
        }
    }
}

@Suite("app feature (headless)", .serialized)
@MainActor struct AppFeatureTests {
    @Test func launchAtLoginOnlyOnExplicitToggle() async throws {
        let ctx = try N8TestContext(featureId: "app")
        let f = AppFeature()
        await f.start(context: ctx)
        #expect(f.loginItemLog.isEmpty) // nothing at start
        #expect(f.setLaunchAtLogin(true).ok)
        #expect(ctx.store.settings.launchAtLogin && f.loginItemLog == [["register": true]])
        _ = await f.run(action: "run", on: ScoredItem(item: SearchItem(id: "app:toggle-login", kind: .command, title: ""), score: 0), modifiers: [])
        #expect(!ctx.store.settings.launchAtLogin && f.loginItemLog.count == 2)
        await f.stop()
    }

    @Test func emptyFeedDisablesUpdates() async throws {
        let ctx = try N8TestContext(featureId: "app")
        let f = AppFeature()
        await f.start(context: ctx)
        #expect(f.update.status == "idle") // default feed tobibytes/glide, no background check headless
        f.setUpdateSettings(["updateFeed": "  "])
        let st = await f.check()
        #expect(st.status == "disabled")
        f.setUpdateSettings(["updateFeed": "https://github.com/a/b"])
        #expect(ctx.store.settings.features["app"]?["updateFeed"] == "a/b")
        // Headless + github.com: refused before any request.
        let st2 = await f.check()
        #expect(st2.status == "error" && st2.error?.contains("headless") == true)
        await f.stop()
    }
}

@Suite("Update status text")
@MainActor struct UpdateStatusTextTests {
    @Test func lastCheckedReadsNaturally() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let ms = { (secondsAgo: Double) in (now.timeIntervalSince1970 - secondsAgo) * 1000 }
        #expect(AppSettingsView.checkedText(ms(5), now: now) == "Checked just now")
        #expect(AppSettingsView.checkedText(ms(60), now: now) == "Checked 1 minute ago")
        #expect(AppSettingsView.checkedText(ms(600), now: now) == "Checked 10 minutes ago")
        #expect(AppSettingsView.checkedText(ms(7200), now: now).hasPrefix("Checked at "))
    }

    @Test func statusSentences() {
        #expect(AppSettingsView.statusText(["status": "up-to-date", "currentVersion": "0.4.1"]) == "Glide is up to date. You have the latest version (0.4.1).")
        #expect(AppSettingsView.statusText(["status": "available", "latestVersion": "0.5.0", "currentVersion": "0.4.1"]) == "Glide 0.5.0 is available. You have 0.4.1.")
        #expect(AppSettingsView.statusText(["status": "checking"]) == "Checking for updates…")
    }
}

