import { describe, expect, it, vi } from "vitest";
import type { AgentClient } from "./client";
import { READ_ONLY_RESULT, runAgentFull, type LoopOptions } from "./loop";
import { isProtectedProcess, RateLimiter } from "./safety";
import { fakeCaps, scripted } from "./test-fakes";
import { toolByName, TOOLS, type AgentCapabilities, type PreparedCall } from "./tools";
import type { AgentStep, RunSnapshot, TranscriptEntry } from "./types";
import { buildWorkflow, itemToWorkflowStep, planWorkflow } from "./workflow";

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
    isAllowed: () => false,
    confirm: async () => true,
    onChange: () => undefined,
    describeError: (e) => ({ message: String(e), kind: "other" }),
    isAbort: (e) => e instanceof Error && e.name === "AbortError",
    ...over,
  };
}

const steps = (s: RunSnapshot): AgentStep[] => s.entries.flatMap((e) => (e.kind === "step" ? [e.step] : []));
const plans = (s: RunSnapshot) => s.entries.filter((e): e is Extract<TranscriptEntry, { kind: "plan" }> => e.kind === "plan");
const summary = (s: RunSnapshot) => s.entries.find((e): e is Extract<TranscriptEntry, { kind: "summary" }> => e.kind === "summary");

function prep(caps: AgentCapabilities, name: string, input: unknown): PreparedCall {
  const t = toolByName(name);
  if (!t) throw new Error(`no tool ${name}`);
  const p = t.prepare(input, caps);
  if ("error" in p) throw new Error(p.error);
  return p;
}
function invalid(caps: AgentCapabilities, name: string, input: unknown): string | null {
  const p = toolByName(name)!.prepare(input, caps);
  return "error" in p ? p.error : null;
}

// --- new tools ------------------------------------------------------------------------------

describe("new tools", () => {
  it("describe their effect in plain English", async () => {
    const caps = fakeCaps();
    const d = (name: string, input: unknown) => prep(caps, name, input).describe();
    expect(await d("create_automation", { name: "Standup", trigger: { kind: "time", time: "9:30", days: [1, 2, 3, 4, 5] }, workflow_id: "wf1" })).toBe(
      "Create the automation “Standup” — Weekdays at 09:30 → Run workflow “Standup” (asks before each run)",
    );
    expect(await d("run_automation", { id: "auto1" })).toBe("Run the automation “Morning” now (Run Standup)");
    expect(await d("restore_layout", { id: "lay1" })).toBe("Restore the window layout “Coding” (2 windows)");
    expect(await d("save_layout", { name: "Writing" })).toBe("Save the current window positions as the layout “Writing”");
    expect(await d("transform_text", { transform: "upper" })).toBe("Transform the clipboard with “upper”");
    expect(await d("kill_process", { pid: 500, force: true })).toBe("Force quit “Chrome Helper” (PID 500) — unsaved work is lost");
    expect(await d("create_reminder", { title: "Call mum", due: "2026-10-21T17:00" })).toBe("Remind you “Call mum” at Wed, Oct 21, 5:00 PM");
    expect(await d("create_snippet", { name: "Sig", text: "Best, Tobi", keyword: ";sig" })).toBe("Create the snippet “Sig” (keyword ;sig): “Best, Tobi”");
    expect(await d("create_quicklink", { name: "GH", url: "https://github.com/search?q={query}" })).toBe("Create the quicklink “GH” → https://github.com/search?q={query}");
    expect(await d("run_shortcut", { name: "Log Water" })).toBe("Run the Shortcuts shortcut “Log Water”");
    expect(await d("set_theme", { preset: "nord", mode: "dark" })).toBe("Change Glide's look: use the “Nord” theme and switch to dark mode");
  });

  it("validate their input", () => {
    const caps = fakeCaps();
    expect(invalid(caps, "create_automation", { trigger: { kind: "time", time: "25:99" }, workflow_id: "wf1" })).toMatch(/Invalid trigger/);
    expect(invalid(caps, "create_automation", { trigger: { kind: "launch" } })).toMatch(/exactly one/);
    expect(invalid(caps, "create_automation", { trigger: { kind: "launch" }, item_id: "agent:ask" })).toMatch(/cannot run the agent/);
    expect(invalid(caps, "create_automation", { trigger: { kind: "hotkey", accelerator: "Cmd+J" }, workflow_id: "wf1" })).toMatch(/Settings/);
    expect(invalid(caps, "kill_process", { pid: 1 })).toMatch(/protected/);
    expect(invalid(caps, "kill_process", { pid: "500" })).toMatch(/integer/);
    expect(invalid(caps, "create_quicklink", { name: "x", url: "javascript:alert(1)" })).toMatch(/http/);
    expect(invalid(caps, "create_snippet", { name: "x", text: "y", keyword: "a b" })).toMatch(/spaces/);
    expect(invalid(caps, "create_reminder", { title: "x", due: "tomorrowish" })).toMatch(/ISO/);
    expect(invalid(caps, "set_theme", {})).toMatch(/mode/);
    expect(invalid(caps, "set_theme", { mode: "sepia" })).toMatch(/system, dark or light/);
    expect(invalid(caps, "run_shortcut", { name: "" })).toMatch(/required/);
  });

  it("call the fake feature methods and return results", async () => {
    const caps = fakeCaps();
    const run = async (name: string, input: unknown) => (await prep(caps, name, input).run()).text;
    expect(JSON.parse(await run("list_automations", {}))).toMatchObject([{ id: "auto1", name: "Morning" }]);
    expect(await run("run_automation", { id: "auto1" })).toBe("Ran");
    expect(JSON.parse(await run("list_layouts", {}))).toMatchObject([{ id: "lay1", name: "Coding" }]);
    expect(await run("transform_text", { transform: "upper", text: "hello" })).toBe("HELLO");
    expect(await run("transform_text", { transform: "upper" })).toBe("SECRET CLIPBOARD TEXT");
    expect(await run("transform_text", { transform: "reverse", source: "selection" })).toBe("terces detceles");
    await expect(run("transform_text", { transform: "nope", text: "x" })).rejects.toThrow(/Unknown transform/);
    expect(JSON.parse(await run("search_bookmarks", { query: "docs" }))).toMatchObject([{ url: "https://glide.example/docs" }]);
    expect(JSON.parse(await run("clipboard_history_search", {}))).toMatchObject([{ title: "password123" }]);
    expect(JSON.parse(await run("list_processes", { query: "chrome" }))).toEqual([{ pid: 500, name: "Chrome Helper", cpu: 80, memoryMB: 391, user: "me" }]);
    expect(await run("system_status", {})).toContain("CPU 12%");
    expect(await run("kill_process", { pid: 500 })).toBe("Quit 500");
    expect(caps.world.killed).toEqual([500]);
    expect(await run("run_shortcut", { name: "Log Water" })).toBe("Shortcut finished. Output: shortcut output");
  });

  it("never kill a protected process, even after approval", async () => {
    const caps = fakeCaps();
    await expect(prep(caps, "kill_process", { pid: 88 }).run()).rejects.toThrow(/Refused: WindowServer/);
    expect(caps.world.killed).toEqual([]);
    expect(isProtectedProcess("WindowServer", "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer")).toBe(true);
    expect(isProtectedProcess("Glide Helper (Renderer)", "/Applications/Glide.app/Contents/Frameworks/Glide Helper (Renderer).app/Contents/MacOS/Glide Helper (Renderer)")).toBe(true);
    expect(isProtectedProcess("Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe(false);
  });

  it("create_reminder only when the reminders feature exists (feature-detected)", async () => {
    const caps = fakeCaps();
    expect(toolByName("create_reminder")!.requires).toBe("reminders");
    await expect(prep(caps, "create_reminder", { title: "x" }).run()).rejects.toThrow(/aren't available/);
    caps.world.features.add("reminders");
    const out = await prep(caps, "create_reminder", { title: "Call mum", due: "2026-10-21T17:00" }).run();
    expect(out.undo?.summary).toBe("Delete the reminder “Call mum”");
    await out.undo!.run();
    expect(caps.world.reminders.size).toBe(0);
  });
});

// --- plan, undo, summary ------------------------------------------------------------------------

describe("planning, undo and summary", () => {
  it("shows the model's plan, links its items to steps and ends with a summary", async () => {
    const caps = fakeCaps();
    const client = scripted([
      { text: "On it.", tools: [{ name: "plan", input: { steps: ["Create a note", "Start a 25 min timer", "Put Safari on the left"] } }, { name: "create_note", input: { text: "Standup\n- a", open: false } }] },
      { tools: [{ name: "start_timer", input: { minutes: 25, name: "Focus" } }, { name: "window_action", input: { action: "left-half", app: "Safari" } }] },
      { text: "All set." },
    ]);
    const snaps: RunSnapshot[] = [];
    const out = await runAgentFull(options(client, caps, { onChange: (s) => snaps.push(s) }));
    const snap = out.snapshot;
    expect(plans(snap)).toHaveLength(1);
    const plan = plans(snap)[0]!;
    expect(plan.title).toBe("I'll do 3 things:");
    const ids = steps(snap).map((s) => s.id);
    expect(plan.items.map((i) => i.stepId)).toEqual(ids);
    // The plan was on screen before anything ran.
    const firstWithPlan = snaps.find((s) => plans(s).length)!;
    expect(steps(firstWithPlan).every((s) => s.status !== "ok")).toBe(true);
    // plan is not a step and doesn't count as a tool call.
    expect(steps(snap).map((s) => s.tool)).toEqual(["create_note", "start_timer", "window_action"]);
    expect(snap.toolCalls).toBe(3);
    expect(summary(snap)).toMatchObject({ text: "Finished: 3 actions done", undoable: 3 });
    expect(out.undos.size).toBe(3);
  });

  it("makes a plan from a multi-call turn when the model didn't", async () => {
    const caps = fakeCaps();
    const client = scripted([{ tools: [{ name: "open_app", input: { name: "Notes" } }, { name: "start_timer", input: { minutes: 5 } }] }, { text: "ok" }]);
    const snap = (await runAgentFull(options(client, caps))).snapshot;
    const plan = plans(snap)[0]!;
    expect(plan.items.map((i) => i.text)).toEqual(["Open the app “Notes”", "Start a 5 min timer"]);
    expect(snap.entries.findIndex((e) => e.kind === "plan")).toBeLessThan(snap.entries.findIndex((e) => e.kind === "step"));
  });

  it("undo puts windows back where they were (frames captured before acting), deletes created things and restores the clipboard/theme", async () => {
    const caps = fakeCaps();
    const before = JSON.parse(JSON.stringify(caps.world.windows)) as typeof caps.world.windows;
    const client = scripted([
      {
        tools: [
          { name: "window_action", input: { action: "left-half", app: "Safari" } },
          { name: "window_action", input: { action: "right-half", app: "Notes" } },
          { name: "create_note", input: { text: "Groceries", open: false } },
          { name: "create_snippet", input: { name: "Sig", text: "Best" } },
          { name: "create_quicklink", input: { name: "GH", url: "https://github.com" } },
          { name: "copy_to_clipboard", input: { text: "new text" } },
          { name: "set_theme", input: { preset: "nord" } },
          { name: "start_timer", input: { minutes: 10 } },
          { name: "create_automation", input: { name: "A", trigger: { kind: "launch" }, workflow_id: "wf1" } },
          { name: "save_layout", input: { name: "Writing" } },
        ],
      },
      { text: "Done." },
    ]);
    const out = await runAgentFull(options(client, caps));
    expect(steps(out.snapshot).every((s) => s.status === "ok")).toBe(true);
    expect(caps.world.windows).not.toEqual(before);
    expect(caps.world.notes.size).toBe(1);
    expect(caps.world.clipboard).toBe("new text");
    expect(caps.world.appearance.darkTheme).toBe("nord");

    // Undo newest-first, like the agent's ⌘Z.
    for (const st of steps(out.snapshot).reverse()) await out.undos.get(st.id)!.run();
    expect(caps.world.windows).toEqual(before);
    expect(caps.world.notes.size).toBe(0);
    expect(caps.world.snippets.size).toBe(0);
    expect(caps.world.quicklinks.size).toBe(0);
    expect(caps.world.clipboard).toBe("secret clipboard text");
    expect(caps.world.appearance.darkTheme).toBe("glide-dark");
    expect(caps.world.timers.size).toBe(0);
    expect(caps.world.automations.size).toBe(1);
    expect([...caps.world.layouts.keys()]).toEqual(["lay1"]);
    expect(steps(out.snapshot).map((s) => s.undo?.summary)).toEqual([
      "Put the windows back where they were",
      "Put the windows back where they were",
      "Delete the note “Groceries”",
      "Delete the snippet “Sig”",
      "Delete the quicklink “GH”",
      "Put the previous clipboard text back",
      "Restore the previous theme",
      "Cancel the 10 min timer",
      "Delete the new automation",
      "Delete the layout “Writing”",
    ]);
  });

  it("restore_layout can be undone too", async () => {
    const caps = fakeCaps();
    const before = JSON.parse(JSON.stringify(caps.world.windows)) as unknown;
    const out = await prep(caps, "restore_layout", { id: "lay1" }).run();
    expect(caps.world.windows).not.toEqual(before);
    await out.undo!.run();
    expect(caps.world.windows).toEqual(before);
  });

  it("steps that changed nothing or failed have no undo", async () => {
    const caps = fakeCaps({ windowAction: async () => ({ ok: false, error: "nope" }) });
    const client = scripted([{ tools: [{ name: "window_action", input: { action: "maximize" } }, { name: "open_url", input: { url: "https://x.y" } }] }, { text: "." }]);
    const out = await runAgentFull(options(client, caps));
    expect(out.undos.size).toBe(0);
    expect(summary(out.snapshot)).toMatchObject({ text: "Finished: 1 action done · 1 failed", undoable: 0 });
  });
});

// --- safety -------------------------------------------------------------------------------------

describe("safety", () => {
  it("read-only mode offers only lookup tools and refuses any state-changing call", async () => {
    const caps = fakeCaps();
    const client = scripted([{ tools: [{ name: "start_timer", input: { minutes: 5 } }, { name: "system_status", input: {} }] }, { text: "I can't." }]);
    const confirm = vi.fn(async () => true);
    const out = await runAgentFull(options(client, caps, { readOnly: true, confirm, isAllowed: () => true }));
    const offered = client.requests[0]!.tools as unknown as string[];
    expect(offered).toContain("system_status");
    expect(offered).not.toContain("start_timer");
    expect(offered).not.toContain("kill_process");
    expect(confirm).not.toHaveBeenCalled();
    expect(caps.calls).toEqual([]);
    expect(steps(out.snapshot).map((s) => [s.tool, s.status])).toEqual([
      ["start_timer", "error"],
      ["system_status", "ok"],
    ]);
    expect(JSON.stringify(client.requests[1]!.messages.at(-1))).toContain(READ_ONLY_RESULT);
    expect(out.snapshot.readOnly).toBe(true);
  });

  it("kill_process and run_shortcut always ask, even when allowed without asking", async () => {
    const caps = fakeCaps();
    const client = scripted([{ tools: [{ name: "kill_process", input: { pid: 500 } }, { name: "run_shortcut", input: { name: "X" } }, { name: "start_timer", input: { minutes: 1 } }] }, { text: "." }]);
    const asked: string[][] = [];
    await runAgentFull(
      options(client, caps, {
        isAllowed: () => true,
        confirm: async (c, s) => {
          asked.push(steps(s).filter((x) => c.stepIds.includes(x.id)).map((x) => x.tool));
          return true;
        },
      }),
    );
    expect(asked).toEqual([["kill_process", "run_shortcut"]]);
  });

  it("rate-limits destructive tools across requests", async () => {
    let t = 0;
    const limiter = new RateLimiter(3, 60_000, () => t);
    const caps = fakeCaps();
    const kills = Array.from({ length: 4 }, () => ({ name: "kill_process", input: { pid: 500 } }));
    const client = scripted([{ tools: kills }, { text: "." }]);
    const out = await runAgentFull(options(client, caps, { takeRateLimit: () => limiter.take() }));
    expect(steps(out.snapshot).map((s) => s.status)).toEqual(["ok", "ok", "ok", "error"]);
    expect(steps(out.snapshot)[3]!.result).toMatch(/Rate limited/);
    expect(caps.world.killed).toHaveLength(3);
    t = 61_000;
    expect(limiter.take()).toBeNull();
  });

  it("only offers tools whose feature is installed (registry feature detection is done by the caller)", () => {
    expect(TOOLS.filter((t) => t.requires === "reminders").map((t) => t.name)).toEqual(["create_reminder"]);
  });
});

// --- save as workflow ---------------------------------------------------------------------------

describe("save as workflow", () => {
  it("converts executed steps into workflow actions (native and feature actions)", async () => {
    const caps = fakeCaps({ workflowForItem: (id, arg, title) => itemToWorkflowStep(id, arg, { quicklinks: [], snippets: [], workflows: [] }, title) });
    const client = scripted([
      {
        tools: [
          { name: "search_catalogue", input: { query: "sleep" } },
          { name: "open_app", input: { name: "Notes" } },
          { name: "window_action", input: { action: "left-half", app: "Safari" } },
          { name: "start_timer", input: { minutes: 25, name: "Focus" } },
          { name: "open_url", input: { url: "https://example.com" } },
          { name: "run_workflow", input: { id: "wf1" } },
          { name: "execute_item", input: { id: "syscmds:sleep" } },
          { name: "run_shortcut", input: { name: "Log Water's" } },
          { name: "run_automation", input: { id: "auto1" } },
          { name: "restore_layout", input: { id: "lay1" } },
        ],
      },
      { text: "Done." },
    ]);
    const out = await runAgentFull(options(client, caps));
    expect(summary(out.snapshot)?.saveable).toBe(true);
    const planned = planWorkflow(steps(out.snapshot).map((step) => ({ step, workflow: step.workflow })));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.actions.map((a) => (a.type === "feature" ? `${a.params.feature}.${a.params.action}` : a.type))).toEqual([
      "openApp",
      "openApp",
      "wait",
      "agent.runItem",
      "timers.start",
      "openUrl",
      "runWorkflow",
      "agent.runItem",
      "runShell",
      "automations.runNow",
      "layouts.restore",
    ]);
    expect(planned.actions[3]!.params).toMatchObject({ item: "windows.left-half" });
    expect(planned.actions[4]!.params).toMatchObject({ duration: "25m", name: "Focus" });
    expect(planned.actions[8]!.params.command).toBe("shortcuts run 'Log Water'\\''s'");
    const wf = buildWorkflow("Morning", "set up my morning", planned.actions, 1000);
    expect(wf).toMatchObject({ name: "Morning", icon: { kind: "emoji", value: "🪄" } });
    expect(wf.actions).toHaveLength(11);
    expect(new Set(wf.actions.map((a) => a.id)).size).toBe(11);
  });

  it("refuses when a step has no workflow equivalent, or nothing changed", async () => {
    const caps = fakeCaps();
    const client = scripted([{ tools: [{ name: "open_app", input: { name: "Notes" } }, { name: "create_note", input: { text: "x", open: false } }] }, { text: "." }]);
    const out = await runAgentFull(options(client, caps));
    const planned = planWorkflow(steps(out.snapshot).map((step) => ({ step, workflow: step.workflow })));
    expect(planned).toMatchObject({ ok: false, unmapped: ["Create a note “x”"] });
    expect(summary(out.snapshot)?.saveable).toBe(false);
    expect(planWorkflow([])).toMatchObject({ ok: false, error: expect.stringMatching(/nothing to save/) });
  });

  it("maps catalogue items to native actions where possible", () => {
    const data = { quicklinks: [{ id: "q1", name: "GH", url: "https://github.com/search?q={query}" }], snippets: [{ id: "s1", name: "Sig", text: "Best" }], workflows: [] };
    expect(itemToWorkflowStep("app:/Applications/Safari.app", undefined, data)).toEqual({ type: "openApp", params: { app: "/Applications/Safari.app" } });
    expect(itemToWorkflowStep("quicklink:q1", "a b", data)).toEqual({ type: "openUrl", params: { url: "https://github.com/search?q=a%20b" } });
    expect(itemToWorkflowStep("snippet:s1", undefined, data)).toEqual({ type: "setClipboard", params: { text: "Best" } });
    expect(itemToWorkflowStep("agent:ask", undefined, data)).toBeNull();
    expect(itemToWorkflowStep("timers:start", "5m", data, "Start Timer")).toMatchObject({ type: "feature", params: { feature: "agent", action: "runItem", item: "timers:start", argument: "5m" } });
  });
});
