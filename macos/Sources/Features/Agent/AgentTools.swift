import Foundation
import GlideCore

/// The agent's core tools (tools.ts): JSON schemas, validation, a plain-English summary of exactly what each
/// call will do, the implementation over AgentCapabilities and, where possible, an undo and a workflow step.
@MainActor enum AgentTools {
    nonisolated static let planTool = "plan"

    /// Window actions (Services.swift WindowService) with titles.
    static let windowActions: [(String, String)] = [
        ("left-half", "Left Half"), ("right-half", "Right Half"), ("top-half", "Top Half"), ("bottom-half", "Bottom Half"),
        ("top-left", "Top Left"), ("top-right", "Top Right"), ("bottom-left", "Bottom Left"), ("bottom-right", "Bottom Right"),
        ("left-third", "Left Third"), ("center-third", "Center Third"), ("right-third", "Right Third"),
        ("left-two-thirds", "Left Two Thirds"), ("right-two-thirds", "Right Two Thirds"), ("maximize", "Maximize"),
        ("almost-maximize", "Almost Maximize"), ("center", "Center"), ("reasonable-size", "Reasonable Size"),
        ("make-larger", "Make Larger"), ("make-smaller", "Make Smaller"), ("next-display", "Next Display"),
        ("previous-display", "Previous Display"), ("restore", "Restore"), ("minimize", "Minimize"), ("toggle-fullscreen", "Toggle Fullscreen"),
    ]

    static func formatDuration(_ ms: Double) -> String {
        let total = Int((ms / 1000).rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        let parts = [h > 0 ? "\(h) h" : "", m > 0 ? "\(m) min" : "", s > 0 ? "\(s) s" : ""].filter { !$0.isEmpty }
        return parts.isEmpty ? "0 s" : parts.joined(separator: " ")
    }

    static func timerDuration(_ ms: Double) -> String {
        let t = Int((ms / 1000).rounded())
        let h = t / 3600, m = (t % 3600) / 60, s = t % 60
        let parts = [h > 0 ? "\(h)h" : "", m > 0 ? "\(m)m" : "", s > 0 ? "\(s)s" : ""].filter { !$0.isEmpty }
        return parts.isEmpty ? "1s" : parts.joined(separator: " ")
    }

    /// Deterministic order (the tool list is part of the cached prompt prefix).
    static func all() -> [AgentTool] {
        [plan(), searchCatalogue(), executeItem(), listWorkflows(), runWorkflow(), windowAction(), openApp(), openURL(), openFile(),
         startTimer(), createNote(), searchNotes(), openNote(), getClipboard(), copyToClipboard(), getSelectedText(), convert(), calendarEvents()]
            + AgentToolsExtra.all()
    }

    static func q(_ s: String) -> String { AgentText.quote(s) }

    // MARK: tools

    static func plan() -> AgentTool {
        agentDefine(
            name: planTool, title: "Plan",
            description: "Show the user a short plan before a request that needs several actions (2-8 short steps, e.g. \"Find the Standup workflow\", \"Run it\"). Call it once, first, together with the first actions. Not needed for single actions or questions.",
            mutating: false,
            schema: agentSchema(["steps": ["type": "array", "items": ["type": "string"], "description": "Short imperative steps, in order"]], required: ["steps"]),
            parse: { a -> [String] in
                guard let raw = a.input["steps"]?.arrayValue else { throw AgentArgs.Bad(message: "\"steps\" must be an array of strings") }
                let steps = raw.compactMap(\.stringValue).map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(160)) }.filter { !$0.isEmpty }
                if steps.isEmpty { throw AgentArgs.Bad(message: "Give at least one step") }
                return Array(steps.prefix(8))
            },
            describe: { s, _ in "Plan \(AgentText.plural(s.count, "step"))" },
            run: { _, _ in AgentToolOutput(text: "The plan is shown to the user. Carry it out now.") })
    }

    static func searchCatalogue() -> AgentTool {
        agentDefine(
            name: "search_catalogue", title: "Search Glide",
            description: "Search everything the Glide launcher can run: apps, built-in commands (timers, window management, notes, system commands, AI commands, settings), workflows, quicklinks and snippets. Returns item ids for execute_item. Use short keyword queries such as \"timer\", \"safari\" or \"lock screen\".",
            mutating: false,
            schema: agentSchema(["query": agentProp("string", "Search text, as a person would type it into the launcher"),
                                 "limit": agentProp("integer", "Maximum results (1-20, default 8)")], required: ["query"]),
            parse: { a in (try a.req("query", max: 200), a.int("limit", 8, 1, 20)) },
            describe: { a, _ in "Search Glide for \(q(a.0))" },
            run: { a, caps in
                let hits = await caps.search(a.0, limit: a.1)
                if hits.isEmpty { return AgentToolOutput(text: "No items match \(q(a.0)).") }
                return AgentToolOutput(text: AgentText.json(.array(hits.map(\.json))))
            })
    }

    static func executeItem() -> AgentTool {
        agentDefine(
            name: "execute_item", title: "Run Glide Item",
            description: "Run one launcher item by the id returned from search_catalogue, exactly as if the user chose it (opens an app, runs a command, workflow or quicklink). Pass argument only for items with acceptsArgument.",
            mutating: true,
            schema: agentSchema(["id": agentProp("string", "Item id from search_catalogue"), "argument": agentProp("string", "Text argument for items that accept one")], required: ["id"]),
            parse: { a -> (String, String?) in
                let id = try a.req("id", max: 2000)
                let arg = try a.str("argument", max: 2000)
                if LiveAgentCapabilities.blockedPrefixes.contains(where: { id.hasPrefix($0) }) { throw AgentArgs.Bad(message: "The agent cannot run itself") }
                return (id, arg)
            },
            describe: { a, caps in
                let hit = caps.findItem(a.0)
                let name = hit.map { "\(q($0.title))\($0.subtitle.map { " (\($0))" } ?? "")" } ?? "item \(a.0)"
                return "Run \(name)\(a.1.map { " with \(q($0))" } ?? "")"
            },
            run: { a, caps in
                guard let hit = caps.findItem(a.0) else { throw AgentToolFailure("No item with id \(a.0). Search the catalogue first.") }
                let text = try await caps.executeItem(a.0, argument: a.1).text("Done")
                return AgentToolOutput(text: text, workflow: caps.workflowForItem(a.0, argument: a.1, title: hit.title).map { [$0] })
            })
    }

    static func listWorkflows() -> AgentTool {
        agentDefine(
            name: "list_workflows", title: "List Workflows",
            description: "List the user's Glide workflows (Shortcuts-style automations) with their ids.",
            mutating: false, schema: agentSchema(),
            parse: { _ in () }, describe: { _, _ in "List workflows" },
            run: { _, caps in
                let list = caps.listWorkflows()
                if list.isEmpty { return AgentToolOutput(text: "The user has no workflows.") }
                return AgentToolOutput(text: AgentText.json(.array(list.map { w in
                    var o: [String: JSONValue] = ["id": .string(w.id), "name": .string(w.name)]
                    if let d = w.description, !d.isEmpty { o["description"] = .string(d) }
                    if w.acceptsInput == true { o["acceptsInput"] = true }
                    return .object(o)
                })))
            })
    }

    static func runWorkflow() -> AgentTool {
        agentDefine(
            name: "run_workflow", title: "Run Workflow",
            description: "Run one of the user's workflows by id (from list_workflows), optionally with input text.",
            mutating: true,
            schema: agentSchema(["id": agentProp("string"), "input": agentProp("string", "Input text for workflows that accept it")], required: ["id"]),
            parse: { a in (try a.req("id", max: 200), try a.str("input", max: 4000)) },
            describe: { a, caps in
                let wf = caps.listWorkflows().first { $0.id == a.0 }
                return "Run workflow \(wf.map { q($0.name) } ?? a.0)\(a.1.map { " with input \(q($0))" } ?? "")"
            },
            run: { a, caps in
                guard caps.listWorkflows().contains(where: { $0.id == a.0 }) else { throw AgentToolFailure("No workflow with id \(a.0)") }
                let r = await caps.runWorkflow(a.0, input: a.1)
                if !r.ok { throw AgentToolFailure(r.error ?? "Workflow failed") }
                let text = r.result.map { "Workflow finished. Result: \(AgentText.clip($0, 2000))" } ?? "Workflow finished."
                return AgentToolOutput(text: text, workflow: [AgentWorkflowStep(type: "runWorkflow", params: ["workflowId": a.0, "input": a.1 ?? ""])])
            })
    }

    static func windowAction() -> AgentTool {
        let ids = windowActions.map(\.0)
        return agentDefine(
            name: "window_action", title: "Move Window",
            description: "Resize or move the front window of an app (like Rectangle). Give app to bring that app to the front first (e.g. \"Safari\"); otherwise the app that was frontmost before Glide is used.",
            mutating: true,
            schema: agentSchema(["action": agentProp("string", "Window layout", enumValues: ids), "app": agentProp("string", "App name to focus first, e.g. \"Notes\"")], required: ["action"]),
            parse: { a -> (String, String?) in
                guard let action = a.input["action"]?.stringValue, ids.contains(action) else {
                    throw AgentArgs.Bad(message: "\"action\" must be one of: \(ids.joined(separator: ", "))")
                }
                return (action, try a.str("app", max: 200))
            },
            describe: { a, _ in
                let title = windowActions.first { $0.0 == a.0 }?.1 ?? a.0
                return "\(a.1.map { "Bring \(q($0)) to the front and move its window" } ?? "Move the front window") to \(title)"
            },
            run: { a, caps in
                let before = await caps.windowSnapshot()
                let text = try await caps.windowAction(a.0, app: a.1).text("Window moved")
                let undo = before.map { snap in AgentUndo(summary: "Put the windows back where they were") { try await caps.restoreWindows(snap).text("Windows restored") } }
                let title = windowActions.first { $0.0 == a.0 }?.1 ?? a.0
                var wf: [AgentWorkflowStep] = []
                if let app = a.1 { wf += [AgentWorkflowStep(type: "openApp", params: ["app": app]), AgentWorkflowStep(type: "wait", params: ["seconds": "0.5"])] }
                wf.append(AgentWorkflow.runItem("windows.\(a.0)", label: title))
                return AgentToolOutput(text: text, undo: undo, workflow: wf)
            })
    }

    static func openURL() -> AgentTool {
        agentDefine(
            name: "open_url", title: "Open URL", description: "Open an http(s) or mailto: URL in the default browser or mail app.",
            mutating: true, schema: agentSchema(["url": agentProp("string")], required: ["url"]),
            parse: { a -> String in
                let raw = try a.req("url", max: 4000).trimmingCharacters(in: .whitespacesAndNewlines)
                guard let u = URL(string: raw), let scheme = u.scheme?.lowercased() else { throw AgentArgs.Bad(message: "Not a valid URL") }
                guard ["http", "https", "mailto"].contains(scheme) else { throw AgentArgs.Bad(message: "Only http, https and mailto URLs can be opened") }
                if scheme != "mailto" && (u.host ?? "").isEmpty { throw AgentArgs.Bad(message: "Not a valid URL") }
                return u.absoluteString
            },
            describe: { u, _ in "Open \(u)" },
            run: { u, caps in AgentToolOutput(text: try caps.openURL(u).text("Opened \(u)"), workflow: [AgentWorkflowStep(type: "openUrl", params: ["url": u])]) })
    }

    static func openApp() -> AgentTool {
        agentDefine(
            name: "open_app", title: "Open App", description: "Open (or bring to the front) a Mac app by name, e.g. \"Safari\" or \"Notes\".",
            mutating: true, schema: agentSchema(["name": agentProp("string")], required: ["name"]),
            parse: { a in try a.req("name", max: 200).trimmingCharacters(in: .whitespacesAndNewlines) },
            describe: { n, _ in "Open the app \(q(n))" },
            run: { n, caps in AgentToolOutput(text: try await caps.openApp(n).text("Opened \(n)"), workflow: [AgentWorkflowStep(type: "openApp", params: ["app": n])]) })
    }

    static func openFile() -> AgentTool {
        agentDefine(
            name: "open_file", title: "Open File", description: "Open a file or folder with its default app. Absolute path or ~/path.",
            mutating: true, schema: agentSchema(["path": agentProp("string")], required: ["path"]),
            parse: { a -> String in
                let p = try a.req("path", max: 2000)
                guard p.hasPrefix("/") || p.hasPrefix("~/") else { throw AgentArgs.Bad(message: "path must be absolute or start with ~/") }
                return p
            },
            describe: { p, _ in "Open \(p)" },
            run: { p, caps in AgentToolOutput(text: try caps.openFile(p).text("Opened \(p)"), workflow: [AgentWorkflowStep(type: "openFile", params: ["path": p])]) })
    }

    static func timerIds(_ caps: any AgentCapabilities) async -> [String] {
        guard let st = try? await caps.call("timers", "state", .null) else { return [] }
        return (st["timers"]?.arrayValue ?? []).compactMap { $0["id"]?.stringValue }
    }

    static func startTimer() -> AgentTool {
        agentDefine(
            name: "start_timer", title: "Start Timer", description: "Start a countdown timer in Glide (shown in the menu bar, notifies when done).",
            mutating: true,
            schema: agentSchema(["minutes": agentProp("number", "Duration in minutes (may be fractional)"), "seconds": agentProp("number", "Extra seconds"),
                                 "name": agentProp("string", "Optional label, e.g. \"Standup\"")]),
            requires: "timers",
            parse: { a -> (Double, String) in
                let ms = (a.num("minutes") * 60_000 + a.num("seconds") * 1000).rounded()
                guard ms >= 1000 else { throw AgentArgs.Bad(message: "Give a duration with minutes and/or seconds") }
                guard ms <= 24 * 3_600_000 else { throw AgentArgs.Bad(message: "Timers can be at most 24 hours") }
                return (ms, (try a.str("name", max: 100) ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
            },
            describe: { a, _ in "Start a \(formatDuration(a.0)) timer\(a.1.isEmpty ? "" : " named \(q(a.1))")" },
            run: { a, caps in
                let before = Set(await timerIds(caps))
                let r = try await caps.call("timers", "start", ["ms": .double(a.0), "name": .string(a.1)])
                let text = try AgentOp.from(r, fallback: "Timer started (\(formatDuration(a.0)))").text("Timer started")
                let created = await timerIds(caps).filter { !before.contains($0) }
                let undo = created.count == 1 ? AgentUndo(summary: "Cancel the \(formatDuration(a.0)) timer") {
                    try AgentOp.from(try await caps.call("timers", "stop", ["id": .string(created[0])]), fallback: "Timer cancelled").text("Timer cancelled")
                } : nil
                return AgentToolOutput(text: text, undo: undo, workflow: [AgentWorkflow.feature("timers", "start", ["duration": timerDuration(a.0), "name": a.1])])
            })
    }

    static func createNote() -> AgentTool {
        agentDefine(
            name: "create_note", title: "Create Note", description: "Create a Glide floating note. The first line becomes its title. Set open to show it.",
            mutating: true,
            schema: agentSchema(["text": agentProp("string", "Note body (Markdown)"), "open": agentProp("boolean", "Show the note window (default true)")], required: ["text"]),
            requires: "notes",
            parse: { a in (try a.req("text", max: 50_000), a.bool("open") != false) },
            describe: { a, _ in "Create a note \(q(a.0.components(separatedBy: "\n").first ?? a.0))\(a.1 ? " and show it" : "")" },
            run: { a, caps in
                let r = try await caps.call("notes", "create", ["text": .string(a.0), "body": .string(a.0)])
                guard let id = r["id"]?.stringValue ?? r["note"]?["id"]?.stringValue else { throw AgentToolFailure(r["error"]?.stringValue ?? "Could not create the note") }
                // Older notes builds create an empty note; save the text into it.
                if (r["body"]?.stringValue ?? r["note"]?["body"]?.stringValue ?? "") != a.0 {
                    _ = try? await caps.call("notes", "save", ["id": .string(id), "text": .string(a.0), "body": .string(a.0)])
                }
                if a.1 { _ = try? await caps.call("notes", "open", ["id": .string(id)]) }
                let title = a.0.components(separatedBy: "\n").first ?? ""
                return AgentToolOutput(text: "Created note \(id)", undo: AgentUndo(summary: "Delete the note \(q(title))") {
                    let r = try await caps.call("notes", "remove", ["id": .string(id)])
                    if r.boolValue == false { throw AgentToolFailure("That note no longer exists") }
                    return "Note deleted"
                })
            })
    }

    static func notesList(_ caps: any AgentCapabilities, _ query: String) async throws -> [JSONValue] {
        let r = try await caps.call("notes", "search", ["query": .string(query)])
        return r.arrayValue ?? r["notes"]?.arrayValue ?? []
    }

    static func searchNotes() -> AgentTool {
        agentDefine(
            name: "search_notes", title: "Search Notes", description: "Search the user's Glide floating notes by text. Returns note ids for open_note.",
            mutating: false, schema: agentSchema(["query": agentProp("string")], required: ["query"]), requires: "notes",
            parse: { a in try a.str("query", max: 200) ?? "" },
            describe: { s, _ in "Search notes for \(q(s))" },
            run: { s, caps in
                let notes = try await notesList(caps, s)
                if notes.isEmpty { return AgentToolOutput(text: "No notes match \(q(s)).") }
                return AgentToolOutput(text: AgentText.json(.array(notes.prefix(15).map { n in
                    var o: [String: JSONValue] = ["id": n["id"] ?? .null, "title": n["title"] ?? ""]
                    if let p = n["preview"] { o["preview"] = p }
                    return .object(o)
                })))
            })
    }

    static func openNote() -> AgentTool {
        agentDefine(
            name: "open_note", title: "Open Note", description: "Show one of the user's Glide notes (id from search_notes) in the floating notes window.",
            mutating: true, schema: agentSchema(["id": agentProp("string")], required: ["id"]), requires: "notes",
            parse: { a in try a.req("id", max: 200) },
            describe: { id, caps in
                let hit = (try? await notesList(caps, ""))?.first { $0["id"]?.stringValue == id }
                return "Open the note \(hit?["title"]?.stringValue.map(q) ?? id)"
            },
            run: { id, caps in
                let r = try await caps.call("notes", "open", ["id": .string(id)])
                return AgentToolOutput(text: try AgentOp.from(r, fallback: "Note opened").text("Note opened"))
            })
    }

    static func getClipboard() -> AgentTool {
        agentDefine(
            name: "get_clipboard", title: "Read Clipboard", description: "Read the text currently on the clipboard.",
            mutating: false, schema: agentSchema(), sensitiveResult: true,
            parse: { _ in () }, describe: { _, _ in "Read the clipboard text" },
            run: { _, caps in
                let t = caps.clipboardText()
                return AgentToolOutput(text: t.isEmpty ? "The clipboard has no text." : AgentText.clip(t))
            })
    }

    static func copyToClipboard() -> AgentTool {
        agentDefine(
            name: "copy_to_clipboard", title: "Copy to Clipboard", description: "Replace the clipboard contents with text.",
            mutating: true, schema: agentSchema(["text": agentProp("string")], required: ["text"]), sensitiveArgs: ["text"],
            parse: { a -> String in
                guard let t = try a.str("text", max: 100_000) else { throw AgentArgs.Bad(message: "\"text\" is required") }
                return t
            },
            describe: { t, _ in "Copy \(q(t)) to the clipboard" },
            run: { t, caps in
                let previous = caps.clipboardText()
                let text = try caps.copyText(t).text("Copied")
                return AgentToolOutput(text: text, undo: AgentUndo(summary: "Put the previous clipboard text back") { try caps.copyText(previous).text("Clipboard restored") },
                                       workflow: [AgentWorkflowStep(type: "setClipboard", params: ["text": t])])
            })
    }

    static func getSelectedText() -> AgentTool {
        agentDefine(
            name: "get_selected_text", title: "Read Selected Text", description: "Read the text selected in the app that was frontmost before Glide opened.",
            mutating: false, schema: agentSchema(), sensitiveResult: true,
            parse: { _ in () }, describe: { _, _ in "Read the selected text" },
            run: { _, caps in
                let r = await caps.selectedText()
                if let e = r.error { throw AgentToolFailure(e) }
                guard let t = r.text, !t.isEmpty else { return AgentToolOutput(text: "No text is selected.") }
                return AgentToolOutput(text: AgentText.clip(t))
            })
    }

    static func convert() -> AgentTool {
        agentDefine(
            name: "convert", title: "Convert",
            description: "Convert units, currencies, time zones and dates with Glide's converter, e.g. \"5 km in miles\", \"100 usd to eur\", \"3pm london in tokyo\".",
            mutating: false, schema: agentSchema(["query": agentProp("string")], required: ["query"]),
            parse: { a in try a.req("query", max: 200) },
            describe: { s, _ in "Convert \(q(s))" },
            run: { s, caps in
                var out: [JSONValue] = []
                if caps.hasFeature("convert"), let r = try? await caps.call("convert", "preview", ["query": .string(s)]) {
                    out = (r.arrayValue ?? []).map { ["title": $0["title"] ?? .null, "subtitle": $0["subtitle"] ?? .null] }
                }
                if out.isEmpty, let calc = CalculatorProviderBridge.evaluate(s) { out = [["title": .string(calc), "subtitle": "Calculator"]] }
                if out.isEmpty { throw AgentToolFailure("Glide could not convert \(q(s)). Try a form like \"5 km in miles\".") }
                return AgentToolOutput(text: AgentText.json(.array(Array(out.prefix(5)))))
            })
    }

    static func calendarEvents() -> AgentTool {
        agentDefine(
            name: "get_calendar_events", title: "Read Calendar", description: "List calendar events from the start of today through days_ahead days (0 = today only).",
            mutating: false, schema: agentSchema(["days_ahead": agentProp("integer", "0-14, default 0")]),
            parse: { a in a.int("days_ahead", 0, 0, 14) },
            describe: { d, _ in d > 0 ? "Read calendar events for today and the next \(d) days" : "Read today's calendar events" },
            run: { d, caps in
                let cal = Calendar.current
                let from = cal.startOfDay(for: Date(timeIntervalSince1970: caps.now() / 1000))
                let to = cal.date(byAdding: .day, value: d + 1, to: from) ?? from.addingTimeInterval(Double(d + 1) * 86400)
                let r = await caps.calendarEvents(from: from, to: to)
                if let e = r.error { throw AgentToolFailure(e) }
                let events = r.events?.arrayValue ?? r.events?["events"]?.arrayValue ?? []
                return AgentToolOutput(text: events.isEmpty ? "No events in that range." : AgentText.clip(AgentText.json(.array(events))))
            })
    }
}

/// The launcher calculator (GlideCore Providers) as a converter fallback.
enum CalculatorProviderBridge {
    static func evaluate(_ q: String) -> String? {
        Calculator.evaluate(q).map(Calculator.format)
    }
}
