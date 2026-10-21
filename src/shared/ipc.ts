/**
 * IPC channel names and payload types. The preload exposes `window.glide`
 * implementing GlideApi; main handles the channels with ipcMain.handle.
 */
import type {
  SearchResponse,
  ScoredItem,
  SearchItem,
  UserData,
  Settings,
  Workflow,
  Quicklink,
  Snippet,
  RunResult,
  ActionSpec,
} from "./types";

export const IPC = {
  // search
  SEARCH_QUERY: "search:query", // (query: string) => SearchResponse
  SEARCH_EXECUTE: "search:execute", // (item: ScoredItem, modifiers?: ExecuteModifiers) => ExecuteResult
  SEARCH_ACTIONS: "search:actions", // (item: SearchItem) => ItemAction[]
  SEARCH_RUN_ACTION: "search:runAction", // (item: ScoredItem, actionId: string) => ExecuteResult
  // data
  DATA_GET: "data:get", // () => UserData
  SETTINGS_SET: "settings:set", // (patch: Partial<Settings>) => Settings
  WORKFLOW_SAVE: "workflow:save", // (wf: Workflow) => Workflow
  WORKFLOW_DELETE: "workflow:delete", // (id: string) => void
  WORKFLOW_RUN: "workflow:run", // (id: string, input?: string) => RunResult
  WORKFLOW_ACTION_SPECS: "workflow:actionSpecs", // () => ActionSpec[]
  QUICKLINK_SAVE: "quicklink:save",
  QUICKLINK_DELETE: "quicklink:delete",
  SNIPPET_SAVE: "snippet:save",
  SNIPPET_DELETE: "snippet:delete",
  FAVORITE_TOGGLE: "favorite:toggle", // (itemId: string) => string[]
  ALIAS_SET: "alias:set", // (itemId: string, alias: string | null) => Record<string,string>
  HOTKEY_SET: "hotkey:set", // (itemId: string, accel: string | null) => Record<string,string>
  APPS_LIST: "apps:list", // () => SearchItem[] (for the workflow editor's app picker)
  // window
  WINDOW_HIDE: "window:hide",
  WINDOW_RESIZE: "window:resize", // (height: number) => void
  WINDOW_OPEN_SETTINGS: "window:openSettings", // (page?: string) => void
  // events main -> renderer
  EVT_SHOW: "evt:show", // window became visible; renderer should focus + reset
  EVT_DATA_CHANGED: "evt:dataChanged", // UserData changed on disk
  EVT_NAVIGATE: "evt:navigate", // (route: string) => void, e.g. "settings/workflows/<id>"
  // workflow prompts (main -> launcher) and answers (launcher -> main)
  EVT_ASK_INPUT: "evt:askInput", // { requestId, prompt, placeholder? }
  ASK_INPUT_ANSWER: "askInput:answer", // (requestId: string, value: string | null)
  EVT_SHOW_RESULT: "evt:showResult", // { title?, text }
  // feature modules (src/main/features, src/renderer/features)
  FEATURE_INVOKE: "feature:invoke", // (featureId: string, method: string, ...args) => unknown
  EVT_FEATURE: "evt:feature", // FeatureEvent
  EVT_OPEN_VIEW: "evt:openView", // ViewRequest — show the launcher and push this view
} as const;

/** A launcher view to push onto the navigation stack (rendered by src/renderer/features/registry). */
export interface ViewRequest {
  /** "<featureId>.<viewName>", e.g. "clipboard.history" */
  id: string;
  props?: Record<string, unknown>;
}

/** Event pushed from a main-process feature to every renderer window. */
export interface FeatureEvent {
  feature: string;
  event: string;
  payload?: unknown;
}

export interface AskInputRequest {
  requestId: string;
  prompt: string;
  placeholder?: string;
}

export interface ShowResultPayload {
  title?: string;
  text: string;
}

export interface ExecuteModifiers {
  cmd?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  /** when true, the renderer should hide the window */
  hide?: boolean;
  /** when set, the renderer should navigate to this route instead of hiding */
  navigate?: string;
  /** when set, the launcher pushes this view instead of hiding */
  view?: ViewRequest;
  message?: string;
  error?: string;
  run?: RunResult;
}

export interface ItemAction {
  id: string;
  title: string;
  shortcut?: string; // e.g. "⌘⏎"
  icon?: string; // emoji
  destructive?: boolean;
}

export interface GlideApi {
  search(query: string): Promise<SearchResponse>;
  execute(item: ScoredItem, modifiers?: ExecuteModifiers): Promise<ExecuteResult>;
  actionsFor(item: SearchItem): Promise<ItemAction[]>;
  runAction(item: ScoredItem, actionId: string): Promise<ExecuteResult>;
  getData(): Promise<UserData>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  saveWorkflow(wf: Workflow): Promise<Workflow>;
  deleteWorkflow(id: string): Promise<void>;
  runWorkflow(id: string, input?: string): Promise<RunResult>;
  actionSpecs(): Promise<ActionSpec[]>;
  saveQuicklink(q: Quicklink): Promise<Quicklink>;
  deleteQuicklink(id: string): Promise<void>;
  saveSnippet(s: Snippet): Promise<Snippet>;
  deleteSnippet(id: string): Promise<void>;
  toggleFavorite(itemId: string): Promise<string[]>;
  setAlias(itemId: string, alias: string | null): Promise<Record<string, string>>;
  setHotkey(itemId: string, accel: string | null): Promise<Record<string, string>>;
  listApps(): Promise<SearchItem[]>;
  hide(): void;
  resize(height: number): void;
  openSettings(page?: string): void;
  onShow(cb: () => void): () => void;
  onDataChanged(cb: (data: UserData) => void): () => void;
  onNavigate(cb: (route: string) => void): () => void;
  /** A running workflow asks the user for text; reply with answerInput (null cancels). */
  onAskInput(cb: (req: AskInputRequest) => void): () => void;
  answerInput(requestId: string, value: string | null): void;
  /** A workflow's showResult action wants text displayed in the launcher. */
  onShowResult(cb: (payload: ShowResultPayload) => void): () => void;
  /** Call a method exposed by a main-process feature module. */
  feature<T = unknown>(featureId: string, method: string, ...args: unknown[]): Promise<T>;
  /** Subscribe to events from feature modules. */
  onFeatureEvent(cb: (e: FeatureEvent) => void): () => void;
  /** Main asks the launcher to show a view (e.g. a hotkey bound to Clipboard History). */
  onOpenView(cb: (view: ViewRequest) => void): () => void;
  platform: "darwin" | "win32" | "linux";
}

declare global {
  interface Window {
    glide: GlideApi;
  }
}
