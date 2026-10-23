import AppKit
import GlideCore
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
                if config.testServer {
                    let server = TestServer(core: core)
                    testServer = server
                    server.start()
                } else if !config.headless {
                    statusItem = StatusItemController(hotkeyDisplay: Accelerator.display(core.store.settings.hotkey),
                                                      onShow: { core.launcher.show() }, onSettings: { core.openSettings(page: nil) })
                    core.statusTitleSink = { [weak statusItem] t in statusItem?.setTitle(t) }
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
        core?.launcher.show()
        return false
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        // glide:// deep links — phase 1 routes them (glide://show, glide://settings/<page>, glide://run/<item id>).
        for url in urls where url.scheme == "glide" {
            switch url.host {
            case "settings": core?.openSettings(page: url.path.isEmpty ? nil : String(url.path.dropFirst()))
            default: core?.launcher.show()
            }
        }
    }
}
