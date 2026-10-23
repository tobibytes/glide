import Foundation

/// Holds every feature, routes items/actions to their owner and fans out dynamic queries with a time budget.
@MainActor public final class FeatureRegistry {
    public private(set) var features: [any Feature]
    private var byId: [String: any Feature] = [:]
    public private(set) var started = false
    /// Called for diagnostics (late providers, duplicate ids).
    public var log: (String) -> Void = { _ in }
    /// Multiplies every feature's `dynamicItemsBudget`. 1 in the app; the test server raises it so rankings stay
    /// deterministic when many headless instances share a loaded CPU (a 60 ms wall-clock budget is then a coin
    /// flip). Interactive latency is measured separately (`show` → `showMs`).
    public var dynamicBudgetScale: Double = 1

    public init(features: [any Feature]) {
        self.features = []
        for f in features { register(f) }
    }

    public func register(_ feature: any Feature) {
        if byId[feature.id] != nil {
            log("duplicate feature id \(feature.id); keeping the first")
            return
        }
        features.append(feature)
        byId[feature.id] = feature
    }

    public func feature(_ id: String) -> (any Feature)? { byId[id] }

    /// The feature that owns an item (`item.feature`).
    public func owner(of item: SearchItem) -> (any Feature)? { item.feature.flatMap { byId[$0] } }

    public func startAll(context: (any Feature) -> FeatureContext) async {
        guard !started else { return }
        started = true
        for f in features { await f.start(context: context(f)) }
    }

    public func stopAll() async {
        for f in features.reversed() { await f.stop() }
        started = false
    }

    /// All static items, stamped with their owner.
    public func catalogueItems() -> [SearchItem] {
        var out: [SearchItem] = []
        for f in features {
            for var item in f.items() {
                if item.feature == nil { item.feature = f.id }
                out.append(item)
            }
        }
        return out
    }

    /// Ask every feature for per-query rows; each gets its own budget, stragglers are cancelled and dropped.
    public func dynamicItems(for text: String) async -> [ScoredItem] {
        let clock = ContinuousClock()
        let now = clock.now
        var pending: [Task<[ScoredItem]?, Never>] = []
        for f in features {
            let deadline = now.advanced(by: f.dynamicItemsBudget * dynamicBudgetScale)
            let query = DynamicQuery(text: text, deadline: deadline)
            pending.append(Task { @MainActor in await Self.race(f, query) })
        }
        var results: [[ScoredItem]] = []
        for (i, task) in pending.enumerated() {
            let id = features[i].id
            if let items = await task.value {
                results.append(items.map { s in
                    var s = s
                    if s.item.feature == nil { s.item.feature = id }
                    return s
                })
            } else {
                log("feature \(id) missed its dynamic-items budget for \"\(text)\"")
            }
        }
        return results.flatMap { $0 }
    }

    /// Main-actor time each feature's last `dynamicItems` call took (ms): diagnostics (test channel `metrics`).
    public private(set) static var lastDynamicMs: [String: Double] = [:]

    /// Run a provider against its deadline; whichever finishes first wins (nil = too late).
    private static func race(_ f: any Feature, _ query: DynamicQuery) async -> [ScoredItem]? {
        await withCheckedContinuation { (cont: CheckedContinuation<[ScoredItem]?, Never>) in
            let once = ResumeOnce(cont)
            let work = Task { @MainActor in
                let t0 = ContinuousClock.now
                let items = await f.dynamicItems(for: query)
                let d = ContinuousClock.now - t0
                lastDynamicMs[f.id] = Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
                once.resume(items)
            }
            Task {
                try? await Task.sleep(until: query.deadline, clock: .continuous)
                work.cancel()
                once.resume(nil)
            }
        }
    }

    public func actions(for item: SearchItem) -> [ItemAction] { owner(of: item)?.actions(for: item) ?? [] }

    public func run(action: String, on item: ScoredItem, modifiers: ActionModifiers = []) async -> ActionResult {
        guard let f = owner(of: item.item) else { return .error("No feature owns \(item.item.id)") }
        return await f.run(action: action, on: item, modifiers: modifiers)
    }

    public func invoke(feature id: String, method: String, args: JSONValue) async throws -> JSONValue {
        guard let f = byId[id] else { throw FeatureError.unknownFeature(id) }
        return try await f.invoke(method: method, args: args)
    }
}

/// Resumes a continuation exactly once (first caller wins).
final class ResumeOnce<T: Sendable>: @unchecked Sendable {
    private var cont: CheckedContinuation<T, Never>?
    private let lock = NSLock()
    init(_ cont: CheckedContinuation<T, Never>) { self.cont = cont }
    func resume(_ value: T) {
        lock.lock()
        let c = cont
        cont = nil
        lock.unlock()
        c?.resume(returning: value)
    }
}
