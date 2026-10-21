import { ipcMain } from "electron";
import { IPC } from "@shared/ipc";
import type { Quicklink, ScoredItem, SearchItem, Settings, Snippet, Workflow } from "@shared/types";
import type { SearchEngine } from "@engine/api";
import type { Executor } from "./execute";
import type { AppSource } from "./sources/apps";
import { calculatorItems, CALCULATOR_SOURCE_ID } from "./sources/calculator";
import { FILE_SOURCE_ID, type FileSource } from "./sources/files";
import type { Store } from "./store";
import type { Windows } from "./window";
import type { WorkflowRuntime } from "./workflows/runtime";
import { ACTION_SPECS } from "./workflows/specs";

export interface IpcDeps {
  store: Store;
  engine: SearchEngine;
  apps: AppSource;
  files: FileSource;
  executor: Executor;
  windows: Windows;
  runtime: WorkflowRuntime;
  features?: FeatureHost;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function isSearchItem(v: unknown): v is SearchItem {
  return isRecord(v) && typeof v.id === "string" && typeof v.kind === "string" && typeof v.title === "string";
}
function isScoredItem(v: unknown): v is ScoredItem {
  return isRecord(v) && isSearchItem(v.item);
}
function isWorkflow(v: unknown): v is Workflow {
  return isRecord(v) && typeof v.name === "string" && Array.isArray(v.actions);
}
function isQuicklink(v: unknown): v is Quicklink {
  return isRecord(v) && typeof v.name === "string" && typeof v.url === "string";
}
function isSnippet(v: unknown): v is Snippet {
  return isRecord(v) && typeof v.name === "string" && typeof v.text === "string";
}
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

import { setLastQuery } from "./last-query";
import type { FeatureHost } from "./features/host";

export function registerIpc(deps: IpcDeps): void {
  const { store, engine, apps, files, executor, windows, runtime } = deps;

  ipcMain.handle(IPC.SEARCH_QUERY, async (_e, query: unknown) => {
    const q = str(query);
    setLastQuery(q);
    const settings = store.getSettings();
    const disabled = new Set(settings.disabledSources);
    const dynamicItems: ScoredItem[] = [];
    if (settings.calculator && !disabled.has(CALCULATOR_SOURCE_ID)) dynamicItems.push(...calculatorItems(q));
    if (settings.fileSearch && !disabled.has(FILE_SOURCE_ID) && q.trim()) {
      try {
        dynamicItems.push(...(await files.search(q)));
      } catch (err) {
        console.warn("[files] search failed:", err);
      }
    } else {
      files.cancel();
    }
    if (deps.features) dynamicItems.push(...(await deps.features.dynamicItems(q)));
    return engine.search(q, { dynamicItems });
  });

  ipcMain.handle(IPC.SEARCH_EXECUTE, (_e, item: unknown, modifiers: unknown) => {
    if (!isScoredItem(item)) return { ok: false, error: "Invalid item" };
    return executor.execute(item, isRecord(modifiers) ? modifiers : undefined);
  });

  ipcMain.handle(IPC.SEARCH_ACTIONS, (_e, item: unknown) => (isSearchItem(item) ? executor.actionsFor(item) : []));

  ipcMain.handle(IPC.SEARCH_RUN_ACTION, (_e, item: unknown, actionId: unknown) => {
    if (!isScoredItem(item) || typeof actionId !== "string") return { ok: false, error: "Invalid action" };
    return executor.runAction(item, actionId);
  });

  ipcMain.handle(IPC.DATA_GET, () => store.getData());

  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: unknown) => store.setSettings(isRecord(patch) ? (patch as Partial<Settings>) : {}));

  ipcMain.handle(IPC.WORKFLOW_SAVE, (_e, wf: unknown) => {
    if (!isWorkflow(wf)) throw new Error("Invalid workflow");
    return store.saveWorkflow({ ...wf, id: str(wf.id) || newId("wf"), icon: wf.icon ?? { kind: "emoji", value: "🧩" } });
  });
  ipcMain.handle(IPC.WORKFLOW_DELETE, (_e, id: unknown) => store.deleteWorkflow(str(id)));
  ipcMain.handle(IPC.WORKFLOW_RUN, async (_e, id: unknown, input: unknown) => {
    const wf = store.getData().workflows.find((w) => w.id === str(id));
    if (!wf) throw new Error("Workflow not found");
    return runtime.run(wf, str(input));
  });
  ipcMain.handle(IPC.WORKFLOW_ACTION_SPECS, () => ACTION_SPECS);

  ipcMain.handle(IPC.QUICKLINK_SAVE, (_e, q: unknown) => {
    if (!isQuicklink(q)) throw new Error("Invalid quicklink");
    return store.saveQuicklink({ ...q, id: str(q.id) || newId("ql") });
  });
  ipcMain.handle(IPC.QUICKLINK_DELETE, (_e, id: unknown) => store.deleteQuicklink(str(id)));

  ipcMain.handle(IPC.SNIPPET_SAVE, (_e, s: unknown) => {
    if (!isSnippet(s)) throw new Error("Invalid snippet");
    return store.saveSnippet({ ...s, id: str(s.id) || newId("sn") });
  });
  ipcMain.handle(IPC.SNIPPET_DELETE, (_e, id: unknown) => store.deleteSnippet(str(id)));

  ipcMain.handle(IPC.FAVORITE_TOGGLE, (_e, itemId: unknown) => store.toggleFavorite(str(itemId)));
  ipcMain.handle(IPC.ALIAS_SET, (_e, itemId: unknown, alias: unknown) => store.setAlias(str(itemId), typeof alias === "string" ? alias : null));
  ipcMain.handle(IPC.HOTKEY_SET, (_e, itemId: unknown, accel: unknown) => store.setHotkey(str(itemId), typeof accel === "string" ? accel : null));
  ipcMain.handle(IPC.APPS_LIST, () => apps.items());

  ipcMain.on(IPC.WINDOW_HIDE, () => windows.hideLauncher());
  ipcMain.on(IPC.WINDOW_RESIZE, (_e, height: unknown) => {
    if (typeof height === "number" && Number.isFinite(height)) windows.resizeLauncher(height);
  });
  ipcMain.on(IPC.WINDOW_OPEN_SETTINGS, (_e, page: unknown) => windows.openSettings(typeof page === "string" ? page : undefined));
}
