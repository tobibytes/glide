import AppKit
import GlideCore
import GlideUI

/// Port of src/main/sources/system.ts (system commands, ids `system:<id>`) plus the Glide settings items
/// (`setting:<id>`). Commands that change system state ask for confirmation first. Everything runs through
/// SystemServices, so headless runs only record "[headless] applescript …" etc.
@MainActor public final class SystemCommandsFeature: Feature, FeatureUI {
    public let id = "system"
    public let title = "System Commands"
    private weak var context: FeatureContext?

    public enum Run: Sendable {
        case appleScript(String)
        case shell(String)
        case openURL(String)
        case openPath(String)
        case copyLocalIP
        case copyPublicIP
    }

    public struct Command: Sendable {
        public let id: String
        public let title: String
        public let subtitle: String?
        public let symbol: String
        public let keywords: [String]
        public let confirm: String?
        public let run: Run
        public let message: String?
    }

    static func pane(_ id: String, _ title: String, _ pane: String, _ symbol: String, _ kw: [String]) -> Command {
        Command(id: id, title: title, subtitle: "System Settings", symbol: symbol, keywords: ["settings", "preferences", "system"] + kw, confirm: nil, run: .openURL("x-apple.systempreferences:\(pane)"), message: nil)
    }
    static func folder(_ id: String, _ title: String, _ folder: String, _ symbol: String, _ kw: [String]) -> Command {
        let path = NSHomeDirectory() + "/" + folder
        return Command(id: id, title: title, subtitle: path, symbol: symbol, keywords: ["open", "folder", "finder"] + kw, confirm: nil, run: .openPath(path), message: nil)
    }

    public static let commands: [Command] = [
        Command(id: "lockScreen", title: "Lock Screen", subtitle: nil, symbol: "lock.fill", keywords: ["lock", "secure", "away"], confirm: nil,
                run: .appleScript("tell application \"System Events\" to keystroke \"q\" using {command down, control down}"), message: nil),
        Command(id: "sleep", title: "Sleep", subtitle: nil, symbol: "moon.zzz.fill", keywords: ["suspend", "nap"], confirm: nil, run: .shell("pmset sleepnow"), message: nil),
        Command(id: "restart", title: "Restart", subtitle: nil, symbol: "arrow.clockwise", keywords: ["reboot"], confirm: "Restart your Mac now?",
                run: .appleScript("tell application \"System Events\" to restart"), message: nil),
        Command(id: "shutDown", title: "Shut Down", subtitle: nil, symbol: "power", keywords: ["power", "off", "halt"], confirm: "Shut down your Mac now?",
                run: .appleScript("tell application \"System Events\" to shut down"), message: nil),
        Command(id: "emptyTrash", title: "Empty Trash", subtitle: nil, symbol: "trash.fill", keywords: ["bin", "delete", "clean"], confirm: "Permanently erase the items in the Trash?",
                run: .appleScript("tell application \"Finder\" to empty trash"), message: "Trash emptied"),
        Command(id: "toggleDarkMode", title: "Toggle Dark Mode", subtitle: nil, symbol: "circle.lefthalf.filled", keywords: ["appearance", "theme", "light", "dark"], confirm: nil,
                run: .appleScript("tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode"), message: nil),
        Command(id: "showDesktop", title: "Show Desktop", subtitle: "Hide all windows", symbol: "menubar.dock.rectangle", keywords: ["hide", "windows", "desktop"], confirm: nil,
                run: .appleScript("tell application \"System Events\" to set visible of (every process whose visible is true and name is not \"Finder\") to false"), message: nil),
        Command(id: "quitAllApps", title: "Quit All Apps", subtitle: nil, symbol: "xmark.app.fill", keywords: ["close", "quit", "everything"], confirm: "Quit all running applications?",
                run: .appleScript("""
                tell application "System Events"
                  set appNames to name of every application process whose visible is true and name is not "Finder" and name is not "Glide"
                end tell
                repeat with appName in appNames
                  try
                    tell application appName to quit
                  end try
                end repeat
                """), message: nil),
        Command(id: "ejectAllDisks", title: "Eject All Disks", subtitle: nil, symbol: "eject.fill", keywords: ["unmount", "usb", "drive", "volume"],
                confirm: "Eject all external disks? Unsaved work on them may be lost.", run: .appleScript("tell application \"Finder\" to eject (every disk whose ejectable is true)"), message: "Disks ejected"),
        folder("openDownloads", "Open Downloads Folder", "Downloads", "arrow.down.circle.fill", ["downloads"]),
        folder("openDocuments", "Open Documents Folder", "Documents", "doc.fill", ["documents"]),
        folder("openDesktop", "Open Desktop Folder", "Desktop", "menubar.dock.rectangle", ["desktop"]),
        Command(id: "startScreenSaver", title: "Start Screen Saver", subtitle: nil, symbol: "sparkles.tv", keywords: ["screensaver", "idle"], confirm: nil, run: .shell("open -a ScreenSaverEngine"), message: nil),
        Command(id: "toggleDnd", title: "Toggle Do Not Disturb", subtitle: nil, symbol: "moon.fill", keywords: ["focus", "dnd", "notifications", "silence"], confirm: nil,
                run: .shell("shortcuts run 'Toggle Do Not Disturb'"), message: "Toggled Do Not Disturb"),
        Command(id: "volumeUp", title: "Volume Up", subtitle: nil, symbol: "speaker.wave.3.fill", keywords: ["sound", "louder", "audio"], confirm: nil,
                run: .appleScript("set volume output volume (((output volume of (get volume settings)) + 10) mod 101)"), message: nil),
        Command(id: "volumeDown", title: "Volume Down", subtitle: nil, symbol: "speaker.wave.1.fill", keywords: ["sound", "quieter", "audio"], confirm: nil,
                run: .appleScript("set v to (output volume of (get volume settings)) - 10\nif v < 0 then set v to 0\nset volume output volume v"), message: nil),
        Command(id: "volumeMute", title: "Toggle Mute", subtitle: nil, symbol: "speaker.slash.fill", keywords: ["sound", "mute", "silence", "audio"], confirm: nil,
                run: .appleScript("set volume output muted (not (output muted of (get volume settings)))"), message: nil),
        Command(id: "copyIp", title: "Copy IP Address", subtitle: "Local IPv4 address", symbol: "network", keywords: ["network", "ip", "address", "lan"], confirm: nil, run: .copyLocalIP, message: nil),
        Command(id: "copyPublicIp", title: "Copy Public IP Address", subtitle: nil, symbol: "globe", keywords: ["network", "ip", "address", "wan", "external"], confirm: nil, run: .copyPublicIP, message: nil),
        pane("settingsWifi", "Wi-Fi Settings", "com.apple.wifi-settings-extension", "wifi", ["wifi", "wireless", "network"]),
        pane("settingsBluetooth", "Bluetooth Settings", "com.apple.BluetoothSettings", "dot.radiowaves.left.and.right", ["bluetooth", "airpods"]),
        pane("settingsDisplay", "Display Settings", "com.apple.Displays-Settings.extension", "display", ["display", "monitor", "resolution", "brightness"]),
        pane("settingsSound", "Sound Settings", "com.apple.Sound-Settings.extension", "speaker.wave.2.fill", ["sound", "audio", "output", "input"]),
        pane("settingsKeyboard", "Keyboard Settings", "com.apple.Keyboard-Settings.extension", "keyboard", ["keyboard", "shortcuts", "input"]),
    ]

    /// Items that open a page of Glide's own Settings window (command = page route).
    static let settingEntries: [(id: String, title: String, route: String, symbol: String, keywords: [String])] = [
        ("general", "Glide Settings", "general", "gearshape.fill", ["preferences", "settings", "options"]),
        ("createWorkflow", "Create Workflow", "workflows/new", "square.stack.3d.up.fill", ["new", "workflow", "automation", "shortcut"]),
        ("createSnippet", "Create Snippet", "snippets/new", "text.quote", ["new", "snippet", "text", "expansion"]),
        ("editHotkey", "Edit Hotkey", "general#hotkey", "command", ["hotkey", "shortcut", "keyboard", "trigger"]),
    ]

    public init() {}
    public func start(context: FeatureContext) async { self.context = context }

    public func items() -> [SearchItem] {
        Self.commands.map { c in
            SearchItem(id: "system:\(c.id)", kind: .system, title: c.title, subtitle: c.subtitle ?? "System Command", icon: .symbol(c.symbol),
                       keywords: c.keywords, command: c.id, source: "system", feature: id)
        } + Self.settingEntries.map { s in
            SearchItem(id: "setting:\(s.id)", kind: .setting, title: s.title, subtitle: "Glide", icon: .symbol(s.symbol), keywords: ["glide"] + s.keywords,
                       command: s.route, source: "settings", feature: id)
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        item.kind == .setting ? [ItemAction(id: "open", title: "Open", shortcut: "↩", icon: "gearshape")] : [ItemAction(id: "run", title: "Run", shortcut: "↩", icon: "play.fill")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let ctx = context else { return .error("Not started") }
        let item = scored.item
        if item.kind == .setting { return .openSettings(page: item.command) }
        guard let cmd = Self.commands.first(where: { $0.id == item.command }) else { return .error("Unknown system command: \(item.command ?? "?")") }
        if let question = cmd.confirm {
            ctx.hideLauncher()
            guard await ctx.services.confirmation.confirm(title: cmd.title, message: question, confirmButton: cmd.title) else { return .hide() }
        }
        do {
            switch cmd.run {
            case let .appleScript(src): _ = try await ctx.services.scripts.runAppleScript(src)
            case let .shell(command):
                let r = try await ctx.services.scripts.runShell(command, shell: "/bin/zsh", timeout: 10)
                if r.status != 0 {
                    return .error(cmd.id == "toggleDnd" ? "Create a Shortcut named \"Toggle Do Not Disturb\" in Shortcuts.app to use this command" : r.stderr)
                }
            case let .openURL(u):
                guard let url = URL(string: u) else { return .error("Bad URL") }
                let r = ctx.services.workspace.open(url: url)
                if !r.ok { return .error(r.error ?? "Could not open") }
            case let .openPath(p):
                let r = ctx.services.workspace.open(path: p)
                if !r.ok { return .error(r.error ?? "Could not open") }
            case .copyLocalIP:
                guard let ip = Self.localIPv4() else { return .error("No active network interface") }
                ctx.services.pasteboard.setString(ip, html: nil, transient: false)
                return .hide(message: "Copied \(ip)")
            case .copyPublicIP:
                let r = try await ctx.services.scripts.runShell("curl -s --max-time 5 https://api.ipify.org", shell: "/bin/zsh", timeout: 8)
                let ip = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                guard r.status == 0, !ip.isEmpty || ctx.services.isHeadless else { return .error("Could not determine public IP") }
                ctx.services.pasteboard.setString(ip, html: nil, transient: false)
                return .hide(message: "Copied \(ip)")
            }
        } catch {
            return .error(error.localizedDescription)
        }
        return .hide(message: cmd.message)
    }

    static func localIPv4() -> String? {
        var addrs: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrs) == 0, let first = addrs else { return nil }
        defer { freeifaddrs(addrs) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = p {
            let flags = Int32(cur.pointee.ifa_flags)
            if let sa = cur.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET), flags & IFF_LOOPBACK == 0, flags & IFF_UP != 0 {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                    return String(decoding: host.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
                }
            }
            p = cur.pointee.ifa_next
        }
        return nil
    }
}
