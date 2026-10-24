import Foundation

/// Events other features post so phone-notify can tell the phone (docs/PHONE.md, D). Posted on the main thread
/// with `NotificationCenter.default`; `userInfo` carries plain strings only, never clipboard text, file contents
/// or error messages. Posting is a no-op when nothing observes, so features stay independent of the phone feature.
public enum GlideFeatureEvents {
    /// Timers: a countdown finished. userInfo: "label" (the timer's name or duration).
    public static let timerFinished = Notification.Name("glide.timers.finished")
    /// Automations: an automatic (not Run Now) run failed. userInfo: "name".
    public static let automationFailed = Notification.Name("glide.automations.failed")
    /// Glide Agent: a run waits for the user to approve steps. userInfo: "runId", "confirmationId".
    public static let agentConfirmation = Notification.Name("glide.agent.confirmation")
    /// MCP server: a client's call waits for Allow / Deny. userInfo: "id", "client", "tool" (tool title).
    public static let mcpConfirmation = Notification.Name("glide.mcp-server.confirmation")

    /// Post on the main thread (callers are @MainActor features).
    @MainActor public static func post(_ name: Notification.Name, _ info: [String: String]) {
        NotificationCenter.default.post(name: name, object: nil, userInfo: info)
    }
}
