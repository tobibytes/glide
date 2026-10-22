/**
 * The agent's tool-use loop: stream a turn, run the requested tools (asking the user first for
 * any state-changing call that isn't allowed without asking), send the results back, repeat.
 * Follow-ups continue the same message history. Multi-step turns get a plan entry, every step
 * that can be put back records an undo, and the run ends with a summary entry.
 * Pure apart from the injected client/capabilities, so it is unit-tested with scripted turns.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../ai/types";
import type { AgentClient, ContentBlock, MessageParam } from "./client";
import { appendPrompt, repairTail, trimHistory } from "./conversation";
import { clip, PLAN_TOOL, ToolFailure, type AgentCapabilities, type AgentTool, type PreparedCall, type ToolOutput, type Undo } from "./tools";
import type { AgentErrorKind, AgentStep, Confirmation, PlanItem, RunSnapshot, TranscriptEntry } from "./types";
import { planWorkflow, type ExecutedStep } from "./workflow";

export const MAX_TOOL_CALLS = 12;
const MAX_TURNS = 16;

export const DECLINED_RESULT = "The user declined this action, so it was not run. Do not retry it; tell the user it was skipped.";
export const READ_ONLY_RESULT = "Read-only mode is on, so Glide Agent can only look things up. Tell the user to turn off Read-only mode in Settings → Agent to make changes.";

export interface LoopOptions {
  runId: string;
  conversationId?: string;
  prompt: string;
  /** Messages of earlier requests in this conversation. */
  history?: MessageParam[];
  client: AgentClient;
  tools: AgentTool[];
  caps: AgentCapabilities;
  model: string;
  effort: Effort;
  system: string;
  context: string;
  signal: AbortSignal;
  maxToolCalls?: number;
  /** Shown as warning notices before the first turn (e.g. an MCP server that couldn't connect). */
  notices?: string[];
  /** Only read-only tools are offered; any other call is refused. */
  readOnly?: boolean;
  /** True when the user enabled "Allow without asking" for this tool. */
  isAllowed(tool: string): boolean;
  /** Destructive tools: returns why the call is refused by the rate limit, or null (and counts it). */
  takeRateLimit?(tool: string): string | null;
  /** Ask the user to approve these steps; resolves false on cancel. */
  confirm(c: Confirmation, snapshot: RunSnapshot): Promise<boolean>;
  onChange(snapshot: RunSnapshot): void;
  describeError(err: unknown): { message: string; kind: AgentErrorKind };
  isAbort(err: unknown): boolean;
  now?(): number;
}

export interface RunOutput {
  snapshot: RunSnapshot;
  /** The conversation's full message history after this run (valid to continue). */
  messages: MessageParam[];
  /** Step id → how to put it back. */
  undos: Map<string, Undo>;
  executed: ExecutedStep[];
}

class Aborted extends Error {}

export async function runAgent(opts: LoopOptions): Promise<RunSnapshot> {
  return (await runAgentFull(opts)).snapshot;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function runAgentFull(opts: LoopOptions): Promise<RunOutput> {
  const max = opts.maxToolCalls ?? MAX_TOOL_CALLS;
  const now = opts.now ?? Date.now;
  let seq = 0;
  const nextId = (p: string) => `${opts.runId}-${p}${++seq}`;
  const snap: RunSnapshot = {
    runId: opts.runId,
    ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    prompt: opts.prompt,
    status: "running",
    entries: [{ kind: "prompt", id: nextId("e"), text: opts.prompt }],
    toolCalls: 0,
    maxToolCalls: max,
    model: opts.model,
    ...(opts.readOnly ? { readOnly: true } : {}),
    startedAt: now(),
  };
  const emit = () => opts.onChange(JSON.parse(JSON.stringify(snap)) as RunSnapshot);
  const push = (e: TranscriptEntry) => {
    snap.entries.push(e);
    return e;
  };
  const notice = (text: string, tone: "info" | "error" | "warning") => push({ kind: "notice", id: nextId("e"), text, tone });
  const checkAbort = () => {
    if (opts.signal.aborted) throw new Aborted();
  };

  for (const n of opts.notices ?? []) notice(n, "warning");
  const offered = opts.readOnly ? opts.tools.filter((t) => !t.mutating) : opts.tools;
  let messages: MessageParam[] = appendPrompt(repairTail(trimHistory(opts.history ?? [])), opts.prompt);
  const undos = new Map<string, Undo>();
  const executed: ExecutedStep[] = [];
  let plan: Extract<TranscriptEntry, { kind: "plan" }> | null = null;
  let capped = false;

  const linkToPlan = (step: AgentStep) => {
    const item = plan?.items.find((i) => !i.stepId);
    if (item) item.stepId = step.id;
  };

  try {
    for (let turn = 0; ; turn++) {
      checkAbort();
      if (turn >= MAX_TURNS) throw Object.assign(new Error(`Stopped after ${MAX_TURNS} model turns.`), { agentKind: "limit" as const });
      let textEntry: Extract<TranscriptEntry, { kind: "text" }> | null = null;
      const res = await opts.client.turn(
        { model: opts.model, effort: opts.effort, system: opts.system, context: opts.context, tools: offered, messages },
        (delta) => {
          if (!textEntry) textEntry = push({ kind: "text", id: nextId("e"), text: "" }) as Extract<TranscriptEntry, { kind: "text" }>;
          textEntry.text += delta;
          emit();
        },
        opts.signal,
      );
      checkAbort();
      if (res.model) snap.model = res.model;
      // Clients that don't stream deltas still produce text blocks.
      if (!textEntry) {
        const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
        if (text.trim()) push({ kind: "text", id: nextId("e"), text });
      }
      // Append the full content (thinking blocks included) so the next turn replays it unchanged.
      messages = [...messages, { role: "assistant", content: res.content }];

      if (res.stopReason === "refusal") throw Object.assign(new Error("Claude declined this request."), { agentKind: "refusal" as const });
      const uses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (res.stopReason === "max_tokens" && uses.length) throw Object.assign(new Error("The response was cut off before the tool call finished. Try a shorter request."), { agentKind: "other" as const });
      if (res.stopReason === "pause_turn") continue;
      if (res.stopReason !== "tool_use" || !uses.length) break;
      if (capped) {
        notice(`Stopped: reached the limit of ${max} tool calls for one request.`, "warning");
        break;
      }

      interface Call {
        use: (typeof uses)[number];
        tool?: AgentTool;
        step: AgentStep;
        prepared?: PreparedCall;
        result?: { text: string; isError: boolean };
      }
      const calls: Call[] = [];
      const turnStart = snap.entries.length;

      // The plan pseudo-tool: shown as the plan, never a step.
      for (const use of uses.filter((u) => u.name === PLAN_TOOL)) {
        const tool = opts.tools.find((t) => t.name === PLAN_TOOL);
        const steps = (use.input as { steps?: unknown }).steps;
        const items: PlanItem[] = Array.isArray(steps) ? steps.filter((s): s is string => typeof s === "string" && !!s.trim()).slice(0, 8).map((text) => ({ text: text.trim() })) : [];
        const prepared = tool?.prepare(use.input, opts.caps);
        if (!tool || !prepared || "error" in prepared || !items.length) {
          calls.push({ use, step: dummyStep(use.name), result: { text: "Invalid plan: give steps as an array of short strings.", isError: true } });
          continue;
        }
        plan = { kind: "plan", id: nextId("e"), title: `I'll do ${plural(items.length, "thing")}:`, items };
        push(plan);
        calls.push({ use, step: dummyStep(use.name), result: { text: (await prepared.run()).text, isError: false } });
      }

      // Prepare every other call of this turn.
      for (const use of uses) {
        if (use.name === PLAN_TOOL) continue;
        const tool = opts.tools.find((t) => t.name === use.name);
        const step: AgentStep = {
          id: nextId("s"),
          tool: use.name,
          title: tool?.title ?? use.name,
          args: isRecord(use.input) ? use.input : {},
          summary: tool?.title ?? use.name,
          mutating: !!tool?.mutating,
          status: "queued",
          ...(tool?.sensitiveResult || tool?.sensitiveArgs?.length ? { sensitive: true } : {}),
        };
        const call: Call = { use, tool, step };
        calls.push(call);
        push({ kind: "step", id: step.id, step });
        linkToPlan(step);
        if (snap.toolCalls >= max) {
          capped = true;
          step.status = "skipped";
          call.result = { text: `Not run: the limit of ${max} tool calls for this request was reached.`, isError: true };
          step.result = call.result.text;
          continue;
        }
        snap.toolCalls++;
        if (!tool) {
          call.result = { text: `Unknown tool ${use.name}`, isError: true };
        } else if (opts.readOnly && tool.mutating) {
          call.result = { text: READ_ONLY_RESULT, isError: true };
        } else {
          const prepared = tool.prepare(use.input, opts.caps);
          if ("error" in prepared) call.result = { text: `Invalid input: ${prepared.error}`, isError: true };
          else {
            call.prepared = prepared;
            try {
              step.summary = await prepared.describe();
            } catch {
              /* keep the tool title */
            }
          }
        }
        if (call.result) {
          step.status = "error";
          step.result = call.result.text;
        }
      }

      // Several actions in one turn and no plan yet: the turn's steps are the plan.
      const real = calls.filter((c) => c.use.name !== PLAN_TOOL && c.prepared);
      if (!plan && real.length >= 2) {
        plan = { kind: "plan", id: nextId("e"), title: `I'll do ${plural(real.length, "thing")}:`, items: real.map((c) => ({ text: c.step.summary, stepId: c.step.id })) };
        snap.entries.splice(turnStart, 0, plan);
      }
      emit();

      // One confirmation for every state-changing call of this turn that isn't pre-approved.
      const confirmable = (c: Call) => !!c.prepared && (c.step.mutating || !!c.tool?.askFirst);
      const ask = calls.filter((c) => confirmable(c) && (c.tool?.alwaysConfirm || !opts.isAllowed(c.step.tool)));
      for (const c of calls) if (confirmable(c) && !ask.includes(c)) c.step.autoApproved = true;
      if (ask.length) {
        const confirmation: Confirmation = { id: nextId("c"), stepIds: ask.map((c) => c.step.id) };
        for (const c of ask) c.step.status = "awaiting";
        snap.status = "confirming";
        snap.confirmation = confirmation;
        emit();
        const approved = await opts.confirm(confirmation, JSON.parse(JSON.stringify(snap)) as RunSnapshot);
        checkAbort();
        snap.status = "running";
        delete snap.confirmation;
        if (!approved) {
          for (const c of ask) {
            c.step.status = "declined";
            c.step.result = "Cancelled by you";
            c.result = { text: DECLINED_RESULT, isError: true };
          }
        }
        emit();
      }

      // Run in order: later calls often depend on earlier ones (focus an app, then move its window).
      for (const c of calls) {
        if (c.result || !c.prepared) continue;
        checkAbort();
        const limited = c.tool?.destructive ? (opts.takeRateLimit?.(c.step.tool) ?? null) : null;
        if (limited) {
          c.result = { text: limited, isError: true };
          c.step.status = "error";
          c.step.result = limited;
          emit();
          continue;
        }
        c.step.status = "running";
        emit();
        try {
          const out: ToolOutput = await c.prepared.run();
          const text = clip(out.text);
          c.result = { text, isError: false };
          c.step.status = "ok";
          c.step.result = text;
          if (out.undo) {
            undos.set(c.step.id, out.undo);
            c.step.undo = { summary: out.undo.summary, state: "available" };
          }
          const wf = out.workflow ? (Array.isArray(out.workflow) ? out.workflow : [out.workflow]) : undefined;
          if (wf?.length) c.step.workflow = wf;
          executed.push({ step: c.step, workflow: wf });
        } catch (err) {
          checkAbort();
          const text = err instanceof ToolFailure || err instanceof Error ? err.message : String(err);
          c.result = { text, isError: true };
          c.step.status = "error";
          c.step.result = text;
        }
        emit();
      }

      const content: Anthropic.Beta.BetaContentBlockParam[] = calls.map((c) => ({
        type: "tool_result",
        tool_use_id: c.use.id,
        content: c.result?.text ?? "",
        ...(c.result?.isError ? { is_error: true } : {}),
      }));
      if (capped) content.push({ type: "text", text: `You have used the limit of ${max} tool calls for this request. Do not call any more tools; briefly tell the user what was done and what is left.` });
      messages = [...messages, { role: "user", content }];
    }
    snap.status = "done";
  } catch (err) {
    if (err instanceof Aborted || opts.signal.aborted || opts.isAbort(err)) {
      snap.status = "cancelled";
      notice("Stopped.", "info");
    } else {
      const kind = (err as { agentKind?: AgentErrorKind }).agentKind;
      snap.error = kind ? { message: (err as Error).message, kind } : opts.describeError(err);
      snap.status = "error";
      notice(snap.error.message, "error");
    }
    for (const e of snap.entries) if (e.kind === "step" && (e.step.status === "queued" || e.step.status === "awaiting" || e.step.status === "running")) e.step.status = "skipped";
    delete snap.confirmation;
  }
  const summary = summarize(snap, executed);
  if (summary) push(summary(nextId("e")));
  snap.endedAt = now();
  emit();
  for (const e of executed) {
    // `executed` holds live step objects; hand out the final copies.
    const fin = snap.entries.find((x) => x.kind === "step" && x.step.id === e.step.id);
    if (fin && fin.kind === "step") e.step = JSON.parse(JSON.stringify(fin.step)) as AgentStep;
  }
  return { snapshot: JSON.parse(JSON.stringify(snap)) as RunSnapshot, messages: repairTail(messages), undos, executed };
}

/** The closing line: what happened, what can be undone, whether it can become a workflow. */
function summarize(snap: RunSnapshot, executed: ExecutedStep[]): ((id: string) => TranscriptEntry) | null {
  const steps = snap.entries.flatMap((e) => (e.kind === "step" ? [e.step] : []));
  if (!steps.length) return null;
  const changed = steps.filter((s) => s.status === "ok" && s.mutating).length;
  const looked = steps.filter((s) => s.status === "ok" && !s.mutating).length;
  const failed = steps.filter((s) => s.status === "error").length;
  const declined = steps.filter((s) => s.status === "declined").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  const undoable = steps.filter((s) => s.undo?.state === "available").length;
  const bits = [
    changed ? `${plural(changed, "action")} done` : "",
    looked ? `${plural(looked, "lookup")}` : "",
    failed ? `${failed} failed` : "",
    declined ? `${declined} declined` : "",
    skipped ? `${skipped} skipped` : "",
  ].filter(Boolean);
  const saveable = planWorkflow(executed).ok;
  const text = `${snap.status === "done" ? "Finished" : snap.status === "cancelled" ? "Stopped" : "Failed"}: ${bits.join(" · ") || "nothing ran"}`;
  return (id) => ({ kind: "summary", id, text, undoable, saveable });
}

function dummyStep(tool: string): AgentStep {
  return { id: "", tool, title: tool, args: {}, summary: tool, mutating: false, status: "ok" };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
