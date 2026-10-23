import CryptoKit
import Foundation
import GlideCore

/// Downloads, verifies and swaps in a new Glide.app (src/main/features/app/installer.ts). Every check must pass
/// before the installed app is touched: SHA-256 against the .sha256 asset, `codesign --verify --deep --strict`,
/// matching bundle identifier and version. `trash` and the URL session are injected (tests use a temp "Trash"
/// and a 127.0.0.1 stub).
public enum UpdateInstaller {
    public enum Phase: String, Sendable { case downloading, verifying, extracting, checkingSignature = "checking-signature", replacing, done }

    public struct Options: Sendable {
        public var candidate: UpdateCandidate
        public var currentAppPath: URL
        public var workDir: URL
        public var headless: Bool
        public var trash: @Sendable (URL) throws -> Void
        public var onPhase: @Sendable (Phase) -> Void
        public init(candidate: UpdateCandidate, currentAppPath: URL, workDir: URL, headless: Bool,
                    trash: @escaping @Sendable (URL) throws -> Void, onPhase: @escaping @Sendable (Phase) -> Void = { _ in }) {
            self.candidate = candidate
            self.currentAppPath = currentAppPath
            self.workDir = workDir
            self.headless = headless
            self.trash = trash
            self.onPhase = onPhase
        }
    }

    public static func sha256(file: URL) throws -> String {
        let h = FileHandle(forReadingAtPath: file.path)
        guard let h else { throw FeatureError.failed("Cannot read \(file.lastPathComponent)") }
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Run a tool; returns (status, stderr).
    @discardableResult
    static func run(_ tool: String, _ args: [String]) async throws -> (Int32, String) {
        try await Task.detached {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: tool)
            p.arguments = args
            let err = Pipe()
            p.standardError = err
            p.standardOutput = FileHandle.nullDevice
            try p.run()
            let data = err.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return (p.terminationStatus, String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        }.value
    }

    public static func plistValue(_ app: URL, _ key: String) -> String? {
        let info = app.appendingPathComponent("Contents/Info.plist")
        guard let d = try? Data(contentsOf: info), let p = try? PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any] else { return nil }
        return p[key] as? String
    }

    public static func verifyCodeSignature(_ app: URL) async throws {
        let (status, err) = try await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        if status != 0 { throw FeatureError.failed("The downloaded app's code signature is invalid: \(err)") }
    }

    static func download(_ urlString: String, to dest: URL, headless: Bool) async throws {
        guard let url = URL(string: urlString) else { throw FeatureError.failed("Bad download URL") }
        guard Releases.networkAllowed(url: url, headless: headless) else { throw FeatureError.failed("Network access is disabled in headless runs (\(url.host ?? ""))") }
        var req = URLRequest(url: url, timeoutInterval: 600)
        req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        req.setValue("Glide-Updater", forHTTPHeaderField: "User-Agent")
        let (tmp, resp) = try await URLSession.shared.download(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw FeatureError.failed("Download failed (\((resp as? HTTPURLResponse)?.statusCode ?? 0)) for \(dest.lastPathComponent)")
        }
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
    }

    /// Returns the installed version.
    @discardableResult
    public static func install(_ o: Options) async throws -> String {
        let fm = FileManager.default
        try fm.createDirectory(at: o.workDir, withIntermediateDirectories: true)
        o.onPhase(.downloading)
        let zip = o.workDir.appendingPathComponent(o.candidate.zip.name)
        let sha = o.workDir.appendingPathComponent(o.candidate.sha256.name)
        try await download(o.candidate.sha256.url, to: sha, headless: o.headless)
        try await download(o.candidate.zip.url, to: zip, headless: o.headless)

        o.onPhase(.verifying)
        guard let expected = Releases.parseSha256File((try? String(contentsOf: sha, encoding: .utf8)) ?? "") else { throw FeatureError.failed("The checksum file is malformed") }
        let actual = try sha256(file: zip)
        guard actual == expected else { throw FeatureError.failed("Checksum mismatch: expected \(expected.prefix(12))…, got \(actual.prefix(12))…") }

        o.onPhase(.extracting)
        let extract = o.workDir.appendingPathComponent("extracted", isDirectory: true)
        try? fm.removeItem(at: extract)
        try fm.createDirectory(at: extract, withIntermediateDirectories: true)
        let (st, err) = try await run("/usr/bin/ditto", ["-x", "-k", zip.path, extract.path])
        guard st == 0 else { throw FeatureError.failed("Could not unpack the update: \(err)") }
        let apps = try fm.contentsOfDirectory(atPath: extract.path).filter { $0.hasSuffix(".app") }
        guard apps.count == 1 else { throw FeatureError.failed("Expected one .app in the update, found \(apps.count)") }
        let newApp = extract.appendingPathComponent(apps[0], isDirectory: true)

        o.onPhase(.checkingSignature)
        try await verifyCodeSignature(newApp)
        let newId = plistValue(newApp, "CFBundleIdentifier") ?? ""
        let curId = plistValue(o.currentAppPath, "CFBundleIdentifier") ?? ""
        guard !newId.isEmpty, newId == curId else { throw FeatureError.failed("Bundle identifier mismatch: update is \"\(newId)\", installed app is \"\(curId)\"") }
        let newVersion = plistValue(newApp, "CFBundleShortVersionString") ?? ""
        guard SemVer.compare(newVersion, o.candidate.release.version) == 0 else {
            throw FeatureError.failed("The update bundle reports version \(newVersion), but the release is \(o.candidate.release.version)")
        }

        o.onPhase(.replacing)
        // Stage next to the current bundle so the final step is a same-volume rename.
        let staged = o.currentAppPath.deletingLastPathComponent().appendingPathComponent(".\(o.currentAppPath.lastPathComponent).update-\(Int(Date().timeIntervalSince1970 * 1000))")
        do { try fm.moveItem(at: newApp, to: staged) } catch {
            let (s2, e2) = try await run("/usr/bin/ditto", [newApp.path, staged.path])
            guard s2 == 0 else { throw FeatureError.failed("Could not stage the update: \(e2)") }
        }
        do { try o.trash(o.currentAppPath) } catch {
            try? fm.removeItem(at: staged)
            throw FeatureError.failed("Could not move the current app to the Trash: \(error.localizedDescription)")
        }
        try fm.moveItem(at: staged, to: o.currentAppPath)
        o.onPhase(.done)
        return newVersion
    }
}
