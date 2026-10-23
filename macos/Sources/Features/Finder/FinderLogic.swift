import Foundation

/// Pure planning for the Finder commands (port of src/main/features/finder/{paths,names,ops}.ts): tests check
/// exactly what would run; FinderFeature executes the plans.
public enum FinderLogic {
    public enum PathFormat: String, CaseIterable, Sendable { case posix, tilde, quoted, url }
    public static let terminals = ["Terminal", "iTerm", "Ghostty"]

    static func shellQuote(_ p: String) -> String {
        p.range(of: #"^[\w@%+=:,./-]+$"#, options: .regularExpression) != nil ? p : "'" + p.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    public static func formatPaths(_ paths: [String], _ format: PathFormat, home: String) -> String {
        let one: (String) -> String = { p in
            switch format {
            case .tilde: return p == home ? "~" : p.hasPrefix(home + "/") ? "~" + p.dropFirst(home.count) : p
            case .quoted: return shellQuote(p)
            case .url:
                return "file://" + p.split(separator: "/", omittingEmptySubsequences: false).map {
                    String($0).addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))) ?? String($0)
                }.joined(separator: "/")
            case .posix: return p
            }
        }
        return paths.map(one).joined(separator: format == .quoted ? " " : "\n")
    }

    /// Where "here" is: a selected folder, else the parent of the first selected file, else the window's folder.
    public static func hereFolder(_ paths: [String], folder: String?, isDir: (String) -> Bool) -> String? {
        if let first = paths.first { return isDir(first) ? first : (first as NSString).deletingLastPathComponent }
        return folder
    }

    /// `open` invocations; Ghostty takes the directory as a flag, the others as a document to open.
    public static func terminalSteps(_ app: String, dir: String) -> [CommandStep] {
        if app == "Ghostty" { return [CommandStep(cmd: "/usr/bin/open", args: ["-na", "Ghostty", "--args", "--working-directory=\(dir)"])] }
        return [CommandStep(cmd: "/usr/bin/open", args: ["-a", app == "iTerm" ? "iTerm" : "Terminal", dir])]
    }

    /// "notes.txt" → "notes 2.txt", "notes 3.txt", … (Finder's style).
    public static func uniqueName(_ name: String, taken: (String) -> Bool) -> String {
        if !taken(name) { return name }
        let ext = (name as NSString).pathExtension
        let base = ext.isEmpty || name.hasPrefix(".") && !name.dropFirst().contains(".") ? name : String(name.dropLast(ext.count + 1))
        let realExt = base == name ? "" : "." + ext
        for i in 2..<10_000 {
            let c = "\(base) \(i)\(realExt)"
            if !taken(c) { return c }
        }
        return "\(base) \(Int(Date().timeIntervalSince1970))\(realExt)"
    }

    public static func commonParent(_ paths: [String]) -> String {
        guard let first = paths.first else { return "/" }
        var parts = (first as NSString).deletingLastPathComponent.components(separatedBy: "/")
        for p in paths.dropFirst() {
            let other = (p as NSString).deletingLastPathComponent.components(separatedBy: "/")
            var i = 0
            while i < parts.count && i < other.count && parts[i] == other[i] { i += 1 }
            parts = Array(parts.prefix(i))
        }
        let j = parts.joined(separator: "/")
        return j.isEmpty ? "/" : j
    }

    public struct CompressPlan: Equatable, Sendable {
        public var output: String
        public var steps: [CommandStep]
    }

    /// One item → "<name>.zip" via ditto (keeps metadata like Finder); several → "Archive.zip" via zip.
    public static func compressPlan(_ paths: [String], taken: (String) -> Bool) -> CompressPlan? {
        guard let src = paths.first else { return nil }
        if paths.count == 1 {
            let dir = (src as NSString).deletingLastPathComponent
            let name = uniqueName("\((src as NSString).lastPathComponent).zip") { taken((dir as NSString).appendingPathComponent($0)) }
            let out = (dir as NSString).appendingPathComponent(name)
            return CompressPlan(output: out, steps: [CommandStep(cmd: "/usr/bin/ditto", args: ["-c", "-k", "--sequesterRsrc", "--keepParent", src, out])])
        }
        let parent = commonParent(paths)
        let name = uniqueName("Archive.zip") { taken((parent as NSString).appendingPathComponent($0)) }
        let out = (parent as NSString).appendingPathComponent(name)
        let rel = paths.map { p -> String in
            let prefix = parent == "/" ? "/" : parent + "/"
            return p.hasPrefix(prefix) ? String(p.dropFirst(prefix.count)) : "."
        }
        return CompressPlan(output: out, steps: [CommandStep(cmd: "/usr/bin/zip", args: ["-r", "-y", "-X", "-q", out] + rel, cwd: parent)])
    }

    public struct MovePlan: Equatable, Sendable {
        public var moves: [(from: String, to: String)] = []
        public var conflicts: [String] = []
        public var skipped: [String] = []
        public static func == (a: Self, b: Self) -> Bool {
            a.moves.map { $0.from + "→" + $0.to } == b.moves.map { $0.from + "→" + $0.to } && a.conflicts == b.conflicts && a.skipped == b.skipped
        }
    }

    public static func movePlan(_ paths: [String], dest: String, exists: (String) -> Bool) -> MovePlan {
        var plan = MovePlan()
        var target = dest
        while target.count > 1 && target.hasSuffix("/") { target.removeLast() }
        for from in paths {
            let name = (from as NSString).lastPathComponent
            if (from as NSString).deletingLastPathComponent == target { plan.skipped.append(from); continue }
            if target == from || target.hasPrefix(from + "/") { plan.conflicts.append("\(name) can’t be moved into itself"); continue }
            let to = (target as NSString).appendingPathComponent(name)
            if exists(to) {
                let t = (target as NSString).lastPathComponent
                plan.conflicts.append("“\(name)” already exists in \(t.isEmpty ? "/" : t)")
            } else { plan.moves.append((from, to)) }
        }
        return plan
    }

    /// Expand "~", "~/x" and relative input (relative to `base`) into an absolute path.
    public static func expandPath(_ input: String, home: String, base: String) -> String {
        let t = input.trimmingCharacters(in: .whitespaces)
        if t == "~" { return home }
        if t.hasPrefix("~/") { return ((home as NSString).appendingPathComponent(String(t.dropFirst(2))) as NSString).standardizingPath }
        if t.hasPrefix("/") { return (t as NSString).standardizingPath }
        return ((base as NSString).appendingPathComponent(t) as NSString).standardizingPath
    }

    public static func openWithSteps(_ appPath: String, paths: [String]) -> [CommandStep] { [CommandStep(cmd: "/usr/bin/open", args: ["-a", appPath] + paths)] }

    public static func describeSelection(_ paths: [String]) -> String {
        if paths.isEmpty { return "Nothing selected" }
        return paths.count == 1 ? (paths[0] as NSString).lastPathComponent : "\(paths.count) items"
    }

    public static func validateFileName(_ name: String) -> String? {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty { return "Type a file name" }
        if n == "." || n == ".." { return "That name is reserved" }
        if n.contains("/") { return "File names cannot contain “/”" }
        if n.contains("\0") { return "Invalid file name" }
        if n.utf8.count > 255 { return "That name is too long" }
        return nil
    }

    // MARK: file-system side (real runs only)

    static func isDir(_ p: String) -> Bool {
        var d: ObjCBool = false
        return FileManager.default.fileExists(atPath: p, isDirectory: &d) && d.boolValue
    }

    /// Creates an empty file; never overwrites (a taken name becomes "name 2.ext").
    public static func createEmptyFile(folder: String, name: String) -> Result<String, StepError> {
        if let bad = validateFileName(name) { return .failure(.failed(bad)) }
        guard isDir(folder) else { return .failure(.failed("That folder no longer exists")) }
        let final = uniqueName(name.trimmingCharacters(in: .whitespacesAndNewlines)) { FileManager.default.fileExists(atPath: (folder as NSString).appendingPathComponent($0)) }
        let full = (folder as NSString).appendingPathComponent(final)
        let fd = open(full, O_WRONLY | O_CREAT | O_EXCL, 0o644)
        guard fd >= 0 else { return .failure(.failed(String(cString: strerror(errno)))) }
        close(fd)
        return .success(full)
    }

    /// Moves without overwriting; refuses the whole batch when any item conflicts.
    public static func moveItems(_ paths: [String], dest: String) -> (ok: Bool, moved: Int, error: String?, plan: MovePlan) {
        guard isDir(dest) else { return (false, 0, "Destination is not a folder", MovePlan()) }
        let plan = movePlan(paths, dest: dest) { FileManager.default.fileExists(atPath: $0) }
        if !plan.conflicts.isEmpty { return (false, 0, plan.conflicts.joined(separator: "; "), plan) }
        var moved = 0
        for m in plan.moves {
            do { try FileManager.default.moveItem(atPath: m.from, toPath: m.to); moved += 1 } catch { return (false, moved, error.localizedDescription, plan) }
        }
        return (true, moved, nil, plan)
    }

    public struct Destination: Hashable, Sendable {
        public var path: String
        public var name: String
        /// "typed" | "recent" | "place" | "child"
        public var kind: String
    }

    /// Sub-folders of the folder part of `typedAbs` whose names start with the last segment.
    public static func completeFolder(_ typedAbs: String, endsWithSlash: Bool, limit: Int = 30) -> [Destination] {
        let dir = endsWithSlash ? typedAbs : (typedAbs as NSString).deletingLastPathComponent
        let prefix = endsWithSlash ? "" : (typedAbs as NSString).lastPathComponent.lowercased()
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        return names.filter { !$0.hasPrefix(".") && $0.lowercased().hasPrefix(prefix) && !$0.hasSuffix(".app") }
            .map { Destination(path: (dir as NSString).appendingPathComponent($0), name: $0, kind: "child") }
            .filter { isDir($0.path) }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
            .prefix(limit).map { $0 }
    }

    public static func places(home: String) -> [Destination] {
        [("Desktop", home + "/Desktop"), ("Documents", home + "/Documents"), ("Downloads", home + "/Downloads"), ("Home", home), ("Applications", "/Applications")]
            .map { Destination(path: $0.1, name: $0.0, kind: "place") }.filter { isDir($0.path) }
    }

    public static func destinations(query: String, base: String?, home: String, recent: [String]) -> [Destination] {
        var rows: [Destination] = []
        func add(_ d: Destination) { if !rows.contains(where: { $0.path == d.path }) { rows.append(d) } }
        let q = query.trimmingCharacters(in: .whitespaces)
        if let c = q.first, "~/.".contains(c) {
            let abs = expandPath(q, home: home, base: base ?? home)
            if isDir(abs) { add(Destination(path: abs, name: (abs as NSString).lastPathComponent.isEmpty ? "/" : (abs as NSString).lastPathComponent, kind: "typed")) }
            for s in completeFolder(abs, endsWithSlash: q.hasSuffix("/")) { add(s) }
            return rows
        }
        for r in recent where isDir(r) { add(Destination(path: r, name: (r as NSString).lastPathComponent, kind: "recent")) }
        for p in places(home: home) { add(p) }
        let needle = q.lowercased()
        return needle.isEmpty ? rows : rows.filter { $0.name.lowercased().contains(needle) || $0.path.lowercased().contains(needle) }
    }

    public static func listApps(_ dirs: [String]) -> [(name: String, path: String)] {
        var seen: [String: (String, String)] = [:]
        for dir in dirs {
            for n in (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [] where n.hasSuffix(".app") {
                let name = String(n.dropLast(4))
                if seen[name.lowercased()] == nil { seen[name.lowercased()] = (name, (dir as NSString).appendingPathComponent(n)) }
            }
        }
        return seen.values.sorted { $0.0.localizedCompare($1.0) == .orderedAscending }.map { (name: $0.0, path: $0.1) }
    }
}
