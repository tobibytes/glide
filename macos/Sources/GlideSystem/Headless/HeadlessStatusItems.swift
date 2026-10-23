import Foundation
import GlideCore

/// Headless status items: composition, clicks and menu-open callbacks work exactly like the live service, but no
/// NSStatusItem is ever created. Changes are recorded as `status-item` effects (`{id, title, sources, menu}` when
/// shown or changed, `{id, removed: true}` when gone); `state()` is what tests read.
@MainActor public final class HeadlessStatusItems: StatusItemHub {
    let log: SideEffectLog
    private var last: [String: String] = [:]

    public init(log: SideEffectLog) {
        self.log = log
        super.init()
    }

    override public func render(_ items: [ComposedStatusItem], removed: [String]) {
        for id in removed {
            last[id] = nil
            log.record("status-item", ["id": .string(id), "removed": true])
        }
        for c in items {
            let detail = StatusMenuJSON.item(c)
            let key = (try? String(decoding: JSONEncoder.glideCompact.encode(detail), as: UTF8.self)) ?? ""
            guard last[c.id] != key else { continue }
            last[c.id] = key
            log.record("status-item", detail)
        }
    }
}
