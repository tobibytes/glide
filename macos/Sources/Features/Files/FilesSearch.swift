import AppKit
import Foundation
import GlideCore

/// The `fileindex` settings bag (src/main/features/fileindex/settings.ts), applied where meaningful natively:
/// scopes (search scopes), exclusions (gitignore-ish patterns / paths), includeHidden, showInRootSearch.
/// `respectIgnoreFiles` and `allowProtectedFolders` are kept untouched for the Electron crawler.
public struct FilesSettings: Equatable, Sendable {
    public var scopes: [String] = ["~", "/Applications"]
    public var exclusions: [String] = ["*.tmp", "*.temp", "**/tmp/**", "**/temp/**"]
    public var includeHidden = false
    public var showInRootSearch = true
    public var respectIgnoreFiles = true
    public var allowProtectedFolders = false
    public init() {}

    public init(bag: [String: JSONValue]) {
        func strings(_ k: String) -> [String]? { bag[k]?.arrayValue?.compactMap(\.stringValue) }
        let d = FilesSettings()
        scopes = strings("scopes") ?? d.scopes
        exclusions = strings("exclusions") ?? d.exclusions
        includeHidden = bag["includeHidden"]?.boolValue ?? d.includeHidden
        showInRootSearch = bag["showInRootSearch"]?.boolValue ?? d.showInRootSearch
        respectIgnoreFiles = bag["respectIgnoreFiles"]?.boolValue ?? d.respectIgnoreFiles
        allowProtectedFolders = bag["allowProtectedFolders"]?.boolValue ?? d.allowProtectedFolders
    }

    public var bag: [String: JSONValue] {
        ["scopes": .array(scopes.map(JSONValue.string)), "exclusions": .array(exclusions.map(JSONValue.string)), "includeHidden": .bool(includeHidden),
         "showInRootSearch": .bool(showInRootSearch), "respectIgnoreFiles": .bool(respectIgnoreFiles), "allowProtectedFolders": .bool(allowProtectedFolders)]
    }

    public func expandedScopes(home: String = NSHomeDirectory()) -> [String] {
        var seen = Set<String>()
        return scopes.map { s in s == "~" ? home : s.hasPrefix("~/") ? home + s.dropFirst() : s }
            .map { ($0 as NSString).standardizingPath }
            .filter { seen.insert($0).inserted }
    }
}

/// Exclusion rules modelled on fileindex/exclusions.ts: VCS/dependency/build/cache directory names, hidden
/// entries, ~/Library (except iCloud Drive), bundle interiors and user patterns.
public struct FilesExclusions: Sendable {
    static let dirNames: Set<String> = [".git", ".hg", ".svn", ".jj", ".bzr", "node_modules", "bower_components", ".pnpm-store", "build", "dist", "target", "out",
                                        ".next", ".nuxt", ".turbo", ".svelte-kit", ".parcel-cache", ".cache", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
                                        ".pytest_cache", ".ruff_cache", ".gradle", ".dart_tool", "DerivedData", "Pods", ".build", "zig-cache", ".Trash", "Caches", "CachedData"]
    static let fileNames: Set<String> = [".DS_Store", ".localized", "Icon\r", ".tsbuildinfo"]
    static let bundleExts: Set<String> = ["app", "photoslibrary", "musiclibrary", "xcarchive", "framework", "bundle", "plugin", "kext", "appex", "xcodeproj", "xcworkspace",
                                          "playground", "rtfd", "pages", "numbers", "key", "imovielibrary", "tvlibrary", "photoboothlibrary", "fcpbundle", "logicx", "band",
                                          "saver", "prefPane", "qlgenerator", "mdimporter"]

    public var home: String
    public var includeHidden: Bool
    var subtreePaths: [String] = []
    var regexes: [NSRegularExpression] = []

    public init(settings: FilesSettings, home: String = NSHomeDirectory()) {
        self.home = home
        includeHidden = settings.includeHidden
        for p in settings.exclusions {
            let t = p.trimmingCharacters(in: .whitespaces)
            if t.isEmpty || t.hasPrefix("#") { continue }
            if t.hasPrefix("/") || t.hasPrefix("~") {
                subtreePaths.append(((t.hasPrefix("~") ? home + t.dropFirst() : t) as NSString).standardizingPath)
            } else if let re = Self.globRegex(t) { regexes.append(re) }
        }
    }

    /// gitignore-ish glob → regex over the path (or the basename when the pattern has no slash).
    static func globRegex(_ glob: String) -> NSRegularExpression? {
        var g = glob
        let anchoredToName = !g.contains("/")
        if g.hasSuffix("/") { g.removeLast() }
        var re = ""
        var i = g.startIndex
        while i < g.endIndex {
            let c = g[i]
            if c == "*" {
                let next = g.index(after: i)
                if next < g.endIndex && g[next] == "*" {
                    re += ".*"
                    i = g.index(after: next)
                    if i < g.endIndex && g[i] == "/" { re += "/?"; i = g.index(after: i) }
                    continue
                }
                re += "[^/]*"
            } else if c == "?" { re += "[^/]" } else { re += NSRegularExpression.escapedPattern(for: String(c)) }
            i = g.index(after: i)
        }
        let pattern = anchoredToName ? "(^|/)\(re)$" : "(^|/)\(re)(/|$)"
        return try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    /// `scopes`: component rules (hidden, dependency dirs, bundles) apply below the containing scope only.
    public func excludes(path: String, scopes: [String] = []) -> Bool {
        var rel = path
        if let scope = scopes.filter({ path.hasPrefix($0 + "/") }).max(by: { $0.count < $1.count }) { rel = String(path.dropFirst(scope.count + 1)) }
        let comps = rel.split(separator: "/").map(String.init)
        for (i, c) in comps.enumerated() {
            if !includeHidden && c.hasPrefix(".") { return true }
            if Self.dirNames.contains(c) && i < comps.count - 1 { return true }
            if i < comps.count - 1, let dot = c.lastIndex(of: "."), Self.bundleExts.contains(String(c[c.index(after: dot)...])) { return true }
        }
        if let last = comps.last, Self.fileNames.contains(last) { return true }
        if path.hasPrefix(home + "/Library/") && !path.hasPrefix(home + "/Library/Mobile Documents/") { return true }
        for s in subtreePaths where path == s || path.hasPrefix(s + "/") { return true }
        let ns = rel as NSString
        for re in regexes where re.firstMatch(in: rel, range: NSRange(location: 0, length: ns.length)) != nil { return true }
        return false
    }

    /// Directory names never descended into by the scan backend.
    public func skipsDirectory(named name: String) -> Bool {
        (!includeHidden && name.hasPrefix(".")) || Self.dirNames.contains(name)
    }
}

public enum FilesSearchMode: String, Sendable { case name, content }

/// Ranking shared by both backends: exact name > prefix > word prefix > contains, then recently opened from
/// Glide, then Spotlight's last-used date, then shorter paths.
public enum FilesRanking {
    public static func rank(_ paths: [String], query: String, opened: [String: Double], lastUsed: [String: Double] = [:]) -> [String] {
        let q = query.lowercased()
        func tier(_ p: String) -> Int {
            let name = (p as NSString).lastPathComponent.lowercased()
            let stem = (name as NSString).deletingPathExtension
            if name == q || stem == q { return 0 }
            if name.hasPrefix(q) { return 1 }
            if name.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains(where: { $0.hasPrefix(q) }) { return 2 }
            return 3
        }
        return paths.map { ($0, tier($0), opened[$0] ?? 0, lastUsed[$0] ?? 0) }
            .sorted { a, b in
                if a.1 != b.1 { return a.1 < b.1 }
                if a.2 != b.2 { return a.2 > b.2 }
                if a.3 != b.3 { return a.3 > b.3 }
                return a.0.count < b.0.count
            }
            .map(\.0)
    }
}

/// A file search backend. Results arrive through `onResults` (possibly several times: live updates).
@MainActor public protocol FilesBackend: AnyObject {
    var name: String { get }
    /// Start (or replace) the live query. `onResults(paths, finished)`.
    func start(text: String, mode: FilesSearchMode, scopes: [String], limit: Int, onResults: @escaping @MainActor ([String], [String: Double], Bool) -> Void)
    func stop()
}

/// Spotlight via NSMetadataQuery (name: kMDItemFSName LIKE[cd] *text*; content: kMDItemTextContent CONTAINS[cd]),
/// kept running so new / renamed / deleted files update the results live.
@MainActor public final class SpotlightFilesBackend: FilesBackend {
    public let name = "spotlight"
    private var query: NSMetadataQuery?
    private var observers: [NSObjectProtocol] = []
    public init() {}

    static func escapeLike(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "*", with: "\\*").replacingOccurrences(of: "?", with: "\\?")
    }

    public func start(text: String, mode: FilesSearchMode, scopes: [String], limit: Int, onResults: @escaping @MainActor ([String], [String: Double], Bool) -> Void) {
        stop()
        let q = NSMetadataQuery()
        switch mode {
        case .name: q.predicate = NSPredicate(format: "%K LIKE[cd] %@", NSMetadataItemFSNameKey, "*\(Self.escapeLike(text))*")
        case .content: q.predicate = NSPredicate(format: "kMDItemTextContent CONTAINS[cd] %@ OR %K LIKE[cd] %@", text, NSMetadataItemFSNameKey, "*\(Self.escapeLike(text))*")
        }
        let existing = scopes.filter { FileManager.default.fileExists(atPath: $0) }
        q.searchScopes = existing.isEmpty ? [NSMetadataQueryLocalComputerScope] : existing
        q.sortDescriptors = [NSSortDescriptor(key: "kMDItemLastUsedDate", ascending: false)]
        q.notificationBatchingInterval = 0.3
        let collect: @MainActor (Bool) -> Void = { [weak q] finished in
            guard let q else { return }
            q.disableUpdates()
            var paths: [String] = []
            var used: [String: Double] = [:]
            let n = min(q.resultCount, max(limit * 20, 400))
            for i in 0..<n {
                guard let item = q.result(at: i) as? NSMetadataItem, let p = item.value(forAttribute: NSMetadataItemPathKey) as? String else { continue }
                paths.append(p)
                if let d = item.value(forAttribute: "kMDItemLastUsedDate") as? Date { used[p] = d.timeIntervalSince1970 }
            }
            q.enableUpdates()
            onResults(paths, used, finished)
        }
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .NSMetadataQueryDidFinishGathering, object: q, queue: .main) { _ in MainActor.assumeIsolated { collect(true) } })
        observers.append(nc.addObserver(forName: .NSMetadataQueryDidUpdate, object: q, queue: .main) { _ in MainActor.assumeIsolated { collect(true) } })
        observers.append(nc.addObserver(forName: .NSMetadataQueryGatheringProgress, object: q, queue: .main) { _ in MainActor.assumeIsolated { collect(false) } })
        query = q
        q.start()
    }

    public func stop() {
        query?.stop()
        query = nil
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
    }
}

/// Deterministic directory walk (headless tests, or GLIDE_FILES_BACKEND=scan): name contains / text contains.
@MainActor public final class ScanFilesBackend: FilesBackend {
    public let name = "scan"
    let exclusions: () -> FilesExclusions
    private var task: Task<Void, Never>?
    public init(exclusions: @escaping () -> FilesExclusions) { self.exclusions = exclusions }

    nonisolated static func scan(text: String, mode: FilesSearchMode, scopes: [String], ex: FilesExclusions, limit: Int) -> [String] {
        let q = text.lowercased()
        var out: [String] = []
        var visited = 0
        let fm = FileManager.default
        func walk(_ dir: String, _ depth: Int) {
            guard depth < 10, visited < 50_000, let names = try? fm.contentsOfDirectory(atPath: dir) else { return }
            for n in names.sorted() {
                visited += 1
                let p = (dir as NSString).appendingPathComponent(n)
                if ex.excludes(path: p, scopes: scopes) { continue }
                var isDir: ObjCBool = false
                fm.fileExists(atPath: p, isDirectory: &isDir)
                var hit = n.lowercased().contains(q)
                if !hit, mode == .content, !isDir.boolValue, let attrs = try? fm.attributesOfItem(atPath: p), (attrs[.size] as? NSNumber)?.intValue ?? 0 < 1_000_000,
                   let s = try? String(contentsOfFile: p, encoding: .utf8) { hit = s.lowercased().contains(q) }
                if hit { out.append(p) }
                if out.count >= limit * 20 { return }
                if isDir.boolValue, !ex.skipsDirectory(named: n), !FilesExclusions.bundleExts.contains((n as NSString).pathExtension) {
                    walk(p, depth + 1)
                }
            }
        }
        for s in scopes { walk(s, 0) }
        return out
    }

    public func start(text: String, mode: FilesSearchMode, scopes: [String], limit: Int, onResults: @escaping @MainActor ([String], [String: Double], Bool) -> Void) {
        stop()
        let ex = exclusions()
        task = Task { @MainActor in
            let paths = await Task.detached(priority: .userInitiated) { ScanFilesBackend.scan(text: text, mode: mode, scopes: scopes, ex: ex, limit: limit) }.value
            guard !Task.isCancelled else { return }
            onResults(paths, [:], true)
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }
}

/// "opened from Glide" recents: `<data>/features/fileindex/opened.json` = {path: unixMs} (same file as Electron).
@MainActor public final class FilesRecents {
    public let file: URL
    public private(set) var opened: [String: Double] = [:]
    static let limit = 2000
    public init(file: URL) {
        self.file = file
        if let d = try? Data(contentsOf: file), let raw = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            for (k, v) in raw { if let n = v as? NSNumber { opened[k] = n.doubleValue } }
        }
    }
    public func record(_ path: String, at ms: Double = Date().timeIntervalSince1970 * 1000) {
        opened[path] = ms
        if opened.count > Self.limit, let oldest = opened.min(by: { $0.value < $1.value })?.key { opened[oldest] = nil }
        save()
    }
    public func forget(_ path: String) { opened[path] = nil; save() }
    /// Most recent first, existing files only.
    public func recent(limit: Int = 20) -> [String] {
        opened.sorted { $0.value > $1.value }.map(\.key).filter { FileManager.default.fileExists(atPath: $0) }.prefix(limit).map { $0 }
    }
    func save() {
        let obj = opened.mapValues { NSNumber(value: $0) }
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? d.write(to: file, options: .atomic)
    }
}
