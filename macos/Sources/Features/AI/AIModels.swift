import Foundation

/// Models offered in Glide AI — identical ids to src/main/features/ai/models.ts (exact ids, no date suffix).
public struct AIModelInfo: Hashable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let description: String
}

public enum AIModels {
    public static let defaultModel = "claude-opus-5-5"

    public static let all: [AIModelInfo] = [
        AIModelInfo(id: "claude-opus-5-5", label: "Claude Opus 5.5", description: "Default — the current Opus"),
        AIModelInfo(id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", description: "Faster and cheaper"),
        AIModelInfo(id: "claude-haiku-4-5", label: "Claude Haiku 4.5", description: "Fastest, lowest cost"),
        AIModelInfo(id: "claude-fable-5-1", label: "Claude Fable 5.1", description: "Most capable — slower, premium price"),
    ]

    public static func isKnown(_ id: String?) -> Bool { all.contains { $0.id == id } }
    public static func label(_ id: String?) -> String { all.first { $0.id == id }?.label ?? id ?? "Claude" }

    /// Models that take `output_config.effort` (Haiku 4.5 rejects it).
    public static func supportsEffort(_ model: String) -> Bool { model != "claude-haiku-4-5" }

    /// Models for which server-side refusal fallbacks (`fallbacks: "default"`) are enabled.
    public static func supportsDefaultFallback(_ model: String) -> Bool {
        ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"].contains(model)
    }

    public static let efforts = ["low", "medium", "high"]
}
