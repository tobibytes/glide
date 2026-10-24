import Foundation
import GlideCore
import GlideSystem

/// phone-web: the remote-control and file actions (docs/PHONE.md, owner "web"). Registered by `PhoneRemote.install`;
/// tests call `register` with a headless input and their own `PhoneFiles`.
@MainActor enum PhoneRemoteActions {
    static let maxPointerDelta = 4000.0
    static let maxScrollDelta = 4000.0
    static let maxTypedCharacters = 10_000

    static let needsAccessibility = PhoneError(
        "needs-permission",
        "Glide needs Accessibility access to control this Mac. On the Mac, open System Settings, then Privacy & Security, then Accessibility, and turn on Glide.")

    static func register(on registry: PhoneActionRegistry, input: any RemoteInputService, files: PhoneFiles) {
        func remote(_ name: String, _ title: String, _ body: @escaping @MainActor (JSONValue) throws -> Void) {
            registry.register(PhoneAction(name, title, group: "remote", risk: .safe, relay: false) { args, _ in
                guard input.isTrusted else { throw needsAccessibility }
                try body(args)
                return ["ok": true]
            })
        }

        remote("pointer.move", "Move the pointer") { args in
            let (dx, dy) = try delta(args, limit: maxPointerDelta)
            input.movePointer(dx: dx, dy: dy)
        }
        remote("pointer.click", "Click") { args in
            let name = args["button"]?.stringValue ?? "left"
            guard let button = RemoteMouseButton(rawValue: name.lowercased()) else { throw PhoneError.badArgs("Unknown button \"\(name.prefix(20))\". Use left, right or middle.") }
            input.click(button: button, count: args["double"]?.boolValue == true ? 2 : 1)
        }
        remote("pointer.scroll", "Scroll") { args in
            let (dx, dy) = try delta(args, limit: maxScrollDelta)
            input.scroll(dx: dx, dy: dy)
        }
        remote("keys.press", "Press a key") { args in
            let (code, mods) = try key(args)
            input.press(keyCode: code, modifiers: mods)
        }
        remote("type.text", "Type text") { args in
            guard let text = args["text"]?.stringValue, !text.isEmpty else { throw PhoneError.badArgs("Nothing to type.") }
            guard text.count <= maxTypedCharacters else { throw PhoneError.badArgs("That's too much text to type at once. Send it to the clipboard instead.") }
            input.type(text: text)
        }
        remote("slides.next", "Next slide") { _ in input.press(keyCode: RemoteKeys.codes["right"] ?? 124, modifiers: []) }
        remote("slides.prev", "Previous slide") { _ in input.press(keyCode: RemoteKeys.codes["left"] ?? 123, modifiers: []) }

        registry.register(PhoneAction("files.search", "Search files", group: "files", risk: .safe, relay: false) { args, _ in
            let query = (args["query"]?.stringValue ?? args.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard query.count >= 2 else { throw PhoneError.badArgs("Type at least two letters to search.") }
            let limit = max(1, min(args["limit"]?.intValue ?? 30, 100))
            return ["files": .array(await files.search(query, limit: limit))]
        })
        registry.register(PhoneAction("files.get", "Download a file", group: "files", risk: .safe, relay: false) { args, _ in
            guard let path = args["path"]?.stringValue, !path.isEmpty else { throw PhoneError.badArgs("Which file? Send its path.") }
            return try await files.get(path)
        })
    }

    static func delta(_ args: JSONValue, limit: Double) throws -> (Double, Double) {
        let dx = args["dx"]?.doubleValue ?? 0
        let dy = args["dy"]?.doubleValue ?? 0
        guard dx.isFinite, dy.isFinite else { throw PhoneError.badArgs("dx and dy must be numbers.") }
        return (min(max(dx, -limit), limit), min(max(dy, -limit), limit))
    }

    /// `{key, modifiers}`: modifiers as an array (["cmd","shift"]) or a "cmd+shift" string. A key like "cmd+k" also works.
    static func key(_ args: JSONValue) throws -> (UInt16, RemoteModifiers) {
        guard var name = args["key"]?.stringValue, !name.isEmpty else { throw PhoneError.badArgs("Which key? Send a key name like \"return\" or \"left\".") }
        var modNames: [String] = []
        if let list = args["modifiers"]?.arrayValue { modNames = list.compactMap(\.stringValue) }
        else if let s = args["modifiers"]?.stringValue { modNames = s.split(separator: "+").map(String.init) }
        if name.count > 1, name.contains("+") {
            var parts = name.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
            let last = parts.removeLast()
            name = last.isEmpty ? "+" : last
            modNames += parts
        }
        guard let mods = RemoteModifiers.parse(modNames) else { throw PhoneError.badArgs("Unknown modifier. Use cmd, shift, alt or ctrl.") }
        guard let code = RemoteKeys.code(for: name) else { throw PhoneError.badArgs("Unknown key \"\(name.prefix(20))\".") }
        return (code, mods)
    }
}
