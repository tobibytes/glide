import Foundation
import GlideCore
import Observation
import SwiftUI

/// phone-core's state behind `PhoneFeature.core`: devices, the LAN server, the request log and the extension
/// points the other phone modules use (test-channel methods and Settings → iPhone sections).
@MainActor @Observable final class PhoneCoreState {
    /// Bumped on every change the Settings page shows.
    var revision = 0
    @ObservationIgnored var log = PhoneRequestLog(file: nil)
    @ObservationIgnored var devices: PhoneDeviceRegistry?
    @ObservationIgnored var server: PhoneLANServer?
    @ObservationIgnored var starting: Task<Void, Never>?
    var lastError: String?
    /// The pairing on screen: the pending device id and the link inside the QR code.
    var pairing: (deviceId: String, url: String, localURL: String?)?
    var confirmSelected = 0
    @ObservationIgnored var methods: [String: @MainActor (JSONValue) async throws -> JSONValue] = [:]
    @ObservationIgnored var sections: [(id: String, order: Int, view: @MainActor () -> AnyView)] = []
    @ObservationIgnored var clock: () -> Date = { Date() }

    func bump() { revision &+= 1 }
}

public extension PhoneFeature {
    /// Add a test-channel / cross-feature method (`invoke phone <name>`). For the other phone modules' hooks;
    /// core methods win on a name clash.
    func addMethod(_ name: String, _ f: @escaping @MainActor (JSONValue) async throws -> JSONValue) { core.methods[name] = f }

    /// Add a section to Settings → iPhone (shown after the core sections, ordered by `order`).
    func addSettingsSection(id: String, order: Int = 100, _ view: @escaping @MainActor () -> AnyView) {
        core.sections.removeAll { $0.id == id }
        core.sections.append((id, order, view))
        core.sections.sort { $0.order < $1.order }
        core.bump()
    }
}
