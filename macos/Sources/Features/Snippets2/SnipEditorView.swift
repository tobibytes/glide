import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Settings → Snippets: snippet list + editor (name, keyword with warning, text, rich text HTML, excluded apps,
/// live preview) and the expansion settings (on/off, keyword prefix, case-adaptive, excluded apps, import/export).
@MainActor @Observable final class SnipEditorModel {
    @ObservationIgnored weak var feature: Snippets2Feature?
    var selectedId: String?
    var draft = Snippet(id: "", name: "", text: "")
    var excludedText = ""
    var filter = ""
    var message: String?
    var error: String?
    var dirty = false

    init(feature: Snippets2Feature) { self.feature = feature }

    var snippets: [Snippet] {
        let all = (feature?.snippets ?? []).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let q = filter.lowercased()
        return q.isEmpty ? all : all.filter { "\($0.name) \($0.keyword ?? "")".lowercased().contains(q) }
    }

    func select(_ id: String?) {
        selectedId = id
        let s = feature?.snippets.first { $0.id == id }
        draft = s ?? Snippet(id: "", name: "", text: "")
        excludedText = (draft.excludedApps ?? []).joined(separator: ", ")
        dirty = false
        error = nil
    }

    func startNew() {
        selectedId = nil
        draft = Snippet(id: "", name: "New Snippet", text: "")
        excludedText = ""
        dirty = true
        error = nil
    }

    func save() {
        guard let f = feature else { return }
        var s = draft
        s.excludedApps = excludedText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        do {
            let saved = try f.save(s)
            select(saved.id)
            message = "Saved “\(saved.name)”"
        } catch {
            self.error = error.localizedDescription
        }
    }

    func delete() {
        guard let id = selectedId else { return }
        feature?.delete(id)
        select(snippets.first?.id)
    }

    var warning: String? {
        guard let k = draft.keyword, !k.isEmpty else { return nil }
        if let other = feature?.snippets.first(where: { $0.id != draft.id && $0.keyword?.trimmingCharacters(in: .whitespaces) == k.trimmingCharacters(in: .whitespaces) }) {
            return "“\(other.name)” already uses this keyword."
        }
        return SnipExpansion.keywordWarning(k, prefix: feature?.settings.keywordPrefix ?? "")
    }

    func state() -> JSONValue {
        ["selectedId": selectedId.map(JSONValue.string) ?? .null, "name": .string(draft.name), "dirty": .bool(dirty), "count": .int(Int64(snippets.count)),
         "warning": warning.map(JSONValue.string) ?? .null, "error": error.map(JSONValue.string) ?? .null]
    }
}

struct SnipEditorView: View {
    @Bindable var model: SnipEditorModel
    @State private var prefix = ""
    @State private var caseAdaptive = false
    @State private var excludedGlobal = ""
    @State private var expand = true
    @State private var importText = ""
    @FocusState private var focus: Field?
    enum Field { case filter, name }

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                TextField("Filter", text: $model.filter).textFieldStyle(.roundedBorder).padding(8).focused($focus, equals: .filter)
                List(selection: Binding(get: { model.selectedId }, set: { model.select($0) })) {
                    ForEach(model.snippets) { s in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(s.name).lineLimit(1)
                            if let k = s.keyword, !k.isEmpty { Text(SnipExpansion.effectiveKeyword(k, prefix: prefix)).font(.caption).foregroundStyle(.secondary) }
                        }
                        .tag(Optional(s.id))
                    }
                }
                HStack {
                    Button { model.startNew(); focus = .name } label: { Image(systemName: "plus") }.keyboardShortcut("n", modifiers: .command).help("New snippet (⌘N)")
                    Button { model.delete() } label: { Image(systemName: "minus") }.disabled(model.selectedId == nil).help("Delete snippet")
                    Spacer()
                }
                .buttonStyle(.borderless)
                .padding(8)
            }
            .frame(minWidth: 190, idealWidth: 220, maxWidth: 300)

            Form {
                Section("Snippet") {
                    TextField("Name", text: $model.draft.name).focused($focus, equals: .name)
                    TextField("Keyword", text: Binding(get: { model.draft.keyword ?? "" }, set: { model.draft.keyword = $0; model.dirty = true }), prompt: Text("e.g. ;sig"))
                    if let w = model.warning { Label(w, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.caption) }
                    VStack(alignment: .leading) {
                        Text("Text").font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: $model.draft.text).font(.system(.body, design: .monospaced)).frame(minHeight: 110)
                        Text("Placeholders: {clipboard} {selection} {date format=\"dd/MM/yyyy\" offset=\"+1d\"} {time} {day} {uuid} {cursor} {snippet name=\"…\"}")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading) {
                        Text("Rich text (HTML, optional — pasted with the plain text)").font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: Binding(get: { model.draft.html ?? "" }, set: { model.draft.html = $0.isEmpty ? nil : $0 })).font(.system(.body, design: .monospaced)).frame(minHeight: 50)
                    }
                    TextField("Don't expand in (bundle ids, comma separated)", text: $model.excludedText)
                    if let p = model.feature?.preview(text: model.draft.text, html: model.draft.html) {
                        LabeledContent("Preview") { Text(p.text).font(.system(.callout, design: .monospaced)).lineLimit(5).textSelection(.enabled) }
                    }
                    HStack {
                        if let e = model.error { Text(e).foregroundStyle(.red) } else if let m = model.message { Text(m).foregroundStyle(.secondary) }
                        Spacer()
                        Button("Save") { model.save() }.keyboardShortcut("s", modifiers: .command).buttonStyle(.borderedProminent)
                    }
                }
                Section("Expansion") {
                    Toggle("Expand keywords as you type", isOn: $expand).onChange(of: expand) { _, v in Task { await model.feature?.setExpansion(v) } }
                    TextField("Keyword prefix (e.g. ;)", text: $prefix).onSubmit { apply() }
                    Toggle("Case-adaptive (Sig → Capitalised, SIG → UPPER)", isOn: $caseAdaptive).onChange(of: caseAdaptive) { _, _ in apply() }
                    TextField("No expansion in (bundle ids, comma separated)", text: $excludedGlobal).onSubmit { apply() }
                    Text("Password fields (secure input) never expand. Needs Accessibility / Input Monitoring.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Import / Export") {
                    HStack {
                        Button("Import from File…") { report(model.feature?.importFile()) }
                        Button("Export to File…") { report(model.feature?.exportFile()) }
                    }
                    TextField("…or paste Raycast snippet JSON here and press ↩", text: $importText).onSubmit {
                        guard let f = model.feature else { return }
                        do { model.message = Snippets2Feature.message(try f.importJSON(importText)); importText = "" } catch { model.error = error.localizedDescription }
                    }
                }
            }
            .formStyle(.grouped)
        }
        .onAppear {
            let s = model.feature?.settings ?? SnippetSettings()
            prefix = s.keywordPrefix
            caseAdaptive = s.caseAdaptive
            excludedGlobal = s.excludedApps.joined(separator: ", ")
            expand = model.feature?.expandEnabled ?? true
            if model.selectedId == nil && !model.dirty { model.select(model.snippets.first?.id) }
        }
    }

    private func apply() {
        let apps = excludedGlobal.split(separator: ",").map { JSONValue.string($0.trimmingCharacters(in: .whitespaces)) }
        let s = model.feature?.setSettings(["keywordPrefix": .string(prefix), "caseAdaptive": .bool(caseAdaptive), "excludedApps": .array(apps)])
        if let s { prefix = s.keywordPrefix }
    }

    private func report(_ r: ActionResult?) {
        switch r {
        case let .stay(m)?: model.message = m
        case let .error(m)?: model.error = m
        default: break
        }
    }
}
