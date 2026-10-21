import AppKit
import ApplicationServices
import EventKit

enum Permissions {
    static func status() -> [String: Any] {
        ["accessibility": AXIsProcessTrusted(), "inputMonitoring": CGPreflightListenEventAccess(), "calendar": CalendarService.status()]
    }

    static func request(_ kind: String) throws -> [String: Any] {
        switch kind {
        case "accessibility":
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case "inputMonitoring":
            _ = CGRequestListenEventAccess()
        case "calendar":
            CalendarService.request()
        default:
            throw HelperError("Unknown permission \(kind)")
        }
        return status()
    }

    private static var last: NSDictionary?

    /// Polls (permissions have no change notification) and emits permissions.changed.
    static func startWatching() {
        last = status() as NSDictionary
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            let now = status()
            if !(last?.isEqual(to: now) ?? false) {
                last = now as NSDictionary
                Output.event("permissions.changed", now)
                Keys.shared.retryIfNeeded()
            }
        }
    }
}

enum CalendarService {
    private static var store = EKEventStore()

    static func status() -> String {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return "authorized"
        case .denied, .writeOnly: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        default: return "authorized" // legacy .authorized
        }
    }

    static func request() {
        let done = DispatchSemaphore(value: 0)
        store.requestFullAccessToEvents { _, _ in done.signal() }
        _ = done.wait(timeout: .now() + 120)
        store = EKEventStore() // a store created before the grant keeps returning nothing
    }

    private static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func events(from: String, to: String) throws -> [[String: Any]] {
        guard status() == "authorized" else { throw HelperError("Calendar access has not been granted") }
        guard let start = parseDate(from), let end = parseDate(to) else { throw HelperError("Invalid date range") }
        let iso = ISO8601DateFormatter()
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
        return store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.map { e in
            var o: [String: Any] = [
                // Recurring occurrences share an identifier; the start time makes each unique.
                "id": "\(e.eventIdentifier ?? e.calendarItemIdentifier)@\(Int(e.startDate.timeIntervalSince1970))",
                "title": e.title ?? "",
                "start": iso.string(from: e.startDate),
                "end": iso.string(from: e.endDate),
                "allDay": e.isAllDay,
                "calendar": e.calendar?.title ?? "",
            ]
            if let l = e.location, !l.isEmpty { o["location"] = l }
            if let u = e.url { o["url"] = u.absoluteString }
            if let n = e.notes, !n.isEmpty { o["notes"] = n }
            if let c = e.calendar?.cgColor, let rgb = NSColor(cgColor: c)?.usingColorSpace(.sRGB) {
                o["color"] = String(format: "#%02x%02x%02x", Int(rgb.redComponent * 255), Int(rgb.greenComponent * 255), Int(rgb.blueComponent * 255))
            }
            return o
        }
    }
}

enum Spotlight {
    private static let domain = "com.apple.symbolichotkeys" as CFString
    private static let key = "AppleSymbolicHotKeys" as CFString
    private static let spotlightId = "64"

    private static func hotkeys() -> [String: Any] {
        (CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? [String: Any]) ?? [:]
    }

    static func enabled() -> Bool {
        guard let entry = hotkeys()[spotlightId] as? [String: Any] else { return true } // absent = system default (on)
        return (entry["enabled"] as? NSNumber)?.boolValue ?? true
    }

    static func setEnabled(_ on: Bool) -> [String: Any] {
        var all = hotkeys()
        var entry = (all[spotlightId] as? [String: Any]) ?? ["value": ["parameters": [32, 49, 1_048_576], "type": "standard"] as [String: Any]]
        entry["enabled"] = on
        all[spotlightId] = entry
        CFPreferencesSetValue(key, all as CFDictionary, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else {
            return ["ok": false, "error": "Could not save the keyboard shortcut preference"]
        }
        let tool = "/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings"
        if FileManager.default.isExecutableFile(atPath: tool) {
            runTool(tool, ["-u"])
        } else {
            log("activateSettings not found; the change applies after logging out")
        }
        return ["ok": true]
    }
}

enum Selection {
    /// Pids we already asked to build their accessibility tree (Chromium/Electron do it lazily).
    private static var woken = Set<pid_t>()
    private static let lock = NSLock()

    /// Selected text via Accessibility. Electron/Chromium apps expose nothing until a client sets
    /// AXManualAccessibility, so on an empty first read we set it once per process and read again.
    static func text() -> [String: Any] {
        guard AXIsProcessTrusted(), let app = Apps.shared.target() else { return ["text": NSNull()] }
        let pid = app.processIdentifier
        let axApp = AX.app(pid, timeout: 0.4)
        if let text = read(axApp) { return ["text": text] }
        lock.lock()
        let first = woken.insert(pid).inserted
        lock.unlock()
        guard first, AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success else {
            return ["text": NSNull()]
        }
        usleep(150_000) // the tree is built asynchronously
        return ["text": read(axApp) ?? NSNull()]
    }

    private static func read(_ axApp: AXUIElement) -> String? {
        guard let focused = AX.element(axApp, kAXFocusedUIElementAttribute),
              let text = AX.attr(focused, kAXSelectedTextAttribute) as? String, !text.isEmpty
        else { return nil }
        return text
    }
}
