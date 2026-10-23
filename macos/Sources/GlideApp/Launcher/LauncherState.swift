import GlideCore
import GlideUI

/// One row of the launcher list (header or item).
struct LauncherRow: Identifiable, Equatable {
    enum Kind: Equatable { case header(String), item(ScoredItem, index: Int) }
    let id: String
    let kind: Kind
    let section: String
}

struct PushedView: Equatable {
    let id: ViewID
    let payload: JSONValue
    var query: String = ""
    var placeholder: String = "Search…"
    /// Footer context title: `LauncherViewHost.setTitle`, else the pushing item's title (see `viewTitle`).
    var title: String?
    var footerPrimary: String?
    var footerHasActions = false
}

struct ActionPanelState: Equatable {
    var item: ScoredItem
    var actions: [ItemAction]
    var filter = ""
    var selected = 0
    /// Opened in NORMAL mode and not filtering: j/k/l/h navigate.
    var vimNav = false
    var filtered: [ItemAction] {
        guard !filter.isEmpty else { return actions }
        let q = prepareQuery(filter)
        return actions.filter { fuzzyMatch(prepareText($0.title), q) != nil }
    }
}

/// Typing an argument for an acceptsArgument item (Tab).
struct ArgumentMode: Equatable {
    var item: ScoredItem
    var savedQuery: String
    /// Several named arguments (quicklinks `{argument name=…}`): see MultiArgument.swift.
    var multi: MultiArgumentState?
}
