import AppKit
import Foundation
import GlideCore
import GlideUI
import Quartz
import SwiftUI
import UniformTypeIdentifiers

/// Detail-pane data (fileindex/preview.ts): metadata plus the first 4 KB of text files.
struct FilesPreviewInfo: Equatable {
    var path: String
    var name: String
    var folder: String
    var exists: Bool
    var isDir: Bool
    var kind: String
    var size: Int64
    var modified: Date?
    var created: Date?
    var text: String?
    var truncated = false
    var childCount: Int?

    static let previewBytes = 4096

    static func looksBinary(_ d: Data) -> Bool {
        var control = 0
        for b in d {
            if b == 0 { return true }
            if b < 9 || (b > 13 && b < 32) { control += 1 }
        }
        return control > d.count / 10
    }

    static func read(_ p: String) -> FilesPreviewInfo {
        let name = (p as NSString).lastPathComponent
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: p, isDirectory: &isDir) else {
            return FilesPreviewInfo(path: p, name: name, folder: FilesFeature.displayFolder(p), exists: false, isDir: false, kind: "Missing", size: 0)
        }
        let url = URL(fileURLWithPath: p)
        let rv = try? url.resourceValues(forKeys: [.localizedTypeDescriptionKey, .fileSizeKey, .contentModificationDateKey, .creationDateKey, .contentTypeKey])
        var info = FilesPreviewInfo(path: p, name: name, folder: FilesFeature.displayFolder(p), exists: true, isDir: isDir.boolValue,
                                    kind: rv?.localizedTypeDescription ?? (isDir.boolValue ? "Folder" : "Document"), size: Int64(rv?.fileSize ?? 0),
                                    modified: rv?.contentModificationDate, created: rv?.creationDate)
        if isDir.boolValue {
            if !FilesExclusions.bundleExts.contains(url.pathExtension) { info.childCount = (try? fm.contentsOfDirectory(atPath: p))?.filter { !$0.hasPrefix(".") }.count }
        } else if let type = rv?.contentType, type.conforms(to: .text) || type.conforms(to: .sourceCode) || type.conforms(to: .json) || (info.size < 1_000_000 && type == .data),
                  let h = FileHandle(forReadingAtPath: p) {
            let d = (try? h.read(upToCount: previewBytes)) ?? Data()
            try? h.close()
            if !looksBinary(d) {
                info.text = String(decoding: d, as: UTF8.self)
                info.truncated = info.size > Int64(previewBytes)
            }
        }
        return info
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["path": .string(path), "name": .string(name), "folder": .string(folder), "exists": .bool(exists), "isDir": .bool(isDir),
                                      "kind": .string(kind), "size": .int(size)]
        if let text { o["text"] = .string(text) }
        if let childCount { o["childCount"] = .int(Int64(childCount)) }
        return .object(o)
    }
}

/// QLPreviewView in the detail split (live app only; offscreen headless snapshots use the metadata fallback).
struct QuickLookPane: NSViewRepresentable {
    let path: String
    func makeNSView(context: Context) -> QLPreviewView {
        let v = QLPreviewView(frame: .zero, style: .compact) ?? QLPreviewView()
        v.autostarts = true
        v.shouldCloseWithWindow = false
        v.previewItem = URL(fileURLWithPath: path) as NSURL
        return v
    }
    func updateNSView(_ v: QLPreviewView, context: Context) {
        if (v.previewItem as? NSURL)?.path != path { v.previewItem = URL(fileURLWithPath: path) as NSURL }
    }
    static func dismantleNSView(_ v: QLPreviewView, coordinator: ()) { v.close() }
}

struct FilesSearchView: View {
    @Environment(\.glideTheme) private var theme
    let model: FilesSearchModel
    let headless: Bool

    var body: some View {
        if model.results.isEmpty {
            EmptyState(symbol: model.loading ? "hourglass" : "doc.text.magnifyingglass",
                       title: model.loading ? "Searching…" : model.query.isEmpty ? "No recent files" : "No files found",
                       subtitle: model.query.isEmpty ? "Files you open from Glide appear here" : "Nothing matches “\(model.query)”\(model.mode == .content ? " in file contents" : "") · ⌘T switches name ⇄ content")
        } else if model.previewShown, let sel = model.selectedPath {
            DetailSplit(ratio: 0.46) { list } detail: { FilesPreviewPane(path: sel, headless: headless) }
        } else {
            list
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    SectionHeader(model.query.isEmpty ? "Recent Files" : model.mode == .content ? "Contents match" : "Files", trailing: "\(model.results.count)")
                    ForEach(Array(model.results.enumerated()), id: \.element) { i, p in
                        FileRow(path: p, selected: i == model.selected)
                            .id(p)
                            .onTapGesture { model.selected = i }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .scrollIndicators(.never)
            .onChange(of: model.selected) { _, i in if model.results.indices.contains(i) { proxy.scrollTo(model.results[i]) } }
        }
    }
}

struct FileRow: View {
    @Environment(\.glideTheme) private var theme
    let path: String
    let selected: Bool
    var body: some View {
        HStack(spacing: 10) {
            ItemIconView(.file(path), size: 22, fallbackSymbol: "doc")
            VStack(alignment: .leading, spacing: 1) {
                Text((path as NSString).lastPathComponent).font(theme.titleFont).foregroundStyle(theme.text).lineLimit(1)
                Text(FilesFeature.displayFolder(path)).font(theme.subtitleFont).foregroundStyle(theme.text3).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .frame(height: CGFloat(theme.tokens.rowHeight))
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(selected ? theme.selected : .clear))
    }
}

struct FilesPreviewPane: View {
    @Environment(\.glideTheme) private var theme
    let path: String
    let headless: Bool

    var body: some View {
        let info = FilesPreviewInfo.read(path)
        VStack(alignment: .leading, spacing: 10) {
            if !headless && info.exists {
                QuickLookPane(path: path).frame(maxWidth: .infinity, minHeight: 170, maxHeight: 230)
            } else if let text = info.text {
                ScrollView { Text(text + (info.truncated ? "\n…" : "")).font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.text2).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: 200)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(theme.surface))
            } else {
                HStack { Spacer(); ItemIconView(.file(path), size: 96, fallbackSymbol: "doc"); Spacer() }.frame(height: 150)
            }
            Text(info.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.text).lineLimit(2)
            VStack(alignment: .leading, spacing: 4) {
                meta("Kind", info.kind)
                if !info.isDir { meta("Size", ByteCountFormatter.string(fromByteCount: info.size, countStyle: .file)) }
                if let c = info.childCount { meta("Items", "\(c)") }
                if let m = info.modified { meta("Modified", m.formatted(date: .abbreviated, time: .shortened)) }
                if let c = info.created { meta("Created", c.formatted(date: .abbreviated, time: .shortened)) }
                meta("Where", info.folder)
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) { Kbd("⌘Y"); Text("Preview").foregroundStyle(theme.text3); Kbd("⌘O"); Text("Open With").foregroundStyle(theme.text3); Kbd("⌃X"); Text("Trash").foregroundStyle(theme.text3) }
                .font(.system(size: 11))
        }
        .padding(12)
    }

    private func meta(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top) {
            Text(k).font(.system(size: 11)).foregroundStyle(theme.text3).frame(width: 64, alignment: .leading)
            Text(v).font(.system(size: 11)).foregroundStyle(theme.text2).lineLimit(2).truncationMode(.middle)
        }
    }
}

struct FilesOpenWithView: View {
    @Environment(\.glideTheme) private var theme
    let model: FilesOpenWithModel
    let filter: String
    var body: some View {
        let list = model.filtered(filter)
        if list.isEmpty {
            EmptyState(symbol: "square.grid.2x2", title: "No applications", subtitle: "Nothing can open this file")
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    SectionHeader("Open With")
                    ForEach(Array(list.enumerated()), id: \.element.path) { i, app in
                        HStack(spacing: 10) {
                            ItemIconView(.app(app.path), size: 22)
                            Text(app.name).font(theme.titleFont).foregroundStyle(theme.text)
                            Spacer()
                            if i == 0 && filter.isEmpty { Tag("Default") }
                        }
                        .padding(.horizontal, 10)
                        .frame(height: CGFloat(theme.tokens.rowHeight))
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(i == model.selected ? theme.selected : .clear))
                    }
                }
                .padding(.horizontal, 8)
            }
        }
    }
}

struct FilesSettingsView: View {
    weak var feature: FilesFeature?
    @State private var prefs = FilesSettings()
    @State private var scopes = ""
    @State private var exclusions = ""

    var body: some View {
        Form {
            Section {
                Toggle("Show files in root search", isOn: bind(\.showInRootSearch))
                Toggle("Include hidden files", isOn: bind(\.includeHidden))
            } footer: { Text("Root search: type 3+ characters, “content:…” searches inside files, “~/” browses folders. Backend: \(feature?.backendKind ?? "spotlight").") }
            Section("Search scopes (one per line)") {
                TextEditor(text: $scopes).font(.system(.body, design: .monospaced)).frame(minHeight: 60)
            }
            Section("Exclusions (globs or paths, one per line)") {
                TextEditor(text: $exclusions).font(.system(.body, design: .monospaced)).frame(minHeight: 60)
            }
            Button("Save") { save() }.keyboardShortcut("s", modifiers: .command)
        }
        .formStyle(.grouped)
        .onAppear {
            prefs = feature?.prefs ?? FilesSettings()
            scopes = prefs.scopes.joined(separator: "\n")
            exclusions = prefs.exclusions.joined(separator: "\n")
        }
    }

    private func bind(_ kp: WritableKeyPath<FilesSettings, Bool>) -> Binding<Bool> {
        Binding(get: { prefs[keyPath: kp] }, set: { prefs[keyPath: kp] = $0; save() })
    }

    private func save() {
        prefs.scopes = scopes.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        prefs.exclusions = exclusions.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let bag = prefs.bag
        Task { _ = try? await feature?.invoke(method: "setSettings", args: .object(bag)) }
    }
}
