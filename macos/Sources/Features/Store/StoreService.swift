import Foundation
import GlideCore

/// Network side of the store (store-client.ts): index fetch and package download with byte caps and SHA-256.
struct StoreClient: Sendable {
    static let defaultIndexURL = "https://raw.githubusercontent.com/tobibytes/glide/main/store/index.json"
    static let maxIndexBytes = 5 * 1024 * 1024
    var session: URLSession = .shared

    /// Reads a body, aborting as soon as it exceeds `max` bytes; the final (redirected) URL must pass the scheme rules.
    func get(_ url: URL, accept: String, max: Int, timeout: TimeInterval) async throws -> Data {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.setValue(accept, forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: req)
        let http = response as? HTTPURLResponse
        if let final = response.url { _ = try StoreSchema.resolveURL(final.absoluteString) }
        guard let status = http?.statusCode, (200..<300).contains(status) else { throw StoreIndexError("HTTP \(http?.statusCode ?? 0)") }
        if response.expectedContentLength > Int64(max) { throw StoreIndexError("Response is too large (\(response.expectedContentLength) bytes)") }
        var out = Data()
        var buffer = [UInt8]()
        buffer.reserveCapacity(64 * 1024)
        for try await b in bytes {
            buffer.append(b)
            if buffer.count >= 64 * 1024 {
                out.append(contentsOf: buffer)
                buffer.removeAll(keepingCapacity: true)
            }
            if out.count + buffer.count > max { throw StoreIndexError("Response is larger than expected (> \(max) bytes)") }
        }
        out.append(contentsOf: buffer)
        return out
    }

    func fetchIndex(_ url: String) async throws -> (entries: [StoreEntry], errors: [String], raw: JSONValue) {
        let u = try StoreSchema.resolveURL(url)
        let data: Data
        do { data = try await get(u, accept: "application/json", max: Self.maxIndexBytes, timeout: 10) } catch let e as StoreIndexError {
            throw StoreIndexError(e.message.hasPrefix("HTTP") ? "Store index request failed: \(e.message)" : e.message)
        } catch {
            throw StoreIndexError("Could not reach the store (\(error.localizedDescription))")
        }
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { throw StoreIndexError("Store index is not valid JSON") }
        let v = try StoreSchema.validate(json)
        return (v.entries, v.errors, json)
    }

    func download(_ d: StoreDownload, indexURL: String) async throws -> Data {
        let u = try StoreSchema.resolveURL(d.url, base: indexURL)
        let data: Data
        do { data = try await get(u, accept: "application/gzip, application/octet-stream", max: min(d.size, StoreSchema.maxDownloadBytes), timeout: 120) } catch let e as StoreIndexError {
            throw StoreIndexError(e.message.hasPrefix("HTTP") ? "Download failed: \(e.message)" : e.message)
        } catch {
            throw StoreIndexError("Download failed (\(error.localizedDescription))")
        }
        try StoreSchema.verify(data, d)
        return data
    }
}

/// One row of the store (StoreItem in store-contract.ts).
struct StoreItem: Hashable, Sendable {
    var entry: StoreEntry
    var origin: String
    /// "bundled" | "download" | nil
    var via: String?
    var size: Int?
    var unavailable: String?
    var version: String
    var installed: Bool
    var installedVersion: String?
    var installedFromStore: Bool
    var updateAvailable: Bool
}

struct StoreState: Sendable {
    var items: [StoreItem]
    var categories: [String]
    var indexURL: String
    var fetchedAt: Int64?
    var fromCache: Bool
    var error: String?
    var warnings: [String]
}

/// Store logic (store-service.ts): bundled + remote index merge, cache, install / update / uninstall.
/// State and cache files are the Electron app's (`store-state.json`, `store-cache.json`).
@MainActor final class StoreService {
    struct Deps {
        var registry: ExtensionRegistry
        var dataDir: URL
        var examplesDir: URL?
        var localIndex: URL?
        var indexURL: () -> String
        /// nil = may fetch; otherwise the reason it may not (headless runs never hit the public default).
        var mayFetch: (String) -> String?
        var appVersion: String = InitPayload.glideVersion
        var client = StoreClient()
        var changed: () -> Void = {}
        var beforeUninstall: (String) -> Void = { _ in }
        var log: (String) -> Void = { _ in }
        var maxCacheAge: TimeInterval = 3600
    }

    private struct Merged {
        var entry: StoreEntry
        var origin: String
        var bundledDir: URL?
    }

    let deps: Deps
    private var merged: [Merged] = []
    private var busy = Set<String>()
    private var lastWarnings: [String] = []

    init(_ deps: Deps) { self.deps = deps }

    private var cacheFile: URL { deps.dataDir.appendingPathComponent("store-cache.json") }
    private var stateFile: URL { deps.dataDir.appendingPathComponent("store-state.json") }

    private func state() -> [String: JSONValue] { ExtensionRegistry.readJSON(stateFile)?["installs"]?.objectValue ?? [:] }

    private func bundledEntries() -> [Merged] {
        let fm = FileManager.default
        var out: [Merged] = []
        if let local = deps.localIndex, let json = ExtensionRegistry.readJSON(local), let v = try? StoreSchema.validate(json) {
            for e in v.entries where e.bundledPath != nil {
                let dir = deps.examplesDir?.appendingPathComponent(e.bundledPath ?? "")
                out.append(Merged(entry: e, origin: "bundled", bundledDir: dir.flatMap { fm.fileExists(atPath: $0.appendingPathComponent("package.json").path) ? $0 : nil }))
            }
            return out
        }
        guard let ex = deps.examplesDir, let dirs = try? fm.contentsOfDirectory(atPath: ex.path) else { return out }
        for d in dirs.sorted() where !d.hasPrefix(".") {
            let dir = ex.appendingPathComponent(d)
            guard let m = Manifest.read(dir: dir).manifest else { continue }
            out.append(Merged(entry: StoreEntry(id: m.name.lowercased(), name: m.name, title: m.title, description: m.description, author: m.author ?? "Glide",
                                                version: m.version, categories: [], icon: (m.icon?.contains(".") ?? true) ? nil : m.icon,
                                                commands: m.commands.map { StoreCommand(name: $0.name, title: $0.title, description: $0.description, mode: $0.mode) },
                                                kind: m.runtime, minGlideVersion: "0.0.0", download: nil, bundledPath: d, screenshots: [], changelog: []),
                              origin: "bundled", bundledDir: dir))
        }
        return out
    }

    private func readCache(_ url: String) -> (fetchedAt: Int64, index: JSONValue)? {
        guard let c = ExtensionRegistry.readJSON(cacheFile), c["url"]?.stringValue == url, let at = c["fetchedAt"]?.intValue, let idx = c["index"] else { return nil }
        return (Int64(at), idx)
    }

    private func remoteEntries(refresh: Bool) async -> (entries: [StoreEntry], fetchedAt: Int64?, fromCache: Bool, error: String?) {
        let url = deps.indexURL()
        let cached = readCache(url)
        let cachedEntries: () -> [StoreEntry] = { (try? cached.map { try StoreSchema.validate($0.index).entries }) ?? [] }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if !refresh, let cached, Double(now - cached.fetchedAt) < deps.maxCacheAge * 1000 { return (cachedEntries(), cached.fetchedAt, true, nil) }
        if let blocked = deps.mayFetch(url) { return (cachedEntries(), cached?.fetchedAt, cached != nil, blocked) }
        do {
            let r = try await deps.client.fetchIndex(url)
            lastWarnings = r.errors
            try? ExtensionRegistry.writeJSON(cacheFile, ["url": .string(url), "fetchedAt": .int(now), "index": r.raw])
            return (r.entries, now, false, nil)
        } catch {
            return (cachedEntries(), cached?.fetchedAt, cached != nil, error.localizedDescription)
        }
    }

    func list(refresh: Bool = false) async -> StoreState {
        let bundled = bundledEntries()
        let remote = await remoteEntries(refresh: refresh)
        var byId: [String: Merged] = [:]
        var order: [String] = []
        for b in bundled { if byId[b.entry.id] == nil { order.append(b.entry.id) }; byId[b.entry.id] = b }
        for e in remote.entries {
            let local = byId[e.id]
            if let local, local.entry.name != e.name { continue }
            var dir = local?.bundledDir
            if dir == nil, let p = e.bundledPath, let ex = deps.examplesDir { dir = ex.appendingPathComponent(p) }
            if let d = dir, !FileManager.default.fileExists(atPath: d.appendingPathComponent("package.json").path) { dir = nil }
            if byId[e.id] == nil { order.append(e.id) }
            byId[e.id] = Merged(entry: e, origin: local != nil || e.bundledPath != nil ? "bundled" : "remote", bundledDir: dir)
        }
        merged = order.compactMap { byId[$0] }
        let items = merged.map(item).sorted { $0.entry.title.localizedCaseInsensitiveCompare($1.entry.title) == .orderedAscending }
        let cats = Array(Set(items.flatMap(\.entry.categories))).sorted()
        return StoreState(items: items, categories: cats, indexURL: deps.indexURL(), fetchedAt: remote.fetchedAt, fromCache: remote.fromCache, error: remote.error, warnings: lastWarnings)
    }

    private func bundledVersion(_ dir: URL?) -> String? { dir.flatMap { Manifest.read(dir: $0).manifest?.version } }

    private func via(_ m: Merged) -> String? {
        if let bv = bundledVersion(m.bundledDir), m.entry.download == nil || bv == m.entry.version { return "bundled" }
        return m.entry.download != nil ? "download" : nil
    }

    private func item(_ m: Merged) -> StoreItem {
        let e = m.entry
        let ext = deps.registry.get(e.name)
        let v = via(m)
        let installedVersion = ext?.manifest?.version
        let compatible = StoreSchema.compareVersions(deps.appVersion, e.minGlideVersion) >= 0
        let unavailable = !compatible ? "Requires Glide \(e.minGlideVersion) or later" : v == nil ? "Not available in this build (bundled files missing)" : nil
        let version = v == "bundled" ? (bundledVersion(m.bundledDir) ?? e.version) : e.version
        return StoreItem(entry: e, origin: m.origin, via: v, size: v == "download" ? e.download?.size : nil, unavailable: unavailable, version: version,
                         installed: ext != nil, installedVersion: installedVersion,
                         installedFromStore: ext != nil && ext?.source?["kind"]?.stringValue == "store" && state()[e.name] != nil,
                         updateAvailable: ext != nil && installedVersion != nil && unavailable == nil && StoreSchema.compareVersions(version, installedVersion!) > 0)
    }

    private func find(_ id: String) async throws -> Merged {
        if let m = merged.first(where: { $0.entry.id == id }) { return m }
        _ = await list()
        guard let m = merged.first(where: { $0.entry.id == id }) else { throw StoreIndexError("\(id) is not in the store") }
        return m
    }

    /// Install or update (`confirmed` must be true: installing runs third-party code).
    func install(_ id: String, confirmed: Bool, update: Bool = false) async throws -> (name: String, title: String, version: String) {
        guard confirmed else { throw StoreIndexError("Installing runs third-party code and must be confirmed first") }
        guard !busy.contains(id) else { throw StoreIndexError("\(id) is already being installed") }
        busy.insert(id)
        defer { busy.remove(id) }
        let m = try await find(id)
        let it = item(m)
        if let u = it.unavailable { throw StoreIndexError("\(it.entry.title): \(u)") }
        if update && !it.installed { throw StoreIndexError("\(it.entry.title) is not installed") }
        if update && !it.updateAvailable { throw StoreIndexError("\(it.entry.title) is up to date") }
        let source: JSONValue = ["kind": "store", "name": .string(m.entry.name)]
        var record: [String: JSONValue]
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if it.via == "bundled", let dir = m.bundledDir {
            try checkPackage(dir, m.entry, strictVersion: false)
            try deps.registry.install(folder: dir, source: source)
            record = ["id": .string(id), "version": .string(it.version), "via": "bundled", "installedAt": .int(now)]
        } else if let dl = m.entry.download {
            let buf = try await deps.client.download(dl, indexURL: deps.indexURL())
            let tmp = deps.dataDir.appendingPathComponent("store-tmp/\(m.entry.name)-\(UUID().uuidString.prefix(12))")
            defer { try? FileManager.default.removeItem(at: tmp) }
            try Tar.extractTgz(buf, to: tmp)
            try checkPackage(tmp, m.entry, strictVersion: true)
            try deps.registry.install(folder: tmp, source: source)
            record = ["id": .string(id), "version": .string(m.entry.version), "via": "download", "sha256": .string(dl.sha256), "installedAt": .int(now)]
        } else { throw StoreIndexError("\(it.entry.title) cannot be installed") }
        var s = state()
        s[m.entry.name] = .object(record)
        try ExtensionRegistry.writeJSON(stateFile, ["installs": .object(s)])
        deps.registry.invalidate()
        deps.changed()
        deps.log("[store] \(update ? "updated" : "installed") \(m.entry.name)@\(record["version"]?.stringValue ?? "") via \(record["via"]?.stringValue ?? "")")
        let ext = deps.registry.get(m.entry.name)
        return (m.entry.name, ext?.manifest?.title ?? it.entry.title, record["version"]?.stringValue ?? "")
    }

    private func checkPackage(_ dir: URL, _ e: StoreEntry, strictVersion: Bool) throws {
        let r = Manifest.read(dir: dir)
        guard let m = r.manifest else { throw StoreIndexError("The package is not a valid extension:\n\(r.errors.joined(separator: "\n"))") }
        if m.name != e.name { throw StoreIndexError("The package is \"\(m.name)\" but the store lists \"\(e.name)\"; not installed") }
        if strictVersion && m.version != e.version { throw StoreIndexError("The package is version \(m.version) but the store lists \(e.version); not installed") }
        if m.runtime != e.kind { throw StoreIndexError("The package is a \(m.runtime) extension but the store lists \(e.kind); not installed") }
    }

    func uninstall(_ id: String) throws {
        let name = merged.first { $0.entry.id == id }?.entry.name ?? id
        guard deps.registry.get(name) != nil else { throw StoreIndexError("\(name) is not installed") }
        deps.beforeUninstall(name)
        try deps.registry.uninstall(name)
        var s = state()
        s[name] = nil
        try ExtensionRegistry.writeJSON(stateFile, ["installs": .object(s)])
        deps.changed()
        deps.log("[store] uninstalled \(name)")
    }
}
