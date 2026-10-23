import Foundation
import GlideCore
import Observation

/// What a conversation needs from the feature: a client (or the reason there is none) and the defaults.
@MainActor protocol AIClientProvider: AnyObject {
    func makeClient() throws -> AnthropicClient
    var currentModel: String { get }
    var currentEffort: String { get }
}

/// A streaming conversation (Quick AI and the chat window). Main-actor state, observed by SwiftUI.
@MainActor @Observable final class AIConversation {
    var messages: [AIChatMessage]
    private(set) var streaming = false
    private(set) var error: AIError?
    /// Model override (AI Command model, chat model picker); nil = the settings default.
    var model: String?
    private(set) var lastModel: String?
    private(set) var cancelled = false
    @ObservationIgnored weak var provider: AIClientProvider?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored var system: String?
    /// Called on the main actor after each answer (finished, failed or stopped).
    @ObservationIgnored var onFinish: ((AIConversation) -> Void)?

    init(provider: AIClientProvider?, messages: [AIChatMessage] = [], model: String? = nil) {
        self.provider = provider
        self.messages = messages
        self.model = model
    }

    var effectiveModel: String { model.flatMap { AIModels.isKnown($0) ? $0 : nil } ?? provider?.currentModel ?? AIModels.defaultModel }

    /// The latest non-empty assistant answer.
    var lastAnswer: String? { messages.last { $0.role == "assistant" && !$0.content.isEmpty }?.content }

    /// Replace the history with `history` (ending in a user turn) and stream the answer.
    func send(_ history: [AIChatMessage]) {
        task?.cancel()
        error = nil
        cancelled = false
        let apiMessages: [AIAPIMessage]
        let client: AnthropicClient
        do {
            apiMessages = try AIRequestBuilder.apiMessages(history)
            guard let provider else { throw AIError(.other, "AI is not available") }
            client = try provider.makeClient()
        } catch {
            messages = history
            self.error = AIError.from(error)
            onFinish?(self)
            return
        }
        let model = effectiveModel
        let request = AIRequest(model: model, effort: provider?.currentEffort ?? "medium", messages: apiMessages, system: system)
        messages = history + [AIChatMessage(role: "assistant", content: "", at: AIChats.nowMs(), model: model)]
        streaming = true
        let index = messages.count - 1
        task = Task { @MainActor [weak self] in
            do {
                for try await event in client.stream(request) {
                    guard let self, index < self.messages.count else { return }
                    switch event {
                    case let .textDelta(t): self.messages[index].content += t
                    case let .started(m): self.messages[index].model = m
                    case let .finished(out):
                        self.messages[index].model = out.model
                        self.lastModel = out.model
                    default: break
                    }
                }
            } catch is CancellationError {
                self?.cancelled = true
            } catch {
                guard let self else { return }
                if Task.isCancelled { self.cancelled = true } else {
                    self.error = AIError.from(error)
                    if index < self.messages.count, self.messages[index].content.isEmpty { self.messages.remove(at: index) }
                }
            }
            guard let self else { return }
            if self.cancelled, index < self.messages.count, self.messages[index].content.isEmpty { self.messages.remove(at: index) }
            self.streaming = false
            self.onFinish?(self)
        }
    }

    /// Ask a follow-up (appends a user turn).
    func ask(_ text: String) {
        let history = messages.filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } + [AIChatMessage(role: "user", content: text, at: AIChats.nowMs())]
        send(history)
    }

    /// Re-run from the last user turn.
    func regenerate() {
        guard let lastUser = messages.lastIndex(where: { $0.role == "user" }) else { return }
        send(Array(messages[...lastUser]))
    }

    func stop() {
        guard streaming else { return }
        cancelled = true
        task?.cancel()
    }

    func wait() async { await task?.value }
}
