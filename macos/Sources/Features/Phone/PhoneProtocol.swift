import Foundation
import GlideCore

// Glide on iPhone: the shared contract between the phone sessions (docs/PHONE.md).
// Every phone capability is a named action in `PhoneActionRegistry`. Both transports (the paired LAN web app and
// the iCloud Drive relay used by Shortcuts) call the same actions, and the same risk gate decides what may run.

/// Who is calling an action.
public struct PhoneCaller: Sendable, Equatable {
    public enum Transport: String, Sendable { case lan, relay }
    public var deviceId: String
    public var deviceName: String
    public var transport: Transport
    public init(deviceId: String, deviceName: String, transport: Transport) {
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.transport = transport
    }
}

/// How an action is gated. `safe` runs directly; `confirm` asks on the Mac (or on a paired phone) first.
/// `sensitive` actions (they return or replace private data such as the clipboard) are off until the user turns
/// them on in Settings → iPhone.
public enum PhoneRisk: String, Sendable, Codable { case safe, confirm }

public struct PhoneError: Error, Sendable, Equatable {
    public var code: String
    public var message: String
    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
    public static func badArgs(_ m: String) -> PhoneError { PhoneError("bad-args", m) }
    public static let denied = PhoneError("denied", "Not allowed. Turn this on in Glide → Settings → iPhone.")
    public static let notFound = PhoneError("not-found", "Unknown action")
}

@MainActor public struct PhoneAction {
    public var name: String
    public var title: String
    /// Settings / web app grouping: "core", "clipboard", "remote", "files", "agent", "notify".
    public var group: String
    public var risk: PhoneRisk
    public var sensitive: Bool
    /// Whether the iCloud relay (Shortcuts, works away from home) may call it. Live controls are LAN-only.
    public var relay: Bool
    public var run: @MainActor (JSONValue, PhoneCaller) async throws -> JSONValue
    public init(_ name: String, _ title: String, group: String, risk: PhoneRisk = .safe, sensitive: Bool = false, relay: Bool = true,
                run: @escaping @MainActor (JSONValue, PhoneCaller) async throws -> JSONValue) {
        self.name = name
        self.title = title
        self.group = group
        self.risk = risk
        self.sensitive = sensitive
        self.relay = relay
        self.run = run
    }
}

@MainActor public final class PhoneActionRegistry {
    public private(set) var actions: [String: PhoneAction] = [:]
    public private(set) var order: [String] = []
    public init() {}
    public func register(_ a: PhoneAction) {
        if actions[a.name] == nil { order.append(a.name) }
        actions[a.name] = a
    }
    public func action(_ name: String) -> PhoneAction? { actions[name] }
    public var all: [PhoneAction] { order.compactMap { actions[$0] } }
}
