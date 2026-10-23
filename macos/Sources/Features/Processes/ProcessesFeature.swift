import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// Process & Port Manager (port of src/main/features/processes): "Kill Process" (live libproc list sorted by
/// CPU), "Kill Port" and "port 3000" in root search (libproc socket lookup, no lsof). Every signal is confirmed;
/// pid 0/1 are never signalled; the pid's executable is re-checked right before signalling (pid reuse).
/// Headless runs record `[headless] process-signal {…}` instead of signalling.
@MainActor public final class ProcessesFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "processes"
    public let title = "Processes"
    private weak var context: FeatureContext?
    private weak var host: (any LauncherViewHost)?
    let sampler = ProcessSampler()
    let nav = SysListNav()
    let model = ProcessesModel()
    /// Test hook: replaces kill(2) (headless default records instead).
    var signaler: ((Int32, Int32) -> Int32)?

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        if context.services.isHeadless && signaler == nil {
            signaler = { pid, sig in
                HeadlessRecord.line("process-signal", ["pid": .int(Int64(pid)), "signal": .string(sig == SIGKILL ? "SIGKILL" : "SIGTERM")])
                return 0
            }
        }
    }

    public var dynamicItemsBudget: Duration { .milliseconds(150) }

    static func item(_ id: String, _ title: String, _ subtitle: String, _ symbol: String, _ kw: [String], argument: Bool = false) -> SearchItem {
        SearchItem(id: "processes:\(id)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol), keywords: kw, acceptsArgument: argument ? true : nil,
                   feature: "processes", data: ["action": .string(id)], kindLabel: "Command")
    }

    public func items() -> [SearchItem] {
        [Self.item("list", "Kill Process", "Processes sorted by CPU · quit or force quit", "xmark.octagon",
                   ["process", "processes", "kill", "quit", "force quit", "task manager", "cpu", "memory", "pid"]),
         Self.item("ports", "Kill Port", "Find what listens on a TCP port and stop it", "powerplug", ["port", "ports", "listen", "lsof", "kill port", "server", "localhost"], argument: true)]
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        guard let port = ProcessPolicy.parsePortQuery(query.text) else { return [] }
        let found = await Task.detached(priority: .userInitiated) { ProcessSampler.listeners(port: port) }.value
        if found.isEmpty {
            return [ScoredItem(item: SearchItem(id: "processes:port:\(port)", kind: .calculator, title: "Nothing is listening on port \(port)", subtitle: "TCP · LISTEN",
                                                icon: .symbol("powerplug"), feature: id, data: ["action": "portView", "port": .int(Int64(port)), "noUsage": true], kindLabel: "Port"),
                               score: 997, matchScore: 997, matchKind: .exact)]
        }
        return found.prefix(3).enumerated().map { i, l in
            ScoredItem(item: SearchItem(id: "processes:port:\(port):\(l.pid)", kind: .calculator, title: "Port \(port) — \(l.command) (PID \(l.pid))",
                                        subtitle: "\(l.address) · \(l.user) · ⏎ show · ⌘⏎ kill…", icon: .symbol("powerplug.fill"), feature: id,
                                        data: ["action": "portView", "port": .int(Int64(port)), "pid": .int(Int64(l.pid)), "noUsage": true], kindLabel: "Port"),
                       score: 997 - Double(i), matchScore: 997, matchKind: .exact)
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "portView": return [ItemAction(id: "portView", title: "Show Port", shortcut: "↩", icon: "powerplug"),
                                 ItemAction(id: "portKill", title: "Kill Listener…", shortcut: "⌘↩", icon: "xmark.octagon", destructive: true)]
        case "ports": return [ItemAction(id: "ports", title: "Show Listening Ports", shortcut: "↩", icon: "powerplug")]
        default: return [ItemAction(id: "list", title: "Show Processes", shortcut: "↩", icon: "list.bullet"),
                         ItemAction(id: "activity", title: "Open Activity Monitor", shortcut: "⌘↩", icon: "waveform.path.ecg")]
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let d = scored.item.data ?? [:]
        switch action {
        case "list":
            nav.reset()
            await refreshProcesses(prime: true)
            return .pushView("processes.list")
        case "activity":
            let r = context?.services.workspace.launchApplication("com.apple.ActivityMonitor") ?? .failure("Not ready")
            return r.ok ? .hide() : .error("Could not open Activity Monitor")
        case "ports":
            nav.reset()
            let port = ProcessPolicy.parsePortQuery("port \(scored.argument ?? "")")
            await refreshPorts(port)
            return .pushView("processes.ports", payload: port.map { ["port": .int(Int64($0))] } ?? .null)
        case "portView", "portKill":
            nav.reset()
            let port = d["port"]?.intValue
            await refreshPorts(port)
            if action == "portKill", let pid = d["pid"]?.intValue {
                let r = await signal(pid: Int32(pid), force: false, expected: nil)
                return r
            }
            return .pushView("processes.ports", payload: port.map { ["port": .int(Int64($0))] } ?? .null)
        default: return .error("Unknown action \(action)")
        }
    }

    // MARK: data

    func refreshProcesses(prime: Bool) async {
        let s = sampler
        if prime && !s.primed {
            _ = await Task.detached { s.sample() }.value
            try? await Task.sleep(for: .milliseconds(250))
        }
        model.processes = ProcessPolicy.sortByCpu(await Task.detached { s.sample() }.value)
        model.at = Date()
    }

    func refreshPorts(_ port: Int?) async {
        model.port = port
        model.listeners = await Task.detached { ProcessSampler.listeners(port: port) }.value
    }

    var selfPids: [Int32] { [getpid()] }

    /// Confirm, re-check the pid still runs the same executable, then signal.
    func signal(pid: Int32, force: Bool, expected: String?) async -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        if ProcessPolicy.unkillable(pid) { return .error(pid == 0 ? "kernel_task cannot be killed" : "launchd (PID 1) cannot be killed from Glide") }
        guard let command = LibProc.path(pid) ?? LibProc.name(pid) else { return .error("No process with PID \(pid) (it may have already quit)") }
        if let expected, expected != command { return .error("PID \(pid) is now a different process; refresh and try again") }
        let name = ProcessPolicy.processName(command)
        var message = force ? "Force quitting \(name) may lose unsaved work." : "Quit \(name) (PID \(pid))?"
        if case let .warn(reason) = ProcessPolicy.killRisk(pid: pid, name: name, command: command, selfPids: selfPids) { message = reason + "\n\n" + message }
        let verb = force ? "Force Quit" : "Quit"
        guard await ctx.services.confirmation.confirm(title: "\(verb) \(name)?", message: message, confirmButton: verb) else { return .stay(message: "Cancelled") }
        // Re-check after the (possibly long) confirmation.
        guard (LibProc.path(pid) ?? LibProc.name(pid)) == command else { return .error("\(name) already quit") }
        let sig = force ? SIGKILL : SIGTERM
        let rc = (signaler ?? { Darwin.kill($0, $1) })(pid, sig)
        if rc != 0 {
            switch errno {
            case EPERM: return .error("Permission denied: \(name) belongs to another user (Glide never asks for admin rights)")
            case ESRCH: return .error("\(name) already quit")
            default: return .error(String(cString: strerror(errno)))
            }
        }
        ctx.log("\(force ? "SIGKILL" : "SIGTERM") sent to \(pid) (\(name))")
        return .stay(message: "\(force ? "Force quit" : "Quit") \(name) (PID \(pid))")
    }

    // MARK: rows

    func processRows(query: String) -> [ScoredItem] {
        sysFilter(model.processes, query: query, text: \.name, keywords: { [$0.command, String($0.pid)] }).map { p, r in
            .row(SearchItem(id: "pid:\(p.pid)", kind: .command, title: p.name, subtitle: "PID \(p.pid) · \(p.user)",
                            icon: p.appPath.map(ItemIcon.app) ?? .symbol("gearshape.2"), path: p.command, feature: id,
                            data: ["pid": .int(Int64(p.pid)), "command": .string(p.command)],
                            kindLabel: String(format: "%.1f%% · %@", p.cpu, ProcessPolicy.formatKb(p.rssKb))), ranges: r)
        }
    }

    func portRows(query: String) -> [ScoredItem] {
        sysFilter(model.listeners, query: query, text: { "\($0.port) \($0.command)" }).map { l, _ in
            .row(SearchItem(id: "listen:\(l.pid):\(l.port)", kind: .command, title: "\(l.port) — \(l.command)", subtitle: "PID \(l.pid) · \(l.address) · \(l.user)",
                            icon: .symbol("powerplug.fill"), feature: id, data: ["pid": .int(Int64(l.pid))], kindLabel: l.proto))
        }
    }

    func rows(_ view: String) -> [ScoredItem] {
        let q = n3Host(host)?.query ?? ""
        return view == "list" ? processRows(query: q) : portRows(query: q)
    }

    func kill(view: String, index: Int, force: Bool) {
        let list = rows(view)
        guard index < list.count, let pid = list[index].item.data?["pid"]?.intValue else { return }
        let expected = list[index].item.data?["command"]?.stringValue
        Task { @MainActor in
            let r = await signal(pid: Int32(pid), force: force, expected: expected)
            switch r {
            case let .error(m): context?.toast(m, style: .error)
            case let .stay(m): context?.toast(m ?? "Done", style: .success)
            default: break
            }
            if view == "list" { await refreshProcesses(prime: false) } else { await refreshPorts(model.port) }
        }
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        guard view.feature == id else { return false }
        let list = rows(view.name)
        nav.sync(query: n3Host(host)?.query ?? "", count: list.count)
        switch nav.apply(command, count: list.count) {
        case .moved: return true
        case .activate: kill(view: view.name, index: nav.index, force: false); return true
        case .secondary, .delete: kill(view: view.name, index: nav.index, force: true); return true
        case .copy:
            if nav.index < list.count, let pid = list[nav.index].item.data?["pid"]?.intValue {
                context?.services.pasteboard.setString(String(pid), html: nil, transient: false)
                context?.toast("Copied PID \(pid)", style: .success)
            }
            return true
        case .actions: return true
        case nil: return false
        }
    }

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        self.host = host
        guard vid.name == "list" || vid.name == "ports" else { return nil }
        let list = vid.name == "list" ? processRows(query: host.query) : portRows(query: host.query)
        nav.sync(query: host.query, count: list.count)
        let header = vid.name == "list" ? "Processes by CPU" : (model.port.map { "Listening on port \($0)" } ?? "Listening TCP ports")
        return AnyView(SysRowsView(header: header, rows: list, selected: nav.index, emptySymbol: "powerplug", emptyTitle: vid.name == "list" ? "No matching processes" : "Nothing is listening",
                                   emptySubtitle: nil) { [weak self] i in self?.nav.index = i }
            .task(id: vid.rawValue) { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    guard let self else { return }
                    if vid.name == "list" { await self.refreshProcesses(prime: false) } else { await self.refreshPorts(self.model.port) }
                }
            }
            .onAppear {
                host.setPlaceholder(vid.name == "list" ? "Filter processes…" : "Filter ports…")
                host.setFooter(primary: "Quit (⌘↩ Force Quit)", hasActions: false)
            })
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "list":
            await refreshProcesses(prime: true)
            return ["processes": .array(model.processes.prefix(args["limit"]?.intValue ?? (args.isNull ? 50 : Int.max)).map { p in
                ["pid": .int(Int64(p.pid)), "ppid": .int(Int64(p.ppid)), "cpu": .double(p.cpu), "rssKb": .int(Int64(p.rssKb)), "user": .string(p.user),
                 "command": .string(p.command), "name": .string(p.name)]
            }), "count": .int(Int64(model.processes.count)), "selfPids": .array(selfPids.map { .int(Int64($0)) })]
        case "listeners":
            let port = args["port"]?.intValue ?? args.intValue
            return .array(ProcessSampler.listeners(port: port).map { ["pid": .int(Int64($0.pid)), "port": .int(Int64($0.port)), "address": .string($0.address), "command": .string($0.command), "user": .string($0.user)] })
        case "signal":
            guard let pid = args["pid"]?.intValue else { throw FeatureError.invalidArguments("pid required") }
            switch await signal(pid: Int32(pid), force: args["signal"]?.stringValue == "SIGKILL", expected: args["expectedCommand"]?.stringValue) {
            case let .error(m): return ["ok": false, "error": .string(m)]
            case let .stay(m): return ["ok": true, "message": m.map(JSONValue.string) ?? .null]
            default: return ["ok": true]
            }
        case "risk":
            let pid = Int32(args["pid"]?.intValue ?? args.intValue ?? -1)
            let cmd = LibProc.path(pid) ?? LibProc.name(pid) ?? ""
            switch ProcessPolicy.killRisk(pid: pid, name: ProcessPolicy.processName(cmd), command: cmd, selfPids: selfPids) {
            case .ok: return ["level": "ok"]
            case let .warn(r): return ["level": "warn", "reason": .string(r)]
            }
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

@MainActor @Observable final class ProcessesModel {
    var processes: [ProcInfo] = []
    var listeners: [PortListener] = []
    var port: Int?
    var at = Date.distantPast
}
