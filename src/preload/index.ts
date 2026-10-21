import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type FeatureEvent, type GlideApi, type ViewRequest } from "@shared/ipc";
import type { UserData } from "@shared/types";
import { EXTRA_IPC, type AskInputRequest, type GlideApiExtras, type ShowResultPayload } from "../main/extra-ipc";

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const platform: GlideApi["platform"] =
  process.platform === "darwin" || process.platform === "win32" || process.platform === "linux" ? process.platform : "linux";

const api: GlideApi & GlideApiExtras = {
  search: (query) => ipcRenderer.invoke(IPC.SEARCH_QUERY, query),
  execute: (item, modifiers) => ipcRenderer.invoke(IPC.SEARCH_EXECUTE, item, modifiers),
  actionsFor: (item) => ipcRenderer.invoke(IPC.SEARCH_ACTIONS, item),
  runAction: (item, actionId) => ipcRenderer.invoke(IPC.SEARCH_RUN_ACTION, item, actionId),
  getData: () => ipcRenderer.invoke(IPC.DATA_GET),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  saveWorkflow: (wf) => ipcRenderer.invoke(IPC.WORKFLOW_SAVE, wf),
  deleteWorkflow: (id) => ipcRenderer.invoke(IPC.WORKFLOW_DELETE, id),
  runWorkflow: (id, input) => ipcRenderer.invoke(IPC.WORKFLOW_RUN, id, input),
  actionSpecs: () => ipcRenderer.invoke(IPC.WORKFLOW_ACTION_SPECS),
  saveQuicklink: (q) => ipcRenderer.invoke(IPC.QUICKLINK_SAVE, q),
  deleteQuicklink: (id) => ipcRenderer.invoke(IPC.QUICKLINK_DELETE, id),
  saveSnippet: (s) => ipcRenderer.invoke(IPC.SNIPPET_SAVE, s),
  deleteSnippet: (id) => ipcRenderer.invoke(IPC.SNIPPET_DELETE, id),
  toggleFavorite: (itemId) => ipcRenderer.invoke(IPC.FAVORITE_TOGGLE, itemId),
  setAlias: (itemId, alias) => ipcRenderer.invoke(IPC.ALIAS_SET, itemId, alias),
  setHotkey: (itemId, accel) => ipcRenderer.invoke(IPC.HOTKEY_SET, itemId, accel),
  listApps: () => ipcRenderer.invoke(IPC.APPS_LIST),
  hide: () => ipcRenderer.send(IPC.WINDOW_HIDE),
  resize: (height) => ipcRenderer.send(IPC.WINDOW_RESIZE, height),
  openSettings: (page) => ipcRenderer.send(IPC.WINDOW_OPEN_SETTINGS, page),
  onShow: (cb) => subscribe<[]>(IPC.EVT_SHOW, cb),
  onDataChanged: (cb) => subscribe<[UserData]>(IPC.EVT_DATA_CHANGED, cb),
  onNavigate: (cb) => subscribe<[string]>(IPC.EVT_NAVIGATE, cb),
  platform,
  // additive extras (see src/main/extra-ipc.ts)
  onAskInput: (cb) => subscribe<[AskInputRequest]>(EXTRA_IPC.EVT_ASK_INPUT, cb),
  answerInput: (requestId, value) => ipcRenderer.send(EXTRA_IPC.ASK_INPUT_ANSWER, requestId, value),
  onShowResult: (cb) => subscribe<[ShowResultPayload]>(EXTRA_IPC.EVT_SHOW_RESULT, cb),
  // feature modules
  feature: <T,>(featureId: string, method: string, ...args: unknown[]) => ipcRenderer.invoke(IPC.FEATURE_INVOKE, featureId, method, ...args) as Promise<T>,
  onFeatureEvent: (cb) => subscribe<[FeatureEvent]>(IPC.EVT_FEATURE, cb),
  onOpenView: (cb) => subscribe<[ViewRequest]>(IPC.EVT_OPEN_VIEW, cb),
};

contextBridge.exposeInMainWorld("glide", api);
