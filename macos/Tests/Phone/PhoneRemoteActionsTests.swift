import Foundation
import GlideCore
@testable import GlideFeatures
import GlideSystem
import Testing

/// The remote-control and file actions, headless: a recording input (never posts an event) and a temp home.
@MainActor @Suite("Phone remote and file actions")
struct PhoneRemoteActionsTests {
    static let lan = PhoneCaller(deviceId: "dev", deviceName: "Test iPhone", transport: .lan)

    @MainActor final class Fixture {
        let registry = PhoneActionRegistry()
        let input: HeadlessRemoteInput
        let home: URL
        let files: PhoneFiles
        var fileBag: [String: JSONValue] = [:]

        init(trusted: Bool = true) throws {
            input = HeadlessRemoteInput(trusted: trusted)
            home = try PhoneWebSupport.scratch("home")
            weak var box: Fixture?
            files = PhoneFiles(home: home.path, backendKind: "scan", fileSettings: { box?.fileBag ?? [:] }, headless: true)
            box = self
            PhoneRemoteActions.register(on: registry, input: input, files: files)
        }

        func run(_ name: String, _ args: JSONValue = [:]) async throws -> JSONValue {
            let a = try #require(registry.action(name))
            return try await a.run(args, PhoneRemoteActionsTests.lan)
        }

        func error(_ name: String, _ args: JSONValue = [:]) async -> PhoneError? {
            do { _ = try await run(name, args); return nil } catch let e as PhoneError { return e } catch { return PhoneError("other", "\(error)") }
        }

        func write(_ rel: String, _ data: Data = Data("hello".utf8)) throws -> URL {
            let u = home.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: u)
            return u
        }

        isolated deinit { try? FileManager.default.removeItem(at: home) }
    }

    @Test func registersTheContractActions() throws {
        let f = try Fixture()
        for name in ["pointer.move", "pointer.click", "pointer.scroll", "keys.press", "type.text", "slides.next", "slides.prev"] {
            let a = try #require(f.registry.action(name))
            #expect(a.group == "remote" && a.risk == .safe && a.relay == false && !a.sensitive, "\(name)")
        }
        for name in ["files.search", "files.get"] {
            let a = try #require(f.registry.action(name))
            #expect(a.group == "files" && a.risk == .safe && a.relay == false, "\(name)")
        }
    }

    @Test func pointerAndKeysAreRecordedNotPosted() async throws {
        let f = try Fixture()
        _ = try await f.run("pointer.move", ["dx": 12, "dy": -3.5])
        _ = try await f.run("pointer.move", ["dx": 99999, "dy": -99999])
        _ = try await f.run("pointer.click", ["button": "right"])
        _ = try await f.run("pointer.click", ["double": true])
        _ = try await f.run("pointer.scroll", ["dx": 0, "dy": 40])
        _ = try await f.run("keys.press", ["key": "k", "modifiers": ["cmd", "shift"]])
        _ = try await f.run("keys.press", ["key": "cmd+left"])
        _ = try await f.run("keys.press", ["key": "Return"])
        _ = try await f.run("type.text", ["text": "Hello, Mac 👋"])
        _ = try await f.run("slides.next")
        _ = try await f.run("slides.prev")
        let e = f.input.effects
        #expect(e.count == 11)
        #expect(e[0] == .init(kind: "remote-move", detail: ["dx": 12.0, "dy": -3.5]))
        #expect(e[1] == .init(kind: "remote-move", detail: ["dx": 4000.0, "dy": -4000.0]))
        #expect(e[2] == .init(kind: "remote-click", detail: ["button": "right", "count": 1]))
        #expect(e[3] == .init(kind: "remote-click", detail: ["button": "left", "count": 2]))
        #expect(e[4] == .init(kind: "remote-scroll", detail: ["dx": 0.0, "dy": 40.0]))
        #expect(e[5] == .init(kind: "remote-key", detail: ["key": "k", "code": 40, "modifiers": ["shift", "cmd"]]))
        #expect(e[6].detail["code"] == 123 && e[6].detail["modifiers"] == ["cmd"])
        #expect(e[7].detail["code"] == 36)
        #expect(e[8] == .init(kind: "remote-type", detail: ["text": "Hello, Mac 👋"]))
        #expect(e[9].detail["code"] == 124 && e[10].detail["code"] == 123)
    }

    @Test func badArgumentsAreExplained() async throws {
        let f = try Fixture()
        #expect(await f.error("pointer.click", ["button": "thumb"])?.code == "bad-args")
        #expect(await f.error("keys.press", ["key": "hyperdrive"])?.code == "bad-args")
        #expect(await f.error("keys.press", ["key": "a", "modifiers": ["super"]])?.code == "bad-args")
        #expect(await f.error("keys.press", [:])?.code == "bad-args")
        #expect(await f.error("type.text", ["text": ""])?.code == "bad-args")
        #expect(await f.error("type.text", .object(["text": .string(String(repeating: "x", count: 10_001))]))?.code == "bad-args")
        #expect(f.input.effects.isEmpty)
    }

    @Test func missingAccessibilityIsAClearError() async throws {
        let f = try Fixture(trusted: false)
        for name in ["pointer.move", "pointer.click", "keys.press", "type.text", "slides.next"] {
            let e = await f.error(name, ["dx": 1, "key": "a", "text": "a"])
            #expect(e?.code == "needs-permission", "\(name)")
            #expect(e?.message.contains("Accessibility") == true)
        }
        #expect(f.input.effects.isEmpty)
    }

    @Test func keyNamesAndModifiers() {
        #expect(RemoteKeys.code(for: "left") == 123 && RemoteKeys.code(for: "PageDown") == 121 && RemoteKeys.code(for: "page_up") == 116)
        #expect(RemoteKeys.code(for: "F5") == 96 && RemoteKeys.code(for: "A") == 0 && RemoteKeys.code(for: "/") == 44)
        #expect(RemoteKeys.code(for: "esc") == 53 && RemoteKeys.code(for: "nope") == nil)
        #expect(RemoteModifiers.parse(["⌘", "Option", "ctrl"]) == [.command, .option, .control])
        #expect(RemoteModifiers.parse(["fn"]) == nil)
    }

    // MARK: files

    @Test func getReturnsFileBytesFromHome() async throws {
        let f = try Fixture()
        let bytes = PhoneWebSupport.random(70_000)
        let u = try f.write("Documents/Report 2026.pdf", bytes)
        let r = try await f.run("files.get", ["path": .string(u.path)])
        #expect(r["name"] == "Report 2026.pdf" && r["type"] == "application/pdf" && r["size"] == 70_000)
        #expect(Data(base64Encoded: r["data"]?.stringValue ?? "") == bytes)
        // Tilde paths are relative to the allowed home.
        let t = try await f.run("files.get", ["path": "~/Documents/Report 2026.pdf"])
        #expect(t["size"] == 70_000)
    }

    @Test func getRefusesPathsOutsideHomeLibraryAndHiddenFiles() async throws {
        let f = try Fixture()
        _ = try f.write("Library/Keychains/login.keychain-db")
        _ = try f.write(".ssh/id_ed25519")
        _ = try f.write(".zshrc")
        _ = try f.write("Projects/.env")
        let outside = try PhoneWebSupport.scratch("outside")
        defer { try? FileManager.default.removeItem(at: outside) }
        let secret = outside.appendingPathComponent("secret.txt")
        try Data("x".utf8).write(to: secret)
        // A symlink inside home that points outside, and one that points into Library.
        try FileManager.default.createSymbolicLink(at: f.home.appendingPathComponent("link-out.txt"), withDestinationURL: secret)
        try FileManager.default.createSymbolicLink(at: f.home.appendingPathComponent("link-lib"), withDestinationURL: f.home.appendingPathComponent("Library"))

        let refused: [String] = [
            f.home.appendingPathComponent("Library/Keychains/login.keychain-db").path,
            f.home.appendingPathComponent(".ssh/id_ed25519").path,
            f.home.appendingPathComponent(".zshrc").path,
            f.home.appendingPathComponent("Projects/.env").path,
            secret.path,
            f.home.appendingPathComponent("link-out.txt").path,
            f.home.appendingPathComponent("link-lib/Keychains/login.keychain-db").path,
            f.home.appendingPathComponent("Documents/../Library/Keychains/login.keychain-db").path,
            "~/.ssh/id_ed25519", "/etc/passwd", "relative/path.txt", f.home.path,
        ]
        for p in refused {
            #expect(await f.error("files.get", .object(["path": .string(p)]))?.code == "not-allowed", "\(p)")
        }
        #expect(await f.error("files.get", [:])?.code == "bad-args")
    }

    @Test func getRefusesLargeFilesAndFolders() async throws {
        let f = try Fixture()
        let big = try f.write("Movies/big.mov", Data())
        let h = try FileHandle(forWritingTo: big)
        try h.truncate(atOffset: UInt64(PhoneFiles.maxBytes + 1)) // sparse, so the test stays fast
        try h.close()
        let e = await f.error("files.get", .object(["path": .string(big.path)]))
        #expect(e?.code == "too-large" && e?.message.contains("25 MB") == true)
        let exact = try f.write("Movies/exact.bin", Data())
        let h2 = try FileHandle(forWritingTo: exact)
        try h2.truncate(atOffset: UInt64(PhoneFiles.maxBytes))
        try h2.close()
        #expect(try await f.run("files.get", .object(["path": .string(exact.path)]))["size"] == .int(Int64(PhoneFiles.maxBytes)))
        try FileManager.default.createDirectory(at: f.home.appendingPathComponent("Folder"), withIntermediateDirectories: true)
        #expect(await f.error("files.get", .object(["path": .string(f.home.appendingPathComponent("Folder").path)]))?.code == "missing")
        #expect(await f.error("files.get", .object(["path": .string(f.home.appendingPathComponent("gone.txt").path)]))?.code == "missing")
    }

    @Test func searchFindsAllowedFilesOnly() async throws {
        let f = try Fixture()
        _ = try f.write("Documents/budget-2026.xlsx")
        _ = try f.write("Documents/Old/budget-2025.xlsx")
        _ = try f.write("Library/budget-secret.txt")
        _ = try f.write(".hidden/budget.txt")
        try FileManager.default.createDirectory(at: f.home.appendingPathComponent("budget-folder"), withIntermediateDirectories: true)
        // Headless without explicit File Search scopes: never searches anything.
        #expect(try await f.run("files.search", ["query": "budget"])["files"] == [])
        f.fileBag = ["scopes": ["~"], "includeHidden": true, "exclusions": []]
        let r = try await f.run("files.search", ["query": "budget"])
        let names = (r["files"]?.arrayValue ?? []).compactMap { $0["name"]?.stringValue }
        #expect(Set(names) == ["budget-2026.xlsx", "budget-2025.xlsx"])
        let first = try #require(r["files"]?.arrayValue?.first)
        #expect(first["size"] == 5 && first["kind"]?.stringValue?.isEmpty == false && first["path"]?.stringValue?.hasSuffix(".xlsx") == true)
        // Scopes outside home are ignored.
        f.fileBag = ["scopes": ["/etc"], "exclusions": []]
        #expect(try await f.run("files.search", ["query": "passwd"])["files"] == [])
        #expect(await f.error("files.search", ["query": "b"])?.code == "bad-args")
    }
}
