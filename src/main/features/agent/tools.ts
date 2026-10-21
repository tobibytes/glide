/**
 * The agent's tools: JSON schemas sent to Claude, input validation, a human summary of exactly
 * what each call will do (shown in the confirmation step) and the implementation over
 * AgentCapabilities (wired to real Glide features in capabilities.ts, faked in tests).
 */
import type { WindowAction } from "../../native/helper";
import { WINDOW_COMMANDS } from "../windows/commands";

export interface OpResult {
  ok: boolean;
  message?: string;
  error?: string;
}

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

/** Everything the tools can do to Glide and the Mac. */
export interface AgentCapabilities {
  search(query: string, limit: number): Promise<CatalogueHit[]>;
  findItem(id: string): Promise<CatalogueHit | undefined>;
  executeItem(id: string, argument?: string): Promise<OpResult>;
  listWorkflows(): WorkflowInfo[];
  runWorkflow(id: string, input?: string): Promise<OpResult & { result?: string }>;
  windowAction(action: WindowAction, app?: string): Promise<OpResult>;
  openUrl(url: string): Promise<OpResult>;
  openApp(name: string): Promise<OpResult>;
  openFile(path: string): Promise<OpResult>;
  clipboardText(): Promise<string>;
  copyText(text: string): Promise<OpResult>;
  selectedText(): Promise<{ text: string | null; error?: string }>;
  startTimer(ms: number, name: string): Promise<OpResult>;
  createNote(text: string): Promise<OpResult & { id?: string }>;
  searchNotes(query: string): Promise<Array<{ id: string; title: string; preview?: string }>>;
  openNote(id: string): Promise<OpResult>;
  convert(query: string): Promise<Array<{ title: string; subtitle?: string }>>;
  calendarEvents(fromIso: string, toIso: string): Promise<{ ok: boolean; events?: CalendarItem[]; error?: string }>;
  /** Clock for tests. */
  now(): number;
}

// A type alias (not an interface) so it is assignable to the SDK's index-signature InputSchema.
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

interface ToolDef<A> {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
  schema: JsonSchema;
  /** Returns the parsed arguments, or an error message for Claude. */
  parse(input: Record<string, unknown>): A | string;
  describe(args: A, caps: AgentCapabilities): string | Promise<string>;
  run(args: A, caps: AgentCapabilities): Promise<string>;
}

export interface PreparedCall {
  describe(): Promise<string>;
  run(): Promise<string>;
}

export interface AgentTool {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
  schema: JsonSchema;
  prepare(input: unknown, caps: AgentCapabilities): PreparedCall | { error: string };
}

/** Thrown by a tool's run() to produce an is_error tool result. */
export class ToolFailure extends Error {}

function define<A>(t: ToolDef<A>): AgentTool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    mutating: t.mutating,
    schema: t.schema,
    prepare(input, caps) {
      if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Tool input must be a JSON object" };
      const parsed = t.parse(input as Record<string, unknown>);
      if (typeof parsed === "string") return { error: parsed };
      return { describe: async () => t.describe(parsed, caps), run: () => t.run(parsed, caps) };
    },
  };
}

// --- argument helpers ----------------------------------------------------------

const MAX_RESULT = 6000;

export function clip(text: string, max = MAX_RESULT): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} characters]` : text;
}

function str(input: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined | { error: string } {
  const v = input[key];
  if (v === undefined || v === null || v === "") return opts.required ? { error: `"${key}" is required` } : undefined;
  if (typeof v !== "string") return { error: `"${key}" must be a string` };
  if (opts.max && v.length > opts.max) return { error: `"${key}" is too long (max ${opts.max} characters)` };
  return v;
}

const isErr = (v: unknown): v is { error: string } => typeof v === "object" && v !== null && "error" in v;
const quote = (s: string) => `“${s.length > 80 ? `${s.slice(0, 80)}…` : s}”`;

function opText(r: OpResult, fallback: string): string {
  if (!r.ok) throw new ToolFailure(r.error || "Failed");
  return r.message || fallback;
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [h ? `${h} h` : "", m ? `${m} min` : "", s ? `${s} s` : ""].filter(Boolean);
  return parts.join(" ") || "0 s";
}

const WINDOW_ACTIONS = WINDOW_COMMANDS.map((c) => c.action);

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
    const raw = input.limit;
    const limit = typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.round(raw))) : 8;
    return { query, limit };
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
    if (!(await caps.findItem(a.id))) throw new ToolFailure(`No item with id ${a.id}. Search the catalogue first.`);
    return opText(await caps.executeItem(a.id, a.argument), "Done");
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
    return r.result ? `Workflow finished. Result: ${clip(r.result, 2000)}` : "Workflow finished.";
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
    return opText(await caps.windowAction(a.action, a.app), "Window moved");
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
    return opText(await caps.openUrl(a.url), `Opened ${a.url}`);
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
    return opText(await caps.openApp(a.name), `Opened ${a.name}`);
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
    return opText(await caps.openFile(a.path), `Opened ${a.path}`);
  },
});

const getClipboard = define<Record<string, never>>({
  name: "get_clipboard",
  title: "Read Clipboard",
  description: "Read the text currently on the clipboard.",
  mutating: false,
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
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  parse(input) {
    const text = str(input, "text", { required: true, max: 100_000 });
    if (isErr(text) || text === undefined) return isErr(text) ? text.error : "text is required";
    return { text };
  },
  describe: (a) => `Copy ${quote(a.text)} to the clipboard`,
  async run(a, caps) {
    return opText(await caps.copyText(a.text), "Copied");
  },
});

const getSelectedText = define<Record<string, never>>({
  name: "get_selected_text",
  title: "Read Selected Text",
  description: "Read the text selected in the app that was frontmost before Glide opened.",
  mutating: false,
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
    return opText(await caps.startTimer(a.ms, a.name), `Timer started (${formatDuration(a.ms)})`);
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
    return `Created note ${r.id}`;
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

/** Deterministic order: the tool list is part of the cached prompt prefix. */
export const TOOLS: AgentTool[] = [
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
];

export function toolByName(name: string, tools: AgentTool[] = TOOLS): AgentTool | undefined {
  return tools.find((t) => t.name === name);
}
