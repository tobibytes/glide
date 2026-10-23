import AppKit
import Foundation
import GlideCore
import GlideUI
import SwiftUI

/// Quicklinks 2.0 (port of src/main/quicklinks): the user's quicklinks (`quicklink:<id>`) with named arguments
/// `{argument name="…" default="…" options="a,b"}`, `{query}`, `{clipboard}`, `{selection}`, `{date format=… offset=…}`,
/// `{uuid}`, modifiers and per-placeholder encoding, "open with" an app, plus Create / Import / Export commands.
/// Replaces the phase-0 `QuicklinksFeature` (same feature id "quicklinks", same item ids).
@MainActor public final class Quicklinks2Feature: Feature, FeatureUI {
    public let id = "quicklinks"
    public let title = "Quicklinks"
    private weak var context: FeatureContext?
    let draft = QLDraft()
    public init() {}
    public func start(context: FeatureContext) async { self.context = context }

    var list: [Quicklink] { context?.store.data.quicklinks ?? [] }

    static func item(_ q: Quicklink, featureId: String) -> SearchItem {
        let defs = QLTemplate.arguments(q.url)
        var data: [String: JSONValue] = [:]
        if !defs.isEmpty { data["arguments"] = .array(defs.map(\.json)) }
        if let w = q.openWith, !w.isEmpty { data["openWith"] = .string(w) }
        return SearchItem(id: "quicklink:\(q.id)", kind: .quicklink, title: q.name, subtitle: q.url, icon: q.icon ?? .symbol("link"), keywords: q.keywords, alias: q.alias,
                          url: q.url, source: "quicklinks", acceptsArgument: defs.isEmpty ? nil : true, feature: featureId, data: data.isEmpty ? nil : data)
    }

    static func command(_ cid: String, _ title: String, _ subtitle: String, _ symbol: String, _ keywords: [String]) -> SearchItem {
        SearchItem(id: "quicklinks.\(cid)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol), keywords: keywords, feature: "quicklinks", kindLabel: "Quicklinks")
    }

    public func items() -> [SearchItem] {
        var create = Self.command("create", "Create Quicklink", "Save a URL with {argument} placeholders", "plus.circle", ["new", "add", "link", "url", "bookmark", "quicklink"])
        create.acceptsArgument = true
        return list.map { Self.item($0, featureId: id) } + [
            create,
            Self.command("import", "Import Quicklinks…", "From a Glide or Raycast JSON export on the clipboard", "square.and.arrow.down", ["import", "json", "raycast"]),
            Self.command("export", "Export Quicklinks…", "Copy all quicklinks as JSON", "square.and.arrow.up", ["export", "json", "backup"]),
        ]
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.id {
        case "quicklinks.export": return [ItemAction(id: "exportCopy", title: "Copy JSON", shortcut: "↩", icon: "doc.on.doc")]
        case "quicklinks.import": return [ItemAction(id: "importClipboard", title: "Import JSON from Clipboard", shortcut: "↩", icon: "doc.on.clipboard")]
        case "quicklinks.create": return [ItemAction(id: "open", title: "Create Quicklink", shortcut: "↩", icon: "plus"), ItemAction(id: "settings", title: "Open Quicklinks Settings", shortcut: "⌘↩", icon: "gearshape")]
        default: break
        }
        let openTitle = item.data?["openWith"]?.stringValue.map { "Open in \((($0 as NSString).lastPathComponent as NSString).deletingPathExtension)" } ?? "Open"
        return [ItemAction(id: "open", title: openTitle, shortcut: "↩", icon: "safari"), ItemAction(id: "copyUrl", title: "Copy URL", shortcut: "⌘↩", icon: "doc.on.doc"),
                ItemAction(id: "edit", title: "Edit Quicklink", shortcut: "⌘E", icon: "pencil"), ItemAction(id: "delete", title: "Delete Quicklink", shortcut: "⌃X", icon: "trash", destructive: true)]
    }

    /// Render the URL for the launcher's argument values; clipboard and selection are read only when used.
    public func resolve(_ template: String, named: [String: String]?, argument: String?) async -> QLCore.Resolution {
        guard let ctx = context else { return .error("Not ready") }
        var env = QLTemplate.Env()
        if QLTemplate.uses(template, "clipboard") { env.clipboard = ctx.services.pasteboard.string() ?? "" }
        if QLTemplate.uses(template, "selection") { env.selection = await ctx.services.selection.selectedText().text ?? "" }
        return QLCore.resolve(template, named: named, argument: argument, env: env)
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        guard let ctx = context else { return .error("Not started") }
        switch action {
        case "exportCopy":
            ctx.services.pasteboard.setString(QLCore.exportJSON(list), html: nil, transient: false)
            return .hide(message: "Quicklinks JSON copied (\(list.count))")
        case "importClipboard":
            do { return .stay(message: try importJSON(ctx.services.pasteboard.string() ?? "")) } catch { return .error(error.localizedDescription) }
        case "settings": return .openSettings(page: "quicklinks")
        default: break
        }
        if scored.item.id == "quicklinks.create" {
            draft.reset(url: scored.argument ?? "")
            return .pushView("quicklinks.create", payload: ["url": .string(scored.argument ?? "")])
        }
        let qid = String(scored.item.id.dropFirst("quicklink:".count))
        guard let q = list.first(where: { $0.id == qid }) else { return .error("Quicklink not found") }
        switch action {
        case "open", "copyUrl":
            let r = await resolve(q.url, named: scored.arguments, argument: scored.argument)
            guard case let .url(filled) = r else {
                if case let .error(e) = r { return .error(e) }
                return .error("Could not build URL")
            }
            if filled.isEmpty { return .error("The quicklink produced an empty URL") }
            if action == "copyUrl" {
                ctx.services.pasteboard.setString(filled, html: nil, transient: false)
                return .hide(message: "URL copied")
            }
            guard let url = URL(string: filled) else { return .error("Invalid URL \(filled)") }
            let ow = q.openWith?.trimmingCharacters(in: .whitespaces)
            let res = ctx.services.workspace.open(url: url, withApp: ow?.isEmpty == false ? ow : nil)
            return res.ok ? .hide() : .error(res.error ?? "Could not open")
        case "edit": return .openSettings(page: "quicklinks/\(qid)")
        case "delete":
            ctx.store.deleteQuicklink(qid)
            return .stay(message: "Quicklink deleted")
        default: return .error("Unknown action \(action)")
        }
    }

    // MARK: saving / import

    @discardableResult
    public func save(name: String, url: String, openWith: String? = nil, alias: String? = nil, id existing: String? = nil) throws -> Quicklink {
        guard let ctx = context else { throw FeatureError.failed("Not ready") }
        let n = name.trimmingCharacters(in: .whitespaces), u = url.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, !u.isEmpty else { throw FeatureError.invalidArguments("Name and URL are required") }
        var q = existing.flatMap { e in list.first { $0.id == e } } ?? Quicklink(id: QLCore.newId(), name: n, url: u)
        q.name = n
        q.url = u
        q.openWith = openWith?.trimmingCharacters(in: .whitespaces).isEmpty == false ? openWith : nil
        if let alias { q.alias = alias.isEmpty ? nil : alias }
        ctx.store.saveQuicklink(q)
        ctx.refreshCatalogue()
        return q
    }

    func importJSON(_ json: String) throws -> String {
        guard let ctx = context else { throw FeatureError.failed("Not ready") }
        let parsed = try QLCore.parseImport(json)
        let fresh = QLCore.dedupe(parsed.quicklinks, existing: list)
        _ = ctx.store.mutate { d in for var q in fresh { q.id = QLCore.newId(); d.quicklinks.append(q) } }
        ctx.refreshCatalogue()
        let dup = parsed.quicklinks.count - fresh.count
        return "Imported \(fresh.count) quicklink\(fresh.count == 1 ? "" : "s")\(dup > 0 ? " · \(dup) already existed" : "")\(parsed.skipped > 0 ? " · \(parsed.skipped) skipped" : "")"
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "list": return .array(list.map { ["id": .string($0.id), "name": .string($0.name), "url": .string($0.url)] })
        case "arguments": return .array(QLTemplate.arguments(args.stringValue ?? args["url"]?.stringValue ?? "").map(\.json))
        case "preview":
            var named: [String: String] = [:]
            for (k, v) in args["values"]?.objectValue ?? [:] { if let s = v.stringValue { named[k] = s } }
            switch await resolve(args["url"]?.stringValue ?? "", named: named, argument: args["argument"]?.stringValue) {
            case let .url(u): return ["url": .string(u)]
            case let .error(e): return ["error": .string(e)]
            }
        case "save":
            let q = try save(name: args["name"]?.stringValue ?? "", url: args["url"]?.stringValue ?? "", openWith: args["openWith"]?.stringValue,
                             alias: args["alias"]?.stringValue, id: args["id"]?.stringValue)
            return ["id": .string(q.id)]
        case "delete":
            context?.store.deleteQuicklink(args.stringValue ?? args["id"]?.stringValue ?? "")
            return true
        case "importJson": return .string(try importJSON(args.stringValue ?? args["json"]?.stringValue ?? ""))
        case "exportJson": return .string(QLCore.exportJSON(list))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    // MARK: UI

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard vid.rawValue == "quicklinks.create" else { return nil }
        host.setPlaceholder("Create Quicklink — fill the form, ⌘↩ to save")
        host.setFooter(primary: "Save Quicklink", hasActions: false)
        return AnyView(QLCreateView(draft: draft, onSave: { [weak self, weak host] in self?.saveDraft(host: host) }))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        guard view.rawValue == "quicklinks.create" else { return false }
        if key.key == "Enter" && key.meta {
            saveDraft(host: nil)
            return true
        }
        return false
    }

    func saveDraft(host: LauncherViewHost?) {
        do {
            let q = try save(name: draft.name, url: draft.url, openWith: draft.openWith)
            draft.reset(url: "")
            context?.toast("Saved quicklink “\(q.name)”", style: .success)
            host?.pop()
        } catch {
            draft.error = error.localizedDescription
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Quicklinks", symbol: "link", order: 40) { [weak self] in AnyView(QLSettingsView(feature: self)) }
    }
}

@MainActor @Observable final class QLDraft {
    var name = ""
    var url = ""
    var openWith = ""
    var error: String?
    func reset(url: String) {
        name = ""
        self.url = url
        openWith = ""
        error = nil
    }
    var arguments: [QLTemplate.ArgumentDef] { QLTemplate.arguments(url) }
}

struct QLCreateView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var draft: QLDraft
    let onSave: () -> Void
    @FocusState private var focus: Int?

    var body: some View {
        Form {
            TextField("Name", text: $draft.name).focused($focus, equals: 0)
            TextField("URL (use {argument name=\"…\"}, {query}, {clipboard}, {selection}, {date}, {uuid})", text: $draft.url).focused($focus, equals: 1)
            TextField("Open with (app path or bundle id, optional)", text: $draft.openWith).focused($focus, equals: 2)
            if !draft.arguments.isEmpty {
                LabeledContent("Arguments") {
                    HStack { ForEach(draft.arguments, id: \.name) { Tag($0.optional ? $0.placeholder : "\($0.placeholder) *") } }
                }
            }
            if let e = draft.error { Text(e).foregroundStyle(theme.danger) }
            HStack {
                Spacer()
                Button("Save Quicklink", action: onSave).keyboardShortcut(.return, modifiers: .command)
            }
        }
        .formStyle(.grouped)
        .onAppear { focus = 0 }
    }
}

struct QLSettingsView: View {
    weak var feature: Quicklinks2Feature?
    @State private var rows: [Quicklink] = []
    @State private var selection: String?
    @State private var name = ""
    @State private var url = ""
    @State private var openWith = ""
    @State private var message: String?

    var body: some View {
        HSplitView {
            List(rows, id: \.id, selection: $selection) { q in
                VStack(alignment: .leading) {
                    Text(q.name)
                    Text(q.url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }.tag(q.id)
            }
            .frame(minWidth: 200)
            Form {
                TextField("Name", text: $name)
                TextField("URL", text: $url)
                TextField("Open with", text: $openWith)
                let defs = QLTemplate.arguments(url)
                if !defs.isEmpty { LabeledContent("Arguments", value: defs.map(\.placeholder).joined(separator: ", ")) }
                if let message { Text(message).foregroundStyle(.secondary) }
                HStack {
                    Button("New") { selection = nil; name = ""; url = ""; openWith = "" }.keyboardShortcut("n", modifiers: .command)
                    Button("Delete") { if let s = selection { Task { _ = try? await feature?.invoke(method: "delete", args: .string(s)); reload() } } }
                        .keyboardShortcut(.delete, modifiers: .command).disabled(selection == nil)
                    Spacer()
                    Button("Save") {
                        do {
                            let q = try feature?.save(name: name, url: url, openWith: openWith, id: selection)
                            selection = q?.id
                            message = "Saved"
                            reload()
                        } catch { message = error.localizedDescription }
                    }.keyboardShortcut("s", modifiers: .command)
                }
            }
            .formStyle(.grouped)
        }
        .onAppear(perform: reload)
        .onChange(of: selection) { _, s in
            guard let q = rows.first(where: { $0.id == s }) else { return }
            name = q.name
            url = q.url
            openWith = q.openWith ?? ""
        }
    }

    private func reload() { rows = feature?.list ?? [] }
}
