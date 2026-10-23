import AppKit
import GlideCore
import GlideUI
import SwiftUI

extension Automation {
    var symbol: String { AutomationModel.triggerKinds.first { $0.kind == trigger.kind }?.symbol ?? "bolt" }
}

func automationRelativeTime(_ ms: Double, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date(timeIntervalSince1970: now / 1000))
}

/// Launcher: pending confirmations, then automations; detail pane with the run log.
struct AutomationsLauncherView: View {
    @Environment(\.glideTheme) private var theme
    let feature: AutomationsFeature
    @Bindable var ui: AutomationsUIModel
    let filter: String

    var body: some View {
        let _ = ui.generation
        let rows = feature.launcherRows(filter: filter)
        let selId = rows.first { $0.id == ui.launcherSelection }?.id ?? rows.first?.id
        if rows.isEmpty {
            EmptyState(symbol: "bolt.badge.clock", title: "No automations yet", subtitle: "Create one in Settings → Automations")
        } else {
            DetailSplit {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 2) {
                            ForEach(rows) { row in
                                AutomationRowView(feature: feature, row: row, selected: row.id == selId)
                                    .id(row.id)
                                    .onTapGesture { ui.launcherSelection = row.id }
                            }
                        }
                        .padding(8)
                    }
                    .onChange(of: selId) { _, id in if let id { proxy.scrollTo(id) } }
                }
            } detail: {
                if let row = rows.first(where: { $0.id == selId }) { AutomationDetail(feature: feature, row: row) }
            }
        }
    }
}

struct AutomationRowView: View {
    @Environment(\.glideTheme) private var theme
    let feature: AutomationsFeature
    let row: AutomationsLauncherRow
    let selected: Bool

    var body: some View {
        HStack(spacing: 10) {
            switch row {
            case let .pending(p):
                Image(systemName: "questionmark.circle.fill").foregroundStyle(theme.warning).font(.system(size: 18))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Run “\(p.name)”?").font(theme.titleFont).foregroundStyle(theme.text)
                    Text(p.reason).font(theme.subtitleFont).foregroundStyle(theme.text2).lineLimit(1)
                }
                Spacer()
                HStack(spacing: 4) { Kbd("↩"); Text("Run").font(.system(size: 11)).foregroundStyle(theme.text3); Kbd("⌘↩"); Text("Skip").font(.system(size: 11)).foregroundStyle(theme.text3) }
            case let .automation(a):
                Image(systemName: a.symbol).font(.system(size: 13, weight: .semibold)).foregroundStyle(a.enabled ? theme.accent : theme.text3)
                    .frame(width: 26, height: 26).background(RoundedRectangle(cornerRadius: 7).fill(a.enabled ? theme.accentSoft : theme.surface))
                VStack(alignment: .leading, spacing: 2) {
                    Text(a.name).font(theme.titleFont).foregroundStyle(theme.text).lineLimit(1)
                    Text(feature.triggerText(a)).font(theme.subtitleFont).foregroundStyle(theme.text2).lineLimit(1)
                }
                Spacer()
                if feature.engine?.isRunning(a.id) == true { ProgressView().controlSize(.small) }
                if feature.problems[a.id] != nil { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(theme.warning) }
                if let r = a.log.first { Circle().fill(r.status == "ok" ? theme.success : r.status == "error" ? theme.danger : theme.text3).frame(width: 7, height: 7) }
                Text(a.enabled ? "On" : "Off").font(.system(size: 11, weight: .semibold)).foregroundStyle(a.enabled ? theme.success : theme.text3)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: CGFloat(theme.tokens.rowHeight))
        .background(RoundedRectangle(cornerRadius: 8).fill(selected ? theme.selected : .clear))
        .contentShape(Rectangle())
    }
}

struct AutomationDetail: View {
    @Environment(\.glideTheme) private var theme
    let feature: AutomationsFeature
    let row: AutomationsLauncherRow

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                switch row {
                case let .pending(p):
                    Text("Waiting for confirmation").font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
                    Text(p.reason).foregroundStyle(theme.text2)
                    if !p.input.isEmpty { Text(p.input).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text2) }
                    Text("Skipped automatically \(automationRelativeTime(p.expiresAt)).").font(.system(size: 11)).foregroundStyle(theme.text3)
                case let .automation(a):
                    Text(a.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
                    Label(feature.triggerText(a), systemImage: a.symbol).foregroundStyle(theme.text2)
                    Label(feature.targetText(a), systemImage: "play.rectangle").foregroundStyle(theme.text2)
                    if a.askBeforeRunning { Label("Asks before running", systemImage: "hand.raised").foregroundStyle(theme.text3) }
                    if let n = feature.engine?.nextRun(a.id), n.isFinite { Label("Next \(automationRelativeTime(n))", systemImage: "clock").foregroundStyle(theme.text3) }
                    if let p = feature.problems[a.id] { Label(p, systemImage: "exclamationmark.triangle").foregroundStyle(theme.warning) }
                    Text("RUN LOG").font(theme.sectionFont).foregroundStyle(theme.text3).padding(.top, 6)
                    if a.log.isEmpty { Text("Never run").foregroundStyle(theme.text3) }
                    ForEach(a.log.prefix(12), id: \.id) { r in AutomationRunRow(record: r) }
                    HStack(spacing: 10) {
                        HStack(spacing: 4) { Kbd("↩"); Text("Run Now") }
                        HStack(spacing: 4) { Kbd("⌘↩"); Text(a.enabled ? "Disable" : "Enable") }
                        HStack(spacing: 4) { Kbd("⌘E"); Text("Edit") }
                    }
                    .font(.system(size: 11)).foregroundStyle(theme.text3).padding(.top, 6)
                }
            }
            .font(.system(size: 12.5))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
        }
    }
}

struct AutomationRunRow: View {
    let record: AutomationRunRecord
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: record.status == "ok" ? "checkmark.circle.fill" : record.status == "error" ? "xmark.octagon.fill" : "forward.circle")
                .foregroundStyle(record.status == "ok" ? Color.green : record.status == "error" ? Color.red : Color.secondary)
            VStack(alignment: .leading, spacing: 1) {
                HStack {
                    Text(record.trigger).lineLimit(1)
                    Spacer()
                    Text(automationRelativeTime(record.at)).foregroundStyle(.secondary).font(.system(size: 10.5))
                }
                Text(record.message).foregroundStyle(.secondary).lineLimit(2).font(.system(size: 11))
            }
        }
        .font(.system(size: 11.5))
    }
}

// MARK: - Settings

struct AutomationsSettingsView: View {
    let feature: AutomationsFeature
    @Bindable var ui: AutomationsUIModel

    var body: some View {
        let _ = ui.generation
        let list = feature.engine?.list ?? []
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                List(selection: Binding(get: { ui.selection }, set: { id in
                    ui.selection = id
                    ui.draft = id.flatMap { i in list.first { $0.id == i }?.json }
                    ui.error = nil
                })) {
                    if !feature.pending.isEmpty {
                        Section("Waiting for you") {
                            ForEach(feature.pending) { p in
                                HStack {
                                    Text("Run “\(p.name)”?")
                                    Spacer()
                                    Button("Run") { feature.settle(p.id, run: true) }
                                    Button("Skip") { feature.settle(p.id, run: false) }
                                }
                            }
                        }
                    }
                    Section("Automations") {
                        ForEach(list) { a in
                            HStack(spacing: 8) {
                                Image(systemName: a.symbol).foregroundStyle(a.enabled ? Color.accentColor : .secondary).frame(width: 18)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(a.name).lineLimit(1)
                                    Text(AutomationModel.describe(a.trigger)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                if feature.problems[a.id] != nil { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                                Toggle("", isOn: Binding(get: { a.enabled }, set: { _ = feature.setEnabled(a.id, $0) })).labelsHidden().toggleStyle(.switch).controlSize(.mini)
                            }
                            .tag(Optional(a.id))
                        }
                    }
                }
                .listStyle(.sidebar)
                Divider()
                HStack {
                    Button { ui.beginNew() } label: { Image(systemName: "plus") }.help("New Automation")
                    Button { if let s = ui.selection { _ = feature.remove(s); ui.selection = nil; ui.draft = nil } } label: { Image(systemName: "minus") }.disabled(ui.selection == nil)
                    Spacer()
                    Text((feature.sources?.active() ?? []).isEmpty ? "No watchers running" : "\(feature.sources?.active().count ?? 0) watchers").font(.caption).foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless).padding(8)
            }
            .frame(width: 260)
            Divider()
            if ui.draft != nil {
                AutomationEditor(feature: feature, ui: ui).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "bolt.badge.clock").font(.system(size: 38)).foregroundStyle(.tertiary)
                    Text("Automations").font(.title3.weight(.semibold))
                    Text("Run a workflow or command at a time, on a schedule, or when an app, Wi‑Fi network, power source, display or folder changes.")
                        .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 380)
                    Button("New Automation") { ui.beginNew() }
                }
                .padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            if ui.draft == nil, let s = ui.selection ?? list.first?.id {
                ui.selection = s
                ui.draft = list.first { $0.id == s }?.json
            }
        }
    }
}

struct AutomationEditor: View {
    let feature: AutomationsFeature
    @Bindable var ui: AutomationsUIModel

    private var draft: JSONValue { ui.draft ?? .null }
    private func set(_ path: [String], _ v: JSONValue) {
        guard var d = ui.draft?.objectValue else { return }
        if path.count == 1 { d[path[0]] = v } else {
            var inner = d[path[0]]?.objectValue ?? [:]
            inner[path[1]] = v
            d[path[0]] = .object(inner)
        }
        ui.draft = .object(d)
    }
    private func str(_ path: [String]) -> Binding<String> {
        Binding(get: { (path.count == 1 ? draft[path[0]] : draft[path[0]]?[path[1]])?.description.replacingOccurrences(of: "null", with: "") ?? "" },
                set: { set(path, .string($0)) })
    }
    private var kind: String { draft["trigger"]?["kind"]?.stringValue ?? "time" }
    private var targetKind: String { draft["target"]?["kind"]?.stringValue ?? "workflow" }

    var body: some View {
        let existing = ui.selection.flatMap { feature.engine?.get($0) }
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Name", text: str(["name"]), prompt: Text(AutomationModel.normalizeTrigger(draft["trigger"]).map(AutomationModel.describe) ?? "Automation"))
                    Toggle("Enabled", isOn: Binding(get: { draft["enabled"]?.boolValue != false }, set: { set(["enabled"], .bool($0)) }))
                    Toggle("Ask before running", isOn: Binding(get: { draft["askBeforeRunning"]?.boolValue ?? defaultAsk }, set: { set(["askBeforeRunning"], .bool($0)) }))
                }
                Section("When") {
                    Picker("Trigger", selection: Binding(get: { kind }, set: { set(["trigger"], AutomationModel.defaultTrigger($0).json) })) {
                        ForEach(AutomationModel.triggerKinds, id: \.kind) { k in Label(k.title, systemImage: k.symbol).tag(k.kind) }
                    }
                    triggerFields
                }
                Section("Do") {
                    Picker("Run", selection: Binding(get: { targetKind }, set: { k in
                        set(["target"], k == "workflow" ? ["kind": "workflow", "workflowId": ""] : ["kind": "command", "itemId": "", "title": "", "argument": ""])
                    })) {
                        Text("Workflow").tag("workflow")
                        Text("Command").tag("command")
                    }
                    if targetKind == "workflow" {
                        Picker("Workflow", selection: str(["target", "workflowId"])) {
                            Text("Choose…").tag("")
                            ForEach(feature.workflows) { w in
                                Text(w.name + (AutomationModel.isRisky(.workflow(workflowId: w.id), workflows: feature.workflows) ? "  ⚠︎" : "")).tag(w.id)
                            }
                        }
                    } else {
                        AutomationCommandPicker(feature: feature, itemId: str(["target", "itemId"]), title: str(["target", "title"]))
                        TextField("Argument", text: str(["target", "argument"]), prompt: Text("optional — {{input}} is the trigger's value"))
                    }
                }
                if let e = ui.error { Section { Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
                if let existing {
                    if let p = feature.problems[existing.id] { Section { Label(p, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) } }
                    Section {
                        if existing.log.isEmpty { Text("Never run").foregroundStyle(.secondary) }
                        ForEach(existing.log.prefix(20), id: \.id) { AutomationRunRow(record: $0) }
                    } header: {
                        HStack {
                            Text("Run Log")
                            Spacer()
                            if let n = feature.engine?.nextRun(existing.id), n.isFinite { Text("Next \(automationRelativeTime(n))").foregroundStyle(.secondary) }
                            Button("Clear") { feature.engine?.clearLog(existing.id) }.buttonStyle(.borderless).disabled(existing.log.isEmpty)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                if let existing {
                    Button { Task { @MainActor in _ = await feature.runNow(existing.id) } } label: { Label("Run Now", systemImage: "play.fill") }
                        .keyboardShortcut("r", modifiers: .command)
                        .disabled(feature.engine?.isRunning(existing.id) == true)
                }
                Spacer()
                Button("Revert") { ui.draft = existing?.json; ui.error = nil }.disabled(existing == nil)
                Button(existing == nil ? "Create" : "Save") { save() }.keyboardShortcut("s", modifiers: .command).buttonStyle(.borderedProminent)
            }
            .padding(10)
        }
    }

    private var defaultAsk: Bool {
        AutomationModel.normalizeTarget(draft["target"]).map { AutomationModel.isRisky($0, workflows: feature.workflows) } ?? true
    }

    private func save() {
        var d = ui.draft?.objectValue ?? [:]
        if let s = ui.selection { d["id"] = .string(s) }
        switch feature.save(.object(d)) {
        case let .ok(a):
            ui.selection = a.id
            ui.draft = a.json
            ui.error = nil
        case let .error(e): ui.error = e
        }
    }

    @ViewBuilder private var triggerFields: some View {
        switch kind {
        case "time":
            TextField("Time (24 h)", text: str(["trigger", "time"]), prompt: Text("09:00"))
            AutomationDaysPicker(days: Binding(get: { (draft["trigger"]?["days"]?.arrayValue ?? []).compactMap(\.intValue) }, set: { set(["trigger", "days"], .array($0.sorted().map { .int(Int64($0)) })) }))
        case "interval":
            Stepper("Every \(draft["trigger"]?["minutes"]?.intValue ?? 15) minutes", value: Binding(get: { draft["trigger"]?["minutes"]?.intValue ?? 15 }, set: { set(["trigger", "minutes"], .int(Int64($0))) }),
                    in: AutomationModel.minInterval...AutomationModel.maxInterval)
        case "app":
            eventPicker(["launched": "Launches", "quit": "Quits", "activated": "Becomes active"])
            TextField("App", text: str(["trigger", "app"]), prompt: Text("Any app — or a name / bundle id"))
        case "wifi":
            eventPicker(["joined": "Joining", "left": "Leaving", "changed": "Any change"])
            HStack {
                TextField("Network", text: str(["trigger", "network"]), prompt: Text("Any network"))
                Button("Use Current") { if let n = feature.sources?.currentNetwork() { set(["trigger", "network"], .string(n)) } }
            }
        case "power":
            eventPicker(["ac": "Connected to power", "battery": "Switched to battery", "below": "Battery drops to", "above": "Battery charges to"])
            if ["below", "above"].contains(draft["trigger"]?["event"]?.stringValue ?? "") {
                Stepper("\(draft["trigger"]?["percent"]?.intValue ?? 20)%", value: Binding(get: { draft["trigger"]?["percent"]?.intValue ?? 20 }, set: { set(["trigger", "percent"], .int(Int64($0))) }), in: 1...100, step: 5)
            }
        case "display":
            eventPicker(["connected": "Connected", "disconnected": "Disconnected", "any": "Any change"])
        case "folder":
            HStack {
                TextField("Folder", text: str(["trigger", "path"]), prompt: Text("~/Downloads"))
                Button("Choose…") {
                    let p = NSOpenPanel()
                    p.canChooseDirectories = true
                    p.canChooseFiles = false
                    if p.runModal() == .OK, let u = p.url { set(["trigger", "path"], .string(u.path)) }
                }
                .disabled(feature.context?.services.isHeadless ?? true)
            }
            eventPicker(["added": "A file is added", "any": "Anything changes"])
        case "hotkey":
            TextField("Hotkey", text: str(["trigger", "accelerator"]), prompt: Text("e.g. Control+Alt+M"))
        default:
            Text("Runs a few seconds after Glide starts.").foregroundStyle(.secondary)
        }
    }

    private func eventPicker(_ options: KeyValuePairs<String, String>) -> some View {
        Picker("Event", selection: str(["trigger", "event"])) {
            ForEach(Array(options), id: \.key) { k, v in Text(v).tag(k) }
        }
    }
}

struct AutomationDaysPicker: View {
    @Binding var days: [Int]
    var body: some View {
        LabeledContent("Days") {
            HStack(spacing: 4) {
                ForEach(0..<7, id: \.self) { d in
                    let on = days.isEmpty || days.contains(d)
                    Button(String(AutomationModel.dayNames[d].prefix(2))) {
                        var set = days.isEmpty ? Set(0..<7) : Set(days)
                        if set.contains(d) { set.remove(d) } else { set.insert(d) }
                        days = set.count == 7 || set.isEmpty ? [] : set.sorted()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 28, height: 22)
                    .background(RoundedRectangle(cornerRadius: 5).fill(on ? Color.accentColor.opacity(0.85) : Color.secondary.opacity(0.15)))
                    .foregroundStyle(on ? .white : .secondary)
                }
                Text(AutomationModel.describeDays(days)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// Search the launcher catalogue for a command target.
struct AutomationCommandPicker: View {
    let feature: AutomationsFeature
    @Binding var itemId: String
    @Binding var title: String
    @State private var query = ""
    @State private var results: [ScoredItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("Command") { Text(title.isEmpty ? "None chosen" : title).foregroundStyle(title.isEmpty ? .secondary : .primary) }
            TextField("Search commands", text: $query)
                .onChange(of: query) { _, q in
                    Task { @MainActor in results = Array((await feature.context?.search(q) ?? []).prefix(6)) }
                }
            ForEach(results, id: \.id) { r in
                Button { itemId = r.item.id; title = r.item.title; query = ""; results = [] } label: {
                    HStack { ItemIconView(r.item.icon, size: 16); Text(r.item.title); Spacer(); Text(r.item.kind.rawValue).font(.caption).foregroundStyle(.secondary) }
                }
                .buttonStyle(.plain)
            }
        }
    }
}
