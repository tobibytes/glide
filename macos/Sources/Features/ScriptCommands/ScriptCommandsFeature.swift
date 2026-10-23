import AppKit
import Foundation
import GlideCore
import GlideUI
import Observation
import SwiftUI

/// Raycast-compatible Script Commands: a folder of scripts with `@raycast.*` metadata, run via Process.
/// Feature id "scripts", settings bag `{directory}` (default "~/Glide Scripts") and item ids `scripts:<file>`
/// match the Electron app. Modes: fullOutput (streamed output view), compact (last line as a toast),
/// silent (hide + notification), inline (first line shown as the subtitle, refreshed every refreshTime).
@MainActor public final class ScriptCommandsFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "scripts"
    public let title = "Script Commands"
    static let defaults: [String: JSONValue] = ["directory": "~/Glide Scripts"]
    static let timeout: TimeInterval = 60

    struct Script: Equatable {
        var id: String
        var file: String
        var path: URL
        var meta: ScriptMeta
        var valid: Bool { meta.errors.isEmpty && meta.title != nil && meta.mode != nil }
        static func == (a: Script, b: Script) -> Bool { a.id == b.id && a.path == b.path && a.meta.title == b.meta.title && a.meta.mode == b.meta.mode && a.meta.errors == b.meta.errors }
    }

    private(set) weak var context: FeatureContext?
    private(set) var scripts: [Script] = []
    private var inline: [String: (line: String, error: Bool)] = [:]
    private var inlineTasks: [String: Task<Void, Never>] = [:]
    private var outputs: [String: ScriptOutputModel] = [:]
    private var forms: [String: FieldsFormModel] = [:]
    private var tokenStack: [String] = []
    private var seq = 0
    private var watcher: DispatchSourceFileSystemObject?
    private var watchedFD: Int32 = -1
    private var watchedDir = ""
    private var loginPath: String?
    private(set) var notifications: [JSONValue] = []

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        scan()
        watch()
        if !context.services.isHeadless {
            Task.detached { [weak self] in
                let p = await ScriptCommandsFeature.resolveLoginPath()
                await MainActor.run { self?.loginPath = p }
            }
        }
    }

    public func stop() async {
        watcher?.cancel()
        for t in inlineTasks.values { t.cancel() }
        for o in outputs.values { o.run?.stop() }
    }

    var directory: URL {
        let raw = context?.settings(defaults: Self.defaults)["directory"]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
        return URL(fileURLWithPath: ((raw.isEmpty ? "~/Glide Scripts" : raw) as NSString).expandingTildeInPath, isDirectory: true)
    }

    // MARK: scanning

    static let skip = try! NSRegularExpression(pattern: #"^\.|\.(md|txt|json|png|jpe?g|gif|svg|icns|template)$"#, options: .caseInsensitive)

    static func scan(_ dir: URL) -> [Script] {
        let fm = FileManager.default
        let names = ((try? fm.contentsOfDirectory(atPath: dir.path)) ?? []).filter { skip.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) == nil }
        var out: [Script] = []
        for name in names.sorted(by: { $0.localizedCompare($1) == .orderedAscending }) {
            let url = dir.appendingPathComponent(name)
            guard let attrs = try? fm.attributesOfItem(atPath: url.path), attrs[.type] as? FileAttributeType == .typeRegular,
                  let size = attrs[.size] as? Int, size <= 512 * 1024 else { continue }
            guard let h = FileHandle(forReadingAtPath: url.path) else { continue }
            let head = (try? h.read(upToCount: 16 * 1024)) ?? Data()
            try? h.close()
            out.append(Script(id: "scripts:\(name)", file: name, path: url, meta: ScriptParser.parse(String(decoding: head, as: UTF8.self))))
        }
        return out
    }

    func scan() {
        let next = Self.scan(directory)
        let changed = next != scripts
        scripts = next
        scheduleInline()
        if changed { context?.refreshCatalogue() }
    }

    private func watch() {
        let dir = directory.path
        if dir == watchedDir, watcher != nil { return }
        watcher?.cancel()
        watcher = nil
        watchedDir = dir
        let fd = open(dir, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete, .extend], queue: .main)
        src.setEventHandler { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MainActor.assumeIsolated { self?.scan() } }
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        watcher = src
    }

    // MARK: catalogue

    func iconFor(_ s: Script) -> ItemIcon {
        guard let i = s.meta.icon else { return .symbol("terminal") }
        if i.hasPrefix("http://") || i.hasPrefix("https://") { return ItemIcon(kind: "url", value: i) }
        if i.range(of: #"\.(png|jpe?g|icns|svg|gif)$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return .file(i.hasPrefix("/") ? i : s.path.deletingLastPathComponent().appendingPathComponent(i).path)
        }
        return .emoji(i)
    }

    public func items() -> [SearchItem] {
        var out = scripts.filter(\.valid).map { s in
            let live = s.meta.mode == "inline" ? inline[s.id] : nil
            return SearchItem(id: s.id, kind: .command, title: s.meta.title ?? s.file, subtitle: live?.line ?? s.meta.packageName ?? s.meta.description, icon: iconFor(s),
                              keywords: [s.file, s.meta.packageName ?? "", s.meta.description ?? "", "script"].filter { !$0.isEmpty },
                              acceptsArgument: !s.meta.arguments.isEmpty, feature: id, data: ["action": "run", "scriptId": .string(s.id)], kindLabel: "Script")
        }
        func cmd(_ a: String, _ title: String, _ symbol: String, _ kw: [String]) -> SearchItem {
            SearchItem(id: "scripts:cmd:\(a)", kind: .command, title: title, subtitle: "Script Commands", icon: .symbol(symbol), keywords: kw, feature: id,
                       data: ["action": .string(a)], kindLabel: "Command")
        }
        out += [cmd("create", "Create Script Command", "doc.badge.plus", ["new", "script", "raycast"]),
                cmd("openFolder", "Open Script Commands Folder", "folder", ["scripts", "folder", "directory"]),
                cmd("reload", "Reload Script Commands", "arrow.clockwise", ["scripts", "refresh", "rescan"])]
        return out
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "create": return [ItemAction(id: "create", title: "Create Script", shortcut: "↩", icon: "doc.badge.plus")]
        case "openFolder": return [ItemAction(id: "openFolder", title: "Open Folder", shortcut: "↩", icon: "folder")]
        case "reload": return [ItemAction(id: "reload", title: "Reload", shortcut: "↩", icon: "arrow.clockwise")]
        default:
            return [ItemAction(id: "run", title: "Run Script", shortcut: "↩", icon: "play"),
                    ItemAction(id: "reveal", title: "Show in Finder", shortcut: "⌘↩", icon: "folder"),
                    ItemAction(id: "edit", title: "Open in Editor", shortcut: "⌘E", icon: "pencil"),
                    ItemAction(id: "copyPath", title: "Copy Path", shortcut: "⇧⌘C", icon: "doc.on.doc"),
                    ItemAction(id: "settings", title: "Manage Script Commands", shortcut: "⌘,", icon: "gearshape")]
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        switch action {
        case "create": return createScript()
        case "openFolder":
            let dir = ensureFolder()
            let r = ctx.services.workspace.open(path: dir.path)
            return r.ok ? .hide() : .error(r.error ?? "Could not open")
        case "reload":
            watch()
            scan()
            return .stay(message: "\(scripts.filter(\.valid).count) script commands")
        case "settings": return .openSettings(page: id)
        default: break
        }
        guard let s = scripts.first(where: { $0.id == scored.item.data?["scriptId"]?.stringValue }) else { return .error("Script not found (was it moved?)") }
        switch action {
        case "edit":
            let r = ctx.services.workspace.open(path: s.path.path)
            return r.ok ? .hide() : .error(r.error ?? "Could not open")
        case "reveal":
            ctx.services.workspace.reveal(path: s.path.path)
            return .hide()
        case "copyPath":
            ctx.services.pasteboard.setString(s.path.path, html: nil, transient: false)
            return .stay(message: "Path copied")
        default:
            return await runScript(s, args: ScriptParser.splitArguments(scored.argument ?? "", count: s.meta.arguments.count))
        }
    }

    // MARK: folder

    @discardableResult
    func ensureFolder() -> URL {
        let dir = directory
        let fm = FileManager.default
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            for ex in ScriptExamples.all { try? ScriptExamples.write(ex.source, to: dir.appendingPathComponent(ex.file)) }
        }
        watch()
        scan()
        return dir
    }

    private func createScript() -> ActionResult {
        let dir = ensureFolder()
        var n = 1
        var file = dir.appendingPathComponent("new-script.sh")
        while FileManager.default.fileExists(atPath: file.path) {
            n += 1
            file = dir.appendingPathComponent("new-script-\(n).sh")
        }
        do { try ScriptExamples.write(ScriptExamples.template(n == 1 ? "New Script" : "New Script \(n)"), to: file) } catch { return .error(error.localizedDescription) }
        _ = context?.services.workspace.open(path: file.path)
        scan()
        return .hide(message: "Created \(file.lastPathComponent)")
    }

    // MARK: running

    static func resolveLoginPath() async -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "printf %s \"$PATH\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        var path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        if (try? p.run()) != nil {
            let deadline = Date().addingTimeInterval(5)
            while p.isRunning && Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
            if p.isRunning { p.terminate() } else {
                let s = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                if !s.isEmpty { path = s }
            }
        }
        return extendPath(path)
    }

    static func extendPath(_ path: String) -> String {
        var parts = path.split(separator: ":").map(String.init).filter { !$0.isEmpty }
        for e in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] where !parts.contains(e) { parts.append(e) }
        return parts.joined(separator: ":")
    }

    private func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = loginPath ?? Self.extendPath(env["PATH"] ?? "")
        env["GLIDE"] = "1"
        env["RAYCAST"] = "1"
        for k in env.keys where k.hasPrefix("GLIDE_") { env[k] = nil }
        return env
    }

    func start(_ s: Script, args: [String], onChunk: (@Sendable (String, String) -> Void)? = nil) -> ScriptRun {
        let encoded = args.enumerated().map { i, a in
            i < s.meta.arguments.count && s.meta.arguments[i].percentEncoded ? (a.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? a) : a
        }
        let run = ScriptRun()
        run.onChunk = onChunk
        let cwd = s.meta.currentDirectoryPath.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, relativeTo: s.path.deletingLastPathComponent()) }
        run.start(file: s.path, args: encoded, cwd: cwd, env: environment(), timeout: Self.timeout)
        return run
    }

    private static func failure(_ o: ScriptRun.Outcome) -> String {
        if let e = o.error { return e == "Timed out" ? "Timed out after \(Int(timeout)) s" : e }
        let l = ScriptParser.lastLine(o.stderr)
        return l.isEmpty ? (ScriptParser.lastLine(o.stdout).isEmpty ? "Exited with code \(o.code ?? -1)" : ScriptParser.lastLine(o.stdout)) : l
    }

    func runScript(_ s: Script, args: [String]) async -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        if let missing = s.meta.arguments.indices.first(where: { !s.meta.arguments[$0].optional && (args.indices.contains($0) ? args[$0] : "").trimmingCharacters(in: .whitespaces).isEmpty }) {
            _ = missing
            return pushArguments(s, values: args)
        }
        if s.meta.needsConfirmation {
            guard await ctx.services.confirmation.confirm(title: "Run “\(s.meta.title ?? s.file)”?", message: s.path.path, confirmButton: "Run") else { return .hide() }
        }
        switch s.meta.mode {
        case "fullOutput":
            let model = ScriptOutputModel(token: nextToken(), script: s)
            model.owner = self
            outputs[model.token] = model
            model.begin(args: args)
            tokenStack.append(model.token)
            Task { @MainActor in
                LauncherHosts.current?.setPlaceholder(s.meta.title ?? s.file)
                LauncherHosts.current?.setFooter(primary: "Copy Output", hasActions: true)
            }
            return .pushView(ViewID(feature: id, name: "output~\(model.token)"), payload: .null)
        case "silent":
            ctx.hideLauncher()
            let run = start(s, args: args)
            let title = s.meta.title ?? s.file
            Task { [weak self] in
                let o = await run.wait()
                if o.ok { let l = ScriptParser.lastLine(o.stdout); if !l.isEmpty { self?.notify(title, l) } } else { self?.notify("\(title) failed", Self.failure(o)) }
            }
            return .hide()
        case "inline":
            await runInline(s)
            let cur = inline[s.id]
            return cur?.error == true ? .error(String(cur?.line.dropFirst(2) ?? "")) : .stay(message: cur?.line ?? "Refreshed")
        default:
            let o = await start(s, args: args).wait()
            return o.ok ? .hide(message: ScriptParser.lastLine(o.stdout).isEmpty ? "Done" : ScriptParser.lastLine(o.stdout)) : .error(Self.failure(o))
        }
    }

    private func notify(_ title: String, _ body: String) {
        notifications.append(["title": .string(title), "body": .string(body)])
        context?.services.notifications.notify(title: title, body: body)
    }

    private func runInline(_ s: Script) async {
        let o = await start(s, args: []).wait()
        inline[s.id] = o.ok ? ((ScriptParser.firstLine(o.stdout).isEmpty ? "(no output)" : ScriptParser.firstLine(o.stdout)), false) : ("⚠ \(Self.failure(o))", true)
        context?.refreshCatalogue()
    }

    private func scheduleInline() {
        for t in inlineTasks.values { t.cancel() }
        inlineTasks = [:]
        var live = Set<String>()
        for (i, s) in scripts.filter({ $0.valid && $0.meta.mode == "inline" && $0.meta.arguments.allSatisfy(\.optional) }).enumerated() {
            live.insert(s.id)
            let first = inline[s.id] == nil
            let every = s.meta.refreshTimeMs
            inlineTasks[s.id] = Task { [weak self] in
                if first {
                    try? await Task.sleep(for: .milliseconds(300 + i * 250))
                    guard !Task.isCancelled else { return }
                    await self?.runInline(s)
                }
                guard let every else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(every))
                    guard !Task.isCancelled else { return }
                    await self?.runInline(s)
                }
            }
        }
        for k in inline.keys where !live.contains(k) { inline[k] = nil }
    }

    private func nextToken() -> String { seq += 1; return "\(seq)" }

    private func pushArguments(_ s: Script, values: [String]) -> ActionResult {
        let fields = s.meta.arguments.enumerated().map { i, a in
            FieldsFormModel.Field(id: "arg\(i)", title: a.placeholder, type: a.type == "password" ? "password" : a.type == "dropdown" ? "dropdown" : "textfield",
                                  required: !a.optional, placeholder: a.placeholder, options: a.data.map { ExtOption(value: $0.value, title: $0.title) })
        }
        var initial: [String: JSONValue] = [:]
        for (i, v) in values.enumerated() where i < fields.count { initial["arg\(i)"] = .string(v) }
        let model = FieldsFormModel(token: nextToken(), title: s.meta.title ?? s.file, submitTitle: "Run Script", fields: fields, values: initial)
        model.onSubmit = { [weak self, weak model] values in
            guard let self, let model else { return nil }
            let args = fields.indices.map { values["arg\($0)"]?.stringValue ?? "" }
            self.popToken(model.token)
            let r = await self.runScript(s, args: args)
            switch r {
            case let .pushView(v, p): LauncherHosts.current?.push(v, payload: p)
            case let .error(m): LauncherHosts.current?.toast(m, style: .error)
            case let .hide(m):
                if let m { LauncherHosts.current?.toast(m, style: .success) }
                self.context?.hideLauncher()
            case let .stay(m): if let m { LauncherHosts.current?.toast(m, style: .info) }
            default: break
            }
            return nil
        }
        forms[model.token] = model
        tokenStack.append(model.token)
        Task { @MainActor in
            LauncherHosts.current?.setPlaceholder(model.title)
            LauncherHosts.current?.setFooter(primary: model.submitTitle, hasActions: false)
        }
        return .pushView(ViewID(feature: id, name: "args~\(model.token)"), payload: .null)
    }

    private func popToken(_ t: String) {
        let wasTop = tokenStack.last == t
        didPop(t)
        if wasTop { LauncherHosts.current?.pop() }
    }

    private func didPop(_ t: String) {
        tokenStack.removeAll { $0 == t }
        forms[t] = nil
        if let o = outputs.removeValue(forKey: t), o.running { o.run?.stop() }
    }

    func rerun(_ model: ScriptOutputModel) { model.begin(args: model.lastArgs) }

    // MARK: FeatureUI

    private func token(_ v: ViewID) -> String? { v.name.split(separator: "~", maxSplits: 1).dropFirst().first.map(String.init) }

    public func launcherView(_ view: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard let t = token(view) else { return nil }
        if let o = outputs[t] {
            host.setPlaceholder(o.script.meta.title ?? o.script.file)
            host.setFooter(primary: "Copy Output", hasActions: true)
            return AnyView(ScriptOutputView(model: o))
        }
        if let f = forms[t] {
            host.setPlaceholder(f.title)
            host.setFooter(primary: f.submitTitle, hasActions: false)
            return AnyView(FieldsFormView(model: f))
        }
        return AnyView(EmptyState(symbol: "terminal", title: "This view has closed"))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        guard let t = token(view) else { return false }
        if let f = forms[t] { return f.handleKey(key) }
        if let o = outputs[t] { return o.handleKey(key) }
        return false
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        guard let t = token(view) else { return false }
        if command == .pop { didPop(t); return false }
        if let o = outputs[t] { return o.handle(command) }
        if let f = forms[t] {
            if case let .move(d) = command, !f.fields.isEmpty { f.focused = min(f.fields.count - 1, max(0, f.focused + d)); return true }
            if case .activate = command { return f.handleKey(VimKey("Enter")) }
            return command.isNavigation
        }
        return false
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Script Commands", symbol: "terminal", order: 61) { [weak self] in AnyView(ScriptsSettingsView(feature: self)) }
    }

    // MARK: invoke

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "state":
            return ["directory": .string(directory.path), "exists": .bool(FileManager.default.fileExists(atPath: directory.path)),
                    "scripts": .array(scripts.map { ["id": .string($0.id), "title": $0.meta.title.map(JSONValue.string) ?? .null, "mode": $0.meta.mode.map(JSONValue.string) ?? .null,
                                                     "errors": .array($0.meta.errors.map(JSONValue.string)), "inline": inline[$0.id].map { .string($0.line) } ?? .null] })]
        case "reload":
            watch()
            scan()
            return .int(Int64(scripts.count))
        case "setDirectory":
            if let d = args["directory"]?.stringValue { context?.setSettings(["directory": .string(d)]) }
            watch()
            scan()
            return .string(directory.path)
        case "createFolder": return .string(ensureFolder().path)
        case "run":
            guard let s = scripts.first(where: { $0.id == args["id"]?.stringValue }) else { throw FeatureError.failed("Script not found") }
            let r = await runScript(s, args: (args["args"]?.arrayValue ?? []).map { $0.stringValue ?? $0.description })
            if case let .pushView(v, p) = r { LauncherHosts.current?.push(v, payload: p) }
            return ExtensionsFeature.describe(r)
        case "output":
            guard let t = tokenStack.last, let o = outputs[t] else { return .null }
            await o.waitDone()
            return ["text": .string(o.text), "code": o.code.map { .int(Int64($0)) } ?? .null, "done": .bool(!o.running), "error": o.error.map(JSONValue.string) ?? .null]
        case "notifications": return .array(notifications)
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

/// fullOutput view state: streamed stdout/stderr, exit code, ⏎ copy, ⌘R run again, ⌘. stop.
@MainActor @Observable final class ScriptOutputModel {
    let token: String
    let script: ScriptCommandsFeature.Script
    @ObservationIgnored weak var owner: ScriptCommandsFeature?
    var text = ""
    var running = false
    var code: Int32?
    var error: String?
    var startedAt = Date()
    var endedAt: Date?
    var scrollAnchor = 0
    var panel: PanelLevel?
    @ObservationIgnored var run: ScriptRun?
    @ObservationIgnored var lastArgs: [String] = []
    @ObservationIgnored private var doneWaiters: [CheckedContinuation<Void, Never>] = []

    init(token: String, script: ScriptCommandsFeature.Script) {
        self.token = token
        self.script = script
    }

    func begin(args: [String]) {
        lastArgs = args
        text = ""
        code = nil
        error = nil
        running = true
        startedAt = Date()
        endedAt = nil
        guard let owner else { return }
        let r = owner.start(script, args: args) { [weak self] _, chunk in
            DispatchQueue.main.async { MainActor.assumeIsolated { if let self, self.text.count < 1 << 20 { self.text += chunk } } }
        }
        run = r
        Task { [weak self] in
            let o = await r.wait()
            // Let queued chunks land first.
            try? await Task.sleep(for: .milliseconds(30))
            guard let self, self.run === r else { return }
            self.running = false
            self.code = o.code
            self.error = o.error
            self.endedAt = Date()
            let w = self.doneWaiters
            self.doneWaiters = []
            for c in w { c.resume() }
        }
    }

    func waitDone() async {
        if !running { return }
        await withCheckedContinuation { doneWaiters.append($0) }
    }

    var actions: [ItemAction] {
        var a = [ItemAction(id: "copy", title: "Copy Output", shortcut: "↩", icon: "doc.on.doc"), ItemAction(id: "rerun", title: "Run Again", shortcut: "⌘R", icon: "arrow.clockwise")]
        if running { a.append(ItemAction(id: "stop", title: "Stop Script", shortcut: "⌘.", icon: "stop.circle", destructive: true)) }
        return a
    }

    func perform(_ id: String) {
        panel = nil
        switch id {
        case "copy":
            owner?.context?.services.pasteboard.setString(text, html: nil, transient: false)
            LauncherHosts.current?.toast("Output copied", style: .success)
        case "rerun": owner?.rerun(self)
        case "stop": run?.stop()
        default: break
        }
    }

    func handle(_ c: VimCommand) -> Bool {
        let lines = max(1, text.split(separator: "\n", omittingEmptySubsequences: false).count)
        switch c {
        case let .move(d): scrollAnchor = min(lines - 1, max(0, scrollAnchor + d)); return true
        case let .halfPage(dir, n): scrollAnchor = min(lines - 1, max(0, scrollAnchor + dir * 10 * n)); return true
        case let .goto(t): if case .last = t { scrollAnchor = lines - 1 } else { scrollAnchor = 0 }; return true
        case .section: return true
        case .activate: perform("copy"); return true
        case .secondary: perform("rerun"); return true
        case .actions: panel = panel == nil ? PanelLevel(title: script.meta.title ?? script.file, actions: actions) : nil; return true
        case .copy: perform("copy"); return true
        default: return false
        }
    }

    func handleKey(_ k: VimKey) -> Bool {
        if var p = panel {
            let out = PanelKeys.handle(k, &p, vimNav: false)
            panel = p
            switch out {
            case .none: break
            case .close, .back: panel = nil
            case let .run(id): perform(id)
            }
            return true
        }
        if k.meta && k.key.lowercased() == "r" { perform("rerun"); return true }
        if k.meta && k.key == "." { perform("stop"); return true }
        return false
    }
}

struct ScriptOutputView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: ScriptOutputModel
    var body: some View {
        let lines = model.text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: model.running ? "hourglass" : model.code == 0 ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(model.running ? theme.text3 : model.code == 0 ? theme.success : theme.danger)
                    Text(model.running ? "Running…" : model.error ?? "Exited with code \(model.code ?? -1)").font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text2)
                    Spacer()
                    Text(model.script.file).font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.text3)
                }
                .padding(.horizontal, 14).frame(height: 30)
                Rectangle().fill(theme.border).frame(height: 1)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { i, l in
                                Text(l.isEmpty ? " " : l).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text).id(i)
                            }
                        }
                        .padding(14)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .onChange(of: model.scrollAnchor) { _, a in proxy.scrollTo(a) }
                    .onChange(of: lines.count) { _, n in if model.running { proxy.scrollTo(n - 1) } }
                }
            }
            if let p = model.panel { ActionPanel(title: p.title, actions: p.filtered, selectedIndex: p.selected, filter: p.filter).padding(10) }
        }
    }
}

struct ScriptsSettingsView: View {
    weak var feature: ScriptCommandsFeature?
    @State private var dir = ""
    @State private var tick = 0
    var body: some View {
        Form {
            Section("Folder") {
                TextField("Script Commands folder", text: $dir).onSubmit {
                    feature?.context?.setSettings(["directory": .string(dir)])
                    feature?.scan()
                    tick += 1
                }
                Button("Create Folder with Examples") { feature?.ensureFolder(); tick += 1 }
            }
            Section("Scripts") {
                let list = feature?.scripts ?? []
                if list.isEmpty { Text("No scripts found. Add files with `# @raycast.title` and `# @raycast.mode` headers.").foregroundStyle(.secondary) }
                ForEach(list, id: \.id) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.meta.title ?? s.file)
                        Text(s.valid ? "\(s.meta.mode ?? "") · \(s.file)" : s.meta.errors.joined(separator: "; ")).font(.caption).foregroundStyle(s.valid ? Color.secondary : Color.red)
                    }
                }
            }
            .id(tick)
        }
        .formStyle(.grouped)
        .onAppear { dir = feature?.context?.settings(defaults: ScriptCommandsFeature.defaults)["directory"]?.stringValue ?? "" }
    }
}

/// Example scripts written the first time the folder is created (examples.ts).
enum ScriptExamples {
    static let all: [(file: String, source: String)] = [
        ("hello-world.sh", """
        #!/bin/bash

        # Required parameters:
        # @raycast.schemaVersion 1
        # @raycast.title Hello World
        # @raycast.mode compact

        # Optional parameters:
        # @raycast.icon 👋
        # @raycast.packageName Examples
        # @raycast.description Greets you (or whoever you type after the name)
        # @raycast.argument1 { "type": "text", "placeholder": "Name", "optional": true }

        echo "Hello, ${1:-world}!"

        """),
        ("system-info.sh", """
        #!/bin/bash

        # Required parameters:
        # @raycast.schemaVersion 1
        # @raycast.title System Info
        # @raycast.mode fullOutput

        # Optional parameters:
        # @raycast.icon 🖥️
        # @raycast.packageName Examples
        # @raycast.description macOS version, uptime and disk usage

        echo "== macOS =="
        sw_vers
        echo
        echo "== Uptime =="
        uptime
        echo
        echo "== Disk =="
        df -h /

        """),
    ]

    static func template(_ title: String) -> String {
        """
        #!/bin/bash

        # Required parameters:
        # @raycast.schemaVersion 1
        # @raycast.title \(title)
        # @raycast.mode fullOutput

        # Optional parameters:
        # @raycast.icon 🤖
        # @raycast.packageName My Scripts
        # @raycast.description Describe what this script does
        # @raycast.argument1 { "type": "text", "placeholder": "Input", "optional": true }

        echo "Hello from \(title): $1"

        """
    }

    static func write(_ source: String, to url: URL) throws {
        try Data(source.utf8).write(to: url, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }
}
