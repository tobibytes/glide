import Foundation
import GlideCore

// Snippet rendering, keyword expansion and import/export — port of src/main/snippets/{render,expansion,live,io}.ts
// (pure; unit tested in Tests/N2FeatureTests).

public struct RenderedSnippet: Equatable, Sendable {
    public var text: String
    /// HTML body for rich-text snippets (pasted alongside the plain text).
    public var html: String?
    /// ← presses after pasting to land on {cursor} (0 = caret stays at the end).
    public var cursorLeft: Int
    public init(text: String, html: String? = nil, cursorLeft: Int = 0) {
        self.text = text
        self.html = html
        self.cursorLeft = cursorLeft
    }
}

/// Settings bag `settings.features["snippets"]` (same keys as the Electron app).
public struct SnippetSettings: Equatable, Sendable {
    /// Characters every keyword must be typed with, e.g. ";". "" = none.
    public var keywordPrefix = ""
    /// "Sig"/"SIG" expand with matching capitalisation.
    public var caseAdaptive = false
    /// Bundle ids where no snippet expands.
    public var excludedApps: [String] = []
    public init(keywordPrefix: String = "", caseAdaptive: Bool = false, excludedApps: [String] = []) {
        self.keywordPrefix = keywordPrefix
        self.caseAdaptive = caseAdaptive
        self.excludedApps = excludedApps
    }

    public init(bag r: [String: JSONValue]) {
        keywordPrefix = String((r["keywordPrefix"]?.stringValue ?? "").filter { !$0.isWhitespace }.prefix(4))
        caseAdaptive = r["caseAdaptive"]?.boolValue == true
        excludedApps = (r["excludedApps"]?.arrayValue ?? []).compactMap(\.stringValue).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    public var bag: [String: JSONValue] {
        ["keywordPrefix": .string(keywordPrefix), "caseAdaptive": .bool(caseAdaptive), "excludedApps": .array(excludedApps.map(JSONValue.string))]
    }
}

public enum SnipRender {
    /// Find a snippet by name (case-insensitive) or keyword, for {snippet name="…"}.
    public static func lookup(_ snippets: [Snippet]) -> (String) -> String? {
        { name in
            let n = name.trimmingCharacters(in: .whitespaces).lowercased()
            let hit = snippets.first { $0.name.trimmingCharacters(in: .whitespaces).lowercased() == n } ?? snippets.first { $0.keyword?.trimmingCharacters(in: .whitespaces).lowercased() == n }
            return hit?.text
        }
    }

    /// ← presses from the end of `after` back to its start: one per grapheme ("\r\n" is one).
    public static func cursorLeftCount(_ after: String) -> Int { after.replacingOccurrences(of: "\r\n", with: "\n").count }

    /// Split at the first cursor marker; later markers are dropped.
    public static func placeCursor(_ rendered: String) -> (text: String, cursorLeft: Int) {
        guard let r = rendered.range(of: SnipTemplate.cursorMarker) else { return (rendered, 0) }
        let before = String(rendered[..<r.lowerBound])
        let after = String(rendered[r.upperBound...]).replacingOccurrences(of: SnipTemplate.cursorMarker, with: "")
        return (before + after, cursorLeftCount(after))
    }

    public static func render(text: String, html: String?, env: SnipTemplate.Env) -> RenderedSnippet {
        let placed = placeCursor(SnipTemplate.render(SnipTemplate.parse(text), env, .init(cursorMarker: SnipTemplate.cursorMarker)))
        guard let html, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return RenderedSnippet(text: placed.text, cursorLeft: placed.cursorLeft) }
        let h = SnipTemplate.render(SnipTemplate.parse(html), env, .init(html: true, cursorMarker: ""))
        return RenderedSnippet(text: placed.text, html: h, cursorLeft: placed.cursorLeft)
    }

    // MARK: HTML

    private static func re(_ p: String) -> NSRegularExpression? { try? NSRegularExpression(pattern: p, options: [.caseInsensitive]) }

    private static func replace(_ s: String, _ pattern: String, _ template: String) -> String {
        guard let r = re(pattern) else { return s }
        return r.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: template)
    }

    private static let entities = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " "]

    /// Plain-text rendition of a small HTML fragment (text fallback and previews).
    public static func htmlToText(_ html: String) -> String {
        var s = replace(html, #"<\s*(script|style)[^>]*>[\s\S]*?<\s*/\s*\1\s*>"#, "")
        s = replace(s, #"<\s*br\s*/?>"#, "\n")
        s = replace(s, #"<\s*li[^>]*>"#, "• ")
        s = replace(s, #"<\s*/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>"#, "\n")
        s = replace(s, #"<[^>]+>"#, "")
        if let r = re(#"&(#x[0-9a-f]+|#\d+|[a-z]+);"#) {
            let ns = s as NSString
            var out = ""
            var last = 0
            for m in r.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
                out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
                let e = ns.substring(with: m.range(at: 1))
                var rep = ns.substring(with: m.range)
                if e.hasPrefix("#") {
                    let code = e.dropFirst().lowercased().hasPrefix("x") ? UInt32(e.dropFirst(2), radix: 16) : UInt32(e.dropFirst())
                    if let code, let u = Unicode.Scalar(code) { rep = String(Character(u)) }
                } else if let v = entities[e.lowercased()] {
                    rep = v
                }
                out += rep
                last = m.range.location + m.range.length
            }
            out += ns.substring(from: last)
            s = out
        }
        s = replace(s, #"\n{3,}"#, "\n\n")
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Remove scripts, event handlers and javascript: URLs before showing or pasting user HTML.
    public static func sanitizeHTML(_ html: String) -> String {
        var s = replace(html, #"<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*/\s*\1\s*>"#, "")
        s = replace(s, #"<\s*(script|iframe|object|embed)[^>]*/?>"#, "")
        s = replace(s, #"\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#, "")
        s = replace(s, #"(href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*("|')?"#, "$1=\"#\"")
        return s
    }
}

public enum SnipExpansion {
    /// The keyword as it must be typed. A keyword that already starts with the prefix is left alone.
    public static func effectiveKeyword(_ keyword: String, prefix: String) -> String {
        let k = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty, !prefix.isEmpty else { return k }
        return k.hasPrefix(prefix) ? k : prefix + k
    }

    /// Capitalise the first letter (skipping leading punctuation/space).
    public static func capitalize(_ s: String) -> String {
        guard let i = s.firstIndex(where: { $0.isLetter }) else { return s }
        return String(s[..<i]) + s[i].uppercased() + String(s[s.index(after: i)...])
    }

    public struct Variant: Equatable, Sendable {
        public var keyword: String
        public var text: String
    }

    /// As-is, Capitalised and UPPER (distinct ones; deliberate mixed-case keywords stay exact).
    public static func caseVariants(_ keyword: String, _ text: String) -> [Variant] {
        var out = [Variant(keyword: keyword, text: text)]
        guard keyword.contains(where: { $0.isLetter }), keyword == keyword.lowercased() else { return out }
        let cap = capitalize(keyword), upper = keyword.uppercased()
        if cap != keyword { out.append(Variant(keyword: cap, text: capitalize(text))) }
        if upper != keyword && upper != cap { out.append(Variant(keyword: upper, text: text.uppercased())) }
        return out
    }

    public static func expandsIn(_ s: Snippet, _ settings: SnippetSettings, bundleId: String?) -> Bool {
        guard let b = bundleId?.lowercased(), !b.isEmpty else { return true }
        if settings.excludedApps.contains(where: { $0.lowercased() == b }) { return false }
        return !(s.excludedApps ?? []).contains { $0.lowercased() == b }
    }

    /// Letters-only keywords without a prefix also fire inside longer words ("sig" in "design").
    public static func keywordWarning(_ keyword: String, prefix: String) -> String? {
        let k = effectiveKeyword(keyword, prefix: prefix)
        guard !k.isEmpty, k.allSatisfy({ $0.isLetter || $0.isNumber }) else { return nil }
        return "“\(k)” is plain letters, so it also expands when those letters appear inside a longer word. Add a prefix such as “;” here or in Snippet settings."
    }

    public struct Entry: Equatable, Sendable {
        public var keyword: String
        public var text: String
        public var snippetId: String
    }

    /// Entries for the keyboard tap, longest keyword first; duplicate keywords keep the first snippet.
    public static func buildList(_ snippets: [Snippet], settings: SnippetSettings, env: SnipTemplate.Env, frontmostBundleId: String? = nil) -> [Entry] {
        var fullEnv = env
        if fullEnv.snippet == nil { fullEnv.snippet = SnipRender.lookup(snippets) }
        var seen = Set<String>()
        var out: [Entry] = []
        for s in snippets {
            guard let raw = s.keyword?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty, !s.text.isEmpty || !(s.html ?? "").isEmpty else { continue }
            guard expandsIn(s, settings, bundleId: frontmostBundleId) else { continue }
            let keyword = effectiveKeyword(raw, prefix: settings.keywordPrefix)
            let body = s.text.isEmpty ? SnipRender.htmlToText(s.html ?? "") : s.text
            let text = SnipRender.render(text: body, html: nil, env: fullEnv).text
            if text.isEmpty && !SnipTemplate.isDynamic(body) { continue }
            let variants = settings.caseAdaptive ? caseVariants(keyword, text) : [Variant(keyword: keyword, text: text)]
            for v in variants where seen.insert(v.keyword).inserted { out.append(Entry(keyword: v.keyword, text: v.text, snippetId: s.id)) }
        }
        return out.enumerated().sorted { a, b in a.element.keyword.count != b.element.keyword.count ? a.element.keyword.count > b.element.keyword.count : a.offset < b.offset }.map(\.element)
    }

    /// The expansion list must be rebuilt over time (dates, clipboard, uuid…).
    public static func needsRefresh(_ snippets: [Snippet]) -> Bool {
        snippets.contains { !($0.keyword ?? "").trimmingCharacters(in: .whitespaces).isEmpty && SnipTemplate.isDynamic($0.text.isEmpty ? ($0.html ?? "") : $0.text) }
    }

    /// Render at expansion time (placeholders, {cursor}, rich text).
    public static func needsLiveRender(_ s: Snippet) -> Bool {
        let src = "\(s.text)\n\(s.html ?? "")"
        return !(s.html ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || SnipTemplate.isDynamic(src) || SnipTemplate.uses(src, "cursor")
    }

    public struct Plan: Equatable, Sendable {
        public var deleteCount: Int
        public var text: String
        public var html: String?
        public var cursorLeft: Int
    }

    /// What to paste for one typed keyword (case adapted to the typed variant).
    public static func plan(typed: String, snippet: Snippet, all: [Snippet], settings: SnippetSettings, env: SnipTemplate.Env) -> Plan {
        var e = env
        if e.snippet == nil { e.snippet = SnipRender.lookup(all) }
        let r = SnipRender.render(text: snippet.text, html: snippet.html, env: e)
        var text = r.text
        if settings.caseAdaptive && typed != typed.lowercased() {
            text = typed == typed.uppercased() && typed.count > 1 ? text.uppercased() : capitalize(text)
        }
        return Plan(deleteCount: typed.count, text: text, html: r.html, cursorLeft: r.cursorLeft)
    }

    /// The tap's entry list: prefix/case variants applied, `text` pre-rendered as the fallback, `id` only for
    /// snippets that need a live render; per-snippet exclusions travel with the entry.
    public static func tapEntries(_ snippets: [Snippet], settings: SnippetSettings, env: SnipTemplate.Env) -> [KeyboardTapConfig.SnippetEntry] {
        let byId = Dictionary(snippets.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return buildList(snippets, settings: settings, env: env).map { e in
            let s = byId[e.snippetId]
            let excluded = (s?.excludedApps ?? []).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            return KeyboardTapConfig.SnippetEntry(keyword: e.keyword, text: e.text, id: s.map(needsLiveRender) == true ? e.snippetId : nil, excludedBundleIds: excluded)
        }
    }
}

// MARK: - import / export

public enum SnipIO {
    public struct ImportResult: Equatable, Sendable {
        public var snippets: [Snippet]
        public var skipped: Int
        /// Raycast placeholders Glide leaves as literal text, e.g. "{browser-tab}".
        public var unsupported: [String]
    }

    private static let placeholderRe = try? NSRegularExpression(pattern: #"\{([a-z][a-z-]*)\b[^{}\n]*\}"#)

    /// Raycast's export is a bare array of `{name, text, keyword?}`; Glide's wraps it in `{snippets: […]}`.
    public static func parse(_ json: String) throws -> ImportResult {
        guard let raw = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else { throw FeatureError.failed("The file is not valid JSON") }
        guard let list = raw.arrayValue ?? raw["snippets"]?.arrayValue else {
            throw FeatureError.failed("No snippets found (expected Raycast's snippet export: an array of {name, text, keyword})")
        }
        var out: [Snippet] = []
        var unsupported: [String] = []
        var skipped = 0
        for r in list {
            guard let o = r.objectValue else { skipped += 1; continue }
            let name = (o["name"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? (o["title"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : (o["name"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let text = (o["text"]?.stringValue).flatMap { $0.isEmpty ? nil : $0 } ?? o["content"]?.stringValue ?? ""
            guard !name.isEmpty, !text.isEmpty else { skipped += 1; continue }
            if let placeholderRe {
                let ns = text as NSString
                for m in placeholderRe.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                    let n = ns.substring(with: m.range(at: 1))
                    if !SnipTemplate.names.contains(n), !unsupported.contains("{\(n)}") { unsupported.append("{\(n)}") }
                }
            }
            var s = Snippet(id: "", name: name, text: text)
            if let k = o["keyword"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !k.isEmpty { s.keyword = k }
            if let a = o["alias"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !a.isEmpty { s.alias = a }
            if let h = o["html"]?.stringValue, !h.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { s.html = h }
            if let ex = o["excludedApps"]?.arrayValue { s.excludedApps = ex.compactMap(\.stringValue) }
            out.append(s)
        }
        return ImportResult(snippets: out, skipped: skipped, unsupported: unsupported)
    }

    public struct MergeResult: Equatable, Sendable {
        public var add: [Snippet]
        public var duplicates: Int
        public var keywordConflicts: Int
    }

    /// Same name + same text is a duplicate (skipped); a keyword already in use is dropped from the import.
    public static func merge(_ incoming: [Snippet], existing: [Snippet]) -> MergeResult {
        func key(_ s: Snippet) -> String { "\(s.name.trimmingCharacters(in: .whitespaces).lowercased())\n\(s.text)" }
        var seen = Set(existing.map(key))
        var keywords = Set(existing.compactMap { $0.keyword?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
        var add: [Snippet] = []
        var dup = 0, conflicts = 0
        for s in incoming {
            guard seen.insert(key(s)).inserted else { dup += 1; continue }
            var n = s
            if let k = n.keyword {
                if keywords.contains(k) { n.keyword = nil; conflicts += 1 } else { keywords.insert(k) }
            }
            add.append(n)
        }
        return MergeResult(add: add, duplicates: dup, keywordConflicts: conflicts)
    }

    /// `{format:"glide.snippets", version:1, exportedAt, snippets}`.
    public static func export(_ list: [Snippet], now: Date = Date()) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let snippets = list.compactMap { s -> JSONValue? in (try? JSONEncoder().encode(s)).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } }
        let root: JSONValue = ["format": "glide.snippets", "version": 1, "exportedAt": .string(f.string(from: now)), "snippets": .array(snippets)]
        return (try? String(decoding: JSONEncoder.glide.encode(root), as: UTF8.self)) ?? "{}"
    }

    public static func newId() -> String { "sn-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))-\(UUID().uuidString.prefix(4).lowercased())" }
}
