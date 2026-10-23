import Foundation
import GlideCore
import SQLite3

/// Browser bookmarks & history readers (port of src/main/features/browser/{browsers,data,sqlite}.ts).
/// Paths are relative to a home directory so tests pass a fixture home; databases are copied to a private
/// temp dir (with -wal/-journal) before they are opened, so the live files are never locked or modified.
public struct BrowserDef: Hashable, Sendable {
    public enum Engine: String, Sendable { case chromium, firefox, safari }
    public var id: String
    public var name: String
    public var bundleId: String
    public var engine: Engine
    public var root: String
    public var app: String
    public var profileArg = false
    public var rootIsProfile = false

    static let appSupport = "Library/Application Support"
    public static let all: [BrowserDef] = [
        .init(id: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", engine: .chromium, root: "\(appSupport)/Google/Chrome", app: "Google Chrome.app", profileArg: true),
        .init(id: "arc", name: "Arc", bundleId: "company.thebrowser.Browser", engine: .chromium, root: "\(appSupport)/Arc/User Data", app: "Arc.app"),
        .init(id: "brave", name: "Brave", bundleId: "com.brave.Browser", engine: .chromium, root: "\(appSupport)/BraveSoftware/Brave-Browser", app: "Brave Browser.app", profileArg: true),
        .init(id: "edge", name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", engine: .chromium, root: "\(appSupport)/Microsoft Edge", app: "Microsoft Edge.app", profileArg: true),
        .init(id: "vivaldi", name: "Vivaldi", bundleId: "com.vivaldi.Vivaldi", engine: .chromium, root: "\(appSupport)/Vivaldi", app: "Vivaldi.app", profileArg: true),
        .init(id: "chromium", name: "Chromium", bundleId: "org.chromium.Chromium", engine: .chromium, root: "\(appSupport)/Chromium", app: "Chromium.app", profileArg: true),
        .init(id: "dia", name: "Dia", bundleId: "company.thebrowser.dia", engine: .chromium, root: "\(appSupport)/Dia/User Data", app: "Dia.app"),
        .init(id: "opera", name: "Opera", bundleId: "com.operasoftware.Opera", engine: .chromium, root: "\(appSupport)/com.operasoftware.Opera", app: "Opera.app", rootIsProfile: true),
        .init(id: "firefox", name: "Firefox", bundleId: "org.mozilla.firefox", engine: .firefox, root: "\(appSupport)/Firefox", app: "Firefox.app"),
        .init(id: "zen", name: "Zen", bundleId: "app.zen-browser.zen", engine: .firefox, root: "\(appSupport)/zen", app: "Zen.app"),
        .init(id: "safari", name: "Safari", bundleId: "com.apple.Safari", engine: .safari, root: "Library/Safari", app: "Safari.app"),
    ]
}

public struct BrowserProfile: Hashable, Sendable {
    /// "<browserId>:<dir>" — the settings key.
    public var key: String
    public var browser: BrowserDef
    public var dir: String
    public var name: String
    public var absDir: String
    public var bookmarksFile: String?
    public var historyFile: String?
}

public struct BrowserEntry: Hashable, Codable, Sendable {
    /// "bookmark" | "history"
    public var type: String
    public var title: String
    public var url: String
    public var folder: String?
    public var visitCount: Int?
    /// unix ms
    public var lastVisit: Double?
}

public enum BrowserData {
    static var fm: FileManager { .default }
    static func exists(_ p: String) -> Bool { fm.fileExists(atPath: p) }
    static func join(_ a: String, _ b: String) -> String { b.isEmpty ? a : (a as NSString).appendingPathComponent(b) }

    static func readJSON(_ p: String) -> JSONValue? { N7JSON.read(URL(fileURLWithPath: p)) }

    /// profile.info_cache names from Chromium's "Local State".
    public static func chromiumProfileNames(_ localState: JSONValue?) -> [String: String] {
        var out: [String: String] = [:]
        for (dir, info) in localState?["profile"]?["info_cache"]?.objectValue ?? [:] { if let n = info["name"]?.stringValue, !n.isEmpty { out[dir] = n } }
        return out
    }

    /// Firefox profiles.ini → [(name, absolute path)].
    public static func parseProfilesIni(_ ini: String, root: String) -> [(name: String, path: String)] {
        var out: [(String, String)] = []
        var cur: [String: String]?
        func flush() {
            if let c = cur, let p = c["Path"] { out.append((c["Name"] ?? (p as NSString).lastPathComponent, c["IsRelative"] == "0" ? p : join(root, p))) }
        }
        for raw in ini.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("[") {
                flush()
                cur = line.range(of: #"^\[Profile\d+\]$"#, options: [.regularExpression, .caseInsensitive]) != nil ? [:] : nil
                continue
            }
            if cur != nil, let eq = line.firstIndex(of: "="), eq != line.startIndex { cur?[String(line[..<eq])] = String(line[line.index(after: eq)...]) }
        }
        flush()
        return out
    }

    static func sortedDir(_ dir: String) -> [String] {
        ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    static func chromiumProfiles(_ b: BrowserDef, root: String) -> [BrowserProfile] {
        let names = chromiumProfileNames(readJSON(join(root, "Local State")))
        let dirs = b.rootIsProfile ? [""] : sortedDir(root).filter { $0 == "Default" || $0.range(of: #"^Profile \d+$"#, options: .regularExpression) != nil || names[$0] != nil }
        return dirs.compactMap { dir in
            let abs = join(root, dir)
            let bm = join(abs, "Bookmarks"), hist = join(abs, "History")
            guard exists(bm) || exists(hist) else { return nil }
            let d = dir.isEmpty ? "Default" : dir
            return BrowserProfile(key: "\(b.id):\(d)", browser: b, dir: d, name: names[dir] ?? d, absDir: abs, bookmarksFile: exists(bm) ? bm : nil, historyFile: exists(hist) ? hist : nil)
        }
    }

    static func firefoxProfiles(_ b: BrowserDef, root: String) -> [BrowserProfile] {
        var entries: [(name: String, path: String)]
        if let ini = try? String(contentsOfFile: join(root, "profiles.ini"), encoding: .utf8) {
            entries = parseProfilesIni(ini, root: root)
        } else {
            entries = sortedDir(join(root, "Profiles")).map { ($0, join(join(root, "Profiles"), $0)) }
        }
        return entries.compactMap { e in
            let places = join(e.path, "places.sqlite")
            guard exists(places) else { return nil }
            let dir = (e.path as NSString).lastPathComponent
            return BrowserProfile(key: "\(b.id):\(dir)", browser: b, dir: dir, name: e.name, absDir: e.path, bookmarksFile: places, historyFile: places)
        }
    }

    static func safariProfiles(_ b: BrowserDef, root: String) -> [BrowserProfile] {
        guard exists(root) else { return [] }
        return [BrowserProfile(key: "\(b.id):Safari", browser: b, dir: "Safari", name: "Safari", absDir: root, bookmarksFile: join(root, "Bookmarks.plist"), historyFile: join(root, "History.db"))]
    }

    public static func discoverProfiles(home: String, browsers: [BrowserDef] = BrowserDef.all) -> [BrowserProfile] {
        browsers.flatMap { b -> [BrowserProfile] in
            let root = join(home, b.root)
            switch b.engine {
            case .chromium: return chromiumProfiles(b, root: root)
            case .firefox: return firefoxProfiles(b, root: root)
            case .safari: return safariProfiles(b, root: root)
            }
        }
    }

    /// Safari data is TCC-protected (Full Disk Access). A plain open never prompts.
    public static func safariAccess(home: String) -> String {
        let f = join(home, "Library/Safari/Bookmarks.plist")
        let fd = open(f, O_RDONLY)
        if fd >= 0 {
            close(fd)
            return "ok"
        }
        return errno == ENOENT ? "missing" : "denied"
    }

    public static func findApp(home: String, _ b: BrowserDef) -> String? {
        var c = ["/Applications/\(b.app)", join(home, "Applications/\(b.app)")]
        if b.id == "safari" { c.insert(contentsOf: ["/Applications/Safari.app", "/System/Cryptexes/App/System/Applications/Safari.app"], at: 0) }
        return c.first(where: exists)
    }

    // MARK: parsing

    static let webkitEpochOffsetMs = 11_644_473_600_000.0
    static let cocoaEpochOffsetS = 978_307_200.0
    public static func webkitToMs(_ us: Double) -> Double { us > 0 ? us / 1000 - webkitEpochOffsetMs : 0 }
    public static func msToWebkit(_ ms: Double) -> Int64 { Int64(((ms + webkitEpochOffsetMs) * 1000).rounded()) }
    public static func cocoaToMs(_ s: Double) -> Double { (s + cocoaEpochOffsetS) * 1000 }
    public static func msToCocoa(_ ms: Double) -> Double { ms / 1000 - cocoaEpochOffsetS }

    static func openable(_ url: String) -> Bool {
        url.range(of: "^(https?|file|ftp|chrome|about|edge|brave|arc|vivaldi):", options: [.regularExpression, .caseInsensitive]) != nil && !url.lowercased().hasPrefix("javascript:")
    }

    static let rootLabel = ["bookmark_bar": "Bookmarks Bar", "other": "Other Bookmarks", "synced": "Mobile Bookmarks"]

    /// Chromium "Bookmarks" JSON.
    public static func parseChromiumBookmarks(_ data: Data) -> [BrowserEntry] {
        guard let doc = try? JSONDecoder().decode(JSONValue.self, from: data), let roots = doc["roots"]?.objectValue else { return [] }
        var out: [BrowserEntry] = []
        func walk(_ n: JSONValue, _ folder: [String]) {
            if n["type"]?.stringValue == "url", let url = n["url"]?.stringValue, openable(url) {
                let name = (n["name"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces)
                out.append(BrowserEntry(type: "bookmark", title: name.isEmpty ? url : name, url: url, folder: folder.isEmpty ? nil : folder.joined(separator: " / ")))
            } else if let kids = n["children"]?.arrayValue {
                let next = n["type"]?.stringValue == "folder" && !(n["name"]?.stringValue ?? "").isEmpty ? folder + [n["name"]?.stringValue ?? ""] : folder
                for c in kids { walk(c, next) }
            }
        }
        // Keep the Electron order (bookmark_bar, other, synced, then others).
        let order = ["bookmark_bar", "other", "synced"]
        let keys = order.filter { roots[$0] != nil } + roots.keys.filter { !order.contains($0) }.sorted()
        for key in keys {
            guard let node = roots[key], let kids = node["children"]?.arrayValue else { continue }
            let label = rootLabel[key] ?? node["name"]?.stringValue ?? key
            for c in kids { walk(c, [label]) }
        }
        return out
    }

    /// Safari Bookmarks.plist (binary or XML). Reading List items are kept under "Reading List".
    public static func parseSafariBookmarks(_ data: Data) -> [BrowserEntry] {
        guard let root = try? PropertyListSerialization.propertyList(from: data, format: nil) else { return [] }
        var out: [BrowserEntry] = []
        func walk(_ n: Any, _ folder: [String]) {
            guard let d = n as? [String: Any] else { return }
            let type = d["WebBookmarkType"] as? String
            if type == "WebBookmarkTypeLeaf" {
                guard let url = d["URLString"] as? String, !url.isEmpty, openable(url) else { return }
                let t = ((d["URIDictionary"] as? [String: Any])?["title"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
                out.append(BrowserEntry(type: "bookmark", title: t.isEmpty ? url : t, url: url, folder: folder.isEmpty ? nil : folder.joined(separator: " / ")))
            } else if type == "WebBookmarkTypeList", let kids = d["Children"] as? [Any] {
                let raw = d["Title"] as? String ?? ""
                let name = raw == "com.apple.ReadingList" ? "Reading List" : raw == "BookmarksBar" ? "Favourites" : raw == "BookmarksMenu" ? "Bookmarks Menu" : raw
                for c in kids { walk(c, name.isEmpty ? folder : folder + [name]) }
            }
        }
        walk(root, [])
        return out
    }

    /// History SQL per engine (columns url, title, visits, last in native epoch units). Values are validated ints.
    public static func historyQuery(_ engine: BrowserDef.Engine, limit: Int, sinceMs: Double) -> String {
        let lim = min(100_000, max(1, limit))
        switch engine {
        case .chromium:
            let w = sinceMs > 0 ? " AND last_visit_time >= \(msToWebkit(sinceMs))" : ""
            return "SELECT url, title, visit_count AS visits, last_visit_time AS last FROM urls WHERE hidden = 0\(w) ORDER BY last_visit_time DESC LIMIT \(lim)"
        case .firefox:
            let w = sinceMs > 0 ? " AND last_visit_date >= \(Int64((sinceMs * 1000).rounded()))" : ""
            return "SELECT url, title, visit_count AS visits, last_visit_date AS last FROM moz_places WHERE last_visit_date IS NOT NULL AND hidden = 0\(w) ORDER BY last_visit_date DESC LIMIT \(lim)"
        case .safari:
            let h = sinceMs > 0 ? " HAVING last >= \(Int64(msToCocoa(sinceMs).rounded(.down)))" : ""
            return "SELECT i.url AS url, (SELECT v2.title FROM history_visits v2 WHERE v2.history_item = i.id AND v2.title IS NOT NULL ORDER BY v2.visit_time DESC LIMIT 1) AS title, i.visit_count AS visits, MAX(v.visit_time) AS last FROM history_items i JOIN history_visits v ON v.history_item = i.id GROUP BY i.id\(h) ORDER BY last DESC LIMIT \(lim)"
        }
    }

    public static let firefoxBookmarksSQL = "SELECT p.url AS url, b.title AS title, parent.title AS folder FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id LEFT JOIN moz_bookmarks parent ON b.parent = parent.id WHERE b.type = 1 AND p.url NOT LIKE 'place:%'"
    static let firefoxRootFolders = ["toolbar": "Bookmarks Toolbar", "menu": "Bookmarks Menu", "unfiled": "Other Bookmarks", "mobile": "Mobile Bookmarks"]

    public static func historyEntries(_ engine: BrowserDef.Engine, rows: [[String: SQLValue]]) -> [BrowserEntry] {
        rows.compactMap { r in
            let url = r["url"]?.string ?? ""
            guard !url.isEmpty, openable(url) else { return nil }
            let last = r["last"]?.double ?? 0
            let ms = engine == .chromium ? webkitToMs(last) : engine == .firefox ? last / 1000 : cocoaToMs(last)
            let t = (r["title"]?.string ?? "").trimmingCharacters(in: .whitespaces)
            return BrowserEntry(type: "history", title: t.isEmpty ? url : t, url: url, visitCount: Int(r["visits"]?.double ?? 0), lastVisit: ms.rounded())
        }
    }

    public static func firefoxBookmarks(_ rows: [[String: SQLValue]]) -> [BrowserEntry] {
        rows.compactMap { r in
            let url = r["url"]?.string ?? ""
            guard !url.isEmpty, openable(url) else { return nil }
            let f = r["folder"]?.string ?? ""
            let folder = firefoxRootFolders[f] ?? f
            let t = (r["title"]?.string ?? "").trimmingCharacters(in: .whitespaces)
            return BrowserEntry(type: "bookmark", title: t.isEmpty ? url : t, url: url, folder: folder.isEmpty ? nil : folder)
        }
    }

    public static func host(_ url: String) -> String {
        (URL(string: url)?.host ?? "").lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
    }
}

// MARK: - SQLite (C API) on a private copy

public enum SQLValue: Hashable, Sendable {
    case int(Int64), double(Double), text(String), null
    var string: String? { if case let .text(s) = self { return s }; return nil }
    var double: Double? {
        switch self {
        case let .int(i): return Double(i)
        case let .double(d): return d
        case let .text(s): return Double(s)
        case .null: return nil
        }
    }
}

public enum BrowserSQLite {
    public enum Failure: Error, LocalizedError {
        case open(String), query(String)
        public var errorDescription: String? {
            switch self {
            case let .open(m): return "Could not open database: \(m)"
            case let .query(m): return "Query failed: \(m)"
            }
        }
    }

    /// Copies `file` (+ -wal/-journal) into a fresh 0700 temp dir, runs the queries, deletes the copy.
    public static func queryCopy(_ file: String, _ sqls: [String], tempRoot: URL = FileManager.default.temporaryDirectory) throws -> [[[String: SQLValue]]] {
        let fm = FileManager.default
        let dir = tempRoot.appendingPathComponent("glide-browser-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: dir) }
        let copy = dir.appendingPathComponent("db.sqlite")
        try fm.copyItem(atPath: file, toPath: copy.path)
        for ext in ["-wal", "-journal"] where fm.fileExists(atPath: file + ext) { try? fm.copyItem(atPath: file + ext, toPath: copy.path + ext) }
        var db: OpaquePointer?
        // Read-write open: the copy may carry a hot journal / WAL that must be replayed.
        guard sqlite3_open_v2(copy.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let db else {
            let m = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            sqlite3_close(db)
            throw Failure.open(m)
        }
        defer { sqlite3_close(db) }
        return try sqls.map { try query(db, $0) }
    }

    static func query(_ db: OpaquePointer, _ sql: String) throws -> [[String: SQLValue]] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw Failure.query(String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(stmt) }
        var rows: [[String: SQLValue]] = []
        let n = sqlite3_column_count(stmt)
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw Failure.query(String(cString: sqlite3_errmsg(db))) }
            var row: [String: SQLValue] = [:]
            for i in 0..<n {
                let name = String(cString: sqlite3_column_name(stmt, i))
                switch sqlite3_column_type(stmt, i) {
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(stmt, i))
                case SQLITE_FLOAT: row[name] = .double(sqlite3_column_double(stmt, i))
                case SQLITE_TEXT: row[name] = sqlite3_column_text(stmt, i).map { .text(String(cString: $0)) } ?? .null
                default: row[name] = .null
                }
            }
            rows.append(row)
        }
        return rows
    }
}

// MARK: - search (search.ts)

public struct IndexedEntry: Hashable, Sendable {
    public var entry: BrowserEntry
    public var profile: String
    public var browser: String
    public var host: String
    var t: String
    var u: String
}

public enum BrowserSearch {
    public static func strip(_ url: String) -> String { url.lowercased().replacingOccurrences(of: "^[a-z]+://(www\\.)?", with: "", options: .regularExpression) }

    public static func index(_ entries: [BrowserEntry], profile: String, browser: String) -> [IndexedEntry] {
        entries.map { IndexedEntry(entry: $0, profile: profile, browser: browser, host: BrowserData.host($0.url), t: $0.title.lowercased(), u: strip($0.url)) }
    }

    /// Same URL twice shows once: first bookmark wins; history keeps the newest visit and sums the counts.
    public static func dedupe(_ list: [IndexedEntry]) -> [IndexedEntry] {
        var order: [String] = []
        var by: [String: IndexedEntry] = [:]
        for e in list {
            var u = e.u
            if u.hasSuffix("/") { u.removeLast() }
            let key = "\(e.entry.type)|\(u)"
            guard let cur = by[key] else {
                by[key] = e
                order.append(key)
                continue
            }
            if e.entry.type == "history" {
                var newer = (e.entry.lastVisit ?? 0) > (cur.entry.lastVisit ?? 0) ? e : cur
                newer.entry.visitCount = (cur.entry.visitCount ?? 0) + (e.entry.visitCount ?? 0)
                by[key] = newer
            }
        }
        return order.compactMap { by[$0] }
    }

    static func wordStart(_ hay: String, _ needle: String) -> Bool {
        var from = hay.startIndex
        while let r = hay.range(of: needle, range: from..<hay.endIndex) {
            if r.lowerBound == hay.startIndex { return true }
            let prev = hay[hay.index(before: r.lowerBound)]
            if !(prev.isASCII && (prev.isLetter || prev.isNumber)) { return true }
            from = hay.index(after: r.lowerBound)
        }
        return false
    }

    static func offset(_ hay: String, _ needle: String) -> Int? { hay.range(of: needle).map { hay.distance(from: hay.startIndex, to: $0.lowerBound) } }

    public static func score(_ e: IndexedEntry, _ tokens: [String], now: Double) -> Double {
        guard !tokens.isEmpty else { return 0 }
        var s = 0.0
        for tok in tokens {
            let inTitle = offset(e.t, tok), inUrl = offset(e.u, tok)
            if inTitle == nil && inUrl == nil { return 0 }
            if inTitle == 0 { s += 40 } else if inTitle != nil && wordStart(e.t, tok) { s += 28 } else if inTitle != nil { s += 14 }
            if e.host.hasPrefix(tok) { s += 30 } else if let iu = inUrl, iu < e.host.count { s += 18 } else if inUrl != nil { s += 6 }
        }
        if e.entry.type == "bookmark" { s += 15 }
        if let v = e.entry.visitCount, v > 0 { s += min(25, log2(1 + Double(v)) * 3) }
        if let lv = e.entry.lastVisit, lv > 0 {
            let days = (now - lv) / 86_400_000
            s += days < 1 ? 12 : days < 7 ? 8 : days < 30 ? 4 : 0
        }
        if tokens.count == 1 && e.t == tokens[0] { s += 30 }
        return s
    }

    public static func tokenize(_ q: String) -> [String] { q.lowercased().split(whereSeparator: \.isWhitespace).map(String.init) }

    public static func search(_ list: [IndexedEntry], _ query: String, limit: Int, type: String? = nil, now: Double = Date().timeIntervalSince1970 * 1000) -> [(IndexedEntry, Double)] {
        let tokens = tokenize(query)
        if tokens.isEmpty {
            let pool = type.map { t in list.filter { $0.entry.type == t } } ?? list
            let sorted = type == "history" ? pool.sorted { ($0.entry.lastVisit ?? 0) > ($1.entry.lastVisit ?? 0) } : pool
            return sorted.prefix(limit).map { ($0, 0) }
        }
        var out: [(IndexedEntry, Double)] = []
        for e in list where type == nil || e.entry.type == type {
            let s = score(e, tokens, now: now)
            if s > 0 { out.append((e, s)) }
        }
        out.sort { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.t.count < $1.0.t.count }
        return Array(out.prefix(limit))
    }

    /// "history foo" / "hist foo" in the root search.
    public static func historyPrefix(_ q: String) -> String? {
        guard let r = q.range(of: #"^\s*(?:history|hist)\s+"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
        return q[r.upperBound...].trimmingCharacters(in: .whitespaces)
    }
}
