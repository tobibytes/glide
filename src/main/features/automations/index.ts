/**
 * Automations: event-triggered workflows (like Shortcuts' Personal Automations).
 * model.ts (types/validation/matching) · schedule.ts (time math) · engine.ts (rate limit, ask, run, log)
 * · sources.ts (app/Wi-Fi/power/display/folder/hotkey watchers) · persist.ts (automations.json in dataDir).
 */
import { currentWifiSsid } from "../../native/wifi";
import os from "node:os";
import { app, dialog, Notification, powerMonitor, screen } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import { exec } from "../../util/exec";
import type { FeatureContext, FeatureModule } from "../types";
import { AutomationEngine, type FireResult, type RunOutcome } from "./engine";
import {
  describeTarget, describeTrigger, isRiskyTarget, newId, normalizeTarget, type Automation, type AutomationsState, type PendingConfirmation, type SaveResult, type TriggerEvent,
} from "./model";
import { debouncedSaver, loadAutomations, saveAutomations } from "./persist";
import { EventSources } from "./sources";

const CONFIRM_TIMEOUT_MS = 5 * 60_000;
const TICK_MS = 1000;
const LAUNCH_DELAY_MS = 3000;

let ctx: FeatureContext | undefined;
let engine: AutomationEngine | undefined;
let sources: EventSources | undefined;
let saver: ReturnType<typeof debouncedSaver> | undefined;
let ticker: NodeJS.Timeout | undefined;
let problems: Record<string, string> = {};
let lastCatalogueKey = "";
const pending = new Map<string, PendingConfirmation & { resolve(run: boolean): void; timer: NodeJS.Timeout; note?: Notification }>();

const str = (v: unknown) => (typeof v === "string" ? v : "");

function workflows() {
  return ctx?.getData().workflows ?? [];
}

function state(): AutomationsState {
  const wfs = workflows();
  return {
    automations: (engine?.all() ?? []).map((a) => ({
      ...a,
      nextRun: engine?.nextRun(a.id) ?? null,
      running: engine?.isRunning(a.id) ?? false,
      problem: problems[a.id],
      triggerText: describeTrigger(a.trigger),
      targetText: describeTarget(a.target, wfs),
    })),
    pending: [...pending.values()].map(({ resolve: _r, timer: _t, note: _n, ...p }) => p),
    workflows: wfs.map((w) => ({ id: w.id, name: w.name || "Untitled", risky: isRiskyTarget({ kind: "workflow", workflowId: w.id }, wfs) })),
    sources: sources?.active() ?? [],
    now: Date.now(),
  };
}

function onChanged(list: Automation[]) {
  if (!ctx) return;
  saver?.schedule(list);
  problems = sources?.sync(list) ?? {};
  // Rebuild the catalogue only when something its items show changed (not on every run start).
  const key = JSON.stringify(list.map((a) => [a.id, a.name, a.enabled, a.trigger, a.log[0]?.id]));
  if (key !== lastCatalogueKey) {
    lastCatalogueKey = key;
    ctx.refreshCatalogue();
  }
  ctx.emit("state", state());
}

async function runTarget(a: Automation, input: string): Promise<RunOutcome> {
  if (!ctx) return { ok: false, message: "Glide is shutting down" };
  if (a.target.kind === "workflow") {
    const id = a.target.workflowId;
    const wf = workflows().find((w) => w.id === id);
    if (!wf) return { ok: false, message: "The workflow no longer exists" };
    const res = await ctx.runtime.run(wf, input);
    if (!res.ok) return { ok: false, message: res.log.find((l) => l.status === "error")?.error ?? "The workflow failed" };
    const result = (res.result ?? "").trim();
    return { ok: true, message: result ? `Finished · ${result.length > 120 ? `${result.slice(0, 120)}…` : result}` : `Finished (${res.log.length} action${res.log.length === 1 ? "" : "s"})` };
  }
  const argument = a.target.argument.replace(/\{\{\s*input\s*\}\}/g, input);
  const res = await ctx.executeItem(a.target.itemId, argument || undefined);
  return res.ok ? { ok: true, message: res.message || "Done" } : { ok: false, message: res.error || res.message || "Failed" };
}

function settle(id: string, run: boolean) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  p.note?.close();
  p.resolve(run);
  ctx?.emit("state", state());
  return true;
}

/** "Ask before running": a notification with Run/Skip, mirrored in the Automations view. Unanswered = skipped. */
function confirm(a: Automation, input: string, reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = newId("p", Date.now());
    const timer = setTimeout(() => settle(id, false), CONFIRM_TIMEOUT_MS);
    const entry = { id, automationId: a.id, name: a.name, reason, input, at: Date.now(), expiresAt: Date.now() + CONFIRM_TIMEOUT_MS, resolve, timer, note: undefined as Notification | undefined };
    pending.set(id, entry);
    if (Notification.isSupported()) {
      const note = new Notification({
        title: `Run “${a.name}”?`,
        body: `${reason}${input ? `\n${input}` : ""}\nClick to review in Glide.`,
        silent: true,
        actions: [{ type: "button", text: "Run" }],
        closeButtonText: "Skip",
      });
      note.on("action", () => settle(id, true));
      note.on("click", () => ctx?.openView({ id: "automations.list", props: { select: `pending:${id}` } }));
      entry.note = note;
      note.show();
    }
    ctx?.emit("state", state());
  });
}

/** Unattended runs that fail get a notification (Run Now failures show as a toast instead). */
function notifyFailures(results: FireResult[]) {
  for (const r of results) {
    if (typeof r !== "object" || r.status !== "error" || r.manual || !Notification.isSupported()) continue;
    const a = engine?.all().find((x) => x.log.some((l) => l.id === r.id));
    if (!a) continue;
    const n = new Notification({ title: `Automation “${a.name}” failed`, body: r.message, silent: true });
    n.on("click", () => ctx?.openView({ id: "automations.list", props: { select: a.id } }));
    n.show();
  }
}

function save(raw: unknown): SaveResult {
  if (!engine) return { ok: false, error: "Automations are not ready" };
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  // New automations default to "ask before running" when the target can change things outside Glide.
  if (r.askBeforeRunning === undefined) {
    const target = normalizeTarget(r.target);
    r.askBeforeRunning = target ? isRiskyTarget(target, workflows()) : true;
  }
  return engine.upsert(r);
}

function resultMessage(a: Automation | undefined, r: FireResult): ExecuteResult {
  if (r === "missing") return { ok: false, error: "That automation no longer exists" };
  if (r === "busy") return { ok: false, error: `“${a?.name}” is already running` };
  if (typeof r !== "object") return { ok: false, error: `Not run (${r})` };
  return r.status === "ok" ? { ok: true, message: `“${a?.name}”: ${r.message}` } : { ok: false, error: `“${a?.name}”: ${r.message}` };
}

async function runNow(id: string): Promise<ExecuteResult> {
  if (!engine) return { ok: false, error: "Automations are not ready" };
  return resultMessage(engine.get(id), await engine.runNow(id));
}

function setEnabled(id: string, enabled: boolean): ExecuteResult {
  const a = engine?.setEnabled(id, enabled);
  return a ? { ok: true, message: `“${a.name}” ${enabled ? "enabled" : "disabled"}` } : { ok: false, error: "That automation no longer exists" };
}

const item = (id: string, title: string, subtitle: string, icon: string, keywords: string[], data: Record<string, unknown>): SearchItem => ({
  id: `automations:${id}`,
  kind: "command",
  kindLabel: "Automation",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "automations",
  data,
});

function lastRunText(a: Automation): string {
  const r = a.log[0];
  if (!r) return "never run";
  const when = new Date(r.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `last ${r.status === "ok" ? "ran" : r.status === "skipped" ? "skipped" : "failed"} ${when}`;
}

export const feature: FeatureModule = {
  id: "automations",
  start(c) {
    ctx = c;
    const dir = c.dataDir();
    saver = debouncedSaver((list) => {
      try {
        saveAutomations(dir, list);
      } catch (err) {
        c.log("could not save automations", err);
      }
    });
    sources = new EventSources({
      wifiSsid: () => currentWifiSsid(c.helper),
      emit: (e: TriggerEvent) => void engine?.handleEvent(e).then(notifyFailures),
      run: async (cmd, args) => {
        const res = await exec(cmd, args, { timeoutMs: 5000 });
        if (res.code !== 0) throw new Error(res.stderr || `${cmd} exited ${res.code}`);
        return res.stdout;
      },
      registerHotkey: (key, accel, handler) => c.registerHotkey(`automation:${key}`, accel, handler),
      screen,
      powerMonitor,
      home: os.homedir(),
      log: c.log,
    });
    engine = new AutomationEngine(
      {
        now: Date.now,
        run: runTarget,
        confirm,
        persist: () => undefined, // saving happens in onChanged (debounced)
        changed: onChanged,
        home: os.homedir(),
      },
      loadAutomations(dir),
    );
    problems = sources.sync(engine.all());
    ticker = setInterval(() => {
      void engine?.tick().then(notifyFailures);
    }, TICK_MS);
    setTimeout(() => void engine?.handleEvent({ type: "launch" }), LAUNCH_DELAY_MS);
    app.on("before-quit", () => saver?.flush());
  },
  stop() {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    sources?.stop();
    for (const id of [...pending.keys()]) settle(id, false);
    saver?.flush();
  },
  items() {
    const list = engine?.all() ?? [];
    const on = list.filter((a) => a.enabled).length;
    return [
      item("create", "Create Automation", "Run a workflow or command when something happens", "✨", ["automation", "trigger", "schedule", "when", "personal automation", "new", "cron"], { action: "create" }),
      item("list", "Automations", list.length ? `${list.length} automation${list.length === 1 ? "" : "s"} · ${on} on` : "Event-triggered workflows", "⚡️", ["automation", "automations", "triggers", "schedule", "cron", "rules"], { action: "list" }),
      ...list.map((a) =>
        item(`a:${a.id}`, a.name, `${describeTrigger(a.trigger)} · ${a.enabled ? "on" : "off"} · ${lastRunText(a)}`, a.enabled ? "⚡️" : "💤", ["automation", "run", "enable", "disable"], { action: "automation", automationId: a.id }),
      ),
    ];
  },
  actions(i): ItemAction[] {
    switch (i.data?.action) {
      case "create":
        return [{ id: "create", title: "Create Automation", shortcut: "⏎" }, { id: "list", title: "Show Automations", shortcut: "⌘⏎" }];
      case "list":
        return [{ id: "list", title: "Show Automations", shortcut: "⏎" }, { id: "create", title: "Create Automation", shortcut: "⌘⏎" }];
      case "automation": {
        const a = engine?.get(str(i.data.automationId));
        return [
          { id: "run", title: "Run Now", shortcut: "⏎", icon: "▶️" },
          { id: "toggle", title: a?.enabled === false ? "Enable Automation" : "Disable Automation", shortcut: "⌘⏎" },
          { id: "edit", title: "Edit Automation", shortcut: "⌘E" },
          { id: "show", title: "Show Run Log", shortcut: "⌘L" },
          { id: "delete", title: "Delete Automation", shortcut: "⌃X", destructive: true },
        ];
      }
    }
    return [];
  },
  async runAction(scored, actionId) {
    const id = str(scored.item.data?.automationId);
    switch (actionId) {
      case "create":
        ctx?.openSettings("automations#new");
        return { ok: true, hide: true };
      case "list":
        return { ok: true, view: { id: "automations.list" } };
      case "run":
        return runNow(id);
      case "toggle": {
        const a = engine?.get(id);
        return a ? setEnabled(id, !a.enabled) : { ok: false, error: "That automation no longer exists" };
      }
      case "edit":
        ctx?.openSettings(`automations#${encodeURIComponent(id)}`);
        return { ok: true, hide: true };
      case "show":
        return { ok: true, view: { id: "automations.list", props: { select: id } } };
      case "delete": {
        const a = engine?.get(id);
        return engine?.remove(id) ? { ok: true, message: `Deleted “${a?.name}”` } : { ok: false, error: "That automation no longer exists" };
      }
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    state: () => state(),
    save: (raw: unknown) => save(raw),
    remove: (id: unknown) => (engine?.remove(str(id)) ? { ok: true, message: "Automation deleted" } : { ok: false, error: "That automation no longer exists" }),
    setEnabled: (id: unknown, enabled: unknown) => setEnabled(str(id), enabled === true),
    runNow: (id: unknown) => runNow(str(id)),
    clearLog: (id: unknown) => {
      engine?.clearLog(str(id));
      return { ok: true, message: "Log cleared" };
    },
    answer: (pendingId: unknown, run: unknown) => (settle(str(pendingId), run === true) ? { ok: true, message: run === true ? "Running…" : "Skipped" } : { ok: false, error: "That request has expired" }),
    currentNetwork: async () => (await sources?.currentNetwork()) ?? null,
    chooseFolder: async () => {
      const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], title: "Watch Folder" });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    /** Dev/test hook (only with GLIDE_AUTOMATIONS_DEBUG=1): feed a synthetic trigger event. */
    debugEvent: async (event: unknown) => {
      if (process.env.GLIDE_AUTOMATIONS_DEBUG !== "1" || !engine) return { ok: false, error: "debug hooks are off" };
      const results = await engine.handleEvent(event as TriggerEvent);
      return { ok: true, results };
    },
  },
};
