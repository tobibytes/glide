import Foundation
import GlideCore

/// Quicklink logic that does not touch the system (port of src/main/quicklinks/core.ts): argument values,
/// validation, URL building, import/export.
public enum QLCore {
    public typealias ArgumentDef = QLTemplate.ArgumentDef

    /// Explicit per-name values (multi-argument entry) win; a plain argument string fills the first argument.
    public static func values(_ defs: [ArgumentDef], named: [String: String]?, argument: String?) -> [String: String] {
        var out: [String: String] = [:]
        for d in defs { if let v = named?[d.name], !v.isEmpty { out[d.name] = v } }
        if let first = defs.first, out[first.name] == nil, let a = argument?.trimmingCharacters(in: .whitespaces), !a.isEmpty { out[first.name] = a }
        return out
    }

    public static func missing(_ defs: [ArgumentDef], _ values: [String: String]) -> [ArgumentDef] {
        defs.filter { !$0.optional && (values[$0.name] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    public static func invalidOptions(_ defs: [ArgumentDef], _ values: [String: String]) -> [ArgumentDef] {
        defs.filter { d in
            guard let opts = d.options, !opts.isEmpty, let v = values[d.name], !v.isEmpty else { return false }
            return !opts.contains(v)
        }
    }

    public static func buildURL(_ url: String, env: QLTemplate.Env) -> String {
        QLTemplate.render(url, env: env, options: .init(encode: true)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Legacy single-`{query}` links keep the classic one-field entry; everything else uses argument pills.
    public static func wantsMultiArgument(_ defs: [ArgumentDef]) -> Bool {
        defs.count > 1 || (defs.count == 1 && (defs[0].name != "query" || defs[0].options != nil || defs[0].defaultValue != nil))
    }

    public enum Resolution: Equatable {
        case url(String)
        case error(String)
    }

    /// Validate values and render the URL (clipboard/selection supplied by the caller).
    public static func resolve(_ template: String, named: [String: String]?, argument: String?, env: QLTemplate.Env) -> Resolution {
        let defs = QLTemplate.arguments(template)
        let vals = values(defs, named: named, argument: argument)
        let legacy = defs.count == 1 && defs[0].name == "query"
        let miss = legacy ? [] : missing(defs, vals)
        if !miss.isEmpty { return .error("Fill in \(miss.map { "“\($0.placeholder)”" }.joined(separator: ", ")) — Tab moves between arguments") }
        if let bad = invalidOptions(defs, vals).first { return .error("“\(vals[bad.name] ?? "")” is not one of \(bad.options?.joined(separator: ", ") ?? "")") }
        var e = env
        e.arguments = vals
        return .url(buildURL(template, env: e))
    }

    // MARK: import / export

    public static func exportJSON(_ list: [Quicklink], now: Date = Date()) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let items: [JSONValue] = list.map { q in
            var o: [String: JSONValue] = ["id": .string(q.id), "name": .string(q.name), "url": .string(q.url)]
            if let a = q.alias { o["alias"] = .string(a) }
            if let k = q.keywords { o["keywords"] = .array(k.map(JSONValue.string)) }
            if let w = q.openWith { o["openWith"] = .string(w) }
            if let i = q.icon { o["icon"] = ["kind": .string(i.kind), "value": .string(i.value)] }
            return .object(o)
        }
        let doc: JSONValue = ["format": "glide.quicklinks", "version": 1, "exportedAt": .string(iso.string(from: now)), "quicklinks": .array(items)]
        return String(decoding: (try? JSONEncoder.glide.encode(doc)) ?? Data(), as: UTF8.self)
    }

    public enum ImportError: Error, LocalizedError, Equatable {
        case invalidJSON, noQuicklinks
        public var errorDescription: String? {
            self == .invalidJSON ? "The file is not valid JSON" : "No quicklinks found (expected an array or {quicklinks: [...]})"
        }
    }

    /// Glide exports ({quicklinks:[…]} or a bare array) and Raycast's export ([{name, link, openWith?}]).
    public static func parseImport(_ json: String) throws -> (quicklinks: [Quicklink], skipped: Int) {
        guard let raw = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) else { throw ImportError.invalidJSON }
        guard let list = raw.arrayValue ?? raw["quicklinks"]?.arrayValue ?? raw["items"]?.arrayValue else { throw ImportError.noQuicklinks }
        var out: [Quicklink] = []
        var skipped = 0
        func s(_ v: JSONValue?) -> String { v?.stringValue?.trimmingCharacters(in: .whitespaces) ?? "" }
        for r in list {
            guard r.objectValue != nil else { skipped += 1; continue }
            let name = s(r["name"]).isEmpty ? s(r["title"]) : s(r["name"])
            let url = s(r["url"]).isEmpty ? s(r["link"]) : s(r["url"])
            guard !name.isEmpty, !url.isEmpty else { skipped += 1; continue }
            var q = Quicklink(id: "", name: name, url: url)
            if !s(r["alias"]).isEmpty { q.alias = s(r["alias"]) }
            if let k = r["keywords"]?.arrayValue { q.keywords = k.compactMap(\.stringValue) }
            let ow = [s(r["openWith"]), s(r["application"]), s(r["openWith"]?["path"]), s(r["openWith"]?["bundleId"])].first { !$0.isEmpty }
            if let ow { q.openWith = ow }
            if let k = r["icon"]?["kind"]?.stringValue, let v = r["icon"]?["value"]?.stringValue, ["emoji", "symbol", "app", "file", "url", "color"].contains(k) {
                q.icon = ItemIcon(kind: k, value: v)
            }
            out.append(q)
        }
        return (out, skipped)
    }

    static func urlKey(_ u: String) -> String {
        var s = u.trimmingCharacters(in: .whitespaces)
        while s.hasSuffix("/") { s.removeLast() }
        return s.lowercased()
    }

    public static func dedupe(_ incoming: [Quicklink], existing: [Quicklink]) -> [Quicklink] {
        var seen = Set(existing.map { urlKey($0.url) })
        return incoming.filter { seen.insert(urlKey($0.url)).inserted }
    }

    public static func newId() -> String {
        "ql-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))-\(String(UInt32.random(in: 0...UInt32.max), radix: 36).prefix(4))"
    }
}
