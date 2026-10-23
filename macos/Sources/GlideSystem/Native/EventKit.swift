import AppKit
import EventKit
import GlideCore

/// Calendar events and Reminders (helper Services.swift CalendarService + Reminders.swift). Data calls need
/// full access, which is only requested via PermissionService.request (an explicit user action).
@MainActor public final class EventKitStore: EventKitService {
    private(set) var store = EKEventStore()
    public init() {}

    nonisolated static func status(_ type: EKEntityType) -> String {
        switch EKEventStore.authorizationStatus(for: type) {
        case .fullAccess: return "authorized"
        case .denied, .writeOnly: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "authorized"
        }
    }

    func requestAccess(_ type: EKEntityType) async {
        _ = try? await (type == .event ? store.requestFullAccessToEvents() : store.requestFullAccessToReminders())
        store = EKEventStore() // a store created before the grant keeps returning nothing
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    nonisolated static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func hex(_ c: CGColor?) -> JSONValue {
        guard let c, let rgb = NSColor(cgColor: c)?.usingColorSpace(.sRGB) else { return .null }
        return .string(String(format: "#%02x%02x%02x", Int(rgb.redComponent * 255), Int(rgb.greenComponent * 255), Int(rgb.blueComponent * 255)))
    }

    private func require(_ type: EKEntityType, _ name: String) throws {
        guard Self.status(type) == "authorized" else { throw FeatureError.failed("\(name) access has not been granted") }
    }

    public func calendarEvents(from: Date, to: Date) async throws -> JSONValue {
        try require(.event, "Calendar")
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
        return .array(store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.map { e in
            var o: [String: JSONValue] = [
                "id": .string("\(e.eventIdentifier ?? e.calendarItemIdentifier)@\(Int(e.startDate.timeIntervalSince1970))"),
                "title": .string(e.title ?? ""), "start": .string(Self.iso.string(from: e.startDate)), "end": .string(Self.iso.string(from: e.endDate)),
                "allDay": .bool(e.isAllDay), "calendar": .string(e.calendar?.title ?? ""), "color": Self.hex(e.calendar?.cgColor),
            ]
            if let l = e.location, !l.isEmpty { o["location"] = .string(l) }
            if let u = e.url { o["url"] = .string(u.absoluteString) }
            if let n = e.notes, !n.isEmpty { o["notes"] = .string(n) }
            return .object(o)
        })
    }

    public func reminderLists() async throws -> JSONValue {
        try require(.reminder, "Reminders")
        let def = store.defaultCalendarForNewReminders()?.calendarIdentifier
        return .array(store.calendars(for: .reminder).map { c in
            ["id": .string(c.calendarIdentifier), "title": .string(c.title), "color": Self.hex(c.cgColor), "isDefault": .bool(c.calendarIdentifier == def), "writable": .bool(c.allowsContentModifications)]
        })
    }

    static func describe(_ r: EKReminder) -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(r.calendarItemIdentifier), "title": .string(r.title ?? ""), "completed": .bool(r.isCompleted),
            "priority": .int(Int64(r.priority)), "listId": .string(r.calendar?.calendarIdentifier ?? ""), "listTitle": .string(r.calendar?.title ?? ""),
            "color": hex(r.calendar?.cgColor),
        ]
        if let comps = r.dueDateComponents, let date = Calendar.current.date(from: comps) {
            o["due"] = .string(iso.string(from: date))
            o["dueAllDay"] = .bool(comps.hour == nil)
        }
        if let d = r.completionDate { o["completionDate"] = .string(iso.string(from: d)) }
        if let n = r.notes, !n.isEmpty { o["notes"] = .string(n) }
        if let u = r.url { o["url"] = .string(u.absoluteString) }
        return .object(o)
    }

    public func reminders(listId: String?, includeCompleted: Bool) async throws -> JSONValue {
        try require(.reminder, "Reminders")
        var cals: [EKCalendar]?
        if let listId, !listId.isEmpty {
            guard let c = store.calendar(withIdentifier: listId) else { throw FeatureError.failed("Unknown reminders list") }
            cals = [c]
        }
        let predicate = includeCompleted ? store.predicateForReminders(in: cals) : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals)
        let s = store
        let found: [JSONValue] = await withCheckedContinuation { cont in
            s.fetchReminders(matching: predicate) { rs in cont.resume(returning: (rs ?? []).map(EventKitStore.describe)) }
        }
        return .array(found)
    }

    public func createReminder(_ p: JSONValue) async throws -> JSONValue {
        try require(.reminder, "Reminders")
        guard let title = p["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { throw FeatureError.invalidArguments("Missing title") }
        let r = EKReminder(eventStore: store)
        r.title = title
        if let notes = p["notes"]?.stringValue, !notes.isEmpty { r.notes = notes }
        if let listId = p["listId"]?.stringValue, !listId.isEmpty {
            guard let c = store.calendar(withIdentifier: listId) else { throw FeatureError.failed("Unknown reminders list") }
            r.calendar = c
        } else {
            guard let c = store.defaultCalendarForNewReminders() else { throw FeatureError.failed("No default reminders list") }
            r.calendar = c
        }
        if let dueRaw = p["due"]?.stringValue {
            guard let due = Self.parseDate(dueRaw) else { throw FeatureError.invalidArguments("Invalid due date") }
            let allDay = p["allDay"]?.boolValue ?? false
            let units: Set<Calendar.Component> = allDay ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute]
            var comps = Calendar.current.dateComponents(units, from: due)
            comps.timeZone = allDay ? nil : TimeZone.current
            r.dueDateComponents = comps
            if !allDay { r.addAlarm(EKAlarm(absoluteDate: due)) }
        }
        try store.save(r, commit: true)
        return Self.describe(r)
    }

    public func completeReminder(id: String, completed: Bool) async throws -> JSONValue {
        try require(.reminder, "Reminders")
        guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else { throw FeatureError.failed("Reminder not found") }
        r.isCompleted = completed
        try store.save(r, commit: true)
        return Self.describe(r)
    }

    public func deleteReminder(id: String) async throws -> JSONValue {
        try require(.reminder, "Reminders")
        guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else { throw FeatureError.failed("Reminder not found") }
        guard r.calendar?.allowsContentModifications != false else { throw FeatureError.failed("This reminders list is read-only") }
        try store.remove(r, commit: true)
        return ["id": .string(id), "deleted": true]
    }
}

/// In-memory EventKit for tests and headless driver runs (never touches the user's calendars/reminders).
/// Seed: {"lists":[…], "reminders":[…], "events":[…]} in the EventKitService JSON shapes. Headless runs use it
/// when GLIDE_EVENTKIT_FIXTURE points at such a file (see `fromEnvironment`).
@MainActor public final class FixtureEventKit: EventKitService {
    public private(set) var lists: [JSONValue]
    public private(set) var reminderItems: [JSONValue]
    public private(set) var events: [JSONValue]
    private var seq = 0

    public init(seed: JSONValue) {
        lists = seed["lists"]?.arrayValue ?? []
        reminderItems = seed["reminders"]?.arrayValue ?? []
        events = seed["events"]?.arrayValue ?? []
    }

    /// The fixture named by GLIDE_EVENTKIT_FIXTURE, only in headless runs.
    public static func fromEnvironment(headless: Bool, environment: [String: String] = ProcessInfo.processInfo.environment) -> FixtureEventKit? {
        guard headless, let p = environment["GLIDE_EVENTKIT_FIXTURE"], let data = FileManager.default.contents(atPath: p),
              let seed = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return FixtureEventKit(seed: seed)
    }

    public func calendarEvents(from: Date, to: Date) async throws -> JSONValue {
        .array(events.filter { e in
            guard let s = e["start"]?.stringValue.flatMap(EventKitStore.parseDate), let en = e["end"]?.stringValue.flatMap(EventKitStore.parseDate) else { return false }
            return en > from && s < to
        })
    }

    public func reminderLists() async throws -> JSONValue { .array(lists) }

    public func reminders(listId: String?, includeCompleted: Bool) async throws -> JSONValue {
        .array(reminderItems.filter { r in
            (includeCompleted || r["completed"]?.boolValue != true) && (listId.map { r["listId"]?.stringValue == $0 } ?? true)
        })
    }

    public func createReminder(_ p: JSONValue) async throws -> JSONValue {
        guard let title = p["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { throw FeatureError.invalidArguments("Missing title") }
        let list = p["listId"]?.stringValue.flatMap { id in lists.first { $0["id"]?.stringValue == id } } ?? lists.first { $0["isDefault"]?.boolValue == true } ?? lists.first
        guard let list else { throw FeatureError.failed("No default reminders list") }
        seq += 1
        var o: [String: JSONValue] = ["id": .string("fixture-\(seq)"), "title": .string(title), "completed": false, "priority": 0,
                                      "listId": list["id"] ?? "", "listTitle": list["title"] ?? "", "color": list["color"] ?? .null]
        if let due = p["due"]?.stringValue {
            guard EventKitStore.parseDate(due) != nil else { throw FeatureError.invalidArguments("Invalid due date") }
            o["due"] = .string(due)
            o["dueAllDay"] = .bool(p["allDay"]?.boolValue ?? false)
        }
        if let n = p["notes"]?.stringValue, !n.isEmpty { o["notes"] = .string(n) }
        reminderItems.append(.object(o))
        return .object(o)
    }

    public func completeReminder(id: String, completed: Bool) async throws -> JSONValue {
        guard let i = reminderItems.firstIndex(where: { $0["id"]?.stringValue == id }), case var .object(o) = reminderItems[i] else { throw FeatureError.failed("Reminder not found") }
        o["completed"] = .bool(completed)
        o["completionDate"] = completed ? .string(ISO8601DateFormatter().string(from: Date())) : .null
        reminderItems[i] = .object(o)
        return .object(o)
    }

    public func deleteReminder(id: String) async throws -> JSONValue {
        guard let i = reminderItems.firstIndex(where: { $0["id"]?.stringValue == id }) else { throw FeatureError.failed("Reminder not found") }
        reminderItems.remove(at: i)
        return ["id": .string(id), "deleted": true]
    }
}
