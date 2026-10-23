import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Colors (src/main/features/color): "Pick Color" (NSColorSampler via ColorPickerService), "Color History"
/// (<userData>/features/color/history.json) and a swatch row for colors typed in the root search.
@MainActor public final class ColorFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "color"
    public let title = "Color"
    private weak var context: FeatureContext?
    public private(set) var history: [ColorEntry] = []
    private var picking = false
    var now: N7Now = n7SystemNow
    lazy var historyModel = N7ListModel(placeholder: "Search colors or type #hex / rgb() to save…", emptyTitle: "No colors yet",
                                        emptySubtitle: "Pick a color or type #hex / rgb() / hsl()") { [weak self] q in self?.historyRows(q) ?? [] }
    static let shortcuts: [ColorFormat: String] = [.rgb: "⇧⌘R", .hsl: "⇧⌘H", .swiftui: "⇧⌘S", .css: "⇧⌘C"]

    public init() {}

    private var file: URL? { context?.dataDirectory().appendingPathComponent("history.json") }

    public func start(context: FeatureContext) async {
        self.context = context
        history = ColorEntry.load(file.flatMap(N7JSON.read))
    }

    private func changed() {
        if let file { N7JSON.write(history, to: file) }
        context?.refreshCatalogue()
        historyModel.changed()
    }

    var pickFormat: ColorFormat {
        ColorFormat(rawValue: context?.settings(defaults: ["pickFormat": "hex"])["pickFormat"]?.stringValue ?? "hex") ?? .hex
    }

    // MARK: catalogue

    private func item(_ action: String, _ title: String, _ subtitle: String, _ symbol: String, _ keywords: [String]) -> SearchItem {
        SearchItem(id: "color:\(action)", kind: .command, title: title, subtitle: subtitle, icon: .symbol(symbol, tint: "#FF9F0A"), keywords: keywords,
                   feature: id, data: ["action": .string(action)], kindLabel: "Color")
    }

    public func items() -> [SearchItem] {
        [item("pick", "Pick Color", "Color Picker", "eyedropper", ["color", "colour", "picker", "eyedropper", "sample", "screen", "hex"]),
         item("history", "Color History", "\(history.count) color\(history.count == 1 ? "" : "s")", "swatchpalette", ["color", "colour", "picked", "palette", "hex", "recent"])]
    }

    public static func swatchItem(query: String, color c: ColorRGBA) -> ScoredItem {
        let h = ColorMath.hsl(c)
        let item = SearchItem(id: "color:swatch:\(query.trimmingCharacters(in: .whitespaces).lowercased())", kind: .calculator, title: ColorMath.format(c, .hex),
                              subtitle: "\(ColorMath.format(c, .rgb)) · hsl(\(h.h), \(h.s)%, \(h.l)%) · ⌘K for more formats",
                              icon: ItemIcon(kind: "color", value: ColorMath.hexOf(c)), feature: "color",
                              data: ["rgba": N7JSON.value(c), "noUsage": true], kindLabel: "Color")
        return ScoredItem(item: item, score: 999, matchScore: 999, matchKind: .exact)
    }

    public func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] {
        let q = query.trimmed
        guard q.count >= 4, ["#", "rgb", "hsl"].contains(where: { q.lowercased().hasPrefix($0) }), let c = ColorMath.parse(q) else { return [] }
        return [Self.swatchItem(query: q, color: c)]
    }

    static func rgba(of item: SearchItem) -> ColorRGBA? { item.data?["rgba"].flatMap { N7JSON.decode($0, as: ColorRGBA.self) } }

    public func actions(for item: SearchItem) -> [ItemAction] {
        switch item.data?["action"]?.stringValue {
        case "pick": return [ItemAction(id: "pick", title: "Pick Color", shortcut: "↩", icon: "eyedropper"), ItemAction(id: "history", title: "Show Color History", shortcut: "⌘↩", icon: "swatchpalette")]
        case "history": return [ItemAction(id: "history", title: "Show Color History", shortcut: "↩", icon: "swatchpalette"), ItemAction(id: "pick", title: "Pick Color", shortcut: "⌘↩", icon: "eyedropper")]
        default:
            guard Self.rgba(of: item) != nil else { return [] }
            return [ItemAction(id: "copy:hex", title: "Copy HEX", shortcut: "↩", icon: "doc.on.doc"), ItemAction(id: "paste:hex", title: "Paste HEX", shortcut: "⌘↩", icon: "doc.on.clipboard")]
                + ColorFormat.all.filter { $0 != .hex }.map { ItemAction(id: "copy:\($0.rawValue)", title: "Copy \($0.title)", icon: "doc.on.doc") }
                + [ItemAction(id: "save", title: "Save to Color History", shortcut: "⌘S", icon: "swatchpalette")]
        }
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        switch action {
        case "pick": return await pick()
        case "history": return .pushView(ViewID(feature: id, name: "history"))
        default: break
        }
        guard let c = Self.rgba(of: scored.item) else { return .error("Not a color") }
        if action == "save" {
            add(c, source: "search")
            return .stay(message: "Saved to Color History")
        }
        let parts = action.split(separator: ":").map(String.init)
        guard parts.count == 2, let f = ColorFormat(rawValue: parts[1]) else { return .error("Unknown action \(action)") }
        let text = ColorMath.format(c, f)
        return parts[0] == "paste" ? paste(text) : copy(text)
    }

    func copy(_ text: String) -> ActionResult {
        context?.services.pasteboard.setString(text, html: nil, transient: false)
        return .hide(message: "Copied \(text)")
    }

    func paste(_ text: String) -> ActionResult {
        context?.hideLauncher()
        context?.services.paste.paste(text: text, html: nil)
        return .hide(message: "Pasted \(text)")
    }

    func add(_ c: ColorRGBA, source: String) {
        history = ColorEntry.add(history, c, source: source, now: now())
        changed()
    }

    /// The loupe runs after the launcher hides; the picked color is copied and the history opens.
    func pick(fromView: Bool = false) async -> ActionResult {
        guard let ctx = context else { return .error("Not ready") }
        if picking { return .error("The color picker is already open") }
        picking = true
        defer { picking = false }
        ctx.hideLauncher()
        try? await Task.sleep(for: .milliseconds(250))
        let res = await ctx.services.colorPicker.pick(timeout: 120)
        guard let hex = res.hex, let c = ColorMath.parse(hex) else { return .hide(message: res.reason == "timeout" ? "Color picker timed out" : "Cancelled") }
        add(c, source: "picker")
        let text = ColorMath.format(c, pickFormat)
        ctx.services.pasteboard.setString(text, html: nil, transient: false)
        if fromView { ctx.showLauncher() } else { ctx.push(ViewID(feature: id, name: "history"), payload: .null) }
        historyModel.select(id: c.hexKey)
        ctx.toast("Copied \(text)", style: .success)
        return .stay(message: "Copied \(text)")
    }

    // MARK: history view

    func historyRows(_ query: String) -> [N7Row] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let typed = ColorMath.parse(query)
        var out: [N7Row] = []
        if let typed {
            out.append(colorRow(id: "typed", section: "Typed Color", c: typed, subtitle: ColorMath.format(typed, .rgb), entry: nil))
        } else if q.isEmpty {
            out.append(N7Row(id: "pick", section: "Picker", icon: .symbol("eyedropper", tint: "#FF9F0A"), title: "Pick Color", subtitle: "macOS color sampler",
                             actions: [N7Action("pick", "Pick Color", shortcut: "↩", icon: "eyedropper") { [weak self] in _ = await self?.pick(fromView: true) }],
                             detail: { AnyView(Text("Press ⏎ to open the macOS color sampler. Click anywhere on screen to pick; Esc cancels. The color is copied as \(self.pickFormat.title) and saved here.").font(.callout).foregroundStyle(.secondary)) }))
        }
        for e in history {
            if !q.isEmpty, typed == nil, !ColorFormat.all.contains(where: { ColorMath.format(e.rgba, $0).lowercased().contains(q) }) { continue }
            out.append(colorRow(id: e.hex, section: "History", c: e.rgba, subtitle: ColorMath.format(e.rgba, .rgb), entry: e))
        }
        return out
    }

    private func colorRow(id rowId: String, section: String, c: ColorRGBA, subtitle: String, entry: ColorEntry?) -> N7Row {
        var actions: [N7Action] = [
            N7Action("copy:hex", "Copy HEX", shortcut: "↩", icon: "doc.on.doc") { [weak self] in self?.copyFromView(c, .hex) },
            N7Action("paste:hex", "Paste HEX", shortcut: "⌘↩", icon: "doc.on.clipboard") { [weak self] in _ = self?.paste(ColorMath.format(c, .hex)) },
        ]
        for f in ColorFormat.all where f != .hex {
            actions.append(N7Action("copy:\(f.rawValue)", "Copy \(f.title)", shortcut: Self.shortcuts[f], icon: "doc.on.doc") { [weak self] in self?.copyFromView(c, f) })
        }
        if let entry {
            actions.append(N7Action("pick", "Pick New Color", shortcut: "⌘N", icon: "eyedropper") { [weak self] in _ = await self?.pick(fromView: true) })
            actions.append(N7Action("delete", "Delete Color", shortcut: "⌃X", icon: "trash", destructive: true) { [weak self] in self?.remove(entry.hex) })
            actions.append(N7Action("clear", "Clear History", shortcut: "⌃⇧X", icon: "trash.slash", destructive: true) { [weak self] in
                self?.history = []
                self?.changed()
                self?.context?.toast("Color history cleared", style: .info)
            })
        } else {
            actions.append(N7Action("save", "Save to History", shortcut: "⌘S", icon: "swatchpalette") { [weak self] in
                self?.add(c, source: "search")
                self?.context?.toast("Saved", style: .success)
            })
        }
        let trailing = entry.map { N7Format.relative($0.at, now: now()) }
        return N7Row(id: rowId, section: section, icon: ItemIcon(kind: "color", value: ColorMath.hexOf(c)), title: ColorMath.format(c, .hex), subtitle: subtitle,
                     trailing: trailing, actions: actions, detail: { AnyView(ColorDetail(color: c)) })
    }

    private func copyFromView(_ c: ColorRGBA, _ f: ColorFormat) {
        let text = ColorMath.format(c, f)
        context?.services.pasteboard.setString(text, html: nil, transient: false)
        LauncherHosts.current?.toast("Copied \(text)", style: .success)
    }

    func remove(_ hex: String) {
        history.removeAll { $0.hex == hex }
        changed()
    }

    // MARK: FeatureUI

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard id.name == "history" else { return nil }
        n7AfterUpdate { [weak self] in self?.historyModel.syncHost() }
        return AnyView(N7ListView(model: historyModel))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { view.name == "history" && historyModel.handleKey(key) }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { view.name == "history" && historyModel.handle(command) }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Color", symbol: "eyedropper", order: 120) { [weak self] in
            AnyView(ColorSettingsView(format: self?.pickFormat ?? .hex) { f in self?.context?.setSettings(["pickFormat": .string(f.rawValue)]) })
        }
    }

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "history": return N7JSON.value(history)
        case "add":
            if let c = args["text"]?.stringValue.flatMap(ColorMath.parse) ?? args.stringValue.flatMap(ColorMath.parse) { add(c, source: "search") }
            return N7JSON.value(history)
        case "remove":
            remove(args["hex"]?.stringValue ?? args.stringValue ?? "")
            return N7JSON.value(history)
        case "clear":
            history = []
            changed()
            return .array([])
        case "pick":
            let r = await pick()
            if case let .stay(m) = r { return ["ok": true, "message": m.map(JSONValue.string) ?? .null] }
            return ["ok": false]
        case "format":
            guard let c = (args["color"]?.stringValue).flatMap(ColorMath.parse), let f = ColorFormat(rawValue: args["format"]?.stringValue ?? "hex") else { return .null }
            return .string(ColorMath.format(c, f))
        case "viewState": return historyModel.snapshot()
        case "viewAction": return .bool(await historyModel.run(actionId: args["id"]?.stringValue ?? ""))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

extension ColorRGBA {
    var hexKey: String { ColorMath.format(self, .hex) }
}

struct ColorDetail: View {
    @Environment(\.glideTheme) private var theme
    let color: ColorRGBA
    var body: some View {
        let dark = ColorMath.luminance(color) < 0.4
        VStack(alignment: .leading, spacing: 10) {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(.sRGB, red: color.r / 255, green: color.g / 255, blue: color.b / 255, opacity: color.a))
                .frame(height: 96)
                .overlay(Text(ColorMath.format(color, .hex)).font(.system(size: 18, weight: .semibold, design: .monospaced)).foregroundStyle(dark ? .white : .black))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.border))
            ForEach(ColorFormat.all, id: \.self) { f in
                HStack(alignment: .firstTextBaseline) {
                    Text(f.title).font(.system(size: 11, weight: .medium)).foregroundStyle(theme.text3).frame(width: 92, alignment: .leading)
                    Text(ColorMath.format(color, f)).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(theme.text).textSelection(.enabled).lineLimit(2)
                }
            }
        }
    }
}

struct ColorSettingsView: View {
    @State var format: ColorFormat
    let onChange: (ColorFormat) -> Void
    var body: some View {
        Form {
            Section("Pick Color") {
                Picker("Copy picked color as", selection: $format) {
                    ForEach(ColorFormat.all, id: \.self) { Text($0.title).tag($0) }
                }
                .onChange(of: format) { _, f in onChange(f) }
                N7SettingsNote(text: "Type #hex, rgb() or hsl() in the launcher to see a swatch with every format.")
            }
        }
        .formStyle(.grouped)
    }
}
