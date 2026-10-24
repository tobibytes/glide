import AppKit
import GlideCore
import GlideFeatures
import GlideSystem
import GlideUI

/// Process configuration from arguments and environment.
struct AppConfig {
    var headless: Bool
    var testServer: Bool
    var dataDirectory: URL
    var verbose: Bool

    static func current() -> AppConfig {
        let env = ProcessInfo.processInfo.environment
        let args = CommandLine.arguments
        let testServer = args.contains("--test-server") || env["GLIDE_TEST_SERVER"] == "1"
        // The test server implies headless: tests must never put anything on the user's screen.
        let headless = env["GLIDE_HEADLESS"] == "1" || args.contains("--headless") || testServer
        return AppConfig(headless: headless, testServer: testServer, dataDirectory: GlidePaths.userDataDirectory(environment: env), verbose: env["GLIDE_VERBOSE"] == "1")
    }
}

/// Everything the app is made of, wired together. Built by AppDelegate.
@MainActor final class AppCore {
    let config: AppConfig
    let store: Store
    let services: SystemServices
    let sideEffects: SideEffectLog?
    let registry: FeatureRegistry
    let launcher: LauncherController
    let window: LauncherWindowController
    let appFeature = GlideAppFeature()
    var settingsWindow: SettingsWindowController?
    let startedAt = Date()
    private var contexts: [HostContext] = []
    private(set) var startupMs: Double = 0

    init(config: AppConfig) throws {
        let t0 = Date()
        self.config = config
        store = Store(directory: config.dataDirectory)
        try store.load()
        if config.headless {
            let log = SideEffectLog(echo: true)
            SideEffectLog.current = log
            sideEffects = log
            services = SystemServicesFactory.headless(log: log)
        } else {
            FaviconCache.networkAllowed = true // "url" icons may fetch favicons (never in headless runs)
            sideEffects = nil
            let frontmost = FrontmostTracker()
            frontmost.start()
            services = SystemServicesFactory.live(frontmost: frontmost)
            (services.permissions as? SystemPermissionService)?.startWatching()
            // Hotkey recorders (Settings, the tour) get the keyboard: suspend Glide's global hotkeys meanwhile.
            let hotkeys = services.hotkeys
            HotkeyCapture.onChange = { on in (hotkeys as? CarbonHotkeyService)?.setSuspended(on) }
            // Nothing listened to the 2 s permission poll: a keyboard tap / modifier hotkey that failed at launch
            // (permission not granted yet) only started after a relaunch. Retry when the status changes.
            if let perms = services.permissions as? SystemPermissionService {
                let tap = services.keyboardTap, earlier = perms.onChange
                perms.onChange = { status in
                    earlier?(status)
                    (tap as? EventTapKeyboardService)?.retryIfNeeded()
                    (hotkeys as? CarbonHotkeyService)?.permissionsChanged()
                }
            }
        }
        registry = FeatureRegistry(features: [appFeature] + AllFeatures.make())
        let verbose = config.verbose
        let logger: (String) -> Void = { msg in if verbose { FileHandle.standardError.write(Data("[glide] \(msg)\n".utf8)) } }
        registry.log = logger
        launcher = LauncherController(store: store, registry: registry, services: services, headless: config.headless, log: logger)
        window = LauncherWindowController(controller: launcher, headless: config.headless)
        window.openSettingsHandler = { [weak self] page in self?.openSettings(page: page) }
        let launcher = launcher, registry = registry
        appFeature.catalogue = { launcher.engine.allItems }
        appFeature.featureTitle = { registry.feature($0)?.title }
        appFeature.openItem = { item in launcher.openFromDirectory(item) }
        appFeature.tryQuery = { text in launcher.tryFromDirectory(text) }
        startupMs = Date().timeIntervalSince(t0) * 1000
    }

    func start() async {
        await registry.startAll { [unowned self] f in
            let ctx = HostContext(featureId: f.id, app: self)
            contexts.append(ctx) // the host owns contexts; features may hold them weakly
            return ctx
        }
        launcher.rebuildCatalogue()
        window.layout()
    }

    /// Feature titles next to the Glide menu-bar icon (`FeatureContext.setStatusTitle`), joined in feature order.
    private var statusTitles: [(feature: String, title: String)] = []
    var statusTitleSink: ((String) -> Void)? { didSet { statusTitleSink?(statusTitle) } }
    var statusTitle: String { statusTitles.map(\.title).filter { !$0.isEmpty }.joined(separator: "  ") }
    func setStatusTitle(feature: String, _ title: String) {
        if let i = statusTitles.firstIndex(where: { $0.feature == feature }) { statusTitles[i].title = title } else { statusTitles.append((feature, title)) }
        statusTitleSink?(statusTitle)
    }

    func log(_ s: String) { if config.verbose { FileHandle.standardError.write(Data("[glide] \(s)\n".utf8)) } }

    func openSettings(page: String?) {
        if config.headless {
            sideEffects?.record("open-settings", ["page": page.map(JSONValue.string) ?? .null])
            // No window headless, but the page still receives its sub-route (so tests can check deep links).
            if let page, case let (pid, route?) = SettingsPage.split(page) { SettingsModel.deliver(core: self, page: pid, route: route) }
            return
        }
        if settingsWindow == nil { settingsWindow = SettingsWindowController(core: self) }
        settingsWindow?.show(page: page)
    }

    func shutdown() async {
        await registry.stopAll()
        services.hotkeys.unregisterAll()
        services.keyboardTap.shutdown()
        store.flush()
    }
}
