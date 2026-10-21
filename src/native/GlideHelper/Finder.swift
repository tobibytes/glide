import AppKit
import ApplicationServices

/// Finder's selected items. `selection()` reads Finder's accessibility tree (needs only the
/// Accessibility grant Glide already has, never prompts). `selectionViaAutomation()` asks Finder
/// over Apple Events instead: more robust, but the first call shows the Automation prompt, so it
/// only runs when the user opted in.
enum FinderSelection {
    private static let bundleId = "com.apple.finder"

    private static func finderPid() -> pid_t? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first?.processIdentifier
    }

    static func selection() -> [String: Any] {
        guard AXIsProcessTrusted() else { return result([], folder: nil, source: "none", error: "Accessibility permission is required to read Finder's selection") }
        guard let pid = finderPid() else { return result([], folder: nil, source: "none", error: "Finder is not running") }
        let app = AX.app(pid, timeout: 0.5)
        let focused = AX.element(app, kAXFocusedUIElementAttribute)
        let window = focused.flatMap { AX.element($0, kAXWindowAttribute) }
            ?? AX.element(app, kAXFocusedWindowAttribute)
            ?? AX.element(app, kAXMainWindowAttribute)
        let folder = window.flatMap(folderOf) ?? (window == nil ? desktopPath() : nil)

        var selected: [AXUIElement] = focused.map(selectedItems) ?? []
        if selected.isEmpty, let window {
            // Column view or a focus ring elsewhere (toolbar, sidebar): use the deepest container with a selection.
            var budget = 4000
            selected = deepestSelection(window, depth: 0, budget: &budget) ?? []
        }
        var paths: [String] = []
        var seen = Set<String>()
        for el in selected {
            guard let p = path(of: el, folder: folder), FileManager.default.fileExists(atPath: p), seen.insert(p).inserted else { continue }
            paths.append(p)
        }
        return result(paths, folder: folder, source: "ax", error: nil)
    }

    static func selectionViaAutomation() -> [String: Any] {
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
        return onMain { () -> [String: Any] in
            var err: NSDictionary?
            guard let script = NSAppleScript(source: source) else { return result([], folder: nil, source: "automation", error: "Could not compile script") }
            let out = script.executeAndReturnError(&err)
            if let err {
                let message = (err[NSAppleScript.errorMessage] as? String) ?? "Finder did not answer"
                return result([], folder: nil, source: "automation", error: message)
            }
            let lines = (out.stringValue ?? "").components(separatedBy: "\n")
            let folder = lines.first.flatMap { $0.isEmpty ? nil : trimSlash($0) }
            let paths = lines.dropFirst().filter { !$0.isEmpty }.map(trimSlash)
            return result(paths, folder: folder, source: "automation", error: nil)
        }
    }

    private static func result(_ paths: [String], folder: String?, source: String, error: String?) -> [String: Any] {
        var o: [String: Any] = ["paths": paths, "folder": folder ?? NSNull(), "source": source]
        if let error { o["error"] = error }
        return o
    }

    private static func trimSlash(_ p: String) -> String { p.count > 1 && p.hasSuffix("/") ? String(p.dropLast()) : p }

    private static func desktopPath() -> String {
        FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first?.path ?? NSHomeDirectory() + "/Desktop"
    }

    /// Finder windows expose the shown folder as AXDocument ("file:///…/").
    private static func folderOf(_ window: AXUIElement) -> String? {
        guard let doc = AX.attr(window, kAXDocumentAttribute) as? String, let url = URL(string: doc), url.isFileURL else { return nil }
        return trimSlash(url.path)
    }

    private static func selectedItems(_ el: AXUIElement) -> [AXUIElement] {
        for name in [kAXSelectedRowsAttribute, kAXSelectedChildrenAttribute, kAXSelectedCellsAttribute] {
            if let items = AX.attr(el, name) as? [AXUIElement], !items.isEmpty { return items }
        }
        return []
    }

    private static func deepestSelection(_ el: AXUIElement, depth: Int, budget: inout Int) -> [AXUIElement]? {
        budget -= 1
        guard budget > 0, depth < 10 else { return nil }
        var found: [AXUIElement]?
        let own = selectedItems(el)
        if !own.isEmpty { found = own }
        let role = AX.attr(el, kAXRoleAttribute) as? String
        // Rows and cells are leaves for our purpose; their children never hold another selection.
        if role == kAXRowRole || role == kAXCellRole { return found }
        for child in AX.children(el) {
            if let deeper = deepestSelection(child, depth: depth + 1, budget: &budget) { found = deeper }
        }
        return found
    }

    /// AXURL when Finder provides one (icon/desktop items), else folder + the item's displayed name.
    private static func path(of el: AXUIElement, folder: String?) -> String? {
        if let url = findURL(el, depth: 0) { return trimSlash(url.path) }
        guard let folder, let name = findName(el, depth: 0), !name.isEmpty, !name.contains("/") else { return nil }
        return (folder as NSString).appendingPathComponent(name)
    }

    private static func findURL(_ el: AXUIElement, depth: Int) -> URL? {
        if let url = AX.attr(el, kAXURLAttribute) as? URL, url.isFileURL { return url }
        if let s = AX.attr(el, kAXURLAttribute) as? String, let url = URL(string: s), url.isFileURL { return url }
        guard depth < 3 else { return nil }
        for child in AX.children(el) { if let u = findURL(child, depth: depth + 1) { return u } }
        return nil
    }

    private static func findName(_ el: AXUIElement, depth: Int) -> String? {
        if let f = AX.attr(el, "AXFilename") as? String, !f.isEmpty { return f }
        let role = AX.attr(el, kAXRoleAttribute) as? String
        if role == kAXTextFieldRole || role == kAXStaticTextRole, let v = AX.attr(el, kAXValueAttribute) as? String, !v.isEmpty { return v }
        if role == kAXImageRole || role == kAXGroupRole, let t = AX.attr(el, kAXTitleAttribute) as? String, !t.isEmpty { return t }
        guard depth < 3 else { return nil }
        // List view: the first cell holds the name; later cells are date/size/kind.
        for child in AX.children(el) { if let n = findName(child, depth: depth + 1) { return n } }
        return nil
    }
}
