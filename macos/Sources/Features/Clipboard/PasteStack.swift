import Foundation
import GlideCore

/// Paste Stack (pure; port of src/main/features/clipboard/stack.ts). "Start Paste Stack" collects the next N copies;
/// ⌘V (or "Paste Next from Stack") pastes them one by one. `items` is always in paste order (head = next): FIFO
/// appends new copies, LIFO prepends them; reordering just moves ids. Persisted as <dataDir>/stack.json.
public struct PasteStack: Hashable, Codable, Sendable {
    public var collecting = false
    /// Stop collecting after this many copies (0 = until stopped).
    public var limit = 0
    public var collected = 0
    public var order: StackOrder = .fifo
    /// Entry ids in paste order.
    public var items: [String] = []

    public init(collecting: Bool = false, limit: Int = 0, collected: Int = 0, order: StackOrder = .fifo, items: [String] = []) {
        self.collecting = collecting
        self.limit = limit
        self.collected = collected
        self.order = order
        self.items = items
    }

    /// normalizeStack(): tolerant decode of whatever stack.json holds.
    public init(json: JSONValue?) {
        guard let o = json?.objectValue else { return }
        collecting = o["collecting"]?.boolValue == true
        limit = max(0, Int(o["limit"]?.doubleValue ?? 0))
        collected = max(0, Int(o["collected"]?.doubleValue ?? 0))
        order = o["order"]?.stringValue == "lifo" ? .lifo : .fifo
        items = o["items"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    public static func start(order: StackOrder, limit: Int = 0) -> PasteStack {
        PasteStack(collecting: true, limit: max(0, limit), collected: 0, order: order, items: [])
    }

    public func stopped() -> PasteStack { var s = self; s.collecting = false; return s }

    private func placing(_ id: String) -> [String] {
        let rest = items.filter { $0 != id }
        return order == .fifo ? rest + [id] : [id] + rest
    }

    /// A new copy while collecting. A re-copy of a waiting id moves it to where a new copy would go.
    public func pushed(_ id: String) -> PasteStack {
        guard collecting else { return self }
        var s = self
        s.items = placing(id)
        s.collected += 1
        s.collecting = limit > 0 ? s.collected < limit : true
        return s
    }

    /// An entry chosen by hand (works whether or not collecting).
    public func added(_ id: String) -> PasteStack { var s = self; s.items = placing(id); return s }

    /// Take the next id; ids that no longer exist are dropped.
    public func takeNext(exists: (String) -> Bool = { _ in true }) -> (id: String?, stack: PasteStack) {
        var s = self
        let alive = items.filter(exists)
        guard let first = alive.first else { s.items = alive; return (nil, s) }
        s.items = Array(alive.dropFirst())
        return (first, s)
    }

    public func removing(_ id: String) -> PasteStack { var s = self; s.items.removeAll { $0 == id }; return s }

    /// Move up (-1) or down (+1) in paste order; clamped at the ends.
    public func moving(_ id: String, by dir: Int) -> PasteStack {
        guard let i = items.firstIndex(of: id) else { return self }
        let j = i + dir
        guard j >= 0, j < items.count else { return self }
        var s = self
        s.items.swapAt(i, j)
        return s
    }

    /// Switching order reverses the waiting items so "next" follows the new rule.
    public func withOrder(_ o: StackOrder) -> PasteStack {
        guard o != order else { return self }
        var s = self
        s.order = o
        s.items.reverse()
        return s
    }

    public func cleared() -> PasteStack { var s = self; s.items = []; s.collecting = false; s.collected = 0; return s }

    /// ⌘V pastes from the stack while something is waiting.
    public var interceptsPaste: Bool { !items.isEmpty }

    /// Put an id back at the head (a ⌘V reply that arrived after the tap's watchdog).
    public func restoringHead(_ id: String) -> PasteStack { var s = self; s.items = [id] + items.filter { $0 != id }; return s }
}

/// What the ⌘V path answers the keyboard tap (port of stackNative.ts).
public enum StackReply: Equatable, Sendable {
    case text(String, html: String?)
    /// The entry (image/file) was put on the pasteboard by us: let the original ⌘V through.
    case passthrough
    case empty
}
