import Foundation
import GlideCore

/// Glide Agent from the phone (docs/PHONE.md, G) and the agent's confirmations as phone approvals.
///
/// `agent.ask {prompt}` starts a normal Glide Agent run in its own conversation, with every state-changing step
/// confirmed (the user's "always allow" list does not apply to phone runs). Read-only tools run at once; the agent's
/// own limits (tool-call cap, read-only mode, rate limit) apply unchanged. The call returns when the run finishes
/// or stops at a confirmation; the confirmation then shows up in `approvals.list` (and as a notification) and is
/// answered with `approvals.respond`, which returns the run's next state the same way.
///
/// Confirmations of runs started on the Mac are offered too while the Glide Agent group is on.
/// Talks to the agent only through its `invoke` methods (start, getRun, respond).
@MainActor final class PhoneAgentApprovals {
    struct Item: Equatable, Sendable {
        var id: String
        var runId: String
        var confirmationId: String
        /// "iPhone" for phone runs (the device name), "Mac" otherwise.
        var deviceName: String
        var title: String
        var summary: String
        /// Tool titles of the steps that wait (what notifications show).
        var tools: [String]
        var at: Date
        var fromPhone: Bool

        var json: JSONValue {
            ["id": .string(id), "source": "agent", "deviceName": .string(deviceName), "action": "agent.confirm", "title": .string(title),
             "summary": .string(summary), "steps": .array(tools.map(JSONValue.string)), "runId": .string(runId),
             "at": .int(Int64(at.timeIntervalSince1970 * 1000))]
        }
    }

    /// `agent/<method>` (injectable for tests).
    var call: @MainActor (_ method: String, _ args: JSONValue) async throws -> JSONValue
    /// Whether runs started on the Mac are offered to the phone (the Glide Agent group switch).
    var offerMacRuns: @MainActor () -> Bool = { true }
    /// A new item waits (phone-notify sends the notification).
    var onAdded: @MainActor (Item) -> Void = { _ in }
    var onChange: @MainActor () -> Void = {}
    var pollInterval: Duration = .milliseconds(100)
    /// How long `agent.ask` / `approvals.respond` wait for the run to finish or reach a confirmation.
    var waitLimit: Duration = .seconds(90)
    /// The agent declines an unanswered confirmation after 300 s; items are dropped a bit later at the latest.
    var itemLifetime: Duration = .seconds(310)

    private(set) var items: [Item] = []
    /// Runs started from a phone: run id → device name.
    private var phoneRuns: [String: String] = [:]
    /// Conversations started from a phone (follow-ups may only continue these).
    private var phoneConversations: Set<String> = []
    private var watchers: [String: Task<Void, Never>] = [:]

    init(call: @escaping @MainActor (_ method: String, _ args: JSONValue) async throws -> JSONValue) {
        self.call = call
    }

    /// Newest first.
    var pending: [Item] { items.sorted { $0.at > $1.at } }

    func stop() {
        for w in watchers.values { w.cancel() }
        watchers.removeAll()
        items.removeAll()
    }

    // MARK: agent.ask

    func ask(_ args: JSONValue, caller: PhoneCaller) async throws -> JSONValue {
        // Check on a run this phone started earlier (after `running`): {runId}.
        if let runId = args["runId"]?.stringValue, args["prompt"] == nil {
            guard phoneRuns[runId] != nil else { throw PhoneError("not-found", "That Glide Agent request isn't available anymore. Ask again.") }
            return try await settle(runId: runId, after: nil)
        }
        let prompt = (args["prompt"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { throw PhoneError.badArgs("Type what you want Glide Agent to do.") }
        guard prompt.count <= 4000 else { throw PhoneError.badArgs("That request is too long. Keep it under 4,000 characters.") }
        var conversationId = "phone-\(PhoneAgentApprovals.randomID())"
        if let c = args["conversationId"]?.stringValue, !c.isEmpty {
            guard phoneConversations.contains(c) else { throw PhoneError("not-found", "That conversation isn't available from the phone. Start a new one.") }
            conversationId = c
        }
        let r = try await call("start", ["prompt": .string(prompt), "conversationId": .string(conversationId), "confirmAll": true])
        guard r["ok"]?.boolValue == true, let runId = r["runId"]?.stringValue else {
            throw PhoneError("failed", r["error"]?.stringValue ?? "Glide Agent couldn't start. Check Settings → AI on the Mac.")
        }
        phoneRuns[runId] = caller.deviceName
        phoneConversations.insert(r["conversationId"]?.stringValue ?? conversationId)
        return try await settle(runId: runId, after: nil)
    }

    // MARK: confirmations

    /// The agent's hook: a run waits for approval (phone runs and, when offered, Mac runs).
    func confirmationWaiting(runId: String, confirmationId: String) async {
        guard !items.contains(where: { $0.confirmationId == confirmationId && $0.runId == runId }) else { return }
        let fromPhone = phoneRuns[runId] != nil
        guard fromPhone || offerMacRuns() else { return }
        guard let snap = try? await call("getRun", ["runId": .string(runId)]), snap["status"]?.stringValue == "confirming",
              snap["confirmation"]?["id"]?.stringValue == confirmationId else { return }
        _ = add(snap, runId: runId)
    }

    @discardableResult private func add(_ snap: JSONValue, runId: String) -> Item? {
        guard let conf = snap["confirmation"], let cid = conf["id"]?.stringValue else { return nil }
        if let existing = items.first(where: { $0.confirmationId == cid && $0.runId == runId }) { return existing }
        let ids = Set((conf["stepIds"]?.arrayValue ?? []).compactMap(\.stringValue))
        let steps = (snap["entries"]?.arrayValue ?? []).compactMap { $0["kind"]?.stringValue == "step" ? $0["step"] : nil }
            .filter { ids.contains($0["id"]?.stringValue ?? "") }
        let tools = steps.map { $0["title"]?.stringValue ?? $0["tool"]?.stringValue ?? "Step" }
        // Sensitive steps (clipboard and the like) show their tool title, not their arguments.
        let summary = steps.map { s in
            s["sensitive"]?.boolValue == true ? (s["title"]?.stringValue ?? "Step") : PhoneNotifyMessage.clip(s["summary"]?.stringValue ?? s["title"]?.stringValue ?? "Step", 120)
        }.joined(separator: "\n")
        let fromPhone = phoneRuns[runId] != nil
        let item = Item(id: "agent-\(Self.randomID())", runId: runId, confirmationId: cid, deviceName: phoneRuns[runId] ?? "Mac",
                        title: steps.count == 1 ? "Glide Agent wants to make a change" : "Glide Agent wants to make \(steps.count) changes",
                        summary: summary, tools: tools, at: Date(), fromPhone: fromPhone)
        items.append(item)
        watch(item)
        onChange()
        onAdded(item)
        return item
    }

    /// Drops the item once the run no longer waits on that confirmation (answered on the Mac, cancelled, timed out).
    private func watch(_ item: Item) {
        let lifetime = itemLifetime
        watchers[item.id] = Task { @MainActor [weak self] in
            let end = ContinuousClock.now + lifetime
            while !Task.isCancelled, ContinuousClock.now < end {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self else { return }
                let snap = try? await self.call("getRun", ["runId": .string(item.runId)])
                if snap?["status"]?.stringValue != "confirming" || snap?["confirmation"]?["id"]?.stringValue != item.confirmationId { break }
            }
            self?.remove(item.id)
        }
    }

    private func remove(_ id: String) {
        guard items.contains(where: { $0.id == id }) else { return }
        items.removeAll { $0.id == id }
        watchers.removeValue(forKey: id)?.cancel()
        onChange()
    }

    func has(_ id: String) -> Bool { items.contains { $0.id == id } }

    /// `approvals.respond` for an agent item: "allow" / "always" run the steps once (the phone never adds tools to
    /// the agent's always-allow list), "deny" skips them. Returns the run's next state like `agent.ask`.
    func respond(_ id: String, decision: String) async throws -> JSONValue {
        guard let item = items.first(where: { $0.id == id }) else { throw PhoneError("not-found", "That request was already answered or has expired.") }
        let approve = decision == "allow" || decision == "always"
        remove(id)
        let ok = try await call("respond", ["runId": .string(item.runId), "confirmationId": .string(item.confirmationId), "approve": .bool(approve)])
        guard ok.boolValue == true else { throw PhoneError("not-found", "That request was already answered or has expired.") }
        var out = try await settle(runId: item.runId, after: item.confirmationId)
        if case var .object(o) = out {
            o["decision"] = .string(approve ? "allow" : "deny")
            out = .object(o)
        }
        return out
    }

    // MARK: waiting

    /// Waits until the run finishes or stops at a confirmation other than `after`, then describes it.
    private func settle(runId: String, after answered: String?) async throws -> JSONValue {
        let end = ContinuousClock.now + waitLimit
        var snap: JSONValue = .null
        while true {
            snap = (try? await call("getRun", ["runId": .string(runId)])) ?? .null
            let status = snap["status"]?.stringValue ?? ""
            if ["done", "error", "cancelled"].contains(status) { break }
            if status == "confirming", let cid = snap["confirmation"]?["id"]?.stringValue, cid != answered { break }
            if snap.isNull || ContinuousClock.now >= end || Task.isCancelled { break }
            try? await Task.sleep(for: pollInterval)
        }
        guard !snap.isNull else { throw PhoneError("failed", "Glide Agent lost track of that request. Ask again.") }
        return describe(snap, runId: runId)
    }

    func describe(_ snap: JSONValue, runId: String) -> JSONValue {
        let entries = snap["entries"]?.arrayValue ?? []
        var text = entries.compactMap { $0["kind"]?.stringValue == "text" ? $0["text"]?.stringValue : nil }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        let status = snap["status"]?.stringValue ?? "running"
        if let e = snap["error"]?["message"]?.stringValue, status == "error" { text = text.isEmpty ? e : "\(text)\n\n\(e)" }
        if text.isEmpty, let summary = entries.last(where: { $0["kind"]?.stringValue == "summary" })?["text"]?.stringValue { text = summary }
        var o: [String: JSONValue] = ["text": .string(text), "status": .string(status), "runId": .string(runId)]
        if let c = snap["conversationId"]?.stringValue { o["conversationId"] = .string(c) }
        if status == "confirming", let item = add(snap, runId: runId) { o["pending"] = .array([item.json]) }
        let steps = entries.compactMap { $0["kind"]?.stringValue == "step" ? $0["step"] : nil }
        o["steps"] = .array(steps.map { s in
            ["title": s["title"] ?? "", "status": s["status"] ?? "", "mutating": s["mutating"] ?? false]
        })
        return .object(o)
    }

    static func randomID() -> String {
        var g = SystemRandomNumberGenerator()
        return (0..<12).map { _ in String("abcdefghijklmnopqrstuvwxyz0123456789".randomElement(using: &g) ?? "x") }.joined()
    }
}
