import GlideCore
import SwiftUI

/// What a pushed launcher view can do (the native ViewProps).
@MainActor public protocol LauncherViewHost: AnyObject {
    /// Text in the search field while this view is on top (reset to "" on push).
    var query: String { get }
    func setPlaceholder(_ text: String)
    func push(_ view: ViewID, payload: JSONValue)
    func pop()
    func close()
    func toast(_ message: String, style: ToastStyle)
    /// Footer: primary action title and whether ⌘K has actions.
    func setFooter(primary: String?, hasActions: Bool)
    /// Replace the search field text (e.g. clear it after a follow-up was sent). (N4, additive)
    /// To pre-fill a view's field when pushing it, put `"query": "<text>"` in the push payload instead.
    func setQuery(_ text: String)
    /// Readable name of the top view for the footer's context title (e.g. "Clipboard History"), replacing the
    /// default (the title of the item that pushed it, else `FeatureUI.viewTitle`, else the feature title). (integration)
    func setTitle(_ title: String)
    /// Ids of the pushed views, bottom → top (e.g. to avoid stacking a duplicate). (integration)
    var viewStack: [ViewID] { get }
}

public extension LauncherViewHost {
    func setQuery(_ text: String) {}
    func setTitle(_ title: String) {}
    var viewStack: [ViewID] { [] }
}

/// A page in the Settings window sidebar.
public struct SettingsPage: Identifiable {
    public var id: String
    public var title: String
    /// SF Symbol name.
    public var symbol: String
    public var order: Int
    public var view: @MainActor () -> AnyView
    /// Deep-link sub-route (`glide://settings/<id>/<route>`, `openSettings(page: "<id>/<route>")` or `"<id>#<route>"`),
    /// delivered before the page is shown, e.g. `workflows/<id>`, `snippets/<id>`, `automations#new`. (integration)
    public var onRoute: (@MainActor (String) -> Void)?
    public init(id: String, title: String, symbol: String, order: Int = 100, view: @escaping @MainActor () -> AnyView) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.order = order
        self.view = view
    }
    public init(id: String, title: String, symbol: String, order: Int = 100, onRoute: @escaping @MainActor (String) -> Void, view: @escaping @MainActor () -> AnyView) {
        self.init(id: id, title: title, symbol: symbol, order: order, view: view)
        self.onRoute = onRoute
    }

    /// "workflows/wf-1" → ("workflows", "wf-1"); "automations#new" → ("automations", "new"); "ai" → ("ai", nil).
    public static func split(_ page: String) -> (id: String, route: String?) {
        guard let i = page.firstIndex(where: { $0 == "/" || $0 == "#" }) else { return (page, nil) }
        let rest = String(page[page.index(after: i)...])
        return (String(page[..<i]), rest.isEmpty ? nil : rest)
    }
}

/// UI contributions of a feature (adopt next to `Feature` in the same class).
@MainActor public protocol FeatureUI: Feature {
    var settingsPage: SettingsPage? { get }
    /// The view for `id` (only ids of this feature are asked). nil = unknown view.
    func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView?
    /// Keys while this feature's view is on top, before the launcher's default handling. true = handled.
    func handleKey(_ key: VimKey, view: ViewID) -> Bool
    /// Footer context title for a pushed view, known at push time (nil = the launcher's default). (integration)
    func viewTitle(_ id: ViewID, payload: JSONValue) -> String?
    /// Search-field placeholder known at push time, so it shows on the first frame (`setPlaceholder` from
    /// `launcherView` still overrides it). nil = "Search…". (integration)
    func viewPlaceholder(_ id: ViewID, payload: JSONValue) -> String?
}

public extension FeatureUI {
    func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { nil }
    func viewPlaceholder(_ id: ViewID, payload: JSONValue) -> String? { nil }
    var settingsPage: SettingsPage? { nil }
    func launcherView(_ id: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? { nil }
    func handleKey(_ key: VimKey, view: ViewID) -> Bool { false }
}

/// Shared vim handling for pushed views: the launcher runs `Vim.key` (counts, gg, NORMAL/INSERT) and offers
/// each resulting command (move, goto, activate, actions, delete, copy, paste…) to the top view's feature
/// first. true = the view applied it (e.g. moved its own selection). Opt in by conforming the feature class.
@MainActor public protocol FeatureCommandHandling: FeatureUI {
    func handleCommand(_ command: VimCommand, view: ViewID) -> Bool
}

/// The launcher's view host, available to features before their view first renders (headless runs never
/// render until a snapshot). Set by the app when the launcher window is created.
@MainActor public enum LauncherHosts {
    public static weak var current: (any LauncherViewHost)?
}
