import GlideCore
import Observation
import SwiftUI

/// Settings → Agent → MCP Servers state (secrets arrive masked as SECRET_KEEP).
@MainActor @Observable final class MCPSettingsModel {
    var servers: [JSONValue] = []
    var testResults: [String: JSONValue] = [:]
    var importText = ""
    var importPreview: JSONValue?
    var message: String?
    var draft = MCPDraft()
    var showingAdd = false

    func reload(_ m: MCPManager?) { servers = m?.list() ?? [] }
}

/// The add/edit form: one value per line for args, KEY=value env lines, "Key: value" header lines.
struct MCPDraft: Equatable {
    var id: String?
    var name = ""
    var transport = "stdio"
    var command = ""
    var args = ""
    var env = ""
    var cwd = ""
    var url = ""
    var headers = ""
    var timeoutSec = 30
    var rateLimit = 30
    var autoRunReadOnly = false

    static func lines(_ s: String) -> [String] { s.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }

    static func pairs(_ s: String, sep: Character) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for l in lines(s) {
            guard let i = l.firstIndex(of: sep) else { continue }
            let k = l[..<i].trimmingCharacters(in: .whitespaces)
            let v = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
            if !k.isEmpty { out[k] = .string(v) }
        }
        return out
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["name": .string(name), "transport": .string(transport), "enabled": true,
                                      "timeoutMs": .int(Int64(timeoutSec * 1000)), "rateLimitPerMinute": .int(Int64(rateLimit)), "autoRunReadOnly": .bool(autoRunReadOnly)]
        if let id { o["id"] = .string(id) }
        if transport == "stdio" {
            o["command"] = .string(command)
            o["args"] = .array(Self.lines(args).map(JSONValue.string))
            if !cwd.isEmpty { o["cwd"] = .string(cwd) }
            let e = Self.pairs(env, sep: "=")
            if !e.isEmpty { o["env"] = .object(e) }
        } else {
            o["url"] = .string(url)
            let h = Self.pairs(headers, sep: ":")
            if !h.isEmpty { o["headers"] = .object(h) }
        }
        return .object(o)
    }

    init() {}

    init(server s: JSONValue) {
        id = s["id"]?.stringValue
        name = s["name"]?.stringValue ?? ""
        transport = s["transport"]?.stringValue ?? "stdio"
        command = s["command"]?.stringValue ?? ""
        args = (s["args"]?.arrayValue ?? []).compactMap(\.stringValue).joined(separator: "\n")
        env = (s["env"]?.objectValue ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.stringValue == MCPServerConfig.secretKeep ? MCPServerConfig.secretKeep : ($0.value.stringValue ?? ""))" }.joined(separator: "\n")
        cwd = s["cwd"]?.stringValue ?? ""
        url = s["url"]?.stringValue ?? ""
        headers = (s["headers"]?.objectValue ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key): \($0.value.stringValue ?? "")" }.joined(separator: "\n")
        timeoutSec = (s["timeoutMs"]?.intValue ?? 30_000) / 1000
        rateLimit = s["rateLimitPerMinute"]?.intValue ?? 30
        autoRunReadOnly = s["autoRunReadOnly"]?.boolValue == true
    }
}

struct MCPServersSection: View {
    @Bindable var model: MCPSettingsModel
    let feature: AgentFeature

    var body: some View {
        Section {
            if model.servers.isEmpty {
                Text("No MCP servers. Add one, or import a Claude Desktop / .mcp.json config. Imported servers start off so you can check each command first.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(model.servers.indices, id: \.self) { i in
                MCPServerRow(server: model.servers[i], test: model.testResults[model.servers[i]["id"]?.stringValue ?? ""], feature: feature, model: model)
            }
            HStack {
                Button("Add Server…") { model.draft = MCPDraft(); model.showingAdd.toggle() }.keyboardShortcut("n", modifiers: [.command, .shift])
                Spacer()
                if let m = model.message { Text(m).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            }
            if model.showingAdd { MCPDraftForm(model: model, feature: feature) }
            DisclosureGroup("Import…") {
                TextEditor(text: $model.importText).font(.system(size: 11, design: .monospaced)).frame(minHeight: 90)
                HStack {
                    Button("Preview") { model.importPreview = feature.mcp?.importConfig(model.importText, apply: false) }
                    Button("Import") {
                        model.importPreview = feature.mcp?.importConfig(model.importText, apply: true)
                        model.message = model.importPreview?["imported"].map { "Imported \($0.description) server(s)" } ?? model.importPreview?["error"]?.stringValue
                    }
                    .disabled(model.importText.isEmpty)
                }
                if let p = model.importPreview {
                    ForEach((p["servers"]?.arrayValue ?? []).indices, id: \.self) { i in
                        let s = (p["servers"]?.arrayValue ?? [])[i]
                        Text("\(s["name"]?.stringValue ?? "") — \(s["transport"]?.stringValue ?? "") \(s["command"]?.stringValue ?? s["url"]?.stringValue ?? "")\(s["exists"]?.boolValue == true ? " (exists, skipped)" : "")")
                            .font(.caption.monospaced())
                    }
                    if let e = p["error"]?.stringValue { Text(e).font(.caption).foregroundStyle(.red) }
                }
            }
        } header: {
            Text("MCP Servers")
        } footer: {
            Text("Tools are offered to Claude as mcp__<server>__<tool>. Read-only tools of untrusted servers and every other tool ask before running. Header and environment values are stored encrypted (Keychain).")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct MCPServerRow: View {
    let server: JSONValue
    let test: JSONValue?
    let feature: AgentFeature
    let model: MCPSettingsModel

    var id: String { server["id"]?.stringValue ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(server["name"]?.stringValue ?? "").font(.headline)
                Text(server["transport"]?.stringValue ?? "").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Toggle("Enabled", isOn: Binding(get: { server["enabled"]?.boolValue == true }, set: { on in
                    Task { @MainActor in _ = await feature.mcp?.setEnabled(id, on) }
                })).labelsHidden()
            }
            Text(server["command"]?.stringValue.map { ([$0] + (server["args"]?.arrayValue ?? []).compactMap(\.stringValue)).joined(separator: " ") } ?? server["url"]?.stringValue ?? "")
                .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
            if let e = server["error"]?.stringValue { Text(e).font(.caption).foregroundStyle(.red).lineLimit(3) }
            HStack {
                Button("Test Connection") {
                    Task { @MainActor in
                        model.testResults[id] = await feature.mcp?.test(.string(id))
                        model.reload(feature.mcp)
                    }
                }
                Button("Reconnect") { Task { @MainActor in model.testResults[id] = await feature.mcp?.reconnect(id) } }
                Button("Edit") { model.draft = MCPDraft(server: server); model.showingAdd = true }
                Button("Remove", role: .destructive) { Task { @MainActor in _ = await feature.mcp?.remove(id) } }
                if let t = test {
                    Text(t["ok"]?.boolValue == true ? "✓ \(t["tools"]?.arrayValue?.count ?? 0) tools in \(t["ms"]?.description ?? "?") ms" : (t["error"]?.stringValue ?? "Failed"))
                        .font(.caption).foregroundStyle(t["ok"]?.boolValue == true ? Color.green : Color.red).lineLimit(2)
                }
            }
            ForEach((server["tools"]?.arrayValue ?? []).indices, id: \.self) { i in
                let t = (server["tools"]?.arrayValue ?? [])[i]
                MCPToolRow(serverId: id, server: server, tool: t, feature: feature)
            }
        }
        .padding(.vertical, 4)
    }

    var color: Color {
        switch server["state"]?.stringValue {
        case "ready"?: return .green
        case "connecting"?: return .yellow
        case "error"?: return .red
        default: return .gray
        }
    }
}

struct MCPToolRow: View {
    let serverId: String
    let server: JSONValue
    let tool: JSONValue
    let feature: AgentFeature

    var body: some View {
        let name = tool["name"]?.stringValue ?? ""
        let agentName = tool["agentName"]?.stringValue ?? ""
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(tool["title"]?.stringValue ?? name).font(.callout)
                Text("\(agentName) · \(tool["readOnly"]?.boolValue == true ? "read-only" : "may change data")").font(.caption2.monospaced()).foregroundStyle(.secondary)
            }
            Spacer()
            Toggle("Offer", isOn: Binding(get: { tool["enabled"]?.boolValue != false }, set: { on in
                guard case var .object(o) = server else { return }
                var disabled = (o["disabledTools"]?.arrayValue ?? []).compactMap(\.stringValue).filter { $0 != name }
                if !on { disabled.append(name) }
                o["disabledTools"] = .array(disabled.map(JSONValue.string))
                Task { @MainActor in _ = await feature.mcp?.save(.object(o)) }
            })).toggleStyle(.checkbox)
            Toggle("Allow without asking", isOn: Binding(get: { feature.settings.allow[agentName] == true }, set: { feature.setAllowed(agentName, $0) }))
                .toggleStyle(.checkbox)
        }
        .padding(.leading, 16)
    }
}

struct MCPDraftForm: View {
    @Bindable var model: MCPSettingsModel
    let feature: AgentFeature

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Name", text: $model.draft.name)
            Picker("Transport", selection: $model.draft.transport) {
                Text("stdio (command)").tag("stdio")
                Text("Streamable HTTP").tag("http")
                Text("SSE (legacy)").tag("sse")
            }
            if model.draft.transport == "stdio" {
                TextField("Command (full path recommended)", text: $model.draft.command)
                Text("Arguments (one per line)").font(.caption)
                TextEditor(text: $model.draft.args).font(.system(size: 11, design: .monospaced)).frame(minHeight: 40)
                Text("Environment (KEY=value per line, stored encrypted)").font(.caption)
                TextEditor(text: $model.draft.env).font(.system(size: 11, design: .monospaced)).frame(minHeight: 40)
                TextField("Working directory (optional)", text: $model.draft.cwd)
            } else {
                TextField("URL", text: $model.draft.url)
                Text("Headers (Key: value per line, e.g. Authorization: Bearer …; stored encrypted)").font(.caption)
                TextEditor(text: $model.draft.headers).font(.system(size: 11, design: .monospaced)).frame(minHeight: 40)
            }
            Stepper("Timeout: \(model.draft.timeoutSec) s", value: $model.draft.timeoutSec, in: 1...600)
            Stepper("Max calls per minute: \(model.draft.rateLimit == 0 ? "no limit" : String(model.draft.rateLimit))", value: $model.draft.rateLimit, in: 0...1000)
            Toggle("Run read-only tools without asking", isOn: $model.draft.autoRunReadOnly)
            HStack {
                Button("Test Connection") {
                    Task { @MainActor in
                        let r = await feature.mcp?.test(model.draft.json)
                        model.message = r?["ok"]?.boolValue == true ? "Connected: \(r?["tools"]?.arrayValue?.count ?? 0) tools" : (r?["error"]?.stringValue ?? "Failed")
                    }
                }
                Spacer()
                Button("Cancel") { model.showingAdd = false }.keyboardShortcut(.cancelAction)
                Button("Save") {
                    Task { @MainActor in
                        let r = await feature.mcp?.save(model.draft.json)
                        if r?["ok"]?.boolValue == true { model.showingAdd = false; model.message = "Saved" } else { model.message = r?["error"]?.stringValue }
                    }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }
}
