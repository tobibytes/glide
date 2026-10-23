import AppKit
import GlideCore
import GlideUI
import ServiceManagement
import SwiftUI

/// The "app" feature (same id and bag as the Electron app: `{ updateFeed, autoCheck }`): GitHub Releases
/// updater, Launch at Login (SMAppService — only ever on an explicit toggle), Show Data Folder, and the
/// "Updates & App" settings page. It also owns the Settings window's General page (GeneralSettingsView).
@MainActor public final class AppFeature: Feature, FeatureUI {
    public let id = "app"
    public let title = "Updates & App"
    private weak var context: FeatureContext?

    public struct UpdateState: Equatable, Sendable {
        public var status = "disabled" // disabled | idle | checking | up-to-date | available | installing | error
        public var latestVersion: String?
        public var releaseName: String?
        public var releaseNotes: String?
        public var releaseUrl: String?
        public var lastChecked: Double?
        public var phase: String?
        public var error: String?
    }

    public private(set) var update = UpdateState()
    private var candidate: UpdateCandidate?
    private var notifiedVersion: String?
    private var checkTimer: Timer?
    private var firstCheck: Task<Void, Never>?
    private var lastFeed = ""
    private var observation: StoreObservation?
    /// Login-item operations performed (headless: recorded instead of calling SMAppService).
    public private(set) var loginItemLog: [JSONValue] = []
    public private(set) var revision = 0

    static let checkInterval: TimeInterval = 6 * 3600
    public static let defaults: [String: JSONValue] = ["updateFeed": .string(Releases.defaultFeed), "autoCheck": true]

    public init() {}

    var headless: Bool { context?.services.isHeadless ?? true }
    var env: [String: String] { ProcessInfo.processInfo.environment }

    public var currentVersion: String {
        if headless, let v = env["GLIDE_APP_VERSION"], !v.isEmpty { return v }
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    /// The running .app bundle, or nil for a bare SwiftPM binary (dev build).
    public var bundlePath: URL? {
        let u = Bundle.main.bundleURL
        return u.pathExtension == "app" ? u : nil
    }

    var feedSetting: String { context?.settings(defaults: Self.defaults)["updateFeed"]?.stringValue ?? Releases.defaultFeed }
    var autoCheck: Bool { context?.settings(defaults: Self.defaults)["autoCheck"]?.boolValue ?? true }
    var baseUrl: String { env["GLIDE_UPDATE_BASE_URL"].flatMap { $0.isEmpty ? nil : $0 } ?? Releases.githubAPI }
    var backgroundAllowed: Bool { Releases.backgroundChecksAllowed(packaged: bundlePath != nil, headless: headless, testBaseUrl: env["GLIDE_UPDATE_BASE_URL"]) }

    public func start(context: FeatureContext) async {
        self.context = context
        lastFeed = feedSetting
        update.status = Releases.parseFeed(feedSetting) == nil ? "disabled" : "idle"
        observation = context.store.observe { [weak self] _ in Task { @MainActor in self?.reschedule() } }
        reschedule()
        if Releases.parseFeed(feedSetting) != nil, autoCheck, backgroundAllowed {
            let delay: Duration = env["GLIDE_UPDATE_BASE_URL"] != nil ? .milliseconds(200) : .seconds(15)
            firstCheck = Task { @MainActor [weak self] in
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
                _ = await self?.check()
            }
        }
    }

    public func stop() async {
        checkTimer?.invalidate()
        firstCheck?.cancel()
    }

    private func changed() {
        revision += 1
        context?.refreshCatalogue()
    }

    // MARK: updater

    private var lastKey = ""

    private func reschedule() {
        let key = "\(feedSetting)|\(autoCheck)"
        if key == lastKey { return }
        lastKey = key
        let feed = feedSetting
        let feedChanged = feed != lastFeed
        lastFeed = feed
        checkTimer?.invalidate()
        checkTimer = nil
        guard Releases.parseFeed(feed) != nil else {
            candidate = nil
            if update.status != "disabled" || feedChanged { update = UpdateState(); changed() }
            return
        }
        if feedChanged {
            candidate = nil
            update = UpdateState(status: "idle")
            changed()
        }
        guard autoCheck, backgroundAllowed else { return }
        checkTimer = Timer.scheduledTimer(withTimeInterval: Self.checkInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.backgroundCheck() }
        }
        if feedChanged {
            // Debounced so typing a feed does not fire requests.
            firstCheck?.cancel()
            firstCheck = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { return }
                _ = await self?.check()
            }
        }
    }

    private func backgroundCheck() { Task { @MainActor in await self.check() } }

    public func fetchLatest(feed: String) async throws -> ReleaseInfo? {
        guard let url = Releases.latestReleaseURL(feed: feed, baseUrl: baseUrl) else { throw FeatureError.failed("Bad update URL") }
        guard Releases.networkAllowed(url: url, headless: headless) else { throw FeatureError.failed("Network access is disabled in headless runs") }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Glide/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { throw FeatureError.failed("No published release found for \(feed)") }
        guard (200..<300).contains(code) else { throw FeatureError.failed("Update check failed: HTTP \(code)") }
        return Releases.parseRelease((try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null)
    }

    @discardableResult
    public func check() async -> UpdateState {
        guard let feed = Releases.parseFeed(feedSetting) else {
            candidate = nil
            update = UpdateState(status: "disabled", error: feedSetting.trimmingCharacters(in: .whitespaces).isEmpty ? nil : "\"\(feedSetting)\" is not an owner/repo feed")
            changed()
            return update
        }
        if update.status == "checking" || update.status == "installing" { return update }
        update.status = "checking"
        update.error = nil
        changed()
        do {
            let release = try await fetchLatest(feed: feed)
            let arch = headless ? (env["GLIDE_UPDATE_ARCH"] ?? Releases.currentArch) : Releases.currentArch
            candidate = Releases.pickUpdate(release, current: currentVersion, arch: arch)
            let now = Date().timeIntervalSince1970 * 1000
            if let c = candidate {
                update = UpdateState(status: "available", latestVersion: c.release.version, releaseName: c.release.name, releaseNotes: c.release.notes,
                                     releaseUrl: c.release.pageUrl, lastChecked: now)
                if notifiedVersion != c.release.version {
                    notifiedVersion = c.release.version
                    context?.services.notifications.notify(title: "Glide \(c.release.version) is available",
                                                           body: "You have \(currentVersion). Open Glide and choose “Update Glide to v\(c.release.version)”.")
                }
            } else {
                update = UpdateState(status: "up-to-date", latestVersion: release?.version, releaseUrl: release?.pageUrl, lastChecked: now)
            }
        } catch {
            candidate = nil
            context?.log("update check failed: \(error.localizedDescription)")
            update = UpdateState(status: "error", lastChecked: Date().timeIntervalSince1970 * 1000, error: error.localizedDescription)
        }
        changed()
        return update
    }

    @discardableResult
    public func install() async -> UpdateState {
        guard let c = candidate else {
            update.status = update.status == "disabled" ? "disabled" : "error"
            update.error = "No update is available to install. Check for updates first."
            changed()
            return update
        }
        guard !headless, let app = bundlePath else {
            update.status = "error"
            update.error = headless ? "Updates are never installed in headless runs." : "Updates can only be installed into a packaged Glide.app (this is a development build)."
            changed()
            return update
        }
        update.status = "installing"
        update.phase = UpdateInstaller.Phase.downloading.rawValue
        update.error = nil
        changed()
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("glide-update-\(Int(Date().timeIntervalSince1970 * 1000))", isDirectory: true)
        do {
            try await UpdateInstaller.install(.init(candidate: c, currentAppPath: app, workDir: work, headless: false,
                                                    trash: { url in try FileManager.default.trashItem(at: url, resultingItemURL: nil) },
                                                    onPhase: { [weak self] p in Task { @MainActor in self?.update.phase = p.rawValue; self?.changed() } }))
            update.phase = "done"
            changed()
            relaunch(app)
        } catch {
            update = UpdateState(status: "error", error: error.localizedDescription)
            changed()
        }
        return update
    }

    private func relaunch(_ app: URL) {
        context?.store.flush()
        // Start the new bundle once this process (which holds the single-instance lock) has exited.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open -n \"$0\"", app.path]
        try? p.run()
        NSApp.terminate(nil)
    }

    func updateJSON() -> JSONValue {
        var o: [String: JSONValue] = ["status": .string(update.status), "currentVersion": .string(currentVersion), "feed": .string(feedSetting)]
        if let v = update.latestVersion { o["latestVersion"] = .string(v) }
        if let v = update.releaseName { o["releaseName"] = .string(v) }
        if let v = update.releaseUrl { o["releaseUrl"] = .string(v) }
        if let v = update.lastChecked { o["lastChecked"] = .double(v) }
        if let v = update.phase { o["phase"] = .string(v) }
        if let v = update.error { o["error"] = .string(v) }
        if let c = candidate { o["asset"] = .string(c.zip.name) }
        return .object(o)
    }

    // MARK: launch at login

    public var launchAtLogin: Bool { context?.store.settings.launchAtLogin ?? false }

    /// Explicit user action only (General page toggle or the launcher command): never called at start.
    @discardableResult
    public func setLaunchAtLogin(_ on: Bool) -> (ok: Bool, message: String?) {
        context?.store.setSettings { $0.launchAtLogin = on }
        if headless {
            loginItemLog.append(["register": .bool(on)])
            changed()
            return (true, nil)
        }
        guard bundlePath != nil else { return (true, "Saved; takes effect in the packaged Glide.app") }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            changed()
            return (true, SMAppService.mainApp.status == .requiresApproval ? "Approve Glide in System Settings → General → Login Items" : nil)
        } catch {
            return (false, error.localizedDescription)
        }
    }

    var loginItemStatus: String {
        if headless || bundlePath == nil { return "unavailable" }
        switch SMAppService.mainApp.status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notRegistered: return "notRegistered"
        case .notFound: return "notFound"
        @unknown default: return "unknown"
        }
    }

    // MARK: settings

    public func setUpdateSettings(_ p: [String: JSONValue]) {
        var clean: [String: JSONValue] = [:]
        if let f = p["updateFeed"]?.stringValue {
            let t = f.trimmingCharacters(in: .whitespaces)
            clean["updateFeed"] = .string(t.isEmpty ? "" : (Releases.parseFeed(t) ?? t))
        }
        if let a = p["autoCheck"]?.boolValue { clean["autoCheck"] = .bool(a) }
        context?.setSettings(clean)
    }

    func info() -> JSONValue {
        ["version": .string(currentVersion), "packaged": .bool(bundlePath != nil), "userDataPath": .string(context?.store.directory.path ?? ""),
         "appPath": bundlePath.map { .string($0.path) } ?? .null, "launchAtLogin": .bool(launchAtLogin), "loginItemStatus": .string(loginItemStatus),
         "loginItemLog": .array(loginItemLog), "updateFeed": .string(feedSetting), "autoCheck": .bool(autoCheck), "update": updateJSON()]
    }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        var out = [
            SearchItem(id: "app:toggle-login", kind: .command, title: "Toggle Launch at Login", subtitle: launchAtLogin ? "On" : "Off", icon: .symbol("power.circle"),
                       keywords: ["startup", "login item", "autostart"], source: "app", feature: id, kindLabel: "Glide"),
            SearchItem(id: "app:check-updates", kind: .command, title: "Check for Glide Updates", subtitle: update.status == "disabled" ? "No update feed set" : "Version \(currentVersion)",
                       icon: .symbol("arrow.down.circle"), keywords: ["update", "upgrade", "version"], source: "app", feature: id, kindLabel: "Glide"),
            SearchItem(id: "app:data-folder", kind: .command, title: "Show Glide Data Folder", icon: .symbol("folder"), keywords: ["support", "data.json", "backup"],
                       source: "app", feature: id, kindLabel: "Glide"),
        ]
        if update.status == "available", let v = update.latestVersion {
            out.insert(SearchItem(id: "app:install-update", kind: .command, title: "Update Glide to v\(v)", subtitle: "Installed: \(currentVersion)", icon: .symbol("sparkles"),
                                  keywords: ["update", "install"], source: "app", feature: id, kindLabel: "Glide"), at: 0)
        }
        return out
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        [ItemAction(id: "run", title: item.id == "app:data-folder" ? "Show in Finder" : "Run", shortcut: "↩"),
         ItemAction(id: "settings", title: "Open Updates & App Settings", shortcut: "⌘↩", icon: "gearshape")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        if action == "settings" { return .openSettings(page: id) }
        switch scored.item.id {
        case "app:toggle-login":
            let on = !launchAtLogin
            let r = setLaunchAtLogin(on)
            return r.ok ? .hide(message: r.message ?? "Launch at Login: \(on ? "On" : "Off")") : .error(r.message ?? "Could not change the login item")
        case "app:check-updates":
            if Releases.parseFeed(feedSetting) == nil { return .openSettings(page: id) }
            let st = await check()
            if st.status == "available" { return .stay(message: "Glide \(st.latestVersion ?? "") is available") }
            if st.status == "error" { return .error(st.error ?? "Update check failed") }
            return .stay(message: "Glide is up to date")
        case "app:install-update":
            let st = await install()
            return st.status == "error" ? .error(st.error ?? "Update failed") : .hide(message: "Installing update…")
        case "app:data-folder":
            if let c = context { _ = c.services.workspace.open(path: c.store.directory.path) }
            return .hide()
        default: return .error("Unknown item \(scored.item.id)")
        }
    }

    // MARK: settings pages

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Updates & App", symbol: "arrow.down.circle", order: 90) { [weak self] in AnyView(AppSettingsView(feature: self)) }
    }

    /// The Settings window's General page (wired by GlideApp's SettingsWindow).
    public func generalPage() -> AnyView {
        guard let c = context else { return AnyView(Text("Starting…")) }
        return AnyView(GeneralSettingsView(model: GeneralSettingsModel(store: c.store, app: self)))
    }

    // MARK: methods

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "info": return info()
        case "check": await check(); return info()
        case "install": await install(); return info()
        case "setUpdateSettings": setUpdateSettings(args.objectValue ?? [:]); return info()
        case "setLaunchAtLogin":
            let r = setLaunchAtLogin(args.boolValue ?? args["on"]?.boolValue ?? false)
            return ["ok": .bool(r.ok), "message": r.message.map(JSONValue.string) ?? .null, "info": info()]
        case "snapshotGeneral":
            let path = args["path"]?.stringValue ?? FileManager.default.temporaryDirectory.appendingPathComponent("glide-general.png").path
            guard let c = context else { throw FeatureError.failed("not ready") }
            let v = GeneralSettingsView(model: GeneralSettingsModel(store: c.store, app: self))
            return OffscreenSnapshot.result(path: path, size: try OffscreenSnapshot.render(v, size: CGSize(width: 620, height: 1100), to: URL(fileURLWithPath: path), appearance: .darkAqua))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

struct AppSettingsView: View {
    weak var feature: AppFeature?
    @State private var feed = ""
    @State private var tick = 0
    @State private var message: String?

    var body: some View {
        let info = feature?.info() ?? .null
        let up = info["update"] ?? .null
        Form {
            Section("Glide") {
                LabeledContent("Version", value: info["version"]?.stringValue ?? "")
                LabeledContent("Data folder") {
                    HStack {
                        Text(info["userDataPath"]?.stringValue ?? "").lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary)
                        Button("Show") { Task { _ = await feature?.run(action: "run", on: ScoredItem(item: SearchItem(id: "app:data-folder", kind: .command, title: ""), score: 0), modifiers: []) } }
                    }
                }
            }
            Section {
                TextField("Update feed (owner/repo)", text: $feed)
                    .onSubmit { feature?.setUpdateSettings(["updateFeed": .string(feed)]); tick += 1 }
                Toggle("Check automatically", isOn: Binding(get: { info["autoCheck"]?.boolValue ?? true }, set: { feature?.setUpdateSettings(["autoCheck": .bool($0)]); tick += 1 }))
                HStack {
                    Button("Check Now") { Task { await feature?.check(); tick += 1 } }
                    if up["status"]?.stringValue == "available" {
                        Button("Update to v\(up["latestVersion"]?.stringValue ?? "")") { Task { await feature?.install(); tick += 1 } }.buttonStyle(.borderedProminent)
                    }
                }
                Text(Self.statusText(up)).font(.caption).foregroundStyle(up["status"]?.stringValue == "error" ? .red : .secondary)
            } header: { Text("Updates") } footer: {
                Text("Glide reads GitHub Releases (default tobibytes/glide). It picks this Mac's architecture build, verifies its SHA-256, code signature and bundle id before replacing Glide.app. An empty feed turns updates off: no update requests are made.")
            }
        }
        .formStyle(.grouped)
        .id(tick)
        .onAppear { feed = info["updateFeed"]?.stringValue ?? "" }
    }

    static func statusText(_ up: JSONValue) -> String {
        switch up["status"]?.stringValue ?? "" {
        case "disabled": return up["error"]?.stringValue ?? "Updates are off (no feed)."
        case "idle": return "Not checked yet."
        case "checking": return "Checking…"
        case "up-to-date": return "Glide is up to date (latest \(up["latestVersion"]?.stringValue ?? "?"))."
        case "available": return "Glide \(up["latestVersion"]?.stringValue ?? "") is available (\(up["asset"]?.stringValue ?? ""))."
        case "installing": return "Installing… \(up["phase"]?.stringValue ?? "")"
        case "error": return up["error"]?.stringValue ?? "Error"
        default: return ""
        }
    }
}
