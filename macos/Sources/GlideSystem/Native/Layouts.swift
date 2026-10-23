import AppKit
import ApplicationServices
import GlideCore

/// Window layouts (helper Layouts.swift): snapshot standard windows of regular apps, move them back by ref.
@MainActor public final class AXLayoutService: LayoutService {
    private let frontmost: FrontmostTracker
    private var refs: [Int: AXUIElement] = [:]
    private var nextRef = 1
    public init(frontmost: FrontmostTracker) { self.frontmost = frontmost }

    static func rect(_ r: CGRect) -> JSONValue {
        ["x": .double(Double(r.minX)), "y": .double(Double(r.minY)), "width": .double(Double(r.width)), "height": .double(Double(r.height))]
    }
    static func parseRect(_ v: JSONValue?) -> CGRect? {
        guard let x = v?["x"]?.doubleValue, let y = v?["y"]?.doubleValue, let w = v?["width"]?.doubleValue, let h = v?["height"]?.doubleValue, w > 0, h > 0 else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    public func displays() -> JSONValue {
        var info: [CGDirectDisplayID: (String, NSEdgeInsets)] = [:]
        for s in NSScreen.screens {
            guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            let f = s.frame, v = s.visibleFrame
            info[CGDirectDisplayID(n.uint32Value)] = (s.localizedName, NSEdgeInsets(top: f.maxY - v.maxY, left: v.minX - f.minX, bottom: v.minY - f.minY, right: f.maxX - v.maxX))
        }
        let main = CGMainDisplayID()
        return .array(Screens.displayIDs().map { id in
            let b = CGDisplayBounds(id)
            let (name, i) = info[id] ?? ("Display", NSEdgeInsets(top: 25, left: 0, bottom: 0, right: 0))
            let v = CGRect(x: b.minX + i.left, y: b.minY + i.top, width: b.width - i.left - i.right, height: b.height - i.top - i.bottom)
            var uuid = JSONValue.null
            if let u = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() { uuid = .string(CFUUIDCreateString(nil, u) as String) }
            return ["id": .int(Int64(id)), "uuid": uuid, "name": .string(name), "frame": Self.rect(b), "visible": Self.rect(v), "main": .bool(id == main)]
        })
    }

    private func describe(_ app: NSRunningApplication) -> JSONValue {
        let d = FrontmostTracker.describe(app)
        return ["name": .string(d.name), "bundleId": d.bundleId.map(JSONValue.string) ?? .null, "pid": .int(Int64(d.pid)),
                "path": d.path.map(JSONValue.string) ?? .null, "hidden": .bool(app.isHidden)]
    }

    public func runningApps() -> JSONValue {
        .array(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !frontmost.isGlide($0) }.map(describe))
    }

    public func capture(includeHidden: Bool) async -> JSONValue {
        guard AXIsProcessTrusted() else { return ["ok": false, "error": "Accessibility permission required"] }
        let displayList = displays()
        let frames = (displayList.arrayValue ?? []).compactMap { Self.parseRect($0["frame"]) }
        var windows: [JSONValue] = []
        var newRefs: [Int: AXUIElement] = [:]
        var ref = nextRef
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !frontmost.isGlide($0) && (includeHidden || !$0.isHidden) }
        for app in apps {
            let axApp = AX.app(app.processIdentifier, timeout: 0.5)
            guard let list = AX.attr(axApp, kAXWindowsAttribute) as? [AXUIElement] else { continue }
            var order = 0
            for win in list {
                let v = AX.attrs(win, [kAXSubroleAttribute, kAXTitleAttribute, kAXMinimizedAttribute, "AXFullScreen"])
                let subrole = v[0] as? String
                guard subrole == nil || subrole == kAXStandardWindowSubrole as String else { continue }
                if (v[2] as? Bool) == true { continue }
                guard let frame = AX.frame(win), frame.width >= 40, frame.height >= 40 else { continue }
                var display = 0, best: CGFloat = -1
                for (i, f) in frames.enumerated() {
                    let inter = f.intersection(frame)
                    let area = inter.isNull ? 0 : inter.width * inter.height
                    if area > best { best = area; display = i }
                }
                newRefs[ref] = win
                windows.append([
                    "ref": .int(Int64(ref)), "pid": .int(Int64(app.processIdentifier)),
                    "bundleId": app.bundleIdentifier.map(JSONValue.string) ?? .null,
                    "appName": .string(app.localizedName ?? app.bundleIdentifier ?? "Unknown"),
                    "appPath": app.bundleURL.map { .string($0.path) } ?? .null,
                    "title": .string((v[1] as? String) ?? ""), "frame": Self.rect(frame), "display": .int(Int64(display)),
                    "order": .int(Int64(order)), "fullScreen": .bool((v[3] as? Bool) ?? false),
                ])
                ref += 1
                order += 1
            }
        }
        refs = newRefs
        nextRef = ref
        return ["ok": true, "displays": displayList, "windows": .array(windows)]
    }

    public func move(_ moves: JSONValue) async -> JSONValue {
        guard AXIsProcessTrusted() else { return ["ok": false, "error": "Accessibility permission required"] }
        var results: [JSONValue] = []
        for m in moves.arrayValue ?? [] {
            guard let ref = m["ref"]?.intValue else { continue }
            let r = JSONValue.int(Int64(ref))
            guard let win = refs[ref] else { results.append(["ref": r, "ok": false, "error": "Unknown window (capture again)"]); continue }
            guard let frame = Self.parseRect(m["frame"]) else { results.append(["ref": r, "ok": false, "error": "Invalid frame"]); continue }
            if (AX.attr(win, "AXFullScreen") as? Bool) == true { results.append(["ref": r, "ok": false, "error": "Window is in full screen"]); continue }
            if (AX.attr(win, kAXMinimizedAttribute) as? Bool) == true { AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
            AX.setFrame(win, frame.integral)
            if m["raise"]?.boolValue == true { AXUIElementPerformAction(win, kAXRaiseAction as CFString) }
            if let actual = AX.frame(win) { results.append(["ref": r, "ok": true, "frame": Self.rect(actual)]) } else { results.append(["ref": r, "ok": false, "error": "Window closed"]) }
        }
        return ["ok": true, "results": .array(results)]
    }

    public func quit(bundleIds: [String]) -> JSONValue {
        var asked = Set<String>()
        for id in bundleIds {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier: id) where !frontmost.isGlide(app) {
                if app.terminate() { asked.insert(id) }
            }
        }
        return ["ok": true, "asked": .array(asked.sorted().map(JSONValue.string))]
    }
}
