import Foundation
import GlideCore

/// The agent's manual tool-use loop (loop.ts): stream a turn, run the requested tools (asking the user first
/// for any state-changing call that isn't allowed without asking), send the results back, repeat. Multi-step
/// turns get a plan entry, undoable steps record an undo, and the run ends with a summary entry.
/// Pure apart from the injected client/capabilities, so it is unit-tested with scripted turns.
@MainActor struct AgentLoop {
    static let maxToolCalls = 12
    static let maxTurns = 16
    static let declinedResult = "The user declined this action, so it was not run. Do not retry it; tell the user it was skipped."
    static let readOnlyResult = "Read-only mode is on, so Glide Agent can only look things up. Tell the user to turn off Read-only mode in Settings → Agent to make changes."

    var runId: String
    var conversationId: String?
    var prompt: String
    var history: [JSONValue] = []
    var client: any AIModelClient
    var tools: [AgentTool]
    var caps: any AgentCapabilities
    var model: String
    var effort = "medium"
    var system = AgentPrompt.system
    var context = ""
    var maxToolCalls = AgentLoop.maxToolCalls
    /// Warning notices shown before the first turn (e.g. an MCP server that couldn't connect).
    var notices: [String] = []
    var readOnly = false
    var isAllowed: @MainActor (String) -> Bool = { _ in false }
    /// Destructive tools: why the call is refused by the rate limit, or nil (and counts it).
    var takeRateLimit: (@MainActor (String) -> String?)?
    /// Ask the user to approve these steps; false on cancel.
    var confirm: @MainActor (AgentConfirmation, AgentRunSnapshot) async -> Bool = { _, _ in false }
    var onChange: @MainActor (AgentRunSnapshot) -> Void = { _ in }
    var now: @MainActor () -> Double = { agentNowMs() }

    struct Output {
        var snapshot: AgentRunSnapshot
        var messages: [JSONValue]
        var undos: [String: AgentUndo]
        var executed: [AgentExecutedStep]
    }

    private struct LoopError: Error { var message: String; var kind: String }

    private final class Call {
        let use: JSONValue
        let tool: AgentTool?
        var stepId: String
        var prepared: AgentPreparedCall?
        var result: (text: String, isError: Bool)?
        init(use: JSONValue, tool: AgentTool?, stepId: String) {
            self.use = use
            self.tool = tool
            self.stepId = stepId
        }
        var name: String { use["name"]?.stringValue ?? "" }
    }

    func run() async -> Output {
        var seq = 0
        func nextId(_ p: String) -> String { seq += 1; return "\(runId)-\(p)\(seq)" }
        var snap = AgentRunSnapshot(runId: runId, conversationId: conversationId, prompt: prompt, status: .running,
                                    entries: [], toolCalls: 0, maxToolCalls: maxToolCalls, model: model,
                                    readOnly: readOnly ? true : nil, startedAt: now())
        snap.entries.append(.prompt(id: nextId("e"), text: prompt))
        for n in notices { snap.entries.append(.notice(id: nextId("e"), text: n, tone: "warning")) }

        let offered = readOnly ? tools.filter { !$0.mutating } : tools
        let toolDefs: [JSONValue] = offered.map { ["name": .string($0.name), "description": .string($0.description), "input_schema": $0.schema] }
        var messages = AgentHistory.appendPrompt(AgentHistory.repairTail(AgentHistory.trim(history)), prompt)
        var undos: [String: AgentUndo] = [:]
        var executed: [AgentExecutedStep] = []
        var planIndex: Int?
        var capped = false

        func stepOf(_ id: String) -> AgentStep? { snap.steps.first { $0.id == id } }
        func linkToPlan(_ stepId: String) {
            guard let pi = planIndex, case .plan(let pid, let title, var items) = snap.entries[pi], let i = items.firstIndex(where: { $0.stepId == nil }) else { return }
            items[i].stepId = stepId
            snap.entries[pi] = .plan(id: pid, title: title, items: items)
        }

        do {
            var turn = 0
            while true {
                try Task.checkCancellation()
                if turn >= Self.maxTurns { throw LoopError(message: "Stopped after \(Self.maxTurns) model turns.", kind: "limit") }
                turn += 1
                var textIndex: Int?
                let req = AgentTurnRequest(model: model, effort: effort, system: system, context: context, tools: toolDefs, messages: messages)
                let res = try await client.turn(req) { delta in
                    if let i = textIndex, case .text(let id, let t) = snap.entries[i] {
                        snap.entries[i] = .text(id: id, text: t + delta)
                    } else {
                        textIndex = snap.entries.count
                        snap.entries.append(.text(id: nextId("e"), text: delta))
                    }
                    onChange(snap)
                }
                try Task.checkCancellation()
                if !res.model.isEmpty { snap.model = res.model }
                if textIndex == nil {
                    let text = res.content.compactMap { $0["type"]?.stringValue == "text" ? $0["text"]?.stringValue : nil }.joined(separator: "\n\n")
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { snap.entries.append(.text(id: nextId("e"), text: text)) }
                }
                // The full content (thinking included) is replayed unchanged next turn.
                messages.append(["role": "assistant", "content": .array(res.content)])

                if res.stopReason == "refusal" { throw LoopError(message: "Claude declined this request.", kind: "refusal") }
                let uses = res.content.filter { $0["type"]?.stringValue == "tool_use" }
                if res.stopReason == "max_tokens" && !uses.isEmpty {
                    throw LoopError(message: "The response was cut off before the tool call finished. Try a shorter request.", kind: "other")
                }
                if res.stopReason == "pause_turn" { continue }
                if res.stopReason != "tool_use" || uses.isEmpty { break }
                if capped {
                    snap.entries.append(.notice(id: nextId("e"), text: "Stopped: reached the limit of \(maxToolCalls) tool calls for one request.", tone: "warning"))
                    break
                }

                var calls: [Call] = []
                let turnStart = snap.entries.count

                // The plan pseudo-tool: shown as the plan, never a step.
                for use in uses where use["name"]?.stringValue == AgentTools.planTool {
                    let tool = tools.first { $0.name == AgentTools.planTool }
                    let call = Call(use: use, tool: tool, stepId: "")
                    calls.append(call)
                    let items = (use["input"]?["steps"]?.arrayValue ?? []).compactMap(\.stringValue)
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.prefix(8).map { AgentPlanItem(text: $0) }
                    guard let tool, case .ready(let p) = tool.prepare(use["input"] ?? .null, caps), !items.isEmpty else {
                        call.result = ("Invalid plan: give steps as an array of short strings.", true)
                        continue
                    }
                    planIndex = snap.entries.count
                    snap.entries.append(.plan(id: nextId("e"), title: "I'll do \(AgentText.plural(items.count, "thing")):", items: Array(items)))
                    call.result = ((try? await p.run().text) ?? "", false)
                }

                // Prepare every other call of this turn.
                for use in uses where use["name"]?.stringValue != AgentTools.planTool {
                    let name = use["name"]?.stringValue ?? ""
                    let tool = tools.first { $0.name == name }
                    var step = AgentStep(id: nextId("s"), tool: name, title: tool?.title ?? name, args: use["input"]?.objectValue ?? [:],
                                         summary: tool?.title ?? name, mutating: tool?.mutating ?? false, status: .queued)
                    if let t = tool, t.sensitiveResult || !t.sensitiveArgs.isEmpty { step.sensitive = true }
                    let call = Call(use: use, tool: tool, stepId: step.id)
                    calls.append(call)
                    snap.entries.append(.step(id: step.id, step: step))
                    linkToPlan(step.id)
                    if snap.toolCalls >= maxToolCalls {
                        capped = true
                        let text = "Not run: the limit of \(maxToolCalls) tool calls for this request was reached."
                        call.result = (text, true)
                        snap.updateStep(step.id) { $0.status = .skipped; $0.result = text }
                        continue
                    }
                    snap.toolCalls += 1
                    if let tool {
                        if readOnly && tool.mutating {
                            call.result = (Self.readOnlyResult, true)
                        } else {
                            switch tool.prepare(use["input"] ?? .null, caps) {
                            case let .invalid(msg): call.result = ("Invalid input: \(msg)", true)
                            case let .ready(p):
                                call.prepared = p
                                let summary = await p.describe()
                                snap.updateStep(step.id) { $0.summary = summary }
                            }
                        }
                    } else {
                        call.result = ("Unknown tool \(name)", true)
                    }
                    if let r = call.result { snap.updateStep(step.id) { $0.status = .error; $0.result = r.text } }
                }

                // Several actions in one turn and no plan yet: the turn's steps are the plan.
                let real = calls.filter { $0.name != AgentTools.planTool && $0.prepared != nil }
                if planIndex == nil && real.count >= 2 {
                    let items = real.map { AgentPlanItem(text: stepOf($0.stepId)?.summary ?? $0.name, stepId: $0.stepId) }
                    snap.entries.insert(.plan(id: nextId("e"), title: "I'll do \(AgentText.plural(real.count, "thing")):", items: items), at: turnStart)
                    planIndex = turnStart
                }
                onChange(snap)

                // One confirmation for every state-changing call of this turn that isn't pre-approved.
                func confirmable(_ c: Call) -> Bool { c.prepared != nil && ((c.tool?.mutating ?? false) || (c.tool?.askFirst ?? false)) }
                let ask = calls.filter { confirmable($0) && (($0.tool?.alwaysConfirm ?? false) || !isAllowed($0.name)) }
                for c in calls where confirmable(c) && !ask.contains(where: { $0 === c }) { snap.updateStep(c.stepId) { $0.autoApproved = true } }
                if !ask.isEmpty {
                    let confirmation = AgentConfirmation(id: nextId("c"), stepIds: ask.map(\.stepId))
                    for c in ask { snap.updateStep(c.stepId) { $0.status = .awaiting } }
                    snap.status = .confirming
                    snap.confirmation = confirmation
                    onChange(snap)
                    let approved = await confirm(confirmation, snap)
                    try Task.checkCancellation()
                    snap.status = .running
                    snap.confirmation = nil
                    if !approved {
                        for c in ask {
                            snap.updateStep(c.stepId) { $0.status = .declined; $0.result = "Cancelled by you" }
                            c.result = (Self.declinedResult, true)
                        }
                    }
                    onChange(snap)
                }

                // Run in order: later calls often depend on earlier ones (focus an app, then move its window).
                for c in calls where c.result == nil {
                    guard let p = c.prepared else { continue }
                    try Task.checkCancellation()
                    if c.tool?.destructive == true, let limited = takeRateLimit?(c.name) {
                        c.result = (limited, true)
                        snap.updateStep(c.stepId) { $0.status = .error; $0.result = limited }
                        onChange(snap)
                        continue
                    }
                    snap.updateStep(c.stepId) { $0.status = .running }
                    onChange(snap)
                    do {
                        let out = try await p.run()
                        let text = AgentText.clip(out.text)
                        c.result = (text, false)
                        snap.updateStep(c.stepId) { s in
                            s.status = .ok
                            s.result = text
                            if let u = out.undo { s.undo = AgentStepUndo(summary: u.summary, state: "available") }
                            if let wf = out.workflow, !wf.isEmpty { s.workflow = wf }
                        }
                        if let u = out.undo { undos[c.stepId] = u }
                        if let s = stepOf(c.stepId) { executed.append(AgentExecutedStep(step: s, workflow: out.workflow)) }
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        try Task.checkCancellation()
                        let text = (error as? AgentToolFailure)?.message ?? error.localizedDescription
                        c.result = (text, true)
                        snap.updateStep(c.stepId) { $0.status = .error; $0.result = text }
                    }
                    onChange(snap)
                }

                var content: [JSONValue] = calls.map { c in
                    var o: [String: JSONValue] = ["type": "tool_result", "tool_use_id": c.use["id"] ?? "", "content": .string(c.result?.text ?? "")]
                    if c.result?.isError == true { o["is_error"] = true }
                    return .object(o)
                }
                if capped {
                    content.append(["type": "text", "text": .string("You have used the limit of \(maxToolCalls) tool calls for this request. Do not call any more tools; briefly tell the user what was done and what is left.")])
                }
                messages.append(["role": "user", "content": .array(content)])
            }
            snap.status = .done
        } catch {
            if error is CancellationError || Task.isCancelled {
                snap.status = .cancelled
                snap.entries.append(.notice(id: nextId("e"), text: "Stopped.", tone: "info"))
            } else {
                let e: AgentRunError
                if let l = error as? LoopError { e = AgentRunError(message: l.message, kind: l.kind) }
                else if let c = error as? AgentClientError { e = AgentRunError(message: c.message, kind: c.kind) }
                else { e = AgentRunError(message: error.localizedDescription, kind: "other") }
                snap.error = e
                snap.status = .error
                snap.entries.append(.notice(id: nextId("e"), text: e.message, tone: "error"))
            }
            for s in snap.steps where [.queued, .awaiting, .running].contains(s.status) { snap.updateStep(s.id) { $0.status = .skipped } }
            snap.confirmation = nil
        }
        if let summary = Self.summarize(snap, executed) { snap.entries.append(summary(nextId("e"))) }
        snap.endedAt = now()
        onChange(snap)
        // `executed` holds copies taken when each step finished; hand out the final versions.
        let finals = executed.map { e in AgentExecutedStep(step: snap.steps.first { $0.id == e.step.id } ?? e.step, workflow: e.workflow) }
        return Output(snapshot: snap, messages: AgentHistory.repairTail(messages), undos: undos, executed: finals)
    }

    /// The closing line: what happened, what can be undone, whether it can become a workflow.
    static func summarize(_ snap: AgentRunSnapshot, _ executed: [AgentExecutedStep]) -> ((String) -> AgentEntry)? {
        let steps = snap.steps
        if steps.isEmpty { return nil }
        let changed = steps.filter { $0.status == .ok && $0.mutating }.count
        let looked = steps.filter { $0.status == .ok && !$0.mutating }.count
        let failed = steps.filter { $0.status == .error }.count
        let declined = steps.filter { $0.status == .declined }.count
        let skipped = steps.filter { $0.status == .skipped }.count
        let undoable = steps.filter { $0.undo?.state == "available" }.count
        let bits = [changed > 0 ? "\(AgentText.plural(changed, "action")) done" : "", looked > 0 ? AgentText.plural(looked, "lookup") : "",
                    failed > 0 ? "\(failed) failed" : "", declined > 0 ? "\(declined) declined" : "", skipped > 0 ? "\(skipped) skipped" : ""].filter { !$0.isEmpty }
        let saveable = AgentWorkflowPlanner.plan(executed).isOK
        let head = snap.status == .done ? "Finished" : snap.status == .cancelled ? "Stopped" : "Failed"
        let text = "\(head): \(bits.isEmpty ? "nothing ran" : bits.joined(separator: " · "))"
        return { id in .summary(id: id, text: text, undoable: undoable, saveable: saveable) }
    }
}
