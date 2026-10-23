import Foundation
import GlideCore

/// A saved AI chat: <userData>/features/ai/chats/<id>.json (same shape as chats.ts, so chats carry over).
public struct AIChat: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var model: String?
    /// unix ms
    public var createdAt: Double
    public var updatedAt: Double
    public var messages: [AIChatMessage]
    public init(id: String, title: String, model: String?, createdAt: Double, updatedAt: Double, messages: [AIChatMessage]) {
        self.id = id
        self.title = title
        self.model = model
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messages = messages
    }
}

public struct AIChatSummary: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var updatedAt: Double
    public var messageCount: Int
    public var preview: String
}

public enum AIChats {
    static let maxMessages = 500
    static let maxContent = 400_000
    private static let idRegex = try? NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,64}$")

    public static func isChatId(_ id: String) -> Bool {
        idRegex?.firstMatch(in: id, range: NSRange(location: 0, length: (id as NSString).length)) != nil
    }

    public static func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    public static func newId(now: Double = nowMs()) -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        let rnd = String((0..<6).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })
        return "\(String(Int64(now), radix: 36))-\(rnd)"
    }

    /// Title from the first user message (Raycast-like).
    public static func deriveTitle(_ messages: [AIChatMessage]) -> String {
        let first = (messages.first { $0.role == "user" }?.content ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if first.isEmpty { return "New Chat" }
        return first.count > 60 ? String(first.prefix(57)) + "…" : first
    }

    public static func sanitize(messages raw: [JSONValue]) -> [AIChatMessage] {
        raw.suffix(maxMessages).compactMap { m in
            guard let role = m["role"]?.stringValue, role == "user" || role == "assistant", let content = m["content"]?.stringValue else { return nil }
            return AIChatMessage(role: role, content: String(content.prefix(maxContent)), at: m["at"]?.doubleValue, model: m["model"]?.stringValue)
        }
    }

    /// sanitizeChat: tolerant of hand-edited / older files.
    public static func sanitize(_ raw: JSONValue, now: Double = nowMs()) -> AIChat? {
        guard raw.objectValue != nil else { return nil }
        let id = raw["id"]?.stringValue.flatMap { isChatId($0) ? $0 : nil } ?? newId(now: now)
        let messages = sanitize(messages: raw["messages"]?.arrayValue ?? [])
        let t = raw["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return AIChat(id: id, title: t.isEmpty ? deriveTitle(messages) : String(t.prefix(120)), model: raw["model"]?.stringValue,
                      createdAt: raw["createdAt"]?.doubleValue ?? now, updatedAt: now, messages: messages)
    }
}

/// One JSON file per chat.
public final class AIChatStore: @unchecked Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }

    private func file(_ id: String) -> URL? { AIChats.isChatId(id) ? directory.appendingPathComponent("\(id).json") : nil }

    public func list() -> [AIChatSummary] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.compactMap { n -> AIChatSummary? in
            guard let c = get(String(n.dropLast(5))) else { return nil }
            return AIChatSummary(id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: c.messages.count, preview: String((c.messages.last?.content ?? "").prefix(140)))
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    public func get(_ id: String) -> AIChat? {
        guard let url = file(id), let data = try? Data(contentsOf: url), let raw = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        var o = raw.objectValue ?? [:]
        o["id"] = .string(id)
        return AIChats.sanitize(.object(o), now: raw["updatedAt"]?.doubleValue ?? AIChats.nowMs())
    }

    /// Saves (stamping updatedAt) atomically: <id>.json.tmp then rename.
    @discardableResult public func save(_ chat: AIChat, now: Double = AIChats.nowMs()) throws -> AIChat {
        guard let url = file(chat.id) else { throw AIError(.badRequest, "Invalid chat id") }
        var c = chat
        c.updatedAt = now
        c.messages = Array(c.messages.suffix(AIChats.maxMessages))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let tmp = url.appendingPathExtension("tmp")
        try enc.encode(c).write(to: tmp)
        if FileManager.default.fileExists(atPath: url.path) { _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp) } else { try FileManager.default.moveItem(at: tmp, to: url) }
        return c
    }

    @discardableResult public func delete(_ id: String) -> Bool {
        guard let url = file(id) else { return false }
        return (try? FileManager.default.removeItem(at: url)) != nil
    }
}
