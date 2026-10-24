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
        if !SingleInstance.acquire(in: config.dataDirectory) {
            // Another native Glide owns this data directory: ask it to show and leave.
            DistributedNotificationCenter.default().postNotificationName(SingleInstance.showNotification, object: nil, userInfo: nil, deliverImmediately: true)
            if config.testServer { StdoutWriter.shared.line(#"{"event":"error","ok":false,"error":"another instance holds the data directory lock"}"#) }
            exit(2)
        }
        do {
            let core = try AppCore(config: config)
            self.core = core
            Task { @MainActor in
                await core.start()
                core.appFeature.onQuit = { NSApp.terminate(nil) }
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
                if config.testServer {
                    let server = TestServer(core: core)
                    testServer = server
                    server.start()
                } else if !config.headless {
                    DistributedNotificationCenter.default().addObserver(forName: SingleInstance.showNotification, object: nil, queue: .main) { _ in
                        MainActor.assumeIsolated { core.launcher.show() }
                    }
                }
            }
        } catch {
            FileHandle.standardError.write(Data("[glide] failed to start: \(error)\n".utf8))
            exit(1)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let core else { return .terminateNow }
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
