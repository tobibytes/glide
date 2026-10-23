import Foundation
import GlideCore
import GlideUI
import SwiftUI

/// Emoji & Symbols picker (port of src/main/features/emoji + renderer/features/emoji): a grid view searchable by
/// name and keywords, skin tones (`settings.features.emoji.skinTone` 0…5), recently/frequently used
/// (`<data>/features/emoji/usage.json`, keyed by base emoji like Electron) and `:name` rows in root search.
@MainActor public final class EmojiFeature: Feature, FeatureUI {
    public let id = "emoji"
    public let title = "Emoji & Symbols"
    static let view: ViewID = "emoji.picker"
    static let columns = 10
    private weak var context: FeatureContext?
    let picker = EmojiPickerState()
    private(set) var usage: [String: EmojiModel.Usage] = [:]
    private var saveTask: Task<Void, Never>?
    public init() {}

    var usageURL: URL? { context?.dataDirectory().appendingPathComponent("usage.json") }

    public func start(context: FeatureContext) async {
        self.context = context
        if let u = usageURL, let d = try? Data(contentsOf: u), let raw = try? JSONDecoder().decode([String: EmojiModel.Usage].self, from: d) { usage = raw }
        picker.skinTone = skinTone
    }

    public func stop() async { flushUsage() }

    public var skinTone: Int {
        let t = context?.settings(defaults: ["skinTone": 0])["skinTone"]?.intValue ?? 0
        return (0...5).contains(t) ? t : 0
    }

    func setSkinTone(_ t: Int) {
        guard (0...5).contains(t) else { return }
        context?.setSettings(["skinTone": .int(Int64(t))])
        picker.skinTone = t
    }

    func recordUse(_ base: String) {
        usage[base] = EmojiModel.Usage(count: (usage[base]?.count ?? 0) + 1, last: Date().timeIntervalSince1970 * 1000)
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.flushUsage()
        }
    }

    func flushUsage() {
        guard let u = usageURL, let d = try? JSONEncoder().encode(usage) else { return }
        try? d.write(to: u, options: .atomic)
    }

    // MARK: catalogue

    public func items() -> [SearchItem] {
        [SearchItem(id: "emoji:picker", kind: .command, title: "Search Emoji & Symbols", subtitle: "Emoji", icon: .emoji("😀"),
                    keywords: ["emoji", "emoticon", "symbols", "smiley", "picker", "character"], acceptsArgument: true, feature: id, data: ["action": "picker"], kindLabel: "Command")] // fix round: Tab → query
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        let q = query.trimmed
        guard q.hasPrefix(":"), q.count >= 3, !q.contains(" ") else { return [] }
        let tone = skinTone
        return EmojiModel.search(q, limit: 5).enumerated().map { i, e in
            let item = SearchItem(id: "emoji:char:\(e.char)", kind: .command, title: e.name.prefix(1).uppercased() + e.name.dropFirst(), subtitle: ":\(e.name.replacingOccurrences(of: " ", with: "_")):",
                                  icon: .emoji(EmojiModel.withTone(e, tone)), keywords: [q] + e.keywords, feature: id,
                                  data: ["action": "char", "char": .string(e.char), "noUsage": true], kindLabel: "Emoji")
            return ScoredItem(item: item, score: Double(100 - i), matchScore: Double(100 - i), matchKind: .keyword)
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        if item.data?["action"]?.stringValue == "char" {
            return [ItemAction(id: "paste", title: "Paste Emoji", shortcut: "↩", icon: "doc.on.clipboard"), ItemAction(id: "copy", title: "Copy Emoji", shortcut: "⌘↩", icon: "doc.on.doc")]
        }
        return [ItemAction(id: "open", title: "Open Emoji Picker", shortcut: "↩", icon: "face.smiling")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        if action == "open" {
            picker.reset()
            return .pushView(Self.view, payload: ["query": .string(scored.argument ?? "")])
        }
        guard let char = scored.item.data?["char"]?.stringValue else { return .error("No emoji") }
        return action == "copy" ? copy(char) : paste(char)
    }

    func tone(_ base: String) -> String { EmojiModel.find(base).map { EmojiModel.withTone($0, skinTone) } ?? base }

    func paste(_ base: String) -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        let text = tone(base)
        recordUse(base)
        ctx.hideLauncher()
        ctx.services.paste.paste(text: text, html: nil)
        return .hide(message: "Pasted \(text)")
    }

    func copy(_ base: String) -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        let text = tone(base)
        ctx.services.pasteboard.setString(text, html: nil, transient: false)
        recordUse(base)
        return .hide(message: "Copied \(text)")
    }

    // MARK: picker

    func sections(for query: String) -> [EmojiModel.Section] {
        let q = query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { return [EmojiModel.Section(id: "results", title: "Results", items: EmojiModel.search(q, limit: 400))] }
        var out: [EmojiModel.Section] = []
        let u = EmojiModel.usageSections(usage)
        let recent = u.recent.compactMap(EmojiModel.find)
        let frequent = u.frequent.compactMap(EmojiModel.find)
        if !recent.isEmpty { out.append(.init(id: "recent", title: "Recently Used", items: recent)) }
        if !frequent.isEmpty { out.append(.init(id: "frequent", title: "Frequently Used", items: frequent)) }
        var byCat: [Int: [EmojiModel.Emoji]] = [:]
        for e in EmojiModel.all { byCat[e.category, default: []].append(e) }
        for (i, c) in EmojiModel.categories.enumerated() { if let items = byCat[i] { out.append(.init(id: c.id, title: c.title, items: items)) } }
        return out
    }

    func rows(for query: String) -> [EmojiModel.Row] { EmojiModel.layout(sections(for: query), columns: Self.columns) }

    func selectedEmoji(query: String) -> EmojiModel.Emoji? {
        let r = rows(for: query)
        let p = EmojiModel.clamp(r, picker.pos)
        return r.isEmpty ? nil : r[p.row].items[p.col]
    }

    public func launcherView(_ vid: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard vid == Self.view else { return nil }
        picker.host = host
        host.setPlaceholder("Search emoji and symbols…")
        host.setFooter(primary: "Paste Emoji", hasActions: false)
        let q = host.query
        picker.sync(query: q)
        return AnyView(EmojiPickerView(state: picker, rows: rows(for: q), columns: Self.columns))
    }

    public func handleKey(_ k: VimKey, view: ViewID) -> Bool {
        guard view == Self.view else { return false }
        let q = picker.host?.query ?? ""
        picker.sync(query: q)
        let r = rows(for: q)
        func go(_ m: EmojiModel.Move) -> Bool { picker.pos = EmojiModel.move(r, picker.pos, m); return true }
        let plain = !k.meta && !k.ctrl && !k.alt
        switch (k.key, k.ctrl, k.meta) {
        case ("ArrowLeft", false, false), ("h", true, false): return go(.left)
        case ("ArrowRight", false, false), ("l", true, false): return go(.right)
        case ("ArrowUp", false, false), ("k", true, false), ("p", true, false): return go(.up)
        case ("ArrowDown", false, false), ("j", true, false), ("n", true, false): return go(.down)
        case ("u", true, false): return go(.pageUp)
        case ("d", true, false): return go(.pageDown)
        case ("Tab", false, false) where plain: return go(k.shift ? .prevSection : .nextSection)
        case ("Enter", _, _):
            guard let e = selectedEmoji(query: q) else { return true }
            let result = k.meta ? copy(e.char) : paste(e.char)
            if case let .hide(message) = result {
                if let message { picker.host?.toast(message, style: .success) }
                picker.host?.close()
            }
            picker.lastAction = k.meta ? "copy:\(e.char)" : "paste:\(e.char)"
            return true
        case ("t", false, true):
            setSkinTone((skinTone + 1) % EmojiModel.skinTones.count)
            picker.host?.toast("Skin tone: \(EmojiModel.skinTones[skinTone].label)", style: .info)
            return true
        default: return false
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "state":
            let u = EmojiModel.usageSections(usage)
            let q = picker.host?.query ?? ""
            return ["recent": .array(u.recent.map(JSONValue.string)), "frequent": .array(u.frequent.map(JSONValue.string)), "skinTone": .int(Int64(skinTone)),
                    "selected": selectedEmoji(query: q).map { .string(EmojiModel.withTone($0, skinTone)) } ?? .null,
                    "row": .int(Int64(picker.pos.row)), "col": .int(Int64(picker.pos.col)), "count": .int(Int64(EmojiModel.all.count))]
        case "search":
            return .array(EmojiModel.search(args.stringValue ?? "", limit: args["limit"]?.intValue ?? 10).map { .string($0.char) })
        case "setSkinTone":
            setSkinTone(args.intValue ?? args["tone"]?.intValue ?? 0)
            return .int(Int64(skinTone))
        case "clearUsage":
            usage = [:]
            flushUsage()
            return true
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Emoji", symbol: "face.smiling", order: 64) { [weak self] in AnyView(EmojiSettingsView(feature: self)) }
    }
}

@MainActor @Observable final class EmojiPickerState {
    var pos = EmojiModel.Pos()
    var skinTone = 0
    var lastQuery = ""
    var lastAction: String?
    @ObservationIgnored weak var boundHost: LauncherViewHost?
    var host: LauncherViewHost? {
        get { boundHost ?? LauncherHosts.current }
        set { boundHost = newValue }
    }
    func reset() { pos = EmojiModel.Pos(); lastQuery = "" }
    func sync(query: String) {
        if query != lastQuery {
            lastQuery = query
            pos = EmojiModel.Pos()
        }
    }
}

struct EmojiPickerView: View {
    @Environment(\.glideTheme) private var theme
    let state: EmojiPickerState
    let rows: [EmojiModel.Row]
    let columns: Int

    var body: some View {
        if rows.isEmpty {
            EmptyState(symbol: "face.dashed", title: "No emoji found", subtitle: "Try another name or keyword")
        } else {
            let p = EmojiModel.clamp(rows, state.pos)
            let selected = rows[p.row].items[p.col]
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { ri, row in
                                if row.first { SectionHeader(row.title).padding(.top, ri == 0 ? 0 : 6) }
                                HStack(spacing: 4) {
                                    ForEach(Array(row.items.enumerated()), id: \.offset) { ci, e in
                                        let on = ri == p.row && ci == p.col
                                        Text(EmojiModel.withTone(e, state.skinTone))
                                            .font(.system(size: 30))
                                            .frame(width: 58, height: 52)
                                            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(on ? theme.selected : .clear))
                                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(on ? theme.selectedRing : .clear, lineWidth: 1.5))
                                            .onTapGesture { state.pos = EmojiModel.Pos(row: ri, col: ci) }
                                    }
                                }
                                .id(ri)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                    .scrollIndicators(.never)
                    .onChange(of: p.row) { _, r in proxy.scrollTo(r) }
                }
                Rectangle().fill(theme.border).frame(height: 1)
                HStack(spacing: 10) {
                    Text(EmojiModel.withTone(selected, state.skinTone)).font(.system(size: 22))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(selected.name.prefix(1).uppercased() + selected.name.dropFirst()).font(theme.titleFont).foregroundStyle(theme.text)
                        Text(selected.keywords.prefix(6).joined(separator: " · ")).font(theme.subtitleFont).foregroundStyle(theme.text3).lineLimit(1)
                    }
                    Spacer()
                    Text("Skin tone \(EmojiModel.skinTones[state.skinTone].swatch)").font(theme.subtitleFont).foregroundStyle(theme.text2)
                    Kbd("⌘T")
                    Text("Copy").font(theme.subtitleFont).foregroundStyle(theme.text2)
                    Kbd("⌘↩")
                }
                .padding(.horizontal, 14)
                .frame(height: 44)
            }
        }
    }
}

struct EmojiSettingsView: View {
    weak var feature: EmojiFeature?
    @State private var tone = 0
    var body: some View {
        Form {
            Picker("Skin tone", selection: Binding(get: { tone }, set: { tone = $0; feature?.setSkinTone($0) })) {
                ForEach(0..<EmojiModel.skinTones.count, id: \.self) { i in Text("\(EmojiModel.skinTones[i].swatch) \(EmojiModel.skinTones[i].label)").tag(i) }
            }
            Button("Clear Recently Used") { Task { _ = try? await feature?.invoke(method: "clearUsage", args: .null) } }
            Text("\(EmojiModel.all.count) emoji bundled (Unicode 15.1). Type “:name” in the root search for quick inserts.").foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .onAppear { tone = feature?.skinTone ?? 0 }
    }
}
