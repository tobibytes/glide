import Foundation
import GlideCore

/// Serialised stdout writer shared by the side-effect log and the test channel (one line per write).
public final class StdoutWriter: @unchecked Sendable {
    public static let shared = StdoutWriter()
    private let lock = NSLock()
    public func line(_ s: String) {
        var data = Data(s.utf8)
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
}

/// Every side effect a headless run WOULD have performed, printed as `[headless] <kind> <json>` and kept in
/// memory (test channel: `{"cmd":"invoke","feature":"headless","method":"effects"}`).
public final class SideEffectLog: @unchecked Sendable {
    public struct Entry: Codable, Sendable, Equatable {
        public var kind: String
        public var detail: JSONValue
    }
    private let lock = NSLock()
    private var entries: [Entry] = []
    public let echo: Bool
    public init(echo: Bool = true) { self.echo = echo }

    public func record(_ kind: String, _ detail: JSONValue = .null) {
        lock.lock()
        entries.append(Entry(kind: kind, detail: detail))
        if entries.count > 1000 { entries.removeFirst(entries.count - 1000) }
        lock.unlock()
        if echo {
            let json = (try? String(decoding: JSONEncoder.glideCompact.encode(detail), as: UTF8.self)) ?? "null"
            StdoutWriter.shared.line("[headless] \(kind) \(json)")
        }
    }

    public var all: [Entry] { lock.lock(); defer { lock.unlock() }; return entries }

    /// The app's log in headless runs (set by the app at launch), so helpers without a FeatureContext record into
    /// the same `headless/effects` list.
    nonisolated(unsafe) public static var current: SideEffectLog?

    /// Record into `current`, or (unit tests without an app) just print the `[headless]` line.
    public static func recordShared(_ kind: String, _ detail: JSONValue) {
        if let log = current { log.record(kind, detail); return }
        let json = (try? String(decoding: JSONEncoder.glideCompact.encode(detail), as: UTF8.self)) ?? "null"
        StdoutWriter.shared.line("[headless] \(kind) \(json)")
    }
    public func clear() { lock.lock(); entries = []; lock.unlock() }
}
