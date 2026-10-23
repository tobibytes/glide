import Foundation
import GlideCore

// Port of src/main/features/sync/merge.ts (deterministic, file-compatible with the Electron app). UserData is
// flattened into keyed items ("workflow.<id>", "settings.vimMode", "feature.clipboard", …); every machine keeps
// a manifest stamping each item with its last local change; deletions become tombstones; merging picks per key
// the newest stamp, ties broken by machine name, then tombstone, then serialized value — the same result on
// every machine in any order.

public struct SyncEntry: Equatable, Sendable {
    /// The item's value (null for a tombstone).
    public var v: JSONValue
    /// Last local change, unix ms.
    public var t: Double
    /// Machine that made the change.
    public var m: String
    /// Tombstone: the item was deleted.
    public var d: Bool
    public init(v: JSONValue, t: Double, m: String, d: Bool = false) {
        self.v = v
        self.t = t
        self.m = m
        self.d = d
    }

    public init?(json: JSONValue) {
        guard let o = json.objectValue, let t = o["t"]?.doubleValue, t.isFinite, let m = o["m"]?.stringValue, let v = o["v"] else { return nil }
        self.init(v: v, t: t, m: m, d: o["d"]?.boolValue == true)
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["v": v, "t": .double(t), "m": .string(m)]
        if d { o["d"] = true }
        return .object(o)
    }
}

public typealias SyncSnapshot = [String: SyncEntry]

public struct SyncFile: Sendable {
    public var machine: String
    public var version: Int
    public var exportedAt: Double
    public var entries: SyncSnapshot
}

public struct SyncConflict: Equatable, Sendable {
    public var key: String
    public var label: String
    public var at: Double
    public var winner: (machine: String, t: Double, deleted: Bool)
    public var loser: (machine: String, t: Double, deleted: Bool)
    public static func == (a: SyncConflict, b: SyncConflict) -> Bool {
        a.key == b.key && a.label == b.label && a.at == b.at && a.winner == b.winner && a.loser == b.loser
    }
    public var json: JSONValue {
        ["key": .string(key), "label": .string(label), "at": .double(at),
         "winner": ["machine": .string(winner.machine), "t": .double(winner.t), "deleted": .bool(winner.deleted)],
         "loser": ["machine": .string(loser.machine), "t": .double(loser.t), "deleted": .bool(loser.deleted)]]
    }
    public init(key: String, label: String, at: Double, winner: (machine: String, t: Double, deleted: Bool), loser: (machine: String, t: Double, deleted: Bool)) {
        self.key = key; self.label = label; self.at = at; self.winner = winner; self.loser = loser
    }
    public init?(json: JSONValue) {
        guard let k = json["key"]?.stringValue, let w = json["winner"], let l = json["loser"] else { return nil }
        self.init(key: k, label: json["label"]?.stringValue ?? k, at: json["at"]?.doubleValue ?? 0,
                  winner: (w["machine"]?.stringValue ?? "", w["t"]?.doubleValue ?? 0, w["deleted"]?.boolValue ?? false),
                  loser: (l["machine"]?.stringValue ?? "", l["t"]?.doubleValue ?? 0, l["deleted"]?.boolValue ?? false))
    }
}

public struct ChangePreview: Equatable, Sendable {
    public var added: [(key: String, label: String)] = []
    public var removed: [(key: String, label: String)] = []
    public var changed: [(key: String, label: String)] = []
    public var count: Int { added.count + removed.count + changed.count }
    public static func == (a: ChangePreview, b: ChangePreview) -> Bool {
        a.added.map(\.key) == b.added.map(\.key) && a.removed.map(\.key) == b.removed.map(\.key) && a.changed.map(\.key) == b.changed.map(\.key)
    }
    public var json: JSONValue {
        func list(_ l: [(key: String, label: String)]) -> JSONValue { .array(l.map { ["key": .string($0.key), "label": .string($0.label)] }) }
        return ["added": list(added), "removed": list(removed), "changed": list(changed)]
    }
}

public enum SyncMerge {
    public static let formatVersion = 1
    /// Settings that make sense on another Mac (launchAtLogin is per-machine; features are synced per bag).
    public static let syncedSettings = ["hotkey", "theme", "disabledSources", "appDirectories", "fileSearch", "calculator", "sectionLimit", "hideOnBlur",
                                        "keepOpenAfterRun", "frecencyHalfLifeDays", "vimMode"]
    /// Feature bags never synced (folder paths are per-machine).
    public static let localFeatures: Set<String> = ["sync"]
    static let tombstoneTTLms: Double = 90 * 24 * 3600 * 1000

    static func isSecret(_ k: String) -> Bool {
        k.range(of: #"(api[-_]?key|secret|token|password|passphrase|credential|private[-_]?key)"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    // MARK: stable JSON (JSON.stringify with sorted keys)

    static func jsString(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }

    static func jsNumber(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == d.rounded(), abs(d) < 1e21 { return String(Int64(exactly: d) ?? Int64(d)) }
        return "\(d)"
    }

    public static func stableStringify(_ v: JSONValue) -> String {
        switch v {
        case .null: return "null"
        case let .bool(b): return b ? "true" : "false"
        case let .int(i): return String(i)
        case let .double(d): return jsNumber(d)
        case let .string(s): return jsString(s)
        case let .array(a): return "[" + a.map(stableStringify).joined(separator: ",") + "]"
        case let .object(o): return "{" + o.keys.sorted().map { "\(jsString($0)):\(stableStringify(o[$0]!))" }.joined(separator: ",") + "}"
        }
    }

    static func same(_ a: JSONValue, _ b: JSONValue) -> Bool { stableStringify(a) == stableStringify(b) }

    public static func stripSecrets(_ bag: [String: JSONValue]) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, v) in bag where !isSecret(k) { out[k] = v.objectValue.map { .object(stripSecrets($0)) } ?? v }
        return out
    }

    static func secretsOf(_ bag: [String: JSONValue]) -> [String: JSONValue] { bag.filter { isSecret($0.key) } }

    // MARK: UserData <-> JSON

    public static func json(_ d: UserData) -> [String: JSONValue] {
        guard let data = try? JSONEncoder().encode(d), let v = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [:] }
        return v.objectValue ?? [:]
    }

    public static func userData(_ o: [String: JSONValue]) -> UserData? {
        guard let data = try? JSONEncoder().encode(JSONValue.object(o)) else { return nil }
        return try? JSONDecoder().decode(UserData.self, from: data)
    }

    static let defaultSettingsJSON: [String: JSONValue] = json(UserData())["settings"]?.objectValue ?? [:]

    /// UserData → { key: value } for everything that syncs.
    public static func flatten(_ d: UserData) -> [String: JSONValue] { flatten(json: json(d)) }

    public static func flatten(json data: [String: JSONValue]) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        let settings = data["settings"]?.objectValue ?? [:]
        for k in syncedSettings { out["settings.\(k)"] = settings[k] ?? defaultSettingsJSON[k] ?? .null }
        for (id, bag) in settings["features"]?.objectValue ?? [:] where !localFeatures.contains(id) {
            if let b = bag.objectValue { out["feature.\(id)"] = .object(stripSecrets(b)) }
        }
        for (kind, key) in [("workflow", "workflows"), ("quicklink", "quicklinks"), ("snippet", "snippets")] {
            for item in data[key]?.arrayValue ?? [] { if let id = item["id"]?.stringValue { out["\(kind).\(id)"] = item } }
        }
        for f in data["favorites"]?.arrayValue ?? [] { if let s = f.stringValue { out["favorite.\(s)"] = true } }
        for (id, a) in data["aliases"]?.objectValue ?? [:] { out["alias.\(id)"] = a }
        for (id, h) in data["hotkeys"]?.objectValue ?? [:] { out["hotkey.\(id)"] = h }
        return out
    }

    static func split(_ key: String) -> (String, String) {
        guard let i = key.firstIndex(of: ".") else { return (key, "") }
        return (String(key[..<i]), String(key[key.index(after: i)...]))
    }

    static func kindOf(_ v: JSONValue) -> String {
        switch v {
        case .null: return "null"
        case .bool: return "boolean"
        case .int, .double: return "number"
        case .string: return "string"
        case .array: return "array"
        case .object: return "object"
        }
    }

    static func valid(_ kind: String, _ v: JSONValue) -> Bool {
        guard let o = v.objectValue, o["id"]?.stringValue != nil, o["name"]?.stringValue != nil else { return false }
        switch kind {
        case "workflow": return o["actions"]?.arrayValue != nil
        case "quicklink": return o["url"]?.stringValue != nil
        case "snippet": return o["text"]?.stringValue != nil
        default: return false
        }
    }

    /// Keep base order for items that stay, append new ones in key order (deterministic).
    static func collection(_ base: [JSONValue], _ values: [String: JSONValue], _ kind: String) -> [JSONValue] {
        var wanted: [String: JSONValue] = [:]
        for (key, v) in values {
            let (k, id) = split(key)
            if k == kind && valid(kind, v) && v["id"]?.stringValue == id { wanted[id] = v }
        }
        let baseIds = base.compactMap { $0["id"]?.stringValue }
        let kept = baseIds.filter { wanted[$0] != nil }.compactMap { wanted[$0] }
        let added = wanted.keys.filter { !baseIds.contains($0) }.sorted().compactMap { wanted[$0] }
        return kept + added
    }

    /// Apply flattened values onto `base` (JSON form). Collections become exactly what `values` lists; settings
    /// and feature bags missing from `values` keep their base value; local-only settings, secrets and
    /// local features are preserved; unknown top-level keys survive.
    public static func unflatten(json base: [String: JSONValue], _ values: [String: JSONValue]) -> [String: JSONValue] {
        var out = base
        var settings = base["settings"]?.objectValue ?? defaultSettingsJSON
        var features = settings["features"]?.objectValue ?? [:]
        for k in syncedSettings {
            if let v = values["settings.\(k)"], let d = defaultSettingsJSON[k], kindOf(v) == kindOf(d) { settings[k] = v }
        }
        for (key, v) in values {
            let (kind, id) = split(key)
            guard kind == "feature", !localFeatures.contains(id), let bag = v.objectValue else { continue }
            var merged = stripSecrets(bag)
            for (sk, sv) in secretsOf(features[id]?.objectValue ?? [:]) { merged[sk] = sv }
            features[id] = .object(merged)
        }
        settings["features"] = .object(features)
        out["settings"] = .object(settings)
        out["workflows"] = .array(collection(base["workflows"]?.arrayValue ?? [], values, "workflow"))
        out["quicklinks"] = .array(collection(base["quicklinks"]?.arrayValue ?? [], values, "quicklink"))
        out["snippets"] = .array(collection(base["snippets"]?.arrayValue ?? [], values, "snippet"))
        func strings(_ kind: String) -> [String: JSONValue] {
            var o: [String: JSONValue] = [:]
            for key in values.keys.sorted() {
                let (k, id) = split(key)
                if k == kind, case .string = values[key]! { o[id] = values[key]! }
            }
            return o
        }
        let favs = values.keys.filter { $0.hasPrefix("favorite.") && values[$0] == .bool(true) }.map { split($0).1 }
        let baseFavs = base["favorites"]?.arrayValue?.compactMap(\.stringValue) ?? []
        out["favorites"] = .array((baseFavs.filter { favs.contains($0) } + favs.filter { !baseFavs.contains($0) }.sorted()).map(JSONValue.string))
        out["aliases"] = .object(strings("alias"))
        out["hotkeys"] = .object(strings("hotkey"))
        return out
    }

    public static func unflatten(_ base: UserData, _ values: [String: JSONValue]) -> UserData {
        userData(unflatten(json: json(base), values)) ?? base
    }

    /// Live values from a snapshot (tombstones dropped).
    public static func values(_ s: SyncSnapshot) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, e) in s where !e.d { out[k] = e.v }
        return out
    }

    /// Re-stamp the manifest from the current values: unchanged items keep their stamp, changes get `now`,
    /// removals become tombstones (dropped after 90 days).
    public static func trackLocal(_ prev: SyncSnapshot, _ values: [String: JSONValue], now: Double, machine: String) -> SyncSnapshot {
        var next: SyncSnapshot = [:]
        for (k, v) in values {
            if let p = prev[k], !p.d, same(p.v, v) { next[k] = p } else { next[k] = SyncEntry(v: v, t: now, m: machine) }
        }
        for (k, p) in prev where values[k] == nil {
            if p.d { if now - p.t < tombstoneTTLms { next[k] = p } } else { next[k] = SyncEntry(v: .null, t: now, m: machine, d: true) }
        }
        return next
    }

    /// Total order on entries: newer wins; ties by machine name, then tombstone, then value.
    public static func compare(_ a: SyncEntry, _ b: SyncEntry) -> Int {
        if a.t != b.t { return a.t < b.t ? -1 : 1 }
        if a.m != b.m { return a.m.utf16.lexicographicallyPrecedes(b.m.utf16) ? -1 : 1 }
        if a.d != b.d { return a.d ? 1 : -1 }
        let sa = stableStringify(a.v), sb = stableStringify(b.v)
        return sa == sb ? 0 : sa.utf16.lexicographicallyPrecedes(sb.utf16) ? -1 : 1
    }

    public static func merge(_ snapshots: [SyncSnapshot]) -> SyncSnapshot {
        var out: SyncSnapshot = [:]
        for s in snapshots {
            for (k, e) in s {
                if let cur = out[k], compare(e, cur) <= 0 { continue }
                out[k] = e
            }
        }
        return out
    }

    /// Keys both this machine and another changed since the last sync, with different results.
    public static func conflicts(local: SyncSnapshot, others: [(machine: String, entries: SyncSnapshot)], since: Double, merged: SyncSnapshot, now: Double) -> [SyncConflict] {
        var out: [SyncConflict] = []
        for o in others {
            for (k, theirs) in o.entries {
                guard let mine = local[k], mine.t > since, theirs.t > since, mine.m != theirs.m else { continue }
                if mine.d == theirs.d && same(mine.v, theirs.v) { continue }
                let winner = merged[k] ?? mine
                let loser = compare(winner, mine) == 0 ? theirs : mine
                out.append(SyncConflict(key: k, label: describe(k, winner.d ? loser.v : winner.v), at: now,
                                        winner: (winner.m, winner.t, winner.d), loser: (loser.m, loser.t, loser.d)))
            }
        }
        return out.sorted { $0.key.utf16.lexicographicallyPrecedes($1.key.utf16) }
    }

    public static func describe(_ key: String, _ v: JSONValue) -> String {
        let (kind, id) = split(key)
        let name = v["name"]?.stringValue ?? id
        switch kind {
        case "settings": return "Setting: \(id)"
        case "feature": return "\(id.prefix(1).uppercased())\(id.dropFirst()) settings"
        case "workflow": return "Workflow “\(name)”"
        case "quicklink": return "Quicklink “\(name)”"
        case "snippet": return "Snippet “\(name)”"
        case "favorite": return "Favorite \(id)"
        case "alias": return "Alias “\(v.stringValue ?? "")” for \(id)"
        case "hotkey": return "Hotkey \(v.stringValue ?? "") for \(id)"
        default: return key
        }
    }

    /// What applying `target` would do to `current`.
    public static func preview(_ current: UserData, _ target: [String: JSONValue]) -> ChangePreview {
        let base = json(current)
        let before = flatten(json: base)
        let after = flatten(json: unflatten(json: base, target))
        var out = ChangePreview()
        for k in after.keys.sorted() {
            if before[k] == nil { out.added.append((k, describe(k, after[k]!))) }
            else if !same(before[k]!, after[k]!) { out.changed.append((k, describe(k, after[k]!))) }
        }
        for k in before.keys.sorted() where after[k] == nil { out.removed.append((k, describe(k, before[k]!))) }
        return out
    }

    public static func parseFile(_ raw: JSONValue) -> SyncFile? {
        guard raw["app"]?.stringValue == "glide", let version = raw["version"]?.intValue, version <= formatVersion,
              let machine = raw["machine"]?.stringValue, let entries = raw["entries"]?.objectValue else { return nil }
        var snap: SyncSnapshot = [:]
        for (k, e) in entries where k.contains(".") { if let entry = SyncEntry(json: e) { snap[k] = entry } }
        return SyncFile(machine: machine, version: version, exportedAt: raw["exportedAt"]?.doubleValue ?? 0, entries: snap)
    }

    public static func fileJSON(machine: String, exportedAt: Double, entries: SyncSnapshot) -> JSONValue {
        ["app": "glide", "version": .int(Int64(formatVersion)), "machine": .string(machine), "exportedAt": .double(exportedAt),
         "entries": .object(entries.mapValues(\.json))]
    }

    /// File-name-safe machine name.
    public static func machineSlug(_ name: String) -> String {
        var s = name.replacingOccurrences(of: #"\.local$"#, with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: #"[^A-Za-z0-9 _-]+"#, with: "-", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^[\s-]+|[\s-]+$"#, with: "", options: .regularExpression)
        let out = String(s.prefix(60))
        return out.isEmpty ? "Mac" : out
    }
}
