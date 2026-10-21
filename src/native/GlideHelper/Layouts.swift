import AppKit
import ApplicationServices

/// Window layouts: snapshot every standard window of regular apps, then move windows back by reference.
/// Matching saved windows to live ones is done in TypeScript (src/main/features/layouts/match.ts);
/// the helper only reports windows and moves the ones it was asked to.
enum WindowLayouts {
    private static let lock = NSLock()
    /// AX elements from the most recent `layouts.capture`, keyed by the `ref` handed to the caller.
    private static var refs: [Int: AXUIElement] = [:]
    private static var nextRef = 1

    static func rect(_ r: CGRect) -> [String: Any] {
        ["x": Double(r.minX), "y": Double(r.minY), "width": Double(r.width), "height": Double(r.height)]
    }

    static func parseRect(_ v: Any?) -> CGRect? {
        guard let d = v as? [String: Any],
              let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue,
              let w = (d["width"] as? NSNumber)?.doubleValue, let h = (d["height"] as? NSNumber)?.doubleValue,
              w > 0, h > 0
        else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    /// Displays in AX coordinates, main display first (same order as Screens.all()).
    static func displays() -> [[String: Any]] {
        let info: [CGDirectDisplayID: (String, NSEdgeInsets)] = onMain {
            var map: [CGDirectDisplayID: (String, NSEdgeInsets)] = [:]
            for s in NSScreen.screens {
                guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
                let f = s.frame, v = s.visibleFrame
                map[CGDirectDisplayID(n.uint32Value)] = (s.localizedName, NSEdgeInsets(top: f.maxY - v.maxY, left: v.minX - f.minX, bottom: v.minY - f.minY, right: f.maxX - v.maxX))
            }
            return map
        }
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let main = CGMainDisplayID()
        ids.sort { a, b in a == main ? true : (b == main ? false : a < b) }
        return ids.map { id in
            let b = CGDisplayBounds(id)
            let (name, i) = info[id] ?? ("Display", NSEdgeInsets(top: 25, left: 0, bottom: 0, right: 0))
            let v = CGRect(x: b.minX + i.left, y: b.minY + i.top, width: b.width - i.left - i.right, height: b.height - i.top - i.bottom)
            var uuid: Any = NSNull()
            if let u = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() { uuid = CFUUIDCreateString(nil, u) as String }
            return ["id": Int(id), "uuid": uuid, "name": name, "frame": rect(b), "visible": rect(v), "main": id == main]
        }
    }

    static func runningApps() -> [[String: Any]] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && !Apps.shared.isGlide($0) }
            .map { app in
                var d = Apps.describe(app)
                d["hidden"] = app.isHidden
                return d
            }
    }

    static func capture(includeHidden: Bool) -> [String: Any] {
        guard AXIsProcessTrusted() else { return ["ok": false, "error": "Accessibility permission required"] }
        let displayList = displays()
        let frames = displayList.compactMap { parseRect($0["frame"]) }
        var windows: [[String: Any]] = []
        var newRefs: [Int: AXUIElement] = [:]
        lock.lock()
        var ref = nextRef
        lock.unlock()
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !Apps.shared.isGlide($0) && (includeHidden || !$0.isHidden) }
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
                    "ref": ref,
                    "pid": Int(app.processIdentifier),
                    "bundleId": app.bundleIdentifier ?? NSNull(),
                    "appName": app.localizedName ?? app.bundleIdentifier ?? "Unknown",
                    "appPath": app.bundleURL?.path ?? NSNull(),
                    "title": (v[1] as? String) ?? "",
                    "frame": rect(frame),
                    "display": display,
                    "order": order,
                    "fullScreen": (v[3] as? Bool) ?? false,
                ])
                ref += 1
                order += 1
            }
        }
        lock.lock()
        refs = newRefs
        nextRef = ref
        lock.unlock()
        return ["ok": true, "displays": displayList, "windows": windows]
    }

    /// Moves windows captured by the most recent capture. Each move reports the frame the app accepted.
    static func move(_ moves: [[String: Any]]) -> [String: Any] {
        guard AXIsProcessTrusted() else { return ["ok": false, "error": "Accessibility permission required"] }
        var results: [[String: Any]] = []
        for m in moves {
            guard let ref = (m["ref"] as? NSNumber)?.intValue else { continue }
            lock.lock()
            let win = refs[ref]
            lock.unlock()
            guard let win else { results.append(["ref": ref, "ok": false, "error": "Unknown window (capture again)"]); continue }
            guard let frame = parseRect(m["frame"]) else { results.append(["ref": ref, "ok": false, "error": "Invalid frame"]); continue }
            if (AX.attr(win, "AXFullScreen") as? Bool) == true {
                results.append(["ref": ref, "ok": false, "error": "Window is in full screen"]); continue
            }
            if (AX.attr(win, kAXMinimizedAttribute) as? Bool) == true {
                AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            }
            AX.setFrame(win, frame.integral)
            if (m["raise"] as? Bool) == true { AXUIElementPerformAction(win, kAXRaiseAction as CFString) }
            if let actual = AX.frame(win) {
                results.append(["ref": ref, "ok": true, "frame": rect(actual)])
            } else {
                results.append(["ref": ref, "ok": false, "error": "Window closed"])
            }
        }
        return ["ok": true, "results": results]
    }

    /// Politely asks apps to quit (they may still show save dialogs). Returns which were asked.
    static func quit(_ bundleIds: [String]) -> [String: Any] {
        var asked: [String] = []
        for id in bundleIds {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier: id) where !Apps.shared.isGlide(app) {
                if app.terminate() { asked.append(id) }
            }
        }
        return ["ok": true, "asked": Array(Set(asked))]
    }
}
