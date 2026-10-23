import AppKit
import GlideCore
import GlideUI
import SwiftUI
import UniformTypeIdentifiers

extension WorkflowCategory {
    var color: Color {
        switch self {
        case .apps: return .blue
        case .web: return .teal
        case .text: return .orange
        case .clipboard: return .purple
        case .scripting: return .green
        case .control: return .yellow
        case .system: return .pink
        }
    }
}

/// Settings → Workflows: workflow list | editor (action stack + run panel) | action library.
struct WorkflowsSettingsView: View {
    @Bindable var model: WorkflowsEditorModel

    var body: some View {
        HStack(spacing: 0) {
            WorkflowSidebar(model: model)
                .frame(width: 210)
            Divider()
            if model.draft != nil {
                WorkflowEditorView(model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "square.stack.3d.up").font(.system(size: 38)).foregroundStyle(.tertiary)
                    Text("No workflow selected").font(.title3.weight(.semibold))
                    Text("Workflows chain actions — open apps, run scripts, transform text, ask questions.").foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("New Workflow") { model.newWorkflow() }.keyboardShortcut("n", modifiers: [.command, .shift])
                }
                .padding(40)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if model.libraryOpen {
                Divider()
                WFActionLibraryView(model: model).frame(width: 270)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(.easeOut(duration: 0.15), value: model.libraryOpen)
        .onDisappear { model.flush() }
    }
}

struct WorkflowSidebar: View {
    @Bindable var model: WorkflowsEditorModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Filter", text: $model.sidebarFilter).textFieldStyle(.plain)
            }
            .padding(7)
            .background(RoundedRectangle(cornerRadius: 7).fill(.quaternary.opacity(0.6)))
            .padding(10)
            List(selection: Binding(get: { model.selectedId }, set: { model.open($0) })) {
                ForEach(model.filteredWorkflows) { wf in
                    HStack(spacing: 8) {
                        ItemIconView(wf.icon, size: 18)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(wf.id == model.draft?.id ? (model.draft?.name ?? wf.name) : wf.name).lineLimit(1)
                            Text(WorkflowEngineFeature.summary(wf).replacingOccurrences(of: "Workflow · ", with: "")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let hk = wf.hotkey, !hk.isEmpty { Text(Accelerator.display(hk)).font(.caption2).foregroundStyle(.secondary) }
                    }
                    .tag(Optional(wf.id))
                    .contextMenu {
                        Button("Duplicate") { model.open(wf.id); model.duplicateWorkflow() }
                        Button("Delete", role: .destructive) { model.deleteWorkflow(wf.id) }
                    }
                }
            }
            .listStyle(.sidebar)
            Divider()
            HStack {
                Button { model.newWorkflow() } label: { Image(systemName: "plus") }
                    .help("New Workflow (⇧⌘N)")
                Button { if let id = model.selectedId { model.deleteWorkflow(id) } } label: { Image(systemName: "minus") }
                    .disabled(model.selectedId == nil)
                    .help("Delete Workflow")
                Spacer()
                Text("\(model.workflows.count)").font(.caption).foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .padding(8)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct WorkflowEditorView: View {
    @Bindable var model: WorkflowsEditorModel
    @FocusState private var stackFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        WorkflowHeaderCard(model: model)
                        HStack {
                            Text("ACTIONS").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Spacer()
                            WFKeyHints(hints: [("↑↓", "select"), ("⌥⌘↑↓", "move"), ("⌘D", "duplicate"), ("⌫", "delete"), ("A", "add")])
                        }
                        WFActionStackView(model: model, actions: model.actions, container: [])
                        Button { model.openLibrary(container: [], index: model.actions.count) } label: {
                            Label("Add Action", systemImage: "plus.circle.fill").frame(maxWidth: .infinity).padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.accentColor.opacity(0.45), style: StrokeStyle(lineWidth: 1.2, dash: [5, 4])))
                    }
                    .padding(18)
                }
                .onChange(of: model.selection) { _, p in if let p { withAnimation { proxy.scrollTo(WorkflowTree.key(p)) } } }
            }
            .focusable()
            .focusEffectDisabled()
            .focused($stackFocused)
            .onKeyPress(phases: .down) { press in
                model.handleKey(press.characters, press.key, modifiers: press.modifiers) ? .handled : .ignored
            }
            .onAppear { stackFocused = true }
            Divider()
            WFRunPanel(model: model)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct WFKeyHints: View {
    let hints: [(String, String)]
    var body: some View {
        HStack(spacing: 10) {
            ForEach(hints, id: \.0) { h in
                HStack(spacing: 3) {
                    Text(h.0).font(.system(size: 10, weight: .medium, design: .rounded))
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: 4).fill(.quaternary))
                    Text(h.1).font(.system(size: 10))
                }
                .foregroundStyle(.secondary)
            }
        }
    }
}

struct WorkflowHeaderCard: View {
    @Bindable var model: WorkflowsEditorModel
    @State private var showDetails = false

    private func binding(_ get: @escaping (Workflow) -> String, _ set: @escaping (inout Workflow, String) -> Void) -> Binding<String> {
        Binding(get: { model.draft.map(get) ?? "" }, set: { v in model.edit { set(&$0, v) } })
    }

    static func emoji(_ icon: ItemIcon) -> String {
        icon.kind == "emoji" && !icon.value.isEmpty ? icon.value : "⚡️"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                TextField("", text: binding({ Self.emoji($0.icon) }, { w, v in w.icon = .emoji(String(v.suffix(1)).isEmpty ? "⚡️" : String(v.suffix(1))) }))
                    .font(.system(size: 26))
                    .multilineTextAlignment(.center)
                    .textFieldStyle(.plain)
                    .frame(width: 52, height: 52)
                    .background(RoundedRectangle(cornerRadius: 13, style: .continuous).fill(LinearGradient(colors: [Color.accentColor.opacity(0.35), Color.accentColor.opacity(0.12)], startPoint: .top, endPoint: .bottom)))
                    .help("Icon (type an emoji)")
                VStack(alignment: .leading, spacing: 4) {
                    TextField("Workflow name", text: binding({ $0.name }, { $0.name = $1 }))
                        .font(.system(size: 20, weight: .semibold))
                        .textFieldStyle(.plain)
                    TextField("Description", text: binding({ $0.description ?? "" }, { $0.description = $1.isEmpty ? nil : $1 }))
                        .textFieldStyle(.plain)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if model.dirty { Text("Saving…").font(.caption).foregroundStyle(.secondary) } else { Label("Saved", systemImage: "checkmark").font(.caption).foregroundStyle(.secondary) }
                Button { showDetails.toggle() } label: { Image(systemName: "slider.horizontal.3") }.buttonStyle(.borderless).help("Launcher options")
            }
            if showDetails {
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
                    GridRow {
                        Text("Alias").foregroundStyle(.secondary)
                        TextField("e.g. qn", text: binding({ $0.alias ?? "" }, { $0.alias = $1.isEmpty ? nil : $1 })).textFieldStyle(.roundedBorder)
                        Text("Hotkey").foregroundStyle(.secondary)
                        TextField("e.g. Alt+Shift+N", text: binding({ $0.hotkey ?? "" }, { $0.hotkey = $1.isEmpty ? nil : $1 })).textFieldStyle(.roundedBorder)
                    }
                    GridRow {
                        Text("Keywords").foregroundStyle(.secondary)
                        TextField("comma separated", text: binding({ ($0.keywords ?? []).joined(separator: ", ") }, { w, v in
                            let k = v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                            w.keywords = k.isEmpty ? nil : k
                        })).textFieldStyle(.roundedBorder)
                        Text("Input").foregroundStyle(.secondary)
                        Toggle("Accepts launcher input (Tab)", isOn: Binding(get: { model.draft?.acceptsInput == true }, set: { v in model.edit { $0.acceptsInput = v ? true : nil } }))
                    }
                }
                .font(.callout)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.background.secondary))
    }
}

/// A list of action cards with drop zones between them (root or an If branch).
struct WFActionStackView: View {
    @Bindable var model: WorkflowsEditorModel
    let actions: [WorkflowAction]
    let container: WorkflowPath

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(actions.enumerated()), id: \.element.id) { i, a in
                WFDropZone(model: model, container: container, index: i)
                WFActionCardView(model: model, action: a, path: container + [.index(i)])
            }
            WFDropZone(model: model, container: container, index: actions.count, isEnd: true)
        }
    }
}

struct WFDropZone: View {
    @Bindable var model: WorkflowsEditorModel
    let container: WorkflowPath
    let index: Int
    var isEnd = false
    @State private var over = false

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(over ? Color.accentColor : Color.clear)
            .frame(height: over ? 4 : (isEnd ? 10 : 6))
            .padding(.vertical, over ? 3 : 0)
            .contentShape(Rectangle())
            .dropDestination(for: String.self) { items, _ in
                guard let key = items.first else { return false }
                model.drop(from: WorkflowTree.parse(key), container: container, index: index)
                return true
            } isTargeted: { over = $0 }
    }
}

struct WFActionCardView: View {
    @Bindable var model: WorkflowsEditorModel
    let action: WorkflowAction
    let path: WorkflowPath

    var body: some View {
        let spec = model.spec(for: action)
        let selected = model.selection == path
        let color = spec?.category.color ?? .gray
        let status = model.runStatus(action.id)
        HStack(spacing: 0) {
            Rectangle().fill(color.gradient).frame(width: 4)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "line.3.horizontal").foregroundStyle(.tertiary).font(.system(size: 11))
                        .help("Drag to reorder")
                    Image(systemName: spec?.symbol ?? "questionmark.square.dashed")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 24, height: 24)
                        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(color.gradient))
                    Text(action.label ?? spec?.title ?? (action.type == "feature" ? "\(action.param("feature") ?? "?").\(action.param("action") ?? "?")" : action.type))
                        .font(.system(size: 13, weight: .semibold))
                    if action.disabled == true { Text("DISABLED").font(.system(size: 9, weight: .bold)).padding(.horizontal, 5).padding(.vertical, 2).background(Capsule().fill(.quaternary)) }
                    if let f = spec?.feature { Text(f).font(.system(size: 10)).foregroundStyle(.secondary).padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().strokeBorder(.quaternary)) }
                    Spacer()
                    if let status { WFRunBadge(entry: status) }
                    if let ov = spec?.outputVar { WFVariableChip(name: ov, style: .output) }
                    Menu {
                        Button("Duplicate  ⌘D") { model.select(path); model.duplicateSelected() }
                        Button(action.disabled == true ? "Enable" : "Disable") { model.select(path); model.toggleSelected() }
                        Button("Move Up  ⌥⌘↑") { model.select(path); model.nudgeSelected(-1) }
                        Button("Move Down  ⌥⌘↓") { model.select(path); model.nudgeSelected(1) }
                        Divider()
                        Button("Delete  ⌫", role: .destructive) { model.select(path); model.deleteSelected() }
                    } label: { Image(systemName: "ellipsis.circle") }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                }
                if let spec {
                    if selected {
                        WFParamGrid(model: model, action: action, spec: spec, path: path)
                    } else if !spec.visibleParams.isEmpty {
                        WFParamSummary(action: action, spec: spec)
                    }
                } else {
                    Text(action.type == "feature" ? "Action “\(action.param("feature") ?? "?").\(action.param("action") ?? "?")” is not available — is that feature installed?" : "Unknown action type “\(action.type)”.")
                        .font(.callout).foregroundStyle(.orange)
                }
                if action.type == "condition" {
                    WFBranchView(model: model, label: "Then", container: path + [.then], actions: action.then ?? [])
                    WFBranchView(model: model, label: "Otherwise", container: path + [.else], actions: action.else ?? [])
                }
            }
            .padding(12)
        }
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.background))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.09), lineWidth: selected ? 2 : 1))
        .shadow(color: .black.opacity(selected ? 0.12 : 0.05), radius: selected ? 6 : 2, y: 1)
        .opacity(action.disabled == true ? 0.55 : 1)
        .contentShape(Rectangle())
        .onTapGesture { model.select(path) }
        .draggable(WorkflowTree.key(path)) {
            Label(spec?.title ?? action.type, systemImage: spec?.symbol ?? "square").padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        }
        .id(WorkflowTree.key(path))
    }
}

struct WFRunBadge: View {
    let entry: WorkflowRunLogEntry
    var body: some View {
        let (sym, color): (String, Color) = entry.status == .ok ? ("checkmark.circle.fill", .green) : entry.status == .error ? ("xmark.octagon.fill", .red) : ("minus.circle", .secondary)
        Image(systemName: sym).foregroundStyle(color).help(entry.error ?? entry.output ?? entry.status.rawValue)
    }
}

struct WFBranchView: View {
    @Bindable var model: WorkflowsEditorModel
    let label: String
    let container: WorkflowPath
    let actions: [WorkflowAction]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label.uppercased()).font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                Spacer()
                Button { model.openLibrary(container: container, index: actions.count) } label: { Label("Add", systemImage: "plus") }
                    .buttonStyle(.borderless).font(.caption)
            }
            if actions.isEmpty {
                Text("No actions — drop one here or press Add").font(.caption).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 30)
                    .background(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    .dropDestination(for: String.self) { items, _ in
                        guard let k = items.first else { return false }
                        model.drop(from: WorkflowTree.parse(k), container: container, index: 0)
                        return true
                    }
            }
            WFActionStackView(model: model, actions: actions, container: container)
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(Color.yellow.opacity(0.5)).frame(width: 2) }
    }
}

enum WFVariableChipStyle { case input, output }

struct WFVariableChip: View {
    let name: String
    var style: WFVariableChipStyle = .input
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: style == .output ? "arrow.down.right" : "curlybraces").font(.system(size: 8, weight: .bold))
            Text(name).font(.system(size: 10.5, weight: .semibold, design: .rounded))
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .foregroundStyle(style == .output ? Color.green : Color.accentColor)
        .background(Capsule().fill((style == .output ? Color.green : Color.accentColor).opacity(0.14)))
    }
}

/// Collapsed card: params as text with `{{var}}` rendered as chips.
struct WFParamSummary: View {
    let action: WorkflowAction
    let spec: WorkflowActionSpec
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(spec.visibleParams.filter { !(action.param($0.key) ?? "").isEmpty && $0.key != "continueOnError" }, id: \.key) { p in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(p.label).font(.caption).foregroundStyle(.secondary).frame(width: 82, alignment: .trailing)
                    WFTokenText(text: displayValue(p))
                }
            }
        }
    }
    private func displayValue(_ p: WorkflowParamSpec) -> String {
        let v = action.param(p.key) ?? ""
        let first = v.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? v
        return v.contains("\n") ? first + " …" : first
    }
}

/// Text with `{{name}}` tokens drawn as chips.
struct WFTokenText: View {
    let text: String
    var body: some View {
        let parts = Self.split(text)
        HStack(spacing: 2) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                if part.isVar { WFVariableChip(name: part.text) } else { Text(part.text).font(.system(size: 12)).lineLimit(1) }
            }
        }
        .lineLimit(1)
    }
    static func split(_ s: String) -> [(text: String, isVar: Bool)] {
        var out: [(String, Bool)] = []
        var rest = Substring(s)
        while let o = rest.range(of: "{{"), let c = rest[o.upperBound...].range(of: "}}") {
            let name = rest[o.upperBound..<c.lowerBound].trimmingCharacters(in: .whitespaces)
            if !rest[rest.startIndex..<o.lowerBound].isEmpty { out.append((String(rest[rest.startIndex..<o.lowerBound]), false)) }
            if WorkflowTemplate.isValidName(name) { out.append((name, true)) } else { out.append((String(rest[o.lowerBound..<c.upperBound]), false)) }
            rest = rest[c.upperBound...]
        }
        if !rest.isEmpty { out.append((String(rest), false)) }
        return out
    }
}

struct WFParamGrid: View {
    @Bindable var model: WorkflowsEditorModel
    let action: WorkflowAction
    let spec: WorkflowActionSpec
    let path: WorkflowPath

    var body: some View {
        let vars = model.variables(for: path)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(spec.visibleParams, id: \.key) { p in
                WFParamEditor(model: model, param: p, value: action.param(p.key) ?? "", variables: vars,
                            mono: WorkflowSpecs.monoParams.contains("\(action.type):\(p.key)"), isWorkflowPicker: action.type == "runWorkflow" && p.key == "workflowId") {
                    model.setParam(path, p.key, $0)
                }
            }
            HStack(spacing: 6) {
                Text("Label").font(.caption).foregroundStyle(.secondary).frame(width: 96, alignment: .trailing)
                TextField(spec.title, text: Binding(get: { action.label ?? "" }, set: { model.setLabel(path, $0) })).textFieldStyle(.roundedBorder).font(.callout)
            }
            HStack(spacing: 4) {
                Text("Variables").font(.caption).foregroundStyle(.secondary).frame(width: 96, alignment: .trailing)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) { ForEach(vars) { v in WFVariableChip(name: v.name).help(v.hint) } }
                }
            }
        }
    }
}

struct WFParamEditor: View {
    @Bindable var model: WorkflowsEditorModel
    let param: WorkflowParamSpec
    let value: String
    let variables: [WorkflowVariables.Variable]
    let mono: Bool
    let isWorkflowPicker: Bool
    let onChange: (String) -> Void

    private var text: Binding<String> { Binding(get: { value }, set: onChange) }

    var body: some View {
        HStack(alignment: param.kind == .multiline ? .top : .center, spacing: 6) {
            HStack(spacing: 2) {
                Text(param.label)
                if param.required { Text("*").foregroundStyle(.red) }
            }
            .font(.caption).foregroundStyle(.secondary).frame(width: 96, alignment: .trailing)
            .padding(.top, param.kind == .multiline ? 6 : 0)
            field
            if param.kind != .select && !isWorkflowPicker { variableMenu }
        }
    }

    @ViewBuilder private var field: some View {
        if isWorkflowPicker {
            Picker("", selection: text) {
                Text("Choose…").tag("")
                ForEach(model.workflows.filter { $0.id != model.draft?.id }) { w in Text(w.name).tag(w.id) }
                if !value.isEmpty && !model.workflows.contains(where: { $0.id == value }) { Text("Missing: \(value)").tag(value) }
            }
            .labelsHidden()
        } else {
            switch param.kind {
            case .select:
                Picker("", selection: text) {
                    ForEach(param.options ?? [], id: \.self) { o in Text(o == "true" ? "Yes" : o == "false" ? "No" : o).tag(o) }
                    if !value.isEmpty && !(param.options ?? []).contains(value) { Text(value).tag(value) }
                }
                .labelsHidden()
                .fixedSize()
            case .multiline:
                TextEditor(text: text)
                    .font(mono ? .system(size: 12, design: .monospaced) : .system(size: 12.5))
                    .scrollContentBackground(.hidden)
                    .padding(4)
                    .frame(minHeight: 54, maxHeight: 140)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.12)))
                    .overlay(alignment: .topLeading) {
                        if value.isEmpty, let ph = param.placeholder { Text(ph).font(.system(size: 12, design: mono ? .monospaced : .default)).foregroundStyle(.tertiary).padding(8).allowsHitTesting(false) }
                    }
            case .app:
                HStack(spacing: 4) {
                    TextField(param.placeholder ?? "", text: text).textFieldStyle(.roundedBorder)
                    Menu {
                        ForEach(model.apps.prefix(300), id: \.self) { a in Button(a) { onChange(a) } }
                    } label: { Image(systemName: "app.badge") }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("Choose an application")
                }
            case .file:
                HStack(spacing: 4) {
                    TextField(param.placeholder ?? "", text: text).textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
                    Button("Choose…") {
                        let panel = NSOpenPanel()
                        panel.canChooseDirectories = true
                        panel.canChooseFiles = true
                        if panel.runModal() == .OK, let url = panel.url {
                            let home = NSHomeDirectory()
                            onChange(url.path.hasPrefix(home) ? "~" + url.path.dropFirst(home.count) : url.path)
                        }
                    }
                    .disabled(model.feature?.context?.services.isHeadless ?? true)
                }
            case .number:
                TextField(param.placeholder ?? "", text: text).textFieldStyle(.roundedBorder).frame(maxWidth: 110).monospacedDigit()
            default:
                TextField(param.placeholder ?? "", text: text).textFieldStyle(.roundedBorder)
                    .font(param.kind == .url ? .system(size: 12, design: .monospaced) : .body)
            }
        }
    }

    private var variableMenu: some View {
        Menu {
            ForEach(variables) { v in
                Button { onChange(value + "{{\(v.name)}}") } label: { Text("{{\(v.name)}}  —  \(v.hint)") }
            }
        } label: {
            Text("{ }").font(.system(size: 11, weight: .bold, design: .monospaced))
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("Insert a variable")
    }
}

struct WFActionLibraryView: View {
    @Bindable var model: WorkflowsEditorModel
    @FocusState private var searchFocused: Bool

    var body: some View {
        let list = model.librarySpecs
        VStack(spacing: 0) {
            HStack {
                Text("Add Action").font(.headline)
                Spacer()
                Button { model.closeLibrary() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.borderless).help("Close (⎋)")
            }
            .padding(.horizontal, 12).padding(.top, 12)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search actions", text: $model.libraryQuery)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .onChange(of: model.libraryQuery) { _, _ in model.libraryIndex = 0 }
                    .onKeyPress(phases: .down) { press in
                        switch press.key {
                        case .downArrow, .upArrow, .return, .escape: return model.handleKey(press.characters, press.key, modifiers: press.modifiers) ? .handled : .ignored
                        default: return .ignored
                        }
                    }
            }
            .padding(7)
            .background(RoundedRectangle(cornerRadius: 7).fill(.quaternary.opacity(0.6)))
            .padding(10)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(WorkflowCategory.allCases, id: \.self) { cat in
                            let items = list.enumerated().filter { $0.element.category == cat }
                            if !items.isEmpty {
                                Text(cat.title.uppercased()).font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.top, 8)
                                ForEach(items, id: \.element.id) { i, s in
                                    WFLibraryRow(spec: s, selected: i == model.libraryIndex)
                                        .id(s.id)
                                        .onTapGesture { model.add(s) }
                                }
                            }
                        }
                        if list.isEmpty { Text("No matching actions").foregroundStyle(.secondary).padding() }
                    }
                    .padding(.horizontal, 6)
                }
                .onChange(of: model.libraryIndex) { _, i in if i < list.count { proxy.scrollTo(list[i].id) } }
            }
            Divider()
            WFKeyHints(hints: [("↑↓", "choose"), ("↩", "add"), ("⎋", "close")]).padding(8)
        }
        .background(.background.secondary)
        .onAppear { searchFocused = true }
    }
}

struct WFLibraryRow: View {
    let spec: WorkflowActionSpec
    let selected: Bool
    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: spec.symbol)
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(spec.category.color.gradient))
            VStack(alignment: .leading, spacing: 1) {
                Text(spec.title).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                Text(spec.description).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 7).fill(selected ? Color.accentColor.opacity(0.2) : .clear))
        .contentShape(Rectangle())
    }
}

struct WFRunPanel: View {
    @Bindable var model: WorkflowsEditorModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button { model.runPanelOpen.toggle() } label: { Image(systemName: model.runPanelOpen ? "chevron.down" : "chevron.up") }.buttonStyle(.borderless)
                Text("Run").font(.headline)
                TextField("Input ({{input}})", text: $model.runInput).textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                    .onSubmit { model.run() }
                if model.isRunning {
                    ProgressView().controlSize(.small)
                    Button("Stop") { model.stop() }.keyboardShortcut(".", modifiers: .command)
                } else {
                    Button { model.run() } label: { Label("Run", systemImage: "play.fill") }
                        .keyboardShortcut("r", modifiers: .command)
                        .buttonStyle(.borderedProminent)
                        .disabled(model.actions.isEmpty)
                }
                Spacer()
                if let r = model.lastRun, !model.isRunning {
                    Label(r.ok ? "Succeeded" : r.cancelled == true ? "Cancelled" : "Failed", systemImage: r.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(r.ok ? .green : .red).font(.callout)
                    if let ms = r.durationMs { Text("\(Int(ms)) ms").font(.caption).foregroundStyle(.secondary).monospacedDigit() }
                }
            }
            if model.runPanelOpen {
                let entries = model.isRunning ? model.liveLog : (model.lastRun?.log ?? [])
                if entries.isEmpty {
                    Text(model.isRunning ? "Running…" : "Press ⌘R to run this workflow. Each step's output appears here.").font(.callout).foregroundStyle(.secondary)
                } else {
                    ScrollView { WorkflowRunLogList(entries: entries, native: true) }.frame(maxHeight: 150)
                    if let res = model.lastRun?.result, !res.isEmpty, !model.isRunning {
                        HStack(alignment: .top) {
                            Text("Result").font(.caption).foregroundStyle(.secondary)
                            Text(res).font(.system(size: 11.5, design: .monospaced)).lineLimit(3).textSelection(.enabled)
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(.bar)
    }
}

/// Offscreen render of the editor for evidence/snapshots (never on screen).
@MainActor enum WorkflowSnapshots {
    static func renderEditor(_ feature: WorkflowEngineFeature, workflowId: String?, selectPath: String?, libraryOpen: Bool, dark: Bool, to url: URL) throws -> NSSize {
        let model = WorkflowsEditorModel(feature: feature)
        model.reload(select: workflowId)
        if let selectPath { model.selection = WorkflowTree.parse(selectPath) }
        if libraryOpen { model.openLibrary() }
        let view = WorkflowsSettingsView(model: model)
            .frame(width: 1080, height: 720)
            .environment(\.colorScheme, dark ? .dark : .light)
        return try render(AnyView(view), size: NSSize(width: 1080, height: 720), dark: dark, to: url)
    }

    static func render(_ view: AnyView, size: NSSize, dark: Bool, to url: URL) throws -> NSSize {
        let hosting = NSHostingView(rootView: view)
        hosting.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        hosting.frame = NSRect(origin: .zero, size: size)
        // An offscreen window gives materials/backgrounds a real context; it is never ordered front.
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.appearance = hosting.appearance
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { throw FeatureError.failed("no bitmap") }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw FeatureError.failed("png encoding failed") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: url)
        window.contentView = nil
        return NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
    }
}
