/**
 * Automations (Shortcuts-style "Personal Automations"): a trigger + a target (workflow or catalogue command).
 * Pure module — no Electron/fs imports — so the renderer can import types/helpers and tests run in plain node.
 */
import type { ActionType, Workflow, WorkflowAction } from "@shared/types";

export type AppEvent = "launched" | "quit" | "activated";
export type WifiEvent = "joined" | "left" | "changed";
export type PowerEvent = "ac" | "battery" | "below" | "above";
export type DisplayEvent = "connected" | "disconnected" | "any";
export type FolderEvent = "added" | "any";

export type Trigger =
  /** time "HH:MM" (24 h, local); days 0=Sun…6=Sat, empty = every day */
  | { kind: "time"; time: string; days: number[] }
  | { kind: "interval"; minutes: number }
  /** app: name or bundle id, "" = any app */
  | { kind: "app"; event: AppEvent; app: string }
  /** network: SSID or the router signature shown by "Use Current Network"; "" = any network */
  | { kind: "wifi"; event: WifiEvent; network: string }
  | { kind: "power"; event: PowerEvent; percent: number }
  | { kind: "display"; event: DisplayEvent }
  | { kind: "folder"; path: string; event: FolderEvent }
  | { kind: "launch" }
  | { kind: "hotkey"; accelerator: string };

export type TriggerKind = Trigger["kind"];

export type Target =
  | { kind: "workflow"; workflowId: string }
  /** argument may contain {{input}} (the trigger's value, e.g. the added file's path) */
  | { kind: "command"; itemId: string; title: string; argument: string };

export interface RunRecord {
  id: string;
  at: number;
  /** human-readable reason, e.g. "Every 5 minutes" or "Run Now" */
  trigger: string;
  status: "ok" | "error" | "skipped";
  message: string;
  input?: string;
  durationMs: number;
  manual?: boolean;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  askBeforeRunning: boolean;
  trigger: Trigger;
  target: Target;
  createdAt: number;
  updatedAt: number;
  /** newest first, at most LOG_LIMIT */
  log: RunRecord[];
}

/** Events produced by the event sources; the engine matches them against triggers. */
export type TriggerEvent =
  | { type: "app"; event: AppEvent; name: string; bundleId?: string }
  | { type: "wifi"; from: string | null; to: string | null }
  | { type: "power"; source: "ac" | "battery"; percent: number; prevSource: "ac" | "battery"; prevPercent: number }
  | { type: "display"; event: "connected" | "disconnected"; name: string }
  | { type: "folder"; path: string; event: "added" | "changed"; file: string }
  | { type: "launch" }
  | { type: "hotkey"; automationId: string };

export const LOG_LIMIT = 50;
export const RATE_LIMIT_MS = 10_000;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export const TRIGGER_KINDS: Array<{ kind: TriggerKind; title: string; icon: string }> = [
  { kind: "time", title: "Time of Day", icon: "🕘" },
  { kind: "interval", title: "Every N Minutes", icon: "🔁" },
  { kind: "app", title: "App", icon: "🧩" },
  { kind: "wifi", title: "Wi‑Fi Network", icon: "📶" },
  { kind: "power", title: "Power & Battery", icon: "🔋" },
  { kind: "display", title: "Display", icon: "🖥️" },
  { kind: "folder", title: "Folder", icon: "📁" },
  { kind: "launch", title: "Glide Launches", icon: "🚀" },
  { kind: "hotkey", title: "Global Hotkey", icon: "⌨️" },
];

/** Workflow actions that touch other apps, the network or files — default "ask before running" for these. */
export const RISKY_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>(["runShell", "runAppleScript", "typeText", "httpRequest", "openFile", "setClipboard"]);

export function defaultTrigger(kind: TriggerKind): Trigger {
  switch (kind) {
    case "time":
      return { kind, time: "09:00", days: [] };
    case "interval":
      return { kind, minutes: 15 };
    case "app":
      return { kind, event: "launched", app: "" };
    case "wifi":
      return { kind, event: "joined", network: "" };
    case "power":
      return { kind, event: "below", percent: 20 };
    case "display":
      return { kind, event: "connected" };
    case "folder":
      return { kind, path: "~/Downloads", event: "added" };
    case "launch":
      return { kind };
    case "hotkey":
      return { kind, accelerator: "" };
  }
}

// --- validation -------------------------------------------------------------------

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : fallback);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizeTime(v: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(v).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

export function normalizeTrigger(raw: unknown): Trigger | null {
  if (!isObj(raw)) return null;
  const kind = oneOf(raw.kind, TRIGGER_KINDS.map((k) => k.kind), "launch");
  if (raw.kind !== kind) return null;
  switch (kind) {
    case "time": {
      const time = normalizeTime(raw.time);
      if (!time) return null;
      const days = Array.isArray(raw.days) ? [...new Set(raw.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
      return { kind, time, days: days.length === 7 ? [] : days };
    }
    case "interval": {
      const minutes = Math.round(num(raw.minutes, 15));
      return { kind, minutes: Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, minutes)) };
    }
    case "app":
      return { kind, event: oneOf(raw.event, ["launched", "quit", "activated"] as const, "launched"), app: str(raw.app).trim() };
    case "wifi":
      return { kind, event: oneOf(raw.event, ["joined", "left", "changed"] as const, "joined"), network: str(raw.network).trim() };
    case "power":
      return { kind, event: oneOf(raw.event, ["ac", "battery", "below", "above"] as const, "below"), percent: Math.min(100, Math.max(1, Math.round(num(raw.percent, 20)))) };
    case "display":
      return { kind, event: oneOf(raw.event, ["connected", "disconnected", "any"] as const, "connected") };
    case "folder": {
      const path = str(raw.path).trim();
      return path ? { kind, path, event: oneOf(raw.event, ["added", "any"] as const, "added") } : null;
    }
    case "launch":
      return { kind };
    case "hotkey": {
      const accelerator = str(raw.accelerator).trim();
      return accelerator ? { kind, accelerator } : null;
    }
  }
}

export function normalizeTarget(raw: unknown): Target | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "workflow") {
    const workflowId = str(raw.workflowId).trim();
    return workflowId ? { kind: "workflow", workflowId } : null;
  }
  if (raw.kind === "command") {
    const itemId = str(raw.itemId).trim();
    return itemId ? { kind: "command", itemId, title: str(raw.title, itemId), argument: str(raw.argument) } : null;
  }
  return null;
}

function normalizeRecord(raw: unknown): RunRecord | null {
  if (!isObj(raw) || typeof raw.at !== "number") return null;
  return {
    id: str(raw.id, `r${raw.at}`),
    at: raw.at,
    trigger: str(raw.trigger),
    status: oneOf(raw.status, ["ok", "error", "skipped"] as const, "error"),
    message: str(raw.message),
    input: typeof raw.input === "string" ? raw.input : undefined,
    durationMs: num(raw.durationMs, 0),
    manual: raw.manual === true ? true : undefined,
  };
}

export type ValidationResult = { ok: true; automation: Automation } | { ok: false; error: string };

/** Validate untrusted input (disk or renderer). `now` stamps missing timestamps. */
export function validateAutomation(raw: unknown, now: number): ValidationResult {
  if (!isObj(raw)) return { ok: false, error: "Invalid automation" };
  const trigger = normalizeTrigger(raw.trigger);
  if (!trigger) {
    const kind = isObj(raw.trigger) ? raw.trigger.kind : undefined;
    return { ok: false, error: kind === "time" ? "Enter a time like 09:00" : kind === "folder" ? "Choose a folder" : kind === "hotkey" ? "Record a hotkey" : "Choose a trigger" };
  }
  const target = normalizeTarget(raw.target);
  if (!target) return { ok: false, error: "Choose a workflow or command to run" };
  const id = str(raw.id).trim() || newId("a", now);
  const log = Array.isArray(raw.log) ? raw.log.map(normalizeRecord).filter((r): r is RunRecord => !!r).slice(0, LOG_LIMIT) : [];
  return {
    ok: true,
    automation: {
      id,
      name: str(raw.name).trim() || describeTrigger(trigger),
      enabled: raw.enabled !== false,
      askBeforeRunning: raw.askBeforeRunning === true,
      trigger,
      target,
      createdAt: num(raw.createdAt, now),
      updatedAt: num(raw.updatedAt, now),
      log,
    },
  };
}

let seq = 0;
export function newId(prefix: string, now: number): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}${now.toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

// --- describing -------------------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeDays(days: number[]): string {
  if (!days.length || days.length === 7) return "Every day";
  const key = [...days].sort().join("");
  if (key === "12345") return "Weekdays";
  if (key === "06") return "Weekends";
  return [...days].sort().map((d) => DAY_NAMES[d]).join(", ");
}

const quote = (s: string) => `“${s}”`;

export function describeTrigger(t: Trigger): string {
  switch (t.kind) {
    case "time":
      return `${describeDays(t.days)} at ${t.time}`;
    case "interval":
      return t.minutes === 1 ? "Every minute" : t.minutes % 60 === 0 ? `Every ${t.minutes / 60 === 1 ? "hour" : `${t.minutes / 60} hours`}` : `Every ${t.minutes} minutes`;
    case "app": {
      const who = t.app ? quote(t.app) : "any app";
      return t.event === "launched" ? `When ${who} launches` : t.event === "quit" ? `When ${who} quits` : `When ${who} becomes active`;
    }
    case "wifi": {
      const net = t.network ? `Wi‑Fi ${quote(t.network)}` : "a Wi‑Fi network";
      return t.event === "joined" ? `When joining ${net}` : t.event === "left" ? `When leaving ${net}` : "When the Wi‑Fi network changes";
    }
    case "power":
      return t.event === "ac" ? "When connected to power" : t.event === "battery" ? "When switching to battery" : t.event === "below" ? `When battery drops to ${t.percent}%` : `When battery charges to ${t.percent}%`;
    case "display":
      return t.event === "connected" ? "When a display is connected" : t.event === "disconnected" ? "When a display is disconnected" : "When displays change";
    case "folder":
      return t.event === "added" ? `When a file is added to ${t.path}` : `When ${t.path} changes`;
    case "launch":
      return "When Glide launches";
    case "hotkey":
      return `Hotkey ${t.accelerator}`;
  }
}

export function describeTarget(target: Target, workflows: Pick<Workflow, "id" | "name">[]): string {
  if (target.kind === "workflow") {
    const wf = workflows.find((w) => w.id === target.workflowId);
    return wf ? `Run workflow ${quote(wf.name)}` : "Run a missing workflow";
  }
  return `Run ${quote(target.title)}${target.argument ? ` with ${quote(target.argument)}` : ""}`;
}

// --- risk -------------------------------------------------------------------------

function actionsAreRisky(actions: WorkflowAction[], getWorkflow: (id: string) => Workflow | undefined, depth: number): boolean {
  for (const a of actions) {
    if (a.disabled) continue;
    if (RISKY_ACTIONS.has(a.type)) return true;
    if (a.type === "runWorkflow") {
      const sub = getWorkflow(a.params.workflowId ?? "");
      if (!sub || depth > 4 || actionsAreRisky(sub.actions, getWorkflow, depth + 1)) return true;
    }
    if (a.type === "condition" && (actionsAreRisky(a.then ?? [], getWorkflow, depth) || actionsAreRisky(a.else ?? [], getWorkflow, depth))) return true;
  }
  return false;
}

/** Whether running the target unattended could change things outside Glide (default for "ask before running"). */
export function isRiskyTarget(target: Target, workflows: Workflow[]): boolean {
  if (target.kind === "command") return !/^(app|quicklink):/.test(target.itemId);
  const byId = (id: string) => workflows.find((w) => w.id === id);
  const wf = byId(target.workflowId);
  return !wf || actionsAreRisky(wf.actions, byId, 0);
}

// --- matching ---------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, " ").replace(/\.app$/, "").trim();
const sameApp = (pattern: string, name: string, bundleId?: string) => !pattern || norm(pattern) === norm(name) || (!!bundleId && pattern.toLowerCase() === bundleId.toLowerCase());
const sameNetwork = (pattern: string, net: string | null) => net !== null && (!pattern || pattern.toLowerCase() === net.toLowerCase());

export function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? `${home}${p.slice(1)}` : p;
}

/**
 * Does `event` fire `trigger`? Returns the input passed to the target (file path, app name, …) or null.
 * Time and interval triggers are scheduled by the engine, never matched against events.
 */
export function matchEvent(trigger: Trigger, event: TriggerEvent, automationId: string, home = ""): string | null {
  switch (trigger.kind) {
    case "app":
      return event.type === "app" && event.event === trigger.event && sameApp(trigger.app, event.name, event.bundleId) ? event.name : null;
    case "wifi": {
      if (event.type !== "wifi" || event.from === event.to) return null;
      if (trigger.event === "changed") return event.to ?? "";
      if (trigger.event === "joined") return sameNetwork(trigger.network, event.to) ? event.to : null;
      return sameNetwork(trigger.network, event.from) ? (event.from ?? "") : null;
    }
    case "power": {
      if (event.type !== "power") return null;
      const pct = String(event.percent);
      if (trigger.event === "ac") return event.source === "ac" && event.prevSource !== "ac" ? pct : null;
      if (trigger.event === "battery") return event.source === "battery" && event.prevSource !== "battery" ? pct : null;
      // Crossing a threshold, not merely being past it, so the automation fires once per crossing.
      if (trigger.event === "below") return event.source === "battery" && event.percent <= trigger.percent && (event.prevPercent > trigger.percent || event.prevSource !== "battery") ? pct : null;
      return event.percent >= trigger.percent && event.prevPercent < trigger.percent ? pct : null;
    }
    case "display":
      return event.type === "display" && (trigger.event === "any" || trigger.event === event.event) ? event.name : null;
    case "folder": {
      if (event.type !== "folder") return null;
      const want = expandHome(trigger.path, home).replace(/\/+$/, "");
      if (want !== event.path.replace(/\/+$/, "")) return null;
      if (trigger.event === "added" && event.event !== "added") return null;
      return event.file;
    }
    case "launch":
      return event.type === "launch" ? "" : null;
    case "hotkey":
      return event.type === "hotkey" && event.automationId === automationId ? "" : null;
    case "time":
    case "interval":
      return null;
  }
}

export function describeEvent(event: TriggerEvent): string {
  switch (event.type) {
    case "app":
      return `${event.name} ${event.event === "activated" ? "became active" : event.event}`;
    case "wifi":
      return event.to ? `Joined ${event.to}` : `Left ${event.from ?? "Wi‑Fi"}`;
    case "power":
      return `${event.source === "ac" ? "Power adapter" : "Battery"} · ${event.percent}%`;
    case "display":
      return `Display ${event.event}: ${event.name}`;
    case "folder":
      return `${event.event === "added" ? "Added" : "Changed"} ${event.file}`;
    case "launch":
      return "Glide launched";
    case "hotkey":
      return "Hotkey pressed";
  }
}

// --- state shared with the renderer ---------------------------------------------------

export interface PendingConfirmation {
  id: string;
  automationId: string;
  name: string;
  reason: string;
  input: string;
  at: number;
  expiresAt: number;
}

export interface AutomationView extends Automation {
  nextRun: number | null;
  running: boolean;
  /** e.g. a folder that can't be watched or a hotkey macOS refused */
  problem?: string;
  triggerText: string;
  targetText: string;
}

export interface AutomationsState {
  automations: AutomationView[];
  pending: PendingConfirmation[];
  workflows: Array<{ id: string; name: string; risky: boolean }>;
  /** event sources currently running (diagnostics) */
  sources: string[];
  now: number;
}

export type SaveResult = { ok: true; automation: Automation } | { ok: false; error: string };
