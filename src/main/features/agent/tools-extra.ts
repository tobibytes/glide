/**
 * Agent tools over other Glide features: automations, window layouts, text transforms, browser
 * bookmarks, processes, system status, reminders, clipboard history, snippets, quicklinks,
 * macOS Shortcuts and appearance. Capabilities are wired in capabilities-extra.ts.
 */
import { describeTarget, describeTrigger, normalizeTarget, normalizeTrigger, type Trigger } from "../automations/model";
import type { AgentCapabilities } from "./tools";
import { clip, defineTool, featureStep, intArg, isErr, opText, quote, reqStr, str, ToolFailure, type AgentToolOf, type OpResult } from "./tooling";

export interface AutomationInfo {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  target: string;
}

export interface LayoutInfo {
  id: string;
  name: string;
  summary: string;
}

export interface ProcessRow {
  pid: number;
  name: string;
  cpu: number;
  rssKb: number;
  user: string;
  command?: string;
}

export interface ProcessCheck {
  exists: boolean;
  name: string;
  command: string;
  /** Protected processes are never killed by the agent, even with confirmation. */
  protected: boolean;
  reason?: string;
}

export interface AppearanceInfo {
  mode: "system" | "dark" | "light";
  darkTheme: string;
  lightTheme: string;
  presets: Array<{ id: string; name: string; scheme: "dark" | "light" }>;
}

export interface ExtraCapabilities {
  hasFeature(id: string): boolean;
  listAutomations(): Promise<AutomationInfo[]>;
  createAutomation(spec: { name: string; trigger: Trigger; target: Record<string, unknown>; askBeforeRunning: boolean }): Promise<OpResult & { id?: string }>;
  deleteAutomation(id: string): Promise<OpResult>;
  runAutomation(id: string): Promise<OpResult>;
  listLayouts(): Promise<LayoutInfo[]>;
  restoreLayout(id: string): Promise<OpResult>;
  saveLayout(name: string): Promise<OpResult & { id?: string; summary?: string }>;
  deleteLayout(id: string): Promise<OpResult>;
  listTransforms(): Array<{ id: string; title: string; category: string }>;
  applyTransform(id: string, input: string): { ok: true; output: string } | { ok: false; error: string };
  searchBookmarks(query: string, limit: number): Promise<{ ok: boolean; items?: Array<{ title: string; url: string; folder?: string; browser?: string }>; error?: string }>;
  listProcesses(): Promise<ProcessRow[]>;
  checkProcess(pid: number): Promise<ProcessCheck>;
  killProcess(pid: number, force: boolean, expectedCommand: string): Promise<OpResult>;
  systemStatus(): Promise<string>;
  createReminder(r: { title: string; due?: string; notes?: string }): Promise<OpResult & { id?: string }>;
  deleteReminder?(id: string): Promise<OpResult>;
  clipboardHistory(query: string, limit: number): Promise<Array<{ type: string; title: string; preview: string; copiedAt: number }>>;
  createSnippet(s: { name: string; text: string; keyword?: string }): Promise<OpResult & { id?: string }>;
  deleteSnippet(id: string): Promise<OpResult>;
  createQuicklink(q: { name: string; url: string }): Promise<OpResult & { id?: string }>;
  deleteQuicklink(id: string): Promise<OpResult>;
  runShortcut(name: string, input?: string): Promise<OpResult & { output?: string }>;
  appearance(): Promise<AppearanceInfo>;
  setAppearance(p: { mode?: "system" | "dark" | "light"; preset?: string }): Promise<OpResult>;
  restoreAppearance(prev: AppearanceInfo): Promise<OpResult>;
}

const define = defineTool<AgentCapabilities>();
const none = { type: "object" as const, properties: {}, additionalProperties: false as const };

// --- automations ------------------------------------------------------------------

const TRIGGER_HELP =
  'Trigger object. kind "time" {time:"HH:MM", days:[0-6] (0=Sun, empty=every day)}, "interval" {minutes}, "app" {event:"launched"|"quit"|"activated", app}, "wifi" {event:"joined"|"left"|"changed", network}, "power" {event:"ac"|"battery"|"below"|"above", percent}, "display" {event:"connected"|"disconnected"|"any"}, "folder" {path, event:"added"|"any"}, "launch" {}.';

const listAutomations = define<Record<string, never>>({
  name: "list_automations",
  title: "List Automations",
  description: "List the user's Glide automations (trigger → workflow or command) with ids for run_automation.",
  mutating: false,
  requires: "automations",
  schema: none,
  parse: () => ({}),
  describe: () => "List automations",
  async run(_a, caps) {
    const list = await caps.listAutomations();
    return list.length ? clip(JSON.stringify(list)) : "The user has no automations.";
  },
});

const createAutomation = define<{ name: string; trigger: Trigger; target: Record<string, unknown>; targetText: string; ask: boolean }>({
  name: "create_automation",
  title: "Create Automation",
  description: `Create a Glide automation that runs a workflow (workflow_id from list_workflows) or a catalogue command (item_id from search_catalogue) when a trigger fires. ${TRIGGER_HELP}`,
  mutating: true,
  requires: "automations",
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      trigger: { type: "object", description: TRIGGER_HELP },
      workflow_id: { type: "string" },
      item_id: { type: "string" },
      argument: { type: "string", description: "Argument for item_id commands; may contain {{input}}" },
      ask_before_running: { type: "boolean", description: "Ask the user each time it fires (default true for anything risky)" },
    },
    required: ["trigger"],
    additionalProperties: false,
  },
  parse(input) {
    const trigger = normalizeTrigger(input.trigger);
    if (!trigger) return `Invalid trigger. ${TRIGGER_HELP}`;
    if (trigger.kind === "hotkey") return "Hotkey automations must be created in Settings → Automations";
    const wf = str(input, "workflow_id", { max: 200 });
    const item = str(input, "item_id", { max: 2000 });
    const arg = str(input, "argument", { max: 2000 });
    const name = str(input, "name", { max: 120 });
    for (const v of [wf, item, arg, name]) if (isErr(v)) return v.error;
    if (!wf === !item) return "Give exactly one of workflow_id or item_id";
    if (typeof item === "string" && item.startsWith("agent:")) return "An automation cannot run the agent";
    const target = wf ? { kind: "workflow", workflowId: wf } : { kind: "command", itemId: item, title: item, argument: (arg as string | undefined) ?? "" };
    if (!normalizeTarget(target)) return "Invalid target";
    return { name: ((name as string | undefined) ?? "").trim(), trigger, target, targetText: wf ? `workflow ${wf as string}` : `command ${item as string}`, ask: input.ask_before_running !== false };
  },
  async describe(a, caps) {
    let target = a.targetText;
    if (a.target.kind === "workflow") {
      const wf = caps.listWorkflows().find((w) => w.id === a.target.workflowId);
      if (wf) target = describeTarget({ kind: "workflow", workflowId: wf.id }, [{ id: wf.id, name: wf.name }]);
    } else {
      const hit = await caps.findItem(String(a.target.itemId));
      if (hit) target = `run ${quote(hit.title)}`;
    }
    return `Create the automation ${a.name ? `${quote(a.name)} ` : ""}— ${describeTrigger(a.trigger)} → ${target}${a.ask ? " (asks before each run)" : ""}`;
  },
  async run(a, caps) {
    if (a.target.kind === "command" && a.target.title === a.target.itemId) {
      const hit = await caps.findItem(String(a.target.itemId));
      if (!hit) throw new ToolFailure(`No item with id ${String(a.target.itemId)}. Search the catalogue first.`);
      a.target.title = hit.title;
    }
    if (a.target.kind === "workflow" && !caps.listWorkflows().some((w) => w.id === a.target.workflowId)) throw new ToolFailure(`No workflow with id ${String(a.target.workflowId)}`);
    const r = await caps.createAutomation({ name: a.name, trigger: a.trigger, target: a.target, askBeforeRunning: a.ask });
    if (!r.ok || !r.id) throw new ToolFailure(r.error || "Could not create the automation");
    const id = r.id;
    return { text: `Created automation ${id}`, undo: { summary: "Delete the new automation", run: async () => opText(await caps.deleteAutomation(id), "Automation deleted") } };
  },
});

const runAutomation = define<{ id: string }>({
  name: "run_automation",
  title: "Run Automation",
  description: "Run one of the user's automations now (id from list_automations).",
  mutating: true,
  destructive: true,
  requires: "automations",
  schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  parse(input) {
    const id = reqStr(input, "id", 200);
    return isErr(id) ? id.error : { id: id.value };
  },
  async describe(a, caps) {
    const hit = (await caps.listAutomations().catch(() => [])).find((x) => x.id === a.id);
    return hit ? `Run the automation ${quote(hit.name)} now (${hit.target})` : `Run automation ${a.id} now`;
  },
  async run(a, caps) {
    return { text: opText(await caps.runAutomation(a.id), "Automation ran"), workflow: featureStep("automations", "runNow", { automation: a.id }) };
  },
});

// --- layouts ----------------------------------------------------------------------

const listLayouts = define<Record<string, never>>({
  name: "list_layouts",
  title: "List Layouts",
  description: "List saved window layouts (which windows go where) with ids for restore_layout.",
  mutating: false,
  requires: "layouts",
  schema: none,
  parse: () => ({}),
  describe: () => "List window layouts",
  async run(_a, caps) {
    const list = await caps.listLayouts();
    return list.length ? clip(JSON.stringify(list)) : "No saved layouts.";
  },
});

const restoreLayout = define<{ id: string }>({
  name: "restore_layout",
  title: "Restore Layout",
  description: "Move every window back to a saved layout (id from list_layouts).",
  mutating: true,
  requires: "layouts",
  schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  parse(input) {
    const id = reqStr(input, "id", 200);
    return isErr(id) ? id.error : { id: id.value };
  },
  async describe(a, caps) {
    const hit = (await caps.listLayouts().catch(() => [])).find((l) => l.id === a.id);
    return hit ? `Restore the window layout ${quote(hit.name)} (${hit.summary})` : `Restore layout ${a.id}`;
  },
  async run(a, caps) {
    if (!(await caps.listLayouts()).some((l) => l.id === a.id)) throw new ToolFailure(`No layout with id ${a.id}`);
    const before = (await caps.windowSnapshot?.().catch(() => null)) ?? null;
    const text = opText(await caps.restoreLayout(a.id), "Layout restored");
    const restore = caps.restoreWindows;
    return {
      text,
      undo: before && restore ? { summary: "Put the windows back where they were", run: async () => opText(await restore(before), "Windows restored") } : undefined,
      workflow: featureStep("layouts", "restore", { layout: a.id }),
    };
  },
});

const saveLayout = define<{ name: string }>({
  name: "save_layout",
  title: "Save Layout",
  description: "Save where every window is right now as a named layout.",
  mutating: true,
  requires: "layouts",
  schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  parse(input) {
    const name = reqStr(input, "name", 100);
    return isErr(name) ? name.error : { name: name.value.trim() };
  },
  describe: (a) => `Save the current window positions as the layout ${quote(a.name)}`,
  async run(a, caps) {
    const r = await caps.saveLayout(a.name);
    if (!r.ok || !r.id) throw new ToolFailure(r.error || "Could not save the layout");
    const id = r.id;
    return { text: `Saved layout ${quote(a.name)}${r.summary ? `: ${r.summary}` : ""}`, undo: { summary: `Delete the layout ${quote(a.name)}`, run: async () => opText(await caps.deleteLayout(id), "Layout deleted") } };
  },
});

// --- text ---------------------------------------------------------------------------

const transformText = define<{ transform: string; text?: string; source: "text" | "clipboard" | "selection" }>({
  name: "transform_text",
  title: "Transform Text",
  description:
    "Apply a Glide text transform (case changes, sort/dedupe lines, URL/Base64/JSON encode/decode, hashes, counts…) to text, the clipboard or the selection and return the result. Pass transform \"list\" to get the available transform ids. Does not change the clipboard; use copy_to_clipboard for that.",
  mutating: false,
  sensitiveResult: true,
  sensitiveArgs: ["text"],
  requires: "transforms",
  schema: {
    type: "object",
    properties: {
      transform: { type: "string", description: "Transform id, or \"list\"" },
      text: { type: "string", description: "Input text (omit to use source)" },
      source: { type: "string", enum: ["text", "clipboard", "selection"], description: "Where the input comes from (default text, or clipboard when text is omitted)" },
    },
    required: ["transform"],
    additionalProperties: false,
  },
  parse(input) {
    const t = reqStr(input, "transform", 80);
    if (isErr(t)) return t.error;
    const text = str(input, "text", { max: 200_000 });
    if (isErr(text)) return text.error;
    const src = input.source;
    const source = src === "clipboard" || src === "selection" ? src : text === undefined ? "clipboard" : "text";
    return { transform: t.value, text, source };
  },
  describe: (a) => (a.transform === "list" ? "List text transforms" : `Transform ${a.source === "text" ? "the given text" : `the ${a.source}`} with ${quote(a.transform)}`),
  async run(a, caps) {
    const all = caps.listTransforms();
    if (a.transform === "list") return JSON.stringify(all.map((t) => ({ id: t.id, title: t.title, category: t.category })));
    const def = all.find((t) => t.id === a.transform);
    if (!def) throw new ToolFailure(`Unknown transform ${quote(a.transform)}. Call transform_text with transform "list".`);
    let input = a.text ?? "";
    if (a.source === "clipboard") input = await caps.clipboardText();
    else if (a.source === "selection") {
      const r = await caps.selectedText();
      if (r.error) throw new ToolFailure(r.error);
      input = r.text ?? "";
    }
    const r = caps.applyTransform(def.id, input);
    if (!r.ok) throw new ToolFailure(r.error);
    return clip(r.output);
  },
});

const searchBookmarks = define<{ query: string; limit: number }>({
  name: "search_bookmarks",
  title: "Search Bookmarks",
  description: "Search the user's browser bookmarks (Safari, Chrome, Arc, …) by title or URL. Read-only; open one with open_url.",
  mutating: false,
  requires: "browser",
  schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", description: "1-20, default 8" } }, required: ["query"], additionalProperties: false },
  parse(input) {
    const q = str(input, "query", { max: 200 });
    if (isErr(q)) return q.error;
    return { query: q ?? "", limit: intArg(input, "limit", 8, 1, 20) };
  },
  describe: (a) => `Search bookmarks for ${quote(a.query)}`,
  async run(a, caps) {
    const r = await caps.searchBookmarks(a.query, a.limit);
    if (!r.ok) throw new ToolFailure(r.error || "Bookmarks are unavailable");
    return r.items?.length ? clip(JSON.stringify(r.items)) : `No bookmarks match ${quote(a.query)}.`;
  },
});

const clipboardHistory = define<{ query: string; limit: number }>({
  name: "clipboard_history_search",
  title: "Search Clipboard History",
  description: "Search Glide's clipboard history (text, links, colors, files). Read-only; returns previews, newest first.",
  mutating: false,
  sensitiveResult: true,
  requires: "clipboard",
  schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", description: "1-20, default 8" } }, additionalProperties: false },
  parse(input) {
    const q = str(input, "query", { max: 200 });
    if (isErr(q)) return q.error;
    return { query: q ?? "", limit: intArg(input, "limit", 8, 1, 20) };
  },
  describe: (a) => (a.query ? `Search clipboard history for ${quote(a.query)}` : "Read recent clipboard history"),
  async run(a, caps) {
    const list = await caps.clipboardHistory(a.query, a.limit);
    return list.length ? clip(JSON.stringify(list.map((e) => ({ ...e, preview: e.preview.slice(0, 300) })))) : "No clipboard history matches.";
  },
});

// --- processes & system -------------------------------------------------------------

const listProcesses = define<{ query: string; limit: number }>({
  name: "list_processes",
  title: "List Processes",
  description: "List running processes sorted by CPU (pid, name, %CPU, memory). Optionally filter by name. Read-only.",
  mutating: false,
  requires: "processes",
  schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", description: "1-30, default 10" } }, additionalProperties: false },
  parse(input) {
    const q = str(input, "query", { max: 100 });
    if (isErr(q)) return q.error;
    return { query: (q ?? "").toLowerCase(), limit: intArg(input, "limit", 10, 1, 30) };
  },
  describe: (a) => (a.query ? `List processes matching ${quote(a.query)}` : "List the busiest processes"),
  async run(a, caps) {
    const rows = (await caps.listProcesses()).filter((p) => !a.query || p.name.toLowerCase().includes(a.query)).slice(0, a.limit);
    return rows.length ? JSON.stringify(rows.map((p) => ({ pid: p.pid, name: p.name, cpu: p.cpu, memoryMB: Math.round(p.rssKb / 1024), user: p.user }))) : "No matching processes.";
  },
});

const killProcess = define<{ pid: number; force: boolean }>({
  name: "kill_process",
  title: "Quit Process",
  description: "Quit (SIGTERM) or force quit (force: true, SIGKILL) a process by pid from list_processes. Always asks the user. Core macOS processes and Glide itself are refused.",
  mutating: true,
  alwaysConfirm: true,
  destructive: true,
  requires: "processes",
  schema: { type: "object", properties: { pid: { type: "integer" }, force: { type: "boolean" } }, required: ["pid"], additionalProperties: false },
  parse(input) {
    const pid = input.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid)) return '"pid" must be an integer';
    if (pid <= 1) return "That process is protected and can't be killed";
    return { pid, force: input.force === true };
  },
  async describe(a, caps) {
    const p = await caps.checkProcess(a.pid).catch(() => null);
    const name = p?.exists ? `${quote(p.name)} (PID ${a.pid})` : `PID ${a.pid}`;
    return `${a.force ? "Force quit" : "Quit"} ${name}${a.force ? " — unsaved work is lost" : ""}`;
  },
  async run(a, caps) {
    const p = await caps.checkProcess(a.pid);
    if (!p.exists) throw new ToolFailure(`No process with PID ${a.pid}`);
    if (p.protected) throw new ToolFailure(`Refused: ${p.reason ?? `${p.name} is a protected process`}`);
    return opText(await caps.killProcess(a.pid, a.force, p.command), `${a.force ? "Force quit" : "Quit"} ${p.name}`);
  },
});

const systemStatus = define<Record<string, never>>({
  name: "system_status",
  title: "System Status",
  description: "Read CPU, memory, disk, battery, network and uptime, plus the busiest processes.",
  mutating: false,
  requires: "sysmon",
  schema: none,
  parse: () => ({}),
  describe: () => "Read system status",
  run: async (_a, caps) => clip(await caps.systemStatus()),
});

// --- create things ------------------------------------------------------------------

const createReminder = define<{ title: string; due?: string; notes?: string }>({
  name: "create_reminder",
  title: "Create Reminder",
  description: "Create a Glide reminder. due is an ISO 8601 local date-time (e.g. 2026-10-21T17:00) computed from the current time.",
  mutating: true,
  requires: "reminders",
  schema: {
    type: "object",
    properties: { title: { type: "string" }, due: { type: "string", description: "ISO 8601 date-time" }, notes: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  },
  parse(input) {
    const title = reqStr(input, "title", 200);
    if (isErr(title)) return title.error;
    const due = str(input, "due", { max: 40 });
    const notes = str(input, "notes", { max: 4000 });
    if (isErr(due)) return due.error;
    if (isErr(notes)) return notes.error;
    if (due !== undefined && Number.isNaN(Date.parse(due))) return '"due" must be an ISO 8601 date-time';
    return { title: title.value.trim(), due, notes };
  },
  describe: (a) => `Remind you ${quote(a.title)}${a.due ? ` at ${new Date(a.due).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}`,
  async run(a, caps) {
    if (!caps.hasFeature("reminders")) throw new ToolFailure("Reminders aren't available in this version of Glide");
    const r = await caps.createReminder(a);
    if (!r.ok) throw new ToolFailure(r.error || "Could not create the reminder");
    const id = r.id;
    const del = caps.deleteReminder;
    return { text: r.message || "Reminder created", undo: id && del ? { summary: `Delete the reminder ${quote(a.title)}`, run: async () => opText(await del(id), "Reminder deleted") } : undefined };
  },
});

const createSnippet = define<{ name: string; text: string; keyword?: string }>({
  name: "create_snippet",
  title: "Create Snippet",
  description: "Save a text snippet (pasted from the launcher; optional keyword expands it while typing).",
  mutating: true,
  schema: { type: "object", properties: { name: { type: "string" }, text: { type: "string" }, keyword: { type: "string", description: "Optional, e.g. \";sig\"" } }, required: ["name", "text"], additionalProperties: false },
  parse(input) {
    const name = reqStr(input, "name", 120);
    const text = reqStr(input, "text", 20_000);
    const keyword = str(input, "keyword", { max: 40 });
    if (isErr(name)) return name.error;
    if (isErr(text)) return text.error;
    if (isErr(keyword)) return keyword.error;
    if (keyword !== undefined && /\s/.test(keyword)) return "keyword can't contain spaces";
    return { name: name.value.trim(), text: text.value, keyword };
  },
  describe: (a) => `Create the snippet ${quote(a.name)}${a.keyword ? ` (keyword ${a.keyword})` : ""}: ${quote(a.text)}`,
  async run(a, caps) {
    const r = await caps.createSnippet(a);
    if (!r.ok || !r.id) throw new ToolFailure(r.error || "Could not create the snippet");
    const id = r.id;
    return { text: `Created snippet ${quote(a.name)}`, undo: { summary: `Delete the snippet ${quote(a.name)}`, run: async () => opText(await caps.deleteSnippet(id), "Snippet deleted") } };
  },
});

const createQuicklink = define<{ name: string; url: string }>({
  name: "create_quicklink",
  title: "Create Quicklink",
  description: "Save a quicklink: a named URL in the launcher. Use {query} in the URL for a search link, e.g. https://github.com/search?q={query}.",
  mutating: true,
  schema: { type: "object", properties: { name: { type: "string" }, url: { type: "string" } }, required: ["name", "url"], additionalProperties: false },
  parse(input) {
    const name = reqStr(input, "name", 120);
    const url = reqStr(input, "url", 4000);
    if (isErr(name)) return name.error;
    if (isErr(url)) return url.error;
    if (!/^(https?|mailto):/i.test(url.value.trim())) return "Quicklinks must be http, https or mailto URLs";
    return { name: name.value.trim(), url: url.value.trim() };
  },
  describe: (a) => `Create the quicklink ${quote(a.name)} → ${a.url}`,
  async run(a, caps) {
    const r = await caps.createQuicklink(a);
    if (!r.ok || !r.id) throw new ToolFailure(r.error || "Could not create the quicklink");
    const id = r.id;
    return { text: `Created quicklink ${quote(a.name)}`, undo: { summary: `Delete the quicklink ${quote(a.name)}`, run: async () => opText(await caps.deleteQuicklink(id), "Quicklink deleted") } };
  },
});

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const runShortcut = define<{ name: string; input?: string }>({
  name: "run_shortcut",
  title: "Run Shortcut",
  description: "Run a macOS Shortcuts shortcut by its exact name (shortcuts run). Always asks the user first.",
  mutating: true,
  alwaysConfirm: true,
  destructive: true,
  schema: { type: "object", properties: { name: { type: "string" }, input: { type: "string", description: "Optional text input" } }, required: ["name"], additionalProperties: false },
  parse(input) {
    const name = reqStr(input, "name", 200);
    const text = str(input, "input", { max: 10_000 });
    if (isErr(name)) return name.error;
    if (isErr(text)) return text.error;
    return { name: name.value.trim(), input: text };
  },
  describe: (a) => `Run the Shortcuts shortcut ${quote(a.name)}${a.input ? ` with input ${quote(a.input)}` : ""}`,
  async run(a, caps) {
    const r = await caps.runShortcut(a.name, a.input);
    if (!r.ok) throw new ToolFailure(r.error || "The shortcut failed");
    const text = r.output?.trim() ? `Shortcut finished. Output: ${clip(r.output.trim(), 2000)}` : r.message || "Shortcut finished.";
    return { text, workflow: { type: "runShell", params: { command: `shortcuts run ${shellQuote(a.name)}`, shell: "/bin/zsh", continueOnError: "false" }, label: `Run Shortcut “${a.name}”` } };
  },
});

const setTheme = define<{ mode?: "system" | "dark" | "light"; preset?: string }>({
  name: "set_theme",
  title: "Set Theme",
  description: "Change Glide's appearance: mode (system, dark, light) and/or a theme preset id (glide-dark, glide-light, midnight, nord, solarized, dracula, mocha, dawn, high-contrast).",
  mutating: true,
  requires: "appearance",
  schema: { type: "object", properties: { mode: { type: "string", enum: ["system", "dark", "light"] }, preset: { type: "string" } }, additionalProperties: false },
  parse(input) {
    const mode = input.mode;
    if (mode !== undefined && mode !== "system" && mode !== "dark" && mode !== "light") return '"mode" must be system, dark or light';
    const preset = str(input, "preset", { max: 60 });
    if (isErr(preset)) return preset.error;
    if (!mode && !preset) return "Give a mode and/or a preset";
    return { mode: mode as "system" | "dark" | "light" | undefined, preset };
  },
  async describe(a, caps) {
    const p = a.preset ? (await caps.appearance().catch(() => null))?.presets.find((x) => x.id === a.preset) : undefined;
    const bits = [a.preset ? `use the ${quote(p?.name ?? a.preset)} theme` : "", a.mode ? `switch to ${a.mode === "system" ? "the system appearance" : `${a.mode} mode`}` : ""].filter(Boolean);
    return `Change Glide's look: ${bits.join(" and ")}`;
  },
  async run(a, caps) {
    const before = await caps.appearance();
    if (a.preset && !before.presets.some((p) => p.id === a.preset)) throw new ToolFailure(`Unknown theme ${quote(a.preset)}. Presets: ${before.presets.map((p) => p.id).join(", ")}`);
    const text = opText(await caps.setAppearance(a), "Theme changed");
    return { text, undo: { summary: "Restore the previous theme", run: async () => opText(await caps.restoreAppearance(before), "Theme restored") } };
  },
});

export const EXTRA_TOOLS: AgentToolOf<AgentCapabilities>[] = [
  listAutomations,
  createAutomation,
  runAutomation,
  listLayouts,
  restoreLayout,
  saveLayout,
  transformText,
  searchBookmarks,
  clipboardHistory,
  listProcesses,
  killProcess,
  systemStatus,
  createReminder,
  createSnippet,
  createQuicklink,
  runShortcut,
  setTheme,
];
