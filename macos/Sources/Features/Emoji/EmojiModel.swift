import Foundation

/// Emoji dataset access, search, skin tones, usage and grid navigation (port of src/renderer/features/emoji/model.ts
/// and grid.ts). The dataset is bundled (EmojiData.swift) — no network at runtime.
public enum EmojiModel {
    public struct Emoji: Equatable, Sendable, Hashable {
        public var char: String
        public var name: String
        public var keywords: [String]
        public var category: Int
        /// "" no skin tones; "1" modifier after the first scalar; otherwise the light-tone form as a template.
        public var skin: String
    }

    public static let categories: [(id: String, title: String, icon: String)] = [
        ("smileys", "Smileys & Emotion", "😀"), ("people", "People & Body", "👋"), ("nature", "Animals & Nature", "🐻"),
        ("food", "Food & Drink", "🍔"), ("travel", "Travel & Places", "✈️"), ("activities", "Activities", "⚽"),
        ("objects", "Objects", "💡"), ("symbols", "Symbols", "❤️"), ("flags", "Flags", "🏁"),
    ]

    public static let skinTones: [(label: String, swatch: String, modifier: String)] = [
        ("Default", "✋", ""), ("Light", "✋🏻", "\u{1F3FB}"), ("Medium-Light", "✋🏼", "\u{1F3FC}"),
        ("Medium", "✋🏽", "\u{1F3FD}"), ("Medium-Dark", "✋🏾", "\u{1F3FE}"), ("Dark", "✋🏿", "\u{1F3FF}"),
    ]

    public static func parseRows(_ rows: String) -> [Emoji] {
        rows.split(separator: "\n").compactMap { line in
            let f = line.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            guard f.count >= 2, !f[0].isEmpty, !f[1].isEmpty else { return nil }
            return Emoji(char: f[0], name: f[1], keywords: f.count > 2 && !f[2].isEmpty ? f[2].split(separator: " ").map(String.init) : [],
                         category: f.count > 3 ? Int(f[3]) ?? 0 : 0, skin: f.count > 4 ? f[4] : "")
        }
    }

    public static let all: [Emoji] = parseRows(EmojiData.rows)
    static let byChar: [String: Emoji] = Dictionary(all.map { ($0.char, $0) }, uniquingKeysWith: { a, _ in a })

    public static func find(_ char: String) -> Emoji? { byChar[char] }

    /// Apply a skin tone (0 = default … 5 = dark) where the emoji supports one.
    public static func withTone(_ e: Emoji, _ tone: Int) -> String {
        guard tone > 0, tone < skinTones.count, !e.skin.isEmpty else { return e.char }
        let mod = skinTones[tone].modifier
        if e.skin == "1" {
            var scalars = Array(e.char.unicodeScalars)
            guard let first = scalars.first else { return e.char }
            scalars.removeFirst()
            if scalars.first == "\u{FE0F}" { scalars.removeFirst() }
            var s = String(first) + mod
            s.unicodeScalars.append(contentsOf: scalars)
            return s
        }
        return e.skin.replacingOccurrences(of: "\u{1F3FB}", with: mod)
    }

    static func tokenScore(_ e: Emoji, _ t: String, _ words: [String]) -> Int {
        if e.name == t { return 100 }
        if e.name.hasPrefix(t) { return 80 }
        if words.contains(t) { return 70 }
        if words.contains(where: { $0.hasPrefix(t) }) { return 60 }
        if e.keywords.contains(t) { return 50 }
        if e.keywords.contains(where: { $0.hasPrefix(t) }) { return 40 }
        if e.name.contains(t) { return 20 }
        return 0
    }

    /// Every token must match the name or a keyword; better matches first, dataset order breaks ties.
    public static func search(_ query: String, in list: [Emoji] = all, limit: Int = .max) -> [Emoji] {
        var q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.hasPrefix(":") { q.removeFirst() }
        if q.hasSuffix(":") { q.removeLast() }
        if q.isEmpty { return Array(list.prefix(limit)) }
        let tokens = q.split(whereSeparator: { $0 == " " || $0 == "_" }).map(String.init)
        var scored: [(Emoji, Int, Int)] = []
        for (i, e) in list.enumerated() {
            if e.char == q { scored.append((e, 1000, i)); continue }
            let words = e.name.split(whereSeparator: { !($0.isLetter || $0.isNumber) }).map(String.init)
            var total = 0
            var ok = true
            for t in tokens {
                let s = tokenScore(e, t, words)
                if s == 0 { ok = false; break }
                total += s
            }
            guard ok else { continue }
            if tokens.count > 1 { total += e.name == q ? 200 : e.name.hasPrefix(q) ? 50 : 0 }
            scored.append((e, total, i))
        }
        scored.sort { $0.1 != $1.1 ? $0.1 > $1.1 : $0.2 < $1.2 }
        return scored.prefix(limit).map(\.0)
    }

    public struct Usage: Codable, Equatable, Sendable {
        public var count: Int
        public var last: Double
    }

    /// Recently used (by time) and frequently used (by count, excluding the recent ones).
    public static func usageSections(_ usage: [String: Usage], recentN: Int = 8, frequentN: Int = 16) -> (recent: [String], frequent: [String]) {
        let recent = usage.sorted { $0.value.last > $1.value.last }.prefix(recentN).map(\.key)
        let frequent = usage.filter { !recent.contains($0.key) && $0.value.count > 1 }
            .sorted { $0.value.count != $1.value.count ? $0.value.count > $1.value.count : $0.value.last > $1.value.last }
            .prefix(frequentN).map(\.key)
        return (Array(recent), Array(frequent))
    }

    // MARK: grid

    public struct Section: Equatable {
        public var id: String
        public var title: String
        public var items: [Emoji]
    }

    public struct Row: Equatable {
        public var section: String
        public var title: String
        public var first: Bool
        public var items: [Emoji]
    }

    public struct Pos: Equatable { public var row = 0, col = 0 }

    public enum Move { case left, right, up, down, pageUp, pageDown, home, end, nextSection, prevSection }

    public static func layout(_ sections: [Section], columns: Int) -> [Row] {
        var rows: [Row] = []
        for s in sections {
            var i = 0
            while i < s.items.count {
                rows.append(Row(section: s.id, title: s.title, first: i == 0, items: Array(s.items[i..<min(i + columns, s.items.count)])))
                i += columns
            }
        }
        return rows
    }

    public static func clamp(_ rows: [Row], _ p: Pos) -> Pos {
        guard !rows.isEmpty else { return Pos() }
        let r = min(rows.count - 1, max(0, p.row))
        return Pos(row: r, col: min(rows[r].items.count - 1, max(0, p.col)))
    }

    public static func move(_ rows: [Row], _ p: Pos, _ m: Move, page: Int = 5) -> Pos {
        guard !rows.isEmpty else { return Pos() }
        let cur = clamp(rows, p)
        switch m {
        case .left:
            if cur.col > 0 { return Pos(row: cur.row, col: cur.col - 1) }
            return cur.row > 0 ? Pos(row: cur.row - 1, col: rows[cur.row - 1].items.count - 1) : cur
        case .right:
            if cur.col < rows[cur.row].items.count - 1 { return Pos(row: cur.row, col: cur.col + 1) }
            return cur.row < rows.count - 1 ? Pos(row: cur.row + 1, col: 0) : cur
        case .up: return clamp(rows, Pos(row: cur.row - 1, col: cur.col))
        case .down: return clamp(rows, Pos(row: cur.row + 1, col: cur.col))
        case .pageUp: return clamp(rows, Pos(row: cur.row - page, col: cur.col))
        case .pageDown: return clamp(rows, Pos(row: cur.row + page, col: cur.col))
        case .home: return Pos()
        case .end: return Pos(row: rows.count - 1, col: rows[rows.count - 1].items.count - 1)
        case .nextSection:
            if let i = rows.indices.first(where: { $0 > cur.row && rows[$0].first }) { return Pos(row: i, col: 0) }
            return cur
        case .prevSection:
            var start = cur.row
            while start > 0 && !rows[start].first { start -= 1 }
            if start < cur.row || cur.col > 0 { return Pos(row: start, col: 0) }
            var prev = start - 1
            while prev > 0 && !rows[prev].first { prev -= 1 }
            return prev >= 0 ? Pos(row: prev, col: 0) : cur
        }
    }
}
