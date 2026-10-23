import Foundation
import GlideCore

/// The agent's hooks into other phase-1 features: the AI feature's client (N4) and the workflow runtime's
/// feature-action registry (the "Run Glide Command" action used by Save as Workflow).
@MainActor enum AgentIntegrations {
    static func liveClient() throws -> any AIModelClient {
        guard let provider = AgentAIBridge.provider else {
            throw AgentClientError(message: "Glide AI isn't set up yet. Add your Anthropic API key in Settings → AI to use Glide Agent.", kind: "no-key")
        }
        do { return AgentAnthropicClient(client: try provider.makeClient()) } catch let e as AIError {
            throw AgentClientError(message: e.kind == .noKey ? "Add your Anthropic API key in Settings → AI to use Glide Agent." : e.message, kind: e.kind.rawValue)
        }
    }

    static func registerWorkflowActions(_ agent: AgentFeature) {
        WorkflowActionRegistry.shared.register(feature: "agent", FeatureWorkflowAction(
            id: AgentWorkflow.runItemAction, title: "Run Glide Command",
            description: "Run a launcher item by id (window layouts, built-in commands, extensions) as if chosen in the launcher",
            emoji: "🪄", symbol: "wand.and.stars", category: .system,
            params: [WorkflowParamSpec("item", "Item id", .text, placeholder: "windows.left-half", required: true),
                     WorkflowParamSpec("argument", "Argument", .text, placeholder: "{{input}}")]
        ) { [weak agent] params, _ in
            guard let agent else { throw WorkflowStepError("Glide Agent is not running") }
            do {
                _ = try await agent.invoke(method: "runItem", args: ["item": .string(params["item"] ?? ""), "argument": .string(params["argument"] ?? "")])
            } catch { throw WorkflowStepError(error.localizedDescription) }
            return FeatureActionOutput()
        })
    }
}
