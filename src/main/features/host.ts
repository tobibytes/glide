import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, globalShortcut, ipcMain, type BrowserWindowConstructorOptions } from "electron";
import { IPC, type ExecuteModifiers, type ExecuteResult, type FeatureEvent, type ItemAction, type ViewRequest } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import type { NativeHelper } from "../native/helper";
import type { Store } from "../store";
import { loadRenderer, webPreferences, type Windows } from "../window";
import type { WorkflowRuntime } from "../workflows/runtime";
import type { FeatureContext, FeatureModule } from "./types";

export interface FeatureHostDeps {
  store: Store;
  runtime: WorkflowRuntime;
  helper: NativeHelper;
  windows: Windows;
  refreshCatalogue(): void;
  executeItem(itemId: string, argument?: string): Promise<ExecuteResult>;
}

export interface FeatureHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  items(): SearchItem[];
  dynamicItems(query: string): Promise<ScoredItem[]>;
  owns(item: SearchItem): boolean;
  actions(item: SearchItem): ItemAction[];
  runAction(item: ScoredItem, actionId: string, modifiers?: ExecuteModifiers): Promise<ExecuteResult>;
  openView(view: ViewRequest): void;
}

const DYNAMIC_TIMEOUT_MS = 250;

export function createFeatureHost(modules: FeatureModule[], deps: FeatureHostDeps): FeatureHost {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const hotkeys = new Map<string, string>(); // "<feature>:<key>" -> accelerator

  const openView = (view: ViewRequest) => {
    deps.windows.showLauncher();
    // The launcher's renderer resets on show; send the view after that reset.
    setTimeout(() => deps.windows.sendToLauncher(IPC.EVT_OPEN_VIEW, view), 30);
  };

  const contextFor = (m: FeatureModule): FeatureContext => ({
    id: m.id,
    store: deps.store,
    runtime: deps.runtime,
    helper: deps.helper,
    dataDir: () => {
      const dir = path.join(app.getPath("userData"), "features", m.id);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    settings: <T extends Record<string, unknown>>(defaults: T): T => ({ ...defaults, ...(deps.store.getSettings().features?.[m.id] ?? {}) }) as T,
    setSettings: (patch) => {
      const all = deps.store.getSettings().features ?? {};
      deps.store.setSettings({ features: { ...all, [m.id]: { ...(all[m.id] ?? {}), ...patch } } });
    },
    getData: () => deps.store.getData(),
    getGlobalSettings: () => deps.store.getSettings(),
    emit: (event, payload) => {
      const e: FeatureEvent = { feature: m.id, event, payload };
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.EVT_FEATURE, e);
    },
    refreshCatalogue: deps.refreshCatalogue,
    showLauncher: deps.windows.showLauncher,
    hideLauncher: deps.windows.hideLauncher,
    openView,
    openSettings: deps.windows.openSettings,
    createWindow: (route: string, options: BrowserWindowConstructorOptions = {}) => {
      const win = new BrowserWindow({ show: false, ...options, webPreferences: { ...webPreferences, ...(options.webPreferences ?? {}) } });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      void loadRenderer(win, `/${route.replace(/^[#/]+/, "")}`);
      return win;
    },
    registerHotkey: (key, accelerator, handler) => {
      const slot = `${m.id}:${key}`;
      const previous = hotkeys.get(slot);
      if (previous) {
        globalShortcut.unregister(previous);
        hotkeys.delete(slot);
      }
      if (!accelerator) return true;
      try {
        const ok = globalShortcut.register(accelerator, handler);
        if (ok) hotkeys.set(slot, accelerator);
        return ok;
      } catch {
        return false;
      }
    },
    executeItem: deps.executeItem,
    log: (...args) => console.log(`[${m.id}]`, ...args),
  });

  ipcMain.handle(IPC.FEATURE_INVOKE, async (_e, featureId: unknown, method: unknown, ...args: unknown[]) => {
    if (typeof featureId !== "string" || typeof method !== "string") throw new Error("Invalid feature call");
    const fn = byId.get(featureId)?.methods?.[method];
    if (!fn) throw new Error(`Unknown feature method ${featureId}.${method}`);
    return fn(...args);
  });

  const safe = <T>(m: FeatureModule, what: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      console.warn(`[${m.id}] ${what} failed:`, err);
      return fallback;
    }
  };

  return {
    async start() {
      for (const m of modules) {
        try {
          await m.start?.(contextFor(m));
        } catch (err) {
          console.warn(`[${m.id}] start failed:`, err);
        }
      }
    },
    async stop() {
      for (const m of modules) await Promise.resolve(m.stop?.()).catch(() => undefined);
    },
    items: () =>
      modules.flatMap((m) => safe(m, "items", () => (m.items?.() ?? []).map((i) => ({ ...i, feature: i.feature ?? m.id })), [])),
    async dynamicItems(query) {
      const results = await Promise.all(
        modules.map(async (m) => {
          if (!m.dynamicItems) return [];
          const timeout = new Promise<ScoredItem[]>((resolve) => setTimeout(() => resolve([]), DYNAMIC_TIMEOUT_MS));
          try {
            const items = await Promise.race([Promise.resolve(m.dynamicItems(query)), timeout]);
            return items.map((s) => ({ ...s, item: { ...s.item, feature: s.item.feature ?? m.id } }));
          } catch (err) {
            console.warn(`[${m.id}] dynamicItems failed:`, err);
            return [];
          }
        }),
      );
      return results.flat();
    },
    owns: (item) => !!item.feature && byId.has(item.feature),
    actions: (item) => {
      const m = item.feature ? byId.get(item.feature) : undefined;
      return m ? safe(m, "actions", () => m.actions?.(item) ?? [], []) : [];
    },
    async runAction(item, actionId, modifiers) {
      const m = item.item.feature ? byId.get(item.item.feature) : undefined;
      if (!m?.runAction) return { ok: false, error: "This item has no handler" };
      try {
        return await m.runAction(item, actionId, modifiers);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    openView,
  };
}
