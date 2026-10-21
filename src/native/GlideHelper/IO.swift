import Foundation

/// Newline-delimited JSON on stdout. Writes go through write(2) so a closed pipe returns EPIPE
/// instead of raising an Objective-C exception (SIGPIPE is ignored in main.swift).
enum Output {
    private static let lock = NSLock()

    static func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
        else {
            log("could not encode message: \(object)")
            return
        }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        data.withUnsafeBytes { raw in
            guard var base = raw.baseAddress else { return }
            var remaining = raw.count
            while remaining > 0 {
                let n = write(STDOUT_FILENO, base, remaining)
                if n <= 0 { if errno == EINTR { continue }; return }
                remaining -= n
                base = base.advanced(by: n)
            }
        }
    }

    static func result(_ id: Any, _ value: Any) { send(["id": id, "result": value]) }
    static func error(_ id: Any, _ message: String) { send(["id": id, "error": message]) }
    static func event(_ name: String, _ data: Any) { send(["event": name, "data": data]) }
}

func log(_ message: String) {
    let line = "[glide-helper] \(message)\n"
    line.withCString { ptr in _ = write(STDERR_FILENO, ptr, strlen(ptr)) }
}

struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

typealias Params = [String: Any]

/// Run on the main thread and wait (AppKit / event-tap state lives there).
func onMain<T>(_ work: () throws -> T) rethrows -> T {
    if Thread.isMainThread { return try work() }
    return try DispatchQueue.main.sync(execute: work)
}

/// Run a command-line tool, returning (status, stdout).
@discardableResult
func runTool(_ path: String, _ args: [String]) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return (-1, "") }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}
