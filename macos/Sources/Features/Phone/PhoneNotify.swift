import Foundation
import GlideCore
import SwiftUI

/// Notifications to the phone (ntfy), Glide Agent from the phone, approvals.
/// Keeps the `install` signature; everything lives in `PhoneNotifyHub`, one per phone feature.
@MainActor enum PhoneNotify {
    private static var hubs: [ObjectIdentifier: PhoneNotifyHub] = [:]

    static func install(_ feature: PhoneFeature) async {
        let key = ObjectIdentifier(feature)
        hubs[key]?.stop()
        let hub = PhoneNotifyHub(feature: feature)
        hubs[key] = hub
        hub.start()
        feature.onStop {
            hub.stop()
            if hubs[key] === hub { hubs[key] = nil }
        }
    }

    /// The hub of a started phone feature (Settings section, tests).
    static func hub(for feature: PhoneFeature) -> PhoneNotifyHub? { hubs[ObjectIdentifier(feature)] }
}

@MainActor final class PhoneNotifyHub {
    weak var feature: PhoneFeature?
    let notifier: PhoneNotifier
    let agent: PhoneAgentApprovals
    private var tokens: [NSObjectProtocol] = []
    private var stopped = false

    init(feature: PhoneFeature) {
        self.feature = feature
        let headless = feature.context?.services.isHeadless ?? true
        let env = ProcessInfo.processInfo.environment
        let store: any AISecretStore = headless
            ? MemorySecretStore(env["GLIDE_PHONE_NTFY_TEST_TOKEN"].flatMap { $0.isEmpty ? nil : $0 })
            : PhoneNotifyKeychainToken()
        notifier = PhoneNotifier(
            settings: { [weak feature] in PhoneNotifySettings(json: feature?.context?.settings(defaults: [:])["notify"]) },
            saveSettings: { [weak feature] s in feature?.context?.setSettings(["notify": s.json]) },
            tokens: store)
        agent = PhoneAgentApprovals { [weak feature] method, args in
            guard let ctx = feature?.context else { throw PhoneError("failed", "Glide is shutting down.") }
            return try await ctx.callFeature("agent", method: method, args: args)
        }
        notifier.log = { [weak feature] in feature?.context?.log($0) }
        agent.offerMacRuns = { [weak feature] in feature?.isGroupEnabled("agent") ?? false }
    }

    func start() {
        guard let feature else { return }
        registerActions(feature)
        // Test channel: `invoke phone notify.<method>`; Settings → iPhone → Notifications.
        for m in ["state", "setSettings", "regenerateTopic", "setToken", "test", "pending"] {
            feature.addMethod("notify.\(m)") { [weak self] args in
                guard let self else { throw PhoneError("failed", "Glide is shutting down.") }
                return try await self.invoke(m, args: args)
            }
        }
        feature.addSettingsSection(id: "notify", order: 50) { [weak feature] in
            guard let feature else { return AnyView(EmptyView()) }
            return AnyView(PhoneNotifySettingsSection(feature: feature))
        }

        agent.onAdded = { [weak self] item in
            guard let self else { return }
            self.notifier.post(PhoneNotifyMessages.confirmation(.agent(tools: item.tools), id: item.id, lanBaseURL: self.feature?.lanBaseURL))
        }
        feature.confirmations.addObserver { [weak self] req in
            guard let self, !self.stopped else { return }
            self.notifier.post(PhoneNotifyMessages.confirmation(.phone(device: req.deviceName, action: req.title), id: req.id, lanBaseURL: self.feature?.lanBaseURL))
        }

        let nc = NotificationCenter.default
        tokens.append(nc.addObserver(forName: GlideFeatureEvents.timerFinished, object: nil, queue: .main) { [weak self] n in
            let label = n.userInfo?["label"] as? String ?? ""
            MainActor.assumeIsolated { _ = self?.notifier.post(PhoneNotifyMessages.timerFinished(label: label)) }
        })
        tokens.append(nc.addObserver(forName: GlideFeatureEvents.automationFailed, object: nil, queue: .main) { [weak self] n in
            let name = n.userInfo?["name"] as? String ?? ""
            MainActor.assumeIsolated { _ = self?.notifier.post(PhoneNotifyMessages.automationFailed(name: name)) }
        })
        tokens.append(nc.addObserver(forName: GlideFeatureEvents.agentConfirmation, object: nil, queue: .main) { [weak self] n in
            let runId = n.userInfo?["runId"] as? String ?? ""
            let cid = n.userInfo?["confirmationId"] as? String ?? ""
            MainActor.assumeIsolated {
                guard let self, !runId.isEmpty, !cid.isEmpty else { return }
                Task { @MainActor in await self.agent.confirmationWaiting(runId: runId, confirmationId: cid) }
            }
        })
        tokens.append(nc.addObserver(forName: GlideFeatureEvents.mcpConfirmation, object: nil, queue: .main) { [weak self] n in
            let client = n.userInfo?["client"] as? String ?? "An MCP client"
            let tool = n.userInfo?["tool"] as? String ?? "a tool"
            MainActor.assumeIsolated { _ = self?.notifier.post(PhoneNotifyMessages.confirmation(.mcp(client: client, tool: tool), id: nil, lanBaseURL: nil)) }
        })
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        for t in tokens { NotificationCenter.default.removeObserver(t) }
        tokens.removeAll()
        agent.stop()
    }

    // MARK: actions (docs/PHONE.md "Actions")

    private func registerActions(_ feature: PhoneFeature) {
        feature.registry.register(PhoneAction("agent.ask", "Ask Glide Agent", group: "agent", risk: .confirm, relay: true) { [weak self] args, caller in
            guard let self else { throw PhoneError("failed", "Glide is shutting down.") }
            return try await self.agent.ask(args, caller: caller)
        })
        feature.registry.register(PhoneAction("approvals.list", "List requests waiting for approval", group: "core", relay: false) { [weak self] _, _ in
            ["pending": .array(self?.pendingJSON ?? [])]
        })
        feature.registry.register(PhoneAction("approvals.respond", "Approve or deny a request", group: "core", relay: false) { [weak self] args, _ in
            guard let self else { throw PhoneError("failed", "Glide is shutting down.") }
            return try await self.respond(args)
        })
        feature.registry.register(PhoneAction("notify.test", "Send a test notification", group: "notify", relay: true) { [weak self] _, _ in
            guard let self else { throw PhoneError("failed", "Glide is shutting down.") }
            return try await self.sendTest()
        })
    }

    /// Phone confirmations (phone-core) and Glide Agent confirmations, newest first.
    var pendingJSON: [JSONValue] {
        var all: [(Date, JSONValue)] = (feature?.confirmations.pending ?? []).map { r in
            (r.at, ["id": .string(r.id), "source": "phone", "deviceName": .string(r.deviceName), "action": .string(r.action), "title": .string(r.title),
                    "summary": .string(r.summary), "at": .int(Int64(r.at.timeIntervalSince1970 * 1000))])
        }
        all += agent.pending.map { ($0.at, $0.json) }
        return all.sorted { $0.0 > $1.0 }.map(\.1)
    }

    func respond(_ args: JSONValue) async throws -> JSONValue {
        guard let id = args["id"]?.stringValue, !id.isEmpty else { throw PhoneError.badArgs("Say which request to answer.") }
        let decision = args["decision"]?.stringValue ?? ""
        guard ["allow", "always", "deny"].contains(decision) else { throw PhoneError.badArgs("Answer with allow, always or deny.") }
        if agent.has(id) { return try await agent.respond(id, decision: decision) }
        guard let feature, feature.confirmations.respond(id, decision: decision) else {
            throw PhoneError("not-found", "That request was already answered or has expired.")
        }
        return ["ok": true, "decision": .string(decision)]
    }

    func sendTest() async throws -> JSONValue {
        let outcome = await notifier.post(PhoneNotifyMessages.test()).value
        guard outcome == .sent else { throw PhoneError(outcome == .off || outcome == .notSetUp ? "off" : "failed", PhoneNotifier.describe(outcome)) }
        return ["sent": true]
    }

    // MARK: settings / test channel

    var stateJSON: JSONValue {
        let s = notifier.settings()
        return ["settings": s.json, "hasToken": .bool(notifier.hasToken), "history": notifier.historyJSON,
                "subscribeURL": .string(s.topic.isEmpty ? "" : PhoneNotifyRules.subscribeURL(server: s.server, topic: s.topic)),
                "pending": .array(pendingJSON)]
    }

    func invoke(_ method: String, args: JSONValue) async throws -> JSONValue {
        switch method {
        case "state": return stateJSON
        case "setSettings":
            _ = try notifier.update(args)
            return stateJSON
        case "regenerateTopic":
            _ = notifier.regenerateTopic()
            return stateJSON
        case "setToken":
            try notifier.setToken(args["token"]?.stringValue)
            return stateJSON
        case "test":
            let outcome = await notifier.post(PhoneNotifyMessages.test()).value
            return ["outcome": .string(outcome == .sent ? "sent" : "failed"), "message": .string(PhoneNotifier.describe(outcome))]
        case "pending": return .array(pendingJSON)
        default: throw FeatureError.unknownMethod(feature: "phone", method: "notify.\(method)")
        }
    }
}
