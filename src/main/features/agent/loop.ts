/**
 * The agent's tool-use loop: stream a turn, run the requested tools (asking the user first for
 * any state-changing call that isn't allowed without asking), send the results back, repeat.
 * Pure apart from the injected client/capabilities, so it is unit-tested with scripted turns.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../ai/types";
import type { AgentClient, ContentBlock, MessageParam } from "./client";
import { clip, ToolFailure, type AgentCapabilities, type AgentTool, type PreparedCall } from "./tools";
import type { AgentErrorKind, AgentStep, Confirmation, RunSnapshot, TranscriptEntry } from "./types";

export const MAX_TOOL_CALLS = 12;
const MAX_TURNS = 16;

export const DECLINED_RESULT = "The user declined this action, so it was not run. Do not retry it; tell the user it was skipped.";

export interface LoopOptions {
  runId: string;
  prompt: string;
  client: AgentClient;
  tools: AgentTool[];
  caps: AgentCapabilities;
  model: string;
  effort: Effort;
  system: string;
  context: string;
  signal: AbortSignal;
  maxToolCalls?: number;
  /** True when the user enabled "Allow without asking" for this tool. */
  isAllowed(tool: string): boolean;
  /** Ask the user to approve these steps; resolves false on cancel. */
  confirm(c: Confirmation, snapshot: RunSnapshot): Promise<boolean>;
  onChange(snapshot: RunSnapshot): void;
  describeError(err: unknown): { message: string; kind: AgentErrorKind };
  isAbort(err: unknown): boolean;
  now?(): number;
}

class Aborted extends Error {}

export async function runAgent(opts: LoopOptions): Promise<RunSnapshot> {
  const max = opts.maxToolCalls ?? MAX_TOOL_CALLS;
  const now = opts.now ?? Date.now;
  let seq = 0;
  const nextId = (p: string) => `${p}${++seq}`;
  const snap: RunSnapshot = {
    runId: opts.runId,
    prompt: opts.prompt,
    status: "running",
    entries: [{ kind: "prompt", id: nextId("e"), text: opts.prompt }],
    toolCalls: 0,
    maxToolCalls: max,
    model: opts.model,
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

  const messages: MessageParam[] = [{ role: "user", content: opts.prompt }];
  let capped = false;

  try {
    for (let turn = 0; ; turn++) {
      checkAbort();
      if (turn >= MAX_TURNS) throw Object.assign(new Error(`Stopped after ${MAX_TURNS} model turns.`), { agentKind: "limit" as const });
      let textEntry: Extract<TranscriptEntry, { kind: "text" }> | null = null;
      const res = await opts.client.turn(
        { model: opts.model, effort: opts.effort, system: opts.system, context: opts.context, tools: opts.tools, messages },
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
      messages.push({ role: "assistant", content: res.content });

      if (res.stopReason === "refusal") throw Object.assign(new Error("Claude declined this request."), { agentKind: "refusal" as const });
      const uses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (res.stopReason === "max_tokens" && uses.length) throw Object.assign(new Error("The response was cut off before the tool call finished. Try a shorter request."), { agentKind: "other" as const });
      if (res.stopReason === "pause_turn") continue;
      if (res.stopReason !== "tool_use" || !uses.length) break;
      if (capped) {
        notice(`Stopped: reached the limit of ${max} tool calls for one request.`, "warning");
        break;
      }

      // Prepare every call of this turn.
      interface Call {
        use: (typeof uses)[number];
        step: AgentStep;
        prepared?: PreparedCall;
        result?: { text: string; isError: boolean };
      }
      const calls: Call[] = [];
      for (const use of uses) {
        const tool = opts.tools.find((t) => t.name === use.name);
        const step: AgentStep = { id: nextId("s"), tool: use.name, title: tool?.title ?? use.name, args: isRecord(use.input) ? use.input : {}, summary: tool?.title ?? use.name, mutating: !!tool?.mutating, status: "queued" };
        const call: Call = { use, step };
        calls.push(call);
        push({ kind: "step", id: step.id, step });
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
      emit();

      // One confirmation for every state-changing call of this turn that isn't pre-approved.
      const ask = calls.filter((c) => c.prepared && c.step.mutating && !opts.isAllowed(c.step.tool));
      for (const c of calls) if (c.prepared && c.step.mutating && !ask.includes(c)) c.step.autoApproved = true;
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
        c.step.status = "running";
        emit();
        try {
          const text = clip(await c.prepared.run());
          c.result = { text, isError: false };
          c.step.status = "ok";
          c.step.result = text;
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
      messages.push({ role: "user", content });
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
  snap.endedAt = now();
  emit();
  return JSON.parse(JSON.stringify(snap)) as RunSnapshot;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
