import GlideCore
import GlideUI

// Integration: readable footer titles for pushed views (FeatureUI.viewTitle), used when a view is pushed by
// another feature, the test channel or a sub-view (an item's own push already shows the item's title).
// Views that know better at render time call `LauncherViewHost.setTitle`.
enum ViewTitles {
    static let table: [String: String] = [
        "agent.run": "Glide Agent", "agent.history": "Agent History",
        "ai.chat": "Quick AI",
        "automations.list": "Automations",
        "clipboard.history": "Clipboard History", "clipboard.stack": "Paste Stack", "clipboard.edit": "Edit Clipboard Item",
        "fileindex.search": "Search Files", "fileindex.openWith": "Open With",
        "finder.newFile": "New File Here", "finder.move": "Move Selection", "finder.openWith": "Open With",
        "layouts.list": "Window Layouts", "layouts.save": "Save Window Layout", "layouts.confirm": "Restore Layout",
        "menus.search": "Search Menu Items",
        "processes.list": "Processes", "processes.ports": "Listening Ports",
        "snippets2.search": "Search Snippets",
        "sysmon.monitor": "System Monitor",
        "workflows.prompt": "Workflow Input", "workflows.result": "Workflow Result",
    ]
    static func title(_ id: ViewID) -> String? { table[id.rawValue] }

    /// First-frame placeholders (the views set the same text when they render).
    static let placeholders: [String: String] = [
        "clipboard.history": "Search clipboard history…", "snippets2.search": "Search snippets…",
        "fileindex.search": "Search files…", "menus.search": "Search menu items…",
        "agent.history": "Search agent conversations…",
    ]
}
extension ClipboardFeature { public func viewPlaceholder(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.placeholders[id.rawValue] } }
extension Snippets2Feature { public func viewPlaceholder(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.placeholders[id.rawValue] } }
extension FilesFeature { public func viewPlaceholder(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.placeholders[id.rawValue] } }
extension MenusFeature { public func viewPlaceholder(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.placeholders[id.rawValue] } }
extension AgentFeature { public func viewPlaceholder(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.placeholders[id.rawValue] } }

extension AgentFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension AIFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { payload["title"]?.stringValue ?? ViewTitles.title(id) } }
extension AutomationsFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension ClipboardFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension FilesFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension FinderFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension LayoutsFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension MenusFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension ProcessesFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension Snippets2Feature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension SystemMonitorFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { ViewTitles.title(id) } }
extension WorkflowEngineFeature { public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { payload["title"]?.stringValue ?? ViewTitles.title(id) } }
