import Foundation

/// Raycast Script Command metadata (`# @raycast.title …`, also `//` / `--` comments and the `@glide.` prefix).
/// Port of src/main/features/scripts/parse.ts.
struct ScriptArgument: Hashable, Sendable {
    /// "text" | "password" | "dropdown"
    var type: String
    var placeholder: String
    var optional: Bool
    var percentEncoded: Bool
    var data: [(title: String, value: String)] = []

    static func == (a: Self, b: Self) -> Bool {
        a.type == b.type && a.placeholder == b.placeholder && a.optional == b.optional && a.percentEncoded == b.percentEncoded
            && a.data.map(\.value) == b.data.map(\.value) && a.data.map(\.title) == b.data.map(\.title)
    }
    func hash(into h: inout Hasher) { h.combine(type); h.combine(placeholder); h.combine(optional) }
}

struct ScriptMeta: Sendable {
    var title: String?
    /// "fullOutput" | "compact" | "silent" | "inline"
    var mode: String?
    var icon: String?
    var packageName: String?
    var description: String?
    var author: String?
    var refreshTimeMs: Int?
    var needsConfirmation = false
    var currentDirectoryPath: String?
    var arguments: [ScriptArgument] = []
    var errors: [String] = []
}

enum ScriptParser {
    static let modes = ["fullOutput", "compact", "silent", "inline"]
    static let minRefreshMs = 10_000
    private static let line = try! NSRegularExpression(pattern: #"^\s*(?:#|//|--)\s*@(?:raycast|glide)\.([A-Za-z]+\d*)\s*(.*?)\s*$"#)

    static func parseDuration(_ text: String) -> Int? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard let re = try? NSRegularExpression(pattern: #"^(\d+(?:\.\d+)?)\s*([smhdSMHD])$"#),
              let m = re.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)),
              let nr = Range(m.range(at: 1), in: t), let ur = Range(m.range(at: 2), in: t), let n = Double(t[nr]) else { return nil }
        let mult: Double = ["s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000][t[ur].lowercased()] ?? 1000
        return Int((n * mult).rounded())
    }

    private static func parseArgument(_ raw: String, _ n: Int, _ errors: inout [String]) -> ScriptArgument? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) else { errors.append("argument\(n) is not valid JSON"); return nil }
        guard let o = obj as? [String: Any] else { errors.append("argument\(n) must be a JSON object"); return nil }
        let type = o["type"] as? String ?? "text"
        guard ["text", "password", "dropdown"].contains(type) else { errors.append("argument\(n) has unsupported type \"\(type)\""); return nil }
        var arg = ScriptArgument(type: type, placeholder: o["placeholder"] as? String ?? "Argument \(n)", optional: o["optional"] as? Bool == true,
                                 percentEncoded: o["percentEncoded"] as? Bool == true)
        if type == "dropdown" {
            arg.data = ((o["data"] as? [Any]) ?? []).compactMap { d in
                guard let d = d as? [String: Any], let v = d["value"] as? String else { return nil }
                return (title: (d["title"] as? String) ?? v, value: v)
            }
            if arg.data.isEmpty { errors.append("argument\(n) dropdown needs a non-empty \"data\" list") }
        }
        return arg
    }

    static func parse(_ source: String) -> ScriptMeta {
        var meta = ScriptMeta()
        var args: [Int: ScriptArgument] = [:]
        for l in source.split(separator: "\n", omittingEmptySubsequences: false).prefix(200) {
            let s = String(l).replacingOccurrences(of: "\r", with: "")
            guard let m = line.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
                  let kr = Range(m.range(at: 1), in: s), let vr = Range(m.range(at: 2), in: s) else { continue }
            let key = String(s[kr]), value = String(s[vr])
            let v = value.isEmpty ? nil : value
            switch key {
            case "title": meta.title = v
            case "mode":
                if modes.contains(value) { meta.mode = value } else { meta.errors.append("Unknown mode \"\(value)\" (use \(modes.joined(separator: ", ")))") }
            case "icon": meta.icon = v
            case "packageName": meta.packageName = v
            case "description": meta.description = v
            case "author": meta.author = v
            case "needsConfirmation": meta.needsConfirmation = value == "true"
            case "currentDirectoryPath": meta.currentDirectoryPath = v
            case "refreshTime":
                if let ms = parseDuration(value) { meta.refreshTimeMs = max(minRefreshMs, ms) } else { meta.errors.append("Invalid refreshTime \"\(value)\" (e.g. 30s, 5m, 1h, 1d)") }
            default:
                if key.hasPrefix("argument"), let n = Int(key.dropFirst("argument".count)), key.count == "argument".count + 1 {
                    if n < 1 || n > 3 { meta.errors.append("Only argument1…argument3 are supported") } else if let a = parseArgument(value, n, &meta.errors) { args[n] = a }
                }
            }
        }
        if meta.title == nil { meta.errors.append("Missing @raycast.title") }
        if meta.mode == nil && !meta.errors.contains(where: { $0.hasPrefix("Unknown mode") }) { meta.errors.append("Missing @raycast.mode") }
        for n in 1...3 {
            guard let a = args[n] else {
                if args.keys.contains(where: { $0 > n }) { meta.errors.append("argument\(n) is missing but a later argument is declared") }
                break
            }
            meta.arguments.append(a)
        }
        return meta
    }

    /// Shell-like split; the last argument takes the rest verbatim.
    static func splitArguments(_ text: String, count: Int) -> [String] {
        var out: [String] = []
        var rest = Substring(text.trimmingCharacters(in: .whitespacesAndNewlines))
        func unquote(_ s: Substring) -> String? {
            if s.count >= 2, s.first == "\"", s.last == "\"" {
                var r = "", esc = false
                for c in s.dropFirst().dropLast() { if esc { r.append(c); esc = false } else if c == "\\" { esc = true } else { r.append(c) } }
                return r
            }
            if s.count >= 2, s.first == "'", s.last == "'" { return String(s.dropFirst().dropLast()) }
            return nil
        }
        while !rest.isEmpty && out.count < count - 1 {
            var token = Substring()
            if let q = rest.first, q == "\"" || q == "'" {
                var i = rest.index(after: rest.startIndex)
                var esc = false
                while i < rest.endIndex { let c = rest[i]; if q == "\"" && esc { esc = false } else if q == "\"" && c == "\\" { esc = true } else if c == q { break }; i = rest.index(after: i) }
                if i >= rest.endIndex { break }
                token = rest[rest.startIndex...i]
                out.append(unquote(token) ?? String(token))
                rest = rest[rest.index(after: i)...]
            } else {
                let end = rest.firstIndex(where: \.isWhitespace) ?? rest.endIndex
                out.append(String(rest[..<end]))
                rest = rest[end...]
            }
            rest = rest.drop(while: \.isWhitespace)
        }
        if !rest.isEmpty && out.count < count { out.append(unquote(rest) ?? String(rest)) }
        return out
    }

    static func lastLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.last ?? ""
    }

    static func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }
}

/// Runs one script file with its shebang (zsh fallback when it has none / is not executable), streaming
/// output, in its own process group so a timeout or Stop also kills its children.
final class ScriptRun: @unchecked Sendable {
    struct Outcome: Sendable, Equatable {
        var code: Int32?
        var stdout: String
        var stderr: String
        var timedOut: Bool
        var error: String?
        var ok: Bool { code == 0 && error == nil }
    }

    private let lock = NSLock()
    private var process: Process?
    private var outBuf = Data(), errBuf = Data()
    private var finished: Outcome?
    private var waiters: [CheckedContinuation<Outcome, Never>] = []
    private var timedOut = false
    var onChunk: (@Sendable (_ stream: String, _ text: String) -> Void)?

    static func hasShebang(_ file: URL) -> Bool {
        guard let h = FileHandle(forReadingAtPath: file.path) else { return false }
        defer { try? h.close() }
        return (try? h.read(upToCount: 2)) == Data("#!".utf8)
    }

    func start(file: URL, args: [String], cwd: URL?, env: [String: String], timeout: TimeInterval) {
        let p = Process()
        let fm = FileManager.default
        if let attrs = try? fm.attributesOfItem(atPath: file.path), let mode = attrs[.posixPermissions] as? Int, mode & 0o100 == 0 {
            try? fm.setAttributes([.posixPermissions: mode | 0o755], ofItemAtPath: file.path)
        }
        if Self.hasShebang(file) && fm.isExecutableFile(atPath: file.path) {
            p.executableURL = file
            p.arguments = args
        } else {
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = [file.path] + args
        }
        p.currentDirectoryURL = cwd ?? file.deletingLastPathComponent()
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        out.fileHandleForReading.readabilityHandler = { [weak self] h in self?.chunk(h.availableData, stdout: true) }
        err.fileHandleForReading.readabilityHandler = { [weak self] h in self?.chunk(h.availableData, stdout: false) }
        p.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            self?.chunk(out.fileHandleForReading.readDataToEndOfFile(), stdout: true)
            self?.chunk(err.fileHandleForReading.readDataToEndOfFile(), stdout: false)
            self?.finish(code: proc.terminationStatus, error: nil)
        }
        do {
            try p.run()
            setpgid(p.processIdentifier, p.processIdentifier)
            lock.lock(); process = p; lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self, p.isRunning else { return }
                self.lock.lock(); self.timedOut = true; self.lock.unlock()
                self.signal(SIGTERM)
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) { if p.isRunning { self.signal(SIGKILL) } }
            }
        } catch {
            finish(code: nil, error: error.localizedDescription)
        }
    }

    private func chunk(_ d: Data, stdout: Bool) {
        guard !d.isEmpty else { return }
        lock.lock()
        if stdout { if outBuf.count < 1 << 20 { outBuf.append(d) } } else if errBuf.count < 1 << 20 { errBuf.append(d) }
        lock.unlock()
        onChunk?(stdout ? "stdout" : "stderr", String(decoding: d, as: UTF8.self))
    }

    private func finish(code: Int32?, error: String?) {
        lock.lock()
        guard finished == nil else { lock.unlock(); return }
        let o = Outcome(code: code, stdout: String(decoding: outBuf, as: UTF8.self), stderr: String(decoding: errBuf, as: UTF8.self), timedOut: timedOut,
                        error: error ?? (timedOut ? "Timed out" : nil))
        finished = o
        let w = waiters
        waiters = []
        lock.unlock()
        for c in w { c.resume(returning: o) }
    }

    func signal(_ sig: Int32) {
        lock.lock(); let p = process; lock.unlock()
        guard let p, p.isRunning else { return }
        if kill(-p.processIdentifier, sig) != 0 { kill(p.processIdentifier, sig) }
    }

    func stop() { signal(SIGTERM) }

    var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return finished == nil }

    func wait() async -> Outcome {
        await withCheckedContinuation { c in
            lock.lock()
            if let f = finished { lock.unlock(); c.resume(returning: f); return }
            waiters.append(c)
            lock.unlock()
        }
    }
}
