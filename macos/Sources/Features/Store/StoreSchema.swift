import Foundation
import GlideCore

/// store/index.json schema v1 — port of src/main/features/extensions/store-schema.ts (same rules and messages).
struct StoreCommand: Hashable, Sendable {
    var name: String
    var title: String
    var description: String?
    var mode: String?
}

struct StoreDownload: Hashable, Sendable {
    var url: String
    var sha256: String
    var size: Int
}

struct StoreChange: Hashable, Sendable {
    var version: String
    var date: String?
    var notes: String
}

struct StoreEntry: Hashable, Sendable {
    var id: String
    var name: String
    var title: String
    var description: String
    var author: String
    var version: String
    var categories: [String]
    var icon: String?
    var commands: [StoreCommand]
    /// "glide" | "raycast"
    var kind: String
    var minGlideVersion: String
    var download: StoreDownload?
    var bundledPath: String?
    var screenshots: [String]
    var changelog: [StoreChange]
    var homepage: String?
    var license: String?
}

struct StoreIndexError: Error, LocalizedError, Equatable {
    var message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

enum StoreSchema {
    static let schemaVersion = 1
    static let maxDownloadBytes = 50 * 1024 * 1024

    private static func matches(_ s: String, _ re: String) -> Bool { s.range(of: re, options: .regularExpression) != nil }
    static func isID(_ s: String) -> Bool { matches(s, "^[a-z0-9][a-z0-9._-]{0,63}$") }
    static func isName(_ s: String) -> Bool { matches(s, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$") && s != "." && s != ".." }
    static func isSHA(_ s: String) -> Bool { matches(s, "^[a-f0-9]{64}$") }
    static let semverRE = #"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"#
    static func isSemver(_ v: JSONValue?) -> Bool { v?.stringValue.map { matches($0.trimmingCharacters(in: .whitespaces), semverRE) } ?? false }

    private static func str(_ v: JSONValue?, _ max: Int = 2000) -> String? {
        guard let s = v?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty, (v?.stringValue?.count ?? 0) <= max else { return nil }
        return s
    }

    private static func semverParts(_ v: String) -> (Int, Int, Int, String?)? {
        guard let re = try? NSRegularExpression(pattern: semverRE) else { return nil }
        let s = v.trimmingCharacters(in: .whitespaces)
        guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        func g(_ i: Int) -> String? { Range(m.range(at: i), in: s).map { String(s[$0]) } }
        return (Int(g(1) ?? "") ?? 0, Int(g(2) ?? "") ?? 0, Int(g(3) ?? "") ?? 0, g(4))
    }

    /// Semver precedence (build metadata ignored; a pre-release sorts before its release; invalid sorts lowest).
    static func compareVersions(_ a: String, _ b: String) -> Int {
        let pa = semverParts(a), pb = semverParts(b)
        guard let pa, let pb else { return pa != nil ? 1 : pb != nil ? -1 : 0 }
        for (x, y) in [(pa.0, pb.0), (pa.1, pb.1), (pa.2, pb.2)] where x != y { return x < y ? -1 : 1 }
        switch (pa.3, pb.3) {
        case (nil, nil): return 0
        case (nil, _): return 1
        case (_, nil): return -1
        case let (ra?, rb?):
            let sa = ra.split(separator: "."), sb = rb.split(separator: ".")
            for i in 0..<max(sa.count, sb.count) {
                if i >= sa.count { return -1 }
                if i >= sb.count { return 1 }
                let x = String(sa[i]), y = String(sb[i])
                let nx = Int(x), ny = Int(y)
                if let nx, let ny { if nx != ny { return nx < ny ? -1 : 1 } } else if (nx == nil) != (ny == nil) { return nx != nil ? -1 : 1 } else if x != y { return x < y ? -1 : 1 }
            }
            return 0
        }
    }

    static func isLoopback(_ host: String) -> Bool {
        let h = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        return h == "127.0.0.1" || h == "localhost" || h == "::1"
    }

    /// https anywhere; http only on loopback.
    static func resolveURL(_ raw: String, base: String? = nil) throws -> URL {
        let u: URL?
        if let base { u = URL(string: raw, relativeTo: URL(string: base))?.absoluteURL } else { u = URL(string: raw) }
        guard let u, let scheme = u.scheme?.lowercased(), u.host != nil else { throw StoreIndexError("Invalid URL: \(raw)") }
        if u.user != nil || u.password != nil { throw StoreIndexError("URLs with credentials are not allowed") }
        guard scheme == "https" || (scheme == "http" && isLoopback(u.host ?? "")) else {
            throw StoreIndexError("Only https:// URLs are allowed (http only for 127.0.0.1): \(u.absoluteString)")
        }
        return u
    }

    private static func urlField(_ v: JSONValue?, _ at: String, _ errors: inout [String]) -> String? {
        guard let s = str(v, 2048) else { return nil }
        if matches(s.lowercased(), "^(javascript|data|file|vbscript):") { errors.append("\(at): unsupported URL scheme"); return nil }
        return s
    }

    private static func parseEntry(_ raw: JSONValue, _ i: Int, _ errors: inout [String]) -> StoreEntry? {
        let at = "extensions[\(i)]"
        guard raw.objectValue != nil else { errors.append("\(at): must be an object"); return nil }
        let label = raw["id"]?.stringValue.map { "\(at) (\($0))" } ?? at
        var errs: [String] = []
        let id = str(raw["id"], 64)
        if id == nil || !isID(id!) { errs.append("\"id\" must be 1–64 lower-case letters, digits, \".\", \"_\" or \"-\"") }
        let name = str(raw["name"], 64)
        if name == nil || !isName(name!) { errs.append("\"name\" must be a valid extension (package) name") }
        let title = str(raw["title"], 120)
        if title == nil { errs.append("\"title\" is required") }
        let description = str(raw["description"], 4000)
        if description == nil { errs.append("\"description\" is required") }
        let author = str(raw["author"], 120)
        if author == nil { errs.append("\"author\" is required") }
        if !isSemver(raw["version"]) { errs.append("\"version\" must be semver (1.2.3)") }
        if !isSemver(raw["minGlideVersion"]) { errs.append("\"minGlideVersion\" must be semver (0.2.0)") }
        let kind = raw["kind"]?.stringValue
        if kind != "glide" && kind != "raycast" { errs.append("\"kind\" must be \"glide\" or \"raycast\"") }
        let categories = Array((raw["categories"]?.arrayValue ?? []).compactMap { str($0, 40) }.prefix(8))
        if let c = raw["categories"], c.arrayValue == nil { errs.append("\"categories\" must be an array of strings") }
        var commands: [StoreCommand] = []
        if let list = raw["commands"]?.arrayValue, !list.isEmpty {
            for c in list {
                guard c.objectValue != nil, let n = str(c["name"], 64), let t = str(c["title"], 120) else { errs.append("every command needs \"name\" and \"title\""); break }
                let mode = ["view", "no-view", "menu-bar"].contains(c["mode"]?.stringValue ?? "") ? c["mode"]?.stringValue : nil
                commands.append(StoreCommand(name: n, title: t, description: str(c["description"], 500), mode: mode))
            }
        } else { errs.append("\"commands\" must list at least one command") }
        var download: StoreDownload?
        if let d = raw["download"], !d.isNull {
            if d.objectValue == nil { errs.append("\"download\" must be { url, sha256, size }") } else {
                let url = urlField(d["url"], "\(label).download.url", &errs)
                let sha = d["sha256"]?.stringValue?.lowercased() ?? ""
                let size = d["size"]?.intValue
                if url == nil { errs.append("\"download.url\" is required") }
                if !isSHA(sha) { errs.append("\"download.sha256\" must be 64 hex characters") }
                if size == nil || size! <= 0 || size! > maxDownloadBytes || d["size"]?.doubleValue != d["size"]?.intValue.map(Double.init) {
                    errs.append("\"download.size\" must be an integer between 1 and \(maxDownloadBytes)")
                }
                if let url, isSHA(sha), let size { download = StoreDownload(url: url, sha256: sha, size: size) }
            }
        }
        var bundled: String?
        if let s = raw["source"], !s.isNull {
            let p = str(s["path"], 64)
            if s.objectValue == nil || s["bundled"]?.boolValue != true || p == nil || !isName(p!) {
                errs.append("\"source\" must be { \"bundled\": true, \"path\": \"<folder in extensions-examples>\" }")
            } else { bundled = p }
        }
        if download == nil && bundled == nil && !errs.contains(where: { $0.contains("download") || $0.contains("source") }) {
            errs.append("needs a \"download\" { url, sha256, size } or a bundled \"source\"")
        }
        let screenshots = Array((raw["screenshots"]?.arrayValue ?? []).enumerated().compactMap { urlField($1, "\(label).screenshots[\($0)]", &errs) }.prefix(10))
        var changelog: [StoreChange] = []
        if let cl = raw["changelog"]?.arrayValue {
            for c in cl where isSemver(c["version"]) { if let notes = str(c["notes"], 4000) { changelog.append(StoreChange(version: c["version"]!.stringValue!.trimmingCharacters(in: .whitespaces), date: str(c["date"], 40), notes: notes)) } }
        } else if raw["changelog"] != nil { errs.append("\"changelog\" must be an array of { version, notes }") }
        let icon = str(raw["icon"], 2048)
        if let icon, matches(icon.lowercased(), "^(javascript|file|vbscript):") { errs.append("\"icon\" must be an emoji or an https URL") }
        if !errs.isEmpty { errors.append(contentsOf: errs.map { "\(label): \($0)" }); return nil }
        var ignored: [String] = []
        return StoreEntry(id: id!, name: name!, title: title!, description: description!, author: author!,
                          version: raw["version"]!.stringValue!.trimmingCharacters(in: .whitespaces), categories: categories, icon: icon, commands: commands,
                          kind: kind!, minGlideVersion: raw["minGlideVersion"]!.stringValue!.trimmingCharacters(in: .whitespaces), download: download,
                          bundledPath: bundled, screenshots: screenshots, changelog: changelog.sorted { compareVersions($0.version, $1.version) > 0 },
                          homepage: urlField(raw["homepage"], "\(label).homepage", &ignored), license: str(raw["license"], 60))
    }

    /// Validate an index document. Throws when the document itself is unusable; bad entries are dropped.
    static func validate(_ json: JSONValue) throws -> (entries: [StoreEntry], errors: [String]) {
        guard json.objectValue != nil else { throw StoreIndexError("Store index must be a JSON object { schemaVersion, extensions }") }
        guard let v = json["schemaVersion"]?.intValue, v >= 1 else { throw StoreIndexError("Store index needs an integer \"schemaVersion\"") }
        if v > schemaVersion { throw StoreIndexError("Store index uses schema v\(v); this Glide understands v\(schemaVersion) — update Glide") }
        guard let list = json["extensions"]?.arrayValue else { throw StoreIndexError("Store index needs an \"extensions\" array") }
        var errors: [String] = []
        var ids = Set<String>(), names = Set<String>()
        var out: [StoreEntry] = []
        for (i, raw) in list.enumerated() {
            guard let e = parseEntry(raw, i, &errors) else { continue }
            if ids.contains(e.id) || names.contains(e.name) { errors.append("extensions[\(i)] (\(e.id)): duplicate id or name"); continue }
            ids.insert(e.id)
            names.insert(e.name)
            out.append(e)
        }
        return (out, errors)
    }

    static func sha256Hex(_ d: Data) -> String { JSHost.digest("sha256", d).map { String(format: "%02x", $0) }.joined() }

    static func verify(_ d: Data, _ dl: StoreDownload) throws {
        if d.count != dl.size { throw StoreIndexError("Download size mismatch: expected \(dl.size) bytes, got \(d.count). The package was not installed.") }
        let got = sha256Hex(d)
        if got != dl.sha256.lowercased() { throw StoreIndexError("Checksum mismatch: expected sha256 \(dl.sha256), got \(got). The package was not installed.") }
    }
}
