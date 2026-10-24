import Foundation

/// Paths and helpers shared by the phone-web tests.
enum PhoneWebSupport {
    static let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    static let repo = testsDir.deletingLastPathComponent().deletingLastPathComponent()
    static let webDir = repo.appendingPathComponent("Sources/Features/Phone/Web")

    /// Node for the crypto vectors and the browser E2E: $NODE, then the usual install locations.
    static var node: String? {
        let env = ProcessInfo.processInfo.environment
        let candidates = [env["NODE"], "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].compactMap { $0 }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Headless Chrome for the web E2E: $GLIDE_CHROME or the standard app bundle.
    static var chrome: String? {
        let env = ProcessInfo.processInfo.environment
        let candidates = [env["GLIDE_CHROME"], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                          "/Applications/Chromium.app/Contents/MacOS/Chromium"].compactMap { $0 }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Scratch space for this run (GLIDE_E2E_TMP or the system temp dir).
    static func scratch(_ name: String) throws -> URL {
        let base = ProcessInfo.processInfo.environment["GLIDE_E2E_TMP"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("phone-web-\(name)-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    struct Run { var status: Int32; var stdout: String; var stderr: String }

    /// Run a tool with a timeout (SIGKILL when it runs over).
    static func run(_ tool: String, _ args: [String], environment: [String: String] = [:], timeout: TimeInterval = 60) throws -> Run {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        for (k, v) in environment { env[k] = v }
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        let outBox = DataBox(), errBox = DataBox()
        out.fileHandleForReading.readabilityHandler = { h in outBox.append(h.availableData) }
        err.fileHandleForReading.readabilityHandler = { h in errBox.append(h.availableData) }
        try p.run()
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL); p.waitUntilExit() }
        p.waitUntilExit()
        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        outBox.append(out.fileHandleForReading.readDataToEndOfFile())
        errBox.append(err.fileHandleForReading.readDataToEndOfFile())
        return Run(status: p.terminationStatus, stdout: outBox.string, stderr: errBox.string)
    }

    final class DataBox: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func append(_ d: Data) { lock.lock(); data.append(d); lock.unlock() }
        var string: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
    }

    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
    static func fromHex(_ s: String) -> Data {
        var out = Data()
        var i = s.startIndex
        while let j = s.index(i, offsetBy: 2, limitedBy: s.endIndex), i < s.endIndex {
            if let b = UInt8(s[i..<j], radix: 16) { out.append(b) }
            i = j
        }
        return out
    }
    static func random(_ n: Int) -> Data { Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }
}
