import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Icon of an extension `IconSource` (emoji, #colour, assets file, file:// path, https URL).
struct ExtIconView: View {
    let src: String?
    let assets: String?
    let size: CGFloat
    var body: some View {
        let icon = extIcon(src, assets: assets)
        if icon?.kind == "url", let u = URL(string: icon?.value ?? "") {
            AsyncImage(url: u) { $0.resizable().aspectRatio(contentMode: .fit) } placeholder: { Color.clear }.frame(width: size, height: size)
        } else {
            ItemIconView(icon, size: size, fallbackSymbol: "circle.dotted")
        }
    }
}

struct MarkdownView: View {
    @Environment(\.glideTheme) private var theme
    let source: String
    var anchor: Int = 0

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    var body: some View {
        let blocks = MarkdownBlock.parse(source)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { i, b in
                        block(b).id(i).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(18)
                .textSelection(.enabled)
            }
            .onChange(of: anchor) { _, a in withAnimation(theme.animation) { proxy.scrollTo(a, anchor: .top) } }
        }
    }

    @ViewBuilder private func block(_ b: MarkdownBlock) -> some View {
        switch b {
        case let .heading(level, text):
            Text(inline(text)).font(.system(size: level == 1 ? 22 : level == 2 ? 17 : 14, weight: .semibold)).foregroundStyle(theme.text)
        case let .paragraph(text): Text(inline(text)).font(.system(size: 13)).foregroundStyle(theme.text).lineSpacing(2)
        case let .bullet(text, ordered):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ordered.map { "\($0)." } ?? "•").foregroundStyle(theme.text3)
                Text(inline(text)).font(.system(size: 13)).foregroundStyle(theme.text)
            }
        case let .quote(text):
            HStack(spacing: 8) {
                Rectangle().fill(theme.borderStrong).frame(width: 3)
                Text(inline(text)).font(.system(size: 13)).foregroundStyle(theme.text2)
            }
        case let .code(text):
            Text(text).font(.system(size: 12, design: .monospaced)).foregroundStyle(theme.text)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(theme.surface))
        case .rule: Rectangle().fill(theme.border).frame(height: 1)
        case let .image(alt, url):
            if url.lowercased().hasPrefix("https://"), let u = URL(string: url) {
                AsyncImage(url: u) { $0.resizable().aspectRatio(contentMode: .fit) } placeholder: { Text(alt).foregroundStyle(theme.text3) }.frame(maxHeight: 240)
            } else {
                Text(alt.isEmpty ? url : alt).foregroundStyle(theme.text3)
            }
        }
    }
}

struct MetadataView: View {
    @Environment(\.glideTheme) private var theme
    let entries: [JSONValue]
    let assets: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, e in
                let kind = e["kind"]?.stringValue ?? "label"
                if kind == "separator" {
                    Rectangle().fill(theme.border).frame(height: 1)
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(e["label"]?.stringValue ?? "").font(.system(size: 11, weight: .medium)).foregroundStyle(theme.text3)
                        if kind == "tags" {
                            HStack(spacing: 4) {
                                ForEach(Array((e["tags"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, t in
                                    Tag(t["text"]?.stringValue ?? "")
                                }
                            }
                        } else {
                            HStack(spacing: 5) {
                                if let i = e["icon"]?.stringValue { ExtIconView(src: i, assets: assets, size: 14) }
                                Text(e["text"]?.stringValue ?? "").font(.system(size: 12.5)).foregroundStyle(e["link"] != nil ? theme.accentText : theme.text)
                            }
                        }
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Renders an extension's current view model (List / Grid / Detail / Form) with the shared look.
struct RunView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: RunModel

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
            if let p = model.panels.last {
                ActionPanel(title: p.title, actions: p.filtered, selectedIndex: p.selected, filter: p.filter).padding(10)
            }
            if let a = model.alert {
                VStack(spacing: 10) {
                    Text(a.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.text)
                    if let m = a.message { Text(m).font(.system(size: 12)).foregroundStyle(theme.text2).multilineTextAlignment(.center) }
                    HStack(spacing: 14) {
                        HStack(spacing: 4) { Text(a.dismiss).foregroundStyle(theme.text2); Kbd("Esc") }
                        HStack(spacing: 4) { Text(a.primary).foregroundStyle(a.destructive ? theme.danger : theme.text); Kbd("↩") }
                    }.font(.system(size: 12, weight: .medium))
                }
                .padding(18).frame(width: 340)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.panelSolid))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.borderStrong))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .overlay(alignment: .top) {
            if model.isLoading { ProgressView().progressViewStyle(.linear).tint(theme.accent).frame(height: 2) }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.type {
        case "list": list
        case "grid": grid
        case "detail": detail
        case "form": FormBody(model: model)
        default: EmptyState(symbol: "hourglass", title: "Loading \(model.session.info.commandTitle)…")
        }
    }

    private var dropdown: some View {
        Group {
            if let dd = model.view["dropdown"] {
                let cur = dd["value"]?.stringValue
                let title = (dd["options"]?.arrayValue ?? []).first { $0["value"]?.stringValue == cur }?["title"]?.stringValue ?? cur ?? ""
                HStack(spacing: 6) {
                    Text("\(dd["tooltip"]?.stringValue.map { "\($0): " } ?? "")\(title)").font(.system(size: 11.5, weight: .medium)).foregroundStyle(theme.text2)
                    Kbd("⌘P")
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    private var emptyView: some View {
        let e = model.view["emptyView"]
        return EmptyState(symbol: model.isLoading ? "hourglass" : "tray",
                          title: e?["title"]?.stringValue ?? (model.isLoading ? "Loading…" : model.view["emptyText"]?.stringValue ?? "No results"),
                          subtitle: e?["description"]?.stringValue)
    }

    private var list: some View {
        let rows = model.rows
        let sel = model.selected?.id
        return VStack(spacing: 0) {
            dropdown
            if rows.isEmpty { emptyView.frame(maxHeight: .infinity) } else if model.showsDetail {
                DetailSplit(ratio: 0.42) { listRows(rows, sel, compact: true) } detail: {
                    if let d = model.selected?.detail {
                        VStack(spacing: 0) {
                            MarkdownView(source: d["markdown"]?.stringValue ?? "")
                            if let md = d["metadata"]?.arrayValue, !md.isEmpty {
                                Rectangle().fill(theme.border).frame(height: 1)
                                MetadataView(entries: md, assets: model.assets)
                            }
                        }
                    } else { EmptyState(symbol: "sidebar.right", title: "No details") }
                }
            } else {
                listRows(rows, sel, compact: false)
            }
        }
    }

    private func listRows(_ rows: [ExtItem], _ sel: String?, compact: Bool) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, item in
                        if let s = item.section, i == 0 || rows[i - 1].section != s { SectionHeader(s) }
                        ExtRow(item: item, selected: item.id == sel, compact: compact, assets: model.assets)
                            .id(item.id)
                            .onTapGesture { model.selectedIndex = i; model.activate(secondary: false) }
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 6)
            }
            .onChange(of: sel) { _, id in if let id { proxy.scrollTo(id) } }
        }
    }

    private var grid: some View {
        let rows = model.rows
        let sel = model.selected?.id
        let cols = Array(repeating: GridItem(.flexible(), spacing: 10), count: model.columns)
        return VStack(spacing: 0) {
            dropdown
            if rows.isEmpty { emptyView.frame(maxHeight: .infinity) } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        let sections = Dictionary(grouping: Array(rows.enumerated()), by: { $0.element.section ?? "" })
                        let order = rows.reduce(into: [String]()) { if !$0.contains($1.section ?? "") { $0.append($1.section ?? "") } }
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(order, id: \.self) { sec in
                                if !sec.isEmpty { SectionHeader(sec) }
                                LazyVGrid(columns: cols, spacing: 10) {
                                    ForEach(sections[sec] ?? [], id: \.element.id) { i, item in
                                        GridCell(item: item, selected: item.id == sel, assets: model.assets).id(item.id)
                                            .onTapGesture { model.selectedIndex = i; model.activate(secondary: false) }
                                    }
                                }
                            }
                        }
                        .padding(12)
                    }
                    .onChange(of: sel) { _, id in if let id { proxy.scrollTo(id) } }
                }
            }
        }
    }

    private var detail: some View {
        HStack(spacing: 0) {
            MarkdownView(source: model.view["markdown"]?.stringValue ?? "", anchor: model.detailAnchor)
            if let md = model.view["metadata"]?.arrayValue, !md.isEmpty {
                Rectangle().fill(theme.border).frame(width: 1)
                ScrollView { MetadataView(entries: md, assets: model.assets) }.frame(width: 230)
            }
        }
    }
}

struct ExtRow: View {
    @Environment(\.glideTheme) private var theme
    let item: ExtItem
    let selected: Bool
    let compact: Bool
    let assets: String
    var body: some View {
        HStack(spacing: theme.tokens.rowGap) {
            ExtIconView(src: item.icon, assets: assets, size: theme.tokens.iconSize)
            Text(item.title).font(theme.titleFont).foregroundStyle(theme.text).lineLimit(1)
            if !compact, let s = item.subtitle { Text(s).font(theme.subtitleFont).foregroundStyle(theme.text3).lineLimit(1) }
            Spacer(minLength: 8)
            if !compact {
                HStack(spacing: 8) {
                    ForEach(Array(item.accessories.enumerated()), id: \.offset) { _, a in
                        if let t = a["tag"]?.stringValue { Tag(t) }
                        if let i = a["icon"]?.stringValue { ExtIconView(src: i, assets: assets, size: 14) }
                        if let t = a["text"]?.stringValue { Text(t).font(.system(size: 12)).foregroundStyle(theme.text3) }
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: theme.tokens.rowHeight)
        .background(RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous).fill(selected ? theme.selected : .clear))
        .contentShape(Rectangle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct GridCell: View {
    @Environment(\.glideTheme) private var theme
    let item: ExtItem
    let selected: Bool
    let assets: String
    var body: some View {
        VStack(spacing: 5) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(theme.surface)
                if let c = item.content, c.hasPrefix("#") {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(RGBA(hex: c) ?? theme.tokens.accent)).padding(6)
                } else {
                    ExtIconView(src: item.content, assets: assets, size: 44)
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(selected ? theme.accent : .clear, lineWidth: 2))
            if !item.title.isEmpty { Text(item.title).font(.system(size: 11.5, weight: .medium)).foregroundStyle(theme.text).lineLimit(1) }
            if let s = item.subtitle { Text(s).font(.system(size: 10.5)).foregroundStyle(theme.text3).lineLimit(1) }
        }
        .contentShape(Rectangle())
    }
}

/// Raycast Form fields as native controls; the focused field follows Tab / ⇧Tab / ↑↓.
struct FormBody: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: RunModel
    @FocusState private var focus: String?

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { model.formValues[id]?.stringValue ?? "" }, set: { model.setField(id, .string($0)) })
    }

    var body: some View {
        let editable = model.editableFields.compactMap { $0["id"]?.stringValue }
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let d = model.view["description"]?.stringValue { Text(d).font(.system(size: 12)).foregroundStyle(theme.text2) }
                ForEach(Array(model.fields.enumerated()), id: \.offset) { _, f in
                    field(f)
                }
            }
            .padding(18)
        }
        .onChange(of: model.focusedField) { _, i in focus = i < editable.count ? editable[i] : nil }
        .onAppear { focus = editable.first }
    }

    @ViewBuilder private func field(_ f: JSONValue) -> some View {
        let id = f["id"]?.stringValue ?? ""
        let type = f["type"]?.stringValue ?? "text"
        let title = f["title"]?.stringValue ?? id
        switch type {
        case "separator": Rectangle().fill(theme.border).frame(height: 1)
        case "description":
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text3).frame(width: 120, alignment: .trailing)
                Text(f["text"]?.stringValue ?? "").font(.system(size: 12.5)).foregroundStyle(theme.text2)
            }
        default:
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(theme.text2).frame(width: 120, alignment: .trailing)
                VStack(alignment: .leading, spacing: 3) {
                    control(f, id: id, type: type)
                    if let e = f["error"]?.stringValue, !e.isEmpty { Text(e).font(.system(size: 11)).foregroundStyle(theme.danger) }
                    else if let i = f["info"]?.stringValue { Text(i).font(.system(size: 11)).foregroundStyle(theme.text3) }
                }
            }
        }
    }

    @ViewBuilder private func control(_ f: JSONValue, id: String, type: String) -> some View {
        let placeholder = f["placeholder"]?.stringValue ?? ""
        switch type {
        case "password": SecureField(placeholder, text: binding(id)).textFieldStyle(.roundedBorder).focused($focus, equals: id)
        case "textarea": TextEditor(text: binding(id)).font(.system(size: 13)).frame(height: 70).focused($focus, equals: id)
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(theme.border))
        case "checkbox":
            Toggle(f["label"]?.stringValue ?? f["title"]?.stringValue ?? "", isOn: Binding(get: { model.formValues[id]?.boolValue ?? false }, set: { model.setField(id, .bool($0)) }))
                .toggleStyle(.checkbox).focused($focus, equals: id)
        case "dropdown":
            Picker("", selection: binding(id)) {
                ForEach(Array((f["options"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, o in
                    Text(o["title"]?.stringValue ?? "").tag(o["value"]?.stringValue ?? "")
                }
            }.labelsHidden().focused($focus, equals: id)
        case "tags":
            let opts = f["options"]?.arrayValue ?? []
            let cur = Set((model.formValues[id]?.arrayValue ?? []).compactMap(\.stringValue))
            HStack(spacing: 6) {
                ForEach(Array(opts.enumerated()), id: \.offset) { _, o in
                    let v = o["value"]?.stringValue ?? ""
                    Toggle(o["title"]?.stringValue ?? v, isOn: Binding(get: { cur.contains(v) }, set: { on in
                        var next = cur
                        if on { next.insert(v) } else { next.remove(v) }
                        model.setField(id, .array(opts.compactMap { $0["value"]?.stringValue }.filter(next.contains).map(JSONValue.string)))
                    })).toggleStyle(.button)
                }
            }
        case "date", "datetime":
            DatePicker("", selection: Binding(get: {
                (model.formValues[id]?.stringValue).flatMap { ISO8601DateFormatter().date(from: $0) } ?? Date()
            }, set: { model.setField(id, .string(ISO8601DateFormatter().string(from: $0))) }), displayedComponents: type == "date" ? [.date] : [.date, .hourAndMinute])
                .labelsHidden().focused($focus, equals: id)
        case "file":
            TextField("Path", text: Binding(get: { (model.formValues[id]?.arrayValue ?? []).compactMap(\.stringValue).joined(separator: ", ") },
                                             set: { model.setField(id, .array($0.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) })) }))
                .textFieldStyle(.roundedBorder).focused($focus, equals: id)
        default: TextField(placeholder, text: binding(id)).textFieldStyle(.roundedBorder).focused($focus, equals: id)
        }
    }
}

/// Preferences / arguments form (Glide-owned).
struct FieldsFormView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: FieldsFormModel
    @FocusState private var focus: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(model.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(theme.text)
                ForEach(model.fields) { f in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(f.title + (f.required ? " *" : "")).font(.system(size: 12.5, weight: .medium)).foregroundStyle(theme.text2).frame(width: 150, alignment: .trailing)
                        VStack(alignment: .leading, spacing: 3) {
                            control(f)
                            if let i = f.info { Text(i).font(.system(size: 11)).foregroundStyle(theme.text3) }
                        }
                    }
                }
                if let e = model.error { Text(e).font(.system(size: 12)).foregroundStyle(theme.danger) }
                HStack(spacing: 6) {
                    Spacer()
                    Text(model.submitTitle).font(.system(size: 12, weight: .medium)).foregroundStyle(theme.text)
                    Kbd("⌘↩")
                }
            }
            .padding(18)
        }
        .onChange(of: model.focused) { _, i in focus = model.fields.indices.contains(i) ? model.fields[i].id : nil }
        .onAppear { focus = model.fields.first?.id }
    }

    @ViewBuilder private func control(_ f: FieldsFormModel.Field) -> some View {
        let text = Binding(get: { model.string(f.id) }, set: { model.values[f.id] = .string($0) })
        switch f.type {
        case "password": SecureField(f.placeholder ?? "", text: text).textFieldStyle(.roundedBorder).focused($focus, equals: f.id)
        case "checkbox":
            Toggle(f.info ?? "", isOn: Binding(get: { model.values[f.id]?.boolValue ?? false }, set: { model.values[f.id] = .bool($0) }))
                .toggleStyle(.checkbox).focused($focus, equals: f.id)
        case "dropdown":
            Picker("", selection: text) { ForEach(f.options, id: \.value) { Text($0.title).tag($0.value) } }.labelsHidden().focused($focus, equals: f.id)
        default: TextField(f.placeholder ?? "", text: text).textFieldStyle(.roundedBorder).focused($focus, equals: f.id)
        }
    }
}

/// Manage Extensions / Store list with a details pane, ⌘K panel and the install confirmation card.
struct SimpleListView: View {
    @Environment(\.glideTheme) private var theme
    @Bindable var model: SimpleListModel

    var body: some View {
        let rows = model.filtered
        let sel = model.current?.id
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                if let b = model.banner {
                    Text(b).font(.system(size: 11.5)).foregroundStyle(theme.warning).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 6)
                }
                if rows.isEmpty { EmptyState(symbol: "puzzlepiece.extension", title: "Nothing here") } else {
                    DetailSplit(ratio: 0.5) {
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 0) {
                                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, r in
                                        if let s = r.section, i == 0 || rows[i - 1].section != s { SectionHeader(s) }
                                        HStack(spacing: 10) {
                                            ItemIconView(r.icon, size: 22, fallbackSymbol: "puzzlepiece.extension")
                                            VStack(alignment: .leading, spacing: 1) {
                                                Text(r.title).font(theme.titleFont).foregroundStyle(theme.text).lineLimit(1)
                                                if let s = r.subtitle { Text(s).font(.system(size: 11)).foregroundStyle(theme.text3).lineLimit(1) }
                                            }
                                            Spacer(minLength: 6)
                                            if model.busy == r.id { ProgressView().controlSize(.small) } else if let a = r.accessory { Tag(a) }
                                        }
                                        .padding(.horizontal, 10).frame(height: 44)
                                        .background(RoundedRectangle(cornerRadius: theme.tokens.rowRadius, style: .continuous).fill(r.id == sel ? theme.selected : .clear))
                                        .id(r.id)
                                        .onTapGesture { model.selected = i }
                                    }
                                }
                                .padding(8)
                            }
                            .onChange(of: sel) { _, id in if let id { proxy.scrollTo(id) } }
                        }
                    } detail: {
                        ScrollView {
                            Text(model.current?.detail ?? "").font(.system(size: 12.5)).foregroundStyle(theme.text).frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        }
                    }
                }
            }
            if let p = model.panel { ActionPanel(title: p.title, actions: p.filtered, selectedIndex: p.selected, filter: p.filter).padding(10) }
            if let c = model.confirm {
                VStack(alignment: .leading, spacing: 10) {
                    Label(c.title, systemImage: "exclamationmark.shield").font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.text)
                    Text(c.message).font(.system(size: 12)).foregroundStyle(theme.text2)
                    HStack(spacing: 14) {
                        Spacer()
                        HStack(spacing: 4) { Text("Cancel").foregroundStyle(theme.text2); Kbd("Esc") }
                        HStack(spacing: 4) { Text("Install").foregroundStyle(theme.text); Kbd("↩") }
                    }.font(.system(size: 12, weight: .medium))
                }
                .padding(18).frame(width: 400)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.panelSolid))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.borderStrong))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

struct ExtensionsSettingsView: View {
    weak var feature: ExtensionsFeature?
    @State private var storeURL = ""
    @State private var tick = 0

    var body: some View {
        Form {
            Section("Installed") {
                let list = feature?.registry?.list() ?? []
                if list.isEmpty { Text("No extensions installed. Open the Store from the launcher to add some.").foregroundStyle(.secondary) }
                ForEach(list, id: \.name) { e in
                    Toggle(isOn: Binding(get: { e.enabled }, set: { on in
                        try? feature?.registry?.setEnabled(e.name, on)
                        feature?.context?.refreshCatalogue()
                        tick += 1
                    })) {
                        VStack(alignment: .leading) {
                            Text(e.manifest?.title ?? e.name)
                            Text("\(e.manifest?.version ?? "?") · \(e.manifest?.runtime == "raycast" ? "Raycast" : "Glide") · \(e.dir.path)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .id(tick)
            Section("Store") {
                TextField("Store index URL (blank = default)", text: $storeURL)
                    .onSubmit { feature?.context?.setSettings(["storeUrl": .string(storeURL.trimmingCharacters(in: .whitespaces))]) }
                Text("Fetched only when you open the Store. https only (http for 127.0.0.1).").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { storeURL = feature?.context?.settings(defaults: ExtensionsFeature.defaults)["storeUrl"]?.stringValue ?? "" }
    }
}
