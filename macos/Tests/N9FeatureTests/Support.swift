import Foundation
@testable import GlideFeatures
import GlideCore
import Testing

/// <glide>/extensions-examples (bundled examples + raycast-fixtures).
let examplesDir: URL = {
    var d = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
    for _ in 0..<3 { d.deleteLastPathComponent() } // Tests/N9FeatureTests/Support.swift → macos
    return d.deletingLastPathComponent().appendingPathComponent("extensions-examples")
}()

func tempDir(_ name: String = "n9") -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

/// Records requests (answered by `answers` or a default) and session events.
@MainActor final class FakeDelegate: ExtensionSessionDelegate {
    var requests: [(method: String, params: [JSONValue])] = []
    var events: [ExtensionSession.Event] = []
    var answers: [String: JSONValue] = [:]
    var storage: [String: JSONValue] = [:]
    func session(_ s: ExtensionSession, request method: String, params: [JSONValue]) async throws -> JSONValue {
        requests.append((method, params))
        switch method {
        case "storage.get": return storage[params.first?.stringValue ?? ""] ?? .null
        case "storage.set": storage[params.first?.stringValue ?? ""] = params.count > 1 ? params[1] : .null; return .null
        case "storage.all": return .object(storage)
        case "storage.remove": storage[params.first?.stringValue ?? ""] = nil; return .null
        case "confirmAlert": return answers[method] ?? true
        default: return answers[method] ?? .null
        }
    }
    func sessionDidChange(_ s: ExtensionSession, _ event: ExtensionSession.Event) { events.append(event) }
    func methods() -> [String] { requests.map(\.method) }
}

/// Polls `cond` on the main actor (JS runs on its own queue and posts back to main).
@MainActor func waitUntil(_ timeout: Duration = .seconds(10), _ cond: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if cond() { return true }
        try? await Task.sleep(for: .milliseconds(15))
    }
    return cond()
}

/// Installs a folder into a temp registry and starts one command in a JS session.
@MainActor struct Harness {
    let registry: ExtensionRegistry
    let delegate = FakeDelegate()
    let base = tempDir()

    init() { registry = ExtensionRegistry(base: base) }

    func install(_ rel: String) throws -> InstalledExtension {
        try registry.install(folder: examplesDir.appendingPathComponent(rel), source: ["kind": "folder"])
    }

    func run(_ ext: InstalledExtension, _ command: String, args: [String: String] = [:], prefs: [String: JSONValue] = [:],
             options: JSHost.Options = JSHost.Options()) throws -> ExtensionSession {
        let m = try #require(ext.manifest)
        let cmd = try #require(m.commands.first { $0.name == command })
        var saved = registry.preferences(ext.name)
        saved.merge(prefs) { $1 }
        let info = SessionInfo(id: UUID().uuidString, extName: m.name, extTitle: m.title, commandName: cmd.name, commandTitle: cmd.title, mode: cmd.mode,
                               runtime: m.runtime, launchType: "userInitiated", assetsPath: ext.dir.appendingPathComponent("assets").path)
        let s = ExtensionSession(info: info, delegate: delegate, options: options)
        s.start(initPayload: InitPayload.make(ext: ext, manifest: m, command: cmd, arguments: args,
                                              preferences: Manifest.resolvePreferences(m, saved: saved, command: cmd.name),
                                              supportPath: registry.supportDir(m.name).path))
        return s
    }
}
