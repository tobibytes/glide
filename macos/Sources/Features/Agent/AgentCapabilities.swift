import AppKit
import Foundation
import GlideCore
import GlideSystem

struct AgentHit: Equatable, Sendable {
    var id: String
    var title: String
    var subtitle: String?
    var kind: String
    var acceptsArgument: Bool

    init(id: String, title: String, subtitle: String? = nil, kind: String, acceptsArgument: Bool = false) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.kind = kind
        self.acceptsArgument = acceptsArgument
    }

    init(_ i: SearchItem) {
        self.init(id: i.id, title: i.title, subtitle: i.subtitle, kind: i.kindLabel ?? i.kind.rawValue, acceptsArgument: i.acceptsArgument == true)
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "title": .string(title), "kind": .string(kind)]
        if let subtitle { o["subtitle"] = .string(subtitle) }
        if acceptsArgument { o["acceptsArgument"] = true }
        return .object(o)
    }
}

struct AgentProcessRow: Equatable, Sendable {
    var pid: Int
    var name: String
    var cpu: Double
    var rssKb: Double
    var user: String
    var command: String
}

struct AgentAppearance: Equatable, Sendable {
    /// system | dark | light
    var mode: String
    var darkTheme: String
    var lightTheme: String
    var presets: [(id: String, name: String, scheme: String)]
    static func == (a: AgentAppearance, b: AgentAppearance) -> Bool {
        a.mode == b.mode && a.darkTheme == b.darkTheme && a.lightTheme == b.lightTheme && a.presets.map(\.id) == b.presets.map(\.id)
    }
}

/// Everything the agent's tools can do to Glide and the Mac (tools.ts AgentCapabilities). The live
/// implementation maps onto FeatureContext (search, executeItem, callFeature, services, store); tests fake it.
@MainActor protocol AgentCapabilities: AnyObject {
    /// Unix ms (clock for tests).
    func now() -> Double
    /// Whether a feature module is installed (tools needing a missing one are hidden).
    func hasFeature(_ id: String) -> Bool
    /// Another feature's `invoke` (timers, notes, automations, layouts, transforms, reminders, …).
    func call(_ feature: String, _ method: String, _ args: JSONValue) async throws -> JSONValue

    func search(_ query: String, limit: Int) async -> [AgentHit]
    func findItem(_ id: String) -> AgentHit?
    func executeItem(_ id: String, argument: String?) async -> AgentOp
    func workflowForItem(_ id: String, argument: String?, title: String?) -> AgentWorkflowStep?
    func listWorkflows() -> [Workflow]
    func runWorkflow(_ id: String, input: String?) async -> (ok: Bool, result: String?, error: String?)

    func windowAction(_ action: String, app: String?) async -> AgentOp
    /// Frames of every window right now (layouts.capture), nil when unreadable.
    func windowSnapshot() async -> JSONValue?
    func restoreWindows(_ snapshot: JSONValue) async -> AgentOp

    func openURL(_ url: String) -> AgentOp
    func openApp(_ name: String) async -> AgentOp
    func openFile(_ path: String) -> AgentOp
    func clipboardText() -> String
    func copyText(_ text: String) -> AgentOp
    func selectedText() async -> (text: String?, error: String?)
    func calendarEvents(from: Date, to: Date) async -> (events: JSONValue?, error: String?)

    func snippets() -> [Snippet]
    func saveSnippet(_ s: Snippet)
    func deleteSnippet(_ id: String) -> Bool
    func saveQuicklink(_ q: Quicklink)
    func deleteQuicklink(_ id: String) -> Bool

    func listProcesses() async throws -> [AgentProcessRow]
    func killProcess(pid: Int, force: Bool, expectedCommand: String) async -> AgentOp
    func runShortcut(_ name: String, input: String?) async -> (ok: Bool, output: String?, error: String?)

    func appearance() -> AgentAppearance
    func setAppearance(mode: String?, preset: String?) -> AgentOp
    func restoreAppearance(_ prev: AgentAppearance) -> AgentOp
}

/// The real capabilities over the host's FeatureContext.
@MainActor final class LiveAgentCapabilities: AgentCapabilities {
    let ctx: FeatureContext
    /// Called when a tool hid the launcher (the run brings its view back for the next confirmation / summary).
    var onLauncherHidden: () -> Void = {}
    private var featureCache: [String: Bool] = [:]
    /// Own items (`agent:`) and the MCP server's (`mcp-server:`) are never runnable through the agent.
    nonisolated static let blockedPrefixes = ["agent:", "mcp-server:"]

    init(ctx: FeatureContext) { self.ctx = ctx }

    func now() -> Double { agentNowMs() }

    func hasFeature(_ id: String) -> Bool {
        if let hit = featureCache[id] { return hit }
        return false
    }

    /// Probes which features are installed: an unknown method means the feature exists, unknownFeature means not.
    func refreshFeatures(_ ids: [String]) async {
        for id in ids {
            do {
                _ = try await ctx.callFeature(id, method: "__glide_agent_probe__", args: .null)
                featureCache[id] = true
            } catch let e as FeatureError {
                if case .unknownFeature = e { featureCache[id] = false } else { featureCache[id] = true }
            } catch {
                featureCache[id] = true
            }
        }
    }

    func call(_ feature: String, _ method: String, _ args: JSONValue) async throws -> JSONValue {
        do { return try await ctx.callFeature(feature, method: method, args: args) } catch let e as FeatureError {
            switch e {
            case .unknownFeature: throw AgentToolFailure("The \(feature) feature is not available in this version of Glide")
            case .unknownMethod: throw AgentToolFailure("The \(feature) feature does not support \(method) yet")
            default: throw AgentToolFailure(e.localizedDescription)
            }
        }
    }

    // MARK: catalogue

    func search(_ query: String, limit: Int) async -> [AgentHit] {
        let res = await ctx.search(query)
        var seen = Set<String>()
        var out: [AgentHit] = []
        for s in res where s.item.kind != .fallback && !Self.blockedPrefixes.contains(where: { s.item.id.hasPrefix($0) }) && seen.insert(s.item.id).inserted {
            out.append(AgentHit(s.item))
            if out.count >= limit { break }
        }
        return out
    }

    func findItem(_ id: String) -> AgentHit? { ctx.findItem(id: id).map(AgentHit.init) }

    func executeItem(_ id: String, argument: String?) async -> AgentOp {
        let r = await ctx.executeItem(id: id, argument: argument)
        switch r {
        case let .hide(m):
            onLauncherHidden()
            return AgentOp(ok: true, message: m ?? "Done")
        case let .stay(m): return AgentOp(ok: true, message: m ?? "Done")
        case .pushView: return AgentOp(ok: true, message: "Opened in Glide")
        case .openSettings: return AgentOp(ok: true, message: "Opened in Glide Settings")
        case let .error(m): return AgentOp(ok: false, error: m)
        }
    }

    func workflowForItem(_ id: String, argument: String?, title: String?) -> AgentWorkflowStep? {
        AgentWorkflowPlanner.itemToWorkflowStep(id, argument: argument, data: ctx.store.data, title: title)
    }

    func listWorkflows() -> [Workflow] { ctx.store.data.workflows }

    func runWorkflow(_ id: String, input: String?) async -> (ok: Bool, result: String?, error: String?) {
        // The workflow runtime (phase 1) exposes workflows.run; older builds run the catalogue item instead.
        do {
            let r = try await ctx.callFeature("workflows", method: "run", args: ["id": .string(id), "input": input.map(JSONValue.string) ?? .null])
            let op = AgentOp.from(r, fallback: "Workflow finished")
            // workflows.run reports step failures in log[].error (integration: surface the real error)
            let stepError = r["log"]?.arrayValue?.first { $0["status"]?.stringValue == "error" }?["error"]?.stringValue
            return (op.ok, r["result"]?.stringValue ?? r["result"]?.description, op.ok ? op.error : (r["error"]?.stringValue ?? stepError ?? op.error))
        } catch FeatureError.unknownMethod {
            let op = await executeItem("workflow:\(id)", argument: input)
            return (op.ok, nil, op.error)
        } catch {
            return (false, nil, error.localizedDescription)
        }
    }

    // MARK: windows

    func windowAction(_ action: String, app: String?) async -> AgentOp {
        let perms = ctx.services.permissions.status()
        if !perms.accessibility && !ctx.services.isHeadless {
            return AgentOp(ok: false, error: "Glide needs Accessibility permission to move windows (System Settings → Privacy & Security → Accessibility).")
        }
        ctx.hideLauncher()
        onLauncherHidden()
        if let app {
            let r = ctx.services.workspace.launchApplication(app)
            if !r.ok { return AgentOp(ok: false, error: "Couldn't find an app named “\(app)”") }
            try? await Task.sleep(for: .milliseconds(ctx.services.isHeadless ? 10 : 450))
        }
        let r = await ctx.services.windows.apply(action)
        return r.ok ? AgentOp(ok: true, message: "Window moved") : AgentOp(ok: false, error: r.error ?? "Could not move the window")
    }

    func windowSnapshot() async -> JSONValue? {
        let r = await ctx.services.layouts.capture(includeHidden: false)
        guard r["ok"]?.boolValue != false, let w = r["windows"]?.arrayValue else { return nil }
        return .array(w)
    }

    func restoreWindows(_ snapshot: JSONValue) async -> AgentOp {
        let live = await ctx.services.layouts.capture(includeHidden: false)
        guard let liveWindows = live["windows"]?.arrayValue, let saved = snapshot.arrayValue else { return AgentOp(ok: false, error: "Could not read windows") }
        var used = Set<Int>()
        var moves: [JSONValue] = []
        for s in saved {
            let pid = s["pid"]?.intValue, title = s["title"]?.stringValue, order = s["order"]?.intValue
            let match = liveWindows.first { w in !used.contains(w["ref"]?.intValue ?? -1) && w["pid"]?.intValue == pid && w["title"]?.stringValue == title }
                ?? liveWindows.first { w in !used.contains(w["ref"]?.intValue ?? -1) && w["pid"]?.intValue == pid && w["order"]?.intValue == order }
            guard let m = match, let ref = m["ref"]?.intValue else { continue }
            used.insert(ref)
            if m["frame"] != s["frame"], let f = s["frame"] { moves.append(["ref": .int(Int64(ref)), "frame": f]) }
        }
        if moves.isEmpty { return AgentOp(ok: true, message: "Windows are already where they were") }
        ctx.hideLauncher()
        onLauncherHidden()
        let r = await ctx.services.layouts.move(.array(moves))
        return r["ok"]?.boolValue == false ? AgentOp(ok: false, error: r["error"]?.stringValue ?? "Could not move the windows back")
            : AgentOp(ok: true, message: "Moved \(AgentText.plural(moves.count, "window")) back")
    }

    // MARK: opening things

    func openURL(_ url: String) -> AgentOp {
        guard let u = URL(string: url) else { return AgentOp(ok: false, error: "Not a valid URL") }
        let r = ctx.services.workspace.open(url: u)
        return r.ok ? AgentOp(ok: true, message: "Opened \(url)") : AgentOp(ok: false, error: r.error)
    }

    func openApp(_ name: String) async -> AgentOp {
        ctx.hideLauncher()
        onLauncherHidden()
        let r = ctx.services.workspace.launchApplication(name)
        return r.ok ? AgentOp(ok: true, message: "Opened \(name)") : AgentOp(ok: false, error: "Couldn't find an app named “\(name)”")
    }

    func openFile(_ path: String) -> AgentOp {
        let full = (path as NSString).expandingTildeInPath
        guard FileManager.default.fileExists(atPath: full) else { return AgentOp(ok: false, error: "No file at \(path)") }
        let r = ctx.services.workspace.open(path: full)
        return r.ok ? AgentOp(ok: true, message: "Opened \(path)") : AgentOp(ok: false, error: r.error)
    }

    func clipboardText() -> String { ctx.services.pasteboard.string() ?? "" }

    func copyText(_ text: String) -> AgentOp {
        ctx.services.pasteboard.setString(text, html: nil, transient: false)
        return AgentOp(ok: true, message: "Copied to the clipboard")
    }

    func selectedText() async -> (text: String?, error: String?) {
        let r = await ctx.services.selection.selectedText()
        if r.reason == "no-accessibility" { return (nil, "Glide needs Accessibility permission to read the selection.") }
        return (r.text, nil)
    }

    func calendarEvents(from: Date, to: Date) async -> (events: JSONValue?, error: String?) {
        let st = ctx.services.permissions.status().calendar
        if st != "authorized" { return (nil, "Glide doesn't have calendar access. Grant it in Settings → Calendar (My Schedule).") }
        do { return (try await ctx.services.eventKit.calendarEvents(from: from, to: to), nil) } catch { return (nil, error.localizedDescription) }
    }

    // MARK: store

    func snippets() -> [Snippet] { ctx.store.data.snippets }
    func saveSnippet(_ s: Snippet) { ctx.store.saveSnippet(s); ctx.refreshCatalogue() }
    func deleteSnippet(_ id: String) -> Bool {
        guard ctx.store.data.snippets.contains(where: { $0.id == id }) else { return false }
        ctx.store.deleteSnippet(id)
        ctx.refreshCatalogue()
        return true
    }
    func saveQuicklink(_ q: Quicklink) { ctx.store.saveQuicklink(q); ctx.refreshCatalogue() }
    func deleteQuicklink(_ id: String) -> Bool {
        guard ctx.store.data.quicklinks.contains(where: { $0.id == id }) else { return false }
        ctx.store.deleteQuicklink(id)
        ctx.refreshCatalogue()
        return true
    }

    // MARK: processes & shortcuts

    func listProcesses() async throws -> [AgentProcessRow] {
        let r = try await call("processes", "list", ["limit": .int(Int64(Int32.max))]) // integration: every process, not the top 50 (kill_process checks the PID)
        let list = r["processes"]?.arrayValue ?? r.arrayValue ?? []
        return list.map { p in
            AgentProcessRow(pid: p["pid"]?.intValue ?? 0, name: p["name"]?.stringValue ?? "", cpu: p["cpu"]?.doubleValue ?? 0,
                            rssKb: p["rssKb"]?.doubleValue ?? 0, user: p["user"]?.stringValue ?? "", command: p["command"]?.stringValue ?? p["name"]?.stringValue ?? "")
        }
    }

    func killProcess(pid: Int, force: Bool, expectedCommand: String) async -> AgentOp {
        if ctx.services.isHeadless {
            ctx.recordEffect(kind: "agent.kill_process", detail: ["pid": .int(Int64(pid)), "force": .bool(force)])
            return AgentOp(ok: true, message: "Headless: would \(force ? "force quit" : "quit") PID \(pid)")
        }
        do {
            let r = try await call("processes", "signal", ["pid": .int(Int64(pid)), "signal": .string(force ? "SIGKILL" : "SIGTERM"), "confirmed": true, "expectedCommand": .string(expectedCommand)])
            return AgentOp.from(r, fallback: "Signal sent")
        } catch { return AgentOp(ok: false, error: error.localizedDescription) }
    }

    func runShortcut(_ name: String, input: String?) async -> (ok: Bool, output: String?, error: String?) {
        if ctx.services.isHeadless {
            ctx.recordEffect(kind: "agent.run_shortcut", detail: ["name": .string(name), "input": input == nil ? .null : "(text)"])
            return (true, nil, nil)
        }
        let dir = ctx.dataDirectory().appendingPathComponent("shortcut-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let out = dir.appendingPathComponent("out.txt").path
        var cmd = "/usr/bin/shortcuts run \(Self.shq(name)) --output-path \(Self.shq(out))"
        if let input {
            let inFile = dir.appendingPathComponent("in.txt")
            try? Data(input.utf8).write(to: inFile)
            cmd += " --input-path \(Self.shq(inFile.path))"
        }
        do {
            let r = try await ctx.services.scripts.runShell(cmd, shell: "/bin/zsh", timeout: 120)
            if r.status != 0 {
                let err = r.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                return (false, nil, err.range(of: "couldn.t find|not found", options: [.regularExpression, .caseInsensitive]) != nil ? "No shortcut named “\(name)”" : (err.isEmpty ? "The shortcut failed" : err))
            }
            return (true, (try? String(contentsOfFile: out, encoding: .utf8)) ?? "", nil)
        } catch { return (false, nil, error.localizedDescription) }
    }

    nonisolated static func shq(_ s: String) -> String { "'\(s.replacingOccurrences(of: "'", with: "'\\''"))'" }

    // MARK: appearance (settings.theme + the "appearance" bag)

    func appearance() -> AgentAppearance {
        let s = ctx.store.settings
        let a = AppearanceSettings(bag: s.features[AppearanceSettings.featureId] ?? [:])
        let mode = ["dark", "light"].contains(s.theme) ? s.theme : "system"
        return AgentAppearance(mode: mode, darkTheme: a.darkTheme, lightTheme: a.lightTheme,
                               presets: Themes.presets.map { ($0.id, $0.name, $0.scheme == .light ? "light" : "dark") })
    }

    func setAppearance(mode: String?, preset: String?) -> AgentOp {
        var patch: [String: JSONValue] = [:]
        var newMode = mode
        if let preset {
            guard let p = Themes.preset(preset) else { return AgentOp(ok: false, error: "Unknown theme \(preset)") }
            let light = p.scheme == .light
            patch[light ? "lightTheme" : "darkTheme"] = .string(p.id)
            if newMode == nil { newMode = light ? "light" : "dark" }
        }
        ctx.store.mutate { d in
            if !patch.isEmpty { d.settings.features[AppearanceSettings.featureId, default: [:]].merge(patch) { $1 } }
            if let m = newMode { d.settings.theme = m }
        }
        return AgentOp(ok: true, message: "Theme changed")
    }

    func restoreAppearance(_ prev: AgentAppearance) -> AgentOp {
        ctx.store.mutate { d in
            d.settings.features[AppearanceSettings.featureId, default: [:]].merge(["darkTheme": .string(prev.darkTheme), "lightTheme": .string(prev.lightTheme)]) { $1 }
            d.settings.theme = prev.mode
        }
        return AgentOp(ok: true, message: "Theme restored")
    }
}
