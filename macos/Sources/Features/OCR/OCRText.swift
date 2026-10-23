import Foundation
import GlideCore

/// Pure OCR/barcode result handling (port of src/main/features/ocr/text.ts).
public enum OCRText {
    /// Rebuild reading order: runs whose vertical extents overlap by more than half form one row (left→right);
    /// a gap larger than ~1.2 line heights starts a new paragraph.
    public static func assemble(_ lines: [OCRLine], minConfidence: Double = 0) -> String {
        let runs = lines.filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty && $0.confidence >= minConfidence }
            .sorted { $0.box.y != $1.box.y ? $0.box.y < $1.box.y : $0.box.x < $1.box.x }
        guard !runs.isEmpty else { return "" }
        var rows: [[OCRLine]] = []
        for run in runs {
            if let row = rows.last {
                let top = row.map(\.box.y).min() ?? 0
                let bottom = row.map { $0.box.y + $0.box.height }.max() ?? 0
                let overlap = min(bottom, run.box.y + run.box.height) - max(top, run.box.y)
                if overlap > 0.5 * min(bottom - top, run.box.height) {
                    rows[rows.count - 1].append(run)
                    continue
                }
            }
            rows.append([run])
        }
        let heights = rows.map { $0.map(\.box.height).max() ?? 0 }.sorted()
        let lineHeight = heights[heights.count / 2]
        var out = ""
        var prevBottom: Double?
        for row in rows {
            let sorted = row.sorted { $0.box.x < $1.box.x }
            let top = row.map(\.box.y).min() ?? 0
            if let pb = prevBottom { out += top - pb > lineHeight * 1.2 ? "\n\n" : "\n" }
            out += sorted.map { $0.text.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
            prevBottom = row.map { $0.box.y + $0.box.height }.max()
        }
        return out
    }

    public enum PayloadKind: String, Codable, Sendable { case url, email, phone, wifi, uri, text }

    public struct WiFi: Hashable, Codable, Sendable {
        public var ssid: String
        public var password: String?
        public var security: String?
    }

    public struct Payload: Hashable, Codable, Sendable {
        public var kind: PayloadKind
        public var url: String?
        public var label: String
        public var wifi: WiFi?
    }

    static func matches(_ s: String, _ p: String, _ opts: NSRegularExpression.Options = [.caseInsensitive]) -> Bool {
        (try? NSRegularExpression(pattern: p, options: opts))?.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    /// WIFI:T:WPA;S:My Net;P:secret;; — values may escape ; , : \ with a backslash.
    static func parseWifi(_ payload: String) -> WiFi {
        var fields: [String: String] = [:]
        let body = Array(payload.dropFirst(5))
        var key = "", val = "", inKey = true, i = 0
        while i < body.count {
            let ch = body[i]
            if ch == "\\" && i + 1 < body.count {
                i += 1
                if inKey { key.append(body[i]) } else { val.append(body[i]) }
            } else if inKey && ch == ":" {
                inKey = false
            } else if !inKey && ch == ";" {
                fields[key.uppercased()] = val
                key = ""
                val = ""
                inKey = true
            } else if inKey {
                key.append(ch)
            } else {
                val.append(ch)
            }
            i += 1
        }
        if !inKey && !key.isEmpty { fields[key.uppercased()] = val }
        return WiFi(ssid: fields["S"] ?? "", password: fields["P"], security: fields["T"])
    }

    static let neverOpen: Set<String> = ["javascript", "data", "file", "vbscript"]

    public static func classify(_ raw: String) -> Payload {
        let p = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if matches(p, #"^https?://\S+$"#) { return Payload(kind: .url, url: p, label: p) }
        if matches(p, #"^www\.\S+\.\S+$"#) { return Payload(kind: .url, url: "https://\(p)", label: p) }
        if matches(p, "^mailto:") { return Payload(kind: .email, url: p, label: String(p.dropFirst(7)).components(separatedBy: "?").first ?? p) }
        if matches(p, #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, []) { return Payload(kind: .email, url: "mailto:\(p)", label: p) }
        if matches(p, "^tel:") { return Payload(kind: .phone, url: p, label: String(p.dropFirst(4))) }
        if matches(p, "^WIFI:") {
            let w = parseWifi(p)
            return Payload(kind: .wifi, url: nil, label: "Wi-Fi “\(w.ssid)”", wifi: w)
        }
        if let scheme = scheme(p), !neverOpen.contains(scheme), !p.contains(where: \.isWhitespace) { return Payload(kind: .uri, url: p, label: p) }
        return Payload(kind: .text, url: nil, label: p.count > 80 ? String(p.prefix(79)) + "…" : p)
    }

    static func scheme(_ s: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: #"^([a-z][a-z0-9+.-]*):"#, options: .caseInsensitive),
              let m = re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) else { return nil }
        return (s as NSString).substring(with: m.range(at: 1)).lowercased()
    }

    /// http(s) links, www. hosts and e-mail addresses in recognized text, de-duplicated.
    public static func extractLinks(_ text: String) -> [String] {
        var out: [String] = []
        func add(_ s: String) { if !out.contains(s) { out.append(s) } }
        let ns = text as NSString
        if let re = try? NSRegularExpression(pattern: #"\b(?:https?://|www\.)[^\s<>"')\]]+"#, options: .caseInsensitive) {
            for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                let u = ns.substring(with: m.range).replacingOccurrences(of: "[.,;:!?]+$", with: "", options: .regularExpression)
                add(u.lowercased().hasPrefix("www.") ? "https://\(u)" : u)
            }
        }
        if let re = try? NSRegularExpression(pattern: #"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"#, options: .caseInsensitive) {
            for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) { add("mailto:\(ns.substring(with: m.range))") }
        }
        return out
    }

    public static func isOpenable(_ url: String) -> Bool { scheme(url).map { !neverOpen.contains($0) } ?? false }

    public static func stats(_ text: String) -> (lines: Int, words: Int, chars: Int) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return (t.isEmpty ? 0 : t.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count,
                t.isEmpty ? 0 : t.split(whereSeparator: \.isWhitespace).count, text.utf16.count)
    }
}
