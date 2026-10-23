import AppKit
import GlideCore
import GlideUI
import Observation
import SwiftUI

/// Text Transforms (feature id "transforms", like src/main/features/transforms): "Transform Text" (a launcher
/// view previewing every transform of the selected text, else the clipboard) plus one root command per
/// transform ("uppercase", "json pretty"). ⏎ pastes into the app behind the launcher, ⌘⏎ / ⌘C copy, ⌘I
/// chains, ⇧⌘V uses the clipboard, ⌘T the search text, ⌘K shows all of these.
@MainActor public final class TransformsFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "transforms"
    public let title = "Text Transforms"
    public static let viewName = "transform"
    public static var viewId: ViewID { ViewID(feature: "transforms", name: viewName) }
    private weak var context: FeatureContext?
    /// The view model of the pushed "transforms.transform" view (created when pushing, so keys work even
    /// before SwiftUI renders — headless runs never render until a snapshot).
    private(set) var session: TransformSession?

    public init() {}

    public func start(context: FeatureContext) async { self.context = context }
    public func stop() async { session = nil }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        var out = [SearchItem(id: "transforms:open", kind: .command, title: "Transform Text", subtitle: "Selection or clipboard → case, JSON, Base64, hashes…",
                              icon: .emoji("🔀"), keywords: ["transform", "convert text", "case", "encode", "decode", "format", "text tools"],
                              feature: id, data: ["action": "open"], kindLabel: "Transform")]
        for t in TextTransforms.all {
            out.append(SearchItem(id: "transforms:\(t.id)", kind: .command, title: t.title, subtitle: t.usesInput ? "Transform selection or clipboard" : "Text transform",
                                  icon: .emoji("🔀"), keywords: t.keywords + ["transform", t.category.rawValue.lowercased()],
                                  feature: id, data: ["action": "one", "transform": .string(t.id)], kindLabel: "Transform"))
        }
        return out
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "open": return [ItemAction(id: "open", title: "Transform Text", shortcut: "↩", icon: "wand.and.stars")]
        case "one":
            return [ItemAction(id: "preview", title: "Preview Transform", shortcut: "↩", icon: "eye"),
                    ItemAction(id: "paste", title: "Paste Result", shortcut: "⌘↩", icon: "doc.on.clipboard"),
                    ItemAction(id: "copy", title: "Copy Result", shortcut: "⇧⌘C", icon: "doc.on.doc")]
        default: return []
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        let tid = scored.item.data?["transform"]?.stringValue ?? ""
        switch action {
        case "open": return openView(preferred: nil)
        case "preview": return openView(preferred: tid)
        case "paste", "copy": return await runOne(tid, verb: action)
        default: return .error("Unknown action \(action)")
        }
    }

    private func openView(preferred: String?) -> ActionResult {
        let s = makeSession(preferred: preferred)
        s.loadInput()
        var payload: [String: JSONValue] = ["title": "Transform Text", "session": .string(s.nonce)]
        if let preferred { payload["transform"] = .string(preferred) }
        return .pushView(Self.viewId, payload: .object(payload))
    }

    @discardableResult
    func makeSession(preferred: String?) -> TransformSession {
        let s = TransformSession(feature: self, preferred: preferred)
        session = s
        return s
    }

    private func runOne(_ tid: String, verb: String) async -> ActionResult {
        guard let ctx = context else { return .error("Not started") }
        guard let t = TextTransforms.byId(tid) else { return .error("Unknown transform \(tid)") }
        let input = t.usesInput ? await SelectionInput.read(ctx.services) : SelectionInput(text: "", source: .none)
        switch TextTransforms.apply(tid, input.text) {
        case let .failure(e): return .error(e)
        case let .ok(out):
            if verb == "paste" {
                paste(out)
                return .hide(message: "Pasted")
            }
            ctx.services.pasteboard.setString(out, html: nil, transient: false)
            return .hide(message: "Copied")
        }
    }

    // MARK: services for the view

    var services: SystemServices? { context?.services }

    /// Non-activating launcher: hiding the panel hands key focus back to the user's app (still frontmost),
    /// then the paste service writes the pasteboard and posts ⌘V there.
    func paste(_ text: String) {
        guard let ctx = context else { return }
        ctx.hideLauncher()
        ctx.services.paste.paste(text: text, html: nil)
    }

    func copy(_ text: String) {
        context?.services.pasteboard.setString(text, html: nil, transient: false)
        toast("Copied", .success)
    }

    func toast(_ message: String, _ style: ToastStyle) { context?.toast(message, style: style) }

    // MARK: UI

    public func launcherView(_ view: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard view.name == Self.viewName else { return nil }
        let s: TransformSession
        if let cur = session, payload["session"]?.stringValue == nil || payload["session"]?.stringValue == cur.nonce {
            s = cur
        } else {
            s = makeSession(preferred: payload["transform"]?.stringValue)
            s.loadInput()
        }
        return AnyView(TransformView(session: s, host: host))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool {
        guard view.name == Self.viewName, let s = session else { return false }
        return s.handleKey(key)
    }

    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool {
        guard view.name == Self.viewName, let s = session else { return false }
        return s.handleCommand(command)
    }

    // MARK: test channel

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "list":
            return .array(TextTransforms.all.map { ["id": .string($0.id), "title": .string($0.title), "category": .string($0.category.rawValue)] })
        case "apply":
            let r = TextTransforms.apply(args["id"]?.stringValue ?? "", args["text"]?.stringValue ?? args["input"]?.stringValue ?? "", TransformOptions(width: args["width"]?.intValue))
            switch r {
            case let .ok(o): return ["ok": true, "output": .string(o)]
            case let .failure(e): return ["ok": false, "error": .string(e)]
            }
        case "input":
            guard let ctx = context else { throw FeatureError.failed("Not started") }
            let i = await SelectionInput.read(ctx.services)
            return ["text": .string(i.text), "source": .string(i.source.rawValue), "note": i.note.map(JSONValue.string) ?? .null]
        case "state":
            guard let s = session else { return .null }
            await s.waitForInput()
            return s.stateJSON()
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

/// One row of the transform list.
struct TransformRow: Identifiable, Equatable {
    let id: String
    let section: String
    let transform: String
}

/// View model of the "transforms.transform" launcher view.
@MainActor @Observable final class TransformSession {
    /// Inputs above this size only compute the selected transform (no per-row previews).
    static let previewAllLimit = 64 * 1024

    @ObservationIgnored weak var feature: TransformsFeature?
    let nonce = UUID().uuidString
    let preferred: String?
    var input: SelectionInput?
    var selectedIndex = 0
    var panelOpen = false
    var panelIndex = 0
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored var queryProvider: () -> String = { LauncherHosts.current?.query ?? "" }

    init(feature: TransformsFeature?, preferred: String?) {
        self.feature = feature
        self.preferred = preferred
    }

    func loadInput() {
        guard loadTask == nil, let services = feature?.services else { return }
        loadTask = Task { @MainActor [weak self] in
            let i = await SelectionInput.read(services)
            self?.input = i
        }
    }

    func waitForInput() async { await loadTask?.value }

    var query: String { queryProvider() }
    var parsed: (query: String, width: Int?) { TextTransforms.parseQuery(query) }
    var options: TransformOptions { TransformOptions(width: parsed.width) }
    var text: String { input?.text ?? "" }

    var rows: [TransformRow] {
        let needle = parsed.query.trimmingCharacters(in: .whitespaces)
        let list = TextTransforms.filter(needle)
        var out: [TransformRow] = []
        if let p = preferred, needle.isEmpty, list.contains(where: { $0.id == p }) {
            out.append(TransformRow(id: "pick:\(p)", section: "Suggested", transform: p))
        }
        for t in list where !(out.first?.transform == t.id) {
            out.append(TransformRow(id: t.id, section: t.category.rawValue, transform: t.id))
        }
        return out
    }

    var selected: TransformRow? {
        let r = rows
        guard !r.isEmpty else { return nil }
        return r[min(max(0, selectedIndex), r.count - 1)]
    }

    func result(_ id: String) -> TransformResult { TextTransforms.apply(id, text, options) }
    /// Row previews are skipped for very large inputs.
    func preview(_ id: String) -> TransformResult? { text.utf16.count > Self.previewAllLimit ? nil : result(id) }

    struct PanelAction: Identifiable, Equatable { let id: String, title: String, shortcut: String, icon: String }
    let panelActions = [
        PanelAction(id: "paste", title: "Paste Result", shortcut: "↩", icon: "doc.on.clipboard"),
        PanelAction(id: "copy", title: "Copy Result", shortcut: "⌘C", icon: "doc.on.doc"),
        PanelAction(id: "chain", title: "Use Result as Input", shortcut: "⌘I", icon: "arrow.triangle.2.circlepath"),
        PanelAction(id: "clip", title: "Use Clipboard as Input", shortcut: "⇧⌘V", icon: "list.clipboard"),
        PanelAction(id: "query", title: "Use Search Text as Input", shortcut: "⌘T", icon: "character.cursor.ibeam"),
    ]

    // MARK: actions

    func perform(_ action: String) {
        guard let f = feature else { return }
        panelOpen = false
        switch action {
        case "paste", "copy", "chain":
            guard let row = selected else { f.toast("No transform matches", .error); return }
            switch result(row.transform) {
            case let .failure(e): f.toast(e, .error)
            case let .ok(out):
                if action == "paste" { f.paste(out) } else if action == "copy" { f.copy(out) } else {
                    input = SelectionInput(text: out, source: input?.source ?? .none)
                    f.toast("Result is the new input", .info)
                }
            }
        case "clip":
            let clip = f.services?.pasteboard.string() ?? ""
            input = SelectionInput(text: clip, source: clip.isEmpty ? .none : .clipboard)
            f.toast("Using the clipboard as input", .info)
        case "query":
            let q = query
            if q.trimmingCharacters(in: .whitespaces).isEmpty { f.toast("Type the text into the search field first", .error); return }
            input = SelectionInput(text: q, source: .none)
        default: break
        }
    }

    func handleKey(_ k: VimKey) -> Bool {
        if panelOpen {
            switch Vim.panelKey(k) {
            case let .move(d)?: panelIndex = min(panelActions.count - 1, max(0, panelIndex + d))
            case .run?: perform(panelActions[panelIndex].id)
            case .close?: panelOpen = false
            default:
                if k.meta || k.ctrl, let a = panelActions.first(where: { $0.shortcut == KeyChord.display(k) }) { perform(a.id) }
            }
            return true
        }
        guard k.meta || k.ctrl else { return false }
        switch KeyChord.display(k) {
        case "⌘C": perform("copy")
        case "⌘I": perform("chain")
        case "⇧⌘V": perform("clip")
        case "⌘T": perform("query")
        default: return false
        }
        return true
    }

    func handleCommand(_ c: VimCommand) -> Bool {
        if c.isNavigation {
            let r = rows
            selectedIndex = Vim.applyNav(c, index: selectedIndex, shape: Vim.NavShape(length: r.count, sections: r.map(\.section), halfPage: 5))
            return true
        }
        switch c {
        case let .activate(mods): perform(mods.contains(.command) ? "copy" : "paste")
        case .secondary: perform("copy")
        case .copy: perform("copy")
        case .paste: perform("paste")
        case .actions:
            panelIndex = 0
            panelOpen.toggle()
        default: return false
        }
        return true
    }

    func stateJSON() -> JSONValue {
        let r = rows
        return [
            "source": .string(input?.source.rawValue ?? "loading"), "input": .string(text), "note": input?.note.map(JSONValue.string) ?? .null,
            "selected": selected.map { .string($0.transform) } ?? .null, "panelOpen": .bool(panelOpen),
            "rows": .array(r.prefix(40).map { row in
                var o: [String: JSONValue] = ["id": .string(row.transform), "section": .string(row.section)]
                if let p = preview(row.transform) { o[p.output != nil ? "preview" : "error"] = .string(p.output ?? p.error ?? "") }
                return .object(o)
            }),
        ]
    }
}

/// "⇧⌘C"-style display string of a key press (matches ItemAction shortcuts).
enum KeyChord {
    static func display(_ k: VimKey) -> String {
        var s = ""
        if k.ctrl { s += "⌃" }
        if k.alt { s += "⌥" }
        if k.shift { s += "⇧" }
        if k.meta { s += "⌘" }
        switch k.key {
        case "Enter": s += "↩"
        case "Escape": s += "esc"
        default: s += k.key.uppercased()
        }
        return s
    }
}
