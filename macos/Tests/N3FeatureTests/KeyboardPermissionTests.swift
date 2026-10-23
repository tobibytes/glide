import Foundation
import Testing
@testable import GlideCore
@testable import GlideFeatures
@testable import GlideSystem

/// Permission service whose status the test flips (the real one polls TCC every 2 s).
@MainActor private final class FlippablePermissions: PermissionService {
    var accessibility = false
    var onChange: ((PermissionsStatus) -> Void)?
    func status() -> PermissionsStatus {
        PermissionsStatus(accessibility: accessibility, inputMonitoring: false, calendar: "notDetermined", reminders: "notDetermined", location: "notDetermined")
    }
    func request(_ kind: PermissionKind) async -> PermissionsStatus { status() }
    func grant() {
        accessibility = true
        onChange?(status())
    }
}

@Suite("keyboard tap after a permission grant (input-audit)")
@MainActor struct KeyboardPermissionTests {
    /// Real-app path: Glide launched without Accessibility builds an EMPTY tap config. Granting it later only ran the
    /// tap's own retry, which had nothing to start, so snippet expansion / Hyper stayed dead until a relaunch.
    @Test func grantingAccessibilityConfiguresTheTap() async {
        let perms = FlippablePermissions()
        var chained = 0
        let ctx = N3Context("keyboard", services: { log in
            let h = SystemServicesFactory.headless(log: log)
            return SystemServices(workspace: h.workspace, pasteboard: h.pasteboard, paste: h.paste, notifications: h.notifications, scripts: h.scripts,
                                  confirmation: h.confirmation, frontmost: h.frontmost, selection: h.selection, windows: h.windows, menus: h.menus,
                                  hotkeys: h.hotkeys, keyboardTap: h.keyboardTap, permissions: perms, ocr: h.ocr, eventKit: h.eventKit, finder: h.finder,
                                  wifi: h.wifi, colorPicker: h.colorPicker, layouts: h.layouts, spotlight: h.spotlight, isHeadless: false)
        })
        perms.onChange = { _ in chained += 1 } // the services factory's handler (tap + hotkey retry) must keep running
        ctx.store.mutate { $0.snippets = [Snippet(id: "1", name: "sig", text: "Best, Olu", keyword: ";sig")] }
        let f = KeyboardFeature()
        await f.start(context: ctx)
        #expect(ctx.effects("keyboard-tap-config").last?["snippets"] == 0) // no Accessibility: nothing enabled

        perms.grant()
        #expect(chained == 1)
        #expect(ctx.effects("keyboard-tap-config").last?["snippets"] == 1)
        #expect(f.state()["keywordCount"] == 1)
    }
}
