import CryptoKit
import Foundation

// Text transforms — a pure port of src/main/features/transforms/transforms.ts (same ids, titles, keywords,
// categories, error messages and outputs), so root-search items, usage and workflows carry over.

public enum TransformCategory: String, Sendable, CaseIterable {
    case `case` = "Case", lines = "Lines", inspect = "Inspect", encode = "Encode", data = "Data", generate = "Generate"
}

public struct TransformOptions: Sendable {
    /// Line width for "wrap" (default 80).
    public var width: Int?
    public var now: Date?
    public var uuid: (@Sendable () -> String)?
    public init(width: Int? = nil, now: Date? = nil, uuid: (@Sendable () -> String)? = nil) {
        self.width = width
        self.now = now
        self.uuid = uuid
    }
}

public struct TransformError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public struct TransformDef: Sendable, Identifiable {
    public let id: String
    public let title: String
    public let category: TransformCategory
    public let keywords: [String]
    /// False for generators (UUID) that ignore the input.
    public let usesInput: Bool
    let run: @Sendable (String, TransformOptions) throws -> String
}

public enum TransformResult: Equatable, Sendable {
    case ok(String)
    case failure(String)
    public var output: String? { if case let .ok(s) = self { return s }; return nil }
    public var error: String? { if case let .failure(e) = self { return e }; return nil }
}

public enum TextTransforms {
    // MARK: helpers

    private static let camelBoundary = TransformRegex("([a-z0-9])([A-Z])")
    private static let acronymBoundary = TransformRegex("([A-Z]+)([A-Z][a-z])")
    private static let wordRun = TransformRegex("[\\p{L}\\p{N}]+")

    /// "fooBar baz-qux_HTTPServer" → ["foo", "Bar", "baz", "qux", "HTTP", "Server"]
    public static func splitWords(_ s: String) -> [String] {
        let spaced = acronymBoundary.replace(camelBoundary.replace(s, template: "$1 $2"), template: "$1 $2")
        return wordRun.all(spaced)
    }

    static func perLine(_ input: String, _ fn: (String) -> String) -> String {
        input.components(separatedBy: "\n").map(fn).joined(separator: "\n")
    }

    /// First character upper, rest lower (JS `w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()`).
    static func cap(_ w: String) -> String {
        guard let first = w.first else { return w }
        return String(first).uppercased() + String(w.dropFirst()).lowercased()
    }

    static func lines(_ input: String) -> [String] {
        input.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
    }

    static func jsTrim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private static let whitespaceRun = TransformRegex("\\s+")

    static func toBase64(_ text: String) -> String { Data(text.utf8).base64EncodedString() }

    private static let base64Shape = TransformRegex("^[A-Za-z0-9+/]*={0,2}$")

    static func fromBase64(_ b64: String) throws -> String {
        let clean = whitespaceRun.replace(jsTrim(b64), template: "").replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard base64Shape.matches(clean) else { throw TransformError("Not valid Base64") }
        // atob tolerates missing padding; re-pad like the JS code and reject impossible lengths.
        let body = clean.replacingOccurrences(of: "=", with: "")
        guard body.count % 4 != 1 else { throw TransformError("Not valid Base64") }
        let padded = body + String(repeating: "=", count: (4 - body.count % 4) % 4)
        guard let data = Data(base64Encoded: padded) else { throw TransformError("Not valid Base64") }
        guard let text = String(data: data, encoding: .utf8) else { throw TransformError("Decoded bytes are not UTF-8 text") }
        return text
    }

    static func parseJSON(_ input: String) throws -> TransformJSON {
        do { return try TransformJSON.parse(input) } catch {
            throw TransformError("Invalid JSON: \(error)")
        }
    }

    static func wrap(_ input: String, width: Int) -> String {
        perLine(input) { line in
            if line.count <= width { return line }
            let indent = TransformRegex("^\\s*").firstGroups(line)?.first ?? ""
            var out: [String] = []
            var cur = ""
            for word in whitespaceRun.split(jsTrim(line)) {
                if !cur.isEmpty && cur.count + 1 + word.count > width - indent.count {
                    out.append(indent + cur)
                    cur = word
                } else {
                    cur = cur.isEmpty ? word : "\(cur) \(word)"
                }
            }
            if !cur.isEmpty { out.append(indent + cur) }
            return out.joined(separator: "\n")
        }
    }

    /// `Date#toISOString`: UTC with milliseconds.
    static func isoString(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        return f.string(from: d)
    }

    private static let numericTimestamp = TransformRegex("^-?\\d{1,16}(\\.\\d+)?$")

    /// `Date.parse` subset: ISO 8601 (with/without fractional seconds or zone; date-only is UTC like JS),
    /// "yyyy-MM-dd HH:mm[:ss]" (local), RFC 1123 / 2822 dates.
    static func parseDate(_ t: String) -> Date? {
        let iso = ISO8601DateFormatter()
        for opts: ISO8601DateFormatter.Options in [[.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime], [.withFullDate]] {
            iso.formatOptions = opts
            if let d = iso.date(from: t) { return d }
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        for (fmt, utc) in [("yyyy-MM-dd'T'HH:mm:ss.SSS", false), ("yyyy-MM-dd'T'HH:mm:ss", false), ("yyyy-MM-dd'T'HH:mm", false),
                           ("yyyy-MM-dd HH:mm:ss", false), ("yyyy-MM-dd HH:mm", false), ("EEE, dd MMM yyyy HH:mm:ss zzz", true),
                           ("EEE, d MMM yyyy HH:mm:ss Z", true), ("dd MMM yyyy HH:mm:ss zzz", true), ("MMM d, yyyy", false), ("MMMM d, yyyy", false),
                           ("yyyy/MM/dd", false), ("MM/dd/yyyy", false)] {
            f.dateFormat = fmt
            f.timeZone = utc ? TimeZone(identifier: "UTC") : TimeZone.current
            if let d = f.date(from: t) { return d }
        }
        return nil
    }

    static func timestamp(_ input: String, now: Date) throws -> String {
        let t = jsTrim(input)
        if t.isEmpty { return "\(Int64((now.timeIntervalSince1970).rounded(.down)))\n\(isoString(now))" }
        if numericTimestamp.matches(t) {
            guard let n = Double(t) else { throw TransformError("Timestamp out of range") }
            // 13+ digits is milliseconds; otherwise seconds.
            let ms = abs(n) >= 1e12 ? n : n * 1000
            guard abs(ms) <= 8.64e15 else { throw TransformError("Timestamp out of range") }
            return isoString(Date(timeIntervalSince1970: ms / 1000))
        }
        guard let d = parseDate(t) else { throw TransformError("Not a unix timestamp or a date") }
        return String(Int64((d.timeIntervalSince1970).rounded(.down)))
    }

    static func jwtDecode(_ input: String) throws -> String {
        let parts = jsTrim(input).components(separatedBy: ".")
        guard parts.count >= 2, parts.count <= 3 else { throw TransformError("Not a JWT (expected header.payload.signature)") }
        func part(_ s: String, _ what: String) throws -> TransformJSON {
            do { return try TransformJSON.parse(try fromBase64(s)) } catch { throw TransformError("JWT \(what) is not Base64URL JSON") }
        }
        let header = try part(parts[0], "header")
        let payload = try part(parts[1], "payload")
        var notes = ["// Decoded only. The signature is NOT verified."]
        for k in ["iat", "nbf", "exp"] {
            if case let .number(v)? = payload[k] { notes.append("// \(k): \(isoString(Date(timeIntervalSince1970: v)))") }
        }
        return notes.joined(separator: "\n") + "\n" + TransformJSON.object([("header", header), ("payload", payload)]).stringify(indent: 2)
    }

    private static let mdFence = TransformRegex("^\\s*(```|~~~)")
    private static let mdHeading = TransformRegex("^\\s{0,3}#{1,6}\\s+")
    private static let mdQuote = TransformRegex("^\\s{0,3}>\\s?")
    private static let mdRule = TransformRegex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
    private static let mdTask = TransformRegex("^(\\s*)[-*+]\\s+\\[[ xX]\\]\\s+")
    private static let mdBullet = TransformRegex("^(\\s*)[-*+]\\s+")
    private static let mdImage = TransformRegex("!\\[([^\\]]*)\\]\\([^)]*\\)")
    private static let mdLink = TransformRegex("\\[([^\\]]+)\\]\\([^)]*\\)")
    private static let mdStrong = TransformRegex("(\\*\\*|__)(.+?)\\1")
    private static let mdEm = TransformRegex("(\\*|_)(?=\\S)(.+?)(?<=\\S)\\1")
    private static let mdStrike = TransformRegex("~~(.+?)~~")
    private static let mdCode = TransformRegex("`([^`]+)`")
    private static let mdTag = TransformRegex("</?[a-z][^>]*>", caseInsensitive: true)
    private static let blankRuns = TransformRegex("\\n{3,}")

    static func markdownToPlain(_ md: String) -> String {
        let body = lines(md).filter { !mdFence.matches($0) }.map { l -> String in
            var s = mdHeading.replace(l, template: "")
            s = mdQuote.replace(s, template: "")
            s = mdRule.replace(s, template: "")
            s = mdTask.replace(s, template: "$1• ")
            s = mdBullet.replace(s, template: "$1• ")
            s = mdImage.replace(s, template: "$1")
            s = mdLink.replace(s, template: "$1")
            s = mdStrong.replace(s, template: "$2")
            s = mdEm.replace(s, template: "$2")
            s = mdStrike.replace(s, template: "$1")
            s = mdCode.replace(s, template: "$1")
            s = mdTag.replace(s, template: "")
            return s
        }.joined(separator: "\n")
        return jsTrim(blankRuns.replace(body, template: "\n\n"))
    }

    private static let paragraphBreak = TransformRegex("\\n\\s*\\n")
    private static let anyWhitespace = TransformRegex("\\s")

    static func counts(_ input: String) -> String {
        let trimmed = jsTrim(input)
        let words = trimmed.isEmpty ? 0 : whitespaceRun.split(trimmed).count
        let lineCount = input.isEmpty ? 0 : lines(input).count
        let paragraphs = trimmed.isEmpty ? 0 : paragraphBreak.split(trimmed).count
        let chars = input.unicodeScalars.count
        let noSpace = anyWhitespace.replace(input, template: "").unicodeScalars.count
        return ["Characters: \(chars)", "Characters (no spaces): \(noSpace)", "Words: \(words)", "Lines: \(lineCount)", "Paragraphs: \(paragraphs)"].joined(separator: "\n")
    }

    static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 { digest.map { String(format: "%02x", $0) }.joined() }

    private static let titleWord = TransformRegex("[\\p{L}\\p{N}][\\p{L}\\p{N}'’]*")
    private static let sentenceStart = TransformRegex("(^\\s*|[.!?]\\s+|\\n\\s*)(\\p{L})")
    private static let nonSlug = TransformRegex("[^a-z0-9]+")
    private static let edgeDashes = TransformRegex("^-+|-+$")
    private static let combiningMarks = TransformRegex("[\\u0300-\\u036f]")
    private static let htmlEntity = TransformRegex("&(#x[0-9a-f]+|#\\d+|amp|lt|gt|quot|apos|#39);", caseInsensitive: true)

    static func htmlEscape(_ s: String) -> String {
        var out = ""
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }

    static func htmlUnescape(_ s: String) throws -> String {
        var failure: TransformError?
        let out = htmlEntity.replace(s) { g in
            let k = g[1].lowercased()
            func scalar(_ v: UInt32?) -> String {
                guard let v, let u = Unicode.Scalar(v) else { failure = TransformError("Invalid character reference \(g[0])"); return g[0] }
                return String(Character(u))
            }
            if k.hasPrefix("#x") { return scalar(UInt32(k.dropFirst(2), radix: 16)) }
            if k.hasPrefix("#") { return scalar(UInt32(k.dropFirst(1), radix: 10)) }
            return ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'"][k] ?? g[0]
        }
        if let failure { throw failure }
        return out
    }

    /// encodeURIComponent's unreserved set.
    private static let uriComponentAllowed: CharacterSet = {
        var set = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        set.insert(charactersIn: "-_.!~*'()")
        return set
    }()

    private static func def(_ id: String, _ title: String, _ category: TransformCategory, _ keywords: [String], usesInput: Bool = true,
                             _ run: @escaping @Sendable (String, TransformOptions) throws -> String) -> TransformDef {
        TransformDef(id: id, title: title, category: category, keywords: keywords, usesInput: usesInput, run: run)
    }

    // MARK: the catalogue (same order as transforms.ts)

    public static let all: [TransformDef] = [
        def("upper", "UPPERCASE", .case, ["uppercase", "upper case", "caps"]) { s, _ in s.uppercased() },
        def("lower", "lowercase", .case, ["lowercase", "lower case"]) { s, _ in s.lowercased() },
        def("title", "Title Case", .case, ["title case", "capitalize"]) { s, _ in titleWord.replace(s) { cap($0[0]) } },
        def("sentence", "Sentence case", .case, ["sentence case"]) { s, _ in sentenceStart.replace(s.lowercased()) { $0[1] + $0[2].uppercased() } },
        def("camel", "camelCase", .case, ["camel case", "camelcase"]) { s, _ in
            perLine(s) { l in splitWords(l).enumerated().map { i, w in i > 0 ? cap(w) : w.lowercased() }.joined() }
        },
        def("pascal", "PascalCase", .case, ["pascal case", "upper camel"]) { s, _ in perLine(s) { splitWords($0).map(cap).joined() } },
        def("snake", "snake_case", .case, ["snake case", "underscore"]) { s, _ in perLine(s) { splitWords($0).map { $0.lowercased() }.joined(separator: "_") } },
        def("constant", "CONSTANT_CASE", .case, ["constant case", "screaming snake"]) { s, _ in perLine(s) { splitWords($0).map { $0.uppercased() }.joined(separator: "_") } },
        def("kebab", "kebab-case", .case, ["kebab case", "dash case", "hyphen"]) { s, _ in perLine(s) { splitWords($0).map { $0.lowercased() }.joined(separator: "-") } },
        def("slugify", "Slugify", .case, ["slug", "url slug", "permalink"]) { s, _ in
            let folded = combiningMarks.replace(s.decomposedStringWithCompatibilityMapping, template: "").lowercased()
            return edgeDashes.replace(nonSlug.replace(folded, template: "-"), template: "")
        },
        def("trim", "Trim Whitespace", .lines, ["trim", "strip", "whitespace"]) { s, _ in perLine(jsTrim(s)) { jsTrim($0) } },
        def("sort", "Sort Lines", .lines, ["sort lines", "alphabetical"]) { s, _ in
            lines(s).enumerated().sorted { a, b in
                let r = a.element.compare(b.element, options: [.caseInsensitive, .diacriticInsensitive, .numeric, .widthInsensitive], range: nil, locale: Locale.current)
                return r == .orderedSame ? a.offset < b.offset : r == .orderedAscending
            }.map(\.element).joined(separator: "\n")
        },
        def("dedupe", "Remove Duplicate Lines", .lines, ["dedupe", "unique", "duplicates", "uniq"]) { s, _ in
            var seen = Set<String>()
            return lines(s).filter { seen.insert($0).inserted }.joined(separator: "\n")
        },
        def("reverse-lines", "Reverse Lines", .lines, ["reverse lines", "flip"]) { s, _ in lines(s).reversed().joined(separator: "\n") },
        def("reverse", "Reverse Text", .lines, ["reverse text", "backwards"]) { s, _ in String(s.reversed()) },
        def("wrap", "Wrap Lines", .lines, ["wrap", "hard wrap", "line width", "80 columns"]) { s, o in wrap(s, width: max(10, o.width ?? 80)) },
        def("count", "Count Words & Characters", .inspect, ["count", "word count", "characters", "lines", "length"]) { s, _ in counts(s) },
        def("json-pretty", "JSON Pretty Print", .data, ["json pretty", "format json", "beautify"]) { s, _ in try parseJSON(s).stringify(indent: 2) },
        def("json-minify", "JSON Minify", .data, ["json minify", "compact json"]) { s, _ in try parseJSON(s).stringify() },
        def("json-validate", "JSON Validate", .data, ["json validate", "lint json", "check json"]) { s, _ in "✓ Valid JSON (\(try parseJSON(s).kindDescription))" },
        def("markdown-plain", "Markdown to Plain Text", .data, ["markdown", "strip markdown", "plain text"]) { s, _ in markdownToPlain(s) },
        def("jwt", "Decode JWT (unverified)", .data, ["jwt", "json web token", "decode token", "bearer"]) { s, _ in try jwtDecode(s) },
        def("timestamp", "Unix Timestamp ↔ ISO Date", .data, ["timestamp", "epoch", "unix time", "iso date", "date"]) { s, o in try timestamp(s, now: o.now ?? Date()) },
        def("base64-encode", "Base64 Encode", .encode, ["base64 encode", "b64"]) { s, _ in toBase64(s) },
        def("base64-decode", "Base64 Decode", .encode, ["base64 decode", "b64 decode"]) { s, _ in try fromBase64(s) },
        def("url-encode", "URL Encode", .encode, ["url encode", "percent encode", "uri"]) { s, _ in s.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? s },
        def("url-decode", "URL Decode", .encode, ["url decode", "percent decode"]) { s, _ in
            guard let d = s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding else { throw TransformError("Malformed percent-encoding") }
            return d
        },
        def("html-escape", "HTML Escape", .encode, ["html escape", "entities", "encode html"]) { s, _ in htmlEscape(s) },
        def("html-unescape", "HTML Unescape", .encode, ["html unescape", "decode entities"]) { s, _ in try htmlUnescape(s) },
        def("md5", "MD5 Hash", .encode, ["md5", "hash", "checksum"]) { s, _ in hex(Insecure.MD5.hash(data: Data(s.utf8))) },
        def("sha1", "SHA-1 Hash", .encode, ["sha1", "hash", "checksum"]) { s, _ in hex(Insecure.SHA1.hash(data: Data(s.utf8))) },
        def("sha256", "SHA-256 Hash", .encode, ["sha256", "hash", "checksum"]) { s, _ in hex(SHA256.hash(data: Data(s.utf8))) },
        def("uuid", "Generate UUID", .generate, ["uuid", "guid", "random id"], usesInput: false) { _, o in (o.uuid ?? { UUID().uuidString.lowercased() })() },
    ]

    public static func byId(_ id: String) -> TransformDef? { all.first { $0.id == id } }

    public static func apply(_ id: String, _ input: String, _ opts: TransformOptions = TransformOptions()) -> TransformResult {
        guard let t = byId(id) else { return .failure("Unknown transform \(id)") }
        if t.usesInput && input.isEmpty && t.id != "timestamp" { return .failure("No input text — select some text or copy it first") }
        do { return .ok(try t.run(input, opts)) } catch let e as TransformError { return .failure(e.message) } catch { return .failure("\(error)") }
    }

    private static let wrapQuery = TransformRegex("^(.*?)\\s*(\\d{2,3})\\s*$")

    /// "wrap 60" → ("wrap", 60): a trailing number in the filter sets the wrap width.
    public static func parseQuery(_ q: String) -> (query: String, width: Int?) {
        if let g = wrapQuery.firstGroups(q), g[1].range(of: "wrap", options: .caseInsensitive) != nil, let w = Int(g[2]) {
            return (g[1], w)
        }
        return (q, nil)
    }

    /// The view's filter: title, keyword or id contains the needle (like TransformView.tsx).
    public static func filter(_ needle: String) -> [TransformDef] {
        let n = jsTrim(needle).lowercased()
        guard !n.isEmpty else { return all }
        return all.filter { $0.title.lowercased().contains(n) || $0.keywords.contains { $0.contains(n) } || $0.id.contains(n) }
    }
}
