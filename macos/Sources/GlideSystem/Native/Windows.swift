import AppKit
import ApplicationServices
import GlideCore

/// Screen geometry in AX coordinates (origin top-left of the primary display, y down).
public struct ScreenInfo: Sendable, Equatable {
    public let frame: CGRect
    public let visible: CGRect
    public init(frame: CGRect, visible: CGRect) {
        self.frame = frame
        self.visible = visible
    }
}

enum Screens {
    /// Must be called on the main thread (NSScreen).
    @MainActor static func all() -> [ScreenInfo] {
        var insets: [CGDirectDisplayID: NSEdgeInsets] = [:]
        for s in NSScreen.screens {
            guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            let f = s.frame, v = s.visibleFrame
            insets[CGDirectDisplayID(n.uint32Value)] = NSEdgeInsets(top: f.maxY - v.maxY, left: v.minX - f.minX, bottom: v.minY - f.minY, right: f.maxX - v.maxX)
        }
        return displayIDs().map { id in
            let b = CGDisplayBounds(id)
            let i = insets[id] ?? NSEdgeInsets(top: 25, left: 0, bottom: 0, right: 0)
            return ScreenInfo(frame: b, visible: CGRect(x: b.minX + i.left, y: b.minY + i.top, width: b.width - i.left - i.right, height: b.height - i.top - i.bottom))
        }
    }

    static func displayIDs() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let main = CGMainDisplayID()
        ids.sort { a, b in a == main ? true : (b == main ? false : a < b) }
        return ids
    }

    static func index(for rect: CGRect, in screens: [ScreenInfo]) -> Int {
        var best = 0
        var bestArea: CGFloat = -1
        for (i, s) in screens.enumerated() {
            let inter = s.frame.intersection(rect)
            let area = inter.isNull ? 0 : inter.width * inter.height
            if area > bestArea { best = i; bestArea = area }
        }
        if bestArea <= 0, let i = screens.firstIndex(where: { $0.frame.contains(CGPoint(x: rect.midX, y: rect.midY)) }) { return i }
        return best
    }
}

/// Window management on the target app's focused window (helper Windows.swift).
@MainActor public final class AXWindowService: WindowService {
    private let frontmost: FrontmostTracker
    /// Frames before Glide changed them (for "restore").
    private var history: [(AXUIElement, CGRect)] = []

    public init(frontmost: FrontmostTracker) { self.frontmost = frontmost }

    private func remember(_ win: AXUIElement, _ frame: CGRect) {
        if history.contains(where: { CFEqual($0.0, win) }) { return }
        history.append((win, frame))
        if history.count > 100 { history.removeFirst(history.count - 100) }
    }

    private func takeSaved(_ win: AXUIElement) -> CGRect? {
        guard let i = history.lastIndex(where: { CFEqual($0.0, win) }) else { return nil }
        return history.remove(at: i).1
    }

    static func focusedWindow(_ app: AXUIElement) -> AXUIElement? {
        AX.element(app, kAXFocusedWindowAttribute) ?? AX.element(app, kAXMainWindowAttribute)
            ?? ((AX.attr(app, kAXWindowsAttribute) as? [AXUIElement])?.first)
    }

    public func apply(_ action: String) async -> ServiceResult {
        guard AXIsProcessTrusted() else { return .failure("Accessibility permission required") }
        guard let target = frontmost.runningTarget() else { return .failure("No application to act on") }
        let app = AX.app(target.processIdentifier)
        guard let win = Self.focusedWindow(app) else { return .failure("\(target.localizedName ?? "The app") has no window to move") }
        switch action {
        case "minimize":
            return AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanTrue) == .success ? .success : .failure("Could not minimize the window")
        case "toggle-fullscreen":
            let on = (AX.attr(win, "AXFullScreen") as? Bool) ?? false
            let err = AXUIElementSetAttributeValue(win, "AXFullScreen" as CFString, (on ? kCFBooleanFalse : kCFBooleanTrue)!)
            return err == .success ? .success : .failure("This window does not support full screen")
        default: break
        }
        guard let frame = AX.frame(win) else { return .failure("Could not read the window frame") }
        let screens = Screens.all()
        guard !screens.isEmpty else { return .failure("No displays found") }
        let si = Screens.index(for: frame, in: screens)
        if action == "restore" {
            guard let saved = takeSaved(win) else { return .failure("Nothing to restore for this window") }
            AX.setFrame(win, saved)
            return .success
        }
        guard let rect = WindowGeometry.target(action: action, frame: frame, visible: screens[si].visible, screens: screens, screenIndex: si) else {
            if action == "next-display" || action == "previous-display" { return .failure("Only one display is connected") }
            return .failure("Unknown window action \(action)")
        }
        remember(win, frame)
        AX.setFrame(win, rect.integral)
        return .success
    }
}

/// Pure geometry for every window action (AX coordinates). Unit tested.
public enum WindowGeometry {
    public static let actions = ["left-half", "right-half", "top-half", "bottom-half", "top-left", "top-right", "bottom-left", "bottom-right",
                                 "left-third", "center-third", "right-third", "left-two-thirds", "right-two-thirds", "maximize", "almost-maximize",
                                 "center", "reasonable-size", "make-larger", "make-smaller", "next-display", "previous-display"]

    public static func target(action: String, frame: CGRect, visible v: CGRect, screens: [ScreenInfo], screenIndex: Int) -> CGRect? {
        let w = v.width, h = v.height, x = v.minX, y = v.minY
        func centered(_ size: CGSize, in r: CGRect) -> CGRect {
            let s = CGSize(width: min(size.width, r.width), height: min(size.height, r.height))
            return CGRect(x: r.midX - s.width / 2, y: r.midY - s.height / 2, width: s.width, height: s.height)
        }
        switch action {
        case "left-half": return CGRect(x: x, y: y, width: w / 2, height: h)
        case "right-half": return CGRect(x: x + w / 2, y: y, width: w / 2, height: h)
        case "top-half": return CGRect(x: x, y: y, width: w, height: h / 2)
        case "bottom-half": return CGRect(x: x, y: y + h / 2, width: w, height: h / 2)
        case "top-left": return CGRect(x: x, y: y, width: w / 2, height: h / 2)
        case "top-right": return CGRect(x: x + w / 2, y: y, width: w / 2, height: h / 2)
        case "bottom-left": return CGRect(x: x, y: y + h / 2, width: w / 2, height: h / 2)
        case "bottom-right": return CGRect(x: x + w / 2, y: y + h / 2, width: w / 2, height: h / 2)
        case "left-third": return CGRect(x: x, y: y, width: w / 3, height: h)
        case "center-third": return CGRect(x: x + w / 3, y: y, width: w / 3, height: h)
        case "right-third": return CGRect(x: x + 2 * w / 3, y: y, width: w / 3, height: h)
        case "left-two-thirds": return CGRect(x: x, y: y, width: 2 * w / 3, height: h)
        case "right-two-thirds": return CGRect(x: x + w / 3, y: y, width: 2 * w / 3, height: h)
        case "maximize": return v
        case "almost-maximize": return centered(CGSize(width: w * 0.9, height: h * 0.9), in: v)
        case "center": return centered(frame.size, in: v)
        case "reasonable-size": return centered(CGSize(width: w * 0.6, height: h * 0.7), in: v)
        case "make-larger", "make-smaller":
            let f: CGFloat = action == "make-larger" ? 1.1 : 0.9
            let size = CGSize(width: max(200, min(w, frame.width * f)), height: max(150, min(h, frame.height * f)))
            var r = CGRect(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2, width: size.width, height: size.height)
            r.origin.x = min(max(r.minX, v.minX), v.maxX - r.width)
            r.origin.y = min(max(r.minY, v.minY), v.maxY - r.height)
            return r
        case "next-display", "previous-display":
            guard screens.count > 1 else { return nil }
            let n = screens.count
            let next = action == "next-display" ? (screenIndex + 1) % n : (screenIndex - 1 + n) % n
            let nv = screens[next].visible
            let rw = min(1, frame.width / w), rh = min(1, frame.height / h)
            let rx = (frame.minX - x) / w, ry = (frame.minY - y) / h
            var r = CGRect(x: nv.minX + rx * nv.width, y: nv.minY + ry * nv.height, width: rw * nv.width, height: rh * nv.height)
            r.origin.x = min(max(r.minX, nv.minX), nv.maxX - r.width)
            r.origin.y = min(max(r.minY, nv.minY), nv.maxY - r.height)
            return r
        default:
            return nil
        }
    }
}
