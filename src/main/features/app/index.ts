/** "app" feature: launch at login, GitHub Releases updater, data export/import/reset and the HUD. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, dialog, Notification, shell, BrowserWindow } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { backupData, buildExport, freshData, parseImport, replaceData } from "./dataio";
import { disposeHud, hud, initHud } from "./hud";
import { parseFeed } from "./releases";
import { backgroundChecksAllowed, createUpdater, type UpdateState, type Updater } from "./updater";

export interface AppSettings extends Record<string, unknown> {
  /** "owner/repo" on GitHub; empty disables updates (and all update network traffic). */
  updateFeed: string;
  autoCheck: boolean;
}
/** The official release feed. Clearing it in Settings stores "" (which overrides this default). */
export const DEFAULT_UPDATE_FEED = "tobibytes/glide";
export const APP_DEFAULTS: AppSettings = { updateFeed: DEFAULT_UPDATE_FEED, autoCheck: true };


export interface AppInfo {
  version: string;
  packaged: boolean;
  userDataPath: string;
  appPath: string | null;
  launchAtLogin: boolean;
  updateFeed: string;
  autoCheck: boolean;
  update: UpdateState;
}

let ctx: FeatureContext | undefined;
let updater: Updater | undefined;
let appliedLogin: boolean | undefined;

const SETTINGS_PAGE = "app";
const bundlePath = (): string | null => (app.isPackaged ? path.resolve(app.getPath("exe"), "../../..") : null);
const appSettings = (): AppSettings => (ctx ? ctx.settings(APP_DEFAULTS) : APP_DEFAULTS);

function applyLoginItem(force = false): void {
  if (!ctx) return;
  const want = ctx.getGlobalSettings().launchAtLogin;
  if (!force && want === appliedLogin) return;
  appliedLogin = want;
  if (!app.isPackaged) {
    ctx.log(`launch at login = ${want} (not applied: only the packaged Glide.app can be a login item)`);
    return;
  }
  // Electron 44 dropped `openAsHidden` (a no-op since macOS 13); LSUIElement already starts Glide windowless.
  app.setLoginItemSettings({ openAtLogin: want });
}

function info(): AppInfo {
  const s = appSettings();
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    userDataPath: app.getPath("userData"),
    appPath: bundlePath(),
    launchAtLogin: ctx?.getGlobalSettings().launchAtLogin ?? false,
    updateFeed: s.updateFeed,
    autoCheck: s.autoCheck,
    update: updater?.state() ?? { status: "disabled", currentVersion: app.getVersion(), feed: s.updateFeed },
  };
}

function setLaunchAtLogin(on: boolean): boolean {
  ctx?.store.setSettings({ launchAtLogin: on });
  return on;
}

function notifyAvailable(version: string): void {
  ctx?.refreshCatalogue();
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `Glide ${version} is available`, body: `You have ${app.getVersion()}. Open Glide and choose “Update Glide to v${version}”.`, silent: true });
  n.on("click", () => ctx?.openSettings(SETTINGS_PAGE));
  n.show();
}

const parentWindow = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? undefined;

async function exportSettings(): Promise<{ ok: boolean; path?: string }> {
  if (!ctx) return { ok: false };
  const opts = { title: "Export Glide Settings", defaultPath: path.join(app.getPath("documents"), `Glide Settings ${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: "JSON", extensions: ["json"] }] };
  const win = parentWindow();
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return { ok: false };
  await fs.writeFile(res.filePath, JSON.stringify(buildExport(ctx.getData(), app.getVersion()), null, 2), "utf8");
  return { ok: true, path: res.filePath };
}

async function importSettings(): Promise<{ ok: boolean; path?: string; backup?: string; error?: string }> {
  if (!ctx) return { ok: false };
  const opts = { title: "Import Glide Settings", properties: ["openFile" as const], filters: [{ name: "JSON", extensions: ["json"] }] };
  const win = parentWindow();
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const file = res.filePaths[0];
  if (res.canceled || !file) return { ok: false };
  try {
    const next = parseImport(JSON.parse(await fs.readFile(file, "utf8")) as unknown);
    const backup = await backupData(app.getPath("userData"), ctx.getData(), "before-import");
    replaceData(ctx.store, next);
    return { ok: true, path: file, backup };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function resetGlide(): Promise<{ ok: boolean; backup?: string }> {
  if (!ctx) return { ok: false };
  const opts = {
    type: "warning" as const,
    buttons: ["Cancel", "Reset Glide"],
    defaultId: 0,
    cancelId: 0,
    message: "Reset Glide to its defaults?",
    detail: "Settings, workflows, quicklinks, snippets, favorites, aliases, hotkeys and launch history go back to a fresh install. A backup of the current data is saved in the data folder under backups/. Feature data such as clipboard history is kept.",
  };
  const win = parentWindow();
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (response !== 1) return { ok: false };
  const backup = await backupData(app.getPath("userData"), ctx.getData(), "before-reset");
  replaceData(ctx.store, freshData());
  ctx.store.setUsage([]);
  return { ok: true, backup };
}

function setUpdateSettings(patch: Partial<Pick<AppSettings, "updateFeed" | "autoCheck">>): AppInfo {
  const clean: Record<string, unknown> = {};
  if (typeof patch.updateFeed === "string") {
    const trimmed = patch.updateFeed.trim();
    clean.updateFeed = trimmed ? (parseFeed(trimmed) ?? trimmed) : "";
  }
  if (typeof patch.autoCheck === "boolean") clean.autoCheck = patch.autoCheck;
  ctx?.setSettings(clean);
  return info();
}

const ITEM = {
  login: "app:toggle-login",
  check: "app:check-updates",
  install: "app:install-update",
  data: "app:data-folder",
} as const;

function items(): SearchItem[] {
  const st = updater?.state();
  const base: SearchItem[] = [
    { id: ITEM.login, kind: "command", kindLabel: "Glide", title: "Toggle Launch at Login", subtitle: ctx?.getGlobalSettings().launchAtLogin ? "On" : "Off", icon: { kind: "emoji", value: "🔁" }, keywords: ["startup", "login item", "autostart"], feature: "app" },
    { id: ITEM.check, kind: "command", kindLabel: "Glide", title: "Check for Glide Updates", subtitle: st?.status === "disabled" ? "No update feed set" : `Version ${app.getVersion()}`, icon: { kind: "emoji", value: "⬆️" }, keywords: ["update", "upgrade", "version"], feature: "app" },
    { id: ITEM.data, kind: "command", kindLabel: "Glide", title: "Show Glide Data Folder", icon: { kind: "emoji", value: "📁" }, keywords: ["support", "data.json", "backup"], feature: "app" },
  ];
  if (st?.status === "available" && st.latestVersion) {
    base.unshift({ id: ITEM.install, kind: "command", kindLabel: "Glide", title: `Update Glide to v${st.latestVersion}`, subtitle: `Installed: ${app.getVersion()}`, icon: { kind: "emoji", value: "✨" }, keywords: ["update", "install"], feature: "app" });
  }
  return base;
}

async function execute(item: SearchItem): Promise<ExecuteResult> {
  if (!ctx || !updater) return { ok: false, error: "Glide is still starting" };
  switch (item.id) {
    case ITEM.login: {
      const on = setLaunchAtLogin(!ctx.getGlobalSettings().launchAtLogin);
      hud(`Launch at Login: ${on ? "On" : "Off"}`);
      return { ok: true, hide: true, message: app.isPackaged ? undefined : "Saved; takes effect in the packaged app" };
    }
    case ITEM.check: {
      if (!parseFeed(appSettings().updateFeed)) return { ok: true, navigate: `settings/${SETTINGS_PAGE}`, message: "Updates are off until you set an update feed" };
      const st = await updater.check();
      if (st.status === "available") return { ok: true, message: `Glide ${st.latestVersion} is available` };
      if (st.status === "error") return { ok: false, error: st.error };
      hud("Glide is up to date");
      return { ok: true, hide: true };
    }
    case ITEM.install: {
      hud("Installing update…");
      const st = await updater.install();
      return st.status === "error" ? { ok: false, error: st.error } : { ok: true, hide: true };
    }
    case ITEM.data:
      await shell.openPath(app.getPath("userData"));
      return { ok: true, hide: true };
    default:
      return { ok: false, error: `Unknown item ${item.id}` };
  }
}

export const feature: FeatureModule = {
  id: "app",
  start(c) {
    ctx = c;
    initHud(c);
    applyLoginItem(true);
    let lastKey = "";
    const settingsKey = () => JSON.stringify([appSettings().updateFeed, appSettings().autoCheck]);
    updater = createUpdater({
      currentVersion: app.getVersion(),
      getFeed: () => appSettings().updateFeed,
      getAutoCheck: () =>
        appSettings().autoCheck &&
        backgroundChecksAllowed({ packaged: app.isPackaged, headless: process.env.GLIDE_HEADLESS === "1", testBaseUrl: process.env.GLIDE_UPDATE_BASE_URL }),
      currentAppPath: bundlePath,
      workDir: () => path.join(os.tmpdir(), `glide-update-${Date.now()}`),
      trash: (p) => shell.trashItem(p),
      relaunch: () => {
        void c.store.flush().finally(() => {
          app.relaunch();
          app.exit(0);
        });
      },
      onChange: (state) => {
        c.emit("update-state", state);
        c.refreshCatalogue();
      },
      onAvailable: notifyAvailable,
      // Test-only override that points the updater at a local fake GitHub API.
      baseUrl: process.env.GLIDE_UPDATE_BASE_URL || undefined,
      log: c.log,
    });
    lastKey = settingsKey();
    c.store.on("change", () => {
      applyLoginItem();
      const key = settingsKey();
      if (key !== lastKey) {
        lastKey = key;
        updater?.reschedule();
        c.emit("update-state", updater?.state());
      }
    });
  },
  stop() {
    updater?.dispose();
    disposeHud();
  },
  items,
  actions(item): ItemAction[] {
    if (item.id === ITEM.install) return [{ id: "install", title: "Install Update and Relaunch", icon: "✨" }, { id: "notes", title: "Open Release Page", shortcut: "⌘⏎", icon: "🌐" }];
    return [{ id: "run", title: "Run", icon: "⏎" }, { id: "settings", title: "Open Updates & App Settings", shortcut: "⌘⏎", icon: "⚙️" }];
  },
  async runAction(scored: ScoredItem, actionId: string): Promise<ExecuteResult> {
    if (actionId === "settings") return { ok: true, navigate: `settings/${SETTINGS_PAGE}` };
    if (actionId === "notes") {
      const url = updater?.state().releaseUrl;
      if (url?.startsWith("https://")) await shell.openExternal(url);
      return { ok: true, hide: true };
    }
    return execute(scored.item);
  },
  methods: {
    hud: (text) => hud(typeof text === "string" ? text : String(text)),
    info: () => info(),
    setUpdateSettings: (patch) => setUpdateSettings((patch ?? {}) as Partial<AppSettings>),
    setLaunchAtLogin: (on) => setLaunchAtLogin(on === true),
    checkNow: () => updater?.check() ?? info().update,
    install: () => updater?.install() ?? info().update,
    showDataFolder: () => shell.openPath(app.getPath("userData")),
    exportSettings: () => exportSettings(),
    importSettings: () => importSettings(),
    reset: () => resetGlide(),
  },
};
