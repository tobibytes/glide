import AppKit
import EventKit

/// EventKit reminders. Every method except status() needs full Reminders access, which is only
/// requested from permissions.request {kind:"reminders"} (an explicit user action in Glide).
enum RemindersService {
    private static var store = EKEventStore()
    private static let lock = NSLock()
    private static func current() -> EKEventStore { lock.lock(); defer { lock.unlock() }; return store }

    static func status() -> String {
        switch EKEventStore.authorizationStatus(for: .reminder) {
        case .fullAccess: return "authorized"
        case .denied, .writeOnly: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        default: return "authorized"
        }
    }

    static func request() {
        let done = DispatchSemaphore(value: 0)
        current().requestFullAccessToReminders { _, _ in done.signal() }
        _ = done.wait(timeout: .now() + 120)
        lock.lock()
        store = EKEventStore() // a store created before the grant keeps returning nothing
        lock.unlock()
    }

    private static func requireAccess() throws {
        guard status() == "authorized" else { throw HelperError("Reminders access has not been granted") }
    }

    private static func hex(_ c: CGColor?) -> Any {
        guard let c, let rgb = NSColor(cgColor: c)?.usingColorSpace(.sRGB) else { return NSNull() }
        return String(format: "#%02x%02x%02x", Int(rgb.redComponent * 255), Int(rgb.greenComponent * 255), Int(rgb.blueComponent * 255))
    }

    static func lists() throws -> [[String: Any]] {
        try requireAccess()
        let s = current()
        let def = s.defaultCalendarForNewReminders()?.calendarIdentifier
        return s.calendars(for: .reminder).map { c in
            ["id": c.calendarIdentifier, "title": c.title, "color": hex(c.cgColor), "isDefault": c.calendarIdentifier == def, "writable": c.allowsContentModifications]
        }
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? iso.date(from: s)
    }

    static func describe(_ r: EKReminder) -> [String: Any] {
        var o: [String: Any] = [
            "id": r.calendarItemIdentifier,
            "title": r.title ?? "",
            "completed": r.isCompleted,
            "priority": r.priority,
            "listId": r.calendar?.calendarIdentifier ?? "",
            "listTitle": r.calendar?.title ?? "",
            "color": hex(r.calendar?.cgColor),
        ]
        if let comps = r.dueDateComponents, let date = Calendar.current.date(from: comps) {
            o["due"] = iso.string(from: date)
            o["dueAllDay"] = comps.hour == nil
        }
        if let d = r.completionDate { o["completionDate"] = iso.string(from: d) }
        if let n = r.notes, !n.isEmpty { o["notes"] = n }
        if let u = r.url { o["url"] = u.absoluteString }
        return o
    }

    static func list(listId: String?, includeCompleted: Bool) throws -> [[String: Any]] {
        try requireAccess()
        let s = current()
        var cals: [EKCalendar]? = nil
        if let listId, !listId.isEmpty {
            guard let c = s.calendar(withIdentifier: listId) else { throw HelperError("Unknown reminders list") }
            cals = [c]
        }
        let predicate = includeCompleted ? s.predicateForReminders(in: cals) : s.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals)
        let done = DispatchSemaphore(value: 0)
        var found: [EKReminder] = []
        s.fetchReminders(matching: predicate) { rs in
            found = rs ?? []
            done.signal()
        }
        guard done.wait(timeout: .now() + 15) == .success else { throw HelperError("Reminders did not answer in time") }
        return found.map(describe)
    }

    static func create(_ p: Params) throws -> [String: Any] {
        try requireAccess()
        guard let title = (p["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { throw HelperError("Missing title") }
        let s = current()
        let r = EKReminder(eventStore: s)
        r.title = title
        if let notes = p["notes"] as? String, !notes.isEmpty { r.notes = notes }
        if let listId = p["listId"] as? String, !listId.isEmpty {
            guard let c = s.calendar(withIdentifier: listId) else { throw HelperError("Unknown reminders list") }
            r.calendar = c
        } else {
            guard let c = s.defaultCalendarForNewReminders() else { throw HelperError("No default reminders list") }
            r.calendar = c
        }
        if let dueRaw = p["due"] as? String {
            guard let due = parseDate(dueRaw) else { throw HelperError("Invalid due date") }
            let allDay = (p["allDay"] as? Bool) ?? false
            let units: Set<Calendar.Component> = allDay ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute]
            var comps = Calendar.current.dateComponents(units, from: due)
            comps.timeZone = allDay ? nil : TimeZone.current
            r.dueDateComponents = comps
            // Timed reminders notify at the due time, like ones made in Reminders.app.
            if !allDay { r.addAlarm(EKAlarm(absoluteDate: due)) }
        }
        try s.save(r, commit: true)
        return describe(r)
    }

    static func complete(id: String, completed: Bool) throws -> [String: Any] {
        try requireAccess()
        let s = current()
        guard let r = s.calendarItem(withIdentifier: id) as? EKReminder else { throw HelperError("Reminder not found") }
        r.isCompleted = completed
        try s.save(r, commit: true)
        return describe(r)
    }
}
