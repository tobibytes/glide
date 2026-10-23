import Foundation
import GlideCore

/// Floating Notes data (port of src/main/features/notes/model.ts). File: <userData>/features/notes/notes.json.
public struct Note: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var body: String
    public var createdAt: Double
    public var updatedAt: Double
    public init(id: String, body: String, createdAt: Double, updatedAt: Double) {
        self.id = id
        self.body = body
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct NoteBounds: Hashable, Codable, Sendable {
    public var x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct NotesFile: Hashable, Codable, Sendable {
    public var notes: [Note] = []
    public var currentId: String?
    public var bounds: NoteBounds?
    public init(notes: [Note] = [], currentId: String? = nil, bounds: NoteBounds? = nil) {
        self.notes = notes
        self.currentId = currentId
        self.bounds = bounds
    }
    // currentId is written as null (not omitted), like JSON.stringify.
    enum CodingKeys: String, CodingKey { case notes, currentId, bounds }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(notes, forKey: .notes)
        try c.encode(currentId, forKey: .currentId)
        try c.encodeIfPresent(bounds, forKey: .bounds)
    }
}

public struct NoteSummary: Hashable, Codable, Sendable {
    public var id: String
    public var title: String
    public var preview: String
    public var updatedAt: Double
    public var chars: Int
}

public enum NotesModel {
    /// First non-empty line without markdown heading / list / checkbox markers, max 60 chars.
    public static func title(of body: String) -> String {
        for raw in body.components(separatedBy: "\n") {
            var l = raw.replacingOccurrences(of: #"^#+\s*"#, with: "", options: .regularExpression)
            l = l.replacingOccurrences(of: #"^[-*]\s+(\[[ x]\]\s+)?"#, with: "", options: .regularExpression)
            l = l.trimmingCharacters(in: .whitespaces)
            if !l.isEmpty { return l.count > 60 ? String(l.prefix(60)) + "…" : l }
        }
        return "Untitled Note"
    }

    public static func summarize(_ n: Note) -> NoteSummary {
        let rest = n.body.components(separatedBy: "\n").dropFirst().joined(separator: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return NoteSummary(id: n.id, title: title(of: n.body), preview: String(rest.prefix(120)), updatedAt: n.updatedAt, chars: n.body.utf16.count)
    }

    public static func newNote(now: Double, body: String = "") -> Note {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        let rand = String((0..<4).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })
        return Note(id: "note-\(String(Int64(now), radix: 36))-\(rand)", body: body, createdAt: now, updatedAt: now)
    }

    /// Newest first, like a stack of sticky notes.
    public static func add(_ f: NotesFile, _ n: Note) -> NotesFile {
        var f = f
        f.notes.insert(n, at: 0)
        f.currentId = n.id
        return f
    }

    public static func update(_ f: NotesFile, id: String, body: String, now: Double) -> NotesFile {
        var f = f
        f.notes = f.notes.map { n in
            guard n.id == id, n.body != body else { return n }
            var m = n
            m.body = body
            m.updatedAt = now
            return m
        }
        return f
    }

    /// Remove a note; the current note moves to its neighbour.
    public static func delete(_ f: NotesFile, id: String) -> NotesFile {
        guard let idx = f.notes.firstIndex(where: { $0.id == id }) else { return f }
        var f = f
        f.notes.remove(at: idx)
        if f.currentId == id || !f.notes.contains(where: { $0.id == f.currentId }) {
            f.currentId = f.notes.isEmpty ? nil : f.notes[min(idx, f.notes.count - 1)].id
        }
        return f
    }

    public static func cycle(_ f: NotesFile, delta: Int) -> String? {
        guard !f.notes.isEmpty else { return nil }
        let idx = max(0, f.notes.firstIndex { $0.id == f.currentId } ?? 0)
        let n = f.notes.count
        return f.notes[((idx + delta) % n + n) % n].id
    }

    /// Every token must appear in the body; title prefix 3, title 2, body 1; then most recently edited.
    public static func search(_ notes: [Note], _ query: String) -> [Note] {
        let tokens = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        let sorted = notes.sorted { $0.updatedAt > $1.updatedAt }
        if tokens.isEmpty { return sorted }
        let scored: [(Note, Int)] = sorted.compactMap { n in
            let t = title(of: n.body).lowercased()
            let b = n.body.lowercased()
            guard tokens.allSatisfy({ b.contains($0) }) else { return nil }
            return (n, tokens.reduce(0) { $0 + (t.hasPrefix($1) ? 3 : t.contains($1) ? 2 : 1) })
        }
        return scored.enumerated().sorted { a, b in
            a.element.1 != b.element.1 ? a.element.1 > b.element.1 : a.element.0.updatedAt != b.element.0.updatedAt ? a.element.0.updatedAt > b.element.0.updatedAt : a.offset < b.offset
        }.map(\.element.0)
    }

    /// Tolerant load (drops malformed notes, keeps currentId only if it exists).
    public static func sanitize(_ raw: JSONValue?) -> NotesFile {
        guard let raw, raw.objectValue != nil else { return NotesFile() }
        let notes: [Note] = (raw["notes"]?.arrayValue ?? []).compactMap { n in
            guard let id = n["id"]?.stringValue, let body = n["body"]?.stringValue else { return nil }
            return Note(id: id, body: body, createdAt: n["createdAt"]?.number ?? 0, updatedAt: n["updatedAt"]?.number ?? 0)
        }
        var bounds: NoteBounds?
        if let b = raw["bounds"], let x = b["x"]?.number, let y = b["y"]?.number, let w = b["width"]?.number, let h = b["height"]?.number {
            bounds = NoteBounds(x: x, y: y, width: w, height: h)
        }
        let cur = raw["currentId"]?.stringValue
        let currentId = cur.flatMap { c in notes.contains { $0.id == c } ? c : nil } ?? notes.first?.id
        return NotesFile(notes: notes, currentId: currentId, bounds: bounds)
    }

    public static func wordCount(_ s: String) -> Int { s.split(whereSeparator: \.isWhitespace).count }
}
