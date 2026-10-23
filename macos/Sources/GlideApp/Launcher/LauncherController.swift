import AppKit
import GlideCore
import GlideFeatures
import GlideSystem
import GlideUI
import Observation

/// What the controller needs from the window layer (LauncherWindowController).
@MainActor protocol LauncherWindowing: AnyObject {
    var isVisible: Bool { get }
    func showPanel()
    func hidePanel()
    func openSettings(page: String?)
    func contentHeightChanged()
    /// Window numbers of Glide's other visible windows (notes panel, AI chat, editors), to tell whether an
    /// action opened one.
    func otherVisibleWindows() -> Set<Int>
    /// Another Glide window has keyboard focus (an action just opened it).
    var otherWindowIsKey: Bool { get }
}

/// The launcher's brain: catalogue, search, selection, vim keys, action panel, view stack, results.
/// UI-agnostic enough to be driven entirely by the test channel in headless mode.
@MainActor @Observable final class LauncherController {
    // MARK: observable state
    var query = "" { didSet { if query != oldValue { queryChanged() } } }
    private(set) var rows: [LauncherRow] = []
    private(set) var selectedIndex = 0
    private(set) var mode: VimMode = .insert
    private(set) var stack: [PushedView] = []
    var actionPanel: ActionPanelState?
    private(set) var argument: ArgumentMode?
    private(set) var toast: ToastData?
    private(set) var theme: GlideTheme
    /// Bumped to (re)focus the search field.
    private(set) var focusToken = 0

    // MARK: dependencies
    @ObservationIgnored let store: Store
    @ObservationIgnored let registry: FeatureRegistry
    @ObservationIgnored let services: SystemServices
    @ObservationIgnored let log: (String) -> Void
    @ObservationIgnored weak var windowing: LauncherWindowing?
    @ObservationIgnored private(set) var engine: SearchEngine
    @ObservationIgnored private var vimState = VimState.initial
    @ObservationIgnored private var searchGeneration = 0
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private(set) var lastActivity = Date()
    @ObservationIgnored private var pendingDeleteAt: Date?
    @ObservationIgnored private var observation: StoreObservation?
    @ObservationIgnored private var catalogueScheduled = false
    @ObservationIgnored var featureHotkeys: [String: @MainActor () -> Void] = [:]
    @ObservationIgnored let headless: Bool
    @ObservationIgnored var systemDark: () -> Bool = { NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
    /// Raycast-like pop-to-root: a launcher shown after 90 s idle starts fresh.
    static let popToRootSeconds: TimeInterval = 90

    init(store: Store, registry: FeatureRegistry, services: SystemServices, headless: Bool, log: @escaping (String) -> Void) {
        self.store = store
        self.registry = registry
        self.services = services
        self.headless = headless
        self.log = log
        engine = SearchEngine()
        theme = GlideTheme(tokens: Themes.tokens(mode: store.settings.theme, systemDark: true, bag: store.settings.features[AppearanceSettings.featureId] ?? [:]), opaqueBackground: headless)
        engine.setUsage(store.usage)
        observation = store.observe { [weak self] _ in
            Task { @MainActor in self?.dataChanged() }
        }
        services.hotkeys.onPress = { [weak self] id in self?.hotkeyPressed(id) }
    }

    // MARK: derived

    var settings: Settings { store.settings }
    var top: PushedView? { stack.last }
    var vimEnabled: Bool { settings.vimMode }
    var itemRows: [(row: LauncherRow, scored: ScoredItem)] {
        rows.compactMap { r in if case let .item(s, _) = r.kind { return (r, s) }; return nil }
    }
    var selected: ScoredItem? {
        let items = itemRows
        guard selectedIndex >= 0, selectedIndex < items.count else { return nil }
        return items[selectedIndex].scored
    }
    /// The item actions apply to (argument mode carries the argument).
    var active: ScoredItem? {
        if let a = argument {
            var s = a.item
            s.argument = query.isEmpty ? nil : query
            if let m = a.multi {
                s.arguments = MultiArgument.values(m, text: query)
                s.argument = m.defs.first.flatMap { s.arguments?[$0.name] }
            }
            return s
        }
        return selected
    }
    var placeholder: String {
        if let top { return top.placeholder }
        if let m = argument?.multi { return MultiArgument.placeholder(m) }
        if let a = argument { return a.item.item.kind == .quicklink ? "Query…" : "Input…" }
        return "Search apps, workflows, commands…"
    }
    var primaryTitle: String? {
        if let top { return top.footerPrimary }
        guard let a = active else { return nil }
        return actions(for: a.item).first?.title
    }

    // MARK: catalogue

    func rebuildCatalogue() {
        let data = store.data
        let disabled = Set(data.settings.disabledSources)
        var items: [SearchItem] = []
        for var item in registry.catalogueItems() {
            if let src = item.source, disabled.contains(src) { continue }
            if let alias = data.aliases[item.id], !alias.isEmpty { item.alias = alias }
            let workflowHotkey = item.kind == .workflow ? data.workflows.first { $0.id == item.workflowId }?.hotkey : nil
            if let accel = data.hotkeys[item.id] ?? workflowHotkey { item.hotkey = Accelerator.display(accel) }
            if data.favorites.contains(item.id) { item.favorite = true }
            items.append(item)
        }
        engine.configure { o in
            o.favorites = data.favorites
            o.aliases = data.aliases
            o.sectionLimit = data.settings.sectionLimit
            o.frecencyHalfLifeDays = data.settings.frecencyHalfLifeDays
        }
        engine.setItems(items)
        refreshTheme()
        registerHotkeys()
        runSearch(preserveSelection: true)
    }

    /// Coalesces refresh requests from features into one rebuild per run-loop turn.
    func scheduleCatalogueRebuild() {
        guard !catalogueScheduled else { return }
        catalogueScheduled = true
        Task { @MainActor in
            self.catalogueScheduled = false
            self.rebuildCatalogue()
        }
    }

    private func dataChanged() { scheduleCatalogueRebuild() }

    func refreshTheme() {
        let s = store.settings
        let t = GlideTheme(tokens: Themes.tokens(mode: s.theme, systemDark: systemDark(), bag: s.features[AppearanceSettings.featureId] ?? [:], previewId: ThemePreview.presetId), opaqueBackground: headless) // N8: Switch Theme live preview
        if t != theme { theme = t }
    }

    // MARK: hotkeys

    func registerHotkeys() {
        let data = store.data
        var bindings = [HotkeyBinding(id: "launcher", accelerator: data.settings.hotkey)]
        var seen: Set<String> = ["launcher"]
        for (id, accel) in data.hotkeys.sorted(by: { $0.key < $1.key }) where seen.insert(id).inserted { bindings.append(HotkeyBinding(id: id, accelerator: accel)) }
        for wf in data.workflows { if let hk = wf.hotkey, !hk.isEmpty, seen.insert("workflow:\(wf.id)").inserted { bindings.append(HotkeyBinding(id: "workflow:\(wf.id)", accelerator: hk)) } }
        for key in featureHotkeys.keys.sorted() where seen.insert(key).inserted {
            if let accel = featureHotkeyAccelerators[key] { bindings.append(HotkeyBinding(id: key, accelerator: accel)) }
        }
        if bindings == lastBindings { return }
        lastBindings = bindings
        let result = services.hotkeys.set(bindings)
        for f in result.failed { log("hotkey \(f.id) not registered: \(f.reason)") }
        for c in result.conflicts { log("hotkey \(c.id): \(c.reason)") }
    }
    @ObservationIgnored private var lastBindings: [HotkeyBinding] = []
    @ObservationIgnored var featureHotkeyAccelerators: [String: String] = [:]

    func hotkeyPressed(_ id: String) {
        if id == "launcher" { toggle(); return }
        if let h = featureHotkeys[id] { h(); return }
        if let item = engine.item(id) { Task { await execute(ScoredItem(item: item, score: 0)) } }
    }

    // MARK: show / hide

    func toggle() { windowing?.isVisible == true ? hide() : show() }

    func show() {
        let stale = Date().timeIntervalSince(lastActivity) > Self.popToRootSeconds
        actionPanel = nil
        mode = Vim.modeAfter(mode, .show)
        vimState = .initial
        if stale {
            argument = nil
            stack = []
            if query != "" { query = "" } else { runSearch() }
        } else {
            runSearch(preserveSelection: true)
        }
        lastActivity = Date()
        refreshTheme()
        windowing?.showPanel()
        focusToken += 1
    }

    func hide() {
        actionPanel = nil
        windowing?.hidePanel()
    }

    /// Simulates the 90 s idle (test channel).
    func expireIdle() { lastActivity = Date(timeIntervalSinceNow: -(Self.popToRootSeconds + 1)) }

    // MARK: search

    private func queryChanged() {
        lastActivity = Date()
        if argument != nil { return } // editing the argument, not the search
        if var t = stack.popLast() {
            t.query = query
            stack.append(t)
            return
        }
        runSearch()
    }

    /// Static results immediately; feature dynamic rows merged when they arrive (or at their budget).
    func runSearch(preserveSelection: Bool = false) {
        searchGeneration += 1
        let gen = searchGeneration
        let q = query
        let keepId = preserveSelection ? selected?.id : nil
        // Integration: a catalogue rebuild (any feature's refreshCatalogue, e.g. a timer tick) re-runs the same
        // query; keep that query's dynamic rows meanwhile instead of flashing static-only results.
        apply(engine.search(q, dynamicItems: lastDynamic.query == q ? lastDynamic.items : []), keepId: keepId)
        searchTask?.cancel()
        guard !q.trimmingCharacters(in: .whitespaces).isEmpty else { searchTask = nil; return }
        searchTask = Task { @MainActor in
            let dynamic = await registry.dynamicItems(for: q)
            guard gen == searchGeneration else { return }
            lastDynamic = (q, dynamic)
            guard !dynamic.isEmpty else { return }
            // N1: a selection still on the first row follows the new first row (calculator/conversion rows land above fallbacks).
            apply(engine.search(q, dynamicItems: dynamic), keepId: selectedIndex <= 0 ? nil : selected?.id)
        }
    }

    /// Wait for in-flight dynamic results (test channel).
    func settle() async {
        // A rebuild may supersede the awaited search (new task): wait for the current one.
        for _ in 0..<20 {
            guard let t = searchTask else { return }
            await t.value
            if searchTask == t { return }
        }
    }
    @ObservationIgnored private var lastDynamic: (query: String, items: [ScoredItem]) = ("", [])

    private func apply(_ response: SearchResponse, keepId: String?) {
        var out: [LauncherRow] = []
        var index = 0
        for s in response.sections where !s.items.isEmpty {
            out.append(LauncherRow(id: "h:\(s.id.rawValue)", kind: .header(s.title), section: s.id.rawValue))
            for it in s.items {
                out.append(LauncherRow(id: "\(s.id.rawValue):\(it.id)", kind: .item(it, index: index), section: s.id.rawValue))
                index += 1
            }
        }
        rows = out
        let items = itemRows
        if let keepId, let i = items.firstIndex(where: { $0.scored.id == keepId }) { selectedIndex = i } else { selectedIndex = items.isEmpty ? -1 : 0 }
        windowing?.contentHeightChanged()
    }

    // MARK: actions

    static let noGeneric: Set<ItemKind> = [.calculator, .fallback]

    func actions(for item: SearchItem) -> [ItemAction] {
        var list = registry.actions(for: item)
        if !Self.noGeneric.contains(item.kind) {
            let fav = store.data.favorites.contains(item.id)
            list.append(ItemAction(id: "favorite", title: fav ? "Remove from Favorites" : "Add to Favorites", shortcut: "⇧⌘F", icon: fav ? "star.slash" : "star"))
            list.append(ItemAction(id: "alias", title: "Set Alias…", icon: "tag"))
            list.append(ItemAction(id: "hotkey", title: "Set Hotkey…", icon: "keyboard"))
        }
        return list
    }

    /// Runs the primary (or ⌘ secondary) action and returns its result (FeatureContext.executeItem reports it).
    @discardableResult
    func execute(_ scored: ScoredItem, modifiers: ActionModifiers = []) async -> ActionResult {
        let list = actions(for: scored.item)
        let chosen = modifiers.contains(.command) ? list.first { ["⌘↩", "⌘⏎"].contains($0.shortcut ?? "") } ?? list.first : list.first
        guard let chosen else { showToast("No action available", .error); return .error("No action available") }
        return await run(chosen.id, on: scored, modifiers: modifiers)
    }

    @discardableResult
    func run(_ actionId: String, on scored: ScoredItem, modifiers: ActionModifiers = []) async -> ActionResult {
        let item = scored.item
        actionPanel = nil
        lastActivity = Date()
        switch actionId {
        case "favorite":
            let favs = store.toggleFavorite(item.id)
            let r = ActionResult.stay(message: favs.contains(item.id) ? "Added to Favorites" : "Removed from Favorites")
            handle(r, item: scored, actionId: actionId)
            return r
        case "alias": handle(.openSettings(page: "aliases/\(item.id)"), item: scored, actionId: actionId); return .openSettings(page: "aliases/\(item.id)")
        case "hotkey": handle(.openSettings(page: "hotkeys/\(item.id)"), item: scored, actionId: actionId); return .openSettings(page: "hotkeys/\(item.id)")
        default: break
        }
        let primary = registry.actions(for: item).first?.id
        if (actionId == primary || actionId == "reveal") && !Self.noGeneric.contains(item.kind) && item.data?["noUsage"]?.boolValue != true {
            engine.recordUsage(item.id, searchTerm: argument == nil ? query.trimmingCharacters(in: .whitespaces) : argument?.savedQuery)
            store.setUsage(engine.usageRecords)
        }
        let wasVisible = windowing?.isVisible ?? false
        let windowsBefore = windowing?.otherVisibleWindows() ?? []
        let result = await registry.run(action: actionId, on: scored, modifiers: modifiers)
        // An action that opened its own window (Floating Notes, AI Chat, an editor) keeps the focus: re-showing
        // the launcher would take the keyboard away from it.
        let openedWindow = windowing.map { $0.otherWindowIsKey || !$0.otherVisibleWindows().subtracting(windowsBefore).isEmpty } ?? false
        handle(result, item: scored, actionId: actionId, wasVisible: wasVisible, openedWindow: openedWindow)
        return result
    }

    func handle(_ result: ActionResult, item: ScoredItem, actionId: String?, wasVisible: Bool = true, openedWindow: Bool = false) {
        switch result {
        case let .hide(message):
            // An action that hid the launcher itself (paste-back, window / menu commands) handed the keyboard to the
            // user's app: re-showing would take it back, and a delayed ⌘V would paste into Glide's search field.
            let steppedAside = wasVisible && windowing?.isVisible == false
            let stay = settings.keepOpenAfterRun && !switchesApp(item.item, actionId: actionId) && !openedWindow && !steppedAside
            argument = nil
            if stay {
                showToast(message ?? "✓ \(item.item.title)", .success)
                runSearch(preserveSelection: true)
            } else {
                if let message { showToast(message, .success) }
                hide()
            }
        case let .stay(message):
            if let message { showToast(message, .info) }
            runSearch(preserveSelection: true)
        case let .pushView(id, payload): push(id, payload: payload, title: item.item.title)
        case let .openSettings(page):
            windowing?.openSettings(page: page)
            hide()
        case let .error(msg): showToast(msg, .error)
        }
    }

    func showToast(_ message: String, _ style: ToastStyle) {
        toast = ToastData(message: message, style: style)
        toastTask?.cancel()
        toastTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            self.toast = nil
        }
    }

    // MARK: view stack

    /// Push a view. `payload["query"]` (a string) pre-fills the view's search field; `title` is the default footer
    /// context title (the pushing item's title) until the feature names the view itself.
    func push(_ id: ViewID, payload: JSONValue, title: String? = nil) {
        actionPanel = nil
        argument = nil
        if var t = stack.popLast() { t.query = query; stack.append(t) } else { rootQuery = query }
        var view = PushedView(id: id, payload: payload)
        let ui = registry.feature(id.feature) as? any FeatureUI
        view.title = ui?.viewTitle(id, payload: payload) ?? title ?? DefaultViewTitles.title(id) // fix round: sub-pushes get a readable default
        if let p = ui?.viewPlaceholder(id, payload: payload) { view.placeholder = p }
        stack.append(view)
        query = payload["query"]?.stringValue ?? ""
        mode = Vim.modeAfter(mode, .push)
        focusToken += 1
        windowing?.contentHeightChanged()
    }

    @ObservationIgnored private var rootQuery = ""

    func pop() {
        guard !stack.isEmpty else { return }
        stack.removeLast()
        mode = Vim.modeAfter(mode, .pop)
        let restore = stack.last?.query ?? rootQuery
        if query != restore { query = restore }
        if stack.isEmpty { runSearch(preserveSelection: true) }
        focusToken += 1
        windowing?.contentHeightChanged()
    }

    func setTopPlaceholder(_ s: String) { if var t = stack.popLast() { t.placeholder = s; stack.append(t) } }
    func setTopTitle(_ s: String) {
        guard var t = stack.last, t.title != s else { return } // called during render: only mutate on change
        t.title = s
        stack[stack.count - 1] = t
    }

    /// The footer's context title: a readable name for the top view (never the raw view id), the argument hint,
    /// or the selected row.
    var contextTitle: String? {
        if let top {
            if let t = top.title, !t.isEmpty { return t }
            if top.id.rawValue == "glide.shortcuts" { return "Keyboard Shortcuts" }
            if let f = registry.feature(top.id.feature) { return f.title }
            return Self.humanize(top.id.name)
        }
        if argument != nil { return "Tab to edit · ⎋ to cancel" }
        return selected?.item.title
    }

    /// "openWith~3" → "Open With".
    static func humanize(_ name: String) -> String {
        let base = name.split(separator: "~").first.map(String.init) ?? name
        var words: [String] = []
        var cur = ""
        for ch in base {
            if ch == "-" || ch == "_" || ch == "." || ch == " " { if !cur.isEmpty { words.append(cur) }; cur = ""; continue }
            if ch.isUppercase, !cur.isEmpty { words.append(cur); cur = "" }
            cur.append(ch)
        }
        if !cur.isEmpty { words.append(cur) }
        return words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
    func setTopFooter(primary: String?, hasActions: Bool) {
        if var t = stack.popLast() { t.footerPrimary = primary; t.footerHasActions = hasActions; stack.append(t) }
    }

    // MARK: keyboard

    /// Handles one key press. true = consumed (must not reach the search field).
    @discardableResult
    func handleKey(_ k: VimKey) -> Bool {
        lastActivity = Date()
        if actionPanel != nil { return panelKey(k) }
        if let top, let f = registry.feature(top.id.feature) as? any FeatureUI, f.handleKey(k, view: top.id) { return true }
        if top == nil, rootKey(k) { return true }

        let ctx = VimContext(enabled: vimEnabled, mode: mode, queryEmpty: query.isEmpty, viewPushed: top != nil || argument != nil,
                             now: Date().timeIntervalSince1970 * 1000)
        let r = Vim.key(vimState, k, ctx)
        vimState = r.state
        if let c = r.command {
            apply(c)
            return true
        }
        if r.consumed { return true }
        // ⌘E, ⇧⌘F, ⌃X … run the matching action of the selected item directly.
        if (k.meta || k.ctrl) && k.key.count == 1, let a = active {
            let s = KeyMapping.shortcutString(k)
            if let action = actions(for: a.item).first(where: { KeyMapping.normalizeShortcut($0.shortcut ?? "") == s }) {
                Task { await run(action.id, on: a) }
                return true
            }
        }
        return false
    }

    /// Enter argument mode for an acceptsArgument item (multi-argument pills when it defines `data.arguments`).
    func beginArgument(_ s: ScoredItem) {
        argument = ArgumentMode(item: s, savedQuery: query)
        if let (m, text) = MultiArgument.initial(s) {
            argument?.multi = m
            query = text
        } else {
            query = s.argument ?? ""
        }
        mode = .insert
        focusToken += 1
    }

    private func rootKey(_ k: VimKey) -> Bool {
        let plain = !k.meta && !k.ctrl && !k.alt
        if let arg = argument {
            if let m = arg.multi, let r = MultiArgument.key(m, k, text: query) {
                argument?.multi = r.0
                query = r.1
                return true
            }
            if k.key == "Escape" && plain || (k.key == "Backspace" && plain && query.isEmpty) {
                argument = nil
                query = arg.savedQuery
                runSearch(preserveSelection: true)
                return true
            }
            if k.key == "Tab" && plain { return true }
        }
        if k.key == "Enter" && k.meta && !k.shift && !k.alt && !k.ctrl && argument == nil && sendsQueryToAgent() {
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = selected
            Task {
                let r = try? await registry.invoke(feature: "agent", method: "openFromLauncher", args: ["query": .string(q)])
                if r == nil || r == .bool(false), let fallback { await execute(fallback, modifiers: .command) } // shortcut off in Agent settings
            }
            return true
        }
        if k.key == "Tab" && plain && !k.shift && argument == nil {
            guard let s = selected else { return true }
            if s.item.acceptsArgument == true {
                beginArgument(s)
            } else {
                Task { await execute(s) }
            }
            return true
        }
        if k.meta && !k.shift && !k.alt && !k.ctrl, k.key.count == 1, let d = Int(k.key), d >= 1, d <= 9 {
            let items = itemRows
            if d - 1 < items.count {
                selectedIndex = d - 1
                Task { await execute(items[d - 1].scored) }
            }
            return true
        }
        return false
    }

    /// ⌘⏎ in the root search sends the query to Glide Agent (Electron `agent/launcherShortcut.ts`) — unless the
    /// selected row has its own ⌘⏎ action (calculator "Paste", quicklink "Copy URL"…), which keeps priority natively
    /// because there is no hidden ⌘K-only secondary here. Fallback rows and empty results always go to the agent.
    func sendsQueryToAgent() -> Bool {
        guard top == nil, argument == nil, actionPanel == nil, registry.feature("agent") != nil else { return false }
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard let s = selected, s.item.kind != .fallback else { return true }
        return !actions(for: s.item).contains { ["⌘↩", "⌘⏎"].contains($0.shortcut ?? "") }
    }

    private func apply(_ c: VimCommand) {
        // Pushed views that keep their own list (FeatureCommandHandling) get vim commands first.
        if let top, let f = registry.feature(top.id.feature) as? any FeatureCommandHandling, f.handleCommand(c, view: top.id) {
            if !c.isNavigation { mode = Vim.modeAfter(mode, .command(c)) }
            return
        }
        if c.isNavigation {
            let items = itemRows
            let shape = Vim.NavShape(length: items.count, sections: items.map(\.row.section), halfPage: 5)
            selectedIndex = Vim.applyNav(c, index: selectedIndex, shape: shape)
            return
        }
        mode = Vim.modeAfter(mode, .command(c))
        switch c {
        case let .activate(mods):
            if argument == nil, top == nil, let s = selected, MultiArgument.needsEntry(s) { beginArgument(s); return }
            if let a = active { Task { await execute(a, modifiers: mods) } }
        case .secondary:
            if let a = active { Task { await execute(a, modifiers: .command) } }
        case .actions: openActionPanel()
        case .delete, .copy, .paste:
            guard let a = active else { return }
            let kind = c == .delete ? "delete" : c == .copy ? "copy" : "paste"
            guard let action = Vim.findAction(actions(for: a.item), kind: kind) else { showToast("No \(kind) action", .info); return }
            if c == .delete {
                if let at = pendingDeleteAt, Date().timeIntervalSince(at) < 2 {
                    pendingDeleteAt = nil
                } else {
                    pendingDeleteAt = Date()
                    showToast("Press x again to \(action.title.lowercased())", .info)
                    return
                }
            }
            Task { await run(action.id, on: a) }
        case .pop:
            if argument != nil { _ = rootKey(VimKey("Escape")) } else { pop() }
        case .clearQuery: query = ""
        case .hide: hide()
        case .normal: break
        case let .insert(clear):
            if clear { query = "" }
            focusToken += 1
        default: break
        }
    }

    func openActionPanel() {
        guard let a = active else { return }
        actionPanel = ActionPanelState(item: a, actions: actions(for: a.item), vimNav: vimEnabled && mode == .normal)
    }

    private func panelKey(_ k: VimKey) -> Bool {
        guard var p = actionPanel else { return false }
        let list = p.filtered
        func move(_ d: Int) { p.selected = list.isEmpty ? 0 : min(list.count - 1, max(0, p.selected + d)); actionPanel = p }
        func runSelected() {
            guard p.selected < list.count else { return }
            let action = list[p.selected]
            Task { await run(action.id, on: p.item) }
        }
        if p.vimNav && p.filter.isEmpty, let pc = Vim.panelKey(k) {
            switch pc {
            case let .move(d): move(d)
            case .run: runSelected()
            case .close: actionPanel = nil
            case .filter: p.vimNav = false; actionPanel = p
            }
            return true
        }
        let plain = !k.meta && !k.ctrl && !k.alt
        switch k.key {
        case "ArrowDown": move(1); return true
        case "ArrowUp": move(-1); return true
        case "Enter": runSelected(); return true
        case "Escape": actionPanel = nil; return true
        case "Backspace":
            if p.filter.isEmpty { actionPanel = nil } else { p.filter.removeLast(); p.selected = 0; actionPanel = p }
            return true
        default: break
        }
        if k.ctrl && ["j", "n"].contains(k.key.lowercased()) { move(1); return true }
        if k.ctrl && ["k", "p"].contains(k.key.lowercased()) { move(-1); return true }
        if k.meta && k.key.lowercased() == "k" { actionPanel = nil; return true }
        if k.meta || k.ctrl {
            let s = KeyMapping.shortcutString(k)
            if let action = p.actions.first(where: { KeyMapping.normalizeShortcut($0.shortcut ?? "") == s }) {
                let item = p.item
                Task { await run(action.id, on: item) }
            }
            return true
        }
        if plain && k.key.count == 1 {
            p.filter += k.key
            p.selected = 0
            actionPanel = p
        }
        return true
    }

    // MARK: test-channel helpers

    /// Simulate typing (each character goes through the same key path as a real key press first).
    func type(_ text: String) {
        for ch in text {
            let s = String(ch)
            let consumed = handleKey(VimKey(s, shift: ch.isUppercase))
            if !consumed {
                if actionPanel == nil { query += s }
            }
        }
    }
}
