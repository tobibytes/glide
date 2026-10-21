/**
 * Glide Agent: a natural-language "do it for me" bar. The launcher view "agent.run" sends a
 * request here; the tool-use loop (loop.ts) runs in this process with the AI feature's model
 * and key, asks the view to confirm state-changing steps, and streams the transcript back as
 * snapshots (event "run").
 */
import path from "node:path";
import { app, safeStorage } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { describeError as describeAiError, isAbort } from "../ai/client";
import { KeyStore } from "../ai/keystore";
import { DEFAULT_MODEL, isKnownModel } from "../ai/models";
import type { Effort } from "../ai/types";
import type { FeatureContext, FeatureModule } from "../types";
import { createCapabilities } from "./capabilities";
import { createCatalogueSource } from "./catalogue";
import { createAnthropicClient, createMockClient, loadMockScript, type AgentClient } from "./client";
import { MAX_TOOL_CALLS, runAgent } from "./loop";
import { AGENT_SYSTEM_PROMPT, requestContext } from "./prompt";
import { TOOLS } from "./tools";
import type { AgentErrorKind, AgentSettings, AgentStatus, AgentViewProps, RunSnapshot, StartResult, ToolInfo } from "./types";

const ID = "agent";
const VIEW = "agent.run";
const DEFAULTS: AgentSettings = { allow: {} };
const EMIT_THROTTLE_MS = 50;
const KEEP_RUNS = 5;
const EFFORTS: Effort[] = ["low", "medium", "high"];
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

interface Run {
  controller: AbortController;
  snapshot: RunSnapshot;
  pending?: { id: string; resolve(ok: boolean): void };
  /** A tool hid the launcher; bring the view back for the next confirmation or the summary. */
  hidden: boolean;
  emitTimer?: NodeJS.Timeout;
  lastEmit: number;
}

let ctx: FeatureContext | undefined;
const runs = new Map<string, Run>();

function need(): FeatureContext {
  if (!ctx) throw new Error("Agent feature not started");
  return ctx;
}

const loadFeatures = async (): Promise<FeatureModule[]> => (await import("../registry")).FEATURES;

// --- settings -----------------------------------------------------------------

const MUTATING = new Set(TOOLS.filter((t) => t.mutating).map((t) => t.name));

function settings(): AgentSettings {
  const raw = need().settings(DEFAULTS).allow;
  const allow: Record<string, boolean> = {};
  if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (MUTATING.has(k) && v === true) allow[k] = true;
  return { allow };
}

function setSettings(patch: unknown): AgentSettings {
  const p = patch as Partial<AgentSettings> | null;
  if (p && p.allow && typeof p.allow === "object") {
    const allow: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(p.allow)) if (MUTATING.has(k) && v === true) allow[k] = true;
    need().setSettings({ allow });
  }
  return settings();
}

function aiChoice(): { model: string; effort: Effort } {
  const ai = need().getGlobalSettings().features?.ai ?? {};
  const model = isKnownModel(ai.model) ? ai.model : DEFAULT_MODEL;
  const effort = typeof ai.effort === "string" && (EFFORTS as string[]).includes(ai.effort) ? (ai.effort as Effort) : "medium";
  return { model, effort };
}

/** Test hook: a scripted client, only when GLIDE_AGENT_MOCK is set (never in packaged builds). */
function mockPath(): string | null {
  const p = process.env.GLIDE_AGENT_MOCK;
  return p && !app.isPackaged ? p : null;
}

/** The AI feature's key store, read-only (a fresh instance so key changes are picked up). */
function readKey(): string | null {
  const dir = path.join(path.dirname(need().dataDir()), "ai");
  return new KeyStore(() => dir, safeStorage).read();
}

function hasKey(): boolean {
  const dir = path.join(path.dirname(need().dataDir()), "ai");
  return new KeyStore(() => dir, safeStorage).status().hasKey;
}

function status(): AgentStatus {
  return { hasKey: !!mockPath() || hasKey(), mock: !!mockPath(), model: aiChoice().model };
}

// --- runs ---------------------------------------------------------------------

const isRunId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,100}$/.test(v);

function publish(run: Run, force = false) {
  const c = need();
  const send = () => {
    run.emitTimer = undefined;
    run.lastEmit = Date.now();
    c.emit("run", run.snapshot);
  };
  if (run.emitTimer) {
    if (!force) return;
    clearTimeout(run.emitTimer);
  }
  const wait = EMIT_THROTTLE_MS - (Date.now() - run.lastEmit);
  if (force || wait <= 0) send();
  else run.emitTimer = setTimeout(send, wait);
}

function reopenView(runId: string, run: Run) {
  if (!run.hidden) return;
  run.hidden = false;
  const props: AgentViewProps = { runId };
  need().openView({ id: VIEW, props: { ...props } });
}

function describeError(err: unknown): { message: string; kind: AgentErrorKind } {
  const e = describeAiError(err);
  return { message: e.message, kind: e.kind };
}

function start(raw: unknown): StartResult {
  const c = need();
  const req = raw as { runId?: unknown; prompt?: unknown } | null;
  if (!req || !isRunId(req.runId) || typeof req.prompt !== "string" || !req.prompt.trim()) return { ok: false, error: "Type what you want Glide to do", errorKind: "bad-request" };
  const prompt = req.prompt.trim().slice(0, 4000);
  const runId = req.runId;

  let client: AgentClient;
  const mock = mockPath();
  if (mock) {
    try {
      client = createMockClient(loadMockScript(mock));
    } catch (err) {
      return { ok: false, error: `Mock script: ${err instanceof Error ? err.message : String(err)}`, errorKind: "other" };
    }
  } else {
    const key = readKey();
    if (!key) return { ok: false, error: "Add your Anthropic API key in Settings → AI to use Glide Agent.", errorKind: "no-key" };
    client = createAnthropicClient(key);
  }

  runs.get(runId)?.controller.abort();
  const { model, effort } = aiChoice();
  const controller = new AbortController();
  const run: Run = {
    controller,
    hidden: false,
    lastEmit: 0,
    snapshot: { runId, prompt, status: "running", entries: [], toolCalls: 0, maxToolCalls: MAX_TOOL_CALLS, model, startedAt: Date.now() },
  };
  runs.set(runId, run);
  while (runs.size > KEEP_RUNS) {
    const oldest = [...runs.entries()].find(([, r]) => r.snapshot.status !== "running" && r.snapshot.status !== "confirming");
    if (!oldest) break;
    runs.delete(oldest[0]);
  }

  const caps = createCapabilities({ ctx: c, catalogue, features: loadFeatures, onLauncherHidden: () => (run.hidden = true) });
  let lastStatus = run.snapshot.status;
  let lastCount = 0;
  void runAgent({
    runId,
    prompt,
    client,
    tools: TOOLS,
    caps,
    model,
    effort,
    system: AGENT_SYSTEM_PROMPT,
    context: requestContext(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
    signal: controller.signal,
    isAllowed: (tool) => settings().allow[tool] === true,
    confirm: (confirmation) =>
      new Promise<boolean>((resolve) => {
        if (controller.signal.aborted) return resolve(false);
        // An unanswered confirmation (launcher dismissed and never reopened) declines itself.
        const timer = setTimeout(() => respond(runId, confirmation.id, false), CONFIRM_TIMEOUT_MS);
        run.pending = {
          id: confirmation.id,
          resolve: (ok) => {
            clearTimeout(timer);
            resolve(ok);
          },
        };
        controller.signal.addEventListener("abort", () => run.pending?.resolve(false), { once: true });
        reopenView(runId, run);
      }),
    onChange: (snap) => {
      run.snapshot = snap;
      const structural = snap.status !== lastStatus || snap.entries.length !== lastCount;
      lastStatus = snap.status;
      lastCount = snap.entries.length;
      publish(run, structural);
    },
    describeError,
    isAbort,
  })
    .then((final) => {
      run.snapshot = final;
      run.pending = undefined;
      publish(run, true);
      if (final.status !== "cancelled") reopenView(runId, run);
    })
    .catch((err: unknown) => c.log("agent run crashed", err));
  return { ok: true };
}

function respond(runId: unknown, confirmationId: unknown, approve: unknown): boolean {
  if (!isRunId(runId)) return false;
  const run = runs.get(runId);
  if (!run?.pending || run.pending.id !== confirmationId) return false;
  const { resolve } = run.pending;
  run.pending = undefined;
  resolve(approve === true);
  return true;
}

function cancel(runId: unknown): boolean {
  if (!isRunId(runId)) return false;
  const run = runs.get(runId);
  if (!run) return false;
  run.controller.abort();
  run.pending?.resolve(false);
  run.pending = undefined;
  return true;
}

// --- catalogue ------------------------------------------------------------------

let catalogue: ReturnType<typeof createCatalogueSource>;

function items(): SearchItem[] {
  return [
    {
      id: "agent:ask",
      kind: "command",
      kindLabel: "Agent",
      feature: ID,
      title: "Ask Glide Agent",
      subtitle: "Do it for me — arrange windows, start timers, open things…",
      icon: { kind: "emoji", value: "🪄" },
      keywords: ["agent", "ai", "do", "automate", "claude", "assistant", "command"],
      acceptsArgument: true,
      data: { type: "ask" },
    },
    {
      id: "agent:fallback",
      kind: "fallback",
      feature: ID,
      title: "Ask Glide Agent",
      icon: { kind: "emoji", value: "🪄" },
      data: { type: "ask" },
    },
  ];
}

function actions(item: SearchItem): ItemAction[] {
  if (item.data?.type !== "ask") return [];
  return [
    { id: "ask", title: "Ask Glide Agent", icon: "🪄" },
    { id: "settings", title: "Agent Settings…", icon: "⚙️", shortcut: "⌘⏎" },
  ];
}

async function runAction(scored: ScoredItem, actionId: string): Promise<ExecuteResult> {
  if (actionId === "settings") return { ok: true, navigate: "settings/agent" };
  if (actionId !== "ask") return { ok: false, error: `Unknown action ${actionId}` };
  const props: AgentViewProps = { prompt: scored.argument?.trim() || undefined };
  return { ok: true, view: { id: VIEW, props: { ...props } } };
}

const toolInfo = (): ToolInfo[] => TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, mutating: t.mutating }));

export const feature: FeatureModule = {
  id: ID,
  start(c) {
    ctx = c;
    catalogue = createCatalogueSource(c, loadFeatures);
    if (mockPath()) c.log(`using scripted mock client from ${mockPath()}`);
  },
  stop() {
    for (const r of runs.values()) r.controller.abort();
    runs.clear();
  },
  items,
  actions,
  runAction,
  methods: {
    start: (req) => start(req),
    respond: (runId, confirmationId, approve) => respond(runId, confirmationId, approve),
    cancel: (runId) => cancel(runId),
    /** The newest run still in progress (lets a freshly opened view re-attach to it). */
    activeRun: () => [...runs.values()].reverse().find((r) => r.snapshot.status === "running" || r.snapshot.status === "confirming")?.snapshot ?? null,
    getRun: (runId) => (isRunId(runId) ? (runs.get(runId)?.snapshot ?? null) : null),
    status: () => status(),
    getSettings: () => settings(),
    setSettings: (patch) => setSettings(patch),
    listTools: () => toolInfo(),
    openAiSettings: () => need().openSettings("ai"),
  },
};
