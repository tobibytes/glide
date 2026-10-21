import { describe, expect, it, vi } from "vitest";
import type { AgentClient, ContentBlock, TurnRequest, TurnResult } from "./client";
import { buildParams, createMockClient, parseMockScript } from "./client";
import { DECLINED_RESULT, runAgent, type LoopOptions } from "./loop";
import { TOOLS, type AgentCapabilities } from "./tools";
import type { Confirmation, RunSnapshot } from "./types";

// --- fakes ----------------------------------------------------------------------

function fakeCaps(over: Partial<AgentCapabilities> = {}): AgentCapabilities & { calls: string[] } {
  const calls: string[] = [];
  const log = (s: string) => calls.push(s);
  const caps: AgentCapabilities = {
    now: () => new Date("2026-10-21T09:00:00").getTime(),
    search: async (q) => (log(`search:${q}`), [{ id: "timers:start", title: "Start Timer", kind: "Timer" }]),
    findItem: async (id) => (id === "app:/Applications/Safari.app" ? { id, title: "Safari", kind: "app" } : undefined),
    executeItem: async (id) => (log(`exec:${id}`), { ok: true }),
    listWorkflows: () => [{ id: "wf1", name: "Standup" }],
    runWorkflow: async (id) => (log(`wf:${id}`), { ok: true, result: "ran" }),
    windowAction: async (action, app) => (log(`win:${action}:${app ?? ""}`), { ok: true }),
    openUrl: async (u) => (log(`url:${u}`), { ok: true }),
    openApp: async (n) => (log(`app:${n}`), { ok: true }),
    openFile: async (p) => (log(`file:${p}`), { ok: true }),
    clipboardText: async () => "clip text",
    copyText: async (t) => (log(`copy:${t}`), { ok: true }),
    selectedText: async () => ({ text: "selected" }),
    startTimer: async (ms, name) => (log(`timer:${ms}:${name}`), { ok: true, message: "Timer started" }),
    createNote: async (t) => (log(`note:${t}`), { ok: true, id: "n1" }),
    searchNotes: async () => [{ id: "n1", title: "Standup notes" }],
    openNote: async (id) => (log(`open-note:${id}`), { ok: true }),
    convert: async () => [{ title: "3.11 mi" }],
    calendarEvents: async () => ({ ok: true, events: [] }),
    ...over,
  };
  return Object.assign(caps, { calls });
}

type Turn = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }>; stop?: string; thinking?: boolean };

/** Scripted client that records every request it receives. */
function scripted(turns: Array<Turn | Error>): AgentClient & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  return {
    requests,
    async turn(req, onText): Promise<TurnResult> {
      requests.push(JSON.parse(JSON.stringify(req, (k, v) => (k === "tools" ? undefined : v))) as TurnRequest);
      const t = turns[requests.length - 1] ?? { text: "done" };
      if (t instanceof Error) throw t;
      const content: ContentBlock[] = [];
      if (t.thinking) content.push({ type: "thinking", thinking: "", signature: "sig-1" } as ContentBlock);
      if (t.text) {
        onText(t.text);
        content.push({ type: "text", text: t.text, citations: null });
      }
      (t.tools ?? []).forEach((c, i) => content.push({ type: "tool_use", id: `tu_${requests.length}_${i}`, name: c.name, input: c.input }));
      return { content, stopReason: t.stop ?? (t.tools?.length ? "tool_use" : "end_turn"), model: "claude-opus-5-5" };
    },
  };
}

function options(client: AgentClient, caps: AgentCapabilities, over: Partial<LoopOptions> = {}): LoopOptions {
  return {
    runId: "r1",
    prompt: "do things",
    client,
    tools: TOOLS,
    caps,
    model: "claude-opus-5-5",
    effort: "medium",
    system: "sys",
    context: "ctx",
    signal: new AbortController().signal,
    isAllowed: () => false,
    confirm: async () => true,
    onChange: () => undefined,
    describeError: (e) => ({ message: e instanceof Error ? e.message : String(e), kind: "other" }),
    isAbort: (e) => e instanceof Error && e.name === "AbortError",
    ...over,
  };
}

const steps = (s: RunSnapshot) => s.entries.flatMap((e) => (e.kind === "step" ? [e.step] : []));
const toolResults = (req: TurnRequest) => {
  const last = req.messages[req.messages.length - 1];
  return Array.isArray(last.content) ? last.content : [];
};

// --- tests --------------------------------------------------------------------------

describe("agent loop", () => {
  it("runs read-only tools without asking and feeds results back, replaying the assistant turn unchanged", async () => {
    const client = scripted([{ thinking: true, text: "Looking.", tools: [{ name: "search_catalogue", input: { query: "timer" } }] }, { text: "Found the timer command." }]);
    const caps = fakeCaps();
    const confirm = vi.fn(async () => true);
    const snap = await runAgent(options(client, caps, { confirm }));

    expect(snap.status).toBe("done");
    expect(confirm).not.toHaveBeenCalled();
    expect(caps.calls).toEqual(["search:timer"]);
    expect(steps(snap)).toMatchObject([{ tool: "search_catalogue", status: "ok", mutating: false }]);
    expect(snap.toolCalls).toBe(1);

    const second = client.requests[1];
    expect(second.messages).toHaveLength(3);
    const assistant = second.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content) && assistant.content[0]).toMatchObject({ type: "thinking", signature: "sig-1" });
    expect(toolResults(second)[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1_0" });
    expect(JSON.stringify(toolResults(second)[0])).toContain("timers:start");
    expect(snap.entries.map((e) => e.kind)).toEqual(["prompt", "text", "step", "text"]);
  });

  it("asks once for all state-changing calls of a turn and runs them in order after approval", async () => {
    const client = scripted([
      {
        tools: [
          { name: "window_action", input: { action: "left-half", app: "Safari" } },
          { name: "window_action", input: { action: "right-half", app: "Notes" } },
          { name: "start_timer", input: { minutes: 25, name: "Focus" } },
        ],
      },
      { text: "Done." },
    ]);
    const caps = fakeCaps();
    const seen: Array<{ c: Confirmation; snap: RunSnapshot }> = [];
    const snap = await runAgent(
      options(client, caps, {
        confirm: async (c, s) => {
          seen.push({ c, snap: s });
          expect(caps.calls).toEqual([]); // nothing ran before approval
          return true;
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].c.stepIds).toHaveLength(3);
    expect(seen[0].snap.status).toBe("confirming");
    const summaries = steps(seen[0].snap).map((s) => s.summary);
    expect(summaries).toEqual(["Bring “Safari” to the front and move its window to Left Half", "Bring “Notes” to the front and move its window to Right Half", "Start a 25 min timer named “Focus”"]);
    expect(steps(seen[0].snap).every((s) => s.status === "awaiting")).toBe(true);
    expect(caps.calls).toEqual(["win:left-half:Safari", "win:right-half:Notes", `timer:${25 * 60_000}:Focus`]);
    expect(snap.status).toBe("done");
    expect(snap.confirmation).toBeUndefined();
  });

  it("declining skips the actions and tells Claude", async () => {
    const client = scripted([{ tools: [{ name: "open_url", input: { url: "https://example.com" } }] }, { text: "Okay, skipped." }]);
    const caps = fakeCaps();
    const snap = await runAgent(options(client, caps, { confirm: async () => false }));
    expect(caps.calls).toEqual([]);
    expect(steps(snap)[0]).toMatchObject({ status: "declined" });
    expect(toolResults(client.requests[1])[0]).toMatchObject({ is_error: true, content: DECLINED_RESULT });
    expect(snap.status).toBe("done");
  });

  it("runs tools the user allowed without asking", async () => {
    const client = scripted([{ tools: [{ name: "start_timer", input: { minutes: 5 } }, { name: "open_app", input: { name: "Notes" } }] }, { text: "ok" }]);
    const caps = fakeCaps();
    const confirm = vi.fn(async () => true);
    const snap = await runAgent(options(client, caps, { confirm, isAllowed: (t) => t === "start_timer" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((confirm.mock.calls[0] as unknown as [Confirmation])[0].stepIds).toHaveLength(1);
    expect(steps(snap).map((s) => [s.tool, s.autoApproved ?? false, s.status])).toEqual([
      ["start_timer", true, "ok"],
      ["open_app", false, "ok"],
    ]);
  });

  it("caps a request at 12 tool calls and stops when Claude keeps calling tools", async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: "convert", input: { query: `${i} km in mi` } }));
    const client = scripted([{ tools: many }, { tools: [{ name: "convert", input: { query: "again" } }] }]);
    const caps = fakeCaps();
    const convert = vi.fn(async () => [{ title: "x" }]);
    caps.convert = convert;
    const snap = await runAgent(options(client, caps));
    expect(convert).toHaveBeenCalledTimes(12);
    expect(snap.toolCalls).toBe(12);
    const all = steps(snap);
    expect(all[12]).toMatchObject({ status: "skipped" });
    const results = toolResults(client.requests[1]);
    expect(results).toHaveLength(14); // 13 tool_results + the limit note
    expect(results[12]).toMatchObject({ is_error: true });
    expect(results[13]).toMatchObject({ type: "text" });
    expect(client.requests).toHaveLength(2);
    expect(snap.entries.at(-1)).toMatchObject({ kind: "notice", tone: "warning" });
    expect(snap.status).toBe("done");
  });

  it("rejects invalid input and unknown tools without running anything", async () => {
    const client = scripted([
      {
        tools: [
          { name: "window_action", input: { action: "sideways" } },
          { name: "open_url", input: { url: "file:///etc/passwd" } },
          { name: "rm_rf", input: {} },
        ],
      },
      { text: "Sorry." },
    ]);
    const caps = fakeCaps();
    const confirm = vi.fn(async () => true);
    const snap = await runAgent(options(client, caps, { confirm }));
    expect(confirm).not.toHaveBeenCalled();
    expect(caps.calls).toEqual([]);
    expect(steps(snap).map((s) => s.status)).toEqual(["error", "error", "error"]);
    const results = toolResults(client.requests[1]);
    expect(results.every((r) => (r as { is_error?: boolean }).is_error)).toBe(true);
    expect(JSON.stringify(results[1])).toContain("Only http, https and mailto");
  });

  it("reports a failing tool to Claude and keeps going", async () => {
    const client = scripted([{ tools: [{ name: "window_action", input: { action: "maximize" } }] }, { text: "Couldn't move it." }]);
    const caps = fakeCaps({ windowAction: async () => ({ ok: false, error: "Accessibility permission required" }) });
    const snap = await runAgent(options(client, caps));
    expect(steps(snap)[0]).toMatchObject({ status: "error", result: "Accessibility permission required" });
    expect(toolResults(client.requests[1])[0]).toMatchObject({ is_error: true, content: "Accessibility permission required" });
    expect(snap.status).toBe("done");
  });

  it("surfaces API errors with their kind", async () => {
    const client = scripted([new Error("boom")]);
    const snap = await runAgent(options(client, fakeCaps(), { describeError: () => ({ message: "Rate limited", kind: "rate-limit" }) }));
    expect(snap.status).toBe("error");
    expect(snap.error).toEqual({ message: "Rate limited", kind: "rate-limit" });
    expect(snap.entries.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: "Rate limited" });
  });

  it("treats a refusal as an error and never runs that turn's tools", async () => {
    const client = scripted([{ tools: [{ name: "open_app", input: { name: "X" } }], stop: "refusal" }]);
    const caps = fakeCaps();
    const snap = await runAgent(options(client, caps));
    expect(snap.status).toBe("error");
    expect(snap.error?.kind).toBe("refusal");
    expect(caps.calls).toEqual([]);
  });

  it("does not run tools from a truncated (max_tokens) turn", async () => {
    const client = scripted([{ tools: [{ name: "open_app", input: { name: "X" } }], stop: "max_tokens" }]);
    const caps = fakeCaps();
    const snap = await runAgent(options(client, caps));
    expect(snap.status).toBe("error");
    expect(caps.calls).toEqual([]);
  });

  it("cancelling while waiting for confirmation stops the run", async () => {
    const ac = new AbortController();
    const client = scripted([{ tools: [{ name: "open_app", input: { name: "Notes" } }] }]);
    const caps = fakeCaps();
    const snap = await runAgent(
      options(client, caps, {
        signal: ac.signal,
        confirm: async () => {
          ac.abort();
          return false;
        },
      }),
    );
    expect(snap.status).toBe("cancelled");
    expect(caps.calls).toEqual([]);
    expect(steps(snap)[0].status).toBe("skipped");
    expect(client.requests).toHaveLength(1);
  });

  it("streams snapshots while running", async () => {
    const client = scripted([{ text: "Hello" }]);
    const seen: string[] = [];
    await runAgent(options(client, fakeCaps(), { onChange: (s) => seen.push(s.status) }));
    expect(seen[0]).toBe("running");
    expect(seen.at(-1)).toBe("done");
  });
});

describe("scripted mock client (GLIDE_AGENT_MOCK)", () => {
  it("replays turns by assistant-turn count and streams text", async () => {
    const client = createMockClient(parseMockScript({ turns: [{ text: "Hi there", tool_calls: [{ name: "start_timer", input: { minutes: 1 } }], delay_ms: 0 }, { text: "Bye", delay_ms: 0 }] }));
    const deltas: string[] = [];
    const req = { model: "m", effort: "low" as const, system: "", context: "", tools: [], messages: [{ role: "user" as const, content: "x" }] };
    const r1 = await client.turn(req, (d) => deltas.push(d), new AbortController().signal);
    expect(deltas.join("")).toBe("Hi there");
    expect(r1.stopReason).toBe("tool_use");
    expect(r1.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    const r2 = await client.turn({ ...req, messages: [...req.messages, { role: "assistant", content: r1.content }] }, () => undefined, new AbortController().signal);
    expect(r2.stopReason).toBe("end_turn");
  });

  it("drives a full run end to end", async () => {
    const client = createMockClient({ turns: [{ tool_calls: [{ name: "start_timer", input: { minutes: 25 } }], delay_ms: 0 }, { text: "Started a 25 min timer.", delay_ms: 0 }] });
    const caps = fakeCaps();
    const snap = await runAgent(options(client, caps));
    expect(caps.calls).toEqual([`timer:${25 * 60_000}:`]);
    expect(snap.entries.at(-1)).toMatchObject({ kind: "text", text: "Started a 25 min timer." });
  });

  it("rejects malformed scripts", () => {
    expect(() => parseMockScript({})).toThrow();
  });
});

describe("request building", () => {
  const base: TurnRequest = { model: "claude-opus-5-5", effort: "medium", system: "S", context: "C", tools: TOOLS, messages: [{ role: "user", content: "hi" }] };

  it("sends every tool with a schema, caches the frozen prefix and opts into fallbacks", () => {
    const p = buildParams(base);
    expect(p.tools?.map((t) => (t as { name: string }).name)).toEqual(TOOLS.map((t) => t.name));
    expect(p.system).toEqual([{ type: "text", text: "S", cache_control: { type: "ephemeral" } }, { type: "text", text: "C" }]);
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.fallbacks).toBe("default");
    expect(p.tool_choice).toBeUndefined();
    expect(p.thinking).toBeUndefined();
  });

  it("omits effort for Haiku", () => {
    const p = buildParams({ ...base, model: "claude-haiku-4-5" });
    expect(p.output_config).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
  });
});
