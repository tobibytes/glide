import AppKit
import GlideCore
import GlideSystem
import GlideUI

/// Extra system commands (port of src/main/features/syscmds): Toggle Hidden Files / Desktop Icons / Dock
/// Auto-Hide, Restart Finder / Dock, Sleep Displays, Log Out. Each is a list of argv steps (no shell), so tests
/// check exactly what would run; confirmations go through ConfirmationService first. Ids `syscmds:<id>`.
@MainActor public final class SysCmdsFeature: Feature, FeatureUI {
    public let id = "syscmds"
    public let title = "More System Commands"
    private weak var context: FeatureContext?
    var runner: (any StepRunning)?

    public struct Command: Sendable {
        public let id: String
        public let title: String
        public let subtitle: String
        public let symbol: String
        public let keywords: [String]
        /// Confirmation text; the command runs only after the user confirms.
        public let confirm: String?
        /// Read the current boolean first (`defaults read`).
        public let read: CommandStep?
        public let steps: @Sendable (Bool?) -> [CommandStep]
        public let done: @Sendable (Bool?) -> String
    }

    nonisolated static let defaults = "/usr/bin/defaults", killall = "/usr/bin/killall", osascript = "/usr/bin/osascript"
    nonisolated static func readBool(_ domain: String, _ key: String) -> CommandStep { CommandStep(cmd: defaults, args: ["read", domain, key], allowFail: true) }

    nonisolated public static let commands: [Command] = [
        Command(id: "toggleHiddenFiles", title: "Toggle Hidden Files", subtitle: "Show or hide dotfiles in Finder (restarts Finder)", symbol: "eye.slash",
                keywords: ["hidden", "dotfiles", "invisible", "finder", "show all files"], confirm: nil, read: readBool("com.apple.finder", "AppleShowAllFiles"),
                steps: { shown in [CommandStep(cmd: defaults, args: ["write", "com.apple.finder", "AppleShowAllFiles", "-bool", shown == true ? "false" : "true"]),
                                   CommandStep(cmd: killall, args: ["Finder"], allowFail: true)] },
                done: { $0 == true ? "Hidden files are now hidden" : "Hidden files are now shown" }),
        Command(id: "toggleDesktopIcons", title: "Toggle Desktop Icons", subtitle: "Hide or show files on the desktop (restarts Finder)", symbol: "menubar.dock.rectangle",
                keywords: ["desktop", "icons", "clean", "presentation", "hide"], confirm: nil, read: readBool("com.apple.finder", "CreateDesktop"),
                steps: { visible in [CommandStep(cmd: defaults, args: ["write", "com.apple.finder", "CreateDesktop", "-bool", visible == false ? "true" : "false"]),
                                     CommandStep(cmd: killall, args: ["Finder"], allowFail: true)] },
                done: { $0 == false ? "Desktop icons shown" : "Desktop icons hidden" }),
        Command(id: "toggleDockAutohide", title: "Toggle Dock Auto-Hide", subtitle: "Automatically hide and show the Dock", symbol: "dock.rectangle",
                keywords: ["dock", "autohide", "hide", "show"], confirm: nil, read: nil,
                steps: { _ in [CommandStep(cmd: osascript, args: ["-"], input: "tell application \"System Events\" to tell dock preferences to set autohide to not autohide")] },
                done: { _ in "Toggled Dock auto-hide" }),
        Command(id: "restartFinder", title: "Restart Finder", subtitle: "Relaunch Finder", symbol: "arrow.clockwise.circle",
                keywords: ["finder", "relaunch", "kill", "restart", "reload"], confirm: "Restart Finder? File copies in progress will be interrupted.", read: nil,
                steps: { _ in [CommandStep(cmd: killall, args: ["Finder"])] }, done: { _ in "Finder restarted" }),
        Command(id: "restartDock", title: "Restart Dock", subtitle: "Relaunch the Dock (fixes stuck Dock / Mission Control)", symbol: "arrow.clockwise.circle",
                keywords: ["dock", "relaunch", "kill", "restart", "mission control"], confirm: nil, read: nil,
                steps: { _ in [CommandStep(cmd: killall, args: ["Dock"])] }, done: { _ in "Dock restarted" }),
        Command(id: "sleepDisplays", title: "Sleep Displays", subtitle: "Turn the screens off; the Mac keeps running", symbol: "display",
                keywords: ["display", "screen", "monitor", "off", "sleep"], confirm: nil, read: nil,
                steps: { _ in [CommandStep(cmd: "/usr/bin/pmset", args: ["displaysleepnow"])] }, done: { _ in "" }),
        Command(id: "logOut", title: "Log Out", subtitle: "Log out of your user account", symbol: "rectangle.portrait.and.arrow.right",
                keywords: ["logout", "sign out", "log off", "user"], confirm: "Log out now? Unsaved work in other apps may be lost.", read: nil,
                // «event aevtrlgo» logs out without macOS showing a second confirmation dialog.
                steps: { _ in [CommandStep(cmd: osascript, args: ["-"], input: "tell application \"loginwindow\" to «event aevtrlgo»")] }, done: { _ in "" }),
    ]

    /// Default values macOS uses when the key was never written.
    static let readFallback: [String: Bool] = ["toggleHiddenFiles": false, "toggleDesktopIcons": true]

    /// `defaults read` prints 1/0, YES/NO or true/false; a missing key means the default.
    public static func parseDefaultsBool(_ out: String?, fallback: Bool) -> Bool {
        let t = (out ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ["1", "yes", "true"].contains(t) { return true }
        if ["0", "no", "false"].contains(t) { return false }
        return fallback
    }

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        if runner == nil { runner = StepRunners.make(headless: context.services.isHeadless) }
    }

    public func items() -> [SearchItem] {
        Self.commands.map { c in
            SearchItem(id: "syscmds:\(c.id)", kind: .command, title: c.title, subtitle: c.subtitle, icon: .symbol(c.symbol), keywords: c.keywords,
                       feature: id, data: ["command": .string(c.id)], kindLabel: "System")
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] { [ItemAction(id: "run", title: "Run", shortcut: "↩", icon: "play.fill")] }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard action == "run", let cid = scored.item.data?["command"]?.stringValue, let cmd = Self.commands.first(where: { $0.id == cid }) else { return .error("Unknown command") }
        return await execute(cmd)
    }

    func execute(_ cmd: Command) async -> ActionResult {
        guard let ctx = context, let runner else { return .error("Not ready") }
        if let q = cmd.confirm {
            ctx.hideLauncher()
            guard await ctx.services.confirmation.confirm(title: cmd.title, message: q, confirmButton: cmd.title) else { return .hide() }
        }
        do {
            var current: Bool?
            if let r = cmd.read { current = Self.parseDefaultsBool(try await runner.runAll([r]), fallback: Self.readFallback[cmd.id] ?? false) }
            try await runner.runAll(cmd.steps(current))
            let m = cmd.done(current)
            return .hide(message: m.isEmpty ? nil : m)
        } catch {
            return .error(error.localizedDescription)
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "run":
            guard let cid = args.stringValue ?? args["id"]?.stringValue, let cmd = Self.commands.first(where: { $0.id == cid }) else { throw FeatureError.invalidArguments("Unknown command") }
            switch await execute(cmd) {
            case let .error(m): return ["ok": false, "error": .string(m)]
            case let .hide(m): return ["ok": true, "message": m.map(JSONValue.string) ?? .null]
            default: return ["ok": true]
            }
        case "plan":
            guard let cid = args["id"]?.stringValue, let cmd = Self.commands.first(where: { $0.id == cid }) else { throw FeatureError.invalidArguments("Unknown command") }
            return .array(cmd.steps(args["current"]?.boolValue).map(\.json))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}
