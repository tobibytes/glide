import AppKit
import ApplicationServices
import GlideCore

/// Finder's selected items (helper Finder.swift): AX path (never prompts) and an opt-in Apple Events path.
@MainActor public final class FinderSelectionService: FinderService {
    public init() {}

    public func selection() async -> FinderSelectionResult {
        guard AXIsProcessTrusted() else { return .init(paths: [], folder: nil, source: "none", error: "Accessibility permission is required to read Finder's selection") }
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first?.processIdentifier else {
            return .init(paths: [], folder: nil, source: "none", error: "Finder is not running")
        }
        return await offMain { FinderAX.selection(pid: pid) }
    }

    public func selectionViaAutomation() async -> FinderSelectionResult {
        let source = """
        tell application "Finder"
            set out to ""
            repeat with f in (get selection as alias list)
                set out to out & POSIX path of f & linefeed
            end repeat
            try
                set dir to POSIX path of (insertion location as alias)
            on error
                set dir to ""
            end try
            return dir & linefeed & out
        end tell
        """
        var err: NSDictionary?
        guard let script = NSAppleScript(source: source) else { return .init(paths: [], folder: nil, source: "automation", error: "Could not compile script") }
        let out = script.executeAndReturnError(&err)
        if let err { return .init(paths: [], folder: nil, source: "automation", error: (err[NSAppleScript.errorMessage] as? String) ?? "Finder did not answer") }
        let lines = (out.stringValue ?? "").components(separatedBy: "\n")
        let folder = lines.first.flatMap { $0.isEmpty ? nil : FinderAX.trimSlash($0) }
        return .init(paths: lines.dropFirst().filter { !$0.isEmpty }.map(FinderAX.trimSlash), folder: folder, source: "automation", error: nil)
    }
}

enum FinderAX {
    static func trimSlash(_ p: String) -> String { p.count > 1 && p.hasSuffix("/") ? String(p.dropLast()) : p }

    static func selection(pid: pid_t) -> FinderSelectionResult {
        let app = AX.app(pid, timeout: 0.5)
        let focused = AX.element(app, kAXFocusedUIElementAttribute)
        let window = focused.flatMap { AX.element($0, kAXWindowAttribute) } ?? AX.element(app, kAXFocusedWindowAttribute) ?? AX.element(app, kAXMainWindowAttribute)
        let folder = window.flatMap(folderOf) ?? (window == nil ? desktopPath() : nil)
        var selected: [AXUIElement] = focused.map(selectedItems) ?? []
        if selected.isEmpty, let window {
            var budget = 4000
            selected = deepestSelection(window, depth: 0, budget: &budget) ?? []
        }
        var paths: [String] = []
        var seen = Set<String>()
        for el in selected {
            guard let p = path(of: el, folder: folder), FileManager.default.fileExists(atPath: p), seen.insert(p).inserted else { continue }
            paths.append(p)
        }
        return .init(paths: paths, folder: folder, source: "ax", error: nil)
    }

    static func desktopPath() -> String { FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first?.path ?? NSHomeDirectory() + "/Desktop" }

    static func folderOf(_ window: AXUIElement) -> String? {
        guard let doc = AX.attr(window, kAXDocumentAttribute) as? String, let url = URL(string: doc), url.isFileURL else { return nil }
        return trimSlash(url.path)
    }

    static func selectedItems(_ el: AXUIElement) -> [AXUIElement] {
        for name in [kAXSelectedRowsAttribute, kAXSelectedChildrenAttribute, kAXSelectedCellsAttribute] {
            if let items = AX.attr(el, name) as? [AXUIElement], !items.isEmpty { return items }
        }
        return []
    }

    static func deepestSelection(_ el: AXUIElement, depth: Int, budget: inout Int) -> [AXUIElement]? {
        budget -= 1
        guard budget > 0, depth < 10 else { return nil }
        var found: [AXUIElement]?
        let own = selectedItems(el)
        if !own.isEmpty { found = own }
        let role = AX.attr(el, kAXRoleAttribute) as? String
        if role == kAXRowRole || role == kAXCellRole { return found }
        for child in AX.children(el) { if let deeper = deepestSelection(child, depth: depth + 1, budget: &budget) { found = deeper } }
        return found
    }

    static func path(of el: AXUIElement, folder: String?) -> String? {
        if let url = findURL(el, depth: 0) { return trimSlash(url.path) }
        guard let folder, let name = findName(el, depth: 0), !name.isEmpty, !name.contains("/") else { return nil }
        return (folder as NSString).appendingPathComponent(name)
    }

    static func findURL(_ el: AXUIElement, depth: Int) -> URL? {
        if let url = AX.attr(el, kAXURLAttribute) as? URL, url.isFileURL { return url }
        if let s = AX.attr(el, kAXURLAttribute) as? String, let url = URL(string: s), url.isFileURL { return url }
        guard depth < 3 else { return nil }
        for child in AX.children(el) { if let u = findURL(child, depth: depth + 1) { return u } }
        return nil
    }

    static func findName(_ el: AXUIElement, depth: Int) -> String? {
        if let f = AX.attr(el, "AXFilename") as? String, !f.isEmpty { return f }
        let role = AX.attr(el, kAXRoleAttribute) as? String
        if role == kAXTextFieldRole || role == kAXStaticTextRole, let v = AX.attr(el, kAXValueAttribute) as? String, !v.isEmpty { return v }
        if role == kAXImageRole || role == kAXGroupRole, let t = AX.attr(el, kAXTitleAttribute) as? String, !t.isEmpty { return t }
        guard depth < 3 else { return nil }
        for child in AX.children(el) { if let n = findName(child, depth: depth + 1) { return n } }
        return nil
    }
}
