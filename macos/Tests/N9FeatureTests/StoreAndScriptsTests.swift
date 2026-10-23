import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

@Suite("tar / gzip / store schema")
struct TarStoreTests {
    @Test func gzipRoundTripAndCRC() throws {
        let d = Data((0..<5000).map { UInt8($0 % 251) })
        let gz = Gzip.compress(d)
        #expect(gz.prefix(2) == Data([0x1F, 0x8B]))
        #expect(try Gzip.decompress(gz, maxBytes: 10_000) == d)
        var bad = gz
        bad[bad.count - 6] ^= 0xFF
        #expect(throws: TarError.self) { try Gzip.decompress(bad, maxBytes: 10_000) }
        #expect(throws: TarError.self) { try Gzip.decompress(gz, maxBytes: 100) } // bomb cap
        // Interop: real gzip output decodes.
        let tmp = tempDir().appendingPathComponent("a.txt")
        try "hello gzip\n".write(to: tmp, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
        p.arguments = ["-k", tmp.path]
        try p.run()
        p.waitUntilExit()
        #expect(String(decoding: try Gzip.decompress(Data(contentsOf: tmp.appendingPathExtension("gz")), maxBytes: 1000), as: UTF8.self) == "hello gzip\n")
    }

    @Test func extractsPackageAndStripsRoot() throws {
        let tgz = Tar.createTgz([.init(path: "package/"), .init(path: "package/package.json", data: Data("{}".utf8)), .init(path: "package/bin/run", data: Data("x".utf8), mode: 0o755)])
        let dest = tempDir().appendingPathComponent("out")
        let paths = try Tar.extractTgz(tgz, to: dest)
        #expect(Set(paths) == ["package.json", "bin/run"])
        let mode = try FileManager.default.attributesOfItem(atPath: dest.appendingPathComponent("bin/run").path)[.posixPermissions] as? Int
        #expect(mode == 0o755)
        #expect(throws: TarError.self) { try Tar.extractTgz(tgz, to: dest) } // destination exists
    }

    @Test(arguments: [
        ("../evil", "Path traversal"), ("/etc/passwd", "Absolute path"), ("a\\b", "Backslashes"), ("C:/x", "Absolute path"),
    ])
    func rejectsHostilePaths(_ path: String, _ msg: String) throws {
        let tar = Tar.create([.init(path: path, data: Data("x".utf8))])
        #expect { try Tar.read(tar) } throws: { ($0 as? TarError)?.message.contains(msg) == true }
    }

    @Test func rejectsLinksDuplicatesAndFileParents() throws {
        #expect { try Tar.read(Tar.create([.init(path: "l", link: ("symlink", "/etc"))])) } throws: { ($0 as? TarError)?.message.contains("symbolic link") == true }
        #expect { try Tar.read(Tar.create([.init(path: "h", link: ("hardlink", "x"))])) } throws: { ($0 as? TarError)?.message.contains("hard link") == true }
        #expect { try Tar.read(Tar.create([.init(path: "a", data: Data()), .init(path: "a", data: Data())])) } throws: { ($0 as? TarError)?.message.contains("Duplicate") == true }
        #expect { try Tar.read(Tar.create([.init(path: "a", data: Data()), .init(path: "a/b", data: Data())])) } throws: { ($0 as? TarError)?.message.contains("inside a file") == true }
        var tar = Tar.create([.init(path: "a", data: Data("x".utf8))])
        tar[0] = UInt8(ascii: "b") // checksum now wrong
        #expect { try Tar.read(tar) } throws: { ($0 as? TarError)?.message.contains("checksum") == true }
        var limits = TarLimits()
        limits.maxEntries = 1
        #expect { try Tar.read(Tar.create([.init(path: "a", data: Data()), .init(path: "b", data: Data())]), limits: limits) } throws: { ($0 as? TarError)?.message.contains("too many") == true }
    }

    @Test func semverAndIndexValidation() throws {
        #expect(StoreSchema.compareVersions("1.2.0", "1.10.0") < 0)
        #expect(StoreSchema.compareVersions("1.0.0-beta", "1.0.0") < 0)
        #expect(StoreSchema.compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10") < 0)
        #expect(StoreSchema.compareVersions("x", "0.0.1") < 0)
        let url = examplesDir.deletingLastPathComponent().appendingPathComponent("store/index.json")
        let v = try StoreSchema.validate(try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)))
        #expect(v.entries.map(\.id) == ["color-converter", "github-search", "hacker-news", "timezones", "uuid-generator"])
        #expect(v.errors.isEmpty)
        let bad: JSONValue = ["schemaVersion": 1, "extensions": [["id": "Bad ID", "name": "x"], ["id": "ok", "name": "ok", "title": "T", "description": "D", "author": "A", "version": "1.0.0",
                                                                    "minGlideVersion": "0.1.0", "kind": "glide", "commands": [["name": "c", "title": "C"]],
                                                                    "download": ["url": "javascript:alert(1)", "sha256": .string(String(repeating: "a", count: 64)), "size": 10]]]]
        let r = try StoreSchema.validate(bad)
        #expect(r.entries.isEmpty)
        #expect(r.errors.contains { $0.contains("unsupported URL scheme") })
        #expect(throws: StoreIndexError.self) { try StoreSchema.validate(["schemaVersion": 2, "extensions": []]) }
        #expect(throws: StoreIndexError.self) { try StoreSchema.resolveURL("http://example.com/x.json") }
        #expect(try StoreSchema.resolveURL("pkg/a.tgz", base: "http://127.0.0.1:9/store/index.json").absoluteString == "http://127.0.0.1:9/store/pkg/a.tgz")
    }
}

@Suite("store service", .serialized)
@MainActor struct StoreServiceTests {
    private func pkg(version: String) -> Data {
        let pj = #"{"name":"e2e-greeter","version":"\#(version)","glide":{"title":"E2E Greeter","commands":[{"name":"greet","title":"Say Hello","mode":"no-view"}]}}"#
        return Tar.createTgz([.init(path: "package/package.json", data: Data(pj.utf8)),
                              .init(path: "package/greet.js", data: Data(#"module.exports = async () => { await require("@glide/api").showHUD("hi"); };"#.utf8))])
    }

    @Test func installsBundledAndDownloadsVerifiedPackage() async throws {
        let v1 = pkg(version: "1.0.0"), v2 = pkg(version: "1.1.0")
        let state = LockedBox(v1)
        let server = try LocalHTTPServer { _, path, _ in
            if path == "/store/index.json" {
                let body = state.get()
                let idx: [String: Any] = ["schemaVersion": 1, "extensions": [[
                    "id": "e2e-greeter", "name": "e2e-greeter", "title": "E2E Greeter", "description": "d", "author": "me", "version": body == v1 ? "1.0.0" : "1.1.0",
                    "minGlideVersion": "0.1.0", "kind": "glide", "commands": [["name": "greet", "title": "Say Hello", "mode": "no-view"]],
                    "download": ["url": "pkg.tgz", "sha256": StoreSchema.sha256Hex(body), "size": body.count]]]]
                return (200, "application/json", try! JSONSerialization.data(withJSONObject: idx))
            }
            if path == "/store/pkg.tgz" { return (200, "application/gzip", state.get()) }
            return (404, "text/plain", Data())
        }
        defer { server.stop() }
        let base = tempDir()
        let reg = ExtensionRegistry(base: base)
        let svc = StoreService(.init(registry: reg, dataDir: base, examplesDir: examplesDir,
                                     localIndex: examplesDir.deletingLastPathComponent().appendingPathComponent("store/index.json"),
                                     indexURL: { "\(server.base)/store/index.json" }, mayFetch: { _ in nil }))
        var st = await svc.list(refresh: true)
        #expect(st.error == nil, "\(st.error ?? "")")
        #expect(st.items.count == 6)
        let greeter = try #require(st.items.first { $0.entry.id == "e2e-greeter" })
        #expect(greeter.via == "download" && greeter.size == v1.count)
        await #expect(throws: StoreIndexError.self) { _ = try await svc.install("e2e-greeter", confirmed: false) }
        _ = try await svc.install("e2e-greeter", confirmed: true)
        #expect(reg.get("e2e-greeter")?.manifest?.version == "1.0.0")
        _ = try await svc.install("uuid-generator", confirmed: true)
        #expect(reg.get("uuid-generator")?.source?["kind"] == "store")
        // A newer version is offered as an update; a tampered package is refused.
        state.set(v2)
        st = await svc.list(refresh: true)
        #expect(st.items.first { $0.entry.id == "e2e-greeter" }?.updateAvailable == true)
        _ = try await svc.install("e2e-greeter", confirmed: true, update: true)
        #expect(reg.get("e2e-greeter")?.manifest?.version == "1.1.0")
        let stateFile = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: base.appendingPathComponent("store-state.json")))
        #expect(stateFile["installs"]?["e2e-greeter"]?["via"] == "download")
        try svc.uninstall("e2e-greeter")
        #expect(reg.get("e2e-greeter") == nil)
    }

    @Test func checksumMismatchInstallsNothing() async throws {
        let body = pkg(version: "1.0.0")
        let server = try LocalHTTPServer { _, path, _ in
            if path == "/i.json" {
                return (200, "application/json", try! JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "extensions": [[
                    "id": "e2e-greeter", "name": "e2e-greeter", "title": "G", "description": "d", "author": "me", "version": "1.0.0", "minGlideVersion": "0.1.0",
                    "kind": "glide", "commands": [["name": "greet", "title": "Hi"]], "download": ["url": "p.tgz", "sha256": String(repeating: "0", count: 64), "size": body.count]]]]))
            }
            return (200, "application/gzip", body)
        }
        defer { server.stop() }
        let base = tempDir()
        let reg = ExtensionRegistry(base: base)
        let svc = StoreService(.init(registry: reg, dataDir: base, examplesDir: nil, localIndex: nil, indexURL: { "\(server.base)/i.json" }, mayFetch: { _ in nil }))
        _ = await svc.list(refresh: true)
        await #expect { _ = try await svc.install("e2e-greeter", confirmed: true) } throws: { ($0 as? StoreIndexError)?.message.contains("Checksum mismatch") == true }
        #expect(reg.list().isEmpty)
    }

    @Test func headlessNeverFetchesPublicDefault() async {
        let base = tempDir()
        let svc = StoreService(.init(registry: ExtensionRegistry(base: base), dataDir: base, examplesDir: examplesDir, localIndex: nil,
                                     indexURL: { StoreClient.defaultIndexURL }, mayFetch: { $0 == StoreClient.defaultIndexURL ? "headless" : nil }))
        let st = await svc.list(refresh: true)
        #expect(st.error == "headless")
        #expect(!st.items.isEmpty) // bundled examples are still listed
    }
}

final class LockedBox: @unchecked Sendable {
    private let lock = NSLock()
    private var v: Data
    init(_ v: Data) { self.v = v }
    func get() -> Data { lock.lock(); defer { lock.unlock() }; return v }
    func set(_ n: Data) { lock.lock(); v = n; lock.unlock() }
}

@Suite("manifest + registry")
struct ManifestTests {
    @Test func glideAndRaycastManifests() throws {
        let ok = Manifest.read(dir: examplesDir.appendingPathComponent("hacker-news"))
        let m = try #require(ok.manifest)
        #expect(m.commands.first?.entry == "top-stories.js")
        #expect(m.preferences.first?.defaultValue == "30")
        let bad = Manifest.validate(["name": "a b", "glide": ["commands": []]])
        #expect(bad.errors.contains { $0.contains("\"name\" must be") })
        #expect(bad.errors.contains("\"glide.title\" is required"))
        let rc = Manifest.translateRaycast(["name": "x", "title": "X", "dependencies": ["@raycast/api": "1"],
                                            "commands": [["name": "m", "title": "M", "mode": "menu-bar", "interval": "5s", "preferences": [["name": "k", "type": "appPicker", "title": "App"]]]]])
        let r = try #require(rc.manifest)
        #expect(r.commands[0].intervalMs == nil && r.warnings.count == 1)
        #expect(r.preferences[0].key == "m/k" && r.preferences[0].type == "textfield")
        #expect(Manifest.parseInterval("90s") == 90_000)
        #expect(Manifest.splitArguments([.init(name: "a", required: true), .init(name: "b", required: false)], "one two three") == ["a": "one", "b": "two three"])
    }

    @Test func preferencesResolveScopedAndMissing() throws {
        let m = try #require(Manifest.translateRaycast(["name": "x", "title": "X", "dependencies": ["@raycast/api": "1"],
                                                        "preferences": [["name": "token", "type": "password", "title": "T", "required": true]],
                                                        "commands": [["name": "c", "title": "C", "preferences": [["name": "token", "type": "textfield", "title": "T2", "default": "d"]]]]]).manifest)
        #expect(Manifest.missingPreferences(m, saved: [:], command: "c").map(\.key) == ["token"])
        #expect(Manifest.resolvePreferences(m, saved: ["token": "ext"], command: "c")["token"] == "ext") // legacy un-namespaced value still read (manifest.ts savedValue)
        #expect(Manifest.resolvePreferences(m, saved: ["token": "ext", "c/token": "cmd"], command: "c")["token"] == "cmd")
    }

    @Test func registryLayoutMatchesElectron() throws {
        let base = tempDir()
        let reg = ExtensionRegistry(base: base)
        try reg.install(folder: examplesDir.appendingPathComponent("timezones"), source: ["kind": "folder", "path": "/x"])
        try reg.setEnabled("timezones", false)
        try reg.setPreferences("timezones", ["hourCycle": "h12"])
        try reg.storageWrite("timezones") { $0["k"] = 1 }
        let st = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: base.appendingPathComponent("state.json")))
        #expect(st["extensions"]?["timezones"]?["enabled"] == false)
        #expect(st["extensions"]?["timezones"]?["source"]?["kind"] == "folder")
        let mode = try FileManager.default.attributesOfItem(atPath: base.appendingPathComponent("preferences/timezones.json").path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
        #expect(reg.storageAll("timezones")["k"] == 1)
        #expect(FileManager.default.fileExists(atPath: base.appendingPathComponent("installed/timezones/world-clocks.js").path))
        try reg.uninstall("timezones")
        #expect(reg.list().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent("preferences/timezones.json").path))
    }

    @Test func filterMatchesElectronOrdering() {
        let items = ["New York", "York", "Yorkshire Pudding"].map { ExtItem(["id": .string($0), "title": .string($0)]) }
        #expect(ExtFilter.filter(items, "york").map(\.title) == ["York", "Yorkshire Pudding", "New York"])
        let kw = ExtItem(["id": "a", "title": "Apple", "keywords": ["Kazakhstan"]])
        #expect(ExtFilter.filter([kw], "kaz").count == 1)
        #expect(ExtFilter.filter([kw], "zzz").isEmpty)
    }

    @Test func markdownBlocks() {
        let b = MarkdownBlock.parse("# T\n\ntext **b**\nmore\n\n- one\n2. two\n> q\n```\ncode\n```\n---\n![alt](https://x/y.png)")
        #expect(b == [.heading(1, "T"), .paragraph("text **b** more"), .bullet("one", ordered: nil), .bullet("two", ordered: "2"), .quote("q"), .code("code"), .rule, .image(alt: "alt", url: "https://x/y.png")])
    }
}

@Suite("script commands")
struct ScriptTests {
    @Test func parsesRaycastMetadata() {
        let m = ScriptParser.parse("""
        #!/bin/bash
        # @raycast.schemaVersion 1
        # @raycast.title Hello
        # @raycast.mode inline
        # @raycast.refreshTime 5s
        // @glide.icon 👋
        # @raycast.argument1 { "type": "dropdown", "placeholder": "P", "data": [{"title":"A","value":"a"}] }
        # @raycast.argument3 { "type": "text", "placeholder": "Q" }
        """)
        #expect(m.title == "Hello" && m.mode == "inline" && m.icon == "👋")
        #expect(m.refreshTimeMs == 10_000)
        #expect(m.arguments.count == 1 && m.arguments[0].data.first?.value == "a")
        #expect(m.errors == ["argument2 is missing but a later argument is declared"])
        #expect(ScriptParser.parse("# @raycast.mode weird").errors.contains { $0.hasPrefix("Unknown mode") })
        #expect(ScriptParser.splitArguments("\"a b\" 'c d' rest of it", count: 3) == ["a b", "c d", "rest of it"])
        #expect(ScriptParser.splitArguments("one", count: 2) == ["one"])
    }

    @Test func runnerStreamsOutputExitCodesAndTimeout() async throws {
        let dir = tempDir("n9-run")
        let f = dir.appendingPathComponent("s.sh")
        try "#!/bin/bash\necho out $1\necho err >&2\nexit 3\n".write(to: f, atomically: true, encoding: .utf8)
        let r = ScriptRun()
        r.start(file: f, args: ["A"], cwd: nil, env: ["PATH": "/usr/bin:/bin"], timeout: 10)
        let o = await r.wait()
        #expect(o.code == 3 && o.stdout == "out A\n" && o.stderr == "err\n" && !o.ok)
        // No shebang: zsh fallback.
        let g = dir.appendingPathComponent("plain")
        try "echo plain".write(to: g, atomically: true, encoding: .utf8)
        let r2 = ScriptRun()
        r2.start(file: g, args: [], cwd: nil, env: ["PATH": "/usr/bin:/bin"], timeout: 10)
        #expect(await r2.wait().stdout == "plain\n")
        let slow = dir.appendingPathComponent("slow.sh")
        try "#!/bin/bash\nsleep 30\n".write(to: slow, atomically: true, encoding: .utf8)
        let r3 = ScriptRun()
        r3.start(file: slow, args: [], cwd: nil, env: ["PATH": "/usr/bin:/bin"], timeout: 0.3)
        let o3 = await r3.wait()
        #expect(o3.timedOut && o3.error == "Timed out")
    }
}
