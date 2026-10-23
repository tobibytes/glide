import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Settings Sync & Backup through a folder the user picks (iCloud Drive, Dropbox, a USB stick) — no network APIs.
/// Feature id "sync" (same bag, state.json and backups/ layout as the Electron app): each Mac writes
/// <folder>/Glide Sync/<machine>.json; "Sync Now" merges every machine's file per item (SyncMerge) and applies the
/// result through the store. Rolling local backups (last 10) can be restored with a preview.
@MainActor public final class SyncFeature: Feature, FeatureUI {
    public let id = "sync"
    public let title = "Sync & Backup"
    private weak var context: FeatureContext?
    private var manifest: SyncSnapshot = [:]
    private(set) var lastSyncAt: Double = 0
    private(set) var lastResult = ""
    private(set) var lastError = ""
    private(set) var conflicts: [SyncConflict] = []
    private var applying = false
    private var running = false
    private var observation: StoreObservation?
    private var debounce: Task<Void, Never>?
    private var autoTimer: Timer?
    static let maxBackups = 10
    static let maxConflicts = 100
    static let syncDirName = "Glide Sync"
    /// Bumped on every change, for the settings page.
    public private(set) var revision = 0

    public init() {}

    public struct Config: Equatable, Sendable {
        public var folder: String
        public var auto: Bool
        public var intervalMinutes: Int
        public var machine: String
    }

    var config: Config {
        let s = context?.settings(defaults: ["folder": "", "auto": false, "intervalMinutes": 15, "machine": ""]) ?? [:]
        let n = s["intervalMinutes"]?.doubleValue ?? 15
        let m = s["machine"]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
        return Config(folder: s["folder"]?.stringValue ?? "", auto: s["auto"]?.boolValue == true,
                      intervalMinutes: n.isFinite ? min(1440, max(1, Int(n.rounded()))) : 15,
                      machine: SyncMerge.machineSlug(m.isEmpty ? Self.hostname() : m))
    }

    /// os.hostname() (gethostname: no DNS lookup).
    static func hostname() -> String {
        var buf = [CChar](repeating: 0, count: 256)
        guard gethostname(&buf, buf.count) == 0 else { return "Mac" }
        return String(cString: buf)
    }

    var syncDir: URL? { config.folder.isEmpty ? nil : URL(fileURLWithPath: config.folder, isDirectory: true).appendingPathComponent(Self.syncDirName, isDirectory: true) }
    private var statePath: URL? { context.map { $0.dataDirectory().appendingPathComponent("state.json") } }
    private var backupDir: URL? {
        guard let d = context?.dataDirectory().appendingPathComponent("backups", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private var now: Double { Date().timeIntervalSince1970 * 1000 }

    public func start(context: FeatureContext) async {
        self.context = context
        loadState()
        track()
        observation = context.store.observe { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.applying else { return }
                self.debounce?.cancel()
                self.debounce = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(500))
                    guard !Task.isCancelled else { return }
                    self?.track()
                    self?.reschedule()
                }
            }
        }
        reschedule()
    }

    public func stop() async {
        autoTimer?.invalidate()
        observation?.cancel()
        debounce?.cancel()
    }

    // MARK: state

    static func readJSON(_ url: URL) -> JSONValue? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: d)
    }

    static func writeJSONAtomic(_ v: JSONValue, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder.glide.encode(v).write(to: url, options: .atomic)
    }

    private func loadState() {
        guard let p = statePath, let raw = Self.readJSON(p) else { return }
        manifest = [:]
        for (k, e) in raw["manifest"]?.objectValue ?? [:] { if let entry = SyncEntry(json: e) { manifest[k] = entry } }
        lastSyncAt = raw["lastSyncAt"]?.doubleValue ?? 0
        lastResult = raw["lastResult"]?.stringValue ?? ""
        lastError = raw["lastError"]?.stringValue ?? ""
        conflicts = raw["conflicts"]?.arrayValue?.compactMap(SyncConflict.init(json:)) ?? []
    }

    private func saveState() {
        guard let p = statePath else { return }
        let v: JSONValue = ["manifest": .object(manifest.mapValues(\.json)), "lastSyncAt": .double(lastSyncAt), "lastResult": .string(lastResult),
                            "lastError": .string(lastError), "conflicts": .array(conflicts.map(\.json))]
        do { try Self.writeJSONAtomic(v, to: p) } catch { context?.log("could not save sync state: \(error)") }
        revision += 1
    }

    /// Stamp local edits as they happen, so "last modified" is the edit time rather than the sync time.
    func track(now t: Double? = nil) {
        guard let c = context else { return }
        manifest = SyncMerge.trackLocal(manifest, SyncMerge.flatten(c.store.data), now: t ?? now, machine: config.machine)
        saveState()
    }

    /// Replace the syncable parts of UserData through the store (one mutation).
    private func applyValues(_ values: [String: JSONValue]) {
        guard let c = context else { return }
        let next = SyncMerge.unflatten(c.store.data, values)
        applying = true
        c.store.mutate { d in
            d.settings = next.settings
            d.workflows = next.workflows
            d.quicklinks = next.quicklinks
            d.snippets = next.snippets
            d.favorites = next.favorites
            d.aliases = next.aliases
            d.hotkeys = next.hotkeys
        }
        // Observers run synchronously; the debounced tracker hops through a Task, so clear on the next turn.
        Task { @MainActor in self.applying = false }
    }

    // MARK: backups

    public struct BackupInfo: Sendable, Equatable {
        public var id: String
        public var createdAt: Double
        public var reason: String
        public var items: Int
        var json: JSONValue { ["id": .string(id), "createdAt": .double(createdAt), "reason": .string(reason), "items": .int(Int64(items))] }
    }

    func listBackups() -> [BackupInfo] {
        guard let dir = backupDir, let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        var out: [BackupInfo] = []
        for f in names where f.hasSuffix(".json") {
            guard let raw = Self.readJSON(dir.appendingPathComponent(f)), let values = raw["values"]?.objectValue else { continue }
            out.append(BackupInfo(id: String(f.dropLast(5)), createdAt: raw["createdAt"]?.doubleValue ?? 0, reason: raw["reason"]?.stringValue ?? "", items: values.count))
        }
        return out.sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.id > $1.id }
    }

    @discardableResult
    func makeBackup(_ reason: String) throws -> BackupInfo {
        guard let c = context, let dir = backupDir else { throw FeatureError.failed("Sync is not ready") }
        let t = now
        let values = SyncMerge.flatten(c.store.data)
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let stamp = iso.string(from: Date(timeIntervalSince1970: t / 1000)).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
        let id = "backup-\(stamp)-\(String(UUID().uuidString.prefix(4)).lowercased())"
        try Self.writeJSONAtomic(["app": "glide", "kind": "backup", "version": .int(Int64(SyncMerge.formatVersion)), "createdAt": .double(t), "reason": .string(reason), "values": .object(values)],
                                 to: dir.appendingPathComponent("\(id).json"))
        for old in listBackups().dropFirst(Self.maxBackups) { try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(old.id).json")) }
        revision += 1
        return BackupInfo(id: id, createdAt: t, reason: reason, items: values.count)
    }

    func backupValues(_ id: String) throws -> [String: JSONValue] {
        guard id.range(of: #"^[\w.-]+$"#, options: .regularExpression) != nil else { throw FeatureError.invalidArguments("Invalid backup id") }
        guard let dir = backupDir, let values = Self.readJSON(dir.appendingPathComponent("\(id).json"))?["values"]?.objectValue else {
            throw FeatureError.failed("Backup not found or unreadable")
        }
        return values
    }

    /// A sync file (<machine>.json) or a backup file.
    func importValues(_ path: String) throws -> [String: JSONValue] {
        guard let raw = Self.readJSON(URL(fileURLWithPath: path)) else { throw FeatureError.failed("Not a Glide sync or backup file") }
        if raw["kind"]?.stringValue == "backup", let v = raw["values"]?.objectValue { return v }
        guard let f = SyncMerge.parseFile(raw) else { throw FeatureError.failed("Not a Glide sync or backup file") }
        return SyncMerge.values(f.entries)
    }

    func restore(_ values: [String: JSONValue], reason: String) throws -> (message: String, preview: ChangePreview) {
        guard let c = context else { throw FeatureError.failed("Sync is not ready") }
        let preview = SyncMerge.preview(c.store.data, values)
        try makeBackup(reason)
        applyValues(values)
        track() // restored items count as fresh local edits, so the next sync spreads them
        let n = preview.count
        return ("Restored (\(n) change\(n == 1 ? "" : "s"))", preview)
    }

    // MARK: sync

    func readSyncFiles(_ dir: URL) -> [SyncFile] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.filter { $0.hasSuffix(".json") }.sorted().compactMap { Self.readJSON(dir.appendingPathComponent($0)).flatMap(SyncMerge.parseFile) }
    }

    private func writeOwnFile(_ dir: URL, _ entries: SyncSnapshot) throws -> URL {
        let file = dir.appendingPathComponent("\(config.machine).json")
        try Self.writeJSONAtomic(SyncMerge.fileJSON(machine: config.machine, exportedAt: now, entries: entries), to: file)
        return file
    }

    public func exportNow() -> (ok: Bool, message: String) {
        guard let dir = syncDir else { return (false, "Choose a sync folder first") }
        track()
        do {
            let file = try writeOwnFile(dir, manifest)
            return (true, "Exported \(SyncMerge.values(manifest).count) items to \(file.path)")
        } catch { return (false, error.localizedDescription) }
    }

    public func syncNow() async -> (ok: Bool, message: String, preview: ChangePreview?, conflicts: Int) {
        guard !running else { return (false, "A sync is already running", nil, 0) }
        guard let c = context, let dir = syncDir else { return (false, "Choose a sync folder first", nil, 0) }
        guard FileManager.default.fileExists(atPath: config.folder) else { return fail("Sync folder is missing: \(config.folder)") }
        running = true
        defer { running = false }
        let t = now
        let me = config.machine
        track(now: t)
        let local = manifest
        let others = readSyncFiles(dir).filter { $0.machine != me }.map { (machine: $0.machine, entries: $0.entries) }
        let merged = SyncMerge.merge([local] + others.map(\.entries))
        let found = SyncMerge.conflicts(local: local, others: others, since: lastSyncAt, merged: merged, now: t)
        let target = SyncMerge.values(merged)
        let preview = SyncMerge.preview(c.store.data, target)
        do {
            if preview.count > 0 {
                try makeBackup("Before sync")
                applyValues(target)
            }
            // Local now equals the merge, so adopt the merged stamps (no spurious "local edit" next time).
            manifest = SyncMerge.trackLocal(merged, SyncMerge.flatten(c.store.data), now: t, machine: me)
            _ = try writeOwnFile(dir, manifest)
        } catch { return fail(error.localizedDescription) }
        lastSyncAt = t
        lastError = ""
        conflicts = Array((found + conflicts).prefix(Self.maxConflicts))
        let o = others.count
        lastResult = preview.count > 0 ? "Applied \(preview.count) change\(preview.count == 1 ? "" : "s") from \(o) other Mac\(o == 1 ? "" : "s")" : "Up to date (\(o) other Mac\(o == 1 ? "" : "s"))"
        saveState()
        return (true, lastResult, preview, found.count)
    }

    private func fail(_ m: String) -> (ok: Bool, message: String, preview: ChangePreview?, conflicts: Int) {
        lastError = m
        saveState()
        return (false, m, nil, 0)
    }

    private func reschedule() {
        let cfg = config
        let key = cfg.auto && !cfg.folder.isEmpty
        if key == (autoTimer != nil) { return }
        autoTimer?.invalidate()
        autoTimer = nil
        guard key else { return }
        // Check every minute; sync when the interval has elapsed (survives sleep better than one long timer).
        autoTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.now - self.lastSyncAt >= Double(self.config.intervalMinutes) * 60_000 else { return }
                Task { _ = await self.syncNow() }
            }
        }
    }

    func status() -> JSONValue {
        let cfg = config
        let dir = syncDir
        return ["settings": ["folder": .string(cfg.folder), "auto": .bool(cfg.auto), "intervalMinutes": .int(Int64(cfg.intervalMinutes)), "machine": .string(cfg.machine)],
                "syncDir": dir.map { .string($0.path) } ?? .null, "lastSyncAt": .double(lastSyncAt), "lastResult": .string(lastResult), "lastError": .string(lastError),
                "machines": .array(dir.map { readSyncFiles($0) }?.map { f in
                    ["machine": .string(f.machine), "exportedAt": .double(f.exportedAt), "items": .int(Int64(SyncMerge.values(f.entries).count)), "self": .bool(f.machine == cfg.machine)]
                } ?? []),
                "conflicts": .array(conflicts.map(\.json)), "backups": .array(listBackups().map(\.json))]
    }

    public func setConfig(_ p: [String: JSONValue]) {
        var clean: [String: JSONValue] = [:]
        if let f = p["folder"]?.stringValue {
            let t = f.trimmingCharacters(in: .whitespaces)
            clean["folder"] = .string(t.isEmpty ? "" : URL(fileURLWithPath: (t as NSString).expandingTildeInPath).standardizedFileURL.path)
        }
        if let a = p["auto"]?.boolValue { clean["auto"] = .bool(a) }
        if let n = p["intervalMinutes"]?.doubleValue { clean["intervalMinutes"] = .double(n) }
        if let m = p["machine"]?.stringValue { clean["machine"] = .string(m) }
        context?.setSettings(clean)
        reschedule()
        revision += 1
    }

    /// NSOpenPanel (explicit click in Settings only; never in headless runs).
    func chooseFolder() {
        guard context?.services.isHeadless == false else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose a folder to sync Glide through"
        panel.message = "Pick a folder in iCloud Drive, Dropbox or any synced location"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url { setConfig(["folder": .string(url.path)]) }
    }

    func chooseImportFile() -> String? {
        guard context?.services.isHeadless == false else { return nil }
        let panel = NSOpenPanel()
        panel.title = "Import Glide data"
        panel.allowedContentTypes = [.json]
        if let d = syncDir { panel.directoryURL = d }
        return panel.runModal() == .OK ? panel.url?.path : nil
    }

    func revealFolder() -> Bool {
        guard let d = syncDir, FileManager.default.fileExists(atPath: d.path) else { return false }
        _ = context?.services.workspace.open(path: d.path)
        return true
    }

    func clearConflicts() {
        conflicts = []
        saveState()
    }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        func item(_ a: String, _ title: String, _ sub: String, _ symbol: String, _ kw: [String]) -> SearchItem {
            SearchItem(id: "sync:\(a)", kind: .command, title: title, subtitle: sub, icon: .symbol(symbol), keywords: kw, source: "sync", feature: id, data: ["action": .string(a)], kindLabel: "Sync")
        }
        let f = config.folder
        return [item("now", "Sync Settings Now", f.isEmpty ? "Choose a sync folder first" : "via \((f as NSString).lastPathComponent)", "arrow.triangle.2.circlepath", ["sync", "settings sync", "icloud", "dropbox", "merge"]),
                item("backup", "Back Up Glide Data", "Local backup (keeps the last 10)", "externaldrive", ["backup", "snapshot", "export"]),
                item("settings", "Sync & Backup Settings", "Folder, auto sync, restore", "icloud", ["sync", "backup", "restore", "import", "export"])]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "now": return [ItemAction(id: "now", title: "Sync Now", shortcut: "↩", icon: "arrow.triangle.2.circlepath"), ItemAction(id: "settings", title: "Open Sync Settings", shortcut: "⌘↩", icon: "gearshape")]
        case "backup": return [ItemAction(id: "backup", title: "Back Up Now", shortcut: "↩", icon: "externaldrive"), ItemAction(id: "settings", title: "Restore from Backup…", shortcut: "⌘↩", icon: "clock.arrow.circlepath")]
        case "settings": return [ItemAction(id: "settings", title: "Open Sync Settings", shortcut: "↩", icon: "gearshape")]
        default: return []
        }
    }

    public func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        switch action {
        case "settings": return .openSettings(page: id)
        case "backup":
            do { return .stay(message: "Backed up \(try makeBackup("Manual").items) items") } catch { return .error(error.localizedDescription) }
        case "now":
            if config.folder.isEmpty { return .openSettings(page: id) }
            let r = await syncNow()
            return r.ok ? .stay(message: r.message) : .error(r.message)
        default: return .error("Unknown action \(action)")
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Sync & Backup", symbol: "icloud", order: 70) { [weak self] in
            AnyView(SyncSettingsView(feature: self))
        }
    }

    // MARK: methods

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "status": return status()
        case "setSettings": setConfig(args.objectValue ?? [:]); return status()
        case "chooseFolder": chooseFolder(); return status()
        case "revealFolder": return .bool(revealFolder())
        case "syncNow":
            let r = await syncNow()
            return ["ok": .bool(r.ok), "message": .string(r.message), "applied": r.preview?.json ?? .null, "conflicts": .int(Int64(r.conflicts))]
        case "exportNow":
            let r = exportNow()
            return ["ok": .bool(r.ok), "message": .string(r.message)]
        case "backupNow": return try makeBackup("Manual").json
        case "previewBackup":
            guard let c = context else { throw FeatureError.failed("Sync is not ready") }
            return SyncMerge.preview(c.store.data, try backupValues(args.stringValue ?? args["id"]?.stringValue ?? "")).json
        case "restoreBackup":
            let r = try restore(try backupValues(args.stringValue ?? args["id"]?.stringValue ?? ""), reason: "Before restore")
            return ["ok": true, "message": .string(r.message), "applied": r.preview.json]
        case "previewImport":
            guard let c = context else { throw FeatureError.failed("Sync is not ready") }
            return SyncMerge.preview(c.store.data, try importValues(args.stringValue ?? args["file"]?.stringValue ?? "")).json
        case "importFile":
            let r = try restore(try importValues(args.stringValue ?? args["file"]?.stringValue ?? ""), reason: "Before import")
            return ["ok": true, "message": .string(r.message), "applied": r.preview.json]
        case "clearConflicts": clearConflicts(); return status()
        case "manifest": return .object(manifest.mapValues(\.json))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

// MARK: - settings page

struct SyncSettingsView: View {
    weak var feature: SyncFeature?
    @State private var message: (ok: Bool, text: String)?
    @State private var preview: (id: String, text: String)?
    @State private var tick = 0

    var body: some View {
        let st = feature?.status() ?? .null
        let cfg = st["settings"] ?? .null
        Form {
            Section {
                LabeledContent("Sync folder") {
                    HStack {
                        Text((cfg["folder"]?.stringValue).flatMap { $0.isEmpty ? nil : $0 } ?? "Not set").foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        Button("Choose…") { feature?.chooseFolder(); tick += 1 }
                        if cfg["folder"]?.stringValue?.isEmpty == false { Button("Reveal") { _ = feature?.revealFolder() } }
                    }
                }
                TextField("This Mac's name", text: Binding(get: { cfg["machine"]?.stringValue ?? "" }, set: { feature?.setConfig(["machine": .string($0)]); tick += 1 }))
                Toggle("Sync automatically", isOn: Binding(get: { cfg["auto"]?.boolValue == true }, set: { feature?.setConfig(["auto": .bool($0)]); tick += 1 }))
                Stepper("Every \(cfg["intervalMinutes"]?.intValue ?? 15) minutes", value: Binding(get: { cfg["intervalMinutes"]?.intValue ?? 15 },
                                                                                                 set: { feature?.setConfig(["intervalMinutes": .int(Int64($0))]); tick += 1 }), in: 1...1440)
                HStack {
                    Button("Sync Now") { Task { if let r = await feature?.syncNow() { message = (r.ok, r.message) }; tick += 1 } }.keyboardShortcut("s", modifiers: [.command])
                    Button("Export Only") { if let r = feature?.exportNow() { message = (r.ok, r.message) }; tick += 1 }
                    Button("Import File…") {
                        guard let f = feature, let file = f.chooseImportFile() else { return }
                        do { let r = try f.restore(try f.importValues(file), reason: "Before import"); message = (true, r.message) } catch { message = (false, error.localizedDescription) }
                        tick += 1
                    }
                }
                if let m = message { Text(m.text).foregroundStyle(m.ok ? .green : .red).font(.caption) }
                else if let e = st["lastError"]?.stringValue, !e.isEmpty { Text(e).foregroundStyle(.red).font(.caption) }
                else if let r = st["lastResult"]?.stringValue, !r.isEmpty { Text(r).foregroundStyle(.secondary).font(.caption) }
            } header: { Text("Settings Sync") } footer: {
                Text("Each Mac writes “Glide Sync/<name>.json” in the folder; Sync Now merges every Mac's file item by item (newest edit wins) and keeps a backup first. API keys and other secrets are never written to the folder.")
            }
            if let machines = st["machines"]?.arrayValue, !machines.isEmpty {
                Section("Macs in the folder") {
                    ForEach(Array(machines.enumerated()), id: \.offset) { _, m in
                        LabeledContent((m["machine"]?.stringValue ?? "") + (m["self"]?.boolValue == true ? " (this Mac)" : "")) {
                            Text("\(m["items"]?.intValue ?? 0) items · \(Self.date(m["exportedAt"]?.doubleValue))").foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if let conflicts = st["conflicts"]?.arrayValue, !conflicts.isEmpty {
                Section {
                    ForEach(Array(conflicts.prefix(20).enumerated()), id: \.offset) { _, c in
                        LabeledContent(c["label"]?.stringValue ?? "") { Text("kept \(c["winner"]?["machine"]?.stringValue ?? "")'s").foregroundStyle(.secondary) }
                    }
                    Button("Clear") { feature?.clearConflicts(); tick += 1 }
                } header: { Text("Conflicts") }
            }
            Section("Backups") {
                Button("Back Up Now") { if let b = try? feature?.makeBackup("Manual") { message = (true, "Backed up \(b.items) items") }; tick += 1 }
                ForEach(Array((st["backups"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, b in
                    let id = b["id"]?.stringValue ?? ""
                    VStack(alignment: .leading) {
                        HStack {
                            Text(Self.date(b["createdAt"]?.doubleValue))
                            Text("\(b["reason"]?.stringValue ?? "") · \(b["items"]?.intValue ?? 0) items").foregroundStyle(.secondary)
                            Spacer()
                            Button("Preview") {
                                guard let f = feature, let v = try? f.backupValues(id), let data = f.contextData else { return }
                                let p = SyncMerge.preview(data, v)
                                preview = (id, "\(p.added.count) added, \(p.removed.count) removed, \(p.changed.count) changed")
                            }
                            Button("Restore") {
                                guard let f = feature else { return }
                                do { let r = try f.restore(try f.backupValues(id), reason: "Before restore"); message = (true, r.message) } catch { message = (false, error.localizedDescription) }
                                tick += 1
                            }
                        }
                        if preview?.id == id, let t = preview?.text { Text("Restoring would apply: \(t)").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .id(tick)
    }

    static func date(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "never" }
        return Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}

extension SyncFeature {
    var contextData: UserData? { context?.store.data }
}
