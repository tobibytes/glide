import AppKit
import GlideCore
import GlideFeatures
import GlideSystem

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let config: AppConfig
    var core: AppCore?
    var statusItem: StatusItemController?
    var testServer: TestServer?

    init(config: AppConfig) { self.config = config }

    func applicationDidFinishLaunching(_ note: Notification) {
        if SingleInstance.acquire(in: config.dataDirectory) { launch(); return }
        if config.headless || config.testServer {
            if config.testServer { StdoutWriter.shared.line(#"{"event":"error","ok":false,"error":"another instance holds the data directory lock"}"#) }
            exit(2)
        }
        // Another Glide owns this data directory: ask it to show the launcher. If it doesn't answer, it's stuck
        // (it would otherwise make Glide impossible to open), so offer to force quit it and start fresh.
        Task { @MainActor in
            if await Self.askRunningGlideToShow() { exit(0) }
            if offerToReplaceStuckGlide() { launch() } else { exit(0) }
        }
    }

    /// Posts the show request and waits up to 3 s for the running Glide's answer.
    static func askRunningGlideToShow() async -> Bool {
        let flag = ShutdownFlag()
        let center = DistributedNotificationCenter.default()
        let token = center.addObserver(forName: SingleInstance.shownNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { flag.done = true }
        }
        defer { center.removeObserver(token) }
        center.postNotificationName(SingleInstance.showNotification, object: nil, userInfo: nil, deliverImmediately: true)
        let started = Date()
        while !flag.done, Date().timeIntervalSince(started) < 3 { try? await Task.sleep(for: .milliseconds(50)) }
        return flag.done
    }

    /// Alert for a running Glide that doesn't respond. Force quits it (only a process with Glide's bundle id,
    /// recorded in the lock file) and takes the lock over. true = continue launching this one.
    func offerToReplaceStuckGlide() -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Glide is already running but isn't responding"
        alert.informativeText = "Force quit it and open Glide again? Nothing you've saved is lost."
        alert.addButton(withTitle: "Force Quit and Open Glide")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        if let pid = SingleInstance.holderPID(in: config.dataDirectory), let app = NSRunningApplication(processIdentifier: pid),
           app.bundleIdentifier == Bundle.main.bundleIdentifier {
            app.forceTerminate()
        }
        let started = Date()
        while Date().timeIntervalSince(started) < 5 {
            if SingleInstance.acquire(in: config.dataDirectory) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        let fail = NSAlert()
        fail.messageText = "Glide couldn't restart"
        fail.informativeText = "Quit Glide in Activity Monitor, then open it again."
        fail.runModal()
        return false
    }

    /// Menu bar icon, hotkeys and the "show" handshake come up first, so Glide can be opened even while features
    /// are still starting; features then start in the background.
    private func launch() {
        do {
            let core = try AppCore(config: config)
            self.core = core
            core.appFeature.onQuit = { GlideQuit.request() }
            // Glide's icon through the shared status-item API: an NSStatusItem live, recorded state only headless.
            let item = StatusItemController(service: core.services.statusItems, hotkeyDisplay: Accelerator.display(core.store.settings.hotkey),
                                            onShow: { core.launcher.show() }, onSettings: { core.openSettings(page: nil) },
                                            onCheckUpdates: {
                                                // Always a fresh check; the About page shows its result as it arrives.
                                                Task { await (core.registry.feature("app") as? AppFeature)?.check() }
                                                core.openSettings(page: "about")
                                            })
            statusItem = item
            core.statusTitleSink = { [weak item] t in item?.setTitle(t) }
            if !config.headless && !config.testServer {
                DistributedNotificationCenter.default().addObserver(forName: SingleInstance.showNotification, object: nil, queue: .main) { _ in
                    MainActor.assumeIsolated {
                        core.launcher.show()
                        DistributedNotificationCenter.default().postNotificationName(SingleInstance.shownNotification, object: nil, userInfo: nil,
                                                                                    deliverImmediately: true)
                    }
                }
            }
            core.launcher.registerHotkeys()
            Task { @MainActor in
                await core.start()
                if config.testServer {
                    let server = TestServer(core: core)
                    testServer = server
                    server.start()
                }
            }
        } catch {
            FileHandle.standardError.write(Data("[glide] failed to start: \(error)\n".utf8))
            let alert = NSAlert()
            alert.messageText = "Glide couldn't start"
            alert.informativeText = "\(error.localizedDescription)\n\nIf this keeps happening, report it at github.com/tobibytes/glide/issues."
            if !config.headless { alert.runModal() }
            exit(1)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let core else { return .terminateNow }
        // Last resort: if shutdown somehow never replies, exit anyway so Quit (and update restarts) always work.
        Thread.detachNewThread {
            Thread.sleep(forTimeInterval: 8)
            exit(0)
        }
        Task { @MainActor in
            await core.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Dock-icon click while Settings / AI Chat is open (Glide is .regular then): AppKit brings those windows
        // back (incl. a minimized one); the launcher only when Glide has no regular window.
        if GlideWindows.shared.hasOpenWindows { return true }
        core?.launcher.show()
        return false
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        // glide:// deep links — phase 1 routes them (glide://show, glide://settings/<page>, glide://run/<item id>).
        for url in urls where url.scheme == "glide" {
            switch url.host {
            case "settings": core?.openSettings(page: url.path.isEmpty ? nil : String(url.path.dropFirst()))
            case "oauth":
                // Raycast extension sign-in coming back from the browser (PKCEClient redirect URI).
                if let core { Task { @MainActor in _ = try? await core.registry.invoke(feature: "extensions", method: "oauthRedirect", args: ["url": .string(url.absoluteString)]) } }
            default: core?.launcher.show()
            }
        }
    }
}
