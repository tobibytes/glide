import Foundation
import GlideCore
import GlideUI
import SwiftUI

/// Fallback commands under every query ("Use with…" section): Search Google / GitHub / YouTube / Files, Ask AI,
/// Ask Glide Agent, custom URL templates and quicklinks. Reorder / disable in Settings → Fallbacks.
@MainActor public final class FallbacksFeature: Feature, FeatureUI {
    public let id = "fallbacks"
    public let title = "Fallback Commands"
    private weak var context: FeatureContext?
    public init() {}
    public func start(context: FeatureContext) async { self.context = context }

    public var prefs: FallbacksModel.Prefs { FallbacksModel.Prefs(bag: context?.settings(defaults: [:]) ?? [:]) }
    var quicklinks: [Quicklink] { context?.store.data.quicklinks ?? [] }


    public func items() -> [SearchItem] {
        guard context != nil else { return [] }
        let defs = FallbacksModel.enabled(prefs, quicklinks: quicklinks)
        return defs.map { f in
            SearchItem(id: "fallbacks:\(f.id)", kind: .fallback, title: f.name, icon: f.icon, url: f.url, feature: id,
                       data: ["fallbackId": .string(f.id), "action": .string(f.action.rawValue)])
        } + [SearchItem(id: "fallbacks:manage", kind: .command, title: "Manage Fallback Commands", subtitle: "Choose what appears when nothing matches",
                        icon: .symbol("arrow.down.to.line"), keywords: ["fallback", "search", "web", "default"], feature: id, data: ["action": "manage"], kindLabel: "Settings")]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        if item.data?["action"]?.stringValue == "manage" { return [ItemAction(id: "manage", title: "Open Settings", shortcut: "↩", icon: "gearshape")] }
        var list = [ItemAction(id: "open", title: item.title, shortcut: "↩", icon: "arrow.up.forward")]
        if item.url != nil { list.append(ItemAction(id: "copyUrl", title: "Copy URL", shortcut: "⌘↩", icon: "doc.on.doc")) }
        list.append(ItemAction(id: "manage", title: "Manage Fallback Commands", shortcut: "⌘,", icon: "gearshape"))
        return list
    }

    func featureExists(_ fid: String) async -> Bool {
        guard let ctx = context else { return false }
        do {
            _ = try await ctx.callFeature(fid, method: "__glide_probe__", args: .null)
            return true
        } catch let e as FeatureError {
            if case .unknownFeature = e { return false }
            return true
        } catch { return true }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        let item = scored.item
        let query = scored.argument?.trimmingCharacters(in: .whitespaces) ?? ""
        if action == "manage" { return .openSettings(page: "fallbacks") }
        if action == "copyUrl", let url = item.url {
            ctx.services.pasteboard.setString(FallbacksModel.fill(url, query: query), html: nil, transient: false)
            return .hide(message: "URL copied")
        }
        guard action == "open" else { return .error("Unknown action \(action)") }
        switch FallbacksModel.Action(rawValue: item.data?["action"]?.stringValue ?? "url") ?? .url {
        case .files: return .pushView("fileindex.search", payload: ["query": .string(query)])
        case .ai:
            guard await featureExists("ai") else { return .error("Ask AI is not available in this build") }
            return .pushView("ai.chat", payload: ["prompt": .string(query)])
        case .agent:
            guard await featureExists("agent") else { return .error("Glide Agent is not available in this build") }
            // agent/open pushes `agent.run` AND starts the run (a bare push with a prompt payload would not).
            do {
                _ = try await ctx.callFeature("agent", method: "open", args: ["prompt": .string(query), "fresh": .bool(!query.isEmpty)])
                return .stay()
            } catch { return .error(error.localizedDescription) }
        case .url:
            guard let tpl = item.url, let url = URL(string: FallbacksModel.fill(tpl, query: query)) else { return .error("Fallback has no URL") }
            let r = ctx.services.workspace.open(url: url, withApp: nil)
            return r.ok ? .hide() : .error(r.error ?? "Could not open")
        }
    }

    // MARK: settings methods (also the test channel)

    func save(_ p: FallbacksModel.Prefs) {
        context?.setSettings(p.bag)
        context?.refreshCatalogue()
    }

    var currentOrder: [String] { FallbacksModel.ordered(prefs, quicklinks: quicklinks).map(\.id) }

    public func move(_ fid: String, by delta: Int) {
        var p = prefs
        p.order = FallbacksModel.move(currentOrder, fid, by: delta)
        save(p)
    }

    public func setEnabled(_ fid: String, _ on: Bool) {
        var p = prefs
        p.disabled.removeAll { $0 == fid }
        if !on { p.disabled.append(fid) }
        save(p)
    }

    public func addCustom(name: String, url: String) throws -> String {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { throw FeatureError.invalidArguments("Name is required") }
        if let problem = FallbacksModel.validate(url) { throw FeatureError.invalidArguments(problem) }
        var p = prefs
        let cid = "custom-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))"
        let order = currentOrder
        p.custom.append(.init(id: cid, name: n, url: url.trimmingCharacters(in: .whitespaces)))
        p.order = order + [cid]
        save(p)
        return cid
    }

    public func removeCustom(_ cid: String) {
        var p = prefs
        p.custom.removeAll { $0.id == cid }
        p.order.removeAll { $0 == cid }
        p.disabled.removeAll { $0 == cid }
        save(p)
    }

    public func setQuicklink(_ qid: String, _ on: Bool) {
        var p = prefs
        p.quicklinks.removeAll { $0 == qid }
        if on { p.quicklinks.append(qid) }
        save(p)
    }

    func config() -> JSONValue {
        let p = prefs
        let off = Set(p.disabled)
        return ["entries": .array(FallbacksModel.ordered(p, quicklinks: quicklinks).map { ["id": .string($0.id), "name": .string($0.name), "enabled": .bool(!off.contains($0.id)), "source": .string($0.source.rawValue)] }),
                "quicklinks": .array(quicklinks.map { ["id": .string($0.id), "name": .string($0.name), "enabled": .bool(p.quicklinks.contains($0.id))] })]
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "getConfig": break
        case "move": move(args["id"]?.stringValue ?? "", by: args["delta"]?.intValue ?? 0)
        case "setEnabled": setEnabled(args["id"]?.stringValue ?? "", args["enabled"]?.boolValue ?? true)
        case "addCustom": _ = try addCustom(name: args["name"]?.stringValue ?? "", url: args["url"]?.stringValue ?? "")
        case "removeCustom": removeCustom(args["id"]?.stringValue ?? "")
        case "setQuicklink": setQuicklink(args["id"]?.stringValue ?? "", args["enabled"]?.boolValue ?? false)
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
        return config()
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Fallbacks", symbol: "arrow.down.to.line", order: 45) { [weak self] in AnyView(FallbacksSettingsView(feature: self)) }
    }
}

/// Keyboard-first settings: ↑/↓ select, ⌥⌘↑ / ⌥⌘↓ reorder, Space toggles, ⌫ removes a custom entry.
struct FallbacksSettingsView: View {
    weak var feature: FallbacksFeature?
    @State private var rows: [(def: FallbacksModel.Def, on: Bool)] = []
    @State private var selection: String?
    @State private var newName = ""
    @State private var newURL = "https://"
    @State private var error: String?
    @State private var links: [(id: String, name: String, on: Bool)] = []

    var body: some View {
        Form {
            Section {
                List(selection: $selection) {
                    ForEach(rows, id: \.def.id) { r in
                        HStack {
                            ItemIconView(r.def.icon, size: 18)
                            Text(r.def.name)
                            if r.def.source != .builtin { Tag(r.def.source == .custom ? "Custom" : "Quicklink") }
                            Spacer()
                            Toggle("", isOn: Binding(get: { r.on }, set: { feature?.setEnabled(r.def.id, $0); reload() })).labelsHidden()
                        }
                        .tag(r.def.id)
                    }
                }
                .frame(minHeight: 260)
                .onKeyPress(.space) { toggleSelected(); return .handled }
                HStack {
                    Button("Move Up") { moveSelected(-1) }.keyboardShortcut(.upArrow, modifiers: [.command, .option])
                    Button("Move Down") { moveSelected(1) }.keyboardShortcut(.downArrow, modifiers: [.command, .option])
                    Button("Remove") { removeSelected() }.keyboardShortcut(.delete, modifiers: [.command])
                        .disabled(rows.first { $0.def.id == selection }?.def.source != .custom)
                }
            } header: {
                Text("Shown under every search, in this order")
            } footer: {
                Text("⌥⌘↑ / ⌥⌘↓ reorder · Space enables or disables · ⌘⌫ removes a custom fallback")
            }
            Section("Add a custom fallback") {
                TextField("Name", text: $newName)
                TextField("URL with {query}", text: $newURL).onSubmit(add)
                if let error { Text(error).foregroundStyle(.red) }
                Button("Add Fallback", action: add)
            }
            if !links.isEmpty {
                Section("Quicklinks as fallbacks") {
                    ForEach(links, id: \.id) { l in
                        Toggle(l.name, isOn: Binding(get: { l.on }, set: { feature?.setQuicklink(l.id, $0); reload() }))
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: reload)
    }

    private func reload() {
        guard let f = feature else { return }
        let p = f.prefs
        let off = Set(p.disabled)
        rows = FallbacksModel.ordered(p, quicklinks: f.quicklinks).map { ($0, !off.contains($0.id)) }
        links = f.quicklinks.map { ($0.id, $0.name, p.quicklinks.contains($0.id)) }
    }
    private func moveSelected(_ d: Int) { if let s = selection { feature?.move(s, by: d); reload() } }
    private func toggleSelected() { if let s = selection, let r = rows.first(where: { $0.def.id == s }) { feature?.setEnabled(s, !r.on); reload() } }
    private func removeSelected() { if let s = selection { feature?.removeCustom(s); reload() } }
    private func add() {
        do {
            _ = try feature?.addCustom(name: newName, url: newURL)
            newName = ""
            newURL = "https://"
            error = nil
            reload()
        } catch { self.error = error.localizedDescription }
    }
}
