import Foundation
import GlideCore
import GlideUI
import SwiftUI

/// Glide on iPhone (feature id "phone"). Other phone modules plug in through the hooks in
/// `start` (each hook lives in that session's own file) and never edit this file except to add a hook line.
@MainActor public final class PhoneFeature: Feature, FeatureUI {
    public let id = "phone"
    public let title = "iPhone"
    public let registry = PhoneActionRegistry()
    public private(set) weak var context: FeatureContext?
    /// Cleanup registered by the hooks (servers, watchers, timers).
    var stopHandlers: [@MainActor () async -> Void] = []
    /// Pending "Ask" confirmations (shared API, see PhoneCoreGate.swift).
    public let confirmations = PhoneConfirmations()
    /// phone-core state: devices, LAN server, request log (PhoneCoreState.swift).
    let core = PhoneCoreState()

    public init() {}

    public func start(context: FeatureContext) async {
        self.context = context
        await PhoneCore.install(self)        // phone-core: LAN server, pairing, crypto, core actions, settings page
        await PhoneRemote.install(self)      // phone-web: remote control + file actions (the web app itself is static)
        await PhoneRelay.install(self)       // phone-relay: iCloud Drive relay, Shortcuts, clipboard mirror, triggers
        await PhoneNotify.install(self)      // phone-notify: notifications (ntfy), agent from the phone, approvals
        PhoneCore.didInstallHooks(self)
    }

    public func stop() async {
        for h in stopHandlers.reversed() { await h() }
        stopHandlers.removeAll()
    }

    public func onStop(_ h: @escaping @MainActor () async -> Void) { stopHandlers.append(h) }

    // MARK: catalogue, methods and UI (phone-core: PhoneCoreUI.swift / PhoneCoreMethods.swift)

    public func items() -> [SearchItem] { PhoneCore.items(self) }
    public func actions(for item: SearchItem) -> [ItemAction] { PhoneCore.actions(self, for: item) }
    public func run(action: String, on item: ScoredItem, modifiers: ActionModifiers) async -> ActionResult { PhoneCore.run(self, action: action, on: item) }
    public func invoke(method: String, args: JSONValue) async throws -> JSONValue { try await PhoneCore.invoke(self, method: method, args: args) }
    public var settingsPage: SettingsPage? { PhoneCore.settingsPage(self) }
    public func launcherView(_ view: ViewID, payload: JSONValue, host: LauncherViewHost) -> AnyView? { PhoneCore.launcherView(self, view, payload: payload, host: host) }
    public func handleKey(_ key: VimKey, view: ViewID) -> Bool { PhoneCore.handleKey(self, key, view: view) }
    public func viewTitle(_ id: ViewID, payload: JSONValue) -> String? { id == PhoneCore.confirmView ? "iPhone Requests" : nil }
}
