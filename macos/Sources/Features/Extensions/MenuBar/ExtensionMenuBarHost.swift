import Foundation
import GlideCore

/// Raycast `menu-bar` mode commands (port of the menu-bar half of src/main/features/extensions/compat.ts) on the
/// shared status-item API. A menu-bar command runs in its own JS session that stays alive (never swept); every
/// depth-0 render becomes the status item "ext:<extension>/<command>" (`.separate`: always its own icon, like Raycast).
/// The command re-runs on its manifest `interval` (launchType "background") and when its menu opens
/// (launchType "userInitiated"); a click in the menu invokes the handler in the live session, relaunching the
/// command when that session has ended. Which commands are active persists in the Electron bag key
/// `settings.features.extensions.background` (`{"<ext>/<command>": true}`); running a menu-bar command activates it.
@MainActor final class ExtensionMenuBarHost {
    final class Slot {
        let key: String
        let ext: String
        let command: String
        var title: String
        weak var session: ExtensionSession?
        var sessionId: String?
        var timer: Timer?
        var lastLaunch: Date = .distantPast
        var runs = 0
        var shown = false
        var last: StatusItemSpec?
        init(key: String, ext: String, command: String, title: String) {
            self.key = key
            self.ext = ext
            self.command = command
            self.title = title
        }
    }

    private weak var feature: ExtensionsFeature?
    private(set) var slots: [String: Slot] = [:]
    /// Headless tests: every interval is shortened to at most this (GLIDE_EXT_INTERVAL_CAP_MS).
    var intervalCapMs: Int? = ProcessInfo.processInfo.environment["GLIDE_EXT_INTERVAL_CAP_MS"].flatMap(Int.init)
    /// Opening the menu re-runs the command unless it (re)started this recently.
    var menuOpenRerunAfter: TimeInterval = 2
    /// `updateCommandMetadata` subtitles by "<ext>/<command>".
    private(set) var subtitles: [String: String] = [:]
    private var startTask: Task<Void, Never>?

    init(feature: ExtensionsFeature) { self.feature = feature }

    static func key(_ ext: String, _ command: String) -> String { "\(ext)/\(command)" }

    private var context: FeatureContext? { feature?.context }
    private var service: (any StatusItemService)? { context?.services.statusItems }

    // MARK: lifecycle

    /// Restore active menu-bar commands once the app has settled (Electron: 1.5 s after start).
    func start(delay: Duration = .milliseconds(1500)) {
        loadMetadata()
        startTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.sync()
        }
    }

    func stopAll() {
        startTask?.cancel()
        for key in Array(slots.keys) { deactivate(key) }
    }

    // MARK: activation toggles

    var background: [String: Bool] {
        let raw = context?.settings(defaults: ["background": .object([:])])["background"]?.objectValue ?? [:]
        return raw.compactMapValues(\.boolValue)
    }

    func isEnabled(_ key: String) -> Bool { background[key] == true }

    private func saveBackground(_ next: [String: Bool]) {
        context?.setSettings(["background": .object(next.filter(\.value).mapValues { .bool($0) })])
    }

    /// Turn the status item of a command on or off (an explicit user action).
    func setEnabled(_ ext: String, _ command: String, _ on: Bool) {
        var next = background
        next[Self.key(ext, command)] = on ? true : nil
        saveBackground(next)
        sync()
    }

    /// Enabled, installed menu-bar commands.
    private func candidates() -> [(key: String, ext: String, cmd: ExtCommand)] {
        var out: [(String, String, ExtCommand)] = []
        for e in feature?.registry?.list() ?? [] where e.enabled {
            for c in e.manifest?.commands ?? [] where c.mode == "menu-bar" { out.append((Self.key(e.name, c.name), e.name, c)) }
        }
        return out
    }

    private func command(_ key: String) -> (ext: String, cmd: ExtCommand)? { candidates().first { $0.key == key }.map { ($0.ext, $0.cmd) } }

    /// Make the active set equal to the toggles (also after install / uninstall / disable).
    func sync() {
        let enabled = background
        let wanted = Set(candidates().filter { enabled[$0.key] == true }.map(\.key))
        for key in Array(slots.keys) where !wanted.contains(key) { deactivate(key) }
        for key in wanted where slots[key]?.session?.alive != true && slots[key]?.sessionId == nil {
            Task { await self.launch(key, launchType: "background") }
        }
    }

    private func deactivate(_ key: String) {
        guard let slot = slots.removeValue(forKey: key) else { return }
        slot.timer?.invalidate()
        if slot.shown { service?.remove(MenuBarExtraModel.itemId(slot.ext, slot.command)) }
        slot.session?.kill()
    }

    // MARK: running

    /// (Re)start a menu-bar command through ExtensionsFeature.runCommand (which calls `sessionStarted`).
    @discardableResult func launch(_ key: String, launchType: String) async -> ActionResult {
        guard let found = command(key), let feature else { return .error("Unknown menu-bar command \(key)") }
        let slot = slot(key, ext: found.ext, cmd: found.cmd)
        slot.lastLaunch = Date()
        let r = await feature.runCommand(found.ext, found.cmd.name, launchType: launchType)
        if case let .error(m) = r { show(slot, MenuBarExtraModel.errorSpec(commandTitle: found.cmd.title, message: m)) }
        return r
    }

    private func slot(_ key: String, ext: String, cmd: ExtCommand) -> Slot {
        if let s = slots[key] {
            s.title = cmd.title
            return s
        }
        let s = Slot(key: key, ext: ext, command: cmd.name, title: cmd.title)
        slots[key] = s
        return s
    }

    /// ExtensionsFeature started a session for a menu-bar command: it replaces the previous one (whose status
    /// item stays until the new render), the interval timer is (re)armed, and a user launch activates the command.
    func sessionStarted(_ s: ExtensionSession, command cmd: ExtCommand, background: Bool) -> ActionResult {
        let key = Self.key(s.info.extName, cmd.name)
        let slot = slot(key, ext: s.info.extName, cmd: cmd)
        let previous = slot.session
        slot.session = s
        slot.sessionId = s.info.id
        slot.runs += 1
        slot.lastLaunch = Date()
        if let previous, previous !== s { previous.kill() }
        arm(slot, cmd)
        if !background, !isEnabled(key) {
            var next = self.background
            next[key] = true
            saveBackground(next)
        }
        return background ? .stay(message: nil) : .hide()
    }

    private func arm(_ slot: Slot, _ cmd: ExtCommand) {
        guard slot.timer == nil, var ms = cmd.intervalMs, ms > 0 else { return }
        if let cap = intervalCapMs, cap > 0 { ms = min(ms, cap) }
        let key = slot.key
        slot.timer = Timer.scheduledTimer(withTimeInterval: Double(ms) / 1000, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.slots[key] != nil else { return }
                Task { await self.launch(key, launchType: "background") }
            }
        }
    }

    /// Session events of menu-bar sessions (they never reach the launcher).
    func sessionDidChange(_ s: ExtensionSession, _ event: ExtensionSession.Event) {
        guard let slot = slots.values.first(where: { $0.sessionId == s.info.id }) else { return }
        switch event {
        case let .render(depth), let .push(depth):
            guard depth == 0, let view = s.view(0) else { return }
            if view["type"]?.stringValue == "menubar" {
                let sid = s.info.id, key = slot.key
                var spec = MenuBarExtraModel.spec(view, fallbackTitle: slot.title, assetsPath: s.info.assetsPath) { [weak self] handler in
                    self?.click(key, sessionId: sid, handler: handler)
                }
                // A re-run starts loading again: keep showing the previous title and rows until it has data.
                if spec.isLoading, view["title"] == nil, let last = slot.last, !last.isLoading {
                    spec.title = last.title
                    if spec.menu.count == 1, spec.menu.first?.title == "Loading…" { spec.menu = last.menu }
                }
                show(slot, spec)
            } else {
                show(slot, MenuBarExtraModel.errorSpec(commandTitle: slot.title, message: MenuBarExtraModel.errorMessage(view)))
            }
        case .ended:
            if slot.sessionId == s.info.id { slot.sessionId = nil }
        case let .failureToast(msg):
            feature?.recordEffect("toast", ["style": "failure", "title": .string(msg), "menuBar": .string(slot.key)])
        case .pop: break
        }
    }

    private func show(_ slot: Slot, _ spec: StatusItemSpec) {
        var spec = spec
        let key = slot.key
        spec.onMenuOpen = { [weak self] in self?.menuOpened(key) }
        slot.last = spec
        slot.shown = true
        service?.show(MenuBarExtraModel.itemId(slot.ext, slot.command), spec, placement: .separate)
    }

    /// A click in the status item's menu: run the handler, relaunching the command if its session ended.
    private func click(_ key: String, sessionId: String, handler: String) {
        guard let slot = slots[key] else { return }
        if slot.sessionId == sessionId, let s = slot.session, s.alive, s.invoke(depth: 0, handler: handler, args: [["type": "left-click"]]) { return }
        Task { await self.launch(key, launchType: "userInitiated") }
    }

    /// Raycast runs a menu-bar command again when its menu opens.
    private func menuOpened(_ key: String) {
        guard let slot = slots[key], Date().timeIntervalSince(slot.lastLaunch) >= menuOpenRerunAfter else { return }
        Task { await self.launch(key, launchType: "userInitiated") }
    }

    // MARK: requests (updateCommandMetadata)

    /// Requests this host owns; nil for everything else.
    func request(_ s: ExtensionSession, method: String, params: [JSONValue]) -> JSONValue? {
        guard method == "updateCommandMetadata" else { return nil }
        let key = Self.key(s.info.extName, s.info.commandName)
        let sub = params.first?["subtitle"]
        if let v = sub?.stringValue, !v.isEmpty { subtitles[key] = v } else if sub != nil { subtitles[key] = nil }
        context?.setSettings(["commandMetadata": .object(subtitles.mapValues { ["subtitle": .string($0)] })])
        context?.refreshCatalogue()
        return .null
    }

    private func loadMetadata() {
        let raw = context?.settings(defaults: ["commandMetadata": .object([:])])["commandMetadata"]?.objectValue ?? [:]
        subtitles = raw.compactMapValues { $0["subtitle"]?.stringValue }
    }

    func subtitle(_ ext: String, _ command: String) -> String? { subtitles[Self.key(ext, command)] }

    // MARK: test channel

    func state() -> JSONValue {
        let items = service?.state()["items"]?.arrayValue ?? []
        return .array(candidates().map { c in
            let slot = slots[c.key]
            let itemId = MenuBarExtraModel.itemId(c.ext, c.cmd.name)
            return ["ext": .string(c.ext), "command": .string(c.cmd.name), "title": .string(c.cmd.title), "interval": c.cmd.interval.map(JSONValue.string) ?? .null,
                    "enabled": .bool(isEnabled(c.key)), "active": .bool(slot?.shown == true), "runs": .int(Int64(slot?.runs ?? 0)),
                    "sessionId": slot?.sessionId.map(JSONValue.string) ?? .null, "itemId": .string(itemId),
                    "item": items.first { $0["id"]?.stringValue == itemId } ?? .null]
        })
    }

    /// `extensions.<method>` test-channel / cross-feature methods owned here; nil for others.
    func invoke(_ method: String, _ args: JSONValue) async -> JSONValue? {
        let ext = args["ext"]?.stringValue ?? args["name"]?.stringValue ?? ""
        let command = args["command"]?.stringValue ?? ""
        let itemId = MenuBarExtraModel.itemId(ext, command)
        switch method {
        case "menuBarState": return state()
        case "setBackground":
            setEnabled(ext, command, args["enabled"]?.boolValue ?? true)
            return state()
        case "menuBarClick":
            let path = args["path"]?.arrayValue?.compactMap(\.intValue) ?? []
            return .bool(service?.click(itemId, path: path) ?? false)
        case "menuBarOpen":
            service?.menuWillOpen(itemId)
            return true
        case "menuBarRefresh":
            return ExtensionsFeature.describe(await launch(Self.key(ext, command), launchType: "background"))
        default: return nil
        }
    }
}
