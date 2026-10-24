import Darwin
import Foundation
import GlideTestHarness
import Testing

// N8 end-to-end checks: onboarding, appearance, menu bar, sync, updates and the General page, driven over the
// headless test channel. Nothing appears on screen; the update feed is a 127.0.0.1 stub in this process.

private let n8Snapshots = ProcessInfo.processInfo.environment["GLIDE_SNAPSHOT_DIR"]
    ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-snapshots").path

private func result(_ r: [String: Any]) -> [String: Any] { r["result"] as? [String: Any] ?? [:] }
private func wait(_ d: GlideDriver, until: () throws -> Bool, timeout: TimeInterval = 5) throws -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if try until() { return true }
        _ = try d.send(["cmd": "ping"])
        Thread.sleep(forTimeInterval: 0.1)
    }
    return try until()
}

/// Minimal HTTP stub on 127.0.0.1 (ephemeral port).
private final class N8Stub: @unchecked Sendable {
    let port: UInt16
    private let fd: Int32
    private let routes: [String: Data]
    init(routes: [String: Data]) throws {
        self.routes = routes
        let s = socket(AF_INET, SOCK_STREAM, 0)
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        guard withUnsafePointer(to: &addr, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, len) } }) == 0, listen(s, 8) == 0 else { throw GlideDriver.DriverError.exited }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) } }
        fd = s
        port = UInt16(bigEndian: addr.sin_port)
        Thread.detachNewThread { [weak self] in self?.loop() }
    }
    private func loop() {
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 { return }
            var buf = [UInt8](repeating: 0, count: 4096)
            let n = read(c, &buf, buf.count)
            let path = String(decoding: buf[0..<max(0, n)], as: UTF8.self).split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            let body = routes[path]
            let head = "HTTP/1.1 \(body == nil ? 404 : 200) X\r\nContent-Length: \(body?.count ?? 0)\r\nConnection: close\r\n\r\n"
            _ = head.withCString { write(c, $0, strlen($0)) }
            body?.withUnsafeBytes { p in _ = write(c, p.baseAddress, p.count) }
            close(c)
        }
    }
    deinit { close(fd) }
}

@Suite("N8 headless driver checks", .serialized)
struct N8E2E {
    @Test func onboardingFirstRunFlowAndSnapshots() throws {
        let d = try GlideDriver()
        defer { d.stop() }
        // Fresh install: the tour opens (state only) after ~0.9 s.
        #expect(try wait(d) { result(try d.invoke("onboarding", "getState"))["windowOpen"] as? Bool == true })
        var st = result(try d.invoke("onboarding", "getState"))
        #expect((st["firstRun"] as? [String: Any])?["reason"] as? String == "first-run")
        #expect(st["step"] as? String == "welcome")
        try FileManager.default.createDirectory(atPath: n8Snapshots, withIntermediateDirectories: true)
        for step in ["welcome", "hotkey", "permissions", "ai", "look", "done"] {
            let snap = result(try d.invoke("onboarding", "snapshot", ["step": step, "path": "\(n8Snapshots)/n8-onboarding-\(step).png"]))
            #expect(snap["width"] as? Int == 1440, "onboarding \(step) snapshot")
        }
        st = result(try d.invoke("onboarding", "key", ["key": "Enter"]))
        #expect(st["step"] as? String == "hotkey")
        st = result(try d.invoke("onboarding", "key", ["key": "j"]))
        #expect(st["listIndex"] as? Int == 1)
        st = result(try d.invoke("onboarding", "key", ["key": "k"]))
        st = result(try d.invoke("onboarding", "key", ["key": "Enter"])) // ⌥Space is current → continue
        #expect(st["step"] as? String == "permissions")
        #expect(((st["permissions"] as? [String: Any])?["status"] as? [String: Any])?.count == 5)
        st = result(try d.invoke("onboarding", "openPermissionSettings", ["kind": "accessibility"]))
        #expect(d.sideEffects.contains { $0.kind == "open-url" && $0.detail.contains("Privacy_Accessibility") })
        _ = try d.invoke("onboarding", "setStep", ["step": "look"])
        st = result(try d.invoke("onboarding", "key", ["key": "j"]))
        let theme = st["activeTheme"] as? String
        #expect(theme != nil && theme != "glide-dark") // themes apply as they get focus
        _ = try d.invoke("onboarding", "finish")
        st = result(try d.invoke("onboarding", "getState"))
        #expect((st["settings"] as? [String: Any])?["completed"] as? Bool == true)
        #expect(st["windowOpen"] as? Bool == false)
        let data = result(try d.invoke("store", "data"))
        #expect(((data["settings"] as? [String: Any])?["features"] as? [String: Any])?["onboarding"] != nil)
    }

    @Test func existingInstallSkipsOnboarding() throws {
        let usage = Data(#"[{"itemId":"app:/System/Applications/Notes.app","launches":[1700000000000],"count":1,"lastLaunchedAt":1700000000000}]"#.utf8)
        let d = try GlideDriver(seed: ["usage.json": usage])
        defer { d.stop() }
        Thread.sleep(forTimeInterval: 1.2)
        let st = result(try d.invoke("onboarding", "getState"))
        #expect((st["firstRun"] as? [String: Any])?["reason"] as? String == "existing-install")
        #expect(st["windowOpen"] as? Bool == false)
    }

    @Test func switchThemeLivePreviewAndAppearanceSnapshots() throws {
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1"])
        defer { d.stop() }
        _ = try d.show()
        try d.type("switch theme")
        #expect(try d.selectedTitle() == "Switch Theme")
        var s = try d.key("enter")
        #expect(s["view"] as? String == "appearance.switch")
        let before = s["theme"] as? String
        s = try d.key("j")
        let previewed = s["theme"] as? String
        #expect(previewed != before) // the launcher itself re-themes while moving
        let sw = result(try d.invoke("appearance", "switcherState"))
        #expect(sw["preview"] as? String == previewed)
        _ = try d.snapshot("\(n8Snapshots)/n8-launcher-switch-theme.png")
        s = try d.key("enter")
        #expect(s["toast"] as? String == "Theme: \(Self.name(previewed))")
        let st = result(try d.invoke("appearance", "get"))
        #expect(st["active"] as? String == previewed)
        s = try d.key("esc")
        for (view, extra) in [("settings", [String: Any]()), ("switch", ["selected": 2])] {
            var args: [String: Any] = ["view": view, "path": "\(n8Snapshots)/n8-appearance-\(view).png"]
            args.merge(extra) { $1 }
            let snap = result(try d.invoke("appearance", "snapshot", args))
            #expect((snap["width"] as? Int ?? 0) > 0)
        }
        // Material + translucency persisted in the appearance bag.
        _ = try d.invoke("appearance", "set", ["material": "sidebar", "translucency": 60])
        let after = result(try d.invoke("appearance", "get"))["settings"] as? [String: Any]
        #expect(after?["material"] as? String == "sidebar" && after?["translucency"] as? Int == 60)
        let snap = result(try d.invoke("app", "snapshotGeneral", ["path": "\(n8Snapshots)/n8-settings-general.png"]))
        #expect((snap["width"] as? Int ?? 0) > 0)
    }

    static func name(_ id: String?) -> String {
        ["glide-dark": "Glide Dark", "glide-light": "Glide Light", "midnight": "Midnight", "nord": "Nord", "solarized": "Solarized", "dracula": "Dracula",
         "mocha": "Mocha", "dawn": "Dawn", "high-contrast": "High Contrast"][id ?? ""] ?? ""
    }

    @Test func menuBarHeadlessStateOnly() throws {
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1"])
        defer { d.stop() }
        _ = try d.invoke("menubar", "inject", ["source": "timers.state", "data": ["timers": [["id": "t1", "name": "Tea", "durationMs": 180_000, "startedAt": Date().timeIntervalSince1970 * 1000, "pausedMs": 0]], "presets": [["id": "p", "name": "Pomodoro", "durationMs": 1_500_000]]]])
        _ = try d.invoke("menubar", "setSettings", ["sysmon": true])
        var st = result(try d.invoke("menubar", "tick"))
        let items = st["items"] as? [[String: Any]] ?? []
        #expect(Set(items.compactMap { $0["id"] as? String }) == ["timers", "sysmon"])
        #expect(items.allSatisfy { $0["rendered"] as? Bool == false }) // never a real status item headless
        let timerTitle = items.first { $0["id"] as? String == "timers" }?["title"] as? String
        #expect(timerTitle?.hasPrefix("⏱ 2:") == true || timerTitle?.hasPrefix("⏱ 3:") == true)
        #expect((items.first { $0["id"] as? String == "sysmon" }?["title"] as? String)?.hasPrefix("CPU ") == true)
        // Click "Pause" in the Tea submenu → calls timers.toggle t1.
        let ok = try d.invoke("menubar", "click", ["id": "timers", "path": [0, 0]])["result"] as? Bool
        #expect(ok == true)
        st = result(try d.invoke("menubar", "state"))
        let calls = st["calls"] as? [[String: Any]] ?? []
        #expect(calls.last?["method"] as? String == "toggle" && calls.last?["args"] as? String == "t1")
        try d.type("menu bar")
        #expect(try d.titles().contains("Hide System Monitor in Menu Bar"))
    }

    @Test func syncThroughFolder() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("glide-n8-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        // Another Mac's file, written the way the Electron app writes it.
        let other = #"{"app":"glide","version":1,"machine":"Other-Mac","exportedAt":4102444800000,"entries":{"settings.vimMode":{"v":false,"t":4102444800000,"m":"Other-Mac"},"quicklink.ql-other":{"v":{"id":"ql-other","name":"Other","url":"https://o"},"t":4102444800000,"m":"Other-Mac"}}}"#
        let syncDir = folder.appendingPathComponent("Glide Sync")
        try FileManager.default.createDirectory(at: syncDir, withIntermediateDirectories: true)
        try Data(other.utf8).write(to: syncDir.appendingPathComponent("Other-Mac.json"))
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1"])
        defer { d.stop() }
        _ = try d.invoke("sync", "setSettings", ["folder": folder.path, "machine": "This-Mac"])
        let r = result(try d.invoke("sync", "syncNow"))
        #expect(r["ok"] as? Bool == true, "\(r)")
        let data = result(try d.invoke("store", "data"))
        #expect((data["settings"] as? [String: Any])?["vimMode"] as? Bool == false)
        #expect((data["quicklinks"] as? [[String: Any]])?.contains { $0["id"] as? String == "ql-other" } == true)
        #expect(FileManager.default.fileExists(atPath: syncDir.appendingPathComponent("This-Mac.json").path))
        let st = result(try d.invoke("sync", "status"))
        #expect((st["backups"] as? [Any])?.count == 1)
    }

    @Test func updaterAgainstLocalStub() throws {
        let rel: [String: Any] = ["tag_name": "v2.0.0", "name": "Glide 2", "body": "", "html_url": "https://example.invalid", "draft": false, "prerelease": false,
                                  "assets": [["name": "Glide-darwin-arm64.zip", "browser_download_url": "http://127.0.0.1:1/z"],
                                             ["name": "Glide-darwin-arm64.zip.sha256", "browser_download_url": "http://127.0.0.1:1/s"],
                                             ["name": "Glide-darwin-x64.zip", "browser_download_url": "http://127.0.0.1:1/x"]]]
        let stub = try N8Stub(routes: ["/repos/tobibytes/glide/releases/latest": try JSONSerialization.data(withJSONObject: rel)])
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1", "GLIDE_UPDATE_BASE_URL": "http://127.0.0.1:\(stub.port)", "GLIDE_APP_VERSION": "1.0.0", "GLIDE_UPDATE_ARCH": "arm64"])
        defer { d.stop() }
        #expect(try wait(d) { (result(try d.invoke("app", "info"))["update"] as? [String: Any])?["status"] as? String == "available" })
        let up = result(try d.invoke("app", "info"))["update"] as? [String: Any]
        #expect(up?["latestVersion"] as? String == "2.0.0" && up?["asset"] as? String == "Glide-darwin-arm64.zip")
        #expect(d.sideEffects.contains { $0.kind == "notify" && $0.detail.contains("2.0.0") })
        _ = try d.show()
        try d.type("update glide")
        #expect(try d.titles().contains("Update Glide to v2.0.0"))
        // Installing is refused headless (never replaces anything in tests).
        let after = result(try d.invoke("app", "install"))["update"] as? [String: Any]
        #expect((after?["error"] as? String)?.contains("headless") == true)
        // Launch at login: recorded, never registered with SMAppService headless.
        let li = result(try d.invoke("app", "setLaunchAtLogin", ["on": true]))
        #expect(((li["info"] as? [String: Any])?["loginItemLog"] as? [[String: Any]])?.count == 1)
    }

    /// On the latest version, Settings and About say so in plain words, and opening them again soon doesn't re-check.
    @Test func upToDateIsShownPlainly() throws {
        let rel: [String: Any] = ["tag_name": "v1.0.0", "name": "Glide 1.0.0", "body": "", "draft": false, "prerelease": false,
                                  "html_url": "https://example.invalid/r",
                                  "assets": [["name": "Glide-darwin-universal.zip", "browser_download_url": "http://127.0.0.1:1/z"],
                                             ["name": "Glide-darwin-universal.zip.sha256", "browser_download_url": "http://127.0.0.1:1/s"]]]
        let stub = try N8Stub(routes: ["/repos/tobibytes/glide/releases/latest": try JSONSerialization.data(withJSONObject: rel)])
        let d = try GlideDriver(environment: ["GLIDE_SKIP_ONBOARDING": "1", "GLIDE_UPDATE_BASE_URL": "http://127.0.0.1:\(stub.port)", "GLIDE_APP_VERSION": "1.0.0", "GLIDE_UPDATE_ARCH": "arm64"])
        defer { d.stop() }
        #expect(try wait(d) { (result(try d.invoke("app", "info"))["update"] as? [String: Any])?["status"] as? String == "up-to-date" })
        let info = result(try d.invoke("app", "info"))
        #expect((info["summary"] as? String) == "Glide is up to date. You have the latest version (1.0.0).")
        let checked = (info["update"] as? [String: Any])?["lastChecked"] as? Double
        let again = result(try d.invoke("app", "checkIfStale", ["maxAge": 3600]))
        #expect((again["update"] as? [String: Any])?["lastChecked"] as? Double == checked)
        let forced = result(try d.invoke("app", "checkIfStale", ["maxAge": 0]))
        #expect(((forced["update"] as? [String: Any])?["lastChecked"] as? Double ?? 0) > (checked ?? 0))
    }
}
