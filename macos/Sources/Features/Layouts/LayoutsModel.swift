import Foundation
import GlideCore

// Saved window layouts and workspaces (port of src/main/features/layouts/{model,match}.ts): types, defensive
// (de)serialisation of <userData>/features/layouts/layouts.json (same shape as the Electron app) and the pure
// restore planner that pairs saved windows with live ones and maps frames across display changes.

public struct SavedDisplay: Hashable, Sendable {
    public var id: Int
    public var uuid: String?
    public var name: String
    public var frame: Rect
    public var visible: Rect
    public var main: Bool
    public init(id: Int, uuid: String?, name: String, frame: Rect, visible: Rect, main: Bool) {
        self.id = id
        self.uuid = uuid
        self.name = name
        self.frame = frame
        self.visible = visible
        self.main = main
    }
}

public struct SavedWindow: Hashable, Sendable {
    public var bundleId: String
    public var appName: String
    public var appPath: String?
    public var title: String
    /// AX coordinates at save time.
    public var frame: Rect
    /// Index into Layout.displays.
    public var display: Int
    /// Position among this app's windows (front to back) at save time.
    public var order: Int
    public init(bundleId: String, appName: String, appPath: String?, title: String, frame: Rect, display: Int, order: Int) {
        self.bundleId = bundleId
        self.appName = appName
        self.appPath = appPath
        self.title = title
        self.frame = frame
        self.display = display
        self.order = order
    }
}

public struct WindowLayout: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var createdAt: Double
    public var updatedAt: Double
    public var displays: [SavedDisplay]
    public var windows: [SavedWindow]
}

public struct AppRef: Hashable, Sendable {
    public var name: String
    public var bundleId: String
    public var path: String?
    public init(name: String, bundleId: String, path: String?) {
        self.name = name
        self.bundleId = bundleId
        self.path = path
    }
}

public struct Workspace: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var layoutId: String?
    public var relaunchLayoutApps: Bool
    public var launchApps: [AppRef]
    /// Asked to quit only after the user confirms.
    public var quitApps: [AppRef]
    public var urls: [String]
    public var focus: Focus?
    /// macOS Shortcut to run (e.g. one that turns on a Focus mode).
    public var shortcut: String?
    public var noteId: String?
    public var createdAt: Double
    public var updatedAt: Double

    public struct Focus: Hashable, Sendable {
        public var goal: String
        public var minutes: Int
    }

    public static func blank(id: String, now: Double) -> Workspace {
        Workspace(id: id, name: "", layoutId: nil, relaunchLayoutApps: false, launchApps: [], quitApps: [], urls: [], focus: nil, shortcut: nil, noteId: nil, createdAt: now, updatedAt: now)
    }
}

public struct LayoutsFile: Hashable, Sendable {
    public var layouts: [WindowLayout] = []
    public var workspaces: [Workspace] = []
    public init(layouts: [WindowLayout] = [], workspaces: [Workspace] = []) {
        self.layouts = layouts
        self.workspaces = workspaces
    }
}

/// A live window as LayoutService.capture reports it.
public struct LiveWindow: Hashable, Sendable {
    public var ref: Int
    public var bundleId: String?
    public var appName: String
    public var appPath: String?
    public var title: String
    public var frame: Rect
    public var display: Int
    public var order: Int
    public var fullScreen: Bool
    public init(ref: Int, bundleId: String?, appName: String, appPath: String?, title: String, frame: Rect, display: Int, order: Int, fullScreen: Bool = false) {
        self.ref = ref
        self.bundleId = bundleId
        self.appName = appName
        self.appPath = appPath
        self.title = title
        self.frame = frame
        self.display = display
        self.order = order
        self.fullScreen = fullScreen
    }
}

// MARK: - parsing

public enum LayoutsCodec {
    static func str(_ v: JSONValue?, _ fallback: String = "") -> String { v?.stringValue ?? fallback }
    static func num(_ v: JSONValue?, _ fallback: Double = 0) -> Double {
        guard let d = v?.doubleValue, d.isFinite else { return fallback }
        return d
    }
    static func strOrNil(_ v: JSONValue?) -> String? {
        guard let s = v?.stringValue, !s.isEmpty else { return nil }
        return s
    }

    public static func rect(_ v: JSONValue?) -> Rect? {
        guard let v, v.objectValue != nil else { return nil }
        let r = Rect(x: num(v["x"], .nan), y: num(v["y"], .nan), width: num(v["width"], .nan), height: num(v["height"], .nan))
        guard [r.x, r.y, r.width, r.height].allSatisfy(\.isFinite), r.width > 0, r.height > 0 else { return nil }
        return r
    }

    public static func display(_ v: JSONValue) -> SavedDisplay? {
        guard v.objectValue != nil, let frame = rect(v["frame"]) else { return nil }
        return SavedDisplay(id: Int(num(v["id"])), uuid: strOrNil(v["uuid"]), name: str(v["name"], "Display"), frame: frame,
                            visible: rect(v["visible"]) ?? frame, main: v["main"]?.boolValue == true)
    }

    public static func window(_ v: JSONValue) -> SavedWindow? {
        guard v.objectValue != nil, let frame = rect(v["frame"]) else { return nil }
        let bundleId = str(v["bundleId"])
        guard !bundleId.isEmpty else { return nil }
        return SavedWindow(bundleId: bundleId, appName: str(v["appName"], bundleId), appPath: strOrNil(v["appPath"]), title: str(v["title"]), frame: frame,
                           display: max(0, Int(num(v["display"]).rounded())), order: max(0, Int(num(v["order"]).rounded())))
    }

    public static func layout(_ v: JSONValue) -> WindowLayout? {
        let id = str(v["id"]), name = str(v["name"]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard v.objectValue != nil, !id.isEmpty, !name.isEmpty else { return nil }
        let displays = (v["displays"]?.arrayValue ?? []).compactMap(display)
        let windows = (v["windows"]?.arrayValue ?? []).compactMap(window).map { w -> SavedWindow in
            var w = w
            if w.display >= displays.count { w.display = 0 }
            return w
        }
        let created = num(v["createdAt"])
        return WindowLayout(id: id, name: name, createdAt: created, updatedAt: num(v["updatedAt"], created), displays: displays, windows: windows)
    }

    public static func appRef(_ v: JSONValue) -> AppRef? {
        let bid = str(v["bundleId"])
        guard v.objectValue != nil, !bid.isEmpty else { return nil }
        return AppRef(name: str(v["name"], bid), bundleId: bid, path: strOrNil(v["path"]))
    }

    static func appRefs(_ v: JSONValue?) -> [AppRef] {
        var seen = Set<String>()
        return (v?.arrayValue ?? []).compactMap(appRef).filter { seen.insert($0.bundleId).inserted }
    }

    /// "github.com" → "https://github.com"; schemes and paths are kept; anything else is dropped.
    public static func normalizeURL(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if s.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*:"#, options: .regularExpression) != nil { return s }
        if s.hasPrefix("/") || s.hasPrefix("~/") { return s }
        if s.range(of: #"^[\w-]+(\.[\w-]+)+(:\d+)?(/.*)?$"#, options: .regularExpression) != nil { return "https://\(s)" }
        return nil
    }

    public static func workspace(_ v: JSONValue) -> Workspace? {
        let id = str(v["id"]), name = str(v["name"]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard v.objectValue != nil, !id.isEmpty, !name.isEmpty else { return nil }
        var focus: Workspace.Focus?
        if let f = v["focus"], f.objectValue != nil, num(f["minutes"]) > 0 { focus = .init(goal: str(f["goal"]), minutes: Int(num(f["minutes"]).rounded())) }
        let created = num(v["createdAt"])
        let shortcut = v["shortcut"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Workspace(id: id, name: name, layoutId: strOrNil(v["layoutId"]), relaunchLayoutApps: v["relaunchLayoutApps"]?.boolValue == true,
                         launchApps: appRefs(v["launchApps"]), quitApps: appRefs(v["quitApps"]),
                         urls: (v["urls"]?.arrayValue ?? []).compactMap { normalizeURL(str($0)) }, focus: focus,
                         shortcut: (shortcut?.isEmpty ?? true) ? nil : shortcut, noteId: strOrNil(v["noteId"]), createdAt: created, updatedAt: num(v["updatedAt"], created))
    }

    public static func parse(_ data: Data) -> LayoutsFile {
        guard let json = try? JSONDecoder().decode(JSONValue.self, from: data), json.objectValue != nil else { return LayoutsFile() }
        let layouts = (json["layouts"]?.arrayValue ?? []).compactMap(layout)
        let ids = Set(layouts.map(\.id))
        let workspaces = (json["workspaces"]?.arrayValue ?? []).compactMap(workspace).map { w -> Workspace in
            var w = w
            if let l = w.layoutId, !ids.contains(l) { w.layoutId = nil }
            return w
        }
        return LayoutsFile(layouts: layouts, workspaces: workspaces)
    }

    // MARK: encoding (same keys as the Electron app)

    static func json(_ r: Rect) -> JSONValue { ["x": .double(r.x), "y": .double(r.y), "width": .double(r.width), "height": .double(r.height)] }
    static func opt(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }

    public static func json(_ d: SavedDisplay) -> JSONValue {
        ["id": .int(Int64(d.id)), "uuid": opt(d.uuid), "name": .string(d.name), "frame": json(d.frame), "visible": json(d.visible), "main": .bool(d.main)]
    }
    public static func json(_ w: SavedWindow) -> JSONValue {
        ["bundleId": .string(w.bundleId), "appName": .string(w.appName), "appPath": opt(w.appPath), "title": .string(w.title), "frame": json(w.frame),
         "display": .int(Int64(w.display)), "order": .int(Int64(w.order))]
    }
    public static func json(_ l: WindowLayout) -> JSONValue {
        ["id": .string(l.id), "name": .string(l.name), "createdAt": .double(l.createdAt), "updatedAt": .double(l.updatedAt),
         "displays": .array(l.displays.map(json)), "windows": .array(l.windows.map(json))]
    }
    public static func json(_ a: AppRef) -> JSONValue { ["name": .string(a.name), "bundleId": .string(a.bundleId), "path": opt(a.path)] }
    public static func json(_ w: Workspace) -> JSONValue {
        ["id": .string(w.id), "name": .string(w.name), "layoutId": opt(w.layoutId), "relaunchLayoutApps": .bool(w.relaunchLayoutApps),
         "launchApps": .array(w.launchApps.map(json)), "quitApps": .array(w.quitApps.map(json)), "urls": .array(w.urls.map(JSONValue.string)),
         "focus": w.focus.map { ["goal": .string($0.goal), "minutes": .int(Int64($0.minutes))] } ?? .null,
         "shortcut": opt(w.shortcut), "noteId": opt(w.noteId), "createdAt": .double(w.createdAt), "updatedAt": .double(w.updatedAt)]
    }
    public static func json(_ f: LayoutsFile) -> JSONValue {
        ["version": 1, "layouts": .array(f.layouts.map(json)), "workspaces": .array(f.workspaces.map(json))]
    }
    public static func encode(_ f: LayoutsFile) -> Data { (try? JSONEncoder.glide.encode(json(f))) ?? Data("{}".utf8) }

    // MARK: live data from LayoutService

    public static func liveWindows(_ capture: JSONValue) -> [LiveWindow] {
        (capture["windows"]?.arrayValue ?? []).compactMap { v in
            guard let ref = v["ref"]?.intValue, let frame = rect(v["frame"]) else { return nil }
            return LiveWindow(ref: ref, bundleId: strOrNil(v["bundleId"]), appName: str(v["appName"], "Unknown"), appPath: strOrNil(v["appPath"]),
                              title: str(v["title"]), frame: frame, display: v["display"]?.intValue ?? 0, order: v["order"]?.intValue ?? 0,
                              fullScreen: v["fullScreen"]?.boolValue == true)
        }
    }
    public static func displays(_ v: JSONValue?) -> [SavedDisplay] { (v?.arrayValue ?? []).compactMap(display) }
}

// MARK: - pure helpers

public enum LayoutsLogic {
    public static func newId(_ prefix: String, now: Double) -> String {
        let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        let rand = String((0..<6).map { _ in chars.randomElement() ?? "x" })
        return "\(prefix)-\(String(Int64(now), radix: 36))-\(rand)"
    }

    public static func layoutFromCapture(name: String, displays: [SavedDisplay], windows: [LiveWindow], now: Double, id: String? = nil) -> WindowLayout {
        let saved = windows.compactMap { w -> SavedWindow? in
            guard let b = w.bundleId, !w.fullScreen else { return nil }
            return SavedWindow(bundleId: b, appName: w.appName, appPath: w.appPath, title: w.title, frame: w.frame, display: w.display, order: w.order)
        }
        return WindowLayout(id: id ?? newId("layout", now: now), name: name.trimmingCharacters(in: .whitespacesAndNewlines), createdAt: now, updatedAt: now, displays: displays, windows: saved)
    }

    /// Distinct apps of a layout, in first-seen order.
    public static func apps(_ l: WindowLayout) -> [AppRef] {
        var seen = Set<String>()
        return l.windows.compactMap { w in seen.insert(w.bundleId).inserted ? AppRef(name: w.appName, bundleId: w.bundleId, path: w.appPath) : nil }
    }

    public static func describe(_ l: WindowLayout) -> String {
        let apps = apps(l).count, n = l.windows.count, d = l.displays.count
        return "\(n) window\(n == 1 ? "" : "s") · \(apps) app\(apps == 1 ? "" : "s")\(d > 1 ? " · \(d) displays" : "")"
    }

    public static func workspaceSubtitle(_ ws: Workspace, layouts: [WindowLayout]) -> String {
        var bits: [String] = []
        if let lid = ws.layoutId, let l = layouts.first(where: { $0.id == lid }) { bits.append("Layout “\(l.name)”") }
        if !ws.launchApps.isEmpty { bits.append("\(ws.launchApps.count) to open") }
        if !ws.quitApps.isEmpty { bits.append("\(ws.quitApps.count) to quit") }
        if !ws.urls.isEmpty { bits.append("\(ws.urls.count) links") }
        if let f = ws.focus { bits.append("Focus \(f.minutes) min") }
        return bits.isEmpty ? "Workspace" : bits.joined(separator: " · ")
    }

    // MARK: matching

    public enum MatchHow: String, Sendable { case title, similar, order }

    public struct PlannedMove: Hashable, Sendable {
        public var ref: Int
        public var frame: Rect
        public var saved: SavedWindow
        public var how: MatchHow
    }

    /// Lowercase, drop "— Edited" suffixes and unsaved-change bullets, collapse whitespace.
    public static func normalizeTitle(_ t: String) -> String {
        var s = t.replacingOccurrences(of: #"\s*[—–-]\s*(edited|modified)\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: #"^[●•*]\s*"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func tokens(_ s: String) -> Set<String> {
        Set(s.components(separatedBy: CharacterSet.letters.union(.decimalDigits).inverted).filter { $0.count > 1 })
    }

    /// 0…1. Equal normalized titles = 1; containment = 0.8; otherwise token Jaccard.
    public static func titleSimilarity(_ a: String, _ b: String) -> Double {
        let x = normalizeTitle(a), y = normalizeTitle(b)
        if x.isEmpty || y.isEmpty { return 0 }
        if x == y { return 1 }
        if (x.count >= 3 && y.contains(x)) || (y.count >= 3 && x.contains(y)) { return 0.8 }
        let tx = tokens(x), ty = tokens(y)
        if tx.isEmpty || ty.isEmpty { return 0 }
        let common = tx.intersection(ty).count
        return Double(common) / Double(tx.count + ty.count - common)
    }

    public static let similarThreshold = 0.5

    /// Per app: exact (normalized) title first, then the most similar title above the threshold, then
    /// whatever is left pairs up by front-to-back order. Full-screen live windows are never moved.
    public static func matchWindows(saved: [SavedWindow], live: [LiveWindow]) -> (pairs: [(saved: SavedWindow, live: LiveWindow, how: MatchHow)], unmatched: [SavedWindow]) {
        var pairs: [(saved: SavedWindow, live: LiveWindow, how: MatchHow)] = []
        var unmatched: [SavedWindow] = []
        var liveByApp: [String: [LiveWindow]] = [:]
        for w in live where !w.fullScreen { if let b = w.bundleId { liveByApp[b, default: []].append(w) } }
        var appOrder: [String] = []
        var savedByApp: [String: [SavedWindow]] = [:]
        for w in saved {
            if savedByApp[w.bundleId] == nil { appOrder.append(w.bundleId) }
            savedByApp[w.bundleId, default: []].append(w)
        }
        for bundleId in appOrder {
            let s = (savedByApp[bundleId] ?? []).enumerated().sorted { $0.element.order != $1.element.order ? $0.element.order < $1.element.order : $0.offset < $1.offset }.map(\.element)
            let l = (liveByApp[bundleId] ?? []).enumerated().sorted { $0.element.order != $1.element.order ? $0.element.order < $1.element.order : $0.offset < $1.offset }.map(\.element)
            var usedS = Set<Int>(), usedL = Set<Int>()
            func take(_ i: Int, _ j: Int, _ how: MatchHow) {
                usedS.insert(i)
                usedL.insert(j)
                pairs.append((s[i], l[j], how))
            }
            for (i, sw) in s.enumerated() {
                let t = normalizeTitle(sw.title)
                guard !t.isEmpty else { continue }
                if let j = l.indices.first(where: { !usedL.contains($0) && normalizeTitle(l[$0].title) == t }) { take(i, j, .title) }
            }
            var candidates: [(i: Int, j: Int, score: Double)] = []
            for (i, sw) in s.enumerated() where !usedS.contains(i) {
                for (j, lw) in l.enumerated() where !usedL.contains(j) {
                    let score = titleSimilarity(sw.title, lw.title)
                    if score >= similarThreshold { candidates.append((i, j, score)) }
                }
            }
            candidates.sort { a, b in a.score != b.score ? a.score > b.score : (a.i != b.i ? a.i < b.i : a.j < b.j) }
            for c in candidates where !usedS.contains(c.i) && !usedL.contains(c.j) { take(c.i, c.j, .similar) }
            var restL = l.indices.filter { !usedL.contains($0) }
            for (i, sw) in s.enumerated() where !usedS.contains(i) {
                if restL.isEmpty { unmatched.append(sw) } else { take(i, restL.removeFirst(), .order) }
            }
        }
        return (pairs, unmatched)
    }

    static func sameSize(_ a: Rect, _ b: Rect) -> Bool { abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1 }
    static func sameRect(_ a: Rect, _ b: Rect) -> Bool { sameSize(a, b) && abs(a.x - b.x) < 1 && abs(a.y - b.y) < 1 }

    /// The live display that best corresponds to a saved one: UUID, then id+size, then same rect, same size, main.
    public static func findDisplay(_ saved: SavedDisplay?, live: [SavedDisplay]) -> SavedDisplay? {
        guard let first = live.first else { return nil }
        let main = live.first(where: \.main) ?? first
        guard let saved else { return main }
        if let u = saved.uuid, let d = live.first(where: { $0.uuid == u }) { return d }
        if let d = live.first(where: { $0.id == saved.id && sameSize($0.frame, saved.frame) }) { return d }
        if let d = live.first(where: { sameRect($0.frame, saved.frame) }) { return d }
        if let d = live.first(where: { sameSize($0.frame, saved.frame) }) { return d }
        return main
    }

    static func clamp(_ r: Rect, into a: Rect) -> Rect {
        let w = min(r.width, a.width), h = min(r.height, a.height)
        let x = min(max(r.x, a.x), a.x + a.width - w), y = min(max(r.y, a.y), a.y + a.height - h)
        return Rect(x: x.rounded(), y: y.rounded(), width: w.rounded(), height: h.rounded())
    }

    /// Same display at the same place → unchanged. Otherwise the frame keeps its position/size relative to the
    /// visible area and is scaled onto the target display.
    public static func mapFrame(_ frame: Rect, savedDisplay: SavedDisplay?, live: [SavedDisplay]) -> Rect {
        guard let target = findDisplay(savedDisplay, live: live) else { return frame }
        if let sd = savedDisplay, sameRect(target.frame, sd.frame) {
            let f = target.frame
            let fits = frame.x >= f.x && frame.y >= f.y && frame.x + frame.width <= f.x + f.width && frame.y + frame.height <= f.y + f.height
            return fits ? frame : clamp(frame, into: target.visible)
        }
        let from = savedDisplay?.visible ?? target.visible, to = target.visible
        let sx = to.width / from.width, sy = to.height / from.height
        let scaled = Rect(x: to.x + (frame.x - from.x) * sx, y: to.y + (frame.y - from.y) * sy, width: frame.width * sx, height: frame.height * sy)
        return clamp(scaled, into: to)
    }

    public static func planRestore(_ layout: WindowLayout, live: [LiveWindow], liveDisplays: [SavedDisplay]) -> (moves: [PlannedMove], unmatched: [SavedWindow]) {
        let m = matchWindows(saved: layout.windows, live: live)
        let moves = m.pairs.map { p in
            PlannedMove(ref: p.live.ref, frame: mapFrame(p.saved.frame, savedDisplay: p.saved.display < layout.displays.count ? layout.displays[p.saved.display] : nil, live: liveDisplays),
                        saved: p.saved, how: p.how)
        }
        return (moves, m.unmatched)
    }

    /// Saved apps (bundle ids) that have no live window right now.
    public static func missingApps(_ saved: [SavedWindow], live: [LiveWindow], running: Set<String>) -> [String] {
        let withWindows = Set(live.compactMap(\.bundleId))
        var out: [String] = []
        for w in saved where !out.contains(w.bundleId) && (!running.contains(w.bundleId) || !withWindows.contains(w.bundleId)) { out.append(w.bundleId) }
        return out
    }
}
