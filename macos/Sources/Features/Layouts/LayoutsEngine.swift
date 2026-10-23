import Foundation
import GlideCore

/// layouts.json in the feature's data dir (written atomically, same shape as the Electron app's).
@MainActor public final class LayoutStore {
    public let file: URL
    public private(set) var data: LayoutsFile

    public init(directory: URL) {
        file = directory.appendingPathComponent("layouts.json")
        data = (try? Data(contentsOf: file)).map(LayoutsCodec.parse) ?? LayoutsFile()
    }

    public var layouts: [WindowLayout] { data.layouts }
    public var workspaces: [Workspace] { data.workspaces }
    public func layout(_ id: String) -> WindowLayout? { data.layouts.first { $0.id == id } }
    public func workspace(_ id: String) -> Workspace? { data.workspaces.first { $0.id == id } }

    public func put(_ l: WindowLayout) {
        if let i = data.layouts.firstIndex(where: { $0.id == l.id }) { data.layouts[i] = l } else { data.layouts.append(l) }
        flush()
    }
    public func deleteLayout(_ id: String) {
        data.layouts.removeAll { $0.id == id }
        for i in data.workspaces.indices where data.workspaces[i].layoutId == id { data.workspaces[i].layoutId = nil }
        flush()
    }
    public func put(_ w: Workspace) {
        if let i = data.workspaces.firstIndex(where: { $0.id == w.id }) { data.workspaces[i] = w } else { data.workspaces.append(w) }
        flush()
    }
    public func deleteWorkspace(_ id: String) {
        data.workspaces.removeAll { $0.id == id }
        flush()
    }

    private func flush() {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? LayoutsCodec.encode(data).write(to: file, options: .atomic)
    }
}

public struct RestoreReport: Sendable, Equatable {
    public var ok = true
    public var error: String?
    public var moved = 0
    public var total = 0
    public var launched: [String] = []
    public var unmatched: [String] = []
    public var failed: [String] = []

    public func summary(_ name: String) -> String {
        if !ok { return error ?? "Could not restore the layout" }
        var parts = ["Restored \(name): \(moved)/\(total) windows"]
        if !launched.isEmpty { parts.append("launched \(launched.joined(separator: ", "))") }
        if !unmatched.isEmpty { parts.append("\(unmatched.count) not open") }
        return parts.joined(separator: " · ")
    }
}

/// Save / restore orchestration over LayoutService (port of engine.ts). Dependencies are injected for tests.
@MainActor public struct LayoutsEngine {
    public static let needsAccessibility = "Window layouts need Accessibility permission. Open System Settings → Privacy & Security → Accessibility and enable Glide."
    public let service: any LayoutService
    public var launch: @MainActor (AppRef) -> ServiceResult
    public var sleep: @MainActor (Duration) async -> Void = { try? await Task.sleep(for: $0) }
    public var now: @MainActor () -> Double = { Date().timeIntervalSince1970 * 1000 }

    public init(service: any LayoutService, launch: @escaping @MainActor (AppRef) -> ServiceResult) {
        self.service = service
        self.launch = launch
    }

    struct Capture {
        var windows: [LiveWindow]
        var displays: [SavedDisplay]
    }

    func capture() async throws -> Capture {
        let r = await service.capture(includeHidden: false)
        guard r["ok"]?.boolValue == true else {
            let e = r["error"]?.stringValue
            throw FeatureError.failed(e == "Accessibility permission required" ? Self.needsAccessibility : (e ?? "Could not read windows"))
        }
        return Capture(windows: LayoutsCodec.liveWindows(r), displays: LayoutsCodec.displays(r["displays"]))
    }

    public func captureLayout(name: String, id: String? = nil) async throws -> WindowLayout {
        let c = try await capture()
        let l = LayoutsLogic.layoutFromCapture(name: name, displays: c.displays, windows: c.windows, now: now(), id: id)
        if l.windows.isEmpty { throw FeatureError.failed("No windows to save — open some app windows first.") }
        return l
    }

    public func runningBundleIds() -> Set<String> {
        Set((service.runningApps().arrayValue ?? []).compactMap { $0["bundleId"]?.stringValue })
    }

    public func restore(_ layout: WindowLayout, relaunch: Bool, launchTimeout: Duration, alsoWaitFor: [String] = []) async -> RestoreReport {
        var report = RestoreReport(total: layout.windows.count)
        var live: Capture
        do { live = try await capture() } catch {
            report.ok = false
            report.error = error.localizedDescription
            return report
        }
        var waitFor = Set(alsoWaitFor)
        if relaunch {
            let missing = LayoutsLogic.missingApps(layout.windows, live: live.windows, running: runningBundleIds())
            for app in LayoutsLogic.apps(layout) where missing.contains(app.bundleId) {
                let r = launch(app)
                if r.ok {
                    report.launched.append(app.name)
                    waitFor.insert(app.bundleId)
                } else {
                    report.failed.append("\(app.name): Could not launch: \(r.error ?? "unknown error")")
                }
            }
        }
        if !waitFor.isEmpty {
            var wanted: [String: Int] = [:]
            for w in layout.windows where waitFor.contains(w.bundleId) { wanted[w.bundleId, default: 0] += 1 }
            for id in waitFor where wanted[id] == nil { wanted[id] = 1 }
            let deadline = now() + Double(launchTimeout.components.seconds) * 1000
            while true {
                var have: [String: Int] = [:]
                for w in live.windows { if let b = w.bundleId { have[b, default: 0] += 1 } }
                if wanted.allSatisfy({ (have[$0.key] ?? 0) >= $0.value }) || now() >= deadline { break }
                await sleep(.milliseconds(400))
                live = (try? await capture()) ?? live
            }
            await sleep(.milliseconds(300))
            live = (try? await capture()) ?? live
        }
        let plan = LayoutsLogic.planRestore(layout, live: live.windows, liveDisplays: live.displays)
        report.unmatched = plan.unmatched.map { "\($0.appName) — \($0.title)" }
        var results = await apply(plan.moves)
        let retry = plan.moves.filter { m in
            guard let r = results[m.ref], r.ok, let f = r.frame else { return false }
            return !Self.close(f, m.frame)
        }
        if !retry.isEmpty {
            await sleep(.milliseconds(150))
            for (k, v) in await apply(retry) { results[k] = v }
        }
        for m in plan.moves {
            if results[m.ref]?.ok == true { report.moved += 1 } else { report.failed.append("\(m.saved.appName): \(results[m.ref]?.error ?? "Not moved")") }
        }
        return report
    }

    static func close(_ a: Rect, _ b: Rect) -> Bool { abs(a.x - b.x) <= 2 && abs(a.y - b.y) <= 2 && abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2 }

    struct MoveResult { var ok: Bool; var error: String?; var frame: Rect? }

    func apply(_ moves: [LayoutsLogic.PlannedMove]) async -> [Int: MoveResult] {
        var out: [Int: MoveResult] = [:]
        if moves.isEmpty { return out }
        let r = await service.move(.array(moves.map { ["ref": .int(Int64($0.ref)), "frame": LayoutsCodec.json($0.frame)] }))
        guard r["ok"]?.boolValue == true else {
            for m in moves { out[m.ref] = MoveResult(ok: false, error: r["error"]?.stringValue ?? "Move failed") }
            return out
        }
        let results = r["results"]?.arrayValue ?? []
        if results.isEmpty {
            // Headless fakes answer without per-window results: count every requested move as done.
            for m in moves { out[m.ref] = MoveResult(ok: true, frame: m.frame) }
        }
        for res in results {
            guard let ref = res["ref"]?.intValue else { continue }
            out[ref] = MoveResult(ok: res["ok"]?.boolValue == true, error: res["error"]?.stringValue, frame: LayoutsCodec.rect(res["frame"]))
        }
        return out
    }
}
