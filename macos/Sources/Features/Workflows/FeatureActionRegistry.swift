import Foundation
import GlideCore

/// What a feature action's `run` returns: the text for {{result}} (nil = leave {{result}} alone) plus extra variables.
public struct FeatureActionOutput: Sendable, Equatable {
    public var result: String?
    public var vars: [String: String]
    public init(result: String? = nil, vars: [String: String] = [:]) {
        self.result = result
        self.vars = vars
    }
}

/// A workflow action contributed by a feature (FeatureWorkflowAction in src/main/workflows/feature-actions.ts).
/// Stored in data.json as `{ "type": "feature", "params": { "feature": <feature>, "action": <id>, …params } }`.
public struct FeatureWorkflowAction: Sendable {
    public typealias Run = @MainActor @Sendable (_ params: [String: String], _ vars: [String: String]) async throws -> FeatureActionOutput
    /// Unique within the feature, e.g. "upper" or "start".
    public var id: String
    public var title: String
    public var description: String
    public var emoji: String
    public var symbol: String
    public var category: WorkflowCategory
    public var params: [WorkflowParamSpec]
    public var outputVar: String?
    /// `params` are substituted (without feature/action, defaults filled); `vars` is a snapshot. Throw to fail.
    public var run: Run

    public init(id: String, title: String, description: String = "", emoji: String = "🧩", symbol: String = "puzzlepiece.extension",
                category: WorkflowCategory = .system, params: [WorkflowParamSpec] = [], outputVar: String? = nil, run: @escaping Run) {
        self.id = id
        self.title = title
        self.description = description
        self.emoji = emoji
        self.symbol = symbol
        self.category = category
        self.params = params
        self.outputVar = outputVar
        self.run = run
    }
}

public struct WorkflowStepError: Error, LocalizedError, Equatable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Feature-provided workflow actions. Any feature in GlideFeatures can add actions from its `start(context:)`:
///
///     WorkflowActionRegistry.shared.register(feature: id, FeatureWorkflowAction(id: "start", title: "Start Timer", …) { params, vars in … })
///
/// They appear in the editor's action library (type "feature") and run in every workflow. A feature's own
/// registration always replaces a host-provided default for the same `<feature>.<action>`.
@MainActor public final class WorkflowActionRegistry {
    public static let shared = WorkflowActionRegistry()

    struct Entry {
        var feature: String
        var def: FeatureWorkflowAction
        var spec: WorkflowActionSpec
        var isDefault: Bool
        var token: UUID
    }

    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    /// Bumped on every change (the editor re-reads the library).
    public private(set) var generation = 0

    public init() {}

    static func key(_ feature: String, _ action: String) -> String { "\(feature).\(action)" }

    /// Register (or replace) an action; returns an unregister closure.
    @discardableResult
    public func register(feature: String, _ def: FeatureWorkflowAction) -> @MainActor () -> Void {
        add(feature: feature, def, isDefault: false)
    }

    /// Host-provided action on behalf of a feature: never replaces one the feature registered itself.
    @discardableResult
    public func registerDefault(feature: String, _ def: FeatureWorkflowAction) -> @MainActor () -> Void {
        let k = Self.key(feature, def.id)
        if let e = entries[k], !e.isDefault { return {} }
        return add(feature: feature, def, isDefault: true)
    }

    private func add(feature: String, _ def: FeatureWorkflowAction, isDefault: Bool) -> @MainActor () -> Void {
        precondition(!feature.isEmpty && !def.id.isEmpty, "A workflow action needs a feature id and an action id")
        let k = Self.key(feature, def.id)
        let token = UUID()
        if entries[k] == nil { order.append(k) }
        entries[k] = Entry(feature: feature, def: def, spec: Self.spec(feature: feature, def), isDefault: isDefault, token: token)
        generation += 1
        return { [weak self] in
            guard let self, self.entries[k]?.token == token else { return }
            self.entries[k] = nil
            self.order.removeAll { $0 == k }
            self.generation += 1
        }
    }

    public func unregisterAll(feature: String) {
        for (k, e) in entries where e.feature == feature { entries[k] = nil }
        order.removeAll { entries[$0] == nil }
        generation += 1
    }

    static func spec(feature: String, _ def: FeatureWorkflowAction) -> WorkflowActionSpec {
        WorkflowActionSpec(type: "feature", feature: feature, action: def.id, title: def.title, description: def.description, emoji: def.emoji, symbol: def.symbol,
                           category: def.category,
                           params: [WorkflowParamSpec(FeatureActionKeys.feature, "Feature", .hidden, default: feature),
                                    WorkflowParamSpec(FeatureActionKeys.action, "Action", .hidden, default: def.id)]
                               + def.params.filter { !FeatureActionKeys.reserved.contains($0.key) },
                           outputVar: def.outputVar)
    }

    public var featureSpecs: [WorkflowActionSpec] { order.compactMap { entries[$0]?.spec } }
    /// Built-ins followed by every registered feature action (the editor's library).
    public var allSpecs: [WorkflowActionSpec] { WorkflowSpecs.builtins + featureSpecs }
    public func has(feature: String, action: String) -> Bool { entries[Self.key(feature, action)] != nil }

    public struct Run: Sendable {
        public var result: String?
        public var vars: [String: String]
        public var outputVar: String?
    }

    /// Run `{feature, action, …params}` (already substituted).
    public func run(params: [String: String], vars: [String: String]) async throws -> Run {
        let feature = params[FeatureActionKeys.feature] ?? ""
        let action = params[FeatureActionKeys.action] ?? ""
        guard let e = entries[Self.key(feature, action)] else {
            throw WorkflowStepError(!feature.isEmpty && !action.isEmpty
                ? "Action “\(feature).\(action)” is not available (is the \(feature) feature installed?)"
                : "Feature action is missing its feature/action")
        }
        var rest: [String: String] = [:]
        for (k, v) in params where !FeatureActionKeys.reserved.contains(k) { rest[k] = v }
        // Fill defaults for params the stored action predates.
        for p in e.spec.params where !FeatureActionKeys.reserved.contains(p.key) && rest[p.key] == nil {
            if let d = p.defaultValue { rest[p.key] = WorkflowTemplate.substitute(d, vars) }
        }
        let out = try await e.def.run(rest, vars)
        return Run(result: out.result, vars: out.vars, outputVar: e.spec.outputVar)
    }
}
