import Foundation

public enum GlidePaths {
    /// `GLIDE_USER_DATA` (tests) or ~/Library/Application Support/Glide — the Electron app's userData, so the
    /// native app reads the same data.json / usage.json.
    public static func userDataDirectory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let custom = environment["GLIDE_USER_DATA"], !custom.isEmpty {
            return URL(fileURLWithPath: (custom as NSString).expandingTildeInPath, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support", isDirectory: true)
        return base.appendingPathComponent("Glide", isDirectory: true)
    }

    /// Private per-feature directory: <userData>/features/<id>/ (same layout as FeatureContext.dataDir()).
    public static func featureDirectory(_ featureId: String, root: URL) -> URL {
        root.appendingPathComponent("features", isDirectory: true).appendingPathComponent(featureId, isDirectory: true)
    }
}

/// Token returned by `Store.observe`; observation stops when it is cancelled or deallocated.
public final class StoreObservation: @unchecked Sendable {
    private let onCancel: () -> Void
    private var cancelled = false
    init(_ onCancel: @escaping () -> Void) { self.onCancel = onCancel }
    public func cancel() {
        guard !cancelled else { return }
        cancelled = true
        onCancel()
    }
    deinit { cancel() }
}

/// data.json + usage.json, mirroring src/main/store.ts: tolerant load (defaults under stored values, seeds on
/// first launch), debounced (250 ms) atomic writes serialised on one queue, change notifications.
///
/// Thread-safety: state is lock-protected; mutations may come from any thread. Observers run synchronously
/// on the mutating thread after the lock is released (the app mutates on the main thread).
public final class Store: @unchecked Sendable {
    public let directory: URL
    public let dataURL: URL
    public let usageURL: URL
    public let debounce: TimeInterval

    private let lock = NSLock()
    private var _data = UserData()
    private var _usage: [UsageRecord] = []
    private var dataDirty = false
    private var usageDirty = false
    private var dataWork: DispatchWorkItem?
    private var usageWork: DispatchWorkItem?
    private var observers: [UUID: @Sendable (UserData) -> Void] = [:]
    private let io = DispatchQueue(label: "dev.glide.store.io")
    /// Write errors are reported here (default: stderr).
    public var onError: @Sendable (String) -> Void = { msg in FileHandle.standardError.write(Data("[store] \(msg)\n".utf8)) }

    public init(directory: URL, debounce: TimeInterval = 0.25) {
        self.directory = directory
        dataURL = directory.appendingPathComponent("data.json")
        usageURL = directory.appendingPathComponent("usage.json")
        self.debounce = debounce
    }

    /// Loads both files. Returns true when data.json did not exist (seeded and written immediately).
    @discardableResult
    public func load(now: Double = Date().timeIntervalSince1970 * 1000) throws -> Bool {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var fresh = false
        var data: UserData
        if let raw = try? Data(contentsOf: dataURL), let decoded = try? JSONDecoder().decode(UserData.self, from: raw) {
            data = decoded
        } else if FileManager.default.fileExists(atPath: dataURL.path) {
            // Unreadable JSON: keep a copy rather than silently overwriting the user's data.
            let backup = directory.appendingPathComponent("data.json.corrupt-\(Int(now))")
            try? FileManager.default.copyItem(at: dataURL, to: backup)
            onError("data.json could not be parsed; a copy was saved to \(backup.lastPathComponent)")
            data = Seed.userData(now: now)
            fresh = true
        } else {
            data = Seed.userData(now: now)
            fresh = true
        }
        var usage: [UsageRecord] = []
        if let raw = try? Data(contentsOf: usageURL), let list = try? JSONDecoder().decode([JSONValue].self, from: raw) {
            usage = list.compactMap { v in
                guard let d = try? JSONEncoder().encode(v) else { return nil }
                return try? JSONDecoder().decode(UsageRecord.self, from: d)
            }
        }
        lock.lock()
        _data = data
        _usage = usage
        lock.unlock()
        if fresh { try write(data, to: dataURL) }
        return fresh
    }

    public var data: UserData { lock.lock(); defer { lock.unlock() }; return _data }
    public var settings: Settings { data.settings }
    public var usage: [UsageRecord] { lock.lock(); defer { lock.unlock() }; return _usage }

    public func setUsage(_ records: [UsageRecord]) {
        lock.lock()
        _usage = records
        usageDirty = true
        usageWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushUsage() }
        usageWork = work
        lock.unlock()
        io.asyncAfter(deadline: .now() + debounce, execute: work)
    }

    /// Apply a mutation, schedule a debounced atomic write and notify observers.
    @discardableResult
    public func mutate(_ fn: (inout UserData) -> Void) -> UserData {
        lock.lock()
        fn(&_data)
        let snapshot = _data
        dataDirty = true
        dataWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushData() }
        dataWork = work
        let handlers = Array(observers.values)
        lock.unlock()
        io.asyncAfter(deadline: .now() + debounce, execute: work)
        for h in handlers { h(snapshot) }
        return snapshot
    }

    public func observe(_ handler: @escaping @Sendable (UserData) -> Void) -> StoreObservation {
        let id = UUID()
        lock.lock()
        observers[id] = handler
        lock.unlock()
        return StoreObservation { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.observers[id] = nil
            self.lock.unlock()
        }
    }

    // MARK: convenience mutations (same semantics as the Electron store)

    public func setSettings(_ fn: (inout Settings) -> Void) { mutate { fn(&$0.settings) } }

    /// Merge `patch` into the feature's settings bag (`settings.features[featureId]`).
    public func setFeatureSettings(_ featureId: String, _ patch: [String: JSONValue]) {
        mutate { d in d.settings.features[featureId, default: [:]].merge(patch) { _, new in new } }
    }

    @discardableResult
    public func saveWorkflow(_ wf: Workflow, now: Double = Date().timeIntervalSince1970 * 1000) -> Workflow {
        var saved = wf
        saved.updatedAt = now
        if saved.createdAt == 0 { saved.createdAt = now }
        mutate { d in
            if let i = d.workflows.firstIndex(where: { $0.id == wf.id }) { d.workflows[i] = saved } else { d.workflows.append(saved) }
        }
        return saved
    }
    public func deleteWorkflow(_ id: String) { mutate { $0.workflows.removeAll { $0.id == id } } }
    public func saveQuicklink(_ q: Quicklink) {
        mutate { d in if let i = d.quicklinks.firstIndex(where: { $0.id == q.id }) { d.quicklinks[i] = q } else { d.quicklinks.append(q) } }
    }
    public func deleteQuicklink(_ id: String) { mutate { $0.quicklinks.removeAll { $0.id == id } } }
    public func saveSnippet(_ s: Snippet) {
        mutate { d in if let i = d.snippets.firstIndex(where: { $0.id == s.id }) { d.snippets[i] = s } else { d.snippets.append(s) } }
    }
    public func deleteSnippet(_ id: String) { mutate { $0.snippets.removeAll { $0.id == id } } }
    @discardableResult
    public func toggleFavorite(_ itemId: String) -> [String] {
        mutate { d in
            if d.favorites.contains(itemId) { d.favorites.removeAll { $0 == itemId } } else { d.favorites.append(itemId) }
        }.favorites
    }
    public func setAlias(_ itemId: String, _ alias: String?) {
        mutate { d in
            let a = alias?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if a.isEmpty { d.aliases[itemId] = nil } else { d.aliases[itemId] = a }
        }
    }
    public func setHotkey(_ itemId: String, _ accel: String?) {
        mutate { d in
            let a = accel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if a.isEmpty { d.hotkeys[itemId] = nil } else { d.hotkeys[itemId] = a }
        }
    }

    /// Write anything pending now (call before quit). Blocks until written.
    public func flush() {
        io.sync {
            flushData()
            flushUsage()
        }
    }

    // MARK: io (runs on `io`)

    private func flushData() {
        lock.lock()
        guard dataDirty else { lock.unlock(); return }
        dataDirty = false
        let snapshot = _data
        lock.unlock()
        do { try write(snapshot, to: dataURL) } catch { onError("failed to write data.json: \(error)") }
    }

    private func flushUsage() {
        lock.lock()
        guard usageDirty else { lock.unlock(); return }
        usageDirty = false
        let snapshot = _usage
        lock.unlock()
        do { try write(snapshot, to: usageURL) } catch { onError("failed to write usage.json: \(error)") }
    }

    private func write<T: Encodable>(_ value: T, to url: URL) throws {
        let data = try JSONEncoder.glide.encode(value)
        try data.write(to: url, options: [.atomic])
    }
}
