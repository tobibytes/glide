/**
 * Feature modules: each capability (clipboard history, window management, AI, …)
 * lives in src/main/features/<id>/index.ts and exports `feature: FeatureModule`.
 * The host (./host.ts) plugs modules into search, execution, IPC and windows,
 * so a feature never edits shared files.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import type { ExecuteModifiers, ExecuteResult, ItemAction, ViewRequest } from "@shared/ipc";
import type { ScoredItem, SearchItem, SearchResponse, Settings, UserData } from "@shared/types";
import type { SearchOptions } from "@shared/search";
import type { NativeHelper } from "../native/helper";
import type { Store } from "../store";
import type { WorkflowRuntime } from "../workflows/runtime";
import type { FeatureWorkflowAction as GenericWorkflowAction } from "../workflows/feature-actions";

export type { SearchOptions } from "@shared/search";
export type { FeatureActionOutput, ActionParamSpec } from "../workflows/feature-actions";
/** A workflow action contributed by a feature (shown in the editor library, run by the workflow runtime). */
export type FeatureWorkflowAction = GenericWorkflowAction<FeatureContext>;

export interface FeatureContext {
  readonly id: string;
  readonly store: Store;
  readonly runtime: WorkflowRuntime;
  /** The Swift helper (window management, keyboard tap, menus, calendar, AX). */
  readonly helper: NativeHelper;
  /** Private directory for this feature's files: <userData>/features/<id>/ (created on demand). */
  dataDir(): string;
  /** This feature's settings merged over `defaults`. */
  settings<T extends Record<string, unknown>>(defaults: T): T;
  setSettings(patch: Record<string, unknown>): void;
  getData(): UserData;
  getGlobalSettings(): Settings;
  /** Push an event to every renderer window (received via window.glide.onFeatureEvent). */
  emit(event: string, payload?: unknown): void;
  /** Re-read items() of every feature and push the catalogue to the engine. */
  refreshCatalogue(): void;
  showLauncher(): void;
  hideLauncher(): void;
  /** Show the launcher with a view pushed (e.g. "clipboard.history"). */
  openView(view: ViewRequest): void;
  openSettings(page?: string): void;
  /** Create a window that renders `#/<route>` (route registered in src/renderer/features/registry). */
  createWindow(route: string, options?: BrowserWindowConstructorOptions): BrowserWindow;
  /** Register (or replace) a global hotkey owned by this feature; returns false if the OS refused it. */
  registerHotkey(key: string, accelerator: string | null, handler: () => void): boolean;
  /** Run any catalogue item as if chosen in the launcher (records usage). */
  executeItem(itemId: string, argument?: string): Promise<ExecuteResult>;
  log(...args: unknown[]): void;
  /**
   * Search exactly like the launcher (catalogue + calculator + files + every feature's dynamic items,
   * engine ranking with frecency), flattened in launcher order. Fallback rows are excluded unless asked.
   */
  search(query: string, opts?: SearchOptions): Promise<ScoredItem[]>;
  /** The launcher's full sectioned response for `query`. */
  searchSections(query: string): Promise<SearchResponse>;
  /** A catalogue item by id (or a dynamic item returned by a recent search). */
  findItem(id: string): SearchItem | undefined;
  /** Call another feature's `methods[method]` (same as the renderer's window.glide.feature). Rejects if missing. */
  callFeature<T = unknown>(featureId: string, method: string, ...args: unknown[]): Promise<T>;
  /** Contribute a workflow action at runtime (replaces one with the same id); returns an unregister function. */
  registerWorkflowAction(action: FeatureWorkflowAction): () => void;
}

export interface FeatureModule {
  id: string;
  /** Called once after app ready. Long work must not block: kick it off and return. */
  start?(ctx: FeatureContext): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** Static catalogue items; re-read whenever refreshCatalogue() runs or user data changes. Set item.feature = id. */
  items?(): SearchItem[];
  /** Per-query items (like the calculator). Keep it fast (< 50 ms) or return [] for short queries. */
  dynamicItems?(query: string): ScoredItem[] | Promise<ScoredItem[]>;
  /** Actions for items whose item.feature === id. First action is primary; "⌘⏎" shortcut is secondary. */
  actions?(item: SearchItem): ItemAction[];
  runAction?(item: ScoredItem, actionId: string, modifiers?: ExecuteModifiers): Promise<ExecuteResult>;
  /** Methods callable from the renderer: window.glide.feature(id, name, ...args). */
  methods?: Record<string, (...args: unknown[]) => unknown>;
  /** Workflow actions this feature contributes; registered after start() with this feature's context. */
  workflowActions?: FeatureWorkflowAction[];
}
