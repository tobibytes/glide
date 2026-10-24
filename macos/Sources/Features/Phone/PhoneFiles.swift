import Foundation
import GlideCore
import GlideSystem
import UniformTypeIdentifiers

/// phone-web: `files.search` and `files.get` for the web app's Files screen. Search reuses File Search's
/// backends (Spotlight in the app, the deterministic scan in headless runs) and its `fileindex` settings; downloads
/// are limited to regular files of at most 25 MB inside the user's home folder, never from ~/Library or a hidden
/// (dot) file or folder.
@MainActor final class PhoneFiles {
    static let maxBytes = 25 * 1024 * 1024
    let policy: PhoneFilePolicy
    let backendKind: String
    let fileSettings: () -> [String: JSONValue]
    let headless: Bool
    private var backend: (any FilesBackend)?

    init(home: String, backendKind: String, fileSettings: @escaping () -> [String: JSONValue], headless: Bool) {
        policy = PhoneFilePolicy(home: home)
        self.backendKind = backendKind
        self.fileSettings = fileSettings
        self.headless = headless
    }

    /// The folder files may come from. Headless runs may point it elsewhere with GLIDE_PHONE_FILES_HOME (tests).
    static func home(headless: Bool, environment: [String: String]) -> String {
        if headless, let h = environment["GLIDE_PHONE_FILES_HOME"], !h.isEmpty { return h }
        return NSHomeDirectory()
    }

    /// Search scopes: File Search's scopes that lie inside the allowed home. Headless runs never fall back to the
    /// user's home: without explicit `fileindex.scopes` they search nothing.
    var scopes: [String] {
        let bag = fileSettings()
        if headless && bag["scopes"] == nil { return [] }
        let settings = FilesSettings(bag: bag)
        return settings.expandedScopes(home: policy.home).compactMap { s in
            let r = PhoneFilePolicy.resolve(s)
            if r == policy.resolvedHome || r.hasPrefix(policy.resolvedHome + "/") { return policy.allowsFolder(r) ? r : nil }
            return nil
        }
    }

    func search(_ query: String, limit: Int) async -> [JSONValue] {
        let scopes = scopes
        guard !scopes.isEmpty else { return [] }
        let settings = FilesSettings(bag: fileSettings())
        let exclusions = FilesExclusions(settings: settings, home: policy.home)
        let b: any FilesBackend = backendKind == "scan" ? ScanFilesBackend { exclusions } : SpotlightFilesBackend()
        backend?.stop()
        backend = b
        let (paths, used) = await withCheckedContinuation { (cont: CheckedContinuation<([String], [String: Double]), Never>) in
            let wait = SearchWait(cont)
            b.start(text: query, mode: .name, scopes: scopes, limit: limit) { p, u, finished in
                wait.latest = (p, u)
                if finished { wait.finish(b) }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(5))
                wait.finish(b)
            }
        }
        if backend === b { backend = nil }
        let ranked = FilesRanking.rank(paths, query: query, opened: [:], lastUsed: used)
        var out: [JSONValue] = []
        for p in ranked where out.count < limit {
            guard (try? policy.check(p)) != nil, let info = Self.describe(p) else { continue }
            out.append(info)
        }
        return out
    }

    /// `{path, name, size, kind}` for a regular file, nil for folders and packages.
    nonisolated static func describe(_ path: String) -> JSONValue? {
        let url = URL(fileURLWithPath: path)
        guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .localizedTypeDescriptionKey, .contentModificationDateKey]),
              v.isRegularFile == true else { return nil }
        var o: [String: JSONValue] = [
            "path": .string(path), "name": .string(url.lastPathComponent), "size": .int(Int64(v.fileSize ?? 0)),
            "kind": .string(v.localizedTypeDescription ?? url.pathExtension.uppercased()),
        ]
        if let d = v.contentModificationDate { o["modified"] = .double((d.timeIntervalSince1970 * 1000).rounded()) }
        return .object(o)
    }

    func get(_ path: String) async throws -> JSONValue {
        let url = try policy.check(path)
        let max = Self.maxBytes
        return try await Task.detached(priority: .userInitiated) { () throws -> JSONValue in
            let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard v?.isRegularFile == true else { throw PhoneError("missing", "That file isn't there anymore. Search again.") }
            if let size = v?.fileSize, size > max { throw PhoneFiles.tooLarge(size) }
            let handle: FileHandle
            do { handle = try FileHandle(forReadingFrom: url) } catch { throw PhoneError("unreadable", "Glide couldn't open that file. Check that it isn't locked or protected.") }
            defer { try? handle.close() }
            // Read at most max + 1 bytes, so a file that grew since the size check is still refused.
            let data = (try? handle.read(upToCount: max + 1)) ?? Data()
            if data.count > max { throw PhoneFiles.tooLarge(data.count) }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            return ["name": .string(url.lastPathComponent), "type": .string(type), "size": .int(Int64(data.count)), "data": .string(data.base64EncodedString())]
        }.value
    }

    nonisolated static func tooLarge(_ bytes: Int) -> PhoneError {
        let mb = Int((Double(bytes) / 1_048_576).rounded(.up))
        return PhoneError("too-large", "This file is \(mb) MB. Glide sends files up to 25 MB to the phone.")
    }
}

/// One search: resumes once, with the latest results, when the backend finishes or after the timeout.
@MainActor private final class SearchWait {
    var latest: ([String], [String: Double]) = ([], [:])
    private var cont: CheckedContinuation<([String], [String: Double]), Never>?
    init(_ cont: CheckedContinuation<([String], [String: Double]), Never>) { self.cont = cont }
    func finish(_ backend: any FilesBackend) {
        guard let c = cont else { return }
        cont = nil
        backend.stop()
        c.resume(returning: latest)
    }
}

/// Which paths `files.get` may read: inside the home folder (after resolving symlinks), not in ~/Library, and no
/// path component that starts with a dot.
struct PhoneFilePolicy: Sendable {
    let home: String
    let resolvedHome: String

    init(home: String) {
        self.home = (home as NSString).standardizingPath
        resolvedHome = Self.resolve(home)
    }

    /// The real path: symlinks resolved. For a path that doesn't exist, its deepest existing folder is resolved and
    /// the rest appended, so a missing file inside home still compares against the resolved home.
    nonisolated static func resolve(_ path: String) -> String {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
        var existing = url
        var rest: [String] = []
        while !FileManager.default.fileExists(atPath: existing.path), existing.path != "/" {
            rest.insert(existing.lastPathComponent, at: 0)
            existing = existing.deletingLastPathComponent()
        }
        var resolved = existing.resolvingSymlinksInPath()
        for c in rest { resolved.appendPathComponent(c) }
        return resolved.path
    }

    static let refused = PhoneError("not-allowed", "Glide only sends files from your home folder, and never from Library or hidden folders.")

    /// Components below home that are refused (besides anything starting with a dot).
    static let refusedTopLevel: Set<String> = ["Library"]

    func allowsFolder(_ resolved: String) -> Bool {
        guard resolved == resolvedHome || resolved.hasPrefix(resolvedHome + "/") else { return false }
        let rest = resolved.dropFirst(resolvedHome.count).split(separator: "/")
        if let first = rest.first, Self.refusedTopLevel.contains(String(first)) { return false }
        return !rest.contains { $0.hasPrefix(".") }
    }

    /// The resolved file URL when the path is allowed, else `not-allowed`.
    func check(_ path: String) throws -> URL {
        let expanded: String
        if path == "~" || path.hasPrefix("~/") { expanded = home + path.dropFirst() } else { expanded = path }
        guard expanded.hasPrefix("/"), !expanded.contains("\0") else { throw Self.refused }
        // Check the path as given (no dot components even if a symlink hides them) and the resolved target.
        let given = (expanded as NSString).standardizingPath
        let below = given.hasPrefix(home + "/") ? String(given.dropFirst(home.count)) : given
        if below.split(separator: "/").contains(where: { $0.hasPrefix(".") }) { throw Self.refused }
        let resolved = Self.resolve(given)
        guard resolved != resolvedHome, allowsFolder(resolved) else { throw Self.refused }
        return URL(fileURLWithPath: resolved)
    }
}
