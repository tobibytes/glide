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

/// Which API Glide AI talks to. Each provider keeps its own Keychain item and model setting.
public enum AIProvider: String, Sendable, CaseIterable, Identifiable {
    case anthropic, openai
    public var id: String { rawValue }
    public var label: String { self == .anthropic ? "Anthropic" : "OpenAI" }
    public var keychainAccount: String { self == .anthropic ? "anthropic-api-key" : "openai-api-key" }
    public var keyPlaceholder: String { self == .anthropic ? "sk-ant-…" : "sk-…" }
    public var keyURL: String { self == .anthropic ? "https://console.anthropic.com/settings/keys" : "https://platform.openai.com/api-keys" }

    /// Best guess from a pasted key: Anthropic keys start with "sk-ant-"; other "sk-" keys are OpenAI's.
    public static func detect(key: String) -> AIProvider? {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if k.hasPrefix("sk-ant-") { return .anthropic }
        if k.hasPrefix("sk-") { return .openai }
        return nil
    }
}

/// OpenAI (and OpenAI-compatible servers: OpenRouter, Ollama, LM Studio …). Any model id is accepted; these are
/// suggestions for the picker.
public enum OpenAIModels {
    public static let defaultModel = "gpt-5"
    public static let suggested: [AIModelInfo] = [
        AIModelInfo(id: "gpt-5", label: "GPT-5", description: "Default"),
        AIModelInfo(id: "gpt-5-mini", label: "GPT-5 mini", description: "Faster and cheaper"),
        AIModelInfo(id: "gpt-5-nano", label: "GPT-5 nano", description: "Fastest, lowest cost"),
        AIModelInfo(id: "gpt-4.1", label: "GPT-4.1", description: "Non-reasoning"),
    ]

    /// A plausible model id (OpenRouter ids contain "/", Ollama ids ":").
    public static func isValid(_ id: String?) -> Bool {
        guard let id, !id.isEmpty, id.count <= 128 else { return false }
        if id.hasPrefix("claude-") { return false }
        return id.allSatisfy { $0.isLetter || $0.isNumber || "-._:/@".contains($0) }
    }

    public static func label(_ id: String) -> String { suggested.first { $0.id == id }?.label ?? id }

    /// Reasoning models take `reasoning_effort`; older chat models reject it.
    public static func supportsEffort(_ model: String) -> Bool {
        let m = model.split(separator: "/").last.map(String.init) ?? model
        return m.hasPrefix("gpt-5") || m.hasPrefix("o1") || m.hasPrefix("o3") || m.hasPrefix("o4")
    }
}
