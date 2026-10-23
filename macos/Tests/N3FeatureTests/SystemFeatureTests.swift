import Darwin
import Foundation
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem
import Testing

@Suite("finder logic")
struct FinderLogicTests {
    let home = "/Users/me"

    @Test func formats() {
        let p = ["/Users/me/a b.txt", "/Users/me/x"]
        #expect(FinderLogic.formatPaths(p, .posix, home: home) == "/Users/me/a b.txt\n/Users/me/x")
        #expect(FinderLogic.formatPaths(p, .tilde, home: home) == "~/a b.txt\n~/x")
        #expect(FinderLogic.formatPaths(p, .quoted, home: home) == "'/Users/me/a b.txt' /Users/me/x")
        #expect(FinderLogic.formatPaths(["/Users/me/a b.txt"], .url, home: home) == "file:///Users/me/a%20b.txt")
        #expect(FinderLogic.formatPaths(["/Users/me"], .tilde, home: home) == "~")
    }

    @Test func plans() {
        #expect(FinderLogic.hereFolder(["/a/b.txt"], folder: "/z") { _ in false } == "/a")
        #expect(FinderLogic.hereFolder(["/a/dir"], folder: "/z") { _ in true } == "/a/dir")
        #expect(FinderLogic.hereFolder([], folder: "/z") { _ in true } == "/z")
        #expect(FinderLogic.terminalSteps("Ghostty", dir: "/x").first?.args == ["-na", "Ghostty", "--args", "--working-directory=/x"])
        #expect(FinderLogic.terminalSteps("iTerm", dir: "/x").first?.args == ["-a", "iTerm", "/x"])
        #expect(FinderLogic.uniqueName("notes.txt") { ["notes.txt", "notes 2.txt"].contains($0) } == "notes 3.txt")
        #expect(FinderLogic.uniqueName("Makefile") { $0 == "Makefile" } == "Makefile 2")
        #expect(FinderLogic.commonParent(["/a/b/c.txt", "/a/b/d/e.txt"]) == "/a/b")
        let one = FinderLogic.compressPlan(["/a/doc.pdf"]) { $0 == "/a/doc.pdf.zip" }
        #expect(one?.output == "/a/doc.pdf 2.zip")
        #expect(one?.steps.first?.cmd == "/usr/bin/ditto")
        let many = FinderLogic.compressPlan(["/a/b/x", "/a/b/y/z"]) { _ in false }
        #expect(many?.output == "/a/b/Archive.zip")
        #expect(many?.steps.first?.args.suffix(2) == ["x", "y/z"])
        #expect(many?.steps.first?.cwd == "/a/b")
        let mv = FinderLogic.movePlan(["/a/x", "/a/dir", "/b/y", "/c/z"], dest: "/a/dir/") { $0 == "/a/dir/z" }
        #expect(mv.moves.map(\.to) == ["/a/dir/x", "/a/dir/y"])
        #expect(mv.skipped == [])
        #expect(mv.conflicts.count == 2)
        #expect(FinderLogic.movePlan(["/d/x"], dest: "/d") { _ in false }.skipped == ["/d/x"])
        #expect(FinderLogic.expandPath("~/Down", home: home, base: "/x") == "/Users/me/Down")
        #expect(FinderLogic.expandPath("../y", home: home, base: "/x/z") == "/x/y")
        #expect(FinderLogic.validateFileName("a/b") != nil)
        #expect(FinderLogic.validateFileName("..") != nil)
        #expect(FinderLogic.validateFileName(" ok.md ") == nil)
        #expect(FinderLogic.describeSelection(["/a/b", "/c"]) == "2 items")
    }

    @Test func fileOpsInTempDir() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("n3-finder-\(UUID().uuidString)").path
        try FileManager.default.createDirectory(atPath: dir + "/dest", withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        guard case let .success(p1) = FinderLogic.createEmptyFile(folder: dir, name: "n.txt") else { Issue.record("create failed"); return }
        guard case let .success(p2) = FinderLogic.createEmptyFile(folder: dir, name: "n.txt") else { Issue.record("create failed"); return }
        #expect((p2 as NSString).lastPathComponent == "n 2.txt")
        let r = FinderLogic.moveItems([p1, p2], dest: dir + "/dest")
        #expect(r.ok && r.moved == 2)
        #expect(FileManager.default.fileExists(atPath: dir + "/dest/n 2.txt"))
        #expect(FinderLogic.destinations(query: dir + "/de", base: nil, home: home, recent: []).map(\.name) == ["dest"])
    }

    @Test @MainActor func featureUsesSelectionAndRecordsPlans() async {
        let ctx = N3Context("finder")
        let f = FinderFeature()
        let runner = HeadlessStepRunner(echo: false)
        f.runner = runner
        await f.start(context: ctx)
        let copy = SearchItem(id: "finder:copyPath", kind: .command, title: "Copy", feature: "finder", data: ["command": "copyPath"])
        #expect(await f.run(action: "run", on: .row(copy), modifiers: []) == .error("Select one or more items in Finder first"))
        _ = try? await f.invoke(method: "setTestSelection", args: ["paths": ["/Users/me/a b.txt"], "folder": "/Users/me"])
        #expect(await f.run(action: "copy:quoted", on: .row(copy), modifiers: []) == .hide(message: "Copied path"))
        #expect(ctx.services.pasteboard.string() == "'/Users/me/a b.txt'")
        let term = SearchItem(id: "finder:terminal", kind: .command, title: "T", feature: "finder", data: ["command": "terminal"])
        _ = await f.run(action: "terminal:Ghostty", on: .row(term), modifiers: [])
        #expect(runner.recorded.last?.args.last == "--working-directory=/Users/me")
        // Moves and new files are only planned in headless runs.
        #expect(f.move(["/nonexistent/x"], to: "/nonexistent-n3-\(UUID().uuidString)") == .hide(message: "Moved 1 item"))
        #expect(f.newFile(folder: "/tmp", name: "a/b", open: false) == .error("File names cannot contain “/”"))
    }
}

@Suite("processes")
struct ProcessTests {
    @Test func policy() {
        #expect(ProcessPolicy.parsePortQuery("port 3000") == 3000)
        #expect(ProcessPolicy.parsePortQuery("kill port 8080") == 8080)
        #expect(ProcessPolicy.parsePortQuery(":5173") == 5173)
        #expect(ProcessPolicy.parsePortQuery("port:22") == 22)
        #expect(ProcessPolicy.parsePortQuery("port 70000") == nil)
        #expect(ProcessPolicy.parsePortQuery("portal") == nil)
        #expect(ProcessPolicy.processName("/Applications/Safari.app/Contents/MacOS/Safari") == "Safari")
        #expect(ProcessPolicy.processName("/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper") == "Slack Helper")
        #expect(ProcessPolicy.appBundle(of: "/Applications/Safari.app/Contents/MacOS/Safari") == "/Applications/Safari.app")
        #expect(ProcessPolicy.processName("/usr/sbin/mDNSResponder") == "mDNSResponder")
        #expect(ProcessPolicy.killRisk(pid: 1, name: "launchd", command: "/sbin/launchd", selfPids: []) != .ok)
        #expect(ProcessPolicy.killRisk(pid: 400, name: "WindowServer", command: "/System/Library/WindowServer", selfPids: []) != .ok)
        #expect(ProcessPolicy.killRisk(pid: 55, name: "x", command: "/x", selfPids: [55]) == .warn("This is Glide itself. Glide will quit."))
        #expect(ProcessPolicy.killRisk(pid: 999, name: "node", command: "/usr/local/bin/node", selfPids: []) == .ok)
        #expect(ProcessPolicy.unkillable(0) && ProcessPolicy.unkillable(1) && !ProcessPolicy.unkillable(2))
        #expect(ProcessPolicy.formatKb(512) == "512 KB")
        #expect(ProcessPolicy.formatKb(2048) == "2.0 MB")
        #expect(ProcessPolicy.formatKb(3 * 1024 * 1024) == "3.0 GB")
        #expect(ProcessPolicy.cpuPercent(prevNs: 1_000, nowNs: 501_000, wallNs: 1_000_000) == 50)
        #expect(ProcessPolicy.cpuPercent(prevNs: nil, nowNs: 5, wallNs: 10) == 0)
    }

    @Test func libprocReadsOwnProcess() async throws {
        let sampler = ProcessSampler()
        _ = sampler.sample()
        var x = 0.0
        for i in 0..<3_000_000 { x += Double(i % 7) } // burn a little CPU
        #expect(x > 0)
        let list = sampler.sample()
        let me = try #require(list.first { $0.pid == getpid() })
        #expect(me.rssKb > 0)
        #expect(me.user == String(cString: getpwuid(getuid()).pointee.pw_name))
        #expect(list.count > 10)
    }

    @Test func findsOwnListeningSocket() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        #expect(fd >= 0)
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let b = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        #expect(b == 0)
        #expect(listen(fd, 1) == 0)
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        let port = Int(UInt16(bigEndian: addr.sin_port))
        let found = ProcessSampler.listeners(port: port)
        #expect(found.first?.pid == getpid())
        #expect(found.first?.address == "127.0.0.1:\(port)")
    }

    @Test @MainActor func signalIsConfirmedAndNeverReal() async {
        let ctx = N3Context("processes")
        let f = ProcessesFeature()
        var sent: [(Int32, Int32)] = []
        f.signaler = { sent.append(($0, $1)); return 0 }
        await f.start(context: ctx)
        #expect(await f.signal(pid: 1, force: false, expected: nil) == .error("launchd (PID 1) cannot be killed from Glide"))
        // Our own pid: risk text in the confirmation, signal goes to the fake only.
        let r = await f.signal(pid: getpid(), force: true, expected: nil)
        #expect(sent.count == 1 && sent[0].0 == getpid() && sent[0].1 == SIGKILL)
        if case let .stay(m) = r { #expect(m?.hasPrefix("Force quit") == true) } else { Issue.record("unexpected \(r)") }
        let confirm = ctx.effects("confirm").first
        #expect(confirm?["message"]?.stringValue?.contains("Glide itself") == true)
        // Wrong expected command (pid reuse) refuses.
        #expect(await f.signal(pid: getpid(), force: false, expected: "/bin/other") == .error("PID \(getpid()) is now a different process; refresh and try again"))
        #expect(sent.count == 1)
    }

    @Test @MainActor func cancelledConfirmationSendsNothing() async {
        let ctx = N3Context("processes", env: ["GLIDE_HEADLESS_CONFIRM": "0"])
        let f = ProcessesFeature()
        var sent = 0
        f.signaler = { _, _ in sent += 1; return 0 }
        await f.start(context: ctx)
        #expect(await f.signal(pid: getpid(), force: false, expected: nil) == .stay(message: "Cancelled"))
        #expect(sent == 0)
    }
}

@Suite("system monitor")
struct SysmonTests {
    @Test func math() {
        let a = [Sysmon.CPUTicks(user: 100, system: 50, idle: 850, nice: 0)]
        let b = [Sysmon.CPUTicks(user: 150, system: 100, idle: 900, nice: 0)]
        #expect(Sysmon.cpuDeltas(a, b) == [100.0 / 150.0])
        #expect(Sysmon.cpuDeltas([], b) == [0])
        let m = Sysmon.memory(pageSize: 4096, anonymous: 1000, purgeable: 200, wired: 100, compressed: 50, fileBacked: 300, total: 100 * 4096 * 100)
        #expect(m.appBytes == 800 * 4096)
        #expect(m.usedBytes == 950 * 4096)
        #expect(m.cachedBytes == 500 * 4096)
        #expect(Sysmon.counterDelta(10, 30) == 20)
        #expect(Sysmon.counterDelta(UInt64(UInt32.max) - 4, 5) == 10)
        #expect(Sysmon.isSysmonQuery("cpu") && Sysmon.isSysmonQuery("batt") && !Sysmon.isSysmonQuery("ba") && !Sysmon.isSysmonQuery("safari"))
        #expect(Sysmon.formatBytes(512) == "512 B")
        #expect(Sysmon.formatBytes(1536) == "1.5 KB")
        #expect(Sysmon.formatUptime(90_061) == "1d 1h")
        #expect(Sysmon.formatUptime(3_700) == "1h 1m")
    }

    @Test @MainActor func readsTheMachine() {
        #expect(!Sysmon.cpuTicks().isEmpty)
        #expect((Sysmon.memory()?.totalBytes ?? 0) > 0)
        #expect((Sysmon.disk()?.totalBytes ?? 0) > 0)
        #expect(Sysmon.loadAverage().count == 3)
        let s = SysmonSampler()
        s.sample(record: true)
        let x = s.sample(record: true)
        #expect(s.history.cpu.count == 2)
        #expect((0...1).contains(x.cpuTotal))
        let g = SystemMonitorFeature.glance(x)
        #expect(g.title.hasPrefix("CPU "))
        #expect(g.subtitle.contains("⏎ System Monitor"))
    }

    @Test @MainActor func glanceRowInRootSearch() async {
        let f = SystemMonitorFeature()
        await f.start(context: N3Context("sysmon"))
        let rows = await f.dynamicItems(for: DynamicQuery(text: "cpu", deadline: .now + .seconds(1)))
        #expect(rows.first?.item.id == "sysmon:glance")
        #expect(rows.first?.item.kind == .calculator)
        #expect(await f.dynamicItems(for: DynamicQuery(text: "saf", deadline: .now + .seconds(1))).isEmpty)
    }
}

@Suite("keyboard")
struct KeyboardTests {
    @Test func recorder() {
        var r = HotkeyRecorderLogic()
        #expect(r.feed(.keyDown(key: "Space", mods: [.alt], time: 0)) == .recorded("Alt+Space"))
        #expect(r.feed(.keyDown(key: "K", mods: [.cmd, .shift, .ctrl], time: 0)) == .recorded("Control+Shift+Command+K"))
        #expect(r.feed(.keyDown(key: "K", mods: [], time: 0)) == .none)
        #expect(r.feed(.keyDown(key: "Escape", mods: [], time: 0)) == .cancelled)
        // Double ⌘.
        #expect(r.feed(.modifier(.cmd, side: "left", down: true, time: 1.0)) == .none)
        #expect(r.feed(.modifier(.cmd, side: "left", down: false, time: 1.1)) == .none)
        #expect(r.feed(.modifier(.cmd, side: "left", down: true, time: 1.2)) == .none)
        #expect(r.feed(.modifier(.cmd, side: "left", down: false, time: 1.3)) == .recorded("Double+Command"))
        // Right ⌥ alone, resolved once the double window passed.
        #expect(r.feed(.modifier(.alt, side: "right", down: true, time: 5.0)) == .none)
        #expect(r.feed(.modifier(.alt, side: "right", down: false, time: 5.05)) == .none)
        #expect(r.feed(.tick(time: 5.2)) == .none)
        #expect(r.feed(.tick(time: 5.6)) == .recorded("Right+Alt"))
        // Modifier used in a chord is not a tap.
        #expect(r.feed(.modifier(.cmd, side: "left", down: true, time: 9)) == .none)
        #expect(r.feed(.modifier(.shift, side: "left", down: true, time: 9.01)) == .none)
        #expect(r.feed(.modifier(.shift, side: "left", down: false, time: 9.02)) == .none)
        #expect(r.feed(.modifier(.cmd, side: "left", down: false, time: 9.03)) == .none)
        #expect(r.feed(.tick(time: 10)) == .none)
        for a in ["Alt+Space", "Double+Command", "Right+Alt", "Control+Shift+Command+K"] {
            if case .failure = HotkeyParser.parse(a) { Issue.record("\(a) does not parse") }
        }
        #expect(HotkeyRecorderLogic.keyName(keyCode: 49, characters: " ") == "Space")
        #expect(HotkeyRecorderLogic.keyName(keyCode: 0, characters: "a") == "A")
    }

    @Test @MainActor func config() {
        let snippets = [Snippet(id: "1", name: "sig", text: "Best", keyword: ";sig"), Snippet(id: "2", name: "sig2", text: "B2", keyword: ";sig2"), Snippet(id: "3", name: "none", text: "x")]
        let c = KeyboardFeature.buildConfig(expandSnippets: true, hyperKey: "capslock", snippets: snippets, contributed: nil, accessibility: true, pasteStack: false)
        #expect(c.snippets.map(\.keyword) == [";sig2", ";sig"])
        #expect(c.hyperKey)
        #expect(KeyboardFeature.buildConfig(expandSnippets: true, hyperKey: "capslock", snippets: snippets, contributed: nil, accessibility: false, pasteStack: true) == KeyboardTapConfig())
        #expect(KeyboardFeature.hotkeyAfterTakeover("") == "Alt+Space")
        #expect(KeyboardFeature.hotkeyAfterTakeover("Command+Space") == "Alt+Space")
        #expect(KeyboardFeature.hotkeyAfterTakeover("Control+Space") == "Control+Space")
    }

    @Test @MainActor func takeoverAndHyperOnlyThroughFakes() async throws {
        let ctx = N3Context("keyboard")
        ctx.store.setSettings { $0.hotkey = "Control+Space" }
        let f = KeyboardFeature()
        await f.start(context: ctx)
        _ = try await f.invoke(method: "setUseCommandSpace", args: true)
        #expect(ctx.store.settings.hotkey == "Command+Space")
        #expect(ctx.effects("spotlight-shortcut").last == ["enabled": false])
        _ = try await f.invoke(method: "setUseCommandSpace", args: false)
        #expect(ctx.store.settings.hotkey == "Control+Space")
        #expect(ctx.effects("spotlight-shortcut").last == ["enabled": true])
        _ = try await f.invoke(method: "setHyperKey", args: "capslock")
        #expect(ctx.effects("keyboard-tap-config").last?["hyper"] == true)
        await #expect(throws: FeatureError.self) { try await f.invoke(method: "setHotkey", args: "Bogus+") }
        _ = try await f.invoke(method: "setHotkey", args: "Double+Command")
        #expect(ctx.store.settings.hotkey == "Double+Command")
    }
}

@Suite("windows, menus, syscmds, nav")
struct MiscTests {
    @Test @MainActor func windowsCommandsAndSuggestedHotkeys() async {
        let ctx = N3Context("windows")
        let f = WindowsFeature()
        f.hideDelay = .zero
        await f.start(context: ctx)
        #expect(f.items().count == 24)
        #expect(f.items().allSatisfy { $0.id.hasPrefix("windows.") && $0.hotkey == nil })
        #expect(ctx.hotkeys.isEmpty)
        _ = try? await f.invoke(method: "setSuggestedHotkeys", args: true)
        #expect(ctx.hotkeys["left-half"] == "Control+Alt+Left")
        #expect(f.items().first { $0.id == "windows.maximize" }?.hotkey == "⌃⌥↩")
        ctx.hotkeyHandlers["left-half"]?()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(ctx.effects("window").last == ["action": "left-half"])
        let item = f.items().first { $0.id == "windows.next-display" }!
        #expect(await f.run(action: "apply", on: .row(item), modifiers: []) == .hide())
        #expect(ctx.effects("window").last == ["action": "next-display"])
        #expect(ctx.hidden == 1)
    }

    @Test @MainActor func menuRows() {
        let items = [MenuItemInfo(path: ["File", "New Window"], enabled: true, shortcut: "⌘N"), MenuItemInfo(path: ["Edit", "Copy"], enabled: false, shortcut: "⌘C"),
                     MenuItemInfo(path: ["View", "Show Sidebar"], enabled: true, shortcut: nil)]
        let all = MenusFeature.rows(items, query: "")
        #expect(all.map(\.item.title) == ["New Window", "Show Sidebar", "Copy"]) // disabled last
        #expect(all[0].item.subtitle == "File")
        #expect(MenusFeature.rows(items, query: "sidebar").first?.item.title == "Show Sidebar")
    }

    @Test @MainActor func menuSearchPressesInTarget() async {
        let ctx = N3Context("menus")
        let f = MenusFeature()
        f.hideDelay = .zero
        await f.start(context: ctx)
        let r = await f.run(action: "open", on: .row(f.items()[0]), modifiers: [])
        guard case .pushView("menus.search", _) = r else { Issue.record("\(r)"); return }
        #expect(f.model.items.count == 2)
        #expect(f.handleCommand(.move(delta: 1), view: "menus.search"))
        #expect(f.nav.index == 1)
        #expect(f.handleCommand(.activate([]), view: "menus.search"))
        try? await Task.sleep(for: .milliseconds(50))
        #expect(ctx.effects("menu-press").last == ["path": ["Edit", "Copy"]])
    }

    @Test @MainActor func syscmdsPlanConfirmAndRecord() async {
        let ctx = N3Context("syscmds")
        let f = SysCmdsFeature()
        let runner = HeadlessStepRunner(echo: false)
        runner.canned["/usr/bin/defaults read com.apple.finder AppleShowAllFiles"] = StepOutput(status: 0, stdout: "1\n", stderr: "")
        f.runner = runner
        await f.start(context: ctx)
        #expect(SysCmdsFeature.parseDefaultsBool("YES", fallback: false))
        #expect(!SysCmdsFeature.parseDefaultsBool("0", fallback: true))
        #expect(SysCmdsFeature.parseDefaultsBool("", fallback: true))
        let hidden = f.items().first { $0.id == "syscmds:toggleHiddenFiles" }!
        #expect(await f.run(action: "run", on: .row(hidden), modifiers: []) == .hide(message: "Hidden files are now hidden"))
        #expect(runner.recorded.map { ([$0.cmd] + $0.args).joined(separator: " ") } == [
            "/usr/bin/defaults read com.apple.finder AppleShowAllFiles",
            "/usr/bin/defaults write com.apple.finder AppleShowAllFiles -bool false",
            "/usr/bin/killall Finder",
        ])
        let restart = f.items().first { $0.id == "syscmds:restartFinder" }!
        _ = await f.run(action: "run", on: .row(restart), modifiers: [])
        #expect(ctx.effects("confirm").count == 1)
        #expect(f.items().count == 7)
    }

    @Test @MainActor func navApply() {
        let n = SysListNav()
        #expect(n.apply(.move(delta: 3), count: 10) == .moved)
        #expect(n.index == 3)
        #expect(n.apply(.goto(.last), count: 10) == .moved)
        #expect(n.index == 9)
        n.sync(query: "x", count: 4)
        #expect(n.index == 0)
        #expect(n.apply(.activate([.command]), count: 4) == .activate([.command]))
        #expect(n.apply(.pop, count: 4) == nil)
    }
}
