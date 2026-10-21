/**
 * Glide Agent: a natural-language "do it for me" bar with follow-up conversations. The launcher
 * view "agent.run" sends requests here; the tool-use loop (loop.ts) runs in this process with the
 * AI feature's model and key, asks the view to confirm state-changing steps, and streams the
 * transcript back as snapshots (event "run"). Conversations are kept per session (sessions.ts),
 * saved redacted (history.ts), and every undoable step can be put back (⌘Z in the view).
 */
import path from "node:path";
import { app, safeStorage } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { describeError as describeAiError, isAbort } from "../ai/client";
import { KeyStore } from "../ai/keystore";
import { DEFAULT_MODEL, isKnownModel } from "../ai/models";
import type { Effort } from "../ai/types";
import type { FeatureContext, FeatureModule, FeatureWorkflowAction } from "../types";
import { createCapabilities } from "./capabilities";
import { createCatalogueSource } from "./catalogue";
import { createAnthropicClient, createMockClient, loadMockScript, type AgentClient } from "./client";
import { ConversationStore } from "./history";
import { MAX_TOOL_CALLS, runAgentFull } from "./loop";
import { AGENT_SYSTEM_PROMPT, requestContext } from "./prompt";
import { RateLimiter, sensitivity } from "./safety";
import { Sessions, type LiveConversation } from "./sessions";
import { RUN_ITEM_ACTION } from "./tooling";
import { TOOLS, type AgentTool } from "./tools";
import type { AgentErrorKind, AgentSettings, AgentStatus, AgentViewProps, RunSnapshot, SaveWorkflowResult, StartResult, ToolInfo, UndoResult } from "./types";
import { buildWorkflow, planWorkflow } from "./workflow";

const ID = "agent";
const VIEW = "agent.run";
const DEFAULTS: AgentSettings = { allow: {}, readOnly: false, keepSensitive: false, launcherShortcut: true, saveHistory: true };
const EMIT_THROTTLE_MS = 50;
const KEEP_RUNS = 20;
const EFFORTS: Effort[] = ["low", "medium", "high"];
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

interface Run {
  controller: AbortController;
  snapshot: RunSnapshot;
  conversationId: string;
  pending?: { id: string; resolve(ok: boolean): void };
  /** A tool hid the launcher; bring the view back for the next confirmation or the summary. */
  hidden: boolean;
  emitTimer?: NodeJS.Timeout;
  lastEmit: number;
}

let ctx: FeatureContext | undefined;
let catalogue: ReturnType<typeof createCatalogueSource>;
let sessions: Sessions | undefined;
let store: ConversationStore | undefined;
const runs = new Map<string, Run>();
const limiter = new RateLimiter();

function need(): FeatureContext {
  if (!ctx) throw new Error("Agent feature not started");
  return ctx;
}
function sess(): Sessions {
  if (!sessions) throw new Error("Agent feature not started");
  return sessions;
}

const loadFeatures = async (): Promise<FeatureModule[]> => (await import("../registry")).FEATURES;

// --- settings -----------------------------------------------------------------

/** Tools the user may run without being asked (never kill_process / run_shortcut). */
const ALLOWABLE = new Set(TOOLS.filter((t) => t.mutating && !t.alwaysConfirm).map((t) => t.name));
const SENSITIVITY = sensitivity(TOOLS);

function cleanAllow(raw: unknown): Record<string, boolean> {
  const allow: Record<string, boolean> = {};
  if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (ALLOWABLE.has(k) && v === true) allow[k] = true;
  return allow;
}

function settings(): AgentSettings {
  const s = need().settings(DEFAULTS);
  return {
    allow: cleanAllow(s.allow),
    readOnly: s.readOnly === true,
    keepSensitive: s.keepSensitive === true,
    launcherShortcut: s.launcherShortcut !== false,
    saveHistory: s.saveHistory !== false,
  };
}

function setSettings(patch: unknown): AgentSettings {
  const p = (patch && typeof patch === "object" ? patch : {}) as Partial<Record<keyof AgentSettings, unknown>>;
  const out: Record<string, unknown> = {};
  if (p.allow && typeof p.allow === "object") out.allow = cleanAllow(p.allow);
  for (const k of ["readOnly", "keepSensitive", "launcherShortcut", "saveHistory"] as const) if (typeof p[k] === "boolean") out[k] = p[k];
  if (Object.keys(out).length) need().setSettings(out);
  const next = settings();
  if (Object.keys(out).length) need().emit("settings", next);
  return next;
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
function keyStore(): KeyStore {
  const dir = path.join(path.dirname(need().dataDir()), "ai");
  return new KeyStore(() => dir, safeStorage);
}

function status(): AgentStatus {
  const mock = !!mockPath();
  return { hasKey: mock || keyStore().status().hasKey, mock, model: aiChoice().model, readOnly: settings().readOnly };
}

let featureIds: Set<string> = new Set();
async function refreshFeatureIds(): Promise<Set<string>> {
  featureIds = new Set((await loadFeatures()).map((f) => f.id));
  return featureIds;
}
const availableTools = (ids: ReadonlySet<string>): AgentTool[] => TOOLS.filter((t) => !t.requires || ids.has(t.requires));

// --- runs ---------------------------------------------------------------------

const isId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,100}$/.test(v);

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

const busy = (conv: LiveConversation) => [...runs.values()].some((r) => r.conversationId === conv.id && (r.snapshot.status === "running" || r.snapshot.status === "confirming"));

async function start(raw: unknown): Promise<StartResult> {
  const c = need();
  const req = raw as { runId?: unknown; prompt?: unknown; conversationId?: unknown } | null;
  if (!req || !isId(req.runId) || typeof req.prompt !== "string" || !req.prompt.trim()) return { ok: false, error: "Type what you want Glide to do", errorKind: "bad-request" };
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
    const key = keyStore().read();
    if (!key) return { ok: false, error: "Add your Anthropic API key in Settings → AI to use Glide Agent.", errorKind: "no-key" };
    client = createAnthropicClient(key);
  }

  const conv = (isId(req.conversationId) ? sess().get(req.conversationId) : undefined) ?? sess().create(isId(req.conversationId) ? req.conversationId : `c${runId}`, prompt);
  if (busy(conv)) return { ok: false, conversationId: conv.id, error: "Glide Agent is still working on this conversation — press esc to stop it first", errorKind: "bad-request" };

  runs.get(runId)?.controller.abort();
  const { model, effort } = aiChoice();
  const s = settings();
  const controller = new AbortController();
  const run: Run = {
    controller,
    conversationId: conv.id,
    hidden: false,
    lastEmit: 0,
    snapshot: { runId, conversationId: conv.id, prompt, status: "running", entries: [{ kind: "prompt", id: `${runId}-p`, text: prompt }], toolCalls: 0, maxToolCalls: MAX_TOOL_CALLS, model, startedAt: Date.now(), ...(s.readOnly ? { readOnly: true } : {}) },
  };
  runs.set(runId, run);
  sess().putRun(conv, run.snapshot);
  while (runs.size > KEEP_RUNS) {
    const oldest = [...runs.entries()].find(([, r]) => r.snapshot.status !== "running" && r.snapshot.status !== "confirming");
    if (!oldest) break;
    runs.delete(oldest[0]);
  }

  const ids = await refreshFeatureIds();
  const caps = createCapabilities({ ctx: c, catalogue, features: loadFeatures, featureIds: ids, onLauncherHidden: () => (run.hidden = true) });
  const context = [requestContext(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone), s.readOnly ? "Read-only mode is on: only look things up; you can't change anything." : ""].filter(Boolean).join("\n");
  let lastStatus = run.snapshot.status;
  let lastCount = 0;
  void runAgentFull({
    runId,
    conversationId: conv.id,
    prompt,
    history: conv.messages,
    client,
    tools: availableTools(ids),
    caps,
    model,
    effort,
    system: AGENT_SYSTEM_PROMPT,
    context,
    readOnly: s.readOnly,
    signal: controller.signal,
    isAllowed: (tool) => settings().allow[tool] === true,
    takeRateLimit: () => limiter.take(),
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
      sess().putRun(conv, snap);
      const structural = snap.status !== lastStatus || snap.entries.length !== lastCount;
      lastStatus = snap.status;
      lastCount = snap.entries.length;
      publish(run, structural);
    },
    describeError,
    isAbort,
  })
    .then((out) => {
      run.snapshot = out.snapshot;
      run.pending = undefined;
      conv.messages = out.messages;
      conv.undos.set(runId, out.undos);
      sess().putRun(conv, out.snapshot);
      sess().persist(conv);
      publish(run, true);
      c.emit("conversations");
      if (out.snapshot.status !== "cancelled") reopenView(runId, run);
    })
    .catch((err: unknown) => c.log("agent run crashed", err));
  return { ok: true, conversationId: conv.id };
}

function respond(runId: unknown, confirmationId: unknown, approve: unknown): boolean {
  if (!isId(runId)) return false;
  const run = runs.get(runId);
  if (!run?.pending || run.pending.id !== confirmationId) return false;
  const { resolve } = run.pending;
  run.pending = undefined;
  resolve(approve === true);
  return true;
}

function cancel(runId: unknown): boolean {
  if (!isId(runId)) return false;
  const run = runs.get(runId);
  if (!run) return false;
  run.controller.abort();
  run.pending?.resolve(false);
  run.pending = undefined;
  return true;
}

/** The run's current snapshot, from an active run or the conversation it belongs to. */
function findRun(runId: string): { conv?: LiveConversation; snap?: RunSnapshot } {
  const conv = sess().ofRun(runId);
  return { conv, snap: runs.get(runId)?.snapshot ?? conv?.runs.find((r) => r.runId === runId) };
}

function emitSnapshot(conv: LiveConversation, snap: RunSnapshot) {
  sess().putRun(conv, snap);
  const live = runs.get(snap.runId);
  if (live) live.snapshot = snap;
  need().emit("run", snap);
}

// --- undo & save as workflow ------------------------------------------------------

async function undo(runId: unknown, stepId?: unknown): Promise<UndoResult> {
  if (!isId(runId)) return { ok: false, undone: 0, failed: 0, message: "Unknown request" };
  const { conv, snap: found } = findRun(runId);
  if (!conv || !found) return { ok: false, undone: 0, failed: 0, message: "That request is no longer available" };
  if (found.status === "running" || found.status === "confirming") return { ok: false, undone: 0, failed: 0, message: "Wait until the request finishes (or press esc to stop it)" };
  const snap = JSON.parse(JSON.stringify(found)) as RunSnapshot;
  const fns = conv.undos.get(runId);
  const steps = snap.entries.flatMap((e) => (e.kind === "step" && e.step.undo?.state === "available" && (stepId === undefined || e.step.id === stepId) ? [e.step] : []));
  if (!steps.length) return { ok: false, undone: 0, failed: 0, message: "Nothing to undo" };
  let undone = 0;
  let failed = 0;
  const notes: string[] = [];
  // Newest first, like a stack.
  for (const st of steps.reverse()) {
    const fn = fns?.get(st.id);
    if (!fn || !st.undo) {
      failed++;
      if (st.undo) Object.assign(st.undo, { state: "failed", error: "Undo is only available until Glide restarts" });
      continue;
    }
    try {
      notes.push(await fn.run());
      st.undo.state = "done";
      fns?.delete(st.id);
      undone++;
    } catch (err) {
      st.undo.state = "failed";
      st.undo.error = err instanceof Error ? err.message : String(err);
      failed++;
    }
  }
  const after = snap.entries.flatMap((e) => (e.kind === "step" ? [e.step] : []));
  for (const e of snap.entries)
    if (e.kind === "summary") {
      e.undoable = after.filter((s) => s.undo?.state === "available").length;
      e.saveable = planWorkflow(after.map((step) => ({ step, workflow: step.workflow }))).ok;
    }
  const message = failed ? `Undid ${undone}, ${failed} couldn't be undone` : `Undid ${undone} change${undone === 1 ? "" : "s"}`;
  snap.entries.push({ kind: "notice", id: `${runId}-u${Date.now().toString(36)}`, text: `↶ ${message}${notes.length ? ` — ${notes.join("; ")}` : ""}`, tone: failed ? "warning" : "info" });
  emitSnapshot(conv, snap);
  sess().persist(conv);
  return { ok: undone > 0, undone, failed, message };
}

function saveAsWorkflow(runId: unknown, name: unknown): SaveWorkflowResult {
  if (!isId(runId)) return { ok: false, error: "Unknown request" };
  const { snap } = findRun(runId);
  if (!snap) return { ok: false, error: "That request is no longer available" };
  const steps = snap.entries.flatMap((e) => (e.kind === "step" ? [{ step: e.step, workflow: e.step.workflow }] : []));
  const planned = planWorkflow(steps);
  if (!planned.ok) return { ok: false, error: planned.error, unmapped: planned.unmapped };
  const wf = buildWorkflow(typeof name === "string" ? name.slice(0, 100) : "", snap.prompt, planned.actions, Date.now());
  need().store.saveWorkflow(wf);
  need().refreshCatalogue();
  return { ok: true, workflowId: wf.id, name: wf.name, actions: wf.actions.length };
}

// --- catalogue ------------------------------------------------------------------

function items(): SearchItem[] {
  return [
    {
      id: "agent:ask",
      kind: "command",
      kindLabel: "Agent",
      feature: ID,
      title: "Ask Glide Agent",
      subtitle: "Do it for me — arrange windows, start timers, open things… (⌘⏎ from any search)",
      icon: { kind: "emoji", value: "🪄" },
      keywords: ["agent", "ai", "do", "automate", "claude", "assistant", "command"],
      acceptsArgument: true,
      data: { type: "ask" },
    },
    {
      id: "agent:history",
      kind: "command",
      kindLabel: "Agent",
      feature: ID,
      title: "Glide Agent History",
      subtitle: "Search, resume or delete past agent conversations",
      icon: { kind: "emoji", value: "🕘" },
      keywords: ["agent", "history", "conversations", "resume"],
      data: { type: "history" },
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
  if (item.data?.type === "history") return [{ id: "history", title: "Open Agent History", icon: "🕘" }];
  if (item.data?.type !== "ask") return [];
  return [
    { id: "ask", title: "Ask Glide Agent", icon: "🪄" },
    { id: "settings", title: "Agent Settings…", icon: "⚙️", shortcut: "⌘⏎" },
    { id: "history", title: "Agent History", icon: "🕘" },
  ];
}

async function runAction(scored: ScoredItem, actionId: string): Promise<ExecuteResult> {
  if (actionId === "settings") return { ok: true, navigate: "settings/agent" };
  if (actionId === "history") return { ok: true, view: { id: "agent.history" } };
  if (actionId !== "ask") return { ok: false, error: `Unknown action ${actionId}` };
  const prompt = scored.argument?.trim() || undefined;
  const props: AgentViewProps = { prompt, fresh: !!prompt };
  return { ok: true, view: { id: VIEW, props: { ...props } } };
}

const toolInfo = (): ToolInfo[] =>
  TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, mutating: t.mutating, alwaysConfirm: t.alwaysConfirm, destructive: t.destructive, available: !t.requires || featureIds.has(t.requires) }));

/** "Run Glide Command": lets saved agent workflows run any catalogue item (window moves, commands…). */
const runItemAction: FeatureWorkflowAction = {
  id: RUN_ITEM_ACTION,
  title: "Run Glide Command",
  description: "Run a launcher item by id (window layouts, built-in commands, extensions) as if chosen in the launcher",
  icon: { kind: "emoji", value: "🪄" },
  category: "system",
  params: [
    { key: "item", label: "Item id", kind: "text", placeholder: "windows.left-half", required: true },
    { key: "argument", label: "Argument", kind: "text", placeholder: "{{input}}" },
  ],
  run: async (c, p) => {
    const id = (p.item ?? "").trim();
    if (!id) throw new Error("Choose a Glide command");
    if (id.startsWith("agent:")) throw new Error("A workflow can't run Glide Agent");
    const r = await c.executeItem(id, p.argument || undefined);
    if (!r.ok) throw new Error(r.error ?? `“${id}” failed`);
    return r.message ?? undefined;
  },
};

export const feature: FeatureModule = {
  id: ID,
  start(c) {
    ctx = c;
    catalogue = createCatalogueSource(c, loadFeatures);
    store = new ConversationStore(() => path.join(c.dataDir(), "conversations.json"));
    sessions = new Sessions({ store, sensitivity: () => SENSITIVITY, keepSensitive: () => settings().keepSensitive, saveHistory: () => settings().saveHistory });
    void refreshFeatureIds();
    if (mockPath()) c.log(`using scripted mock client from ${mockPath()}`);
  },
  stop() {
    for (const r of runs.values()) r.controller.abort();
    runs.clear();
    store?.flush();
  },
  items,
  actions,
  runAction,
  workflowActions: [runItemAction],
  methods: {
    start: (req) => start(req),
    respond: (runId, confirmationId, approve) => respond(runId, confirmationId, approve),
    cancel: (runId) => cancel(runId),
    /** The newest run still in progress (lets a freshly opened view re-attach to it). */
    activeRun: () => [...runs.values()].reverse().find((r) => r.snapshot.status === "running" || r.snapshot.status === "confirming")?.snapshot ?? null,
    getRun: (runId) => (isId(runId) ? (findRun(runId).snap ?? null) : null),
    getConversation: (id) => {
      if (!isId(id)) return null;
      const c = sess().get(id);
      return c ? sess().view(c) : null;
    },
    /** The conversation used most recently in this session (reopening the agent keeps context). */
    latestConversation: () => {
      const c = sess().latest();
      return c && c.runs.length ? sess().view(c) : null;
    },
    listConversations: (query) => sess().list(typeof query === "string" ? query.slice(0, 200) : ""),
    deleteConversation: (id) => {
      if (!isId(id)) return false;
      for (const r of runs.values()) if (r.conversationId === id) cancel(r.snapshot.runId);
      const ok = sess().delete(id);
      need().emit("conversations");
      return ok;
    },
    clearHistory: () => {
      const n = sess().clear();
      need().emit("conversations");
      return n;
    },
    undo: (runId, stepId) => undo(runId, stepId),
    saveAsWorkflow: (runId, name) => saveAsWorkflow(runId, name),
    /** ⌘⏎ in the launcher's root search: open the agent with that query as a new request. */
    openFromLauncher: (query) => {
      if (typeof query !== "string" || !query.trim() || !settings().launcherShortcut) return false;
      const props: AgentViewProps = { prompt: query.trim().slice(0, 4000), fresh: true };
      need().openView({ id: VIEW, props: { ...props } });
      return true;
    },
    status: () => status(),
    getSettings: () => settings(),
    setSettings: (patch) => setSettings(patch),
    listTools: async () => {
      await refreshFeatureIds();
      return toolInfo();
    },
    openAiSettings: () => need().openSettings("ai"),
  },
};
