import Foundation
import GlideCore

// Clipboard history data model and pure logic — port of src/main/features/clipboard/model.ts. No AppKit, no I/O,
// so everything here is unit tested (Tests/N2FeatureTests). Times are epoch milliseconds like the Electron app, and
// history.json written by either app reads in the other (unknown fields round-trip through `extra`).

public enum ClipType: String, Codable, Sendable, CaseIterable {
    case text, link, color, file, image
    public var label: String {
        switch self {
        case .text: return "Text"
        case .link: return "Links"
        case .color: return "Colors"
        case .file: return "Files"
        case .image: return "Images"
        }
    }
    public var symbol: String {
        switch self {
        case .text: return "text.alignleft"
        case .link: return "link"
        case .color: return "paintpalette"
        case .file: return "doc"
        case .image: return "photo"
        }
    }
}

/// all | <type> | pinned
public enum ClipFilter: Hashable, Sendable {
    case all, pinned
    case type(ClipType)
    public init(_ raw: String?) {
        switch raw {
        case "pinned": self = .pinned
        case let r?: self = ClipType(rawValue: r).map(ClipFilter.type) ?? .all
        default: self = .all
        }
    }
    public var raw: String {
        switch self {
        case .all: return "all"
        case .pinned: return "pinned"
        case let .type(t): return t.rawValue
        }
    }
    public var label: String {
        switch self {
        case .all: return "All Types"
        case .pinned: return "Pinned"
        case let .type(t): return t.label
        }
    }
    public static let menu: [ClipFilter] = [.all, .type(.text), .type(.image), .type(.link), .type(.file), .type(.color), .pinned]
}

public struct SourceApp: Hashable, Codable, Sendable {
    public var name: String
    public var bundleId: String?
    public init(name: String, bundleId: String?) {
        self.name = name
        self.bundleId = bundleId
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(name, forKey: AnyCodingKey("name"))
        if let bundleId { try c.encode(bundleId, forKey: AnyCodingKey("bundleId")) } else { try c.encodeNil(forKey: AnyCodingKey("bundleId")) }
    }
}

public struct ClipImage: Hashable, Codable, Sendable {
    /// sha1 of the PNG bytes; files live at <dataDir>/images/<sha1>.png and <sha1>.thumb.png
    public var sha1: String
    public var width: Int
    public var height: Int
    public var bytes: Int
    public init(sha1: String, width: Int, height: Int, bytes: Int) {
        self.sha1 = sha1
        self.width = width
        self.height = height
        self.bytes = bytes
    }
}

public struct ClipEntry: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var type: ClipType
    /// Dedupe key: same key = same content ("t:<sha1>", "i:<sha1>", "f:<paths>").
    public var key: String
    public var text: String?
    public var files: [String]?
    public var image: ClipImage?
    /// Rich text copied alongside the plain text (native app only; the Electron app ignores and keeps it).
    public var html: String?
    /// RTF data, base64 (native app only).
    public var rtf: String?
    public var source: SourceApp?
    public var createdAt: Double
    public var lastCopiedAt: Double
    public var count: Int
    public var pinned: Bool
    /// Text recognised in an image. nil = not tried yet, "" = nothing found.
    public var ocrText: String?
    public var extra: [String: JSONValue] = [:]

    public init(id: String, type: ClipType, key: String, text: String? = nil, files: [String]? = nil, image: ClipImage? = nil, html: String? = nil, rtf: String? = nil,
                source: SourceApp? = nil, createdAt: Double = 0, lastCopiedAt: Double = 0, count: Int = 1, pinned: Bool = false, ocrText: String? = nil) {
        self.id = id
        self.type = type
        self.key = key
        self.text = text
        self.files = files
        self.image = image
        self.html = html
        self.rtf = rtf
        self.source = source
        self.createdAt = createdAt
        self.lastCopiedAt = lastCopiedAt
        self.count = count
        self.pinned = pinned
        self.ocrText = ocrText
    }

    static let knownKeys: Set<String> = ["id", "type", "key", "text", "files", "image", "html", "rtf", "source", "createdAt", "lastCopiedAt", "count", "pinned", "ocrText"]

    public init(from decoder: Decoder) throws {
        let r = try LosslessReader(decoder, known: Self.knownKeys)
        guard let id = r.string("id"), let key = r.string("key"), let t = r.string("type"), let type = ClipType(rawValue: t), let last = r.double("lastCopiedAt") else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a clipboard entry"))
        }
        self.id = id
        self.type = type
        self.key = key
        text = r.string("text")
        files = r.strings("files")
        image = r.value(ClipImage.self, "image")
        html = r.string("html")
        rtf = r.string("rtf")
        source = r.value(SourceApp.self, "source")
        lastCopiedAt = last
        createdAt = r.double("createdAt") ?? last
        count = r.int("count") ?? 1
        pinned = r.bool("pinned") ?? false
        ocrText = r.string("ocrText")
        extra = r.extra
    }

    public func encode(to encoder: Encoder) throws {
        var w = LosslessWriter(encoder, extra: extra)
        try w.set("id", id)
        try w.set("type", type)
        try w.set("key", key)
        try w.set("text", text)
        try w.set("files", files)
        try w.set("image", image)
        try w.set("html", html)
        try w.set("rtf", rtf)
        try w.set("source", source)
        try w.set("createdAt", createdAt)
        try w.set("lastCopiedAt", lastCopiedAt)
        try w.set("count", count)
        try w.set("pinned", pinned)
        try w.set("ocrText", ocrText)
        try w.finish()
    }
}

/// A capture before it becomes an entry.
public struct ClipCandidate: Hashable, Sendable {
    public var type: ClipType
    public var key: String
    public var text: String?
    public var files: [String]?
    public var image: ClipImage?
    public var html: String?
    public var rtf: String?
    public var source: SourceApp?
    public init(type: ClipType, key: String, text: String? = nil, files: [String]? = nil, image: ClipImage? = nil, html: String? = nil, rtf: String? = nil, source: SourceApp? = nil) {
        self.type = type
        self.key = key
        self.text = text
        self.files = files
        self.image = image
        self.html = html
        self.rtf = rtf
        self.source = source
    }
}

public enum StackOrder: String, Codable, Sendable { case fifo, lifo }

public struct ClipSettings: Hashable, Sendable {
    public var enabled = true
    public var paused = false
    /// epoch ms; recording is paused until then ("Pause for 5 Minutes"). 0 = not timed.
    public var pausedUntil: Double = 0
    /// 0 = keep forever
    public var retentionDays = 90
    /// Per-type override in days (missing = retentionDays).
    public var retentionByType: [ClipType: Int] = [:]
    public var maxEntries = 1000
    public var maxImages = 200
    public var maxImageMB = 500
    public var ignoredApps: [String] = ClipSettings.defaultIgnoredApps
    public var hotkey = ""
    public var stackHotkey = ""
    public var stackOrder: StackOrder = .fifo
    public var ocrImages = true
    public var viewMode = "list"
    /// ⌘V pastes the next Paste Stack item while items wait (native addition; Electron always intercepted).
    public var stackInterceptPaste = false // off by default: a forgotten stack must never hijack ⌘V

    public init() {}

    public static let defaultIgnoredApps = ["com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword", "com.bitwarden.desktop", "com.apple.keychainaccess", "com.apple.Passwords"]

    public static var defaultsBag: [String: JSONValue] { ClipSettings().bag }

    /// normalizeSettings(): coerce a settings bag read from disk into valid values.
    public init(bag raw: [String: JSONValue]) {
        let d = ClipSettings()
        func num(_ v: JSONValue?, _ def: Int, _ lo: Int, _ hi: Int) -> Int {
            guard let x = v?.doubleValue, x.isFinite else { return def }
            return min(hi, max(lo, Int(x.rounded())))
        }
        enabled = raw["enabled"]?.boolValue ?? d.enabled
        paused = raw["paused"]?.boolValue ?? d.paused
        pausedUntil = max(0, raw["pausedUntil"]?.doubleValue ?? 0)
        retentionDays = num(raw["retentionDays"], d.retentionDays, 0, 3650)
        var byType: [ClipType: Int] = [:]
        for t in ClipType.allCases {
            if let v = raw["retentionByType"]?[t.rawValue]?.doubleValue, v.isFinite, v > 0 { byType[t] = min(3650, Int(v.rounded())) }
        }
        retentionByType = byType
        maxEntries = num(raw["maxEntries"], d.maxEntries, 10, 100_000)
        maxImages = num(raw["maxImages"], d.maxImages, 0, 10_000)
        maxImageMB = num(raw["maxImageMB"], d.maxImageMB, 0, 100_000)
        if let arr = raw["ignoredApps"]?.arrayValue {
            ignoredApps = arr.compactMap(\.stringValue).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        }
        hotkey = raw["hotkey"]?.stringValue ?? ""
        stackHotkey = raw["stackHotkey"]?.stringValue ?? ""
        stackOrder = raw["stackOrder"]?.stringValue == "lifo" ? .lifo : .fifo
        ocrImages = raw["ocrImages"]?.boolValue ?? d.ocrImages
        viewMode = raw["viewMode"]?.stringValue == "grid" ? "grid" : "list"
        stackInterceptPaste = raw["stackInterceptPaste"]?.boolValue ?? false
    }

    public var bag: [String: JSONValue] {
        var byType: [String: JSONValue] = [:]
        for (t, v) in retentionByType { byType[t.rawValue] = .int(Int64(v)) }
        return [
            "enabled": .bool(enabled), "paused": .bool(paused), "pausedUntil": .double(pausedUntil), "retentionDays": .int(Int64(retentionDays)),
            "retentionByType": .object(byType), "maxEntries": .int(Int64(maxEntries)), "maxImages": .int(Int64(maxImages)), "maxImageMB": .int(Int64(maxImageMB)),
            "ignoredApps": .array(ignoredApps.map(JSONValue.string)), "hotkey": .string(hotkey), "stackHotkey": .string(stackHotkey),
            "stackOrder": .string(stackOrder.rawValue), "ocrImages": .bool(ocrImages), "viewMode": .string(viewMode), "stackInterceptPaste": .bool(stackInterceptPaste),
        ]
    }

    public func isPaused(now: Double) -> Bool { paused || pausedUntil > now }
}

public enum ClipModel {
    public static let day: Double = 86_400_000

    // MARK: classification

    private static func re(_ p: String) -> NSRegularExpression {
        // Patterns are literals in this file; a typo is a programming error caught by the tests.
        (try? NSRegularExpression(pattern: p, options: [.caseInsensitive])) ?? NSRegularExpression()
    }
    private static let urlRe = re(#"^(https?://|mailto:|ftp://|file://)[^\s]+$"#)
    private static let bareDomainRe = re(#"^www\.[a-z0-9-]+(\.[a-z0-9-]+)+(/[^\s]*)?$"#)
    private static let hexRe = re(#"^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$"#)
    private static let fnColorRe = re(#"^(rgba?|hsla?)\(\s*[-\d.%]+(deg)?\s*[,\s]\s*[-\d.%]+\s*[,\s]\s*[-\d.%]+\s*([,/]\s*[\d.%]+\s*)?\)$"#)

    static func full(_ r: NSRegularExpression, _ s: String) -> Bool {
        r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    public static func isColor(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return full(hexRe, t) || full(fnColorRe, t)
    }

    public static func isLink(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return full(urlRe, t) || full(bareDomainRe, t)
    }

    public static func classifyText(_ text: String) -> ClipType {
        if isColor(text) { return .color }
        if isLink(text) { return .link }
        return .text
    }

    public static func isConcealed(_ types: [String]) -> Bool {
        let markers = ["org.nspasteboard.concealedtype", "org.nspasteboard.transienttype", "org.nspasteboard.autogeneratedtype", "com.agilebits.onepassword"]
        return types.contains { t in markers.contains { t.lowercased().contains($0) } }
    }

    public static func isIgnoredApp(_ bundleId: String?, _ ignored: [String]) -> Bool {
        guard let b = bundleId?.lowercased(), !b.isEmpty else { return false }
        return ignored.contains { $0.trimmingCharacters(in: .whitespaces).lowercased() == b }
    }

    /// text/uri-list → local file paths (non-file URIs ignored).
    public static func filePathsFromUriList(_ list: String) -> [String] {
        var out: [String] = []
        for raw in list.split(whereSeparator: { $0 == "\n" || $0 == "\r\n" || $0 == "\r" }) {
            let l = raw.trimmingCharacters(in: .whitespaces)
            guard !l.isEmpty, !l.hasPrefix("#"), l.lowercased().hasPrefix("file://"), let u = URL(string: l) else { continue }
            out.append(u.path)
        }
        return out
    }

    public static func countWords(_ text: String) -> Int { text.split(whereSeparator: { $0.isWhitespace }).count }

    // MARK: list operations

    /// Same key → the existing entry moves to the top with count+1 (keeping id, pin, first-copied time).
    public static func upsert(_ entries: [ClipEntry], _ c: ClipCandidate, now: Double, newId: () -> String) -> (entries: [ClipEntry], entry: ClipEntry, isNew: Bool) {
        if let i = entries.firstIndex(where: { $0.key == c.key }) {
            var e = entries[i]
            e.lastCopiedAt = now
            e.count += 1
            e.source = c.source ?? e.source
            if c.html != nil { e.html = c.html }
            if c.rtf != nil { e.rtf = c.rtf }
            var rest = entries
            rest.remove(at: i)
            return ([e] + rest, e, false)
        }
        let e = ClipEntry(id: newId(), type: c.type, key: c.key, text: c.text, files: c.files, image: c.image, html: c.html, rtf: c.rtf, source: c.source,
                          createdAt: now, lastCopiedAt: now, count: 1, pinned: false)
        return ([e] + entries, e, true)
    }

    /// Move an entry to the top (after pasting/copying it from history).
    public static func touch(_ entries: [ClipEntry], id: String, now: Double) -> [ClipEntry] {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return entries }
        var e = entries[i]
        e.lastCopiedAt = now
        e.count += 1
        var rest = entries
        rest.remove(at: i)
        return [e] + rest
    }

    public static func sorted(_ entries: [ClipEntry]) -> [ClipEntry] {
        entries.enumerated().sorted { a, b in a.element.lastCopiedAt != b.element.lastCopiedAt ? a.element.lastCopiedAt > b.element.lastCopiedAt : a.offset < b.offset }.map(\.element)
    }

    /// Retention: age (per type), entry count, image count and bytes. Pinned entries are never removed; the oldest
    /// unpinned go first.
    public static func prune(_ entries: [ClipEntry], _ s: ClipSettings, now: Double) -> (kept: [ClipEntry], removed: [ClipEntry]) {
        let list = sorted(entries)
        var removed = Set<String>()
        var removedOrder: [ClipEntry] = []
        func remove(_ e: ClipEntry) { if removed.insert(e.id).inserted { removedOrder.append(e) } }
        for e in list where !e.pinned {
            let days = s.retentionByType[e.type] ?? s.retentionDays
            if days > 0, e.lastCopiedAt < now - Double(days) * day { remove(e) }
        }
        var alive = list.filter { !removed.contains($0.id) }
        if s.maxEntries > 0, alive.count > s.maxEntries {
            var excess = alive.count - s.maxEntries
            for e in alive.reversed() where excess > 0 && !e.pinned {
                remove(e)
                excess -= 1
            }
        }
        alive = list.filter { !removed.contains($0.id) }
        let images = alive.filter { $0.type == .image }
        var count = images.count
        var bytes = images.reduce(0) { $0 + ($1.image?.bytes ?? 0) }
        let maxBytes = s.maxImageMB * 1024 * 1024
        for e in images.reversed() {
            let overCount = s.maxImages > 0 && count > s.maxImages
            let overBytes = s.maxImageMB > 0 && bytes > maxBytes
            if !overCount && !overBytes { break }
            if e.pinned { continue }
            remove(e)
            count -= 1
            bytes -= e.image?.bytes ?? 0
        }
        return (list.filter { !removed.contains($0.id) }, removedOrder)
    }

    /// Lower-cased searchable text: content, file paths, source app, OCR text, image size.
    public static func haystack(_ e: ClipEntry) -> String {
        var parts = [e.text ?? ""] + (e.files ?? []) + [e.source?.name ?? "", e.ocrText ?? ""]
        if let i = e.image { parts.append("image \(i.width)x\(i.height)") }
        return parts.joined(separator: "\n").lowercased()
    }

    /// A bundle id, or "name:<app>" when the bundle id is unknown.
    public static func sourceKey(_ s: SourceApp?) -> String? { s.map { $0.bundleId ?? "name:\($0.name)" } }

    public static func matches(_ e: ClipEntry, query: String, filter: ClipFilter, source: String? = nil, hay: (ClipEntry) -> String = haystack) -> Bool {
        switch filter {
        case .all: break
        case .pinned: if !e.pinned { return false }
        case let .type(t): if e.type != t { return false }
        }
        if let source, sourceKey(e.source) != source { return false }
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace })
        if words.isEmpty { return true }
        let h = hay(e)
        return words.allSatisfy { h.contains($0) }
    }

    /// Pinned first, then most recently copied.
    public static func filter(_ entries: [ClipEntry], query: String, filter: ClipFilter, limit: Int = 0, source: String? = nil, hay: (ClipEntry) -> String = haystack) -> [ClipEntry] {
        let out = entries.enumerated().filter { matches($0.element, query: query, filter: filter, source: source, hay: hay) }.sorted { a, b in
            if a.element.pinned != b.element.pinned { return a.element.pinned }
            if a.element.lastCopiedAt != b.element.lastCopiedAt { return a.element.lastCopiedAt > b.element.lastCopiedAt }
            return a.offset < b.offset
        }.map(\.element)
        return limit > 0 ? Array(out.prefix(limit)) : out
    }

    /// First non-empty line (or a description of images/files).
    public static func title(_ e: ClipEntry) -> String {
        if e.type == .image, let i = e.image { return "Image (\(i.width)×\(i.height))" }
        if e.type == .file, let files = e.files, let f = files.first {
            let name = f.split(separator: "/").last.map(String.init) ?? f
            return files.count > 1 ? "\(name) + \(files.count - 1) more" : name
        }
        let line = (e.text ?? "").components(separatedBy: .newlines).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        let t = String(line.trimmingCharacters(in: .whitespaces).prefix(200))
        return t.isEmpty ? "(whitespace)" : t
    }

    /// Host of a link without "www." (nil when it does not parse).
    public static func linkDomain(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.lowercased().hasPrefix("mailto:") {
            let addr = t.dropFirst(7)
            guard let at = addr.split(separator: "@", maxSplits: 1).dropFirst().first else { return nil }
            return String(at.split(whereSeparator: { $0 == "?" || $0 == "#" }).first ?? at)
        }
        let withScheme = hasScheme(t) ? t : "https://\(t)"
        guard let host = URLComponents(string: withScheme)?.host ?? URL(string: withScheme.replacingOccurrences(of: " ", with: "%20"))?.host, !host.isEmpty else { return nil }
        return host.lowercased().hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    static func hasScheme(_ t: String) -> Bool { t.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*:"#, options: .regularExpression) != nil }

    /// URL to open for a link entry ("www.x.com" → "https://www.x.com").
    public static func linkHref(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return hasScheme(t) ? t : "https://\(t)"
    }

    public static func markdownLink(_ url: String, title: String? = nil) -> String {
        let href = linkHref(url)
        let rawLabel = title?.trimmingCharacters(in: .whitespaces).isEmpty == false ? title!.trimmingCharacters(in: .whitespaces) : (linkDomain(url) ?? href)
        var label = ""
        for ch in rawLabel { if "[]\\".contains(ch) { label.append("\\") }; label.append(ch) }
        return "[\(label)](\(href.replacingOccurrences(of: ")", with: "%29").replacingOccurrences(of: " ", with: "%20")))"
    }

    /// Text an entry contributes when merged or pasted as text (files → paths, images → nil).
    public static func entryText(_ e: ClipEntry) -> String? {
        switch e.type {
        case .image: return nil
        case .file: return (e.files?.isEmpty ?? true) ? nil : e.files!.joined(separator: "\n")
        default: return e.text
        }
    }

    /// Merge in the given order; nil when no entry has text.
    public static func mergeTexts(_ list: [ClipEntry], separator: String = "\n") -> String? {
        let parts = list.compactMap(entryText).filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: separator)
    }

    public struct SourceSummary: Hashable, Sendable {
        public var key: String
        public var name: String
        public var bundleId: String?
        public var count: Int
    }

    /// Distinct source apps, most entries first.
    public static func sourceApps(_ entries: [ClipEntry]) -> [SourceSummary] {
        var map: [String: SourceSummary] = [:]
        var order: [String] = []
        for e in entries {
            guard let s = e.source, let k = sourceKey(s) else { continue }
            if map[k] == nil { order.append(k); map[k] = SourceSummary(key: k, name: s.name, bundleId: s.bundleId, count: 0) }
            map[k]!.count += 1
        }
        return order.compactMap { map[$0] }.sorted { $0.count != $1.count ? $0.count > $1.count : $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    public struct Stats: Hashable, Sendable {
        public var total: Int
        public var pinned: Int
        public var byType: [ClipType: Int]
        public var imageBytes: Int
        public var oldest: Double?
        public var paused: Bool
        public var pausedUntil: Double?
        public var enabled: Bool
    }

    public static func stats(_ entries: [ClipEntry], _ s: ClipSettings, now: Double) -> Stats {
        var byType: [ClipType: Int] = [:]
        for t in ClipType.allCases { byType[t] = 0 }
        var bytes = 0
        var oldest: Double?
        for e in entries {
            byType[e.type, default: 0] += 1
            bytes += e.image?.bytes ?? 0
            oldest = min(oldest ?? e.createdAt, e.createdAt)
        }
        let until = s.pausedUntil > now ? s.pausedUntil : nil
        return Stats(total: entries.count, pinned: entries.filter(\.pinned).count, byType: byType, imageBytes: bytes, oldest: oldest,
                     paused: s.paused || until != nil, pausedUntil: until, enabled: s.enabled)
    }

    /// Relative time for the detail pane ("2 min ago", "Yesterday 14:05", "Mar 3").
    public static func relative(_ ms: Double, now: Double) -> String {
        let s = max(0, (now - ms) / 1000)
        if s < 60 { return "Just now" }
        if s < 3600 { return "\(Int(s / 60)) min ago" }
        if s < 86_400 { return "\(Int(s / 3600)) h ago" }
        let d = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.dateFormat = s < 7 * 86_400 ? "EEE HH:mm" : "MMM d, yyyy"
        return f.string(from: d)
    }
}
