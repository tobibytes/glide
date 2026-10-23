import Foundation
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem
import GlideUI

/// A FeatureContext over the headless fakes and a temp Store (never touches the user's data or screen).
@MainActor final class N3Context: FeatureContext {
    let featureId: String
    let store: Store
    let services: SystemServices
    let log: SideEffectLog
    let root: URL
    var hotkeys: [String: String] = [:]
    var hotkeyHandlers: [String: @MainActor () -> Void] = [:]
    var toasts: [(String, ToastStyle)] = []
    var hidden = 0
    var pushed: [ViewID] = []
    var calls: [(String, String)] = []

    init(_ featureId: String, env: [String: String] = [:], services custom: ((SideEffectLog) -> SystemServices)? = nil) {
        self.featureId = featureId
        root = (ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory).appendingPathComponent("n3-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = Store(directory: root, debounce: 0)
        _ = try? store.load()
        log = SideEffectLog(echo: false)
        services = custom?(log) ?? SystemServicesFactory.headless(log: log, environment: env)
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
    func hideLauncher() { hidden += 1 }
    func push(_ view: ViewID, payload: JSONValue) { pushed.append(view) }
    func openSettings(page: String?) {}
    func toast(_ message: String, style: ToastStyle) { toasts.append((message, style)) }
    func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool {
        if let accelerator {
            hotkeys[key] = accelerator
            hotkeyHandlers[key] = handler
        } else {
            hotkeys[key] = nil
            hotkeyHandlers[key] = nil
        }
        return true
    }
    func executeItem(id: String, argument: String?) async -> ActionResult { .stay(message: nil) }
    func search(_ query: String) async -> [ScoredItem] { [] }
    func findItem(id: String) -> SearchItem? { nil }
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue {
        calls.append((featureId, method))
        throw FeatureError.unknownFeature(featureId)
    }
    func log(_ message: String) {}

    func effects(_ kind: String) -> [JSONValue] { log.all.filter { $0.kind == kind }.map(\.detail) }
}

/// LayoutService fake with scripted capture results; records moves and quits.
@MainActor final class FakeLayouts: LayoutService {
    var displaysValue: JSONValue = [["id": 1, "uuid": "A", "name": "Built-in", "frame": ["x": 0, "y": 0, "width": 1440, "height": 900],
                                     "visible": ["x": 0, "y": 25, "width": 1440, "height": 875], "main": true]]
    var windows: [JSONValue] = []
    var running: [String] = []
    var moves: [JSONValue] = []
    var quits: [[String]] = []
    func displays() -> JSONValue { displaysValue }
    func runningApps() -> JSONValue { .array(running.map { ["name": .string($0), "bundleId": .string($0), "pid": 1] }) }
    func capture(includeHidden: Bool) async -> JSONValue { ["ok": true, "displays": displaysValue, "windows": .array(windows)] }
    func move(_ m: JSONValue) async -> JSONValue {
        moves.append(m)
        return ["ok": true, "results": .array((m.arrayValue ?? []).map { ["ref": $0["ref"] ?? .null, "ok": true, "frame": $0["frame"] ?? .null] })]
    }
    func quit(bundleIds: [String]) -> JSONValue {
        quits.append(bundleIds)
        return ["ok": true, "asked": .array(bundleIds.map(JSONValue.string))]
    }

    static func window(_ ref: Int, _ bid: String, _ title: String, x: Double = 0, y: Double = 25, w: Double = 700, h: Double = 500, order: Int = 0) -> JSONValue {
        ["ref": .int(Int64(ref)), "pid": 1, "bundleId": .string(bid), "appName": .string(bid), "appPath": nil, "title": .string(title),
         "frame": ["x": .double(x), "y": .double(y), "width": .double(w), "height": .double(h)], "display": 0, "order": .int(Int64(order)), "fullScreen": false]
    }
}
