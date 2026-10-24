import Foundation
import GlideCore

// iCloud Drive relay (docs/PHONE.md, "Transport 2").
// Pure, nonisolated logic: folder layout, request parsing, reply encoding, file classification. No I/O state here,
// so all of it is unit-tested without a running feature.

/// Where the relay lives. The contract folder is `iCloud Drive/Glide/Phone`. Shortcuts built by Glide can only save
/// without a folder picker relative to the Shortcuts app's own iCloud folder (`iCloud Drive/Shortcuts`), so Glide
/// watches `Shortcuts/Glide/Phone` too. `GLIDE_PHONE_RELAY_DIR` replaces both (tests always set it).
public enum PhoneRelayPaths {
    public static let envOverride = "GLIDE_PHONE_RELAY_DIR"

    public static func roots(environment: [String: String] = ProcessInfo.processInfo.environment,
                             home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [URL] {
        if let o = environment[envOverride], !o.isEmpty { return [URL(fileURLWithPath: o, isDirectory: true).standardizedFileURL] }
        let mobile = home.appendingPathComponent("Library/Mobile Documents", isDirectory: true)
        return [
            mobile.appendingPathComponent("com~apple~CloudDocs/Glide/Phone", isDirectory: true),
            mobile.appendingPathComponent("iCloud~is~workflow~my~workflows/Documents/Glide/Phone", isDirectory: true),
        ]
    }

    public static func inbox(_ root: URL) -> URL { root.appendingPathComponent("inbox", isDirectory: true) }
    public static func outbox(_ root: URL) -> URL { root.appendingPathComponent("outbox", isDirectory: true) }
    public static func clipboard(_ root: URL) -> URL { root.appendingPathComponent("clipboard.json") }
}

public enum PhoneRelayLimits {
    /// Largest inbox file read (a shared photo, base64). Bigger files get a `too-large` reply.
    public static let maxRequestBytes = 25 * 1024 * 1024
    /// Largest outbox reply written. Bigger results are replaced by a `too-large` error.
    public static let maxReplyBytes = 25 * 1024 * 1024
    /// A file that is not valid JSON yet may still be syncing; give it this long before answering with an error.
    public static let partialGrace: TimeInterval = 15
    /// Requests older than this (the Mac was off or asleep) are answered `expired` and never run.
    public static let maxRequestAge: TimeInterval = 60 * 60
    /// Outbox replies older than this are deleted.
    public static let outboxTTL: TimeInterval = 10 * 60
    /// Ids remembered for duplicate detection.
    public static let seenTTL: TimeInterval = 60 * 60
    public static let maxSeen = 2048
    /// Mirror cap for clipboard.json.
    public static let maxClipboardBytes = 64 * 1024
}

/// One parsed `inbox/<id>.json`.
public struct PhoneRelayRequest: Sendable, Equatable {
    public var id: String
    public var action: String
    public var args: JSONValue
    public var from: String?
}

public enum PhoneRelayParse: Sendable, Equatable {
    case request(PhoneRelayRequest)
    /// Not valid (yet): maybe a partial write. Retry until `partialGrace` passes, then answer with this error.
    case incomplete(String)
    /// Valid JSON but not a usable request: answer with this error now.
    case invalid(id: String, PhoneError)
}

public enum PhoneRelayProtocol {
    /// Ids become file names: keep them short and boring.
    public static func isValidId(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 64, s != ".", s != ".." else { return false }
        return s.unicodeScalars.allSatisfy { c in
            (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "-" || c == "_" || c == "."
        } && !s.hasPrefix(".")
    }

    /// `ab12.json` → `ab12`; Shortcuts may also produce `ab12.json.json` or `ab12.txt`.
    public static func stem(of fileName: String) -> String {
        var s = fileName
        for ext in [".json", ".txt", ".plist"] { while s.lowercased().hasSuffix(ext) { s = String(s.dropLast(ext.count)) } }
        return s
    }

    /// An id usable for the reply file name when the request itself has none (or a bad one).
    public static func fallbackId(fileName: String) -> String {
        let st = stem(of: fileName)
        if isValidId(st) { return st }
        let cleaned = String(st.unicodeScalars.filter { c in
            (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "-" || c == "_"
        }.prefix(48).map(Character.init))
        var h: UInt32 = 5381
        for b in fileName.utf8 { h = (h &* 33) ^ UInt32(b) }
        return cleaned.isEmpty ? "request-\(h % 1_000_000)" : cleaned
    }

    /// Parse an inbox file. JSON first; a binary or XML plist (what a Shortcuts dictionary can turn into) is accepted too.
    public static func parse(_ data: Data, fileName: String) -> PhoneRelayParse {
        let fallback = fallbackId(fileName: fileName)
        let trimmed = data.drop { $0 == 0x20 || $0 == 0x0A || $0 == 0x0D || $0 == 0x09 || $0 == 0xEF || $0 == 0xBB || $0 == 0xBF }
        if trimmed.isEmpty { return .incomplete("The request file is empty.") }
        var value: JSONValue?
        if let v = try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed)) {
            value = v
        } else if let p = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) {
            value = JSONValue(any: p)
        }
        guard let value else { return .incomplete("The request file is not valid JSON.") }
        guard let obj = value.objectValue else {
            return .invalid(id: fallback, .badArgs("The request must be a JSON object."))
        }
        var id = fallback
        if let raw = obj["id"] {
            let s = raw.stringValue ?? raw.intValue.map(String.init) ?? ""
            guard isValidId(s) else { return .invalid(id: fallback, .badArgs("The request id may only use letters, digits, dots, dashes and underscores (64 at most).")) }
            id = s
        }
        if let v = obj["v"], let n = v.intValue ?? v.stringValue.flatMap({ Int($0) }), n != 1 {
            return .invalid(id: id, PhoneError("unsupported", "This request uses relay version \(n). Update Glide on your Mac."))
        }
        guard let action = obj["action"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !action.isEmpty, action.count <= 64 else {
            return .invalid(id: id, .badArgs("The request has no action."))
        }
        var args = obj["args"] ?? .object([:])
        if args.isNull { args = .object([:]) }
        // A Shortcuts text field can only carry a string: accept args given as a JSON string.
        if let s = args.stringValue {
            if let d = s.data(using: .utf8), let v = try? JSONDecoder().decode(JSONValue.self, from: d), v.objectValue != nil { args = v } else {
                return .invalid(id: id, .badArgs("args must be a JSON object."))
            }
        }
        guard args.objectValue != nil else { return .invalid(id: id, .badArgs("args must be a JSON object.")) }
        return .request(PhoneRelayRequest(id: id, action: action, args: args, from: obj["from"]?.stringValue))
    }

    public static let caller = PhoneCaller(deviceId: "icloud", deviceName: "Shortcuts", transport: .relay)

    /// The reply object written to `outbox/<id>.json`: `{"id","ok",…}` as on the LAN, plus `text`, a plain
    /// human-readable line (the agent's answer, a message, or the error) so a shortcut can show it without parsing.
    public static func reply(id: String, outcome: JSONValue) -> JSONValue {
        var o = outcome.objectValue ?? [:]
        if o["ok"]?.boolValue == nil {
            // Not an envelope: a bare result.
            o = ["ok": true, "result": outcome]
        }
        o["id"] = .string(id)
        if o["text"] == nil { o["text"] = .string(summary(o)) }
        return .object(o)
    }

    public static func errorReply(id: String, _ e: PhoneError) -> JSONValue {
        reply(id: id, outcome: ["ok": false, "error": ["code": .string(e.code), "message": .string(e.message)]])
    }

    static func summary(_ o: [String: JSONValue]) -> String {
        if o["ok"]?.boolValue == false {
            return o["error"]?["message"]?.stringValue ?? "Glide could not do that."
        }
        let r = o["result"]
        // Glide Agent waiting for an approval (phone-notify): approvals are LAN-only, so say where to answer.
        if r?["status"]?.stringValue == "confirming" {
            let t = r?["text"]?.stringValue.map { $0.isEmpty ? "" : $0 + "\n\n" } ?? ""
            return t + "Glide Agent is waiting for your approval. Approve it in Glide Remote or on the Mac."
        }
        for k in ["text", "message", "result"] { if let s = r?[k]?.stringValue, !s.isEmpty { return s } }
        if let s = r?.stringValue, !s.isEmpty { return s }
        return "Done"
    }

    public static func encode(_ v: JSONValue) -> Data {
        (try? JSONEncoder.glideCompact.encode(v)) ?? Data("{}".utf8)
    }

    /// iCloud placeholder for a not-yet-downloaded file: `.<name>.icloud` → `<name>`.
    public static func placeholderTarget(_ fileName: String) -> String? {
        guard fileName.hasPrefix("."), fileName.hasSuffix(".icloud"), fileName.count > ".x.icloud".count - 1 else { return nil }
        let inner = String(fileName.dropFirst().dropLast(".icloud".count))
        return inner.isEmpty ? nil : inner
    }

    /// Files in inbox that may be requests (not hidden, not our temp files, not placeholders).
    public static func isCandidate(_ fileName: String) -> Bool {
        !fileName.hasPrefix(".") && !fileName.hasSuffix(".tmp") && !fileName.hasSuffix(".icloud")
    }

    public static func clipboardMirror(text: String, at: Date) -> JSONValue {
        ["text": .string(text), "at": .int(Int64((at.timeIntervalSince1970 * 1000).rounded()))]
    }
}
