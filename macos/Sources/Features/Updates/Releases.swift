import Foundation
import GlideCore

// Ports of src/main/features/app/{semver,releases}.ts: SemVer precedence, GitHub Releases feed parsing and
// arch-aware asset selection. Pure.

public struct SemVer: Equatable, Sendable {
    public enum Ident: Equatable, Sendable { case num(Int), str(String) }
    public var major: Int, minor: Int, patch: Int
    public var prerelease: [Ident]

    public init?(_ input: String) {
        let s = input.trimmingCharacters(in: .whitespaces)
        let re = #"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"#
        guard let m = try? NSRegularExpression(pattern: re).firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        func g(_ i: Int) -> String? { Range(m.range(at: i), in: s).map { String(s[$0]) } }
        guard let a = g(1).flatMap(Int.init), let b = g(2).flatMap(Int.init), let c = g(3).flatMap(Int.init) else { return nil }
        major = a; minor = b; patch = c
        prerelease = g(4)?.split(separator: ".").map { p in p.allSatisfy(\.isNumber) ? .num(Int(p) ?? 0) : .str(String(p)) } ?? []
    }

    /// -1 / 0 / 1; unparseable versions sort below everything.
    public static func compare(_ a: String, _ b: String) -> Int {
        let pa = SemVer(a), pb = SemVer(b)
        guard let x = pa, let y = pb else { return (pa == nil) == (pb == nil) ? 0 : pa != nil ? 1 : -1 }
        for (u, v) in [(x.major, y.major), (x.minor, y.minor), (x.patch, y.patch)] where u != v { return u < v ? -1 : 1 }
        if x.prerelease.isEmpty || y.prerelease.isEmpty {
            if x.prerelease.count == y.prerelease.count { return 0 }
            return x.prerelease.isEmpty ? 1 : -1
        }
        for i in 0..<max(x.prerelease.count, y.prerelease.count) {
            guard i < x.prerelease.count else { return -1 }
            guard i < y.prerelease.count else { return 1 }
            switch (x.prerelease[i], y.prerelease[i]) {
            case let (.num(p), .num(q)): if p != q { return p < q ? -1 : 1 }
            case (.num, .str): return -1
            case (.str, .num): return 1
            case let (.str(p), .str(q)): if p != q { return p < q ? -1 : 1 }
            }
        }
        return 0
    }

    public static func isNewer(_ candidate: String, than current: String) -> Bool { compare(candidate, current) > 0 }
    /// "v1.2.3" → "1.2.3" (only when it parses).
    public static func normalise(_ tag: String) -> String? {
        guard SemVer(tag) != nil else { return nil }
        let t = tag.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("v") ? String(t.dropFirst()) : t
    }
}

public struct ReleaseAsset: Equatable, Sendable {
    public var name: String
    public var url: String
    public var size: Int?
}

public struct ReleaseInfo: Equatable, Sendable {
    public var version: String, tag: String, name: String, notes: String, pageUrl: String
    public var assets: [ReleaseAsset]
}

public struct UpdateCandidate: Equatable, Sendable {
    public var release: ReleaseInfo
    public var zip: ReleaseAsset
    public var sha256: ReleaseAsset
}

public enum Releases {
    public static let defaultFeed = "tobibytes/glide"
    public static let githubAPI = "https://api.github.com"

    public static func zipAssetName(_ arch: String) -> String { "Glide-darwin-\(arch).zip" }

    /// Native build first, then universal; unknown archs get only universal.
    public static func assetPreference(_ arch: String) -> [String] {
        switch arch {
        case "arm64": return ["arm64", "universal"]
        case "x64", "x86_64": return ["x64", "universal"]
        default: return ["universal"]
        }
    }

    /// The running build's arch in the Electron naming (process.arch).
    public static var currentArch: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x64"
        #else
        return "unknown"
        #endif
    }

    /// "owner/repo", "github.com/owner/repo" or a full https URL (".git" ok) → "owner/repo", else nil.
    public static func parseFeed(_ input: String) -> String? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        for p in ["https://", "http://"] where s.hasPrefix(p) { s = String(s.dropFirst(p.count)) }
        for p in ["www.github.com/", "github.com/"] where s.hasPrefix(p) { s = String(s.dropFirst(p.count)) }
        if s.hasSuffix(".git") { s = String(s.dropLast(4)) }
        while s.hasSuffix("/") { s.removeLast() }
        guard s.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil else { return nil }
        if s.split(separator: "/").contains(where: { $0.allSatisfy { $0 == "." } }) { return nil }
        return s
    }

    public static func latestReleaseURL(feed: String, baseUrl: String = githubAPI) -> URL? {
        var b = baseUrl
        while b.hasSuffix("/") { b.removeLast() }
        return URL(string: "\(b)/repos/\(feed)/releases/latest")
    }

    /// GitHub "release" JSON → ReleaseInfo; nil for drafts, prereleases or bad tags.
    public static func parseRelease(_ raw: JSONValue) -> ReleaseInfo? {
        guard raw.objectValue != nil, raw["draft"]?.boolValue != true, raw["prerelease"]?.boolValue != true else { return nil }
        let tag = raw["tag_name"]?.stringValue ?? ""
        guard let version = SemVer.normalise(tag) else { return nil }
        let assets: [ReleaseAsset] = (raw["assets"]?.arrayValue ?? []).compactMap { a in
            guard let n = a["name"]?.stringValue, !n.isEmpty, let u = a["browser_download_url"]?.stringValue, !u.isEmpty else { return nil }
            return ReleaseAsset(name: n, url: u, size: a["size"]?.intValue)
        }
        let name = raw["name"]?.stringValue ?? ""
        return ReleaseInfo(version: version, tag: tag, name: name.isEmpty ? tag : name, notes: raw["body"]?.stringValue ?? "", pageUrl: raw["html_url"]?.stringValue ?? "", assets: assets)
    }

    /// The zip + checksum pair for this arch (exact names), or nil.
    public static func selectAssets(_ r: ReleaseInfo, arch: String = currentArch) -> (zip: ReleaseAsset, sha256: ReleaseAsset)? {
        for a in assetPreference(arch) {
            let name = zipAssetName(a)
            if let zip = r.assets.first(where: { $0.name == name }), let sha = r.assets.first(where: { $0.name == "\(name).sha256" }) { return (zip, sha) }
        }
        return nil
    }

    /// Offered only when newer and a complete asset pair for this arch exists.
    public static func pickUpdate(_ r: ReleaseInfo?, current: String, arch: String = currentArch) -> UpdateCandidate? {
        guard let r, SemVer.isNewer(r.version, than: current), let a = selectAssets(r, arch: arch) else { return nil }
        return UpdateCandidate(release: r, zip: a.zip, sha256: a.sha256)
    }

    /// "<hex>  name" or a bare digest.
    public static func parseSha256File(_ text: String) -> String? {
        guard let r = text.range(of: #"\b[a-fA-F0-9]{64}\b"#, options: .regularExpression) else { return nil }
        return text[r].lowercased()
    }

    /// Network policy: headless runs may only talk to a loopback stub (tests never reach the internet).
    public static func networkAllowed(url: URL, headless: Bool) -> Bool {
        guard headless else { return true }
        return ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
    }

    /// Background checks: packaged app and not headless — or a test pointed at a local stub.
    public static func backgroundChecksAllowed(packaged: Bool, headless: Bool, testBaseUrl: String?) -> Bool {
        if let t = testBaseUrl, !t.isEmpty { return true }
        return packaged && !headless
    }
}
