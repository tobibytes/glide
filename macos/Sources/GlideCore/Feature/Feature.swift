import Foundation

/// A launcher view addressed as "<featureId>.<name>" (e.g. "clipboard.history"), like the Electron registry.
public struct ViewID: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { rawValue = value }
    public init(feature: String, name: String) { rawValue = "\(feature).\(name)" }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var feature: String { String(rawValue.split(separator: ".", maxSplits: 1).first ?? "") }
    public var name: String { rawValue.split(separator: ".", maxSplits: 1).dropFirst().first.map(String.init) ?? "" }
    public var description: String { rawValue }
}

/// One ⌘K action. The first action of an item is primary (⏎); the one with shortcut "⌘⏎" is secondary.
public struct ItemAction: Hashable, Codable, Sendable, Identifiable {
    public var id: String
    public var title: String
    /// Display string, e.g. "⌘⏎", "⇧⌘C", "⌃X".
    public var shortcut: String?
    /// SF Symbol name (emoji also accepted).
    public var icon: String?
    public var destructive: Bool
    public init(id: String, title: String, shortcut: String? = nil, icon: String? = nil, destructive: Bool = false) {
        self.id = id
        self.title = title
        self.shortcut = shortcut
        self.icon = icon
        self.destructive = destructive
    }
}

public struct ActionModifiers: OptionSet, Hashable, Codable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let command = ActionModifiers(rawValue: 1)
    public static let shift = ActionModifiers(rawValue: 2)
    public static let option = ActionModifiers(rawValue: 4)
}

/// What the launcher does after an action ran.
public enum ActionResult: Sendable, Equatable {
    /// Done: hide the launcher (unless keepOpenAfterRun applies), optionally showing a message.
    case hide(message: String? = nil)
    /// Keep the launcher open; show `message` as a toast if set. The list is refreshed.
    case stay(message: String? = nil)
    /// Push a launcher view (rendered by the owning feature's FeatureUI.launcherView).
    case pushView(ViewID, payload: JSONValue = .null)
    /// Open the Settings window at a page (feature id or "general", optionally "/<sub-route>").
    case openSettings(page: String?)
    case error(String)
}

/// One query handed to `Feature.dynamicItems`. Respect `deadline`: the registry stops waiting at the deadline
/// and drops late results (check `Task.isCancelled` in long loops).
public struct DynamicQuery: Sendable {
    public var text: String
    public var deadline: ContinuousClock.Instant
    public init(text: String, deadline: ContinuousClock.Instant) {
        self.text = text
        self.deadline = deadline
    }
    public var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
}

public enum FeatureError: Error, LocalizedError, Equatable {
    case unknownFeature(String)
    case unknownMethod(feature: String, method: String)
    case invalidArguments(String)
    case failed(String)
    public var errorDescription: String? {
        switch self {
        case let .unknownFeature(f): return "Unknown feature \(f)"
        case let .unknownMethod(f, m): return "Feature \(f) has no method \(m)"
        case let .invalidArguments(m): return m
        case let .failed(m): return m
        }
    }
}

public enum ToastStyle: String, Sendable, Codable { case info, success, error }

/// Services the host gives a feature (the native `FeatureContext`). Provided by the app; tests use
/// `TestFeatureContext` (GlideCore) or the headless app.
@MainActor public protocol FeatureContext: AnyObject {
    var featureId: String { get }
    var store: Store { get }
    var services: SystemServices { get }
    /// <userData>/features/<id>/ (created on demand).
    func dataDirectory() -> URL
    /// This feature's settings bag (`settings.features[id]`) merged over `defaults`.
    func settings(defaults: [String: JSONValue]) -> [String: JSONValue]
    func setSettings(_ patch: [String: JSONValue])
    /// Re-read every feature's `items()` and push the catalogue to the engine.
    func refreshCatalogue()
    func showLauncher()
    func hideLauncher()
    /// Show the launcher with a view pushed.
    func push(_ view: ViewID, payload: JSONValue)
    func openSettings(page: String?)
    func toast(_ message: String, style: ToastStyle)
    /// Register (or replace, or remove with nil) a global hotkey owned by this feature. False if refused.
    @discardableResult func registerHotkey(key: String, accelerator: String?, handler: @escaping @MainActor () -> Void) -> Bool
    /// Run any catalogue item's primary action as if chosen in the launcher (records usage).
    func executeItem(id: String, argument: String?) async -> ActionResult
    /// Search exactly like the launcher (flattened, launcher order, fallbacks excluded).
    func search(_ query: String) async -> [ScoredItem]
    func findItem(id: String) -> SearchItem?
    /// Call another feature's `invoke(method:args:)`.
    func callFeature(_ featureId: String, method: String, args: JSONValue) async throws -> JSONValue
    func log(_ message: String)
    /// Record a side effect that has no SystemServices API (headless runs: lands in the side-effect log, i.e.
    /// `[headless] <kind> <detail>` and `headless/effects`; live: a log line). (integration)
    func recordEffect(kind: String, detail: JSONValue)
    /// Show `title` next to the Glide menu-bar icon ("" clears it). One title per feature; the menu-bar feature may
    /// claim it through `StatusTitleRouting.claim` (e.g. onto its Timers extra). Never shown in headless runs
    /// (recorded as `status-title`). (integration)
    func setStatusTitle(_ title: String)
}

public extension FeatureContext {
    func recordEffect(kind: String, detail: JSONValue) {}
    func setStatusTitle(_ title: String) {}
}

/// Routes `FeatureContext.setStatusTitle` (the Electron `setTrayTitleHandler`). The menu-bar feature installs
/// `claim`; returning true means it shows the title itself, so the Glide icon stays plain.
@MainActor public enum StatusTitleRouting {
    public static var claim: ((_ featureId: String, _ title: String) -> Bool)?
}

/// A feature module — the unit phase-1 sessions build. See docs/ARCHITECTURE.md for the contract.
///
/// Lifecycle: the registry creates every feature at launch, calls `start(context:)` once (do not block: kick
/// off long work in a Task), then reads `items()` whenever the catalogue is rebuilt (start, data change,
/// `context.refreshCatalogue()`), `dynamicItems(for:)` on every keystroke, `actions(for:)` for rows whose
/// `item.feature == id`, and `run(action:on:modifiers:)` when one is chosen. UI lives in `FeatureUI` (GlideUI).
@MainActor public protocol Feature: AnyObject, Sendable {
    /// Stable id. MUST equal the Electron feature id when one exists (settings bag key, view ids, item ids).
    var id: String { get }
    /// Human name (settings sidebar, logs).
    var title: String { get }
    func start(context: FeatureContext) async
    func stop() async
    /// Static catalogue items. Set `item.feature = id` (the registry stamps it if missing).
    func items() -> [SearchItem]
    /// Per-query items (like the calculator). Keep it well under the budget or return [] for short queries.
    func dynamicItems(for query: DynamicQuery) async -> [ScoredItem]
    /// Budget for `dynamicItems` (default 60 ms).
    var dynamicItemsBudget: Duration { get }
    /// Actions for items this feature owns. First = primary (⏎); shortcut "⌘⏎" = secondary.
    func actions(for item: SearchItem) -> [ItemAction]
    func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult
    /// Methods callable from other features and the test channel (`{"cmd":"invoke"}`).
    func invoke(method: String, args: JSONValue) async throws -> JSONValue
}

public extension Feature {
    func start(context: FeatureContext) async {}
    func stop() async {}
    func items() -> [SearchItem] { [] }
    func dynamicItems(for query: DynamicQuery) async -> [ScoredItem] { [] }
    var dynamicItemsBudget: Duration { .milliseconds(60) }
    func actions(for item: SearchItem) -> [ItemAction] { [] }
    func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult { .error("Action \(action) is not available") }
    func invoke(method: String, args: JSONValue) async throws -> JSONValue { throw FeatureError.unknownMethod(feature: id, method: method) }
}

/// Running these brings another app to the front, so the launcher steps aside even with keepOpenAfterRun.
public func switchesApp(_ item: SearchItem, actionId: String?) -> Bool {
    if let a = actionId?.lowercased(),
       ["copy", "paste", "reveal", "pin", "favorite", "alias", "hotkey", "delete", "remove"].contains(where: { a.hasPrefix($0) }) {
        return false
    }
    return item.kind == .app || item.kind == .file || item.kind == .quicklink
}
