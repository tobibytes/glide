import Foundation
import GlideCore

/// Headless remote input: records what the live service would post, never posts an event.
/// Kinds: `remote-move {dx,dy}`, `remote-click {button,count}`, `remote-scroll {dx,dy}`, `remote-key {key,code,modifiers}`,
/// `remote-type {text}`.
@MainActor public final class HeadlessRemoteInput: RemoteInputService {
    public struct Effect: Equatable, Sendable {
        public var kind: String
        public var detail: JSONValue
        public init(kind: String, detail: JSONValue) {
            self.kind = kind
            self.detail = detail
        }
    }

    public var isTrusted: Bool
    public private(set) var effects: [Effect] = []
    private let sink: @MainActor (String, JSONValue) -> Void

    /// `trusted: false` simulates missing Accessibility permission. `sink` receives every effect too (the app passes
    /// the side-effect log, so `headless/effects` shows them).
    public init(trusted: Bool = true, sink: @escaping @MainActor (String, JSONValue) -> Void = { _, _ in }) {
        isTrusted = trusted
        self.sink = sink
    }

    private func record(_ kind: String, _ detail: JSONValue) {
        effects.append(Effect(kind: kind, detail: detail))
        if effects.count > 1000 { effects.removeFirst(effects.count - 1000) }
        sink(kind, detail)
    }

    public func clear() { effects = [] }

    public func movePointer(dx: Double, dy: Double) { record("remote-move", ["dx": .double(dx), "dy": .double(dy)]) }
    public func click(button: RemoteMouseButton, count: Int) { record("remote-click", ["button": .string(button.rawValue), "count": .int(Int64(count))]) }
    public func scroll(dx: Double, dy: Double) { record("remote-scroll", ["dx": .double(dx), "dy": .double(dy)]) }
    public func press(keyCode: UInt16, modifiers: RemoteModifiers) {
        let name = RemoteKeys.codes.filter { $0.value == keyCode }.keys.sorted().first ?? ""
        record("remote-key", ["key": .string(name), "code": .int(Int64(keyCode)), "modifiers": .array(modifiers.names.map(JSONValue.string))])
    }
    public func type(text: String) { record("remote-type", ["text": .string(text)]) }
}
