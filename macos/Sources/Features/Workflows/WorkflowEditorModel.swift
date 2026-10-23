import AppKit
import GlideCore
import Observation
import SwiftUI

/// State of the Settings → Workflows editor. Edits apply to a draft that autosaves (debounced) to data.json,
/// so nothing is lost when the window closes; ⌘S saves at once.
@MainActor @Observable final class WorkflowsEditorModel {
    @ObservationIgnored weak var feature: WorkflowEngineFeature?
    var selectedId: String?
    var draft: Workflow?
    var selection: WorkflowPath?
    var sidebarFilter = ""
    var dirty = false

    // library
    var libraryOpen = false
    var libraryQuery = ""
    var libraryIndex = 0
    /// Where the next library pick goes (container + index); nil = after the selection.
    var insertTarget: (container: WorkflowPath, index: Int)?

    // run panel
    var runInput = ""
    var isRunning = false
    var liveLog: [WorkflowRunLogEntry] = []
    var lastRun: WorkflowRunResult?
    var runPanelOpen = true

    // drag
    var dragging: WorkflowPath?

    var apps: [String] = []
    private(set) var specsGeneration = 0
    @ObservationIgnored private var saveTask: Task<Void, Never>?

    init(feature: WorkflowEngineFeature) { self.feature = feature }

    var workflows: [Workflow] { feature?.workflows ?? [] }
    var filteredWorkflows: [Workflow] {
        let f = sidebarFilter.trimmingCharacters(in: .whitespaces)
        return f.isEmpty ? workflows : workflows.filter { $0.name.localizedCaseInsensitiveContains(f) || ($0.description ?? "").localizedCaseInsensitiveContains(f) }
    }
    var specs: [WorkflowActionSpec] {
        _ = specsGeneration
        return feature?.registry.allSpecs ?? WorkflowSpecs.builtins
    }

    // MARK: workflows

    func reload(select: String?) {
        if let select, select != "new" { open(select) }
        else if select == "new" { newWorkflow() }
        else if selectedId == nil || draft == nil { open(workflows.first?.id) }
        specsGeneration = feature?.registry.generation ?? 0
        if apps.isEmpty { loadApps() }
    }

    func open(_ id: String?) {
        flush()
        selectedId = id
        draft = id.flatMap { i in workflows.first { $0.id == i } }.map(WorkflowMigration.migrate)
        selection = draft?.actions.isEmpty == false ? [.index(0)] : nil
        dirty = false
        libraryOpen = false
        liveLog = []
        lastRun = id.flatMap { feature?.history.last($0) }
        runInput = ""
    }

    func newWorkflow() {
        flush()
        let wf = Workflow(id: WorkflowIDs.newWorkflowId(), name: "New Workflow", icon: .emoji("⚡️"), actions: [])
        let saved = feature?.context?.store.saveWorkflow(wf) ?? wf
        open(saved.id)
        openLibrary()
    }

    func deleteWorkflow(_ id: String) {
        let list = filteredWorkflows
        let idx = list.firstIndex { $0.id == id } ?? 0
        feature?.context?.store.deleteWorkflow(id)
        if selectedId == id {
            draft = nil
            dirty = false
            let rest = list.filter { $0.id != id }
            open(rest.isEmpty ? nil : rest[min(idx, rest.count - 1)].id)
        }
    }

    func duplicateWorkflow() {
        guard let d = draft else { return }
        flush()
        if let copy = feature?.duplicate(d) { open(copy.id) }
    }

    func edit(_ fn: (inout Workflow) -> Void) {
        guard var d = draft else { return }
        fn(&d)
        draft = d
        dirty = true
        scheduleSave()
    }

    func editActions(_ fn: ([WorkflowAction]) -> [WorkflowAction]) { edit { $0.actions = fn($0.actions) } }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    func flush() {
        saveTask?.cancel()
        guard dirty, let d = draft, let store = feature?.context?.store else { return }
        var w = d
        if w.name.trimmingCharacters(in: .whitespaces).isEmpty { w.name = "Untitled Workflow" }
        let saved = store.saveWorkflow(w)
        draft?.updatedAt = saved.updatedAt
        draft?.createdAt = saved.createdAt
        dirty = false
    }

    // MARK: actions

    var actions: [WorkflowAction] { draft?.actions ?? [] }
    var flatPaths: [WorkflowPath] { WorkflowTree.flatten(actions) }
    func action(at p: WorkflowPath) -> WorkflowAction? { WorkflowTree.action(actions, p) }
    func spec(for a: WorkflowAction) -> WorkflowActionSpec? { WorkflowSpecs.spec(for: a, in: specs) }

    func select(_ p: WorkflowPath?) { selection = p }

    func moveSelection(_ delta: Int) {
        let paths = flatPaths
        guard !paths.isEmpty else { selection = nil; return }
        guard let s = selection, let i = paths.firstIndex(of: s) else { selection = delta > 0 ? paths.first : paths.last; return }
        selection = paths[max(0, min(paths.count - 1, i + delta))]
    }

    func setParam(_ p: WorkflowPath, _ key: String, _ value: String) {
        editActions { WorkflowTree.update($0, p) { $0.params[key] = .string(value) } }
    }
    func setLabel(_ p: WorkflowPath, _ label: String) {
        editActions { WorkflowTree.update($0, p) { $0.label = label.isEmpty ? nil : label } }
    }

    func deleteSelected() {
        guard let s = selection else { return }
        let paths = flatPaths
        let i = paths.firstIndex(of: s) ?? 0
        editActions { WorkflowTree.remove($0, s) }
        let after = flatPaths
        selection = after.isEmpty ? nil : after[max(0, min(after.count - 1, i - (i >= after.count ? 1 : 0)))]
    }

    func duplicateSelected() {
        guard let s = selection, let a = action(at: s), case let .index(i)? = s.last else { return }
        let c = Array(s.dropLast())
        editActions { WorkflowTree.insert($0, c, i + 1, WorkflowTree.clone(a)) }
        selection = c + [.index(i + 1)]
    }

    func toggleSelected() {
        guard let s = selection else { return }
        editActions { WorkflowTree.update($0, s) { $0.disabled = $0.disabled == true ? nil : true } }
    }

    func nudgeSelected(_ delta: Int) {
        guard let s = selection else { return }
        var newPath = s
        editActions { root in
            let r = WorkflowTree.nudge(root, s, by: delta)
            newPath = r.path
            return r.root
        }
        selection = newPath
    }

    /// Drop `from` into `container` at `index` (drag-reorder, including into/out of If branches).
    func drop(from: WorkflowPath, container: WorkflowPath, index: Int) {
        var newPath = from
        editActions { root in
            let r = WorkflowTree.move(root, from: from, to: container, index: index)
            newPath = r.path
            return r.root
        }
        selection = newPath
        dragging = nil
    }

    // MARK: library

    var librarySpecs: [WorkflowActionSpec] {
        let q = libraryQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let all = specs
        guard !q.isEmpty else { return all }
        let words = q.split(separator: " ").map(String.init)
        return all.filter { s in
            let hay = "\(s.title) \(s.description) \(s.category.title) \(s.feature ?? "") \(s.type)".lowercased()
            return words.allSatisfy { hay.contains($0) }
        }.sorted { a, b in
            let ap = a.title.lowercased().hasPrefix(q), bp = b.title.lowercased().hasPrefix(q)
            return ap && !bp
        }
    }

    func openLibrary(container: WorkflowPath? = nil, index: Int? = nil) {
        if let container { insertTarget = (container, index ?? WorkflowTree.container(actions, container).count) } else { insertTarget = nil }
        libraryQuery = ""
        libraryIndex = 0
        libraryOpen = true
        specsGeneration = feature?.registry.generation ?? specsGeneration
    }

    func closeLibrary() {
        libraryOpen = false
        insertTarget = nil
    }

    /// Insert after the selection (inside an If's Then when the If is selected and empty), or at the target.
    func add(_ spec: WorkflowActionSpec) {
        let a = spec.makeAction()
        let target: (WorkflowPath, Int)
        if let t = insertTarget {
            target = (t.container, t.index)
        } else if let s = selection, case let .index(i)? = s.last {
            target = (Array(s.dropLast()), i + 1)
        } else {
            target = ([], actions.count)
        }
        editActions { WorkflowTree.insert($0, target.0, target.1, a) }
        let list = WorkflowTree.container(actions, target.0)
        selection = target.0 + [.index(min(target.1, max(0, list.count - 1)))]
        closeLibrary()
    }

    func addLibrarySelection() {
        let list = librarySpecs
        guard libraryIndex >= 0, libraryIndex < list.count else { return }
        add(list[libraryIndex])
    }

    // MARK: running

    func run() {
        guard let feature, let d = draft, !isRunning else { return }
        flush()
        isRunning = true
        liveLog = []
        runPanelOpen = true
        let input = runInput
        Task { @MainActor [weak self] in
            let r = await feature.run(d, input: input, source: "editor") { e in self?.liveLog.append(e) }
            self?.lastRun = r
            self?.liveLog = r.log
            self?.isRunning = false
        }
    }

    func stop() {
        guard let id = draft?.id else { return }
        feature?.cancel(id)
    }

    /// Status of an action in the latest run (card badges).
    func runStatus(_ actionId: String) -> WorkflowRunLogEntry? {
        (isRunning ? liveLog : (lastRun?.log ?? [])).last { $0.actionId == actionId }
    }

    // MARK: helpers

    func variables(for p: WorkflowPath) -> [WorkflowVariables.Variable] { WorkflowVariables.available(before: p, in: actions, specs: specs) }

    func loadApps() {
        let dirs = feature?.context?.store.settings.appDirectories ?? Settings.defaults.appDirectories
        Task { @MainActor [weak self] in
            let names = await Task.detached(priority: .utility) { () -> [String] in
                var out: [String] = []
                let fm = FileManager.default
                for d in dirs {
                    let dir = (d as NSString).expandingTildeInPath
                    for n in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where n.hasSuffix(".app") { out.append(String(n.dropLast(4))) }
                }
                return Array(Set(out)).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            }.value
            self?.apps = names
        }
    }

    // MARK: keyboard (editor focus, not inside a text field)

    /// Returns true when handled.
    func handleKey(_ chars: String, _ key: KeyEquivalent, modifiers: EventModifiers) -> Bool {
        let cmd = modifiers.contains(.command), opt = modifiers.contains(.option)
        if libraryOpen {
            switch key {
            case .downArrow: libraryIndex = min(librarySpecs.count - 1, libraryIndex + 1); return true
            case .upArrow: libraryIndex = max(0, libraryIndex - 1); return true
            case .return: addLibrarySelection(); return true
            case .escape: closeLibrary(); return true
            default: return false
            }
        }
        switch key {
        case .downArrow where cmd && opt: nudgeSelected(1); return true
        case .upArrow where cmd && opt: nudgeSelected(-1); return true
        case .downArrow: moveSelection(1); return true
        case .upArrow: moveSelection(-1); return true
        case .delete, .deleteForward: deleteSelected(); return true
        case .escape: selection = nil; return true
        default: break
        }
        switch (chars.lowercased(), cmd) {
        case ("j", false): moveSelection(1); return true
        case ("k", false): moveSelection(-1); return true
        case ("d", true): duplicateSelected(); return true
        case ("n", true), ("a", false), ("+", false): openLibrary(); return true
        case ("r", true): run(); return true
        case (".", true): stop(); return true
        case ("s", true): flush(); return true
        case (" ", false), ("e", true): toggleSelected(); return true
        default: return false
        }
    }
}
