import Foundation
import GlideCore
import GlideSystem

/// Fan-out of the Clipboard feature's pasteboard changes, so other features can follow the clipboard without a
/// second poller. ClipboardFeature posts every snapshot its watcher delivers (own writes are never delivered).
@MainActor public enum PasteboardChangeObservers {
    private static var handlers: [UUID: @MainActor (PasteboardSnapshot) -> Void] = [:]

    @discardableResult
    public static func add(_ h: @escaping @MainActor (PasteboardSnapshot) -> Void) -> UUID {
        let id = UUID()
        handlers[id] = h
        return id
    }

    public static func remove(_ id: UUID?) {
        guard let id else { return }
        handlers[id] = nil
    }

    public static func notify(_ snap: PasteboardSnapshot) {
        for h in handlers.values { h(snap) }
    }
}

/// Keeps `<root>/clipboard.json` (`{"text","at"}`) equal to the Mac clipboard's text, so the "Get Mac Clipboard"
/// shortcut is a plain file read. Opt-in (Settings → iPhone, needs the Clipboard group). Follows Clipboard History's
/// rules: concealed / transient / auto-generated types (password managers) and ignored apps are skipped, nothing is
/// written while Clipboard History is paused, and only text up to 64 KB is mirrored. Turning it off deletes the file.
@MainActor final class PhoneClipboardMirror {
    let roots: [URL]
    private let services: SystemServices
    /// Clipboard History's settings (ignored apps, pause), read fresh for each change.
    var clipSettings: () -> ClipSettings
    var now: () -> Date = { Date() }
    var fallbackInterval: Duration = .milliseconds(1500)

    private(set) var isOn = false
    private var observer: UUID?
    private var fallbackTask: Task<Void, Never>?
    private var lastWritten: String?
    private(set) var writes = 0

    init(roots: [URL], services: SystemServices, clipSettings: @escaping () -> ClipSettings) {
        self.roots = roots
        self.services = services
        self.clipSettings = clipSettings
    }

    private var watcher: any PasteboardWatching { PasteboardWatcherFactory.watcher(for: services) }

    func setOn(_ on: Bool) async {
        guard on != isOn else { return }
        isOn = on
        if on {
            observer = PasteboardChangeObservers.add { [weak self] snap in self?.handle(snap) }
            startFallback()
            handle(await watcher.read())
        } else {
            PasteboardChangeObservers.remove(observer)
            observer = nil
            fallbackTask?.cancel()
            fallbackTask = nil
            lastWritten = nil
            for r in roots { PhoneRelayIO.remove(PhoneRelayPaths.clipboard(r)) }
        }
    }

    /// When Clipboard History is off its watcher is not running: then check the change count ourselves (one integer
    /// read per tick, contents only read when it moved). While the shared watcher runs this loop does nothing.
    private func startFallback() {
        fallbackTask?.cancel()
        // Baseline now, so a copy made right after turning the mirror on is not missed.
        var last: Int? = watcher.isWatching ? nil : currentCount
        fallbackTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.isOn else { return }
                let interval = self.fallbackInterval
                if !self.watcher.isWatching {
                    let count = self.currentCount
                    if let l = last, l != count { self.handle(await self.watcher.read()) }
                    last = count
                } else {
                    last = nil
                }
                try? await Task.sleep(for: interval)
            }
        }
    }

    private var currentCount: Int { (watcher as? FakePasteboardWatcher)?.changeCount ?? services.pasteboard.changeCount }

    /// The text to mirror for a snapshot, or nil to leave clipboard.json as it is.
    nonisolated static func mirrorText(_ snap: PasteboardSnapshot, settings: ClipSettings, nowMs: Double) -> String? {
        if settings.isPaused(now: nowMs) { return nil }
        if ClipModel.isConcealed(snap.types) || PasteboardMarkers.isConcealed(snap.types) { return nil }
        if ClipModel.isIgnoredApp(snap.source?.bundleId, settings.ignoredApps) { return nil }
        guard snap.files.isEmpty, let text = snap.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard text.utf8.count <= PhoneRelayLimits.maxClipboardBytes else { return nil }
        return text
    }

    func handle(_ snap: PasteboardSnapshot) {
        guard isOn else { return }
        let t = now()
        guard let text = Self.mirrorText(snap, settings: clipSettings(), nowMs: t.timeIntervalSince1970 * 1000), text != lastWritten else { return }
        write(text, at: t)
    }

    private func write(_ text: String, at t: Date) {
        lastWritten = text
        let data = PhoneRelayProtocol.encode(PhoneRelayProtocol.clipboardMirror(text: text, at: t))
        for r in roots where FileManager.default.fileExists(atPath: r.path) {
            PhoneRelayIO.writeAtomic(data, to: PhoneRelayPaths.clipboard(r))
        }
        writes += 1
    }
}
