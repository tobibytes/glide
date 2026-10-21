import { app, globalShortcut } from "electron";
import { IPC } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { createEngine } from "@engine/index";
import { createCatalogue } from "./catalogue";
import { createExecutor } from "./execute";
import { syncHotkeys } from "./hotkeys";
import { installIconProtocol, registerIconScheme } from "./icons";
import { registerIpc } from "./ipc";
import { createPrompts } from "./prompts";
import { createAppSource } from "./sources/apps";
import { createFileSource } from "./sources/files";
import { Store } from "./store";
import { createTray } from "./tray";
import { createWindows } from "./window";
import { createWorkflowRuntime } from "./workflows/runtime";
import { createFeatureHost } from "./features/host";
import { FEATURES } from "./features/registry";
import { createNativeHelper, type NativeHelper } from "./native/helper";
import { HEADLESS, HEADLESS_HELPER_METHODS, installHeadless } from "./headless";

installHeadless();

app.setName("Glide");
// Test runs point this at a throwaway directory so they never touch real user data.
if (process.env.GLIDE_USER_DATA) {
  app.setPath("userData", process.env.GLIDE_USER_DATA);
  app.setPath("sessionData", process.env.GLIDE_USER_DATA);
}
registerIconScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();
  app.dock?.hide();
  installIconProtocol();

  const store = new Store(app.getPath("userData"));
  await store.load();

  const settings = () => store.getSettings();
  const engine = createEngine({
    frecencyHalfLifeDays: settings().frecencyHalfLifeDays,
    sectionLimit: settings().sectionLimit,
    favorites: new Set(store.getData().favorites),
    aliases: store.getData().aliases,
  });
  engine.setUsage(store.getUsage());

  // prompts is assigned right after windows; the callback only runs once the launcher hides.
  let cancelPrompts: () => void = () => undefined;
  const windows = createWindows({ getHideOnBlur: () => settings().hideOnBlur, onLauncherHidden: () => cancelPrompts() });
  const prompts = createPrompts(windows);
  cancelPrompts = prompts.cancelAll;

  const apps = createAppSource(() => settings().appDirectories);
  const files = createFileSource();
  const runtime = createWorkflowRuntime({
    getWorkflow: (id) => store.getData().workflows.find((w) => w.id === id),
    askInput: prompts.askInput,
    showResult: prompts.showResult,
    hideLauncher: windows.hideLauncher,
  });

  const helper = HEADLESS ? readOnlyHelper(createNativeHelper()) : createNativeHelper();
  // Late-bound: feature items feed the catalogue, and features need catalogue/executor.
  let featureItems: () => SearchItem[] = () => [];
  const scoredFrom = (item: SearchItem): ScoredItem => ({ item, score: 0, matchScore: 0, matchKind: "none", frecency: 0, ranges: [] });
  const catalogue = createCatalogue({
    store,
    apps,
    engine,
    featureItems: () => featureItems(),
    onHotkey: (item) => {
      void executor.execute(scoredFrom(item)).then((result) => {
        if (result.navigate) windows.openSettings(result.navigate);
        else if (result.view) features.openView(result.view);
        else if (!result.ok) console.warn(`[hotkey] ${item.title}: ${result.error}`);
      });
    },
  });
  const executorDeps = { store, engine, catalogue, windows, runtime };
  const executor = createExecutor(executorDeps);
  const features = createFeatureHost(FEATURES, {
    store,
    runtime,
    helper,
    windows,
    refreshCatalogue: () => catalogue.rebuild(),
    executeItem: async (itemId, argument) => {
      const item = catalogue.find(itemId);
      if (!item) return { ok: false, error: `No item ${itemId}` };
      const result = await executor.execute({ ...scoredFrom(item), argument });
      if (result.navigate) windows.openSettings(result.navigate);
      if (result.view) features.openView(result.view);
      return result;
    },
  });
  Object.assign(executorDeps, { features });
  featureItems = () => features.items();

  const syncShortcuts = () => {
    const failed = syncHotkeys([{ accel: settings().hotkey, handler: windows.toggleLauncher }, ...catalogue.hotkeyBindings()]);
    if (failed.length) console.warn("[hotkeys] could not register:", failed.join(", "));
  };

  catalogue.rebuild();
  syncShortcuts();
  apps.onChange(() => catalogue.rebuild());
  void apps.rescan();

  let appDirsKey = settings().appDirectories.join("\n");
  store.on("change", (data) => {
    catalogue.rebuild();
    syncShortcuts();
    const key = data.settings.appDirectories.join("\n");
    if (key !== appDirsKey) {
      appDirsKey = key;
      void apps.rescan();
    }
    windows.broadcast(IPC.EVT_DATA_CHANGED, data);
  });

  registerIpc({ store, engine, apps, files, executor, windows, runtime, features });
  await features.start();
  catalogue.rebuild();
  if (!HEADLESS) createTray(windows);
  windows.createLauncher();
  if (process.env.GLIDE_SHOW_ON_START) setTimeout(() => windows.showLauncher(), 800);

  app.on("second-instance", () => windows.showLauncher());
  app.on("activate", () => windows.showLauncher());
  app.on("window-all-closed", () => undefined); // menu-bar app: keep running
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    void features.stop();
    helper.dispose();
    apps.dispose();
    files.cancel();
  });

  let flushed = false;
  app.on("before-quit", (event) => {
    if (flushed) return;
    event.preventDefault();
    prompts.cancelAll();
    void store.flush().finally(() => {
      flushed = true;
      app.quit();
    });
  });
}

/** Headless test runs: the helper may read state but never move windows, type or tap the keyboard. */
function readOnlyHelper(inner: NativeHelper): NativeHelper {
  return {
    available: () => inner.available(),
    on: (event, cb) => inner.on(event, cb),
    dispose: () => inner.dispose(),
    call: ((method: string, ...params: unknown[]) => {
      if (!HEADLESS_HELPER_METHODS.has(method)) {
        console.log(`[headless] helper.blocked ${method}`);
        return Promise.reject(new Error(`helper method ${method} is disabled in headless mode`));
      }
      return (inner.call as (m: string, ...p: unknown[]) => Promise<unknown>)(method, ...params);
    }) as NativeHelper["call"],
  };
}
