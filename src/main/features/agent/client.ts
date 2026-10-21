/**
 * One Messages API turn for the agent loop, behind a small interface so the loop can run
 * against Anthropic, a scripted mock (GLIDE_AGENT_MOCK) or a test double.
 */
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { supportsDefaultFallback, supportsEffort } from "../ai/models";
import type { Effort } from "../ai/types";
import type { AgentTool } from "./tools";

export type ContentBlock = Anthropic.Beta.BetaContentBlock;
export type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface TurnRequest {
  model: string;
  effort: Effort;
  /** Frozen instructions (cached prefix). */
  system: string;
  /** Per-request context (date, time zone) placed after the cache breakpoint. */
  context: string;
  tools: AgentTool[];
  messages: MessageParam[];
}

export interface TurnResult {
  content: ContentBlock[];
  stopReason: string | null;
  model: string;
}

export interface AgentClient {
  turn(req: TurnRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<TurnResult>;
}

export function buildParams(req: TurnRequest): Anthropic.Beta.MessageCreateParamsStreaming {
  const params: Anthropic.Beta.MessageCreateParamsStreaming = {
    model: req.model,
    // Replies are short; tool inputs are small, so eager input streaming is left off.
    max_tokens: 16000,
    system: [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
      ...(req.context ? [{ type: "text" as const, text: req.context }] : []),
    ],
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
    messages: req.messages,
    // Second breakpoint: caches the growing transcript between tool-loop turns.
    cache_control: { type: "ephemeral" },
    stream: true,
  };
  if (supportsEffort(req.model)) params.output_config = { effort: req.effort };
  if (supportsDefaultFallback(req.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

export function createAnthropicClient(apiKey: string, baseURL?: string): AgentClient {
  const client = new Anthropic({ apiKey, baseURL, maxRetries: 1 });
  return {
    async turn(req, onText, signal) {
      const { stream: _s, ...params } = buildParams(req);
      const stream = client.beta.messages.stream(params, { signal });
      stream.on("text", (delta) => onText(delta));
      const final = await stream.finalMessage();
      return { content: final.content, stopReason: final.stop_reason, model: final.model };
    },
  };
}

// ---------------------------------------------------------------------------
// Scripted mock (dev/test hook only)
// ---------------------------------------------------------------------------

export interface MockTurn {
  text?: string;
  tool_calls?: Array<{ name: string; input: Record<string, unknown> }>;
  stop_reason?: string;
  /** Throw this message instead of answering (simulates API failures). */
  error?: string;
  /** Delay per streamed word (default 12 ms). */
  delay_ms?: number;
}

export interface MockScript {
  model?: string;
  turns: MockTurn[];
}

export function parseMockScript(raw: unknown): MockScript {
  const r = raw as Partial<MockScript> | null;
  if (!r || !Array.isArray(r.turns)) throw new Error("Mock script needs a turns array");
  return { model: typeof r.model === "string" ? r.model : "mock-model", turns: r.turns };
}

export function loadMockScript(file: string): MockScript {
  return parseMockScript(JSON.parse(fs.readFileSync(file, "utf8")));
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(abortError())), { once: true });
  });

function abortError(): Error {
  const e = new Error("Request was aborted.");
  e.name = "AbortError";
  return e;
}

/** Replays turns in order; the turn index is the number of assistant turns already in the request. */
export function createMockClient(script: MockScript): AgentClient {
  return {
    async turn(req, onText, signal) {
      const index = req.messages.filter((m) => m.role === "assistant").length;
      const t = script.turns[index] ?? { text: "(mock script has no more turns)" };
      if (t.error) throw new Error(t.error);
      const content: ContentBlock[] = [];
      if (t.text) {
        const words = t.text.split(/(?<=\s)/);
        for (const w of words) {
          await sleep(t.delay_ms ?? 12, signal);
          onText(w);
        }
        content.push({ type: "text", text: t.text, citations: null });
      }
      (t.tool_calls ?? []).forEach((c, i) => content.push({ type: "tool_use", id: `toolu_mock_${index}_${i}`, name: c.name, input: c.input }));
      const stopReason = t.stop_reason ?? (t.tool_calls?.length ? "tool_use" : "end_turn");
      return { content, stopReason, model: script.model ?? "mock-model" };
    },
  };
}
