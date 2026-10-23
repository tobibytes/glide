import AppKit
import GlideCore
import GlideSystem
import GlideUI
import SwiftUI

/// EventKit status as the views show it.
public enum EventKitAccess: String, Sendable {
    case ok, notDetermined, denied, restricted, unavailable, error
}

/// Reminders (src/main/features/reminders): "remind <text> tomorrow 9am" in the root search with
/// natural-language due dates (ReminderDue), a Reminders view (lists, Overdue/Today/Upcoming, ⏎ completes,
/// ⌘N new) and a create view. Access is requested only from the explicit "Grant Access" row.
@MainActor public final class RemindersFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "reminders"
    public let title = "Reminders"
    private weak var context: FeatureContext?
    var now: () -> Date = { Date() }
    /// Injected in tests; else GLIDE_EVENTKIT_FIXTURE (headless) or the system service.
    var eventKitOverride: (any EventKitService)?
    private var fixture: FixtureEventKit?
    private(set) var status: EventKitAccess = .notDetermined
    private(set) var message: String?
    private(set) var lists: [ReminderList] = []
    private(set) var reminders: [ReminderItem] = []
    private var listFilter: String?
    private var counts = (overdue: 0, today: 0)
    private var createListId: String?

    lazy var listModel = N7ListModel(placeholder: "Search reminders…", emptyTitle: "All done", emptySubtitle: "⌘N to add a reminder") { [weak self] q in self?.listRows(q) ?? [] }
    lazy var createModel = N7ListModel(placeholder: "Reminder, e.g. “Call mom tomorrow 9am #family // notes”", emptyTitle: "Reminders") { [weak self] q in self?.createRows(q) ?? [] }

    public init() {
        listModel.banner = { [weak self] in self?.banner(filter: true) }
        createModel.banner = { [weak self] in self?.banner(filter: false) }
    }

    func banner(filter: Bool) -> (String, Bool)? {
        if status != .ok { return message.map { ($0, status == .error) } }
        guard filter, let f = listFilter, let l = lists.first(where: { $0.id == f }) else { return nil }
        return ("List: \(l.title) · ⌘K to change", false)
    }

    var eventKit: (any EventKitService)? { eventKitOverride ?? fixture ?? context?.services.eventKit }

    var defaultListSetting: String { context?.settings(defaults: [:])["defaultListId"]?.stringValue ?? "" }
    var showCompleted: Bool { context?.settings(defaults: [:])["showCompleted"]?.boolValue ?? false }

    public func start(context: FeatureContext) async {
        self.context = context
        fixture = FixtureEventKit.fromEnvironment(headless: context.services.isHeadless)
        // Only refresh counts when access already exists; never prompts.
        if access().0 == .ok { await load(); context.refreshCatalogue() }
    }

    /// Access without prompting.
    func access() -> (EventKitAccess, String?) {
        if eventKitOverride != nil || fixture != nil { return (.ok, nil) }
        guard let p = context?.services.permissions.status() else { return (.error, "Not ready") }
        switch p.reminders {
        case "authorized": return (.ok, nil)
        case "notDetermined": return (.notDetermined, "Glide needs permission to read and create your reminders.")
        case "restricted": return (.restricted, "Reminders access is restricted on this Mac.")
        default: return (.denied, "Reminders access is turned off for Glide.")
        }
    }

    static func failure(_ error: Error) -> (EventKitAccess, String) {
        let m = error.localizedDescription
        if m.contains("headless") { return (.unavailable, "Reminders are not available here (\(m)).") }
        if m.contains("not been granted") { return (.notDetermined, m) }
        return (.error, m)
    }

    @discardableResult func load() async -> EventKitAccess {
        let a = access()
        status = a.0
        message = a.1
        guard a.0 == .ok, let ek = eventKit else {
            lists = []
            reminders = []
            refresh()
            return status
        }
        do {
            let l = try await ek.reminderLists()
            let r = try await ek.reminders(listId: nil, includeCompleted: showCompleted)
            lists = (l.arrayValue ?? []).compactMap(ReminderList.from)
            reminders = (r.arrayValue ?? []).compactMap(ReminderItem.from)
            counts = RemindersModel.countDue(reminders, now: now())
        } catch {
            (status, message) = Self.failure(error)
            lists = []
            reminders = []
        }
        refresh()
        return status
    }

    private func refresh() {
        listModel.changed()
        createModel.changed()
    }

    struct CreateResult {
        var ok: Bool
        var error: String?
        var status: EventKitAccess?
        var reminder: ReminderItem?
    }

    func create(_ d: ReminderDraft) async -> CreateResult {
        let title = d.title.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return CreateResult(ok: false, error: "Type a title for the reminder") }
        let a = access()
        guard a.0 == .ok, let ek = eventKit else { return CreateResult(ok: false, error: a.1, status: a.0) }
        var p: [String: JSONValue] = ["title": .string(title)]
        if let due = d.due { p["due"] = .string(due); p["allDay"] = .bool(d.allDay) }
        let listId = d.listId ?? (defaultListSetting.isEmpty ? nil : defaultListSetting)
        if lists.isEmpty { await load() }
        if let listId, lists.contains(where: { $0.id == listId }) { p["listId"] = .string(listId) }
        if let n = d.notes, !n.isEmpty { p["notes"] = .string(n) }
        do {
            let r = try await ek.createReminder(.object(p))
            await load()
            context?.refreshCatalogue()
            return CreateResult(ok: true, reminder: ReminderItem.from(r))
        } catch {
            let f = Self.failure(error)
            return CreateResult(ok: false, error: f.1, status: f.0)
        }
    }

    func complete(_ r: ReminderItem, _ completed: Bool) async -> String? {
        guard let ek = eventKit else { return "Not ready" }
        do {
            _ = try await ek.completeReminder(id: r.id, completed: completed)
            if let i = reminders.firstIndex(where: { $0.id == r.id }) {
                reminders[i].completed = completed
                reminders[i].completionDate = RemindersModel.iso(now())
            }
            await load()
            context?.refreshCatalogue()
            return nil
        } catch {
            return Self.failure(error).1
        }
    }

    /// Removes the reminder from Reminders (EKEventStore.remove). nil = deleted, else the error message.
    func delete(id: String) async -> String? {
        guard access().0 == .ok, let ek = eventKit else { return access().1 ?? "Not ready" }
        do {
            _ = try await ek.deleteReminder(id: id)
            reminders.removeAll { $0.id == id }
            await load()
            context?.refreshCatalogue()
            return nil
        } catch {
            return Self.failure(error).1
        }
    }

    /// Explicit user action only (the "Grant Access" row).
    func requestAccess() async {
        _ = await context?.services.permissions.request(.reminders)
        await load()
        context?.refreshCatalogue()
    }

    // MARK: catalogue

    var badge: String {
        if counts.overdue == 0 && counts.today == 0 { return "Overdue, today and upcoming" }
        return [counts.overdue > 0 ? "\(counts.overdue) overdue" : nil, counts.today > 0 ? "\(counts.today) due today" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    public func items() -> [SearchItem] {
        [SearchItem(id: "reminders:view", kind: .command, title: "My Reminders", subtitle: badge, icon: .symbol("checklist", tint: "#FF9F0A"),
                    keywords: ["reminders", "todo", "tasks", "due", "overdue"], feature: id, data: ["action": "view"], kindLabel: "Reminders"),
         SearchItem(id: "reminders:create", kind: .command, title: "Create Reminder", subtitle: "Type “remind <text> tomorrow 9am” in the search field, or open the form",
                    icon: .symbol("bell.badge", tint: "#FF9F0A"), keywords: ["new reminder", "add reminder", "remind me", "todo"], feature: id, data: ["action": "new"], kindLabel: "Reminders")]
    }

    static let createRE = try? NSRegularExpression(pattern: #"^(?:create\s+reminder|new\s+reminder|add\s+reminder|reminder|remind\s+me(?:\s+to)?|remind)\s+(.+)$"#, options: .caseInsensitive)

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        let q = query.trimmed
        guard let m = Self.createRE?.firstMatch(in: q, range: NSRange(location: 0, length: (q as NSString).length)) else { return [] }
        let text = (q as NSString).substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
        guard text.count >= 2 else { return [] }
        let d = RemindersModel.draft(text, lists: lists, now: now())
        let list = d.listId.flatMap { id in lists.first { $0.id == id }?.title }
        let due = ReminderDue.preview(ParsedReminder(title: d.title, due: d.due.flatMap(RemindersModel.date), allDay: d.allDay), now: now())
        let item = SearchItem(id: "reminders:create-from-query", kind: .command, title: "Create Reminder “\(d.title)”", subtitle: [due, list].compactMap { $0 }.joined(separator: " · "),
                              icon: .symbol("bell.badge", tint: "#FF9F0A"), keywords: ["reminder", "remind", "todo"], feature: id,
                              data: ["action": "createDraft", "draft": N7JSON.value(d), "noUsage": true], kindLabel: "Reminders")
        return [ScoredItem(item: item, score: 2000, matchScore: 2000, matchKind: .keyword)]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "createDraft": return [.init(id: "create", title: "Create Reminder", shortcut: "↩", icon: "bell.badge"), .init(id: "edit", title: "Edit Before Creating", shortcut: "⌘↩", icon: "pencil")]
        case "new": return [.init(id: "new", title: "New Reminder", shortcut: "↩", icon: "plus")]
        default: return [.init(id: "view", title: "Show Reminders", shortcut: "↩", icon: "checklist")]
        }
    }

    private var pendingDraftText: String?

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let draft = scored.item.data?["draft"].flatMap { N7JSON.decode($0, as: ReminderDraft.self) }
        switch action {
        case "view":
            Task { await load() }
            return push("list")
        case "new":
            createListId = nil
            pendingDraftText = nil
            Task { await load() }
            return push("create")
        case "edit":
            pendingDraftText = draft.map { [$0.title, $0.phrase].compactMap { $0 }.joined(separator: " ") }
            Task { await load() }
            return push("create")
        case "create":
            guard let draft else { return .error("Nothing to create") }
            let r = await create(draft)
            if r.ok { return .hide(message: "Reminder created: \(r.reminder?.title ?? draft.title)") }
            if let s = r.status, s != .error {
                pendingDraftText = [draft.title, draft.phrase].compactMap { $0 }.joined(separator: " ")
                await load()
                return push("create")
            }
            return .error(r.error ?? "Could not create the reminder")
        default: return .error("Unknown action \(action)")
        }
    }

    private func push(_ name: String) -> ActionResult {
        let m = name == "list" ? listModel : createModel
        n7AfterUpdate { m.syncHost() }
        return .pushView(ViewID(feature: id, name: name))
    }

    // MARK: rows

    private func accessRows() -> [N7Row] {
        let retry = N7Row(id: "retry", icon: .symbol("arrow.clockwise"), title: "Try Again", subtitle: status == .unavailable ? "Not available in this run" : "Reload reminders",
                          actions: [N7Action("retry", "Try Again", shortcut: "↩", icon: "arrow.clockwise") { [weak self] in await self?.load() }])
        switch status {
        case .notDetermined:
            return [N7Row(id: "grant", icon: .symbol("lock.open", tint: "#FF9F0A"), title: "Grant Reminders Access", subtitle: "macOS will ask once",
                          actions: [N7Action("grant", "Grant Reminders Access", shortcut: "↩", icon: "lock.open") { [weak self] in await self?.requestAccess() }])]
        case .denied, .restricted:
            return [N7Row(id: "settings", icon: .symbol("gearshape"), title: "Open Privacy Settings", subtitle: "Allow Glide under Privacy & Security → Reminders",
                          actions: [N7Action("settings", "Open Privacy Settings", shortcut: "↩", icon: "gearshape") { [weak self] in
                              if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders") { _ = self?.context?.services.workspace.open(url: u) }
                          }]), retry]
        default: return [retry]
        }
    }

    func listRows(_ query: String) -> [N7Row] {
        guard status == .ok else { return accessRows() }
        let t = now()
        let source = listFilter.map { f in reminders.filter { $0.listId == f } } ?? reminders
        let common: [N7Action] = [
            N7Action("new", "New Reminder", shortcut: "⌘N", icon: "plus") { [weak self] in
                guard let self else { return }
                self.createListId = self.listFilter
                self.pendingDraftText = nil
                LauncherHosts.current?.push(ViewID(feature: self.id, name: "create"), payload: .null)
                n7AfterUpdate { self.createModel.syncHost() }
            },
            N7Action("reload", "Reload", shortcut: "⌘R", icon: "arrow.clockwise") { [weak self] in await self?.load() },
            N7Action("openApp", "Open Reminders App", shortcut: "⌘O", icon: "arrow.up.forward.app") { [weak self] in
                _ = self?.context?.services.workspace.launchApplication("com.apple.reminders")
                self?.context?.hideLauncher()
            },
            N7Action("all", "Show All Lists\(listFilter == nil ? " ✓" : "")", icon: "tray.2") { [weak self] in self?.listFilter = nil },
        ] + lists.enumerated().map { i, l in
            N7Action("list:\(l.id)", "Show “\(l.title)”\(listFilter == l.id ? " ✓" : "")", shortcut: i < 9 ? "⌘\(i + 1)" : nil, icon: "list.bullet") { [weak self] in self?.listFilter = l.id }
        }
        let rows = RemindersModel.rows(source, now: t, query: query).map { r, section -> N7Row in
            let due = r.due.flatMap(RemindersModel.date).map { ReminderDue.describe($0, allDay: r.dueAllDay == true, now: t) }
            let title = (RemindersModel.priorityMarks(r.priority).map { "\($0) " } ?? "") + r.title
            return N7Row(id: r.id, section: section.rawValue, icon: .symbol(r.completed ? "checkmark.circle.fill" : "circle", tint: r.color ?? "#FF9F0A"), title: title,
                         subtitle: r.notes?.components(separatedBy: "\n").first, tag: section == .overdue ? due : nil,
                         trailing: [section == .overdue ? nil : due, r.listTitle].compactMap { $0 }.joined(separator: " · "),
                         actions: [N7Action("toggle", r.completed ? "Mark as Not Completed" : "Complete", shortcut: "↩", icon: "checkmark.circle") { [weak self] in
                             guard let self else { return }
                             if let err = await self.complete(r, !r.completed) { self.listModel.host?.toast(err, style: .error) } else {
                                 self.listModel.host?.toast(r.completed ? "Marked as not completed" : "Completed “\(r.title)”", style: .success)
                             }
                         }] + common + [N7Action("copy", "Copy Title", shortcut: "⌘C", icon: "doc.on.doc") { [weak self] in
                             self?.context?.services.pasteboard.setString(r.title, html: nil, transient: false)
                             LauncherHosts.current?.toast("Copied", style: .success)
                         },
                         // Destructive: ⌃X / vim x need a second press (N7ListModel.confirmDelete).
                         N7Action("delete", "Delete Reminder", shortcut: "⌃X", icon: "trash", destructive: true) { [weak self] in
                             guard let self else { return }
                             if let err = await self.delete(id: r.id) { self.listModel.host?.toast(err, style: .error) } else {
                                 self.listModel.host?.toast("Deleted “\(r.title)”", style: .success)
                             }
                         }])
        }
        if rows.isEmpty {
            return [N7Row(id: "empty", icon: .symbol("party.popper", tint: "#30D158"), title: query.isEmpty ? "All done" : "No matching reminders", subtitle: "⌘N to add a reminder", actions: common)]
        }
        return rows
    }

    func createRows(_ query: String) -> [N7Row] {
        guard status == .ok else { return accessRows() }
        let text = query.isEmpty ? (pendingDraftText ?? "") : query
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            return [N7Row(id: "hint", icon: .symbol("bell.badge", tint: "#FF9F0A"), title: "Type the reminder in the search field",
                          subtitle: "Dates like “tomorrow 9am”, “in 2 hours”, “next friday”; #list picks a list; “ // ” starts notes")]
        }
        let t = now()
        let d = RemindersModel.draft(text, lists: lists, now: t)
        let def = RemindersModel.pickList(lists, d.listId ?? createListId ?? (defaultListSetting.isEmpty ? nil : defaultListSetting))
        let preview = [ReminderDue.preview(ParsedReminder(title: d.title, due: d.due.flatMap(RemindersModel.date), allDay: d.allDay), now: t), d.notes.map { "Notes: \($0)" }]
            .compactMap { $0 }.joined(separator: " · ")
        func createAction(_ listId: String?, _ listTitle: String?) -> N7Action {
            N7Action("create", listTitle.map { "Create in “\($0)”" } ?? "Create Reminder", shortcut: "↩", icon: "bell.badge") { [weak self] in
                guard let self else { return }
                var draft = d
                draft.listId = listId
                let r = await self.create(draft)
                if r.ok {
                    self.pendingDraftText = nil
                    LauncherHosts.current?.toast("Reminder created: \(r.reminder?.title ?? d.title)", style: .success)
                    LauncherHosts.current?.close()
                } else {
                    LauncherHosts.current?.toast(r.error ?? "Could not create the reminder", style: .error)
                }
            }
        }
        var rows = [N7Row(id: "create", icon: .symbol("bell.badge", tint: "#FF9F0A"), title: d.title.isEmpty ? "Untitled" : d.title, subtitle: preview, trailing: def?.title,
                          actions: [createAction(def?.id, def?.title)])]
        for l in lists where l.writable && l.id != def?.id {
            rows.append(N7Row(id: "in:\(l.id)", section: "Add to Another List", icon: .symbol("list.bullet", tint: l.color), title: "Add to \(l.title)", subtitle: preview,
                              actions: [createAction(l.id, l.title)]))
        }
        return rows
    }

    private func model(_ v: ViewID) -> N7ListModel? { v.name == "list" ? listModel : v.name == "create" ? createModel : nil }

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard let m = model(id) else { return nil }
        n7AfterUpdate { m.syncHost() }
        return AnyView(N7ListView(model: m))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { model(view)?.handleKey(key) ?? false }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { model(view)?.handle(command) ?? false }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Reminders", symbol: "checklist", order: 116) { [weak self] in
            AnyView(RemindersSettingsView(lists: self?.lists ?? [], defaultList: self?.defaultListSetting ?? "", showCompleted: self?.showCompleted ?? false, status: self?.status.rawValue ?? "") { patch in
                self?.context?.setSettings(patch)
                Task { await self?.load() }
            })
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "state":
            await load()
            return ["status": .string(status.rawValue), "message": message.map(JSONValue.string) ?? .null, "lists": N7JSON.value(lists), "reminders": N7JSON.value(reminders),
                    "defaultListId": RemindersModel.pickList(lists, defaultListSetting.isEmpty ? nil : defaultListSetting).map { .string($0.id) } ?? .null]
        case "parse": return N7JSON.value(RemindersModel.draft(args["text"]?.stringValue ?? args.stringValue ?? "", lists: lists, now: now()))
        case "create":
            let d = N7JSON.decode(args, as: ReminderDraft.self) ?? ReminderDraft(title: args["title"]?.stringValue ?? "", due: args["due"]?.stringValue, allDay: args["allDay"]?.boolValue ?? false,
                                                                                   listId: args["listId"]?.stringValue, notes: args["notes"]?.stringValue, phrase: nil)
            let r = await create(d)
            return ["ok": .bool(r.ok), "error": r.error.map(JSONValue.string) ?? .null, "status": r.status.map { .string($0.rawValue) } ?? .null, "reminder": N7JSON.value(r.reminder)]
        case "complete":
            guard let r = reminders.first(where: { $0.id == args["id"]?.stringValue }) else { return ["ok": false, "error": "Invalid reminder"] }
            let err = await complete(r, args["completed"]?.boolValue != false)
            return ["ok": .bool(err == nil), "error": err.map(JSONValue.string) ?? .null]
        case "delete":
            // Agent / MCP `delete_reminder` (and the agent's undo of create_reminder). Accepts {id} or a bare id string.
            guard let rid = (args["id"]?.stringValue ?? args.stringValue)?.trimmingCharacters(in: .whitespaces), !rid.isEmpty else { return ["ok": false, "error": "Missing id"] }
            if reminders.isEmpty { await load() }
            let title = reminders.first { $0.id == rid }?.title
            let err = await delete(id: rid)
            return ["ok": .bool(err == nil), "error": err.map(JSONValue.string) ?? .null, "message": err == nil ? .string("Deleted reminder “\(title ?? rid)”") : .null]
        case "setSettings":
            var p: [String: JSONValue] = [:]
            if let v = args["defaultListId"]?.stringValue { p["defaultListId"] = .string(v) }
            if let v = args["showCompleted"]?.boolValue { p["showCompleted"] = .bool(v) }
            context?.setSettings(p)
            return ["defaultListId": .string(defaultListSetting), "showCompleted": .bool(showCompleted)]
        case "viewState": return model(ViewID(feature: id, name: args["view"]?.stringValue ?? "list"))?.snapshot() ?? .null
        case "viewAction": return .bool(await model(ViewID(feature: id, name: args["view"]?.stringValue ?? "list"))?.run(actionId: args["id"]?.stringValue ?? "") ?? false)
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

struct RemindersSettingsView: View {
    let lists: [ReminderList]
    @State var defaultList: String
    @State var showCompleted: Bool
    let status: String
    let onChange: ([String: JSONValue]) -> Void
    var body: some View {
        Form {
            Section("Reminders") {
                Picker("Default list", selection: $defaultList) {
                    Text("Reminders default").tag("")
                    ForEach(lists.filter(\.writable)) { Text($0.title).tag($0.id) }
                }
                .onChange(of: defaultList) { _, v in onChange(["defaultListId": .string(v)]) }
                Toggle("Show completed reminders", isOn: $showCompleted).onChange(of: showCompleted) { _, v in onChange(["showCompleted": .bool(v)]) }
                N7SettingsNote(text: status == "ok" ? "Type “remind call mom tomorrow 9am #family” in the launcher." : "Open My Reminders in the launcher and choose Grant Access.")
            }
        }
        .formStyle(.grouped)
    }
}
