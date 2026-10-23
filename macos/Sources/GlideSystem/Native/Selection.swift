import AppKit
import ApplicationServices
import GlideCore

/// Selected text in the user's app via Accessibility (helper Services.swift `Selection`).
///
/// Works while the launcher is visible: the panel is non-activating, so the user's app is still active and its
/// AXFocusedUIElement is still the field they were typing in.
@MainActor public final class AXSelectionService: SelectionService {
    private let frontmost: FrontmostTracker
    public init(frontmost: FrontmostTracker) { self.frontmost = frontmost }

    public func selectedText() async -> SelectionResult {
        guard AXIsProcessTrusted() else { return SelectionResult(text: nil, app: nil, reason: "no-accessibility") }
        guard let app = frontmost.runningTarget() else { return SelectionResult(text: nil, app: nil, reason: "no-target-app") }
        let pid = app.processIdentifier
        let name = app.localizedName ?? app.bundleIdentifier ?? "the app"
        let bundleId = app.bundleIdentifier
        return await offMain { SelectionReader.read(pid: pid, name: name, bundleId: bundleId) }
    }
}

/// The thread-agnostic reading logic, unchanged from the helper.
enum SelectionReader {
    /// Pids we already asked to build their accessibility tree (Chromium/Electron do it lazily).
    private nonisolated(unsafe) static var woken = Set<pid_t>()
    private static let lock = NSLock()

    /// Chromium browsers build their AX tree only for assistive clients: Electron apps listen to
    /// AXManualAccessibility, Chrome-family browsers to AXEnhancedUserInterface.
    static let chromiumBrowsers: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "org.chromium.Chromium",
        "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.vivaldi.Vivaldi",
        "com.operasoftware.Opera", "ai.perplexity.comet", "company.thebrowser.dia",
    ]

    static func read(pid: pid_t, name: String, bundleId: String?) -> SelectionResult {
        let axApp = AX.app(pid, timeout: 1.0)
        let policy = SelectionReadPolicy.standard
        var woke = false
        for attempt in 0..<policy.attempts {
            let delay = policy.delay(beforeAttempt: attempt, afterWake: woke)
            if delay > 0 { usleep(useconds_t(delay * 1_000_000)) }
            let focused = focusedElement(axApp, pid: pid)
            if let focused, isSecure(focused) { return SelectionResult(text: nil, app: name, reason: "secure-field") }
            if let focused, let text = readOnce(focused) { return SelectionResult(text: text, app: name, reason: nil) }
            // Chromium/Electron build their tree lazily: ask once per process, then retry.
            if !woke, policy.shouldWake(attempt: attempt, focusedFound: focused != nil) {
                lock.lock()
                let first = woken.insert(pid).inserted
                lock.unlock()
                if first, wake(axApp, bundleId: bundleId) { woke = true }
            }
        }
        let focused = focusedElement(axApp, pid: pid)
        return SelectionResult(text: nil, app: name, reason: SelectionReadPolicy.reason(focusedFound: focused != nil))
    }

    /// The app's focused element; falls back to the system-wide focus when it belongs to the same process
    /// (never Glide's own panel).
    private static func focusedElement(_ axApp: AXUIElement, pid: pid_t) -> AXUIElement? {
        if let el = AX.element(axApp, kAXFocusedUIElementAttribute) { return el }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.5)
        guard let el = AX.element(system, kAXFocusedUIElementAttribute) else { return nil }
        var owner: pid_t = 0
        guard AXUIElementGetPid(el, &owner) == .success, owner == pid else { return nil }
        return el
    }

    private static func isSecure(_ el: AXUIElement) -> Bool {
        (AX.attr(el, kAXSubroleAttribute) as? String) == (kAXSecureTextFieldSubrole as String)
    }

    private static func wake(_ axApp: AXUIElement, bundleId: String?) -> Bool {
        let manual = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
        var enhanced = false
        if let id = bundleId, chromiumBrowsers.contains(id) {
            enhanced = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success
        }
        return manual || enhanced
    }

    /// 1. AXSelectedText (text fields, most native views). 2. AXSelectedTextRange → AXStringForRange (views
    /// that report a range but not the text). 3. Web content (Chrome, Safari, Electron): the selection only
    /// exists as a text-marker range on the focused element or an ancestor web area.
    private static func readOnce(_ focused: AXUIElement) -> String? {
        if let text = AX.attr(focused, kAXSelectedTextAttribute) as? String, !text.isEmpty { return text }
        if let rangeValue = AX.attr(focused, kAXSelectedTextRangeAttribute), CFGetTypeID(rangeValue) == AXValueGetTypeID() {
            var range = CFRange()
            // swiftlint:disable:next force_cast
            if AXValueGetValue(rangeValue as! AXValue, .cfRange, &range), range.length > 0 {
                var value: AnyObject?
                if AXUIElementCopyParameterizedAttributeValue(focused, kAXStringForRangeParameterizedAttribute as CFString, rangeValue, &value) == .success,
                   let text = value as? String, !text.isEmpty {
                    return text
                }
                if let full = AX.attr(focused, kAXValueAttribute) as? String, let r = SelectionReadPolicy.substring(full, location: range.location, length: range.length) {
                    return r
                }
            }
        }
        for el in [focused] + ancestors(of: focused, limit: 8) {
            guard let range = AX.attr(el, "AXSelectedTextMarkerRange") else { continue }
            var value: AnyObject?
            if AXUIElementCopyParameterizedAttributeValue(el, "AXStringForTextMarkerRange" as CFString, range, &value) == .success,
               let text = value as? String, !text.isEmpty {
                return text
            }
        }
        return nil
    }

    private static func ancestors(of el: AXUIElement, limit: Int) -> [AXUIElement] {
        var out: [AXUIElement] = []
        var cur = el
        while out.count < limit, let parent = AX.element(cur, kAXParentAttribute) {
            out.append(parent)
            cur = parent
        }
        return out
    }
}

/// Pure decisions of the selection reader (unit-tested): attempts with backoff, when to wake a lazy
/// Chromium/Electron tree, how to explain a failure, and UTF-16 range slicing.
public struct SelectionReadPolicy: Sendable, Equatable {
    /// Delay before each attempt (seconds); attempt 0 runs immediately.
    public var backoff: [Double]
    /// Extra wait after waking an app's accessibility tree (it is built asynchronously).
    public var afterWake: Double

    public static let standard = SelectionReadPolicy(backoff: [0, 0.08, 0.2, 0.35], afterWake: 0.25)

    public init(backoff: [Double], afterWake: Double) {
        self.backoff = backoff
        self.afterWake = afterWake
    }

    public var attempts: Int { backoff.count }
    /// Worst-case time spent waiting (well under the 3 s caller timeout).
    public var totalDelay: Double { backoff.reduce(0, +) + afterWake }

    public func delay(beforeAttempt attempt: Int, afterWake woke: Bool) -> Double {
        guard attempt > 0, attempt < backoff.count else { return 0 }
        return backoff[attempt] + (woke && attempt == firstAttemptAfterWake ? afterWake : 0)
    }

    private var firstAttemptAfterWake: Int { 1 }

    /// Wake after the first failed read (focused element missing or no selection reported).
    public func shouldWake(attempt: Int, focusedFound: Bool) -> Bool { attempt == 0 }

    public static func reason(focusedFound: Bool) -> String { focusedFound ? "no-selected-text" : "no-focused-element" }

    /// `AXValue` substring for a CFRange (UTF-16 offsets), nil when out of bounds.
    public static func substring(_ s: String, location: Int, length: Int) -> String? {
        let u = Array(s.utf16)
        guard location >= 0, length > 0, location + length <= u.count else { return nil }
        let text = String(utf16CodeUnits: Array(u[location..<(location + length)]), count: length)
        return text.isEmpty ? nil : text
    }
}
