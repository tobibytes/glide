import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageParam } from "./client";
import { createMockClient } from "./client";
import { appendPrompt, redactMessages, repairTail, trimHistory } from "./conversation";
import { ConversationStore } from "./history";
import { runAgentFull, type LoopOptions } from "./loop";
import { REDACTED, sensitivity } from "./safety";
import { Sessions } from "./sessions";
import { fakeCaps, scripted } from "./test-fakes";
import { TOOLS, type AgentCapabilities } from "./tools";
import type { AgentClient } from "./client";

function options(client: AgentClient, caps: AgentCapabilities, over: Partial<LoopOptions> = {}): LoopOptions {
  return {
    runId: "r1",
    prompt: "do things",
    client,
    tools: TOOLS,
    caps,
    model: "m",
    effort: "medium",
    system: "sys",
    context: "ctx",
    signal: new AbortController().signal,
    isAllowed: () => true,
    confirm: async () => true,
    onChange: () => undefined,
    describeError: (e) => ({ message: String(e), kind: "other" }),
    isAbort: (e) => e instanceof Error && e.name === "AbortError",
    ...over,
  };
}

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "glide-agent-test-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("multi-turn conversations", () => {
  it("a follow-up request carries the earlier request, tool calls and results", async () => {
    const caps = fakeCaps();
    const client = scripted([
      { tools: [{ name: "window_action", input: { action: "left-half", app: "Safari" } }] },
      { text: "Safari is on the left." },
      { tools: [{ name: "window_action", input: { action: "right-half", app: "Safari" } }] },
      { text: "Moved it to the right." },
    ]);
    const first = await runAgentFull(options(client, caps, { runId: "r1", prompt: "put safari left" }));
    expect(first.snapshot.status).toBe("done");
    const second = await runAgentFull(options(client, caps, { runId: "r2", prompt: "now put it on the right", history: first.messages }));
    expect(second.snapshot.status).toBe("done");

    const req = client.requests[2]!; // first turn of the follow-up
    const roles = req.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(req.messages[0]!.content).toBe("put safari left");
    expect(JSON.stringify(req.messages[1])).toContain("left-half");
    expect(JSON.stringify(req.messages[2])).toContain("tool_result");
    expect(req.messages[4]!.content).toBe("now put it on the right");
    expect(second.messages).toHaveLength(8);
    expect(caps.calls).toEqual(["win:left-half:Safari", "win:right-half:Safari"]);
  });

  it("the GLIDE_AGENT_MOCK client continues its script across follow-ups", async () => {
    const mock = createMockClient({ turns: [{ text: "One.", delay_ms: 0 }, { text: "Two.", delay_ms: 0 }] });
    const caps = fakeCaps();
    const a = await runAgentFull(options(mock, caps, { prompt: "first" }));
    const b = await runAgentFull(options(mock, caps, { runId: "r2", prompt: "second", history: a.messages }));
    expect(a.snapshot.entries.find((e) => e.kind === "text")).toMatchObject({ text: "One." });
    expect(b.snapshot.entries.find((e) => e.kind === "text")).toMatchObject({ text: "Two." });
  });

  it("a stopped run leaves a history that is still valid to continue", async () => {
    const ac = new AbortController();
    const caps = fakeCaps();
    const client = scripted([{ tools: [{ name: "open_app", input: { name: "Notes" } }] }, { text: "ok" }]);
    const stopped = await runAgentFull(
      options(client, caps, {
        signal: ac.signal,
        isAllowed: () => false,
        confirm: async () => {
          ac.abort();
          return false;
        },
      }),
    );
    expect(stopped.snapshot.status).toBe("cancelled");
    const last = stopped.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last)).toContain("Not run: the request was stopped.");
    // The follow-up merges into that user turn instead of making two user messages in a row.
    const next = appendPrompt(stopped.messages, "try again");
    expect(next.at(-1)!.role).toBe("user");
    expect(next.filter((m) => m.role === "user")).toHaveLength(2);
    expect(JSON.stringify(next.at(-1))).toContain("try again");
  });

  it("repairs, trims and appends history at request boundaries", () => {
    const tail: MessageParam[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "open_app", input: { name: "X" } }] },
    ];
    expect(repairTail(tail).at(-1)).toMatchObject({ role: "user" });
    const long: MessageParam[] = [];
    for (let i = 0; i < 40; i++) long.push({ role: "user", content: `p${i}` }, { role: "assistant", content: [{ type: "text", text: `r${i}` }] });
    const trimmed = trimHistory(long, 10);
    expect(trimmed.length).toBeLessThanOrEqual(10);
    expect(trimmed[0]).toMatchObject({ role: "user" });
    expect(appendPrompt([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "text", text: "y" }] }], "z").at(-1)).toEqual({ role: "user", content: "z" });
  });
});

describe("redaction of saved history", () => {
  const info = sensitivity(TOOLS);

  it("replaces clipboard/selection results and clipboard arguments, and drops thinking", async () => {
    const caps = fakeCaps();
    const client = scripted([
      { thinking: true, tools: [{ name: "get_clipboard", input: {} }, { name: "get_selected_text", input: {} }, { name: "clipboard_history_search", input: { query: "pass" } }] },
      { tools: [{ name: "copy_to_clipboard", input: { text: "secret clipboard text, cleaned" } }] },
      { text: "Done." },
    ]);
    const out = await runAgentFull(options(client, caps));
    const live = JSON.stringify(out.messages);
    expect(live).toContain("secret clipboard text");
    expect(live).toContain("password123");

    const saved = JSON.stringify(redactMessages(out.messages, info, false));
    expect(saved).not.toContain("secret clipboard text");
    expect(saved).not.toContain("selected secret");
    expect(saved).not.toContain("password123");
    expect(saved).not.toContain("sig-1");
    expect(saved).toContain(REDACTED);

    const kept = JSON.stringify(redactMessages(out.messages, info, true));
    expect(kept).toContain("secret clipboard text");
  });

  it("Sessions.persist stores redacted runs unless the user opted in, and can be searched and resumed", async () => {
    const dir = tmp();
    const store = new ConversationStore(() => path.join(dir, "conversations.json"));
    let keep = false;
    const sessions = new Sessions({ store, sensitivity: () => info, keepSensitive: () => keep, saveHistory: () => true });
    const caps = fakeCaps();
    const client = scripted([{ tools: [{ name: "get_clipboard", input: {} }] }, { text: "Your clipboard says hi." }]);
    const conv = sessions.create("c1", "what is on my clipboard");
    const out = await runAgentFull(options(client, caps, { conversationId: "c1", prompt: "what is on my clipboard" }));
    conv.messages = out.messages;
    sessions.putRun(conv, out.snapshot);
    sessions.persist(conv);
    store.flush();

    const disk = fs.readFileSync(path.join(dir, "conversations.json"), "utf8");
    expect(disk).not.toContain("secret clipboard text");
    expect(disk).toContain("redacted");
    expect(store.search("clipboard")).toMatchObject([{ id: "c1", runs: 1 }]);
    expect(store.search("nothing-like-this")).toEqual([]);

    // A fresh session (after a restart) resumes from disk.
    const reopened = new Sessions({ store: new ConversationStore(() => path.join(dir, "conversations.json")), sensitivity: () => info, keepSensitive: () => keep, saveHistory: () => true });
    const resumed = reopened.get("c1")!;
    expect(resumed.runs).toHaveLength(1);
    expect(resumed.messages.length).toBeGreaterThan(0);
    const client2 = scripted([{ text: "Follow-up answer." }]);
    const next = await runAgentFull(options(client2, caps, { runId: "r2", prompt: "and before that?", history: resumed.messages }));
    expect(next.snapshot.status).toBe("done");
    expect(JSON.stringify(client2.requests[0]!.messages)).toContain("what is on my clipboard");

    keep = true;
    sessions.persist(conv);
    store.flush();
    expect(fs.readFileSync(path.join(dir, "conversations.json"), "utf8")).toContain("secret clipboard text");

    expect(sessions.delete("c1")).toBe(true);
    store.flush();
    expect(store.search("")).toEqual([]);
  });

  it("does not save anything when history is off", () => {
    const dir = tmp();
    const store = new ConversationStore(() => path.join(dir, "conversations.json"));
    const sessions = new Sessions({ store, sensitivity: () => info, keepSensitive: () => false, saveHistory: () => false });
    const c = sessions.create("c2", "hello");
    sessions.putRun(c, { runId: "r", prompt: "hello", status: "done", entries: [], toolCalls: 0, maxToolCalls: 12, model: "m", startedAt: 1 });
    sessions.persist(c);
    store.flush();
    expect(fs.existsSync(path.join(dir, "conversations.json"))).toBe(false);
    expect(sessions.list("")).toMatchObject([{ id: "c2" }]);
  });
});
