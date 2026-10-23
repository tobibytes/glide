import Foundation
import GlideCore

/// Typed reads of the wire view model (ViewModel in src/extension-api/types.ts). The JSON stays the source of
/// truth (unknown fields survive); these are lightweight views over it.
struct ExtAction: Identifiable, Hashable {
    var json: JSONValue
    var id: String { json["id"]?.stringValue ?? "" }
    var kind: String { json["kind"]?.stringValue ?? "run" }
    var title: String { json["title"]?.stringValue ?? "Action" }
    var shortcut: String? { json["shortcut"]?.stringValue }
    var icon: String? { json["icon"]?.stringValue }
    var destructive: Bool { json["destructive"]?.boolValue == true }
    var handler: String? { json["handler"]?.stringValue }
    var callback: String? { json["callback"]?.stringValue }
    var url: String? { json["url"]?.stringValue }
    var text: String? { json["text"]?.stringValue }
    var html: String? { json["html"]?.stringValue }
    var target: String? { json["target"]?.stringValue }
    var application: String? { json["application"]?.stringValue }
    var paths: [String] { (json["paths"]?.arrayValue ?? []).compactMap(\.stringValue) }
    var section: String? { json["section"]?.stringValue }
    var children: [ExtAction] { (json["children"]?.arrayValue ?? []).map(ExtAction.init) }

    init(_ json: JSONValue) { self.json = json }

    /// For the shared ⌘K panel (the first action is ⏎, the second ⌘⏎ unless they carry their own shortcut).
    func itemAction(index: Int) -> ItemAction {
        let sc = shortcut ?? (index == 0 ? "↩" : index == 1 ? "⌘↩" : nil)
        return ItemAction(id: id, title: kind == "submenu" ? "\(title) ›" : title, shortcut: sc, icon: icon, destructive: destructive)
    }
}

struct ExtItem: Identifiable, Hashable {
    var json: JSONValue
    var id: String { json["id"]?.stringValue ?? "" }
    var title: String { json["title"]?.stringValue ?? "" }
    var subtitle: String? { json["subtitle"]?.stringValue }
    var icon: String? { json["icon"]?.stringValue ?? json["content"]?.stringValue }
    var content: String? { json["content"]?.stringValue }
    var section: String? { json["section"]?.stringValue }
    var keywords: [String] { (json["keywords"]?.arrayValue ?? []).compactMap(\.stringValue) }
    var accessories: [JSONValue] { json["accessories"]?.arrayValue ?? [] }
    var actions: [ExtAction] { (json["actions"]?.arrayValue ?? []).map(ExtAction.init) }
    var detail: JSONValue? { json["detail"] }
    init(_ json: JSONValue) { self.json = json }
}

extension JSONValue {
    var extType: String { self["type"]?.stringValue ?? "" }
    var extItems: [ExtItem] { (self["items"]?.arrayValue ?? []).map(ExtItem.init) }
    var extActions: [ExtAction] { (self["actions"]?.arrayValue ?? []).map(ExtAction.init) }
    var extLoading: Bool { self["isLoading"]?.boolValue == true }
}

enum ExtFilter {
    static func norm(_ s: String) -> String { s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased() }

    static func score(_ item: ExtItem, _ words: [String]) -> Double {
        let title = norm(item.title)
        let rest = norm(([item.subtitle ?? ""] + item.keywords + item.accessories.map { $0["text"]?.stringValue ?? $0["tag"]?.stringValue ?? "" }).joined(separator: " "))
        var total = 0.0
        for w in words {
            if title.hasPrefix(w) { total += 100 }
            else if title.range(of: "(^|[^a-z0-9])" + NSRegularExpression.escapedPattern(for: w), options: .regularExpression) != nil { total += 60 }
            else if title.contains(w) { total += 30 }
            else if rest.contains(w) { total += 10 }
            else { return 0 }
        }
        return total - Double(min(title.count, 50)) / 100
    }

    /// Local filtering of List/Grid items (src/renderer/features/extensions/filter.ts).
    static func filter(_ items: [ExtItem], _ query: String) -> [ExtItem] {
        let words = norm(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !words.isEmpty else { return items }
        var scored: [(i: Int, item: ExtItem, s: Double)] = []
        for (i, item) in items.enumerated() {
            let s = score(item, words)
            if s > 0 { scored.append((i, item, s)) }
        }
        scored.sort { a, b in a.s != b.s ? a.s > b.s : a.i < b.i }
        return scored.map(\.item)
    }
}

/// http(s)/mailto only (actions.ts isSafeUrl).
func isSafeExtensionURL(_ s: String) -> Bool {
    let l = s.lowercased()
    guard l.hasPrefix("http:") || l.hasPrefix("https:") || l.hasPrefix("mailto:") else { return false }
    return URL(string: s) != nil
}

/// Minimal Markdown → blocks for Detail views (headings, paragraphs, lists, quotes, code, rules, images).
/// Raw HTML is shown as text; inline formatting uses AttributedString's Markdown parser.
enum MarkdownBlock: Hashable {
    case heading(Int, String)
    case paragraph(String)
    case bullet(String, ordered: String?)
    case quote(String)
    case code(String)
    case rule
    case image(alt: String, url: String)

    static func parse(_ md: String) -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        var para: [String] = []
        var code: [String]?
        func flush() { if !para.isEmpty { out.append(.paragraph(para.joined(separator: " "))); para = [] } }
        for raw in md.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let line = raw
            let t = line.trimmingCharacters(in: .whitespaces)
            if code != nil {
                if t.hasPrefix("```") { out.append(.code(code!.joined(separator: "\n"))); code = nil } else { code!.append(line) }
                continue
            }
            if t.hasPrefix("```") { flush(); code = []; continue }
            if t.isEmpty { flush(); continue }
            if t == "---" || t == "***" || t == "___" { flush(); out.append(.rule); continue }
            if let hashes = t.firstIndex(where: { $0 != "#" }), t.hasPrefix("#"), t[hashes] == " ", t.distance(from: t.startIndex, to: hashes) <= 6 {
                flush()
                out.append(.heading(t.distance(from: t.startIndex, to: hashes), String(t[hashes...]).trimmingCharacters(in: .whitespaces)))
                continue
            }
            if t.hasPrefix("!["), let close = t.range(of: "]("), t.hasSuffix(")") {
                flush()
                out.append(.image(alt: String(t[t.index(t.startIndex, offsetBy: 2)..<close.lowerBound]), url: String(t[close.upperBound..<t.index(before: t.endIndex)])))
                continue
            }
            if t.hasPrefix("> ") || t == ">" { flush(); out.append(.quote(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))); continue }
            if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") { flush(); out.append(.bullet(String(t.dropFirst(2)), ordered: nil)); continue }
            if let dot = t.firstIndex(of: "."), t[..<dot].allSatisfy(\.isNumber), !t[..<dot].isEmpty, t[t.index(after: dot)...].hasPrefix(" ") {
                flush()
                out.append(.bullet(String(t[t.index(dot, offsetBy: 2)...]), ordered: String(t[..<dot])))
                continue
            }
            para.append(t)
        }
        if let code { out.append(.code(code.joined(separator: "\n"))) }
        flush()
        return out
    }
}
