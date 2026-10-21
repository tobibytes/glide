/**
 * The agent's core tools: JSON schemas sent to Claude, input validation, a human summary of exactly
 * what each call will do (shown in the confirmation step), the implementation over
 * AgentCapabilities (wired to real Glide features in capabilities.ts, faked in tests) and, where
 * possible, an undo and a workflow equivalent. More tools live in tools-extra.ts.
 */
import type { WindowAction } from "../../native/helper";
import { EXTRA_TOOLS, type ExtraCapabilities } from "./tools-extra";
import { itemId as windowItemId, WINDOW_COMMANDS } from "../windows/commands";
import { clip, defineTool, featureStep, intArg, isErr, opText, quote, runItemStep, str, ToolFailure, type AgentToolOf, type OpResult, type WorkflowStep } from "./tooling";

export { clip, ToolFailure } from "./tooling";
export type { JsonSchema, OpResult, PreparedCall, ToolOutput, Undo, WorkflowStep } from "./tooling";

export interface CatalogueHit {
  id: string;
  title: string;
  subtitle?: string;
  kind: string;
  acceptsArgument?: boolean;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  description?: string;
  acceptsInput?: boolean;
}

export interface CalendarItem {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  calendar?: string;
}

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where every window was before the agent moved things (for undo). */
export interface WindowSnapshot {
  windows: Array<{ pid: number; bundleId: string | null; appName: string; title: string; order: number; frame: WindowFrame }>;
}

/** Everything the tools can do to Glide and the Mac. */
export interface AgentCapabilities extends ExtraCapabilities {
  search(query: string, limit: number): Promise<CatalogueHit[]>;
  findItem(id: string): Promise<CatalogueHit | undefined>;
  executeItem(id: string, argument?: string): Promise<OpResult>;
  /** The workflow action equivalent of running a catalogue item, when there is one. */
  workflowForItem?(id: string, argument?: string, title?: string): WorkflowStep | null;
  listWorkflows(): WorkflowInfo[];
  runWorkflow(id: string, input?: string): Promise<OpResult & { result?: string }>;
  windowAction(action: WindowAction, app?: string): Promise<OpResult>;
  /** Frames of every window right now; null when the helper can't read them. */
  windowSnapshot?(): Promise<WindowSnapshot | null>;
  restoreWindows?(snapshot: WindowSnapshot): Promise<OpResult>;
  openUrl(url: string): Promise<OpResult>;
  openApp(name: string): Promise<OpResult>;
  openFile(path: string): Promise<OpResult>;
  clipboardText(): Promise<string>;
  copyText(text: string): Promise<OpResult>;
  selectedText(): Promise<{ text: string | null; error?: string }>;
  startTimer(ms: number, name: string): Promise<OpResult>;
  timerIds?(): Promise<string[]>;
  stopTimer?(id: string): Promise<OpResult>;
  createNote(text: string): Promise<OpResult & { id?: string }>;
  deleteNote?(id: string): Promise<OpResult>;
  searchNotes(query: string): Promise<Array<{ id: string; title: string; preview?: string }>>;
  openNote(id: string): Promise<OpResult>;
  convert(query: string): Promise<Array<{ title: string; subtitle?: string }>>;
  calendarEvents(fromIso: string, toIso: string): Promise<{ ok: boolean; events?: CalendarItem[]; error?: string }>;
  /** Clock for tests. */
  now(): number;
}

export type AgentTool = AgentToolOf<AgentCapabilities>;

const define = defineTool<AgentCapabilities>();

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [h ? `${h} h` : "", m ? `${m} min` : "", s ? `${s} s` : ""].filter(Boolean);
  return parts.join(" ") || "0 s";
}

const WINDOW_ACTIONS = WINDOW_COMMANDS.map((c) => c.action);

/** "1h 5m 30s": the form the timers workflow action parses. */
function timerDuration(ms: number): string {
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", s ? `${s}s` : ""].filter(Boolean).join(" ") || "1s";
}

/** The planning pseudo-tool: the loop shows its steps as the plan instead of running anything. */
export const PLAN_TOOL = "plan";

// --- tools -----------------------------------------------------------------------

const searchCatalogue = define<{ query: string; limit: number }>({
  name: "search_catalogue",
  title: "Search Glide",
  description:
    "Search everything the Glide launcher can run: apps, built-in commands (timers, window management, notes, system commands, AI commands, settings), workflows, quicklinks and snippets. Returns item ids for execute_item. Use short keyword queries such as \"timer\", \"safari\" or \"lock screen\".",
  mutating: false,
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search text, as a person would type it into the launcher" },
      limit: { type: "integer", description: "Maximum results (1-20, default 8)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  parse(input) {
    const query = str(input, "query", { required: true, max: 200 });
    if (isErr(query) || query === undefined) return isErr(query) ? query.error : "query is required";
    return { query, limit: intArg(input, "limit", 8, 1, 20) };
  },
  describe: (a) => `Search Glide for ${quote(a.query)}`,
  async run(a, caps) {
    const hits = await caps.search(a.query, a.limit);
    if (!hits.length) return `No items match ${quote(a.query)}.`;
    return JSON.stringify(hits.map((h) => ({ id: h.id, title: h.title, subtitle: h.subtitle, kind: h.kind, acceptsArgument: h.acceptsArgument || undefined })));
  },
});

const executeItem = define<{ id: string; argument?: string }>({
  name: "execute_item",
  title: "Run Glide Item",
  description:
    "Run one launcher item by the id returned from search_catalogue, exactly as if the user chose it (opens an app, runs a command, workflow or quicklink). Pass argument only for items with acceptsArgument.",
  mutating: true,
  schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Item id from search_catalogue" },
      argument: { type: "string", description: "Text argument for items that accept one" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  parse(input) {
    const id = str(input, "id", { required: true, max: 2000 });
    const argument = str(input, "argument", { max: 2000 });
    if (isErr(id) || id === undefined) return isErr(id) ? id.error : "id is required";
    if (isErr(argument)) return argument.error;
    if (id.startsWith("agent:")) return "The agent cannot run itself";
    return { id, argument };
  },
  async describe(a, caps) {
    const hit = await caps.findItem(a.id);
    const name = hit ? `${quote(hit.title)}${hit.subtitle ? ` (${hit.subtitle})` : ""}` : `item ${a.id}`;
    return `Run ${name}${a.argument ? ` with ${quote(a.argument)}` : ""}`;
  },
  async run(a, caps) {
    const hit = await caps.findItem(a.id);
    if (!hit) throw new ToolFailure(`No item with id ${a.id}. Search the catalogue first.`);
    const text = opText(await caps.executeItem(a.id, a.argument), "Done");
    return { text, workflow: caps.workflowForItem?.(a.id, a.argument, hit.title) ?? undefined };
  },
});

const listWorkflows = define<Record<string, never>>({
  name: "list_workflows",
  title: "List Workflows",
  description: "List the user's Glide workflows (Shortcuts-style automations) with their ids.",
  mutating: false,
  schema: { type: "object", properties: {}, additionalProperties: false },
  parse: () => ({}),
  describe: () => "List workflows",
  async run(_a, caps) {
    const list = caps.listWorkflows();
    return list.length ? JSON.stringify(list) : "The user has no workflows.";
  },
});

const runWorkflow = define<{ id: string; input?: string }>({
  name: "run_workflow",
  title: "Run Workflow",
  description: "Run one of the user's workflows by id (from list_workflows), optionally with input text.",
  mutating: true,
  schema: {
    type: "object",
    properties: { id: { type: "string" }, input: { type: "string", description: "Input text for workflows that accept it" } },
    required: ["id"],
    additionalProperties: false,
  },
  parse(input) {
    const id = str(input, "id", { required: true, max: 200 });
    const text = str(input, "input", { max: 4000 });
    if (isErr(id) || id === undefined) return isErr(id) ? id.error : "id is required";
    if (isErr(text)) return text.error;
    return { id, input: text };
  },
  describe(a, caps) {
    const wf = caps.listWorkflows().find((w) => w.id === a.id);
    return `Run workflow ${wf ? quote(wf.name) : a.id}${a.input ? ` with input ${quote(a.input)}` : ""}`;
  },
  async run(a, caps) {
    if (!caps.listWorkflows().some((w) => w.id === a.id)) throw new ToolFailure(`No workflow with id ${a.id}`);
    const r = await caps.runWorkflow(a.id, a.input);
    if (!r.ok) throw new ToolFailure(r.error || "Workflow failed");
    const text = r.result ? `Workflow finished. Result: ${clip(r.result, 2000)}` : "Workflow finished.";
    return { text, workflow: { type: "runWorkflow", params: { workflowId: a.id, input: a.input ?? "" } } };
  },
});

const windowAction = define<{ action: WindowAction; app?: string }>({
  name: "window_action",
  title: "Move Window",
  description:
    "Resize or move the front window of an app (like Rectangle). Give app to bring that app to the front first (e.g. \"Safari\"); otherwise the app that was frontmost before Glide is used.",
  mutating: true,
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: WINDOW_ACTIONS, description: "Window layout" },
      app: { type: "string", description: "App name to focus first, e.g. \"Notes\"" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  parse(input) {
    const action = input.action;
    if (typeof action !== "string" || !(WINDOW_ACTIONS as string[]).includes(action)) return `"action" must be one of: ${WINDOW_ACTIONS.join(", ")}`;
    const app = str(input, "app", { max: 200 });
    if (isErr(app)) return app.error;
    return { action: action as WindowAction, app };
  },
  describe(a) {
    const title = WINDOW_COMMANDS.find((c) => c.action === a.action)?.title ?? a.action;
    return `${a.app ? `Bring ${quote(a.app)} to the front and move its window` : "Move the front window"} to ${title}`;
  },
  async run(a, caps) {
    // Capture first so undo can put every window back exactly where it was.
    const before = (await caps.windowSnapshot?.().catch(() => null)) ?? null;
    const text = opText(await caps.windowAction(a.action, a.app), "Window moved");
    const restore = caps.restoreWindows;
    const undo = before && restore ? { summary: "Put the windows back where they were", run: async () => opText(await restore(before), "Windows restored") } : undefined;
    const title = WINDOW_COMMANDS.find((c) => c.action === a.action)?.title ?? a.action;
    const workflow: WorkflowStep[] = [...(a.app ? [{ type: "openApp" as const, params: { app: a.app } }, { type: "wait" as const, params: { seconds: "0.5" } }] : []), runItemStep(windowItemId(a.action), undefined, title)];
    return { text, undo, workflow };
  },
});

const openUrl = define<{ url: string }>({
  name: "open_url",
  title: "Open URL",
  description: "Open an http(s) or mailto: URL in the default browser or mail app.",
  mutating: true,
  schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  parse(input) {
    const url = str(input, "url", { required: true, max: 4000 });
    if (isErr(url) || url === undefined) return isErr(url) ? url.error : "url is required";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "Not a valid URL";
    }
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return "Only http, https and mailto URLs can be opened";
    return { url: parsed.toString() };
  },
  describe: (a) => `Open ${a.url}`,
  async run(a, caps) {
    return { text: opText(await caps.openUrl(a.url), `Opened ${a.url}`), workflow: { type: "openUrl", params: { url: a.url } } };
  },
});

const openApp = define<{ name: string }>({
  name: "open_app",
  title: "Open App",
  description: "Open (or bring to the front) a Mac app by name, e.g. \"Safari\" or \"Notes\".",
  mutating: true,
  schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  parse(input) {
    const name = str(input, "name", { required: true, max: 200 });
    if (isErr(name) || name === undefined) return isErr(name) ? name.error : "name is required";
    return { name: name.trim() };
  },
  describe: (a) => `Open the app ${quote(a.name)}`,
  async run(a, caps) {
    return { text: opText(await caps.openApp(a.name), `Opened ${a.name}`), workflow: { type: "openApp", params: { app: a.name } } };
  },
});

const openFile = define<{ path: string }>({
  name: "open_file",
  title: "Open File",
  description: "Open a file or folder with its default app. Absolute path or ~/path.",
  mutating: true,
  schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  parse(input) {
    const p = str(input, "path", { required: true, max: 2000 });
    if (isErr(p) || p === undefined) return isErr(p) ? p.error : "path is required";
    if (!p.startsWith("/") && !p.startsWith("~/")) return "path must be absolute or start with ~/";
    return { path: p };
  },
  describe: (a) => `Open ${a.path}`,
  async run(a, caps) {
    return { text: opText(await caps.openFile(a.path), `Opened ${a.path}`), workflow: { type: "openFile", params: { path: a.path } } };
  },
});

const getClipboard = define<Record<string, never>>({
  name: "get_clipboard",
  title: "Read Clipboard",
  description: "Read the text currently on the clipboard.",
  mutating: false,
  sensitiveResult: true,
  schema: { type: "object", properties: {}, additionalProperties: false },
  parse: () => ({}),
  describe: () => "Read the clipboard text",
  async run(_a, caps) {
    const t = await caps.clipboardText();
    return t ? clip(t) : "The clipboard has no text.";
  },
});

const copyToClipboard = define<{ text: string }>({
  name: "copy_to_clipboard",
  title: "Copy to Clipboard",
  description: "Replace the clipboard contents with text.",
  mutating: true,
  sensitiveArgs: ["text"],
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  parse(input) {
    const text = str(input, "text", { required: true, max: 100_000 });
    if (isErr(text) || text === undefined) return isErr(text) ? text.error : "text is required";
    return { text };
  },
  describe: (a) => `Copy ${quote(a.text)} to the clipboard`,
  async run(a, caps) {
    const previous = await caps.clipboardText().catch(() => "");
    const text = opText(await caps.copyText(a.text), "Copied");
    return {
      text,
      undo: { summary: "Put the previous clipboard text back", run: async () => opText(await caps.copyText(previous), "Clipboard restored") },
      workflow: { type: "setClipboard", params: { text: a.text } },
    };
  },
});

const getSelectedText = define<Record<string, never>>({
  name: "get_selected_text",
  title: "Read Selected Text",
  description: "Read the text selected in the app that was frontmost before Glide opened.",
  mutating: false,
  sensitiveResult: true,
  schema: { type: "object", properties: {}, additionalProperties: false },
  parse: () => ({}),
  describe: () => "Read the selected text",
  async run(_a, caps) {
    const r = await caps.selectedText();
    if (r.error) throw new ToolFailure(r.error);
    return r.text ? clip(r.text) : "No text is selected.";
  },
});

const startTimer = define<{ ms: number; name: string }>({
  name: "start_timer",
  title: "Start Timer",
  description: "Start a countdown timer in Glide (shown in the menu bar, notifies when done).",
  mutating: true,
  schema: {
    type: "object",
    properties: {
      minutes: { type: "number", description: "Duration in minutes (may be fractional)" },
      seconds: { type: "number", description: "Extra seconds" },
      name: { type: "string", description: "Optional label, e.g. \"Standup\"" },
    },
    additionalProperties: false,
  },
  parse(input) {
    const num = (k: string) => (typeof input[k] === "number" && Number.isFinite(input[k]) ? (input[k] as number) : 0);
    const ms = Math.round(num("minutes") * 60_000 + num("seconds") * 1000);
    if (!(ms >= 1000)) return "Give a duration with minutes and/or seconds";
    if (ms > 24 * 3_600_000) return "Timers can be at most 24 hours";
    const name = str(input, "name", { max: 100 });
    if (isErr(name)) return name.error;
    return { ms, name: name?.trim() ?? "" };
  },
  describe: (a) => `Start a ${formatDuration(a.ms)} timer${a.name ? ` named ${quote(a.name)}` : ""}`,
  async run(a, caps) {
    const before = new Set((await caps.timerIds?.().catch(() => [])) ?? []);
    const text = opText(await caps.startTimer(a.ms, a.name), `Timer started (${formatDuration(a.ms)})`);
    const created = ((await caps.timerIds?.().catch(() => [])) ?? []).filter((id) => !before.has(id));
    const stop = caps.stopTimer;
    const undo =
      created.length === 1 && stop
        ? { summary: `Cancel the ${formatDuration(a.ms)} timer`, run: async () => opText(await stop(created[0]!), "Timer cancelled") }
        : undefined;
    return { text, undo, workflow: featureStep("timers", "start", { duration: timerDuration(a.ms), name: a.name }) };
  },
});

const createNote = define<{ text: string; open: boolean }>({
  name: "create_note",
  title: "Create Note",
  description: "Create a Glide floating note. The first line becomes its title. Set open to show it.",
  mutating: true,
  schema: {
    type: "object",
    properties: { text: { type: "string", description: "Note body (Markdown)" }, open: { type: "boolean", description: "Show the note window (default true)" } },
    required: ["text"],
    additionalProperties: false,
  },
  parse(input) {
    const text = str(input, "text", { required: true, max: 50_000 });
    if (isErr(text) || text === undefined) return isErr(text) ? text.error : "text is required";
    return { text, open: input.open !== false };
  },
  describe: (a) => `Create a note ${quote(a.text.split("\n")[0] ?? a.text)}${a.open ? " and show it" : ""}`,
  async run(a, caps) {
    const r = await caps.createNote(a.text);
    if (!r.ok || !r.id) throw new ToolFailure(r.error || "Could not create the note");
    if (a.open) await caps.openNote(r.id);
    const id = r.id;
    const del = caps.deleteNote;
    const title = a.text.split("\n")[0] ?? "";
    return { text: `Created note ${id}`, undo: del ? { summary: `Delete the note ${quote(title)}`, run: async () => opText(await del(id), "Note deleted") } : undefined };
  },
});

const searchNotes = define<{ query: string }>({
  name: "search_notes",
  title: "Search Notes",
  description: "Search the user's Glide floating notes by text. Returns note ids for open_note.",
  mutating: false,
  schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  parse(input) {
    const query = str(input, "query", { max: 200 });
    if (isErr(query)) return query.error;
    return { query: query ?? "" };
  },
  describe: (a) => `Search notes for ${quote(a.query)}`,
  async run(a, caps) {
    const notes = await caps.searchNotes(a.query);
    return notes.length ? JSON.stringify(notes.slice(0, 15)) : `No notes match ${quote(a.query)}.`;
  },
});

const openNote = define<{ id: string }>({
  name: "open_note",
  title: "Open Note",
  description: "Show one of the user's Glide notes (id from search_notes) in the floating notes window.",
  mutating: true,
  schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  parse(input) {
    const id = str(input, "id", { required: true, max: 200 });
    if (isErr(id) || id === undefined) return isErr(id) ? id.error : "id is required";
    return { id };
  },
  async describe(a, caps) {
    const hit = (await caps.searchNotes("")).find((n) => n.id === a.id);
    return `Open the note ${hit ? quote(hit.title) : a.id}`;
  },
  async run(a, caps) {
    return opText(await caps.openNote(a.id), "Note opened");
  },
});

const convert = define<{ query: string }>({
  name: "convert",
  title: "Convert",
  description: "Convert units, currencies, time zones and dates with Glide's converter, e.g. \"5 km in miles\", \"100 usd to eur\", \"3pm london in tokyo\".",
  mutating: false,
  schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  parse(input) {
    const query = str(input, "query", { required: true, max: 200 });
    if (isErr(query) || query === undefined) return isErr(query) ? query.error : "query is required";
    return { query };
  },
  describe: (a) => `Convert ${quote(a.query)}`,
  async run(a, caps) {
    const out = await caps.convert(a.query);
    if (!out.length) throw new ToolFailure(`Glide could not convert ${quote(a.query)}. Try a form like "5 km in miles".`);
    return JSON.stringify(out.slice(0, 5));
  },
});

const calendarEvents = define<{ daysAhead: number }>({
  name: "get_calendar_events",
  title: "Read Calendar",
  description: "List calendar events from the start of today through days_ahead days (0 = today only).",
  mutating: false,
  schema: { type: "object", properties: { days_ahead: { type: "integer", description: "0-14, default 0" } }, additionalProperties: false },
  parse(input) {
    const d = input.days_ahead;
    return { daysAhead: typeof d === "number" && Number.isFinite(d) ? Math.max(0, Math.min(14, Math.round(d))) : 0 };
  },
  describe: (a) => (a.daysAhead ? `Read calendar events for today and the next ${a.daysAhead} days` : "Read today's calendar events"),
  async run(a, caps) {
    const from = new Date(caps.now());
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + a.daysAhead + 1);
    const r = await caps.calendarEvents(from.toISOString(), to.toISOString());
    if (!r.ok) throw new ToolFailure(r.error || "Calendar unavailable");
    return r.events?.length ? clip(JSON.stringify(r.events)) : "No events in that range.";
  },
});

const plan = define<{ steps: string[] }>({
  name: PLAN_TOOL,
  title: "Plan",
  description:
    "Show the user a short plan before a request that needs several actions (2-8 short steps, e.g. \"Find the Standup workflow\", \"Run it\"). Call it once, first, together with the first actions. Not needed for single actions or questions.",
  mutating: false,
  schema: {
    type: "object",
    properties: { steps: { type: "array", items: { type: "string" }, description: "Short imperative steps, in order" } },
    required: ["steps"],
    additionalProperties: false,
  },
  parse(input) {
    const raw = input.steps;
    if (!Array.isArray(raw)) return '"steps" must be an array of strings';
    const steps = raw.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim().slice(0, 160));
    if (!steps.length) return "Give at least one step";
    return { steps: steps.slice(0, 8) };
  },
  describe: (a) => `Plan ${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`,
  run: async () => "The plan is shown to the user. Carry it out now.",
});

/** Deterministic order: the tool list is part of the cached prompt prefix. */
export const TOOLS: AgentTool[] = [
  plan,
  searchCatalogue,
  executeItem,
  listWorkflows,
  runWorkflow,
  windowAction,
  openApp,
  openUrl,
  openFile,
  startTimer,
  createNote,
  searchNotes,
  openNote,
  getClipboard,
  copyToClipboard,
  getSelectedText,
  convert,
  calendarEvents,
  ...EXTRA_TOOLS,
];

export function toolByName(name: string, tools: AgentTool[] = TOOLS): AgentTool | undefined {
  return tools.find((t) => t.name === name);
}
