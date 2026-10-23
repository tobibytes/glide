import Foundation
import GlideCore

/// EventKit reminder (EventKitService JSON shape, same as the Electron helper's HelperReminder).
public struct ReminderItem: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var completed: Bool
    public var priority: Int
    public var listId: String
    public var listTitle: String
    public var color: String?
    public var due: String?
    public var dueAllDay: Bool?
    public var completionDate: String?
    public var notes: String?
    public var url: String?
    public init(id: String, title: String, completed: Bool = false, priority: Int = 0, listId: String = "", listTitle: String = "", color: String? = nil,
                due: String? = nil, dueAllDay: Bool? = nil, completionDate: String? = nil, notes: String? = nil, url: String? = nil) {
        self.id = id
        self.title = title
        self.completed = completed
        self.priority = priority
        self.listId = listId
        self.listTitle = listTitle
        self.color = color
        self.due = due
        self.dueAllDay = dueAllDay
        self.completionDate = completionDate
        self.notes = notes
        self.url = url
    }

    public static func from(_ v: JSONValue) -> ReminderItem? {
        guard let id = v["id"]?.stringValue else { return nil }
        return ReminderItem(id: id, title: v["title"]?.stringValue ?? "", completed: v["completed"]?.boolValue ?? false, priority: v["priority"]?.intValue ?? 0,
                            listId: v["listId"]?.stringValue ?? "", listTitle: v["listTitle"]?.stringValue ?? "", color: v["color"]?.stringValue,
                            due: v["due"]?.stringValue, dueAllDay: v["dueAllDay"]?.boolValue, completionDate: v["completionDate"]?.stringValue,
                            notes: v["notes"]?.stringValue, url: v["url"]?.stringValue)
    }
}

public struct ReminderList: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var color: String?
    public var isDefault: Bool
    public var writable: Bool
    public init(id: String, title: String, color: String? = nil, isDefault: Bool = false, writable: Bool = true) {
        self.id = id
        self.title = title
        self.color = color
        self.isDefault = isDefault
        self.writable = writable
    }
    public static func from(_ v: JSONValue) -> ReminderList? {
        guard let id = v["id"]?.stringValue else { return nil }
        return ReminderList(id: id, title: v["title"]?.stringValue ?? "", color: v["color"]?.stringValue, isDefault: v["isDefault"]?.boolValue ?? false,
                            writable: v["writable"]?.boolValue ?? true)
    }
}

/// A reminder about to be created ("title // notes #list tomorrow 9am" parsed).
public struct ReminderDraft: Hashable, Codable, Sendable {
    public var title: String
    public var due: String?
    public var allDay: Bool
    public var listId: String?
    public var notes: String?
    public var phrase: String?
}

/// Pure view-model (port of src/main/features/reminders/model.ts).
public enum RemindersModel {
    public enum Section: String, CaseIterable, Sendable { case overdue = "Overdue", today = "Today", upcoming = "Upcoming", noDue = "No Due Date", completed = "Completed" }

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }

    public static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    /// Overdue = timed and past, or all-day before today.
    public static func section(_ r: ReminderItem, now: Date, calendar: Calendar = .current) -> Section {
        if r.completed { return .completed }
        guard let due = date(r.due) else { return .noDue }
        let diff = ReminderDue.dayDiff(due, now, calendar: calendar)
        if diff < 0 || (r.dueAllDay != true && due < now) { return .overdue }
        return diff == 0 ? .today : .upcoming
    }

    static func prioRank(_ p: Int) -> Int { p > 0 ? p : 10 }

    public static func rows(_ list: [ReminderItem], now: Date, query: String = "", calendar: Calendar = .current) -> [(ReminderItem, Section)] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let order = Section.allCases
        return list.filter { q.isEmpty || "\($0.title) \($0.notes ?? "") \($0.listTitle)".lowercased().contains(q) }
            .map { ($0, section($0, now: now, calendar: calendar)) }
            .sorted { a, b in
                let sa = order.firstIndex(of: a.1) ?? 0, sb = order.firstIndex(of: b.1) ?? 0
                if sa != sb { return sa < sb }
                if a.1 == .completed { return (date(a.0.completionDate) ?? .distantPast) > (date(b.0.completionDate) ?? .distantPast) }
                let da = date(a.0.due) ?? .distantFuture, db = date(b.0.due) ?? .distantFuture
                if da != db { return da < db }
                if prioRank(a.0.priority) != prioRank(b.0.priority) { return prioRank(a.0.priority) < prioRank(b.0.priority) }
                return a.0.title < b.0.title
            }
    }

    public static func countDue(_ list: [ReminderItem], now: Date) -> (overdue: Int, today: Int) {
        var o = 0, t = 0
        for r in list {
            switch section(r, now: now) {
            case .overdue: o += 1
            case .today: t += 1
            default: break
            }
        }
        return (o, t)
    }

    /// Requested list if writable, else the default, else the first writable.
    public static func pickList(_ lists: [ReminderList], _ wanted: String?) -> ReminderList? {
        let w = lists.filter(\.writable)
        return w.first { $0.id == wanted } ?? w.first(where: \.isDefault) ?? w.first
    }

    /// "#work buy paper" → list "Work…". Returns the text without the tag.
    public static func extractListTag(_ text: String, _ lists: [ReminderList]) -> (text: String, listId: String?) {
        guard let re = try? NSRegularExpression(pattern: #"(?:^|\s)#([\p{L}\p{N}_-]+)"#),
              let m = re.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) else { return (text, nil) }
        let ns = text as NSString
        let tag = ns.substring(with: m.range(at: 1)).lowercased()
        guard let list = lists.first(where: { $0.title.lowercased().replacingOccurrences(of: " ", with: "") == tag }) ?? lists.first(where: { $0.title.lowercased().hasPrefix(tag) }) else {
            return (text, nil)
        }
        let rest = (ns.substring(to: m.range.location) + ns.substring(from: m.range.location + m.range.length))
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return (rest, list.id)
    }

    /// "title // notes"
    public static func splitNotes(_ text: String) -> (text: String, notes: String?) {
        guard let r = text.range(of: " // ") else { return (text, nil) }
        let notes = text[r.upperBound...].trimmingCharacters(in: .whitespaces)
        return (String(text[..<r.lowerBound]), notes.isEmpty ? nil : notes)
    }

    public static func draft(_ text: String, lists: [ReminderList], now: Date = Date(), calendar: Calendar = .current) -> ReminderDraft {
        let (body, notes) = splitNotes(text)
        let tagged = extractListTag(body, lists)
        let p = ReminderDue.parse(tagged.text, now: now, calendar: calendar)
        return ReminderDraft(title: p.title, due: p.due.map(iso), allDay: p.allDay, listId: tagged.listId, notes: notes, phrase: p.phrase)
    }

    public static func priorityMarks(_ p: Int) -> String? { p <= 0 ? nil : p <= 4 ? "!!!" : p == 5 ? "!!" : "!" }
}
