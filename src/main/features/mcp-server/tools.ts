/**
 * The tools Glide exposes over MCP: names, descriptions, JSON input schemas and safety metadata.
 * Most are thin wrappers over the Glide Agent's tools (same validation, same feature calls, see
 * ../agent/tools.ts); a few (timers list/stop, reminders list, OCR on a file) are implemented in
 * ./backend.ts. Pure module: no Electron.
 */
import { TOOLS as AGENT_TOOLS } from "../agent/tools";
import type { JsonSchema } from "../agent/tooling";

export type { JsonSchema } from "../agent/tooling";

export interface McpToolMeta {
  name: string;
  title: string;
  description: string;
  /** Never changes anything (MCP readOnlyHint). */
  readOnly: boolean;
  /** May delete or irreversibly change user data or run arbitrary commands (MCP destructiveHint). */
  destructive: boolean;
  /** Returns clipboard contents: off by default and only shown to clients the user allowed. */
  sensitive?: boolean;
  /** Feature id this tool needs; hidden when that feature isn't installed. */
  requires?: string;
}

export interface McpToolDef extends McpToolMeta {
  inputSchema: JsonSchema;
  /** Agent tool that implements this one (../agent/tools*.ts). */
  agentTool?: string;
  /** Arguments merged under the client's (e.g. create_note does not pop the note window open). */
  defaults?: Record<string, unknown>;
}

const NONE: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

function agentSchema(name: string): JsonSchema {
  const t = AGENT_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`agent tool ${name} missing`);
  return t.schema;
}

function agentRequires(name: string): string | undefined {
  return AGENT_TOOLS.find((x) => x.name === name)?.requires;
}

type Wrap = Omit<McpToolMeta, "requires"> & { agentTool: string; defaults?: Record<string, unknown>; schema?: JsonSchema };

const wrap = (w: Wrap): McpToolDef => ({
  name: w.name,
  title: w.title,
  description: w.description,
  readOnly: w.readOnly,
  destructive: w.destructive,
  sensitive: w.sensitive,
  requires: agentRequires(w.agentTool),
  inputSchema: w.schema ?? agentSchema(w.agentTool),
  agentTool: w.agentTool,
  defaults: w.defaults,
});

export const MCP_TOOLS: McpToolDef[] = [
  wrap({
    name: "search_glide",
    title: "Search Glide",
    agentTool: "search_catalogue",
    readOnly: true,
    destructive: false,
    description:
      "Search everything the Glide launcher can run on this Mac: apps, built-in commands (timers, window management, notes, system commands), workflows, quicklinks and snippets. Returns item ids for run_command. Use short keyword queries such as \"timer\", \"safari\" or \"lock screen\".",
  }),
  wrap({
    name: "run_command",
    title: "Run Glide Command",
    agentTool: "execute_item",
    readOnly: false,
    destructive: true,
    description:
      "Run one Glide launcher item by the id returned from search_glide, exactly as if the user chose it (opens an app, runs a command, workflow or quicklink). Pass argument only for items with acceptsArgument. The user confirms every call in Glide.",
  }),
  wrap({ name: "list_workflows", title: "List Workflows", agentTool: "list_workflows", readOnly: true, destructive: false, description: "List the user's Glide workflows (Shortcuts-style automations) with their ids." }),
  wrap({ name: "run_workflow", title: "Run Workflow", agentTool: "run_workflow", readOnly: false, destructive: true, description: "Run one of the user's Glide workflows by id (from list_workflows), optionally with input text. Returns the workflow's result." }),
  wrap({ name: "window_action", title: "Move Window", agentTool: "window_action", readOnly: false, destructive: false, description: "Resize or move the front window of an app (left half, maximize, center, next display…). Give app to bring that app to the front first." }),
  wrap({ name: "list_layouts", title: "List Window Layouts", agentTool: "list_layouts", readOnly: true, destructive: false, description: "List the user's saved Glide window layouts with their ids." }),
  wrap({ name: "restore_layout", title: "Restore Window Layout", agentTool: "restore_layout", readOnly: false, destructive: false, description: "Restore a saved window layout by id (from list_layouts): opens its apps and moves their windows back." }),
  wrap({ name: "save_layout", title: "Save Window Layout", agentTool: "save_layout", readOnly: false, destructive: false, description: "Save the current position of every window as a named Glide window layout." }),
  {
    name: "list_timers",
    title: "List Timers",
    readOnly: true,
    destructive: false,
    requires: "timers",
    inputSchema: NONE,
    description: "List Glide's running and paused countdown timers and stopwatches with their ids and remaining time.",
  },
  wrap({ name: "start_timer", title: "Start Timer", agentTool: "start_timer", readOnly: false, destructive: false, description: "Start a Glide countdown timer (shown in the menu bar, notifies when done). Give minutes and/or seconds and an optional name." }),
  {
    name: "stop_timer",
    title: "Stop Timer",
    readOnly: false,
    destructive: true,
    requires: "timers",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Timer id from list_timers" } }, required: ["id"], additionalProperties: false },
    description: "Cancel a running Glide timer by id (from list_timers).",
  },
  wrap({
    name: "clipboard_history_search",
    title: "Search Clipboard History",
    agentTool: "clipboard_history_search",
    readOnly: true,
    destructive: false,
    sensitive: true,
    description: "Search the user's Glide clipboard history (text previews of recently copied items). Off unless the user allows it.",
  }),
  wrap({
    name: "create_note",
    title: "Create Note",
    agentTool: "create_note",
    readOnly: false,
    destructive: false,
    defaults: { open: false },
    description: "Create a Glide floating note (Markdown). The first line becomes its title. Set open to true to show it on screen.",
  }),
  wrap({ name: "search_notes", title: "Search Notes", agentTool: "search_notes", readOnly: true, destructive: false, description: "Search the user's Glide floating notes by text. Returns note ids; read a note with the glide://notes/<id> resource." }),
  wrap({ name: "convert", title: "Convert", agentTool: "convert", readOnly: true, destructive: false, description: "Convert units, currencies, time zones and dates, or evaluate math, with Glide's converter, e.g. \"5 km in miles\", \"100 usd to eur\", \"3pm london in tokyo\"." }),
  wrap({ name: "transform_text", title: "Transform Text", agentTool: "transform_text", readOnly: true, destructive: false, description: "Apply one of Glide's text transforms (case changes, slugify, base64, URL encode, JSON format, sort lines…) to text and return the result." }),
  {
    name: "list_reminders",
    title: "List Reminders",
    readOnly: true,
    destructive: false,
    requires: "reminders",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Only reminders whose title contains this text" }, limit: { type: "integer", description: "1-100, default 30" } },
      additionalProperties: false,
    },
    description: "List the user's Apple Reminders (title, due date, list, completed) through Glide. Needs Reminders access granted to Glide.",
  },
  wrap({ name: "create_reminder", title: "Create Reminder", agentTool: "create_reminder", readOnly: false, destructive: false, description: "Create an Apple Reminder through Glide with an optional due date (ISO 8601) and notes." }),
  wrap({ name: "list_automations", title: "List Automations", agentTool: "list_automations", readOnly: true, destructive: false, description: "List the user's Glide automations (trigger → action rules) with their ids." }),
  wrap({ name: "run_automation", title: "Run Automation", agentTool: "run_automation", readOnly: false, destructive: true, description: "Run one of the user's Glide automations now by id (from list_automations), ignoring its trigger." }),
  {
    name: "capture_text_from_image",
    title: "Text from Image File",
    readOnly: true,
    destructive: false,
    requires: "ocr",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path (or ~/path) of a PNG, JPEG, HEIC, TIFF, GIF, BMP or WebP image" } },
      required: ["path"],
      additionalProperties: false,
    },
    description: "Recognize the text in an image file on this Mac with Glide's on-device OCR (Apple Vision). Files only: it never captures the screen.",
  },
  wrap({ name: "system_status", title: "System Status", agentTool: "system_status", readOnly: true, destructive: false, description: "Current CPU, memory, disk, battery, network and uptime of this Mac, from Glide's system monitor." }),
  wrap({ name: "search_bookmarks", title: "Search Bookmarks", agentTool: "search_bookmarks", readOnly: true, destructive: false, description: "Search the user's browser bookmarks (Safari, Chrome, Arc, Firefox…) indexed by Glide. Read-only." }),
];

export function mcpToolByName(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

/** MCP tools/list entry (annotations per the 2025-06 spec). */
export function toListEntry(t: McpToolDef) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: t.readOnly ? false : t.destructive, idempotentHint: t.readOnly, openWorldHint: false },
  };
}
