import AppKit
import Foundation
import GlideCore
import IOKit.ps

/// Turns system changes into AutomationEvents. Only the sources an enabled automation needs run
/// (`sync` is called on every list change), so idle cost is zero.
@MainActor protocol AutomationEventSources: AnyObject {
    var emit: ((AutomationEvent) -> Void)? { get set }
    /// Start/stop sources for `list`; returns per-automation problems (unwatchable folder, refused hotkey).
    func sync(_ list: [Automation]) -> [String: String]
    func active() -> [String]
    func currentNetwork() -> String?
    func stop()
}

/// Hotkeys and folder checks shared by the live and headless sources.
@MainActor class AutomationSourcesBase {
    var emit: ((AutomationEvent) -> Void)?
    let registerHotkey: (String, String?, @escaping @MainActor () -> Void) -> Bool
    let home: String
    var hotkeys: [String: String] = [:] // automation id → accelerator

    init(home: String, registerHotkey: @escaping (String, String?, @escaping @MainActor () -> Void) -> Bool) {
        self.home = home
        self.registerHotkey = registerHotkey
    }

    func folderDir(_ path: String) -> String {
        URL(fileURLWithPath: AutomationModel.expandHome(path, home: home)).standardizedFileURL.path
    }

    func syncHotkeys(_ enabled: [Automation], _ problems: inout [String: String]) {
        var want: [String: String] = [:]
        for a in enabled { if case let .hotkey(acc) = a.trigger { want[a.id] = acc } }
        for (id, acc) in hotkeys where want[id] != acc {
            _ = registerHotkey("automation:\(id)", nil) {}
            hotkeys[id] = nil
        }
        for (id, acc) in want where hotkeys[id] == nil {
            if registerHotkey("automation:\(id)", acc, { [weak self] in self?.emit?(.hotkey(automationId: id)) }) { hotkeys[id] = acc }
            else { problems[id] = "macOS refused the hotkey \(acc) (already in use?)" }
        }
    }

    func stopHotkeys() {
        for id in hotkeys.keys { _ = registerHotkey("automation:\(id)", nil) {} }
        hotkeys = [:]
    }
}

/// Headless / tests: no system observers at all (events arrive only through `debugEvent`); hotkeys go through
/// the host's (fake) hotkey service; folders are only checked for existence.
@MainActor final class HeadlessAutomationSources: AutomationSourcesBase, AutomationEventSources {
    private(set) var wanted: [String] = []
    func sync(_ list: [Automation]) -> [String: String] {
        var problems: [String: String] = [:]
        let enabled = list.filter(\.enabled)
        var kinds = Set(enabled.map(\.trigger.kind))
        kinds.remove("time"); kinds.remove("interval"); kinds.remove("launch"); kinds.remove("hotkey"); kinds.remove("folder")
        var w = kinds.sorted()
        for a in enabled {
            if case let .folder(path, _) = a.trigger {
                let dir = folderDir(path)
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue { w.append("folder:\(dir)") }
                else { problems[a.id] = "Can't watch \(dir) (missing or not readable)" }
            }
        }
        syncHotkeys(enabled, &problems)
        wanted = w
        return problems
    }
    func active() -> [String] { wanted + hotkeys.values.sorted().map { "hotkey:\($0)" } }
    func currentNetwork() -> String? { nil }
    func stop() { stopHotkeys(); wanted = [] }
}

/// The real sources: NSWorkspace app notifications, Wi‑Fi via the WiFi service (polled), IOKit power-source
/// notifications, screen-parameter changes, DispatchSource folder watchers, hotkeys via the host.
@MainActor final class LiveAutomationSources: AutomationSourcesBase, AutomationEventSources {
    let wifiInfo: () -> JSONValue
    private var appObservers: [NSObjectProtocol] = []
    private var displayObserver: NSObjectProtocol?
    private var displays: [UInt32: String] = [:]
    private var wifiTimer: Timer?
    private var lastNetwork: String??
    private var powerSource: CFRunLoopSource?
    private var powerTimer: Timer?
    private var lastPower: (source: String, percent: Int)?
    private var folders: [String: FolderWatcher] = [:]

    init(home: String, wifiInfo: @escaping () -> JSONValue, registerHotkey: @escaping (String, String?, @escaping @MainActor () -> Void) -> Bool) {
        self.wifiInfo = wifiInfo
        super.init(home: home, registerHotkey: registerHotkey)
    }

    func sync(_ list: [Automation]) -> [String: String] {
        var problems: [String: String] = [:]
        let enabled = list.filter(\.enabled)
        let kinds = Set(enabled.map(\.trigger.kind))
        setApps(kinds.contains("app"))
        setWifi(kinds.contains("wifi"))
        setPower(kinds.contains("power"))
        setDisplays(kinds.contains("display"))

        var wantDirs: [String: [String]] = [:]
        for a in enabled { if case let .folder(path, _) = a.trigger { wantDirs[folderDir(path), default: []].append(a.id) } }
        for (dir, w) in folders where wantDirs[dir] == nil {
            w.stop()
            folders[dir] = nil
        }
        for (dir, ids) in wantDirs where folders[dir] == nil {
            let w = FolderWatcher(dir: dir) { [weak self] e in self?.emit?(e) }
            if w.start() { folders[dir] = w } else { for id in ids { problems[id] = "Can't watch \(dir) (missing or not readable)" } }
        }
        syncHotkeys(enabled, &problems)
        return problems
    }

    func active() -> [String] {
        var out: [String] = []
        if !appObservers.isEmpty { out.append("apps") }
        if wifiTimer != nil { out.append("wifi") }
        if powerSource != nil { out.append("power") }
        if displayObserver != nil { out.append("displays") }
        out += folders.keys.sorted().map { "folder:\($0)" }
        out += hotkeys.values.sorted().map { "hotkey:\($0)" }
        return out
    }

    func stop() {
        setApps(false)
        setWifi(false)
        setPower(false)
        setDisplays(false)
        for w in folders.values { w.stop() }
        folders = [:]
        stopHotkeys()
    }

    // MARK: apps

    private func setApps(_ on: Bool) {
        let nc = NSWorkspace.shared.notificationCenter
        if !on {
            for o in appObservers { nc.removeObserver(o) }
            appObservers = []
            return
        }
        guard appObservers.isEmpty else { return }
        let pairs: [(Notification.Name, String)] = [(NSWorkspace.didLaunchApplicationNotification, "launched"), (NSWorkspace.didTerminateApplicationNotification, "quit"),
                                                    (NSWorkspace.didActivateApplicationNotification, "activated")]
        for (name, event) in pairs {
            appObservers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.activationPolicy == .regular,
                      app.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
                let name = app.localizedName ?? app.bundleURL?.deletingPathExtension().lastPathComponent ?? "App"
                let bid = app.bundleIdentifier
                MainActor.assumeIsolated { self?.emit?(.app(event: event, name: name, bundleId: bid)) }
            })
        }
    }

    // MARK: Wi‑Fi

    func currentNetwork() -> String? {
        let info = wifiInfo()
        if let ssid = info["ssid"]?.stringValue, !ssid.isEmpty { return ssid }
        if info["connected"]?.boolValue == true { return info["bssid"]?.stringValue.map { "Router \($0)" } ?? "Unknown network" }
        return nil
    }

    private func setWifi(_ on: Bool) {
        if !on {
            wifiTimer?.invalidate()
            wifiTimer = nil
            lastNetwork = nil
            return
        }
        guard wifiTimer == nil else { return }
        lastNetwork = .some(currentNetwork())
        wifiTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = self.currentNetwork()
                if let prev = self.lastNetwork, prev != now { self.emit?(.wifi(from: prev, to: now)) }
                self.lastNetwork = .some(now)
            }
        }
    }

    // MARK: power (IOKit)

    nonisolated static func readPower() -> (source: String, percent: Int)? {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else { return nil }
        let type = IOPSGetProvidingPowerSourceType(blob)?.takeUnretainedValue() as String?
        var percent = -1
        if let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] {
            for ps in list {
                guard let d = IOPSGetPowerSourceDescription(blob, ps)?.takeUnretainedValue() as? [String: Any],
                      let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 else { continue }
                percent = Int((Double(cur) / Double(max) * 100).rounded())
            }
        }
        return (type == kIOPMACPowerKey ? "ac" : "battery", percent)
    }

    private func powerChanged() {
        guard let next = Self.readPower() else { return }
        if let prev = lastPower, prev.source != next.source || prev.percent != next.percent {
            emit?(.power(source: next.source, percent: next.percent, prevSource: prev.source, prevPercent: prev.percent))
        }
        lastPower = next
    }

    private func setPower(_ on: Bool) {
        if !on {
            if let s = powerSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .defaultMode) }
            powerSource = nil
            powerTimer?.invalidate()
            powerTimer = nil
            lastPower = nil
            return
        }
        guard powerSource == nil else { return }
        lastPower = Self.readPower()
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        if let src = IOPSNotificationCreateRunLoopSource({ ptr in
            guard let ptr else { return }
            let me = Unmanaged<LiveAutomationSources>.fromOpaque(ptr).takeUnretainedValue()
            MainActor.assumeIsolated { me.powerChanged() }
        }, ctx)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .defaultMode)
            powerSource = src
        }
        // Percent changes are not always notified: a slow poll as a backstop.
        powerTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.powerChanged() } }
    }

    // MARK: displays

    static func currentDisplays() -> [UInt32: String] {
        var out: [UInt32: String] = [:]
        for s in NSScreen.screens {
            guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            out[n.uint32Value] = s.localizedName
        }
        return out
    }

    private func setDisplays(_ on: Bool) {
        if !on {
            if let o = displayObserver { NotificationCenter.default.removeObserver(o) }
            displayObserver = nil
            return
        }
        guard displayObserver == nil else { return }
        displays = Self.currentDisplays()
        displayObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = Self.currentDisplays()
                for (id, name) in now where self.displays[id] == nil { self.emit?(.display(event: "connected", name: name)) }
                for (id, name) in self.displays where now[id] == nil { self.emit?(.display(event: "disconnected", name: name)) }
                self.displays = now
            }
        }
    }
}

/// Watches one directory (DispatchSource on the directory fd), debounced, diffing the listing.
@MainActor final class FolderWatcher {
    let dir: String
    let emit: (AutomationEvent) -> Void
    let debounce: Duration
    private var source: DispatchSourceFileSystemObject?
    private var known: Set<String> = []
    private var pending: Task<Void, Never>?

    init(dir: String, debounce: Duration = .milliseconds(800), emit: @escaping (AutomationEvent) -> Void) {
        self.dir = dir
        self.debounce = debounce
        self.emit = emit
    }

    func start() -> Bool {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return false }
        known = Set(names)
        let fd = open(dir, O_EVTONLY)
        guard fd >= 0 else { return false }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete, .extend], queue: .main)
        src.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.bump() } }
        src.setCancelHandler { close(fd) }
        src.resume()
        source = src
        return true
    }

    func stop() {
        source?.cancel()
        source = nil
        pending?.cancel()
    }

    private func bump() {
        pending?.cancel()
        pending = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.debounce)
            guard !Task.isCancelled else { return }
            self.scan()
        }
    }

    /// Diff the directory now (tests call this directly).
    func scan() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        let added = names.filter { !known.contains($0) && Self.isInteresting($0) }.sorted()
        known = Set(names)
        if added.isEmpty { emit(.folder(path: dir, event: "changed", file: dir)) }
        for n in added { emit(.folder(path: dir, event: "added", file: (dir as NSString).appendingPathComponent(n))) }
    }

    /// Hidden files and in-progress downloads are never "added".
    static func isInteresting(_ name: String) -> Bool {
        if name.hasPrefix(".") || name == "Icon\r" { return false }
        let ext = (name as NSString).pathExtension.lowercased()
        return !["crdownload", "download", "part", "partial", "tmp"].contains(ext)
    }
}
