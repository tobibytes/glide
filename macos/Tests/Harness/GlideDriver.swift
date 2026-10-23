import Foundation
import MachO

/// Drives a headless Glide over its stdin/stdout test channel.
///
/// - Spawns `Glide --test-server` with GLIDE_HEADLESS=1, a fresh temp GLIDE_USER_DATA (optionally seeded with a
///   data.json / usage.json), and GLIDE_TEST_PARENT_PID so the app exits if the test process dies.
/// - `send` writes one JSON command and waits for the matching response (correlated by "id").
/// - `[headless] …` lines are collected in `sideEffects`.
/// - `stop()` (also on deinit) sends quit, then SIGTERM, then SIGKILL. The temp dir is removed.
public final class GlideDriver: @unchecked Sendable {
    public enum DriverError: Error, CustomStringConvertible {
        case binaryNotFound(String), stale(String), notReady(String), timeout(String), exited
        public var description: String {
            switch self {
            case let .binaryNotFound(p): return "Glide binary not found (\(p)); run `swift build --product Glide` or set GLIDE_BINARY"
            case let .stale(f): return "Glide binary is older than \(f): run `swift build` (or scripts/test.sh) before `swift test`"
            case let .notReady(log): return "Glide did not become ready: \(log)"
            case let .timeout(c): return "timed out waiting for response to \(c)"
            case .exited: return "Glide exited"
            }
        }
    }

    public let process = Process()
    public let dataDirectory: URL
    private let stdin = Pipe()
    private let stdout = Pipe()
    private let stderr = Pipe()
    private let lock = NSLock()
    private var buffer = Data()
    private var responses: [Int: [String: Any]] = [:]
    private var lines: [String] = []
    private var nextId = 1
    private var ready = false
    private let signal = DispatchSemaphore(value: 0)
    private var stopped = false
    private let keepData: Bool
    public private(set) var readyInfo: [String: Any] = [:]

    /// Default binary: $GLIDE_BINARY, else `<package>/.build/debug/Glide` found next to the running test bundle.
    public static func defaultBinary() -> URL? {
        if let p = ProcessInfo.processInfo.environment["GLIDE_BINARY"] { return URL(fileURLWithPath: p) }
        for b in Bundle.allBundles where b.bundlePath.hasSuffix(".xctest") {
            let candidate = b.bundleURL.deletingLastPathComponent().appendingPathComponent("Glide")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        // swift-testing (swiftpm-testing-helper) loads the .xctest bundle without listing it in Bundle.allBundles;
        // find it among the loaded images so a `--scratch-path` build drives ITS Glide, not a stale .build one.
        for i in 0..<_dyld_image_count() {
            guard let cName = _dyld_get_image_name(i) else { continue }
            let path = String(cString: cName)
            guard let r = path.range(of: ".xctest/") else { continue }
            let bundle = URL(fileURLWithPath: String(path[..<r.lowerBound]) + ".xctest")
            let candidate = bundle.deletingLastPathComponent().appendingPathComponent("Glide")
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<4 {
            let c = dir.appendingPathComponent(".build/debug/Glide")
            if FileManager.default.isExecutableFile(atPath: c.path) { return c }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    /// `swift test` compiles the app modules but does not relink the Glide executable, so refuse to drive a
    /// binary that is older than any object file it is linked from.
    static func newerSource(than binary: URL) -> String? {
        let dir = binary.deletingLastPathComponent()
        guard let binDate = (try? binary.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate else { return nil }
        for module in ["Glide", "GlideCore", "GlideSystem", "GlideUI", "GlideFeatures"] {
            let mdir = dir.appendingPathComponent("\(module).build")
            guard let files = try? FileManager.default.contentsOfDirectory(at: mdir, includingPropertiesForKeys: [.contentModificationDateKey]) else { continue }
            for url in files where url.path.hasSuffix(".swift.o") {
                if let d = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, d > binDate.addingTimeInterval(1) {
                    return "\(module)/\(url.lastPathComponent)"
                }
            }
        }
        return nil
    }

    /// - Parameters:
    ///   - seed: files to put in the data dir before launch, e.g. ["data.json": data].
    ///   - environment: extra env (GLIDE_HEADLESS_SELECTION, GLIDE_HEADLESS_CONFIRM=0, …).
    public init(binary: URL? = nil, seed: [String: Data] = [:], environment: [String: String] = [:], keepData: Bool = false, readyTimeout: TimeInterval = 20) throws {
        guard let bin = binary ?? Self.defaultBinary(), FileManager.default.isExecutableFile(atPath: bin.path) else {
            throw DriverError.binaryNotFound(binary?.path ?? "auto")
        }
        if binary == nil, ProcessInfo.processInfo.environment["GLIDE_BINARY"] == nil, let newer = Self.newerSource(than: bin) { throw DriverError.stale(newer) }
        self.keepData = keepData
        // GLIDE_E2E_TMP: parent for the fresh data dir (sessions keep test data in their scratch dir).
        let tmpRoot = ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
        dataDirectory = tmpRoot.appendingPathComponent("glide-e2e-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        for (name, data) in seed {
            let url = dataDirectory.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) // nested seeds (features/<id>/…)
            try data.write(to: url)
        }

        var env = ProcessInfo.processInfo.environment
        env["GLIDE_HEADLESS"] = "1"
        env["GLIDE_TEST_SERVER"] = "1"
        env["GLIDE_USER_DATA"] = dataDirectory.path
        env["GLIDE_TEST_PARENT_PID"] = String(getpid())
        env["GLIDE_HELPER_DRY_RUN"] = "1"
        for (k, v) in environment { env[k] = v }
        process.executableURL = bin
        process.arguments = ["--test-server"]
        process.environment = env
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; self?.signal.signal(); return }
            self?.consume(d)
        }
        stderr.fileHandleForReading.readabilityHandler = { h in if h.availableData.isEmpty { h.readabilityHandler = nil } }
        process.terminationHandler = { [weak self] _ in self?.signal.signal() }
        try process.run()

        let deadline = Date().addingTimeInterval(readyTimeout)
        while Date() < deadline {
            lock.lock()
            let ok = ready
            lock.unlock()
            if ok { return }
            if !process.isRunning { break }
            _ = signal.wait(timeout: .now() + 0.1)
        }
        let log = lines.joined(separator: "\n")
        stop()
        throw DriverError.notReady(log)
    }

    deinit { stop() }

    private func consume(_ d: Data) {
        lock.lock()
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            let line = String(decoding: lineData, as: UTF8.self)
            lines.append(line)
            if line.hasPrefix("{"), let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] {
                if obj["event"] as? String == "ready" { ready = true; readyInfo = obj }
                if let id = obj["id"] as? Int { responses[id] = obj }
            }
        }
        lock.unlock()
        signal.signal()
    }

    /// Send a command and wait for its response.
    @discardableResult
    public func send(_ command: [String: Any], timeout: TimeInterval = 15) throws -> [String: Any] {
        lock.lock()
        let id = nextId
        nextId += 1
        lock.unlock()
        var cmd = command
        cmd["id"] = id
        var data = try JSONSerialization.data(withJSONObject: cmd)
        data.append(0x0A)
        try stdin.fileHandleForWriting.write(contentsOf: data)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            lock.lock()
            if let r = responses.removeValue(forKey: id) { lock.unlock(); return r }
            lock.unlock()
            if !process.isRunning { throw DriverError.exited }
            _ = signal.wait(timeout: .now() + 0.05)
        }
        throw DriverError.timeout("\(command)")
    }

    // MARK: conveniences

    public func show() throws -> [String: Any] { try send(["cmd": "show"]) }
    public func hide() throws -> [String: Any] { try send(["cmd": "hide"]) }
    @discardableResult public func type(_ text: String) throws -> [String: Any] { try send(["cmd": "type", "text": text]) }
    @discardableResult public func key(_ key: String) throws -> [String: Any] { try send(["cmd": "key", "key": key]) }
    public func state() throws -> [String: Any] { try send(["cmd": "state"]) }
    public func snapshot(_ path: String) throws -> [String: Any] { try send(["cmd": "snapshot", "path": path]) }
    public func metrics() throws -> [String: Any] { try send(["cmd": "metrics"]) }
    @discardableResult public func invoke(_ feature: String, _ method: String, _ args: Any = NSNull()) throws -> [String: Any] {
        try send(["cmd": "invoke", "feature": feature, "method": method, "args": args])
    }

    /// Titles of the result rows in order.
    public func titles() throws -> [String] { ((try state()["rows"] as? [[String: Any]]) ?? []).compactMap { $0["title"] as? String } }
    public func selectedTitle() throws -> String? {
        ((try state()["rows"] as? [[String: Any]]) ?? []).first { $0["selected"] as? Bool == true }?["title"] as? String
    }

    /// `[headless] <kind> <json>` lines seen so far.
    public var sideEffects: [(kind: String, detail: String)] {
        lock.lock()
        defer { lock.unlock() }
        return lines.filter { $0.hasPrefix("[headless] ") }.map { l in
            let rest = l.dropFirst("[headless] ".count)
            let parts = rest.split(separator: " ", maxSplits: 1)
            return (String(parts.first ?? ""), parts.count > 1 ? String(parts[1]) : "")
        }
    }

    public var outputLines: [String] { lock.lock(); defer { lock.unlock() }; return lines }

    /// quit → SIGTERM → SIGKILL. Always leaves no process behind.
    public func stop() {
        lock.lock()
        if stopped { lock.unlock(); return }
        stopped = true
        lock.unlock()
        if process.isRunning {
            try? stdin.fileHandleForWriting.write(contentsOf: Data("{\"cmd\":\"quit\"}\n".utf8))
            waitExit(2)
        }
        if process.isRunning { process.terminate(); waitExit(1) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL); waitExit(1) }
        try? stdin.fileHandleForWriting.close()
        if !keepData { try? FileManager.default.removeItem(at: dataDirectory) }
    }

    private func waitExit(_ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning && Date() < deadline { usleep(20_000) }
    }
}
