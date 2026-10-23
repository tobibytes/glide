import Darwin
import Foundation
import GlideCore

/// Installed extensions on disk, in the Electron app's layout (`<userData>/features/extensions/`):
/// `installed/<name>/`, `state.json` ({extensions: {name: {enabled, source, installedAt}}}),
/// `preferences/<name>.json` (0600), `storage/<name>.json` (LocalStorage), `support/<name>/`.
struct InstalledExtension: Sendable {
    var name: String
    var dir: URL
    var enabled: Bool
    var source: JSONValue?
    var installedAt: Int64?
    var manifest: ExtManifest?
    var errors: [String] = []
}

struct ExtensionError: Error, LocalizedError, Equatable {
    var message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// Builds a Raycast folder's commands into `out` (`.glide-build/<command>.cjs`); returns error messages.
typealias RaycastBuildFunction = @Sendable (_ src: URL, _ out: URL, _ manifest: ExtManifest) -> [String]

final class ExtensionRegistry: @unchecked Sendable {
    let base: URL
    let installedDir: URL
    private let raycastBuilder: RaycastBuildFunction?
    private var cache: [InstalledExtension]?
    private let fm = FileManager.default

    init(base: URL, raycastBuilder: RaycastBuildFunction? = RaycastBuilder.build) {
        self.base = base
        installedDir = base.appendingPathComponent("installed", isDirectory: true)
        self.raycastBuilder = raycastBuilder
    }

    private var stateFile: URL { base.appendingPathComponent("state.json") }

    // MARK: json helpers

    static func readJSON(_ url: URL) -> JSONValue? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: d)
    }

    static func writeJSON(_ url: URL, _ value: JSONValue, mode: Int? = nil) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.appendingPathExtension("\(getpid()).tmp")
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try enc.encode(value).write(to: tmp)
        if let mode { try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: tmp.path) }
        if Darwin.rename(tmp.path, url.path) != 0 {
            try? FileManager.default.removeItem(at: tmp)
            throw ExtensionError("Could not write \(url.lastPathComponent): \(String(cString: strerror(errno)))")
        }
    }

    private func state() -> [String: JSONValue] { Self.readJSON(stateFile)?["extensions"]?.objectValue ?? [:] }
    private func saveState(_ s: [String: JSONValue]) throws {
        try Self.writeJSON(stateFile, ["extensions": .object(s)])
        cache = nil
    }

    func invalidate() { cache = nil }

    // MARK: listing

    func list() -> [InstalledExtension] {
        if let cache { return cache }
        let st = state()
        let names = ((try? fm.contentsOfDirectory(atPath: installedDir.path)) ?? []).filter { !$0.hasPrefix(".") && Manifest.isValidName($0) }.sorted()
        let out = names.map { name -> InstalledExtension in
            let dir = installedDir.appendingPathComponent(name, isDirectory: true)
            let s = st[name]
            var e = InstalledExtension(name: name, dir: dir, enabled: s?["enabled"]?.boolValue ?? true, source: s?["source"],
                                       installedAt: s?["installedAt"]?.intValue.map(Int64.init))
            switch Manifest.read(dir: dir) {
            case let .ok(m): e.manifest = m
            case let .failed(errs): e.errors = errs
            }
            return e
        }
        cache = out
        return out
    }

    func get(_ name: String) -> InstalledExtension? { list().first { $0.name == name } }

    func setEnabled(_ name: String, _ enabled: Bool) throws {
        guard get(name) != nil else { throw ExtensionError("\(name) is not installed") }
        var s = state()
        var entry = s[name]?.objectValue ?? [:]
        entry["enabled"] = .bool(enabled)
        s[name] = .object(entry)
        try saveState(s)
    }

    // MARK: install

    /// Copy a validated folder into installed/<name> (replacing an existing install). Raycast folders are built.
    @discardableResult
    func install(folder src: URL, source: JSONValue) throws -> InstalledExtension {
        let pkg = src.appendingPathComponent("package.json")
        guard fm.fileExists(atPath: pkg.path) else { throw ExtensionError("\(src.path) has no package.json") }
        if let json = Self.readJSON(pkg), Manifest.isRaycastPackage(json), !hasBuiltRaycastEntries(src, json) {
            return try installRaycast(folder: src)
        }
        let res = Manifest.read(dir: src)
        guard let m = res.manifest else { throw ExtensionError("Invalid extension:\n\(res.errors.joined(separator: "\n"))") }
        try fm.createDirectory(at: installedDir, withIntermediateDirectories: true)
        let target = installedDir.appendingPathComponent(m.name, isDirectory: true)
        if target.standardizedFileURL.path == src.standardizedFileURL.path { return try record(m.name, source) }
        let tmp = installedDir.appendingPathComponent(".tmp-\(m.name)-\(Int(Date().timeIntervalSince1970 * 1000))", isDirectory: true)
        defer { try? fm.removeItem(at: tmp) }
        try copyTree(src, tmp, skip: [".git"])
        try? fm.removeItem(at: target)
        try fm.moveItem(at: tmp, to: target)
        return try record(m.name, source)
    }

    /// A Raycast package that already carries its bundles (store tarballs, re-installs of an installed copy).
    private func hasBuiltRaycastEntries(_ dir: URL, _ pkg: JSONValue) -> Bool {
        let cmds = pkg["commands"]?.arrayValue ?? []
        return !cmds.isEmpty && cmds.allSatisfy { c in
            guard let n = c["name"]?.stringValue else { return false }
            return Manifest.raycastEntryCandidates(n).contains { fm.fileExists(atPath: dir.appendingPathComponent($0).path) }
        }
    }

    /// Import a Raycast folder: translate, bundle each command into .glide-build, copy package.json, assets
    /// and docs only (dependencies are bundled; node_modules is never copied).
    @discardableResult
    func installRaycast(folder src: URL) throws -> InstalledExtension {
        guard let builder = raycastBuilder else { throw ExtensionError("Importing Raycast extensions is not available") }
        guard let pkg = Self.readJSON(src.appendingPathComponent("package.json")) else { throw ExtensionError("Cannot read package.json") }
        guard Manifest.isRaycastPackage(pkg) else { throw ExtensionError("\(src.path) is not a Raycast extension (package.json needs a top-level \"commands\" array)") }
        let pre = Manifest.translateRaycast(pkg)
        guard let m = pre.manifest else { throw ExtensionError("Invalid Raycast extension:\n\(pre.errors.joined(separator: "\n"))") }
        try fm.createDirectory(at: installedDir, withIntermediateDirectories: true)
        let tmp = installedDir.appendingPathComponent(".tmp-\(m.name)-\(Int(Date().timeIntervalSince1970 * 1000))", isDirectory: true)
        defer { try? fm.removeItem(at: tmp) }
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
        try fm.copyItem(at: src.appendingPathComponent("package.json"), to: tmp.appendingPathComponent("package.json"))
        for extra in ["assets", "README.md", "CHANGELOG.md", "LICENSE"] {
            let from = src.appendingPathComponent(extra)
            if fm.fileExists(atPath: from.path) { try copyTree(from, tmp.appendingPathComponent(extra), skip: [], followLinks: true) }
        }
        let errors = builder(src, tmp.appendingPathComponent(Manifest.raycastBuildDir, isDirectory: true), m)
        if !errors.isEmpty { throw ExtensionError("Could not build \(m.title):\n\(errors.joined(separator: "\n"))") }
        let check = Manifest.read(dir: tmp)
        guard check.manifest != nil else { throw ExtensionError("Invalid extension after build:\n\(check.errors.joined(separator: "\n"))") }
        let target = installedDir.appendingPathComponent(m.name, isDirectory: true)
        try? fm.removeItem(at: target)
        try fm.moveItem(at: tmp, to: target)
        return try record(m.name, ["kind": "raycast-folder", "path": .string(src.standardizedFileURL.path)])
    }

    /// Copies files and folders; symlinks are skipped unless `followLinks` (never copied as links).
    private func copyTree(_ from: URL, _ to: URL, skip: Set<String>, followLinks: Bool = false) throws {
        let values = try from.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        if values.isSymbolicLink == true {
            guard followLinks else { return }
            return try copyTree(from.resolvingSymlinksInPath(), to, skip: skip, followLinks: followLinks)
        }
        if values.isDirectory == true {
            try fm.createDirectory(at: to, withIntermediateDirectories: true)
            for name in try fm.contentsOfDirectory(atPath: from.path) where !skip.contains(name) {
                try copyTree(from.appendingPathComponent(name), to.appendingPathComponent(name), skip: skip, followLinks: followLinks)
            }
        } else {
            try fm.copyItem(at: from, to: to)
        }
    }

    private func record(_ name: String, _ source: JSONValue) throws -> InstalledExtension {
        var s = state()
        let enabled = s[name]?["enabled"]?.boolValue ?? true
        s[name] = ["enabled": .bool(enabled), "source": source, "installedAt": .int(Int64(Date().timeIntervalSince1970 * 1000))]
        try saveState(s)
        guard let e = get(name) else { throw ExtensionError("Install of \(name) failed") }
        return e
    }

    /// Re-copy (folder / raycast-folder / store bundled) installs. Git installs are not updated natively.
    @discardableResult
    func update(_ name: String, bundledDir: (String) -> URL?) throws -> InstalledExtension {
        guard let e = get(name) else { throw ExtensionError("\(name) is not installed") }
        let src = e.source
        switch src?["kind"]?.stringValue {
        case "raycast-folder":
            if let p = src?["path"]?.stringValue, fm.fileExists(atPath: p) { return try installRaycast(folder: URL(fileURLWithPath: p)) }
        case "folder":
            if let p = src?["path"]?.stringValue, fm.fileExists(atPath: p) { return try install(folder: URL(fileURLWithPath: p), source: src ?? .null) }
        case "store":
            if let n = src?["name"]?.stringValue, let dir = bundledDir(n) { return try install(folder: dir, source: src ?? .null) }
        case "git":
            throw ExtensionError("\(name) was installed from git; updating git installs needs the Electron app (or reinstall from a folder)")
        default: break
        }
        throw ExtensionError("\(name) has no update source (install it again from a folder)")
    }

    func uninstall(_ name: String) throws {
        guard Manifest.isValidName(name) else { throw ExtensionError("Invalid name") }
        try? fm.removeItem(at: installedDir.appendingPathComponent(name))
        try? fm.removeItem(at: prefsFile(name))
        var s = state()
        s[name] = nil
        try saveState(s)
    }

    // MARK: preferences / storage / support

    private func prefsFile(_ name: String) -> URL { base.appendingPathComponent("preferences/\(name).json") }
    func preferences(_ name: String) -> [String: JSONValue] { Self.readJSON(prefsFile(name))?.objectValue ?? [:] }
    func setPreferences(_ name: String, _ values: [String: JSONValue]) throws {
        guard Manifest.isValidName(name) else { throw ExtensionError("Invalid name") }
        try Self.writeJSON(prefsFile(name), .object(values), mode: 0o600)
    }

    private func storageFile(_ name: String) -> URL { base.appendingPathComponent("storage/\(name).json") }
    func storageAll(_ name: String) -> [String: JSONValue] { Self.readJSON(storageFile(name))?.objectValue ?? [:] }
    func storageWrite(_ name: String, _ mutate: (inout [String: JSONValue]) -> Void) throws {
        var d = storageAll(name)
        mutate(&d)
        try Self.writeJSON(storageFile(name), .object(d), mode: 0o600)
    }

    func supportDir(_ name: String) -> URL {
        let d = base.appendingPathComponent("support/\(name)", isDirectory: true)
        try? fm.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
}

/// Bundles a Raycast folder's `src/<command>.tsx|ts|jsx|js` with the esbuild binary (raycast-build.ts options).
/// esbuild is found at $GLIDE_ESBUILD, `<Glide.app>/Contents/Resources/esbuild/bin/esbuild`, or the dev checkout's
/// node_modules. Without it, pre-built `dist/<command>.js` files (`ray build`) are used as is.
enum RaycastBuilder {
    static let externals = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "@raycast/api", "@raycast/utils", "electron"]

    static func esbuildBinary() -> URL? {
        let fm = FileManager.default
        if let p = ProcessInfo.processInfo.environment["GLIDE_ESBUILD"], fm.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        if let r = Bundle.main.resourceURL?.appendingPathComponent("esbuild/bin/esbuild"), fm.isExecutableFile(atPath: r.path) { return r }
        // Development checkout: <glide>/node_modules/esbuild → ../@esbuild/<platform>/bin/esbuild (pnpm layout).
        var dir = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<8 {
            let nm = dir.appendingPathComponent("node_modules/esbuild")
            if fm.fileExists(atPath: nm.path) {
                let real = nm.resolvingSymlinksInPath()
                #if arch(arm64)
                let plat = "darwin-arm64"
                #else
                let plat = "darwin-x64"
                #endif
                for c in [real.deletingLastPathComponent().appendingPathComponent("@esbuild/\(plat)/bin/esbuild"),
                          dir.appendingPathComponent("node_modules/@esbuild/\(plat)/bin/esbuild")] where fm.isExecutableFile(atPath: c.path) {
                    return c
                }
            }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    static func describe(_ line: String, command: String) -> String {
        if let r = line.range(of: #"Could not resolve "([^"]+)""#, options: .regularExpression) {
            let spec = line[r].dropFirst("Could not resolve \"".count).dropLast()
            let pkg = spec.hasPrefix("@") ? spec.split(separator: "/").prefix(2).joined(separator: "/") : String(spec.split(separator: "/").first ?? "")
            if pkg.hasPrefix(".") || pkg.hasPrefix("/") { return "\(command): Missing file \"\(spec)\"" }
            return "\(command): Missing dependency \"\(pkg)\". Glide does not download packages: run `npm install` in the extension folder yourself, then import it again."
        }
        return "\(command): \(line)"
    }

    static let build: RaycastBuildFunction = { src, out, manifest in
        let fm = FileManager.default
        var errors: [String] = []
        try? fm.createDirectory(at: out, withIntermediateDirectories: true)
        let esbuild = esbuildBinary()
        for cmd in manifest.commands {
            let source = Manifest.raycastSourceCandidates(cmd.name).first { fm.fileExists(atPath: src.appendingPathComponent($0).path) }
            let outfile = out.appendingPathComponent("\(cmd.name).cjs")
            if let source, let esbuild {
                let p = Process()
                p.executableURL = esbuild
                p.currentDirectoryURL = src
                var args = [src.appendingPathComponent(source).path, "--bundle", "--platform=node", "--format=cjs", "--target=node20",
                            "--jsx=automatic", "--jsx-import-source=react", "--define:process.env.NODE_ENV=\"production\"",
                            "--asset-names=assets/[name]-[hash]", "--log-level=error", "--outfile=\(outfile.path)"]
                args += externals.map { "--external:\($0)" }
                args += ["png", "svg", "jpg", "jpeg", "gif"].map { "--loader:.\($0)=file" }
                p.arguments = args
                let errPipe = Pipe()
                p.standardError = errPipe
                p.standardOutput = FileHandle.nullDevice
                do {
                    try p.run()
                    let data = errPipe.fileHandleForReading.readDataToEndOfFile()
                    p.waitUntilExit()
                    if p.terminationStatus != 0 {
                        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { $0.hasPrefix("✘") || $0.contains("[ERROR]") }
                            .map { $0.replacingOccurrences(of: "✘ [ERROR] ", with: "") }
                        errors += (lines.isEmpty ? ["esbuild failed (\(p.terminationStatus))"] : lines).map { describe($0, command: cmd.name) }
                    }
                } catch {
                    errors.append("\(cmd.name): \(error.localizedDescription)")
                }
                continue
            }
            let prebuilt = src.appendingPathComponent("dist/\(cmd.name).js")
            if fm.fileExists(atPath: prebuilt.path) {
                try? fm.removeItem(at: outfile)
                do { try fm.copyItem(at: prebuilt, to: outfile) } catch { errors.append("\(cmd.name): \(error.localizedDescription)") }
                continue
            }
            if source == nil { errors.append("\(cmd.name): no source file (expected \(Manifest.raycastSourceCandidates(cmd.name).joined(separator: ", ")))") }
            else { errors.append("\(cmd.name): building TypeScript/JSX needs esbuild, which this Glide build does not include. Build the extension with `ray build` (dist/\(cmd.name).js) or set GLIDE_ESBUILD.") }
        }
        return errors
    }
}
