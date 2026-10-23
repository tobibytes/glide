import Foundation
import GlideCore

/// `{{var}}` substitution, conditions and built-in variables (src/main/workflows/template.ts).
public enum WorkflowTemplate {
    public static let conditionOperators = ["equals", "contains", "startsWith", "matches regex", "isEmpty", "isNotEmpty", ">", "<"]

    /// Variable names allowed by setVariable and recognised inside `{{ }}`.
    public static func isValidName(_ name: String) -> Bool {
        !name.isEmpty && name.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "." || $0 == "-" }
            && name.unicodeScalars.allSatisfy { $0.isASCII }
    }

    /// Replace every `{{ name }}` with its value; unknown variables become "".
    public static func substitute(_ template: String, _ vars: [String: String]) -> String {
        guard template.contains("{{") else { return template }
        var out = ""
        var rest = Substring(template)
        while let open = rest.range(of: "{{") {
            out += rest[rest.startIndex..<open.lowerBound]
            let after = rest[open.upperBound...]
            if let close = after.range(of: "}}") {
                let inner = after[after.startIndex..<close.lowerBound].trimmingCharacters(in: .whitespaces)
                if isValidName(inner) {
                    out += vars[inner] ?? ""
                    rest = after[close.upperBound...]
                    continue
                }
            }
            // Not a variable reference: keep the braces literally and move on.
            out += "{{"
            rest = after
        }
        out += rest
        return out
    }

    /// Variable names referenced by a template (for "available variables" warnings and lazy selection reads).
    public static func references(_ template: String) -> [String] {
        var names: [String] = []
        var rest = Substring(template)
        while let open = rest.range(of: "{{") {
            let after = rest[open.upperBound...]
            guard let close = after.range(of: "}}") else { break }
            let inner = after[after.startIndex..<close.lowerBound].trimmingCharacters(in: .whitespaces)
            if isValidName(inner), !names.contains(inner) { names.append(inner) }
            rest = after[close.upperBound...]
        }
        return names
    }

    public static func substituteParams(_ params: [String: JSONValue], _ vars: [String: String]) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in params { out[k] = substitute(v.description, vars) }
        return out
    }

    public static func evaluateCondition(_ left: String, _ op: String, _ right: String) -> Bool {
        switch op {
        case "equals": return left == right
        case "contains": return right.isEmpty || left.contains(right)
        case "startsWith": return left.hasPrefix(right)
        case "matches regex":
            guard let re = try? NSRegularExpression(pattern: right) else { return false }
            return re.firstMatch(in: left, range: NSRange(left.startIndex..., in: left)) != nil
        case "isEmpty": return left.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case "isNotEmpty": return !left.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case ">", "<":
            if let a = jsNumber(left), let b = jsNumber(right) { return op == ">" ? a > b : a < b }
            return op == ">" ? left > right : left < right
        default: return false
        }
    }

    /// `Number(s)` semantics for the comparison operators ("" → 0, whitespace trimmed, NaN → nil).
    static func jsNumber(_ s: String) -> Double? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return 0 }
        if let d = Double(t), d.isFinite { return d }
        if t.lowercased().hasPrefix("0x"), let i = Int(t.dropFirst(2), radix: 16) { return Double(i) }
        return nil
    }

    /// {{date}}, {{time}}, {{timestamp}} — like `toLocaleDateString()` / `toLocaleTimeString([], {hour, minute})`.
    public static func builtinVariables(now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current) -> [String: String] {
        let d = DateFormatter()
        d.locale = locale
        d.timeZone = timeZone
        d.setLocalizedDateFormatFromTemplate("yMd")
        let t = DateFormatter()
        t.locale = locale
        t.timeZone = timeZone
        t.setLocalizedDateFormatFromTemplate("jjmm")
        return ["date": d.string(from: now), "time": t.string(from: now), "timestamp": String(Int64(now.timeIntervalSince1970 * 1000))]
    }
}

/// Normalises stored actions before a run (src/main/workflows/migrate.ts). Accepted feature-action forms:
///   { type: "feature", params: { feature, action, …params } }   (canonical)
///   { type: "feature", feature, action, params: { … } }        (object form)
///   { type: "feature:<feature>.<action>", params }              (compact form)
public enum WorkflowMigration {
    public static func migrate(_ a: WorkflowAction) -> WorkflowAction {
        var next = a
        if a.type.hasPrefix("feature:"), let (f, act) = compact(a.type) {
            next.type = "feature"
            next.params[FeatureActionKeys.feature] = .string(f)
            next.params[FeatureActionKeys.action] = .string(act)
        } else if a.type == "feature" {
            if let f = a.extra[FeatureActionKeys.feature]?.stringValue {
                next.params[FeatureActionKeys.feature] = .string(f)
                next.extra[FeatureActionKeys.feature] = nil
            }
            if let act = a.extra[FeatureActionKeys.action]?.stringValue {
                next.params[FeatureActionKeys.action] = .string(act)
                next.extra[FeatureActionKeys.action] = nil
            }
        }
        if let t = a.then { next.then = t.map(migrate) }
        if let e = a.else { next.else = e.map(migrate) }
        return next
    }

    public static func migrate(_ wf: Workflow) -> Workflow {
        var w = wf
        w.actions = wf.actions.map(migrate)
        return w
    }

    /// "feature:<feature>.<action>" with feature `[\w-]+` and action `[\w.-]+`.
    static func compact(_ type: String) -> (String, String)? {
        let body = type.dropFirst("feature:".count)
        guard let dot = body.firstIndex(of: ".") else { return nil }
        let f = String(body[body.startIndex..<dot])
        let a = String(body[body.index(after: dot)...])
        let fOK = !f.isEmpty && f.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-") }
        let aOK = !a.isEmpty && a.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-" || $0 == ".") }
        return fOK && aOK ? (f, a) : nil
    }
}
