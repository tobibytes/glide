import Foundation
import GlideCore

/// Agent tools over other Glide features (tools-extra.ts): automations, layouts, transforms, bookmarks,
/// clipboard history, processes, system status, reminders, snippets, quicklinks, Shortcuts and appearance.
@MainActor enum AgentToolsExtra {
    static func q(_ s: String) -> String { AgentText.quote(s) }

    static func all() -> [AgentTool] {
        [listAutomations(), createAutomation(), runAutomation(), listLayouts(), restoreLayout(), saveLayout(), transformText(), searchBookmarks(),
         clipboardHistory(), listProcesses(), killProcess(), systemStatus(), createReminder(), deleteReminder(), createSnippet(), createQuicklink(), runShortcut(), setTheme()]
    }

    static let triggerHelp = #"Trigger object. kind "time" {time:"HH:MM", days:[0-6] (0=Sun, empty=every day)}, "interval" {minutes}, "app" {event:"launched"|"quit"|"activated", app}, "wifi" {event:"joined"|"left"|"changed", network}, "power" {event:"ac"|"battery"|"below"|"above", percent}, "display" {event:"connected"|"disconnected"|"any"}, "folder" {path, event:"added"|"any"}, "launch" {}."#
    static let triggerKinds = ["time", "interval", "app", "wifi", "power", "display", "folder", "launch"]

    static func describeTrigger(_ t: [String: JSONValue]) -> String {
        let kind = t["kind"]?.stringValue ?? ""
        switch kind {
        case "time": return "every day at \(t["time"]?.stringValue ?? "?")"
        case "interval": return "every \(t["minutes"]?.intValue ?? 0) min"
        case "app": return "when \(t["app"]?.stringValue ?? "an app") is \(t["event"]?.stringValue ?? "launched")"
        case "wifi": return "when Wi‑Fi \(t["event"]?.stringValue ?? "changes")\(t["network"]?.stringValue.map { " (\($0))" } ?? "")"
        case "power": return "on power event \(t["event"]?.stringValue ?? "")"
        case "display": return "when a display is \(t["event"]?.stringValue ?? "connected")"
        case "folder": return "when files change in \(t["path"]?.stringValue ?? "a folder")"
        case "launch": return "when Glide starts"
        default: return kind
        }
    }

    static func automations(_ caps: any AgentCapabilities) async throws -> [JSONValue] {
        let st = try await caps.call("automations", "state", .null)
        return (st["automations"]?.arrayValue ?? []).map { a in
            ["id": a["id"] ?? .null, "name": a["name"] ?? "", "enabled": .bool(a["enabled"]?.boolValue != false),
             "trigger": a["triggerText"] ?? "", "target": a["targetText"] ?? ""]
        }
    }

    static func listAutomations() -> AgentTool {
        agentDefine(
            name: "list_automations", title: "List Automations",
            description: "List the user's Glide automations (trigger → workflow or command) with ids for run_automation.",
            mutating: false, schema: agentSchema(), requires: "automations",
            parse: { _ in () }, describe: { _, _ in "List automations" },
            run: { _, caps in
                let list = try await automations(caps)
                return AgentToolOutput(text: list.isEmpty ? "The user has no automations." : AgentText.clip(AgentText.json(.array(list))))
            })
    }

    struct AutomationSpec { var name: String; var trigger: [String: JSONValue]; var target: [String: JSONValue]; var ask: Bool }

    static func createAutomation() -> AgentTool {
        agentDefine(
            name: "create_automation", title: "Create Automation",
            description: "Create a Glide automation that runs a workflow (workflow_id from list_workflows) or a catalogue command (item_id from search_catalogue) when a trigger fires. \(triggerHelp)",
            mutating: true,
            schema: agentSchema(["name": agentProp("string"), "trigger": agentProp("object", triggerHelp), "workflow_id": agentProp("string"), "item_id": agentProp("string"),
                                 "argument": agentProp("string", "Argument for item_id commands; may contain {{input}}"),
                                 "ask_before_running": agentProp("boolean", "Ask the user each time it fires (default true for anything risky)")], required: ["trigger"]),
            requires: "automations",
            parse: { a -> AutomationSpec in
                guard let trig = a.input["trigger"]?.objectValue, let kind = trig["kind"]?.stringValue else { throw AgentArgs.Bad(message: "Invalid trigger. \(triggerHelp)") }
                if kind == "hotkey" { throw AgentArgs.Bad(message: "Hotkey automations must be created in Settings → Automations") }
                guard triggerKinds.contains(kind) else { throw AgentArgs.Bad(message: "Invalid trigger. \(triggerHelp)") }
                let wf = try a.str("workflow_id", max: 200), item = try a.str("item_id", max: 2000), arg = try a.str("argument", max: 2000), name = try a.str("name", max: 120)
                if (wf == nil) == (item == nil) { throw AgentArgs.Bad(message: "Give exactly one of workflow_id or item_id") }
                if let item, item.hasPrefix("agent:") { throw AgentArgs.Bad(message: "An automation cannot run the agent") }
                let target: [String: JSONValue] = wf.map { ["kind": "workflow", "workflowId": .string($0)] }
                    ?? ["kind": "command", "itemId": .string(item ?? ""), "title": .string(item ?? ""), "argument": .string(arg ?? "")]
                return AutomationSpec(name: (name ?? "").trimmingCharacters(in: .whitespaces), trigger: trig, target: target, ask: a.bool("ask_before_running") != false)
            },
            describe: { s, caps in
                var target = "\(s.target["kind"]?.stringValue ?? "") \(s.target["workflowId"]?.stringValue ?? s.target["itemId"]?.stringValue ?? "")"
                if let wid = s.target["workflowId"]?.stringValue, let wf = caps.listWorkflows().first(where: { $0.id == wid }) { target = "run the workflow \(q(wf.name))" }
                if let iid = s.target["itemId"]?.stringValue, let hit = caps.findItem(iid) { target = "run \(q(hit.title))" }
                return "Create the automation \(s.name.isEmpty ? "" : "\(q(s.name)) ")— \(describeTrigger(s.trigger)) → \(target)\(s.ask ? " (asks before each run)" : "")"
            },
            run: { s, caps in
                var target = s.target
                if let iid = target["itemId"]?.stringValue {
                    guard let hit = caps.findItem(iid) else { throw AgentToolFailure("No item with id \(iid). Search the catalogue first.") }
                    target["title"] = .string(hit.title)
                }
                if let wid = target["workflowId"]?.stringValue, !caps.listWorkflows().contains(where: { $0.id == wid }) { throw AgentToolFailure("No workflow with id \(wid)") }
                let r = try await caps.call("automations", "save", ["name": .string(s.name), "trigger": .object(s.trigger), "target": .object(target),
                                                                    "askBeforeRunning": .bool(s.ask), "enabled": true])
                guard r["ok"]?.boolValue != false, let id = r["automation"]?["id"]?.stringValue ?? r["id"]?.stringValue else {
                    throw AgentToolFailure(r["error"]?.stringValue ?? "Could not save the automation")
                }
                return AgentToolOutput(text: "Created automation \(id)", undo: AgentUndo(summary: "Delete the new automation") {
                    try AgentOp.from(try await caps.call("automations", "remove", ["id": .string(id)]), fallback: "Automation deleted").text("Automation deleted")
                })
            })
    }

    static func runAutomation() -> AgentTool {
        agentDefine(
            name: "run_automation", title: "Run Automation", description: "Run one of the user's automations now (id from list_automations).",
            mutating: true, schema: agentSchema(["id": agentProp("string")], required: ["id"]), destructive: true, requires: "automations",
            parse: { a in try a.req("id", max: 200) },
            describe: { id, caps in
                if let hit = (try? await automations(caps))?.first(where: { $0["id"]?.stringValue == id }) {
                    return "Run the automation \(q(hit["name"]?.stringValue ?? id)) now (\(hit["target"]?.stringValue ?? ""))"
                }
                return "Run automation \(id) now"
            },
            run: { id, caps in
                let r = try await caps.call("automations", "runNow", ["id": .string(id)])
                return AgentToolOutput(text: try AgentOp.from(r, fallback: "Automation ran").text("Automation ran"), workflow: [AgentWorkflow.feature("automations", "runNow", ["automation": id])])
            })
    }

    static func layouts(_ caps: any AgentCapabilities) async throws -> [JSONValue] {
        let st = try await caps.call("layouts", "state", .null)
        return (st["layouts"]?.arrayValue ?? st.arrayValue ?? []).map { l in
            ["id": l["id"] ?? .null, "name": l["name"] ?? "", "summary": l["summary"] ?? .string("\(AgentText.plural(l["windows"]?.arrayValue?.count ?? 0, "window"))")]
        }
    }

    static func listLayouts() -> AgentTool {
        agentDefine(
            name: "list_layouts", title: "List Layouts", description: "List saved window layouts (which windows go where) with ids for restore_layout.",
            mutating: false, schema: agentSchema(), requires: "layouts",
            parse: { _ in () }, describe: { _, _ in "List window layouts" },
            run: { _, caps in
                let list = try await layouts(caps)
                return AgentToolOutput(text: list.isEmpty ? "No saved layouts." : AgentText.clip(AgentText.json(.array(list))))
            })
    }

    static func restoreLayout() -> AgentTool {
        agentDefine(
            name: "restore_layout", title: "Restore Layout", description: "Move every window back to a saved layout (id from list_layouts).",
            mutating: true, schema: agentSchema(["id": agentProp("string")], required: ["id"]), requires: "layouts",
            parse: { a in try a.req("id", max: 200) },
            describe: { id, caps in
                if let hit = (try? await layouts(caps))?.first(where: { $0["id"]?.stringValue == id }) {
                    return "Restore the window layout \(q(hit["name"]?.stringValue ?? id)) (\(hit["summary"]?.stringValue ?? ""))"
                }
                return "Restore layout \(id)"
            },
            run: { id, caps in
                guard try await layouts(caps).contains(where: { $0["id"]?.stringValue == id }) else { throw AgentToolFailure("No layout with id \(id)") }
                let before = await caps.windowSnapshot()
                let text = try AgentOp.from(try await caps.call("layouts", "restore", ["id": .string(id)]), fallback: "Layout restored").text("Layout restored")
                return AgentToolOutput(text: text, undo: before.map { snap in AgentUndo(summary: "Put the windows back where they were") { try await caps.restoreWindows(snap).text("Windows restored") } },
                                       workflow: [AgentWorkflow.feature("layouts", "restore", ["layout": id])])
            })
    }

    static func saveLayout() -> AgentTool {
        agentDefine(
            name: "save_layout", title: "Save Layout", description: "Save where every window is right now as a named layout.",
            mutating: true, schema: agentSchema(["name": agentProp("string")], required: ["name"]), requires: "layouts",
            parse: { a in try a.req("name", max: 100).trimmingCharacters(in: .whitespaces) },
            describe: { n, _ in "Save the current window positions as the layout \(q(n))" },
            run: { n, caps in
                let l = try await caps.call("layouts", "save", ["name": .string(n)])
                guard let id = l["id"]?.stringValue ?? l["layout"]?["id"]?.stringValue else { throw AgentToolFailure(l["error"]?.stringValue ?? "Could not save the layout") }
                let windows = (l["windows"] ?? l["layout"]?["windows"])?.arrayValue?.count ?? 0
                return AgentToolOutput(text: "Saved layout \(q(n)): \(AgentText.plural(windows, "window"))", undo: AgentUndo(summary: "Delete the layout \(q(n))") {
                    try AgentOp.from(try await caps.call("layouts", "deleteLayout", ["id": .string(id)]), fallback: "Layout deleted").text("Layout deleted")
                })
            })
    }

    static func transformText() -> AgentTool {
        agentDefine(
            name: "transform_text", title: "Transform Text",
            description: "Apply a Glide text transform (case changes, sort/dedupe lines, URL/Base64/JSON encode/decode, hashes, counts…) to text, the clipboard or the selection and return the result. Pass transform \"list\" to get the available transform ids. Does not change the clipboard; use copy_to_clipboard for that.",
            mutating: false,
            schema: agentSchema(["transform": agentProp("string", "Transform id, or \"list\""), "text": agentProp("string", "Input text (omit to use source)"),
                                 "source": agentProp("string", "Where the input comes from (default text, or clipboard when text is omitted)", enumValues: ["text", "clipboard", "selection"])], required: ["transform"]),
            sensitiveResult: true, sensitiveArgs: ["text"], requires: "transforms",
            parse: { a -> (String, String?, String) in
                let t = try a.req("transform", max: 80)
                let text = try a.str("text", max: 200_000)
                let src = a.input["source"]?.stringValue
                let source = src == "clipboard" || src == "selection" ? src ?? "text" : text == nil ? "clipboard" : "text"
                return (t, text, source)
            },
            describe: { a, _ in a.0 == "list" ? "List text transforms" : "Transform \(a.2 == "text" ? "the given text" : "the \(a.2)") with \(q(a.0))" },
            run: { a, caps in
                let listed = try await caps.call("transforms", "list", .null)
                let all = listed.arrayValue ?? listed["transforms"]?.arrayValue ?? []
                if a.0 == "list" {
                    return AgentToolOutput(text: AgentText.json(.array(all.map { ["id": $0["id"] ?? .null, "title": $0["title"] ?? .null, "category": $0["category"] ?? .null] })))
                }
                guard all.contains(where: { $0["id"]?.stringValue == a.0 }) else { throw AgentToolFailure("Unknown transform \(q(a.0)). Call transform_text with transform \"list\".") }
                var input = a.1 ?? ""
                if a.2 == "clipboard" { input = caps.clipboardText() } else if a.2 == "selection" {
                    let r = await caps.selectedText()
                    if let e = r.error { throw AgentToolFailure(e) }
                    input = r.text ?? ""
                }
                let r = try await caps.call("transforms", "apply", ["id": .string(a.0), "input": .string(input)])
                if r["ok"]?.boolValue == false { throw AgentToolFailure(r["error"]?.stringValue ?? "Transform failed") }
                return AgentToolOutput(text: AgentText.clip(r["output"]?.stringValue ?? r.stringValue ?? ""))
            })
    }

    static func searchBookmarks() -> AgentTool {
        agentDefine(
            name: "search_bookmarks", title: "Search Bookmarks",
            description: "Search the user's browser bookmarks (Safari, Chrome, Arc, …) by title or URL. Read-only; open one with open_url.",
            mutating: false, schema: agentSchema(["query": agentProp("string"), "limit": agentProp("integer", "1-20, default 8")], required: ["query"]), requires: "browser",
            parse: { a in (try a.str("query", max: 200) ?? "", a.int("limit", 8, 1, 20)) },
            describe: { a, _ in "Search bookmarks for \(q(a.0))" },
            run: { a, caps in
                let r = try await caps.call("browser", "search", ["query": .string(a.0), "kind": "bookmark", "limit": .int(Int64(a.1))])
                let rows = (r.arrayValue ?? r["items"]?.arrayValue ?? []).prefix(a.1).map { b -> JSONValue in
                    ["title": b["title"] ?? "", "url": b["url"] ?? "", "folder": b["folder"] ?? .null, "browser": b["browserName"] ?? b["browser"] ?? .null]
                }
                return AgentToolOutput(text: rows.isEmpty ? "No bookmarks match \(q(a.0))." : AgentText.clip(AgentText.json(.array(Array(rows)))))
            })
    }

    static func clipboardHistory() -> AgentTool {
        agentDefine(
            name: "clipboard_history_search", title: "Search Clipboard History",
            description: "Search Glide's clipboard history (text, links, colors, files). Read-only; returns previews, newest first.",
            mutating: false, schema: agentSchema(["query": agentProp("string"), "limit": agentProp("integer", "1-20, default 8")]),
            sensitiveResult: true, requires: "clipboard",
            parse: { a in (try a.str("query", max: 200) ?? "", a.int("limit", 8, 1, 20)) },
            describe: { a, _ in a.0.isEmpty ? "Read recent clipboard history" : "Search clipboard history for \(q(a.0))" },
            run: { a, caps in
                let list = try await clipboardEntries(caps, a.0, a.1)
                return AgentToolOutput(text: list.isEmpty ? "No clipboard history matches." : AgentText.clip(AgentText.json(.array(list))))
            })
    }

    static func clipboardEntries(_ caps: any AgentCapabilities, _ query: String, _ limit: Int) async throws -> [JSONValue] {
        let r = try await caps.call("clipboard", "list", ["query": .string(query), "limit": .int(Int64(limit))])
        return (r.arrayValue ?? r["entries"]?.arrayValue ?? []).prefix(limit).map { e in
            ["type": e["type"] ?? "", "title": e["title"] ?? "", "preview": .string(String((e["preview"]?.stringValue ?? "").prefix(300))), "copiedAt": e["lastCopiedAt"] ?? e["copiedAt"] ?? 0]
        }
    }

    static func listProcesses() -> AgentTool {
        agentDefine(
            name: "list_processes", title: "List Processes",
            description: "List running processes sorted by CPU (pid, name, %CPU, memory). Optionally filter by name. Read-only.",
            mutating: false, schema: agentSchema(["query": agentProp("string"), "limit": agentProp("integer", "1-30, default 10")]), requires: "processes",
            parse: { a in ((try a.str("query", max: 100) ?? "").lowercased(), a.int("limit", 10, 1, 30)) },
            describe: { a, _ in a.0.isEmpty ? "List the busiest processes" : "List processes matching \(q(a.0))" },
            run: { a, caps in
                let rows = try await caps.listProcesses().filter { a.0.isEmpty || $0.name.lowercased().contains(a.0) }.prefix(a.1)
                if rows.isEmpty { return AgentToolOutput(text: "No matching processes.") }
                return AgentToolOutput(text: AgentText.json(.array(rows.map { p in
                    ["pid": .int(Int64(p.pid)), "name": .string(p.name), "cpu": .double(p.cpu), "memoryMB": .int(Int64((p.rssKb / 1024).rounded())), "user": .string(p.user)]
                })))
            })
    }

    struct ProcessCheck { var exists: Bool; var name: String; var command: String; var protected: Bool; var reason: String? }

    static func checkProcess(_ caps: any AgentCapabilities, _ pid: Int) async throws -> ProcessCheck {
        guard let p = try await caps.listProcesses().first(where: { $0.pid == pid }) else { return ProcessCheck(exists: false, name: "", command: "", protected: false) }
        if AgentSafety.isProtectedProcess(name: p.name, command: p.command) {
            return ProcessCheck(exists: true, name: p.name, command: p.command, protected: true, reason: "\(p.name) is a protected system or Glide process")
        }
        if let risk = try? await caps.call("processes", "risk", ["pid": .int(Int64(pid))]), risk["level"]?.stringValue == "warn" {
            return ProcessCheck(exists: true, name: p.name, command: p.command, protected: true, reason: risk["reason"]?.stringValue)
        }
        return ProcessCheck(exists: true, name: p.name, command: p.command, protected: false)
    }

    static func killProcess() -> AgentTool {
        agentDefine(
            name: "kill_process", title: "Quit Process",
            description: "Quit (SIGTERM) or force quit (force: true, SIGKILL) a process by pid from list_processes. Always asks the user. Core macOS processes and Glide itself are refused.",
            mutating: true, schema: agentSchema(["pid": agentProp("integer"), "force": agentProp("boolean")], required: ["pid"]),
            alwaysConfirm: true, destructive: true, requires: "processes",
            parse: { a -> (Int, Bool) in
                guard let d = a.input["pid"]?.doubleValue, d == d.rounded(), d.isFinite else { throw AgentArgs.Bad(message: "\"pid\" must be an integer") }
                if d <= 1 { throw AgentArgs.Bad(message: "That process is protected and can't be killed") }
                return (Int(d), a.bool("force") == true)
            },
            describe: { a, caps in
                let p = try? await checkProcess(caps, a.0)
                let name = p?.exists == true ? "\(q(p?.name ?? "")) (PID \(a.0))" : "PID \(a.0)"
                return "\(a.1 ? "Force quit" : "Quit") \(name)\(a.1 ? " — unsaved work is lost" : "")"
            },
            run: { a, caps in
                let p = try await checkProcess(caps, a.0)
                guard p.exists else { throw AgentToolFailure("No process with PID \(a.0)") }
                if p.protected { throw AgentToolFailure("Refused: \(p.reason ?? "\(p.name) is a protected process")") }
                return AgentToolOutput(text: try await caps.killProcess(pid: a.0, force: a.1, expectedCommand: p.command).text("\(a.1 ? "Force quit" : "Quit") \(p.name)"))
            })
    }

    static func systemStatus() -> AgentTool {
        agentDefine(
            name: "system_status", title: "System Status", description: "Read CPU, memory, disk, battery, network and uptime, plus the busiest processes.",
            mutating: false, schema: agentSchema(), requires: "sysmon",
            parse: { _ in () }, describe: { _, _ in "Read system status" },
            run: { _, caps in AgentToolOutput(text: AgentText.clip(statusText(try await caps.call("sysmon", "sample", ["record": false, "top": 5])))) })
    }

    static func statusText(_ st: JSONValue) -> String {
        let s = st["sample"] ?? st
        func gb(_ v: JSONValue?) -> String { String(format: "%.1f GB", (v?.doubleValue ?? 0) / 1_073_741_824) }
        let cpuTotal = s["cpu"]?["total"]?.doubleValue ?? 0
        let load = (s["cpu"]?["load"]?.arrayValue ?? []).map { String(format: "%.2f", $0.doubleValue ?? 0) }.joined(separator: " ")
        var lines = ["CPU \(Int((cpuTotal * (cpuTotal <= 1 ? 100 : 1)).rounded()))% · load \(load.isEmpty ? "?" : load)"]
        if let m = s["memory"] { lines.append("Memory \(gb(m["usedBytes"])) of \(gb(m["totalBytes"])) used") }
        if let d = s["disk"] { lines.append("Disk \(gb(d["availableBytes"])) free of \(gb(d["totalBytes"]))") }
        if let b = s["battery"], !b.isNull { lines.append("Battery \(b["percent"]?.intValue ?? 0)% (\(b["state"]?.stringValue ?? (b["charging"]?.boolValue == true ? "charging" : "on battery")))") }
        if let n = s["net"] { lines.append("Network ↓\(Int((n["rxPerSec"]?.doubleValue ?? 0) / 1024)) KB/s ↑\(Int((n["txPerSec"]?.doubleValue ?? 0) / 1024)) KB/s") }
        if let u = s["uptimeSec"]?.doubleValue { lines.append("Uptime \(Int((u / 3600).rounded())) h") }
        if let top = s["top"]?.arrayValue, !top.isEmpty {
            lines.append("Busiest: " + top.map { "\($0["name"]?.stringValue ?? "") (PID \($0["pid"]?.intValue ?? 0), \(Int($0["cpu"]?.doubleValue ?? 0))% CPU)" }.joined(separator: ", "))
        }
        return lines.joined(separator: "\n")
    }

    static func createReminder() -> AgentTool {
        agentDefine(
            name: "create_reminder", title: "Create Reminder",
            description: "Create a Glide reminder. due is an ISO 8601 local date-time (e.g. 2026-10-21T17:00) computed from the current time.",
            mutating: true,
            schema: agentSchema(["title": agentProp("string"), "due": agentProp("string", "ISO 8601 date-time"), "notes": agentProp("string")], required: ["title"]),
            requires: "reminders",
            parse: { a -> (String, Date?, String?) in
                let title = try a.req("title", max: 200).trimmingCharacters(in: .whitespaces)
                let notes = try a.str("notes", max: 4000)
                var due: Date?
                if let d = try a.str("due", max: 40) {
                    guard let parsed = AgentDates.parse(d) else { throw AgentArgs.Bad(message: "\"due\" must be an ISO 8601 date-time") }
                    due = parsed
                }
                return (title, due, notes)
            },
            describe: { a, _ in
                guard let due = a.1 else { return "Remind you \(q(a.0))" }
                let f = DateFormatter()
                f.dateFormat = "EEE, MMM d, h:mm a"
                return "Remind you \(q(a.0)) at \(f.string(from: due))"
            },
            run: { a, caps in
                var args: [String: JSONValue] = ["title": .string(a.0)]
                if let n = a.2 { args["notes"] = .string(n) }
                if let d = a.1 { args["due"] = .string(ISO8601DateFormatter().string(from: d)) }
                let r = try await caps.call("reminders", "create", .object(args))
                if r.boolValue == false || r["ok"]?.boolValue == false { throw AgentToolFailure(r["error"]?.stringValue ?? "Could not create the reminder") }
                let id = r["id"]?.stringValue ?? r["reminder"]?["id"]?.stringValue
                let undo = id.map { id in AgentUndo(summary: "Delete the reminder \(q(a.0))") {
                    if let r = try? await caps.call("reminders", "delete", ["id": .string(id)]) { return try AgentOp.from(r, fallback: "Reminder deleted").text("Reminder deleted") }
                    return try AgentOp.from(try await caps.call("reminders", "complete", ["id": .string(id), "completed": true]), fallback: "Reminder marked completed").text("Reminder marked completed")
                } }
                return AgentToolOutput(text: r["message"]?.stringValue ?? "Reminder created", undo: undo)
            })
    }

    /// The reminders the user has (Reminders feature `state`), or a readable failure.
    static func reminderRows(_ caps: any AgentCapabilities) async throws -> [JSONValue] {
        let st = try await caps.call("reminders", "state", .null)
        if let status = st["status"]?.stringValue, status != "ok" {
            throw AgentToolFailure(st["message"]?.stringValue ?? "Reminders unavailable (\(status)). Grant access in Glide → Reminders.")
        }
        return st["reminders"]?.arrayValue ?? []
    }

    /// id wins; else a title match (exact, case-insensitive, then a unique "contains").
    static func findReminder(_ rows: [JSONValue], id: String?, title: String?) throws -> JSONValue {
        if let id {
            guard let r = rows.first(where: { $0["id"]?.stringValue == id }) else { throw AgentToolFailure("No reminder with id \(id)") }
            return r
        }
        let t = (title ?? "").lowercased()
        let exact = rows.filter { ($0["title"]?.stringValue ?? "").lowercased() == t }
        let hits = exact.isEmpty ? rows.filter { ($0["title"]?.stringValue ?? "").lowercased().contains(t) } : exact
        guard let first = hits.first else { throw AgentToolFailure("No reminder matches \(q(title ?? ""))") }
        guard hits.count == 1 else {
            throw AgentToolFailure("\(hits.count) reminders match \(q(title ?? "")): " + hits.prefix(5).map { "\(q($0["title"]?.stringValue ?? "")) (id \($0["id"]?.stringValue ?? ""))" }.joined(separator: ", ") + ". Pass id.")
        }
        return first
    }

    static func deleteReminder() -> AgentTool {
        agentDefine(
            name: "delete_reminder", title: "Delete Reminder",
            description: "Permanently delete one of the user's Apple Reminders by its title (or id, when known). Several matches are refused with their ids. Always asks the user.",
            mutating: true,
            schema: agentSchema(["id": agentProp("string", "Reminder id"), "title": agentProp("string", "Exact title, when the id is unknown")]),
            alwaysConfirm: true, destructive: true, requires: "reminders",
            parse: { a -> (String?, String?) in
                let id = try a.str("id", max: 400)?.trimmingCharacters(in: .whitespaces)
                let title = try a.str("title", max: 200)?.trimmingCharacters(in: .whitespaces)
                guard !(id ?? "").isEmpty || !(title ?? "").isEmpty else { throw AgentArgs.Bad(message: "Give the reminder's id or title") }
                return ((id ?? "").isEmpty ? nil : id, (title ?? "").isEmpty ? nil : title)
            },
            describe: { a, caps in
                if let rows = try? await reminderRows(caps), let r = try? findReminder(rows, id: a.0, title: a.1) {
                    return "Delete the reminder \(q(r["title"]?.stringValue ?? "")) — this can't be undone"
                }
                return "Delete the reminder \(a.0.map { "with id \($0)" } ?? q(a.1 ?? "")) — this can't be undone"
            },
            run: { a, caps in
                let r = try findReminder(try await reminderRows(caps), id: a.0, title: a.1)
                guard let id = r["id"]?.stringValue else { throw AgentToolFailure("That reminder has no id") }
                let title = r["title"]?.stringValue ?? id
                let out = try await caps.call("reminders", "delete", ["id": .string(id)])
                return AgentToolOutput(text: try AgentOp.from(out, fallback: "Deleted the reminder \(q(title))").text("Deleted the reminder \(q(title))"))
            })
    }

    static func newId(_ prefix: String, _ now: Double) -> String {
        "\(prefix)-agent-\(String(Int64(now), radix: 36))\(String(Int.random(in: 0..<46656), radix: 36))"
    }

    static func createSnippet() -> AgentTool {
        agentDefine(
            name: "create_snippet", title: "Create Snippet", description: "Save a text snippet (pasted from the launcher; optional keyword expands it while typing).",
            mutating: true,
            schema: agentSchema(["name": agentProp("string"), "text": agentProp("string"), "keyword": agentProp("string", "Optional, e.g. \";sig\"")], required: ["name", "text"]),
            parse: { a -> (String, String, String?) in
                let name = try a.req("name", max: 120).trimmingCharacters(in: .whitespaces)
                let text = try a.req("text", max: 20_000)
                let kw = try a.str("keyword", max: 40)
                if let kw, kw.contains(where: \.isWhitespace) { throw AgentArgs.Bad(message: "keyword can't contain spaces") }
                return (name, text, kw)
            },
            describe: { a, _ in "Create the snippet \(q(a.0))\(a.2.map { " (keyword \($0))" } ?? ""): \(q(a.1))" },
            run: { a, caps in
                if let kw = a.2, caps.snippets().contains(where: { $0.keyword == kw }) { throw AgentToolFailure("The keyword \(kw) is already used by another snippet") }
                let id = newId("sn", caps.now())
                caps.saveSnippet(Snippet(id: id, name: a.0, text: a.1, keyword: a.2))
                return AgentToolOutput(text: "Created snippet \(q(a.0))", undo: AgentUndo(summary: "Delete the snippet \(q(a.0))") {
                    guard caps.deleteSnippet(id) else { throw AgentToolFailure("That snippet no longer exists") }
                    return "Snippet deleted"
                })
            })
    }

    static func createQuicklink() -> AgentTool {
        agentDefine(
            name: "create_quicklink", title: "Create Quicklink",
            description: "Save a quicklink: a named URL in the launcher. Use {query} in the URL for a search link, e.g. https://github.com/search?q={query}.",
            mutating: true, schema: agentSchema(["name": agentProp("string"), "url": agentProp("string")], required: ["name", "url"]),
            parse: { a -> (String, String) in
                let name = try a.req("name", max: 120).trimmingCharacters(in: .whitespaces)
                let url = try a.req("url", max: 4000).trimmingCharacters(in: .whitespaces)
                guard url.range(of: "^(https?|mailto):", options: [.regularExpression, .caseInsensitive]) != nil else {
                    throw AgentArgs.Bad(message: "Quicklinks must be http, https or mailto URLs")
                }
                return (name, url)
            },
            describe: { a, _ in "Create the quicklink \(q(a.0)) → \(a.1)" },
            run: { a, caps in
                let id = newId("ql", caps.now())
                caps.saveQuicklink(Quicklink(id: id, name: a.0, url: a.1))
                return AgentToolOutput(text: "Created quicklink \(q(a.0))", undo: AgentUndo(summary: "Delete the quicklink \(q(a.0))") {
                    guard caps.deleteQuicklink(id) else { throw AgentToolFailure("That quicklink no longer exists") }
                    return "Quicklink deleted"
                })
            })
    }

    static func runShortcut() -> AgentTool {
        agentDefine(
            name: "run_shortcut", title: "Run Shortcut", description: "Run a macOS Shortcuts shortcut by its exact name (shortcuts run). Always asks the user first.",
            mutating: true, schema: agentSchema(["name": agentProp("string"), "input": agentProp("string", "Optional text input")], required: ["name"]),
            alwaysConfirm: true, destructive: true,
            parse: { a in (try a.req("name", max: 200).trimmingCharacters(in: .whitespaces), try a.str("input", max: 10_000)) },
            describe: { a, _ in "Run the Shortcuts shortcut \(q(a.0))\(a.1.map { " with input \(q($0))" } ?? "")" },
            run: { a, caps in
                let r = await caps.runShortcut(a.0, input: a.1)
                if !r.ok { throw AgentToolFailure(r.error ?? "The shortcut failed") }
                let out = r.output?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return AgentToolOutput(text: out.isEmpty ? "Shortcut finished." : "Shortcut finished. Output: \(AgentText.clip(out, 2000))",
                                       workflow: [AgentWorkflowStep(type: "runShell", params: ["command": "shortcuts run \(LiveAgentCapabilities.shq(a.0))", "shell": "/bin/zsh", "continueOnError": "false"],
                                                                    label: "Run Shortcut “\(a.0)”")])
            })
    }

    static func setTheme() -> AgentTool {
        agentDefine(
            name: "set_theme", title: "Set Theme",
            description: "Change Glide's appearance: mode (system, dark, light) and/or a theme preset id (glide-dark, glide-light, midnight, nord, solarized, dracula, mocha, dawn, high-contrast).",
            mutating: true, schema: agentSchema(["mode": agentProp("string", nil, enumValues: ["system", "dark", "light"]), "preset": agentProp("string")]),
            parse: { a -> (String?, String?) in
                let mode = a.input["mode"]?.stringValue
                if let m = mode, !["system", "dark", "light"].contains(m) { throw AgentArgs.Bad(message: "\"mode\" must be system, dark or light") }
                let preset = try a.str("preset", max: 60)
                if mode == nil && preset == nil { throw AgentArgs.Bad(message: "Give a mode and/or a preset") }
                return (mode, preset)
            },
            describe: { a, caps in
                let name = a.1.map { id in caps.appearance().presets.first { $0.id == id }?.name ?? id }
                let bits = [name.map { "use the \(q($0)) theme" }, a.0.map { $0 == "system" ? "switch to the system appearance" : "switch to \($0) mode" }].compactMap { $0 }
                return "Change Glide's look: \(bits.joined(separator: " and "))"
            },
            run: { a, caps in
                let before = caps.appearance()
                if let p = a.1, !before.presets.contains(where: { $0.id == p }) {
                    throw AgentToolFailure("Unknown theme \(q(p)). Presets: \(before.presets.map(\.id).joined(separator: ", "))")
                }
                let text = try caps.setAppearance(mode: a.0, preset: a.1).text("Theme changed")
                return AgentToolOutput(text: text, undo: AgentUndo(summary: "Restore the previous theme") { try caps.restoreAppearance(before).text("Theme restored") })
            })
    }
}

enum AgentDates {
    /// ISO 8601 with or without seconds / zone (a local time when no zone is given), or a plain date.
    static func parse(_ s: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: s) { return d }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        for fmt in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
            f.dateFormat = fmt
            if let d = f.date(from: s) { return d }
        }
        return nil
    }
}
