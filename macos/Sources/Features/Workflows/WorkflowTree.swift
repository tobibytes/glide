import Foundation
import GlideCore

/// Path into the nested action tree (lib/workflowTree.ts). A container path is [] (root) or
/// [...actionPath, .then | .else]; an action path is [...containerPath, .index(i)].
public enum WorkflowPathSegment: Hashable, Sendable, CustomStringConvertible {
    case index(Int)
    case then
    case `else`
    public var description: String {
        switch self {
        case let .index(i): return String(i)
        case .then: return "then"
        case .else: return "else"
        }
    }
}

public typealias WorkflowPath = [WorkflowPathSegment]

public enum WorkflowTree {
    public static func key(_ p: WorkflowPath) -> String { p.map(\.description).joined(separator: "/") }
    public static func parse(_ k: String) -> WorkflowPath {
        k.isEmpty ? [] : k.split(separator: "/").compactMap { s in
            s == "then" ? .then : s == "else" ? .else : Int(s).map { .index($0) }
        }
    }

    /// Depth-first, in run order (an action before its then/else children).
    public static func walk(_ list: [WorkflowAction], _ base: WorkflowPath = [], _ fn: (WorkflowAction, WorkflowPath) -> Void) {
        for (i, a) in list.enumerated() {
            let p = base + [.index(i)]
            fn(a, p)
            if let t = a.then { walk(t, p + [.then], fn) }
            if let e = a.else { walk(e, p + [.else], fn) }
        }
    }

    /// Visible rows in order (the editor's keyboard navigation order).
    public static func flatten(_ list: [WorkflowAction]) -> [WorkflowPath] {
        var out: [WorkflowPath] = []
        walk(list) { _, p in out.append(p) }
        return out
    }

    public static func container(_ root: [WorkflowAction], _ c: WorkflowPath) -> [WorkflowAction] {
        var list = root
        var i = 0
        while i < c.count {
            guard case let .index(idx) = c[i], i + 1 < c.count, idx >= 0, idx < list.count else { return [] }
            switch c[i + 1] {
            case .then: list = list[idx].then ?? []
            case .else: list = list[idx].else ?? []
            case .index: return []
            }
            i += 2
        }
        return list
    }

    public static func action(_ root: [WorkflowAction], _ p: WorkflowPath) -> WorkflowAction? {
        guard case let .index(i)? = p.last else { return nil }
        let list = container(root, Array(p.dropLast()))
        return i >= 0 && i < list.count ? list[i] : nil
    }

    public static func setContainer(_ root: [WorkflowAction], _ c: WorkflowPath, _ next: [WorkflowAction]) -> [WorkflowAction] {
        guard c.count >= 2 else { return c.isEmpty ? next : root }
        guard case let .index(idx) = c[0], idx >= 0, idx < root.count else { return root }
        var out = root
        var node = out[idx]
        switch c[1] {
        case .then: node.then = setContainer(node.then ?? [], Array(c.dropFirst(2)), next)
        case .else: node.else = setContainer(node.else ?? [], Array(c.dropFirst(2)), next)
        case .index: return root
        }
        out[idx] = node
        return out
    }

    public static func update(_ root: [WorkflowAction], _ p: WorkflowPath, _ fn: (inout WorkflowAction) -> Void) -> [WorkflowAction] {
        guard case let .index(i)? = p.last else { return root }
        let c = Array(p.dropLast())
        var list = container(root, c)
        guard i >= 0, i < list.count else { return root }
        fn(&list[i])
        return setContainer(root, c, list)
    }

    public static func remove(_ root: [WorkflowAction], _ p: WorkflowPath) -> [WorkflowAction] {
        guard case let .index(i)? = p.last else { return root }
        let c = Array(p.dropLast())
        var list = container(root, c)
        guard i >= 0, i < list.count else { return root }
        list.remove(at: i)
        return setContainer(root, c, list)
    }

    public static func insert(_ root: [WorkflowAction], _ c: WorkflowPath, _ index: Int, _ a: WorkflowAction) -> [WorkflowAction] {
        var list = container(root, c)
        list.insert(a, at: max(0, min(index, list.count)))
        return setContainer(root, c, list)
    }

    /// True when `candidate` is inside (or equal to) `ancestor`.
    public static func isWithin(_ candidate: WorkflowPath, _ ancestor: WorkflowPath) -> Bool {
        candidate.count >= ancestor.count && Array(candidate.prefix(ancestor.count)) == ancestor
    }

    /// Move an action to a container/index; returns the new root and the moved action's new path.
    public static func move(_ root: [WorkflowAction], from: WorkflowPath, to toContainer: WorkflowPath, index toIndex: Int) -> (root: [WorkflowAction], path: WorkflowPath) {
        guard let a = action(root, from), !isWithin(toContainer, from), case let .index(fromIdx)? = from.last else { return (root, from) }
        let fromContainer = Array(from.dropLast())
        var idx = toIndex
        if fromContainer == toContainer && fromIdx < toIndex { idx -= 1 }
        let without = remove(root, from)
        var target = toContainer
        if toContainer.count > fromContainer.count && isWithin(toContainer, fromContainer), case let .index(sib) = toContainer[fromContainer.count], sib > fromIdx {
            target[fromContainer.count] = .index(sib - 1)
        }
        let list = container(without, target)
        idx = max(0, min(idx, list.count))
        return (insert(without, target, idx, a), target + [.index(idx)])
    }

    /// A deep copy with fresh ids (duplicate).
    public static func clone(_ a: WorkflowAction) -> WorkflowAction {
        var c = a
        c.id = WorkflowIDs.newActionId()
        c.then = a.then?.map(clone)
        c.else = a.else?.map(clone)
        return c
    }

    /// Move one step up/down among its siblings (⌥⌘↑ / ⌥⌘↓).
    public static func nudge(_ root: [WorkflowAction], _ p: WorkflowPath, by delta: Int) -> (root: [WorkflowAction], path: WorkflowPath) {
        guard case let .index(i)? = p.last else { return (root, p) }
        let c = Array(p.dropLast())
        var list = container(root, c)
        let j = i + delta
        guard i >= 0, i < list.count, j >= 0, j < list.count else { return (root, p) }
        list.swapAt(i, j)
        return (setContainer(root, c, list), c + [.index(j)])
    }

    /// Count of actions including nested branches.
    public static func count(_ list: [WorkflowAction]) -> Int {
        var n = 0
        walk(list) { _, _ in n += 1 }
        return n
    }
}
