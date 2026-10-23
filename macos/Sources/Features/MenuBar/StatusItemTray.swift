import Foundation
import GlideCore

/// MenuBarManager's TrayHandle on top of the shared status-item API (`SystemServices.statusItems`): each extra
/// is the item "menubar.<extra>". The Timers extra is `.combinable` (it folds into Glide's icon while "Show
/// timers and focus in Glide's menu bar icon" is on); the other extras always get their own icon.
@MainActor final class StatusItemTray: TrayHandle {
    let itemId: String
    private let service: any StatusItemService
    private let placement: StatusItemPlacement
    private var spec: StatusItemSpec

    init(service: any StatusItemService, extra: String) {
        self.service = service
        itemId = "menubar.\(extra)"
        placement = extra == ExtraID.timers.rawValue ? .combinable : .separate
        spec = StatusItemSpec(section: ExtraID(rawValue: extra)?.title)
    }

    func setTitle(_ title: String) { spec.title = title; publish() }
    func setIcon(_ icon: String?) { spec.icon = icon; publish() }
    func setTooltip(_ tooltip: String) { spec.tooltip = tooltip.isEmpty ? nil : tooltip; publish() }
    func setMenu(_ menu: [MenuBarMenuItem]) { spec.menu = StatusItemBridge.menu(menu); publish() }
    func destroy() { service.remove(itemId) }

    private func publish() { service.show(itemId, spec, placement: placement) }
}

/// MenuBarMenuItem / MenuBarItemSpec (Menu Bar feature, ExtraSpecs) → shared StatusMenuItem / StatusItemSpec.
@MainActor enum StatusItemBridge {
    static func menu(_ items: [MenuBarMenuItem]) -> [StatusMenuItem] {
        items.map { m in
            if m.separator { return .separator }
            return StatusMenuItem(m.title ?? "", subtitle: m.subtitle, icon: m.icon, shortcut: m.shortcut, enabled: m.enabled ?? true, checked: m.checked ?? false,
                                  submenu: m.submenu.map(menu), onClick: m.onClick)
        }
    }

    static func spec(_ s: MenuBarItemSpec, section: String?) -> StatusItemSpec {
        StatusItemSpec(title: s.title, icon: s.icon, tooltip: s.tooltip, menu: menu(s.menu), section: section)
    }
}
