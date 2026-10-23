import AppKit
import GlideCore
import GlideUI
import SwiftUI

/// Recognized text, as the result view shows it.
public struct OCRTextResult: Hashable, Codable, Sendable {
    public var kind = "text"
    /// "screen" | "clipboard" | "file"
    public var source: String
    public var text: String
    public var lines: Int
    public var words: Int
    public var chars: Int
    public var links: [String]
    public var copied: Bool
    public var permissionHint: Bool
}

public struct OCRCodesResult: Hashable, Codable, Sendable {
    public struct Code: Hashable, Codable, Sendable {
        public var payload: String
        public var symbology: String
        public var info: OCRText.Payload
    }
    public var kind = "codes"
    public var source: String
    public var codes: [Code]
}

/// Screen Text & QR (src/main/features/ocr): region capture (`screencapture -i`, never in headless runs) or a
/// clipboard image → Vision OCR / barcode detection (OCRService) → text on the clipboard and a result view.
/// Temp images are deleted right after use.
@MainActor public final class OCRFeature: Feature, FeatureUI, FeatureCommandHandling {
    public let id = "ocr"
    public let title = "Screen Text"
    private weak var context: FeatureContext?
    private var busy = false
    /// Result the view shows ("text" / "codes" / "error" / "permission").
    private(set) var current: JSONValue = .null
    /// Headless-only clipboard image (driver seam; GLIDE_HEADLESS_CLIPBOARD_IMAGE also works).
    var headlessClipboardImage: String?
    /// Recorded instead of running `screencapture` in headless mode.
    public private(set) var effects: [String] = []

    lazy var resultModel = N7ListModel(placeholder: "Filter recognized lines…", emptyTitle: "No text found") { [weak self] q in self?.resultRows(q) ?? [] }

    public init() {
        resultModel.header = { [weak self] in AnyView(OCRResultHeader(result: self?.current ?? .null)) }
    }

    struct Settings {
        var autoCopy: Bool
        var languageCorrection: Bool
        var fast: Bool
        var languages: [String]
    }

    var settings: Settings {
        let s = context?.settings(defaults: [:]) ?? [:]
        return Settings(autoCopy: s["autoCopy"]?.boolValue != false, languageCorrection: s["languageCorrection"]?.boolValue != false, fast: s["fast"]?.boolValue == true,
                        languages: (s["languages"]?.arrayValue ?? []).compactMap(\.stringValue).filter { !$0.isEmpty })
    }

    var screenAccess: String {
        if context?.services.isHeadless ?? true { return "unknown" }
        return CGPreflightScreenCaptureAccess() ? "granted" : "not-determined"
    }

    public func start(context: FeatureContext) async {
        self.context = context
        headlessClipboardImage = ProcessInfo.processInfo.environment["GLIDE_HEADLESS_CLIPBOARD_IMAGE"]
    }

    // MARK: recognition

    func recognize(file: String, source: String) async throws -> OCRTextResult {
        guard let ctx = context else { throw FeatureError.failed("Not ready") }
        let s = settings
        let r = try await ctx.services.ocr.recognize(path: file, languages: s.languages, fast: s.fast, languageCorrection: s.languageCorrection)
        let text = OCRText.assemble(r.lines)
        var copied = false
        if !text.isEmpty && s.autoCopy {
            ctx.services.pasteboard.setString(text, html: nil, transient: false)
            copied = true
        }
        let st = OCRText.stats(text)
        return OCRTextResult(source: source, text: text, lines: st.lines, words: st.words, chars: st.chars, links: OCRText.extractLinks(text), copied: copied,
                             permissionHint: text.isEmpty && source == "screen" && screenAccess != "granted")
    }

    func scan(file: String, source: String) async throws -> OCRCodesResult {
        guard let ctx = context else { throw FeatureError.failed("Not ready") }
        let r = try await ctx.services.ocr.barcodes(path: file)
        return OCRCodesResult(source: source, codes: r.codes.map {
            .init(payload: $0.payload, symbology: $0.symbology.replacingOccurrences(of: "VNBarcodeSymbology", with: ""), info: OCRText.classify($0.payload))
        })
    }

    static func tempFile() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("glide-ocr", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return dir.appendingPathComponent("capture-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(5)).png")
    }

    /// Interactive region capture (drag; Space toggles window mode; Esc cancels). nil = cancelled.
    func captureRegion() async -> URL? {
        if context?.services.isHeadless ?? true {
            effects.append("screencapture -i (skipped: headless)")
            context?.log("headless: screencapture -i not run")
            return nil
        }
        let file = Self.tempFile()
        let ok: Bool = await withCheckedContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            p.arguments = ["-i", "-x", file.path]
            p.terminationHandler = { _ in cont.resume(returning: true) }
            do { try p.run() } catch { cont.resume(returning: false) }
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        guard ok, size > 0 else {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        return file
    }

    /// The clipboard's image as a temp PNG (temp: true), or a copied image file used in place.
    func clipboardImage() -> (path: String, temp: Bool)? {
        guard let pb = context?.services.pasteboard else { return nil }
        if context?.services.isHeadless ?? true, let p = headlessClipboardImage {
            return FileManager.default.fileExists(atPath: p) ? (p, false) : nil
        }
        // integration: through PasteboardService (headless: the fake pasteboard's image / files)
        if let img = pb.fileURLs().first(where: { ["png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "gif", "bmp", "webp"].contains($0.pathExtension.lowercased()) }) {
            return (img.path, false)
        }
        guard let png = pb.imagePNG() else { return nil }
        let file = Self.tempFile()
        guard (try? png.write(to: file, options: [.atomic])) != nil else { return nil }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return (file.path, true)
    }

    // MARK: flows

    private func show(_ result: JSONValue) {
        current = result
        resultModel.changed()
    }

    private func viewFor(_ result: JSONValue) -> ViewID { ViewID(feature: id, name: result["kind"]?.stringValue == "codes" ? "codes" : "result") }

    private func open(_ result: JSONValue) {
        show(result)
        context?.push(viewFor(result), payload: .null)
        n7AfterUpdate { [weak self] in self?.resultModel.syncHost() }
    }

    static func errorResult(_ m: String, permissionHint: Bool = false) -> JSONValue { ["kind": "error", "message": .string(m), "permissionHint": .bool(permissionHint)] }

    /// Capture runs after the launcher hides; the result opens the launcher again with the view.
    @discardableResult func captureFlow(_ mode: String) async -> JSONValue {
        guard let ctx = context, !busy else { return .null }
        busy = true
        defer { busy = false }
        ctx.hideLauncher()
        try? await Task.sleep(for: .milliseconds(200))
        guard let file = await captureRegion() else { return .null }
        defer { try? FileManager.default.removeItem(at: file) }
        do {
            if mode == "text" {
                let r = try await recognize(file: file.path, source: "screen")
                if r.copied { ctx.toast("Copied Text to Clipboard", style: .success) }
                let v = N7JSON.value(r)
                open(v)
                return v
            }
            let r = try await scan(file: file.path, source: "screen")
            let v = r.codes.isEmpty ? Self.errorResult(screenAccess == "granted" ? "No QR code or barcode found in the selected area." : "No code found. If the capture was blank, Glide needs Screen Recording permission.",
                                                        permissionHint: screenAccess != "granted") : N7JSON.value(r)
            open(v)
            return v
        } catch {
            let v = Self.errorResult(error.localizedDescription)
            open(v)
            return v
        }
    }

    func fromClipboard(_ mode: String) async -> ActionResult {
        guard let img = clipboardImage() else { return .error("The clipboard has no image. Copy a screenshot or image first (⌃⇧⌘4 copies a screenshot).") }
        defer { if img.temp { try? FileManager.default.removeItem(atPath: img.path) } }
        do {
            if mode == "text" {
                let r = try await recognize(file: img.path, source: "clipboard")
                if r.text.isEmpty { return .error("No text found in the clipboard image.") }
                show(N7JSON.value(r))
                n7AfterUpdate { [weak self] in self?.resultModel.syncHost() }
                return .pushView(ViewID(feature: id, name: "result"))
            }
            let r = try await scan(file: img.path, source: "clipboard")
            if r.codes.isEmpty { return .error("No QR code or barcode found in the clipboard image.") }
            show(N7JSON.value(r))
            n7AfterUpdate { [weak self] in self?.resultModel.syncHost() }
            return .pushView(ViewID(feature: id, name: "codes"))
        } catch {
            return .error(error.localizedDescription)
        }
    }

    // MARK: catalogue

    static let entries: [(id: String, title: String, subtitle: String, symbol: String, keywords: [String])] = [
        ("capture-text", "Capture Text", "Select an area of the screen and copy its text (OCR)", "text.viewfinder", ["ocr", "screen text", "extract text", "recognize", "screenshot text", "scan text"]),
        ("scan-qr", "Scan QR Code", "Select a QR code or barcode on screen", "qrcode.viewfinder", ["qr", "barcode", "scan", "code"]),
        ("clipboard-text", "Capture Text from Clipboard Image", "OCR the image on the clipboard", "doc.text.viewfinder", ["ocr", "clipboard", "image", "extract text"]),
        ("clipboard-qr", "Scan QR Code from Clipboard Image", "Read a QR code or barcode from the clipboard image", "qrcode", ["qr", "barcode", "clipboard"]),
    ]

    public func items() -> [SearchItem] {
        Self.entries.map { e in
            SearchItem(id: "ocr.\(e.id)", kind: .command, title: e.title, subtitle: e.subtitle, icon: .symbol(e.symbol, tint: "#64D2FF"), keywords: e.keywords, feature: id,
                       data: ["action": .string(e.id)], kindLabel: "Screen Text")
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] {
        guard let a = item.data?["action"]?.stringValue, let e = Self.entries.first(where: { $0.id == a }) else { return [] }
        return [.init(id: a, title: e.title, shortcut: "↩", icon: e.symbol), .init(id: "screen-recording", title: "Open Screen Recording Settings", icon: "lock.shield"),
                .init(id: "settings", title: "Screen Text Settings…", icon: "gearshape")]
    }

    public func run(action: String, on scored: ScoredItem, modifiers: ActionModifiers) async -> ActionResult {
        switch action {
        case "capture-text", "scan-qr":
            let mode = action == "capture-text" ? "text" : "codes"
            Task { await self.captureFlow(mode) }
            return .hide()
        case "clipboard-text": return await fromClipboard("text")
        case "clipboard-qr": return await fromClipboard("codes")
        case "screen-recording":
            if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { _ = context?.services.workspace.open(url: u) }
            return .hide()
        case "settings": return .openSettings(page: id)
        default: return .error("Unknown action for \(scored.item.title)")
        }
    }

    // MARK: result views

    func copy(_ text: String) {
        context?.services.pasteboard.setString(text, html: nil, transient: false)
        LauncherHosts.current?.toast("Copied", style: .success)
    }

    func paste(_ text: String) {
        context?.hideLauncher()
        context?.services.paste.paste(text: text, html: nil)
    }

    func openURL(_ url: String) -> Bool {
        guard OCRText.isOpenable(url), let u = URL(string: url) else { return false }
        _ = context?.services.workspace.open(url: u)
        context?.hideLauncher()
        return true
    }

    func resultRows(_ query: String) -> [N7Row] {
        let kind = current["kind"]?.stringValue ?? ""
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if kind == "codes" {
            let codes = (current["codes"]?.arrayValue ?? []).compactMap { N7JSON.decode($0, as: OCRCodesResult.Code.self) }
            return codes.enumerated().compactMap { i, c in
                if !q.isEmpty && !c.payload.lowercased().contains(q) { return nil }
                var actions: [N7Action] = []
                if let u = c.info.url, OCRText.isOpenable(u) {
                    actions.append(N7Action("open", c.info.kind == .email ? "Compose E-mail" : "Open", shortcut: "↩", icon: "arrow.up.forward.square") { [weak self] in _ = self?.openURL(u) })
                }
                if let w = c.info.wifi, let pw = w.password {
                    actions.append(N7Action("password", "Copy Wi-Fi Password", shortcut: actions.isEmpty ? "↩" : "⇧⌘P", icon: "wifi") { [weak self] in self?.copy(pw) })
                }
                actions.append(N7Action("copy", "Copy Content", shortcut: actions.isEmpty ? "↩" : "⌘↩", icon: "doc.on.doc") { [weak self] in self?.copy(c.payload) })
                actions.append(N7Action("paste", "Paste Content", shortcut: "⇧⌘V", icon: "doc.on.clipboard") { [weak self] in self?.paste(c.payload) })
                let symbol = c.info.kind == .url ? "link" : c.info.kind == .wifi ? "wifi" : c.info.kind == .email ? "envelope" : c.info.kind == .phone ? "phone" : "qrcode"
                return N7Row(id: "code-\(i)", section: "Codes", icon: .symbol(symbol, tint: "#64D2FF"), title: c.info.label, subtitle: c.info.kind.rawValue.uppercased(), trailing: c.symbology,
                             actions: actions, detail: { AnyView(Text(c.payload).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)) })
            }
        }
        guard kind == "text", let text = current["text"]?.stringValue else {
            let msg = current["message"]?.stringValue ?? "Nothing recognized yet"
            return [N7Row(id: "error", icon: .symbol("exclamationmark.triangle", tint: "#FF9F0A"), title: msg,
                          subtitle: current["permissionHint"]?.boolValue == true ? "Glide may need Screen Recording permission" : nil,
                          actions: [N7Action("settings", "Open Screen Recording Settings", shortcut: "↩", icon: "lock.shield") { [weak self] in
                              if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") { _ = self?.context?.services.workspace.open(url: u) }
                          }])]
        }
        var rows: [N7Row] = [N7Row(id: "all", section: "Text", icon: .symbol("text.alignleft", tint: "#64D2FF"), title: "All Text",
                                   subtitle: text.replacingOccurrences(of: "\n", with: " ").prefix(120).description, actions: [
                                       N7Action("copy", "Copy Text", shortcut: "↩", icon: "doc.on.doc") { [weak self] in self?.copy(text) },
                                       N7Action("paste", "Paste Text", shortcut: "⌘↩", icon: "doc.on.clipboard") { [weak self] in self?.paste(text) },
                                       N7Action("copyLine", "Copy as One Line", shortcut: "⇧⌘C", icon: "text.line.first.and.arrowtriangle.forward") { [weak self] in
                                           self?.copy(text.split(whereSeparator: \.isNewline).joined(separator: " "))
                                       },
                                   ], detail: { AnyView(Text(text).font(.system(size: 12.5)).textSelection(.enabled)) })]
        for link in current["links"]?.arrayValue?.compactMap(\.stringValue) ?? [] where q.isEmpty || link.lowercased().contains(q) {
            rows.append(N7Row(id: "link-\(link)", section: "Links", icon: .symbol(link.hasPrefix("mailto:") ? "envelope" : "link", tint: "#0A84FF"), title: link,
                              actions: [N7Action("open", "Open", shortcut: "↩", icon: "arrow.up.forward.square") { [weak self] in _ = self?.openURL(link) },
                                        N7Action("copy", "Copy Link", shortcut: "⌘↩", icon: "doc.on.doc") { [weak self] in self?.copy(link) }]))
        }
        for (i, line) in text.components(separatedBy: "\n").enumerated() where !line.trimmingCharacters(in: .whitespaces).isEmpty && (q.isEmpty || line.lowercased().contains(q)) {
            rows.append(N7Row(id: "line-\(i)", section: "Lines", icon: .symbol("text.quote"), title: line,
                              actions: [N7Action("copy", "Copy Line", shortcut: "↩", icon: "doc.on.doc") { [weak self] in self?.copy(line) },
                                        N7Action("paste", "Paste Line", shortcut: "⌘↩", icon: "doc.on.clipboard") { [weak self] in self?.paste(line) }]))
        }
        return rows
    }

    public func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? {
        guard ["result", "codes"].contains(id.name) else { return nil }
        n7AfterUpdate { [weak self] in self?.resultModel.syncHost() }
        return AnyView(N7ListView(model: resultModel))
    }

    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { ["result", "codes"].contains(view.name) && resultModel.handleKey(key) }
    public func handleCommand(_ command: VimCommand, view: ViewID) -> Bool { ["result", "codes"].contains(view.name) && resultModel.handle(command) }

    public var settingsPage: SettingsPage? {
        SettingsPage(id: id, title: "Screen Text", symbol: "text.viewfinder", order: 118) { [weak self] in
            let s = self?.settings
            return AnyView(OCRSettingsView(autoCopy: s?.autoCopy ?? true, correction: s?.languageCorrection ?? true, fast: s?.fast ?? false,
                                           languages: (s?.languages ?? []).joined(separator: ", "), access: self?.screenAccess ?? "unknown") { patch in self?.setSettings(patch) })
        }
    }

    func setSettings(_ p: [String: JSONValue]) {
        var clean: [String: JSONValue] = [:]
        for k in ["autoCopy", "languageCorrection", "fast"] { if let b = p[k]?.boolValue { clean[k] = .bool(b) } }
        if let langs = p["languages"]?.arrayValue {
            clean["languages"] = .array(langs.compactMap(\.stringValue).filter { $0.range(of: "^[a-zA-Z-]{2,10}$", options: .regularExpression) != nil }.map(JSONValue.string))
        }
        context?.setSettings(clean)
    }

    // MARK: invoke

    public func invoke(method: String, args: JSONValue) async throws -> JSONValue {
        let file = args["path"]?.stringValue ?? args["file"]?.stringValue ?? args.stringValue ?? ""
        let s = settings
        switch method {
        case "settings", "setSettings":
            if method == "setSettings" { setSettings(args.objectValue ?? [:]) }
            let st = settings
            return ["autoCopy": .bool(st.autoCopy), "languageCorrection": .bool(st.languageCorrection), "fast": .bool(st.fast),
                    "languages": .array(st.languages.map(JSONValue.string)), "screenAccess": .string(screenAccess), "fastDefault": .bool(s.fast)]
        case "recognizeImage": return N7JSON.value(try await recognize(file: file, source: "file"))
        case "scanImage": return N7JSON.value(try await scan(file: file, source: "file"))
        case "openImage":
            do {
                let v = args["mode"]?.stringValue == "codes" ? N7JSON.value(try await scan(file: file, source: "file")) : N7JSON.value(try await recognize(file: file, source: "file"))
                open(v)
                return v
            } catch {
                open(Self.errorResult(error.localizedDescription))
                return .null
            }
        // Workflows (N6) call `captureText` and expect a string or {text}.
        case "captureText":
            let v = await captureFlow("text")
            return v.isNull ? ["text": "", "cancelled": true] : ["text": v["text"] ?? "", "result": v]
        case "scanQr": return await captureFlow("codes")
        case "fromClipboard":
            let r = await fromClipboard(args["mode"]?.stringValue == "codes" ? "codes" : "text")
            if case let .error(e) = r { return ["ok": false, "error": .string(e)] }
            return ["ok": true, "result": current]
        case "setHeadlessClipboardImage":
            guard context?.services.isHeadless == true else { return false }
            headlessClipboardImage = file.isEmpty ? nil : file
            return true
        case "copy":
            context?.services.pasteboard.setString(args["text"]?.stringValue ?? file, html: nil, transient: false)
            return true
        case "openUrl": return .bool(openURL(args["url"]?.stringValue ?? file))
        case "effects": return .array(effects.map(JSONValue.string))
        case "viewState": return resultModel.snapshot()
        case "viewAction": return .bool(await resultModel.run(actionId: args["id"]?.stringValue ?? ""))
        default: throw FeatureError.unknownMethod(feature: id, method: method)
        }
    }
}

struct OCRResultHeader: View {
    @Environment(\.glideTheme) private var theme
    let result: JSONValue
    var body: some View {
        if result["kind"]?.stringValue == "text" {
            HStack(spacing: 10) {
                Image(systemName: result["copied"]?.boolValue == true ? "checkmark.circle.fill" : "text.viewfinder").foregroundStyle(theme.success)
                Text("\(result["lines"]?.intValue ?? 0) lines · \(result["words"]?.intValue ?? 0) words · \(result["chars"]?.intValue ?? 0) chars")
                if result["copied"]?.boolValue == true { Text("· copied to clipboard").foregroundStyle(theme.text3) }
                Spacer()
                Text("from \(result["source"]?.stringValue ?? "screen")").foregroundStyle(theme.text3)
            }
            .font(.system(size: 12)).foregroundStyle(theme.text2).padding(.horizontal, 14).padding(.vertical, 8)
            .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 1) }
        }
    }
}

struct OCRSettingsView: View {
    @State var autoCopy: Bool
    @State var correction: Bool
    @State var fast: Bool
    @State var languages: String
    let access: String
    let onChange: ([String: JSONValue]) -> Void
    var body: some View {
        Form {
            Section("Recognition") {
                Toggle("Copy recognized text automatically", isOn: $autoCopy).onChange(of: autoCopy) { _, v in onChange(["autoCopy": .bool(v)]) }
                Toggle("Language correction", isOn: $correction).onChange(of: correction) { _, v in onChange(["languageCorrection": .bool(v)]) }
                Toggle("Fast mode (less accurate)", isOn: $fast).onChange(of: fast) { _, v in onChange(["fast": .bool(v)]) }
                TextField("Languages (e.g. en-US, de-DE; empty = automatic)", text: $languages)
                    .onSubmit { onChange(["languages": .array(languages.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) })]) }
            }
            Section("Permissions") {
                LabeledContent("Screen Recording", value: access)
                N7SettingsNote(text: "Capture Text uses the macOS region selector; without Screen Recording permission captures of other apps come out blank.")
            }
        }
        .formStyle(.grouped)
    }
}
