/**
 * Shared contract between the Electron main process, the preload bridge,
 * the pure search engine, and the React renderer.
 *
 * Every builder session codes against this file. Change it only by extending
 * (add optional fields / new union members); never rename existing members.
 */

// ---------------------------------------------------------------------------
// Search items
// ---------------------------------------------------------------------------

export type ItemKind =
  | "app" // installed application bundle
  | "system" // built-in command (Lock Screen, Empty Trash, Sleep…)
  | "workflow" // user-built workflow (the Shortcuts-style part)
  | "quicklink" // URL template with optional {query} placeholder
  | "snippet" // text expansion / paste
  | "file" // file or folder found by the file source
  | "calculator" // inline calculator result
  | "setting" // opens a settings page inside Glide
  | "fallback" // shown when nothing matches (e.g. "Search Google for …")
  | "command"; // provided by a feature module (see src/main/features); routed by item.feature

export interface ItemIcon {
  kind: "emoji" | "symbol" | "app" | "file" | "url" | "color";
  /** emoji char, SF-like symbol name, bundle path, file path, http(s) url, or #rrggbb */
  value: string;
  /** optional tint for symbol icons */
  tint?: string;
}

export interface SearchItem {
  id: string;
  kind: ItemKind;
  title: string;
  subtitle?: string;
  icon?: ItemIcon;
  /** Extra tokens matched with lower weight than the title (Raycast: "keywords"). */
  keywords?: string[];
  /** User-assigned alias; an exact alias match ranks first (Raycast: alias). */
  alias?: string;
  /** Display string for a global hotkey, e.g. "⌥⌘K". */
  hotkey?: string;
  favorite?: boolean;
  /** kind-specific payload */
  path?: string; // app / file
  url?: string; // quicklink (may contain {query})
  text?: string; // snippet body
  workflowId?: string; // workflow
  command?: string; // system / setting identifier
  /** Source that produced the item; useful for enabling/disabling sources. */
  source?: string;
  /** Items that accept the rest of the query as an argument (quicklink {query}, workflow input). */
  acceptsArgument?: boolean;
  /** Feature module that owns this item; execute/actions are routed to it. */
  feature?: string;
  /** Free-form payload for the owning feature (must be JSON-serialisable). */
  data?: Record<string, unknown>;
  /** Display label for the kind column when kind is "command" (e.g. "Window", "Clipboard"). */
  kindLabel?: string;
}

// ---------------------------------------------------------------------------
// Search engine
// ---------------------------------------------------------------------------

export interface MatchRange {
  start: number;
  end: number; // exclusive
}

export type MatchKind = "alias" | "exact" | "prefix" | "word-prefix" | "acronym" | "fuzzy" | "keyword" | "none";

export interface ScoredItem {
  item: SearchItem;
  /** final score used for ordering, higher first */
  score: number;
  /** pure text-match score before usage weighting */
  matchScore: number;
  matchKind: MatchKind;
  /** usage-derived score (frecency) */
  frecency: number;
  /** character ranges in the title to highlight */
  ranges: MatchRange[];
  /** argument text (anything after the matched item for acceptsArgument items) */
  argument?: string;
  /** Named argument values from the launcher's multi-argument entry (quicklink `{argument name="…"}`). */
  arguments?: Record<string, string>;
}

export type SectionId = "favorites" | "suggestions" | "results" | "workflows" | "apps" | "files" | "calculator" | "fallbacks";

export interface ResultSection {
  id: SectionId;
  title: string;
  items: ScoredItem[];
}

export interface SearchResponse {
  query: string;
  sections: ResultSection[];
  /** total items considered */
  total: number;
  tookMs: number;
}

/** Usage record persisted per item id to compute frecency. */
export interface UsageRecord {
  itemId: string;
  /** unix ms timestamps of the most recent launches (bounded ring) */
  launches: number[];
  /** total launch count ever */
  count: number;
  lastLaunchedAt: number;
}

// ---------------------------------------------------------------------------
// Workflows (Shortcuts-style)
// ---------------------------------------------------------------------------

export type ActionType =
  | "openApp"
  | "openUrl"
  | "runShell"
  | "runAppleScript"
  | "typeText"
  | "setClipboard"
  | "getClipboard"
  | "notify"
  | "wait"
  | "askInput"
  | "setVariable"
  | "condition"
  | "httpRequest"
  | "runWorkflow"
  | "showResult"
  | "openFile"
  | "playSound"
  /** Contributed by a feature module: params.feature + params.action pick the handler (see FeatureWorkflowAction). */
  | "feature";

/**
 * Every action has a stable id, a type and a params bag. Params are strings
 * that may contain {{variables}}: {{input}}, {{clipboard}}, {{result}},
 * {{date}}, {{time}}, {{selection}}, plus any user variable set by setVariable.
 */
export interface WorkflowAction {
  id: string;
  type: ActionType;
  /** user-facing label override */
  label?: string;
  params: Record<string, string>;
  /** For "condition": nested branches. */
  then?: WorkflowAction[];
  else?: WorkflowAction[];
  /** disabled actions are skipped at runtime */
  disabled?: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  icon: ItemIcon;
  alias?: string;
  hotkey?: string;
  keywords?: string[];
  /** When true, the launcher passes the text after the name as {{input}}. */
  acceptsInput?: boolean;
  actions: WorkflowAction[];
  createdAt: number;
  updatedAt: number;
}

export interface ActionSpec {
  type: ActionType;
  title: string;
  description: string;
  icon: ItemIcon;
  category: "apps" | "web" | "text" | "clipboard" | "scripting" | "control" | "system";
  params: Array<{
    key: string;
    label: string;
    /** "hidden" params are stored on the action (defaults) but not shown in the editor. */
    kind: "text" | "multiline" | "number" | "select" | "app" | "file" | "url" | "hidden";
    placeholder?: string;
    options?: string[];
    required?: boolean;
    default?: string;
  }>;
  /** variable produced by the action, if any (available as {{result}} and {{<outputVar>}}) */
  outputVar?: string;
  /** For type "feature": the contributing feature id and its action id (also stored as hidden params). */
  feature?: string;
  action?: string;
}

export interface RunLogEntry {
  actionId: string;
  type: ActionType;
  status: "ok" | "error" | "skipped";
  startedAt: number;
  endedAt: number;
  output?: string;
  error?: string;
}

export interface RunResult {
  workflowId: string;
  ok: boolean;
  log: RunLogEntry[];
  variables: Record<string, string>;
  result?: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  /** Electron accelerator string, e.g. "Alt+Space" */
  hotkey: string;
  theme: "system" | "dark" | "light";
  /** source ids that are turned off */
  disabledSources: string[];
  /** directories to scan for apps */
  appDirectories: string[];
  /** enable Spotlight-backed file search */
  fileSearch: boolean;
  /** show calculator results inline */
  calculator: boolean;
  /** maximum results per section */
  sectionLimit: number;
  /** hide window when it loses focus */
  hideOnBlur: boolean;
  /** keep the launcher open after running a command (except ones that bring another app forward) */
  keepOpenAfterRun: boolean;
  /** usage-decay half life in days (frecency) */
  frecencyHalfLifeDays: number;
  /** Vim-style navigation: Ctrl+J/K always; Esc enters normal mode where j/k/gg/G/… work. */
  vimMode: boolean;
  /** Start Glide when you log in. */
  launchAtLogin: boolean;
  /** Per-feature settings bags, keyed by feature id. Each feature owns its own shape and defaults. */
  features: Record<string, Record<string, unknown>>;
}

export const DEFAULT_SETTINGS: Settings = {
  hotkey: "Alt+Space",
  theme: "system",
  disabledSources: [],
  appDirectories: ["/Applications", "/System/Applications", "/System/Applications/Utilities", "~/Applications"],
  fileSearch: true,
  calculator: true,
  sectionLimit: 8,
  hideOnBlur: true,
  keepOpenAfterRun: true,
  frecencyHalfLifeDays: 10,
  vimMode: true,
  launchAtLogin: false,
  features: {},
};

export interface Quicklink {
  id: string;
  name: string;
  url: string;
  icon?: ItemIcon;
  alias?: string;
  keywords?: string[];
  /** Open with this app instead of the default handler: an app bundle path or bundle id. */
  openWith?: string;
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
  keyword?: string; // typed keyword that expands
  alias?: string;
  /** Rich-text body (HTML). `text` stays the plain-text fallback. */
  html?: string;
  /** Bundle ids of apps where the keyword never expands. */
  excludedApps?: string[];
}

/** Everything the renderer needs to render the settings screens. */
export interface UserData {
  settings: Settings;
  workflows: Workflow[];
  quicklinks: Quicklink[];
  snippets: Snippet[];
  favorites: string[]; // item ids
  aliases: Record<string, string>; // item id -> alias
  hotkeys: Record<string, string>; // item id -> accelerator
}

/**
 * Running these brings another app to the front (an app, a file or folder, a web page), so the
 * launcher steps aside even when Settings.keepOpenAfterRun is on. `actionId` is the ⌘K action, if any.
 */
export function switchesApp(item: Pick<SearchItem, "kind">, actionId?: string): boolean {
  if (actionId && /^(copy|paste|reveal|pin|favorite|alias|hotkey|delete|remove)/i.test(actionId)) return false;
  return item.kind === "app" || item.kind === "file" || item.kind === "quicklink";
}
