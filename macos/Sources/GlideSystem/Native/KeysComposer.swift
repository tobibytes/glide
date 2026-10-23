import CoreGraphics
import Foundation
import GlideCore

/// Fan-out of keyboard-tap events (session N2). The tap has ONE `onEvent` closure; the Keyboard feature (N3) owns
/// it and the single `configure` call (configure replaces the whole config). It forwards every event here, and the
/// features that answer the tap subscribe: Snippets 2.0 renders `.snippetMatched` and calls `tap.finishExpansion`,
/// the Clipboard answers `.stackNext` with `tap.applyStackReply`. Contributions to the config go through
/// `callFeature("keyboard", "setSnippets" | "setPasteStack")`.
@MainActor public final class KeyboardTapComposer {
    /// One contribution to the tap config (used by `merge`, the pure helper for owners that combine several).
    public struct Part: Hashable, Sendable {
        public var snippets: [KeyboardTapConfig.SnippetEntry]
        /// Bundle ids where no snippet expands.
        public var excludedBundleIds: [String]
        public var hyperKey: Bool
        /// ⌘V pastes the next Paste Stack item (only set while the stack has items).
        public var pasteStack: Bool
        public init(snippets: [KeyboardTapConfig.SnippetEntry] = [], excludedBundleIds: [String] = [], hyperKey: Bool = false, pasteStack: Bool = false) {
            self.snippets = snippets
            self.excludedBundleIds = excludedBundleIds
            self.hyperKey = hyperKey
            self.pasteStack = pasteStack
        }
    }

    private struct Entry { weak var owner: SystemServices?; let composer: KeyboardTapComposer }
    private static var cache: [ObjectIdentifier: Entry] = [:]

    /// The hub of this services instance (created on first use; it does NOT take over `keyboardTap.onEvent`).
    public static func shared(for services: SystemServices) -> KeyboardTapComposer {
        let key = ObjectIdentifier(services)
        if let e = cache[key], e.owner === services { return e.composer }
        let c = KeyboardTapComposer(tap: services.keyboardTap)
        cache[key] = Entry(owner: services, composer: c)
        return c
    }

    public let tap: any KeyboardTapService
    private var subscribers: [String: (KeyboardTapEvent) -> Void] = [:]
    public private(set) var lastError: String?
    public private(set) var dispatched = 0

    public init(tap: any KeyboardTapService) { self.tap = tap }

    /// Make this hub the tap's event sink (only when no keyboard feature forwards events, e.g. tests).
    public func attachToTap() { tap.onEvent = { [weak self] e in self?.dispatch(e) } }

    public func subscribe(_ owner: String, _ handler: ((KeyboardTapEvent) -> Void)?) { subscribers[owner] = handler }

    /// Deliver an event to every subscriber (the keyboard feature's tap handler calls this; tests may too).
    public func dispatch(_ event: KeyboardTapEvent) {
        dispatched += 1
        if case let .tapFailed(reason) = event { lastError = reason }
        for key in subscribers.keys.sorted() { subscribers[key]?(event) }
    }

    /// Pure merge: snippets of all owners (owner order, first owner wins a duplicate keyword) longest keyword first,
    /// exclusions unioned, Hyper / Paste Stack on when any owner wants them.
    public nonisolated static func merge(_ parts: [String: Part]) -> KeyboardTapConfig {
        var out = KeyboardTapConfig()
        var seen = Set<String>()
        var excluded: [String] = []
        for owner in parts.keys.sorted() {
            guard let p = parts[owner] else { continue }
            for s in p.snippets where !s.keyword.isEmpty && seen.insert(s.keyword).inserted { out.snippets.append(s) }
            for b in p.excludedBundleIds where !excluded.contains(where: { $0.lowercased() == b.lowercased() }) { excluded.append(b) }
            out.hyperKey = out.hyperKey || p.hyperKey
            out.pasteStack = out.pasteStack || p.pasteStack
        }
        out.snippets = out.snippets.enumerated().sorted { a, b in
            a.element.keyword.count != b.element.keyword.count ? a.element.keyword.count > b.element.keyword.count : a.offset < b.offset
        }.map(\.element)
        out.excludedBundleIds = excluded
        return out
    }
}

/// Synthetic keys features need after a paste (session N2). Headless: recorded, never posted.
@MainActor public enum SyntheticKeys {
    /// Paste through `services.paste` (transient write, ⌘V, clipboard restored), then press ← `cursorLeft` times so
    /// the caret lands on a snippet's {cursor}.
    public static func paste(text: String, html: String?, cursorLeft: Int, services: SystemServices) {
        services.paste.paste(text: text, html: html)
        let n = max(0, min(cursorLeft, 2000))
        guard n > 0 else { return }
        if services.isHeadless {
            (services.paste as? HeadlessPaste)?.log.record("cursor-left", ["count": .int(Int64(n))])
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            for _ in 0..<n { postKey(CGKeyCode(KeyCodes.leftArrow)) }
        }
    }
}
