/**
 * Extensions: installable folders whose commands run in an Electron utilityProcess each,
 * talking to main over parentPort JSON messages. See src/extension-api/README.md.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, screen, shell, utilityProcess } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { API_SHIM_SOURCE, buildRunnerSource } from "../../../extension-api/runtime";
import { buildRaycastRunnerSource, RAYCAST_SHIMS } from "../../../extension-api/raycast/runtime";
import { iconFor } from "../../../extension-api/icons";
import type { ChildMessage, JsonValue, ParentMessage, RequestMethod } from "../../../extension-api/types";
import { pasteFromClipboard } from "../../workflows/runtime";
import type { FeatureContext, FeatureModule } from "../types";
import { dispatchAction, findAction, isSafeUrl, type ActionOutcome } from "./actions";
import type { ExtensionSettings, ExtensionSummary, InstallRequest, PreferencesState, RaycastSupport, RunViewState, StoreListing, StoreResponse } from "./contract";
import { missingPreferences, prefKey, resolvePreferences, splitArguments, type CommandManifest } from "./manifest";
import type { LaunchType, RaycastCompat } from "./compat";
import { wireCompat, type CompatWiring } from "./compat-feature";
import { buildRaycastCommands, loadEsbuild, type EsbuildLike } from "./raycast-build";
import { ExtensionRegistry, isRaycastFolder, type InstalledExtension } from "./registry";
import { SessionManager, type AlertRequest, type ChildHandle, type SessionInfo, type ToastActionModel } from "./sessions";
import { bundledIndex, fetchIndex, type StoreEntry } from "./store-index";
import { storeMethods } from "./store-feature";

const ID = "extensions";
const RAYCAST_STORE_URL = "https://www.raycast.com/store";
const run = promisify(execFile);
const DEFAULTS: ExtensionSettings = { storeUrl: "" };

let ctx: FeatureContext | null = null;
let registry: ExtensionRegistry | null = null;
let sessions: SessionManager | null = null;
let runtimeDir = "";
let hudWindow: BrowserWindow | null = null;
/** Raycast menu-bar / background / OAuth / AI services (compat.ts, compat-feature.ts). */
let wiring: CompatWiring | null = null;
const compat = (): RaycastCompat | null => wiring?.compat ?? null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function reg(): ExtensionRegistry {
  if (!registry) throw new Error("Extensions are not ready yet");
  return registry;
}

function sess(): SessionManager {
  if (!sessions) throw new Error("Extensions are not ready yet");
  return sessions;
}

/** extensions-examples/ next to the app (dev) or copied into dist/ / Resources (packaged). */
function examplesDir(): string | undefined {
  const appPath = app.getAppPath();
  const candidates = [path.join(appPath, "extensions-examples"), path.join(appPath, "dist", "extensions-examples"), path.join(process.resourcesPath ?? "", "extensions-examples")];
  return candidates.find((d) => fs.existsSync(d));
}

function writeRuntime(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "runner.cjs"), buildRunnerSource());
  fs.writeFileSync(path.join(dir, "glide-api.cjs"), API_SHIM_SOURCE);
  fs.writeFileSync(path.join(dir, "raycast-runner.cjs"), buildRaycastRunnerSource());
  for (const [file, source] of Object.entries(RAYCAST_SHIMS)) fs.writeFileSync(path.join(dir, file), source);
}

// --- Raycast import ------------------------------------------------------------------

let esbuildCache: EsbuildLike | null | undefined;

/** esbuild from the app folder (development) or Resources/esbuild (a packaged build that ships it). */
function esbuild(): EsbuildLike | null {
  if (esbuildCache === undefined) esbuildCache = loadEsbuild([app.getAppPath(), path.join(process.resourcesPath ?? "", "esbuild")]);
  return esbuildCache;
}

async function buildRaycast(srcDir: string, outDir: string, manifest: Parameters<typeof buildRaycastCommands>[2]): Promise<string[]> {
  return (await buildRaycastCommands(srcDir, outDir, manifest, esbuild())).errors;
}

// --- HUD ------------------------------------------------------------------------

function showHud(text: string) {
  if (!ctx) return;
  ctx.hideLauncher();
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
  const width = Math.min(520, Math.max(180, text.length * 8 + 64));
  const height = 46;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = ctx.createWindow(`${ID}/hud/${encodeURIComponent(text.slice(0, 200))}`, {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height - 120),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
  });
  hudWindow = win;
  win.setIgnoreMouseEvents(true);
  win.once("ready-to-show", () => win.showInactive());
  setTimeout(() => {
    if (!win.isDestroyed()) win.close();
  }, 1800);
}

// --- extension process requests --------------------------------------------------

async function openTarget(target: string) {
  const t = target.trim();
  if (/^(javascript|data|vbscript):/i.test(t)) throw new Error("Refusing to open that URL scheme");
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^file:/i.test(t)) {
    await shell.openExternal(t);
    return;
  }
  const p = t.startsWith("~") ? path.join(app.getPath("home"), t.slice(1)) : t.replace(/^file:\/\//i, "");
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
}

async function pasteText(text: string) {
  clipboard.writeText(text);
  ctx?.hideLauncher();
  await sleep(150);
  await pasteFromClipboard();
}

/** Raycast clipboard content: a string or { text, html, file }. */
function clipText(v: JsonValue | undefined): { text: string; html?: string } {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, JsonValue>;
    const text = typeof o.text === "string" ? o.text : typeof o.file === "string" ? o.file : "";
    return typeof o.html === "string" ? { text, html: o.html } : { text };
  }
  return { text: typeof v === "string" ? v : v === null || v === undefined ? "" : String(v) };
}

async function writeClip(text: string, html?: string) {
  if (html) await clipboard.write([new ClipboardItem({ "text/plain": text, "text/html": html })]);
  else await clipboard.writeText(text);
}

const expandHome = (p: string) => (p.startsWith("~") ? path.join(app.getPath("home"), p.slice(1)) : p.replace(/^file:\/\//i, ""));

async function openWith(target: string, application?: string | null) {
  if (!application) return openTarget(target);
  const t = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target) ? target : expandHome(target);
  const flag = application.includes("/") ? "-a" : /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(application) ? "-b" : "-a";
  await run("/usr/bin/open", [flag, application, t], { timeout: 10_000 });
}

const pendingAlerts = new Map<string, (ok: boolean) => void>();
let alertSeq = 0;

async function confirmAlert(info: SessionInfo, raw: JsonValue | undefined): Promise<boolean> {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, JsonValue>;
  const alert: AlertRequest = {
    id: `al${++alertSeq}`,
    title: String(o.title ?? "Are you sure?"),
    message: typeof o.message === "string" ? o.message : undefined,
    primaryTitle: String(o.primaryTitle ?? "OK"),
    dismissTitle: String(o.dismissTitle ?? "Cancel"),
    destructive: o.destructive === true,
  };
  if (info.mode === "no-view") {
    const res = await dialog.showMessageBox({ type: alert.destructive ? "warning" : "question", message: alert.title, detail: alert.message, buttons: [alert.primaryTitle, alert.dismissTitle], defaultId: 0, cancelId: 1 });
    return res.response === 0;
  }
  return new Promise<boolean>((resolve) => {
    pendingAlerts.set(alert.id, resolve);
    ctx?.emit("session", { sessionId: info.id, kind: "alert", alert });
  });
}

async function selectedText(): Promise<string | null> {
  if (!ctx) return null;
  try {
    const res = await Promise.race([ctx.helper.call("selection.text"), sleep(2000).then(() => null)]);
    return res?.text ?? null;
  } catch {
    return null;
  }
}

async function onRequest(info: SessionInfo, method: RequestMethod, params: JsonValue[], stream: (chunk: string) => void = () => undefined): Promise<JsonValue | void> {
  const handled = await compat()?.request(info, method, params, stream);
  if (handled) return handled.value;
  const p0 = params[0];
  const s0 = typeof p0 === "string" ? p0 : "";
  const r = reg();
  switch (method) {
    case "clipboard.copy": {
      const c = clipText(p0);
      return writeClip(c.text, c.html);
    }
    case "clipboard.paste":
      return pasteText(clipText(p0).text);
    case "clipboard.read":
      return clipboard.readText();
    case "clipboard.clear":
      clipboard.clear();
      return;
    case "open":
      return openWith(s0, typeof params[1] === "string" ? params[1] : null);
    case "showInFinder":
      shell.showItemInFolder(expandHome(s0));
      return;
    case "trash":
      for (const p of params) if (typeof p === "string" && p) await shell.trashItem(expandHome(p));
      return;
    case "confirmAlert":
      return confirmAlert(info, p0);
    case "selection.text":
      return selectedText();
    case "launchCommand": {
      const extName = typeof params[1] === "string" && params[1] ? params[1] : info.extName;
      const argsIn = params[2] && typeof params[2] === "object" && !Array.isArray(params[2]) ? (params[2] as Record<string, JsonValue>) : {};
      const args = Object.fromEntries(Object.entries(argsIn).map(([k, v]) => [k, String(v ?? "")]));
      const launchType: LaunchType = params[4] === "background" ? "background" : "userInitiated";
      const res = await runCommand(extName, s0, args, params[3] ?? null, launchType);
      if (!res.ok) throw new Error(res.error ?? "launchCommand failed");
      if (res.view && launchType === "userInitiated") ctx?.openView(res.view);
      return;
    }
    case "popToRoot":
      ctx?.emit("session", { sessionId: info.id, kind: "popToRoot" });
      return;
    case "clearSearchBar":
      ctx?.emit("session", { sessionId: info.id, kind: "clearSearch" });
      return;
    case "openPreferences":
      ctx?.openView({ id: `${ID}.preferences`, props: { name: info.extName, title: `${info.extTitle} Preferences` } });
      return;
    case "toast.hide":
      if (s0) ctx?.emit("session", { sessionId: info.id, kind: "toastHide", toastId: s0 });
      return;
    case "showHUD":
      if (info.launchType !== "background") showHud(s0);
      return;
    case "closeMainWindow":
      ctx?.hideLauncher();
      return;
    case "showToast": {
      const [style, title, message] = params;
      if (info.mode !== "view") {
        // Background runs stay silent; a user-run no-view / menu-bar command flashes a HUD.
        if (info.launchType !== "background" && style !== "animated") showHud(String(title));
        return;
      }
      const actions = Array.isArray(params[4]) ? toastActions(params[4]) : undefined;
      ctx?.emit("session", { sessionId: info.id, kind: "toast", toast: { style: String(style), title: String(title), message: typeof message === "string" ? message : undefined, id: typeof params[3] === "string" ? params[3] : undefined, actions } });
      return;
    }
    case "storage.get":
      return (r.storageAll(info.extName)[s0] as JsonValue | undefined) ?? null;
    case "storage.set":
      r.storageWrite(info.extName, (d) => void (d[s0] = params[1] ?? null));
      return;
    case "storage.remove":
      r.storageWrite(info.extName, (d) => void delete d[s0]);
      return;
    case "storage.all":
      return r.storageAll(info.extName) as JsonValue;
    case "storage.clear":
      r.storageWrite(info.extName, (d) => {
        for (const k of Object.keys(d)) delete d[k];
      });
      return;
  }
  throw new Error(`Unknown request ${String(method)}`);
}

function toastActions(list: JsonValue[]): ToastActionModel[] {
  const out: ToastActionModel[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object" || Array.isArray(a) || typeof a.handler !== "string") continue;
    out.push({ slot: a.slot === "secondary" ? "secondary" : "primary", title: String(a.title ?? "Open"), shortcut: typeof a.shortcut === "string" ? a.shortcut : undefined, handler: a.handler });
  }
  return out;
}

function spawnChild(info: SessionInfo): ChildHandle {
  const child = utilityProcess.fork(path.join(runtimeDir, info.runtime === "raycast" ? "raycast-runner.cjs" : "runner.cjs"), [], {
    serviceName: `Glide Extension (${info.extName}/${info.commandName})`,
    stdio: "pipe",
    env: { ...process.env, GLIDE_EXTENSION: info.extName },
  });
  const log = (chunk: Buffer) => ctx?.log(`[${info.extName}/${info.commandName}]`, chunk.toString().trimEnd());
  child.stdout?.on("data", log);
  child.stderr?.on("data", log);
  return {
    postMessage: (msg: ParentMessage) => child.postMessage(msg),
    onMessage: (cb) => child.on("message", (m: unknown) => cb(m as ChildMessage)),
    onExit: (cb) => child.on("exit", (code) => cb(code)),
    kill: () => void child.kill(),
  };
}

// --- catalogue ---------------------------------------------------------------------

function summary(ext: InstalledExtension): ExtensionSummary {
  const m = ext.manifest;
  const saved = m ? reg().getPreferences(ext.name) : {};
  return {
    name: ext.name,
    title: m?.title ?? ext.name,
    description: m?.description ?? "",
    version: m?.version ?? "?",
    author: m?.author,
    icon: iconFor(m?.icon, path.join(ext.dir, "assets")) ?? { kind: "emoji", value: "🧩" },
    enabled: ext.enabled,
    source: ext.source,
    dir: ext.dir,
    errors: ext.errors,
    commands: m?.commands ?? [],
    preferences: m?.preferences ?? [],
    missingPreferences: m ? missingPreferences(m, saved).filter((p) => !p.command).map((p) => p.name) : [],
    isGit: fs.existsSync(path.join(ext.dir, ".git")),
    runtime: m?.runtime ?? "glide",
    warnings: m?.warnings,
  };
}

const commandItemId = (ext: string, cmd: string) => `ext:${ext}:${cmd}`;

function commandItem(ext: InstalledExtension, cmd: CommandManifest): SearchItem {
  const m = ext.manifest!;
  return {
    id: commandItemId(ext.name, cmd.name),
    kind: "command",
    kindLabel: "Extension",
    title: cmd.title,
    subtitle: cmd.subtitle ?? m.title,
    icon: iconFor(cmd.icon ?? m.icon, path.join(ext.dir, "assets")) ?? iconFor(m.icon, path.join(ext.dir, "assets")) ?? { kind: "emoji", value: "🧩" },
    keywords: [...cmd.keywords, m.title, ...(cmd.description ? [cmd.description] : [])],
    acceptsArgument: cmd.arguments.length > 0 || undefined,
    feature: ID,
    source: ID,
    data: { type: "command", ext: ext.name, command: cmd.name },
  };
}

const STATIC_ITEMS: SearchItem[] = [
  {
    id: "ext:manage",
    kind: "command",
    kindLabel: "Extensions",
    title: "Manage Extensions",
    subtitle: "Enable, disable, update or uninstall extensions",
    icon: { kind: "emoji", value: "🧩" },
    keywords: ["extensions", "plugins", "installed", "uninstall", "update"],
    feature: ID,
    data: { type: "manage" },
  },
  {
    id: "ext:store",
    kind: "command",
    kindLabel: "Extensions",
    title: "Store",
    subtitle: "Browse Extensions",
    icon: { kind: "emoji", value: "🛍️" },
    keywords: ["browse extensions", "extension store", "install extension", "plugins"],
    feature: ID,
    data: { type: "store" },
  },
];

// --- running commands ------------------------------------------------------------

type ArgInput = string | Record<string, string> | undefined;

async function runCommand(extName: string, cmdName: string, argInput: ArgInput, launchContext: JsonValue = null, launchType: LaunchType = "userInitiated"): Promise<ExecuteResult> {
  const ext = reg().get(extName);
  if (!ext?.manifest) return { ok: false, error: `Extension ${extName} is not installed or is invalid` };
  if (!ext.enabled) return { ok: false, error: `${ext.manifest.title} is disabled (Manage Extensions to enable it)` };
  const cmd = ext.manifest.commands.find((c) => c.name === cmdName);
  if (!cmd) return { ok: false, error: `Unknown command ${cmdName}` };

  const saved = reg().getPreferences(extName);
  const argumentText = typeof argInput === "string" ? argInput : undefined;
  const background = launchType === "background";
  if (missingPreferences(ext.manifest, saved, cmd.name).length) {
    if (background) return { ok: false, error: `${cmd.title} needs its preferences set before it can run in the background` };
    return { ok: true, view: { id: `${ID}.preferences`, props: { name: extName, then: { command: cmdName, argument: argumentText ?? null } } } };
  }

  const args = typeof argInput === "object" && argInput ? { ...argInput } : splitArguments(cmd.arguments, argumentText);
  const missingArg = cmd.arguments.find((a) => a.required && !args[a.name]?.trim());
  if (missingArg) {
    if (background) return { ok: false, error: `${cmd.title} needs arguments` };
    return { ok: true, view: { id: `${ID}.arguments`, props: { name: extName, command: cmdName, values: args } } };
  }
  if (background && cmd.mode === "view") return { ok: false, error: `${cmd.title} is a view command and cannot run in the background` };

  const assetsPath = path.join(ext.dir, "assets");
  const runtime = ext.manifest.runtime ?? "glide";
  const info = sess().start(
    { extName, extTitle: ext.manifest.title, commandName: cmd.name, commandTitle: cmd.title, mode: cmd.mode, runtime, launchType },
    {
      commandPath: path.join(ext.dir, cmd.entry),
      apiPath: path.join(runtimeDir, "glide-api.cjs"),
      runtime,
      shimDir: runtimeDir,
      launchContext,
      launchType,
      capabilities: { ai: compat()?.aiAvailable() ?? false },
      arguments: args,
      preferences: resolvePreferences(ext.manifest, saved, cmd.name),
      environment: {
        extensionName: extName,
        extensionTitle: ext.manifest.title,
        commandName: cmd.name,
        commandMode: cmd.mode,
        assetsPath,
        extensionPath: ext.dir,
        supportPath: reg().supportDir(extName),
        glideVersion: app.getVersion(),
      },
    },
  );
  if (cmd.mode === "view") return { ok: true, view: { id: `${ID}.run`, props: { sessionId: info.id, title: cmd.title } } };
  if (cmd.mode === "menu-bar") {
    compat()?.menuSessionStarted(info);
    if (!background) compat()?.userLaunched(extName, cmd);
    return background ? { ok: true } : { ok: true, hide: true };
  }
  if (!background) compat()?.userLaunched(extName, cmd);
  const res = await sess().completion(info.id);
  if (background) return res.ok ? { ok: true } : { ok: false, error: `${cmd.title}: ${res.error ?? "failed"}` };
  return res.ok ? { ok: true, hide: true } : { ok: false, error: `${cmd.title}: ${res.error ?? "failed"}` };
}

function sessionAssets(info: SessionInfo): string {
  const ext = reg().get(info.extName);
  return ext ? path.join(ext.dir, "assets") : "";
}

async function runViewAction(sessionId: string, depth: number, actionId: string): Promise<ActionOutcome> {
  const m = sess();
  const action = findAction(m.view(sessionId, depth), actionId);
  if (!action) return { ok: false, error: "That action is no longer available" };
  try {
    return await dispatchAction(action, {
      openUrl: (url) => shell.openExternal(url),
      copy: (text, html) => writeClip(text, html),
      paste: pasteText,
      hud: showHud,
      invoke: (handler, args) => void m.invoke(sessionId, depth, handler, args as JsonValue[]),
      open: (target, application) => openWith(target, application),
      showInFinder: async (p) => shell.showItemInFolder(expandHome(p)),
      trash: async (paths) => {
        for (const p of paths) await shell.trashItem(expandHome(p));
      },
    });
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// --- store ---------------------------------------------------------------------------

function storeListing(e: StoreEntry, installed: Set<string>): StoreListing {
  return {
    name: e.name,
    title: e.title,
    description: e.description,
    author: e.author,
    icon: iconFor(e.icon) ?? { kind: "emoji", value: "🧩" },
    version: e.version,
    repo: e.repo,
    origin: e.origin,
    commands: e.commands,
    installed: installed.has(e.name),
  };
}

let remoteCache: { url: string; entries: StoreEntry[] } | null = null;

async function loadStore(refresh: boolean): Promise<{ entries: StoreEntry[]; response: StoreResponse }> {
  const url = String(ctx?.settings(DEFAULTS).storeUrl ?? "").trim();
  const installed = new Set(reg().list().map((e) => e.name));
  const entries = bundledIndex(examplesDir());
  let remoteError: string | undefined;
  if (url) {
    try {
      if (refresh || remoteCache?.url !== url) remoteCache = { url, entries: await fetchIndex(url) };
      const known = new Set(entries.map((e) => e.name));
      entries.push(...remoteCache.entries.filter((e) => !known.has(e.name)));
    } catch (err) {
      remoteError = errMsg(err);
    }
  }
  return { entries, response: { entries: entries.map((e) => storeListing(e, installed)), remoteUrl: url, remoteError } };
}

const bundledDirFor = (name: string) => bundledIndex(examplesDir()).find((e) => e.name === name)?.bundledDir;

async function install(req: InstallRequest): Promise<ExtensionSummary> {
  let ext: InstalledExtension;
  if (req.kind === "raycast-folder" || (req.kind === "folder" && isRaycastFolder(req.path))) ext = await reg().installRaycastFolder(req.path);
  else if (req.kind === "folder") ext = reg().installFromFolder(req.path, { kind: "folder", path: path.resolve(req.path) });
  else if (req.kind === "git") ext = await reg().installFromGit(req.url);
  else {
    const dir = bundledDirFor(req.name);
    if (dir) ext = reg().installFromFolder(dir, { kind: "store", name: req.name });
    else {
      const remote = (await loadStore(false)).entries.find((e) => e.name === req.name && e.repo);
      if (!remote?.repo) throw new Error(`${req.name} is not in the store`);
      ext = await reg().installFromGit(remote.repo, { kind: "store", name: req.name, repo: remote.repo });
    }
  }
  changed();
  return summary(ext);
}

function changed() {
  reg().invalidate();
  ctx?.refreshCatalogue();
  ctx?.emit("changed");
  compat()?.sync();
}

// --- feature -------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

export const feature: FeatureModule = {
  id: ID,
  start(c) {
    ctx = c;
    const base = c.dataDir();
    registry = new ExtensionRegistry(base, buildRaycast);
    runtimeDir = path.join(base, "runtime");
    writeRuntime(runtimeDir);
    sessions = new SessionManager({
      spawn: spawnChild,
      onRequest,
      emit: (e) => {
        if (!compat()?.onSessionEvent(e)) c.emit("session", e);
      },
      log: (...a) => c.log(...a),
    });
    wiring = wireCompat({
      ctx: c,
      sessions: sess,
      registry: reg,
      launch: (ext, command, o) => runCommand(ext, command, o.args, o.launchContext ?? null, o.launchType),
    });
    c.refreshCatalogue();
    // Restore active menu-bar commands and background schedules once the app has settled.
    setTimeout(() => compat()?.sync(), 1500).unref?.();
  },
  stop() {
    compat()?.stopAll();
    sessions?.killAll();
  },
  items() {
    if (!registry) return STATIC_ITEMS;
    const items = [...STATIC_ITEMS];
    for (const ext of registry.list()) {
      if (!ext.enabled || !ext.manifest) continue;
      for (const cmd of ext.manifest.commands) items.push(commandItem(ext, cmd));
    }
    return items;
  },
  actions(item: SearchItem): ItemAction[] {
    const type = item.data?.type;
    if (type === "command") {
      const ext = registry?.get(str(item.data?.ext));
      const list: ItemAction[] = [{ id: "run", title: "Run Command", shortcut: "⏎", icon: "▶️" }];
      if (ext?.manifest?.preferences.length) list.push({ id: "preferences", title: "Configure Extension", shortcut: "⌘,", icon: "⚙️" });
      const cmd = ext?.manifest?.commands.find((c) => c.name === str(item.data?.command));
      if (cmd && (cmd.mode === "menu-bar" || cmd.intervalMs)) {
        const on = compat()?.isEnabled(`${ext!.name}/${cmd.name}`) ?? false;
        const what = cmd.mode === "menu-bar" ? "Menu Bar Item" : `Background Refresh (${cmd.interval})`;
        list.push({ id: on ? "background-off" : "background-on", title: `${on ? "Deactivate" : "Activate"} ${what}`, icon: on ? "⏹️" : "🔁" });
      }
      list.push({ id: "manage", title: "Manage Extensions", icon: "🧩" }, { id: "disable", title: "Disable Extension", icon: "⏸️", destructive: true });
      return list;
    }
    return [{ id: "open", title: type === "store" ? "Browse Extensions" : "Manage Extensions", shortcut: "⏎" }];
  },
  async runAction(scored: ScoredItem, actionId: string): Promise<ExecuteResult> {
    const { item } = scored;
    const type = item.data?.type;
    if (type === "manage" || actionId === "manage") return { ok: true, view: { id: `${ID}.manage`, props: { title: "Manage Extensions" } } };
    if (type === "store") return { ok: true, view: { id: `${ID}.store`, props: { title: "Store" } } };
    const ext = str(item.data?.ext);
    if (actionId === "preferences") return { ok: true, view: { id: `${ID}.preferences`, props: { name: ext, title: "Extension Preferences" } } };
    if (actionId === "disable") {
      reg().setEnabled(ext, false);
      changed();
      return { ok: true, message: "Extension disabled" };
    }
    if (actionId === "background-on" || actionId === "background-off") {
      compat()?.setEnabled(ext, str(item.data?.command), actionId === "background-on");
      ctx?.refreshCatalogue();
      return { ok: true, message: actionId === "background-on" ? "Activated" : "Deactivated" };
    }
    return runCommand(ext, str(item.data?.command), scored.argument);
  },
  methods: {
    // Extension store (store-*.ts): storeList / storeInstall / storeUpdate / storeUninstall / storeScreenshot.
    ...storeMethods({
      registry: reg,
      ctx: () => ctx,
      examplesDir,
      changed: () => changed(),
      beforeUninstall: (name) => {
        for (const s of sessions?.running() ?? []) if (s.extName === name) sessions?.kill(s.id);
        wiring?.tokens.clear(name);
      },
    }),
    // Raycast compatibility: OAuth card, background toggles, menu-bar state, Quick Look, snippets/quicklinks.
    ...(Object.fromEntries(
      ["oauthOpen", "oauthCancel", "oauthPrompt", "oauthRedirect", "backgroundState", "setBackground", "menuBarState", "menuBarClick", "quickLook", "saveSnippet", "saveQuicklink"].map((m) => [m, (...a: unknown[]) => {
        if (!wiring) throw new Error("Extensions are not ready yet");
        return wiring.methods[m](...a);
      }]),
    ) as Record<string, (...args: unknown[]) => unknown>),
    getView: (sessionId: unknown, depth: unknown): RunViewState | null => {
      const info = sessions?.get(str(sessionId));
      if (!info) return null;
      return { info: { ...info, assetsPath: sessionAssets(info) }, view: sess().view(info.id, num(depth)) ?? null };
    },
    mountView: (sessionId: unknown, depth: unknown) => sessions?.mountView(str(sessionId), num(depth)),
    unmountView: (sessionId: unknown, depth: unknown) => sessions?.unmountView(str(sessionId), num(depth)),
    action: (sessionId: unknown, depth: unknown, actionId: unknown) => runViewAction(str(sessionId), num(depth), str(actionId)),
    search: (sessionId: unknown, depth: unknown, text: unknown) => {
      const view = sessions?.view(str(sessionId), num(depth));
      if ((view?.type === "list" || view?.type === "grid") && view.searchHandler) sess().invoke(str(sessionId), num(depth), view.searchHandler, [str(text)]);
    },
    submit: (sessionId: unknown, depth: unknown, values: unknown, actionId: unknown) => {
      const view = sessions?.view(str(sessionId), num(depth));
      if (!view) return false;
      const clean: Record<string, JsonValue> = {};
      if (values && typeof values === "object")
        for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
          if (typeof v === "string" || typeof v === "boolean") clean[k] = v;
          else if (Array.isArray(v)) clean[k] = v.map(String);
        }
      const handler = actionId ? findAction(view, str(actionId))?.handler : view.type === "form" ? view.submitHandler : undefined;
      if (!handler) return false;
      return sess().invoke(str(sessionId), num(depth), handler, [clean]);
    },
    /** Raycast UI events (dropdown/field changes, selection, load more): invoke a handler of the view. */
    event: (sessionId: unknown, depth: unknown, handler: unknown, args: unknown) => {
      if (!sessions?.view(str(sessionId), num(depth)) || !str(handler)) return false;
      const list = Array.isArray(args) ? (JSON.parse(JSON.stringify(args)) as JsonValue[]) : [];
      return sess().invoke(str(sessionId), num(depth), str(handler), list);
    },
    alertResult: (alertId: unknown, ok: unknown) => {
      const resolve = pendingAlerts.get(str(alertId));
      pendingAlerts.delete(str(alertId));
      resolve?.(ok === true);
    },
    raycastSupport: (): RaycastSupport => ({ canBuild: !!esbuild(), storeUrl: RAYCAST_STORE_URL }),
    /** Opens the Raycast Store website in the browser (an explicit user action; nothing is downloaded). */
    openRaycastStore: () => shell.openExternal(RAYCAST_STORE_URL),
    stopSession: (sessionId: unknown) => sessions?.kill(str(sessionId)),
    openUrl: async (url: unknown) => {
      if (!isSafeUrl(str(url))) throw new Error("Only http, https and mailto links can be opened");
      await shell.openExternal(str(url));
    },
    runCommand: (name: unknown, command: unknown, args: unknown) =>
      runCommand(str(name), str(command), typeof args === "string" ? args : args && typeof args === "object" ? (args as Record<string, string>) : undefined),
    list: (): ExtensionSummary[] => reg().list().map(summary),
    store: async (refresh: unknown): Promise<StoreResponse> => (await loadStore(refresh === true)).response,
    install: (req: unknown) => {
      const r = req as InstallRequest;
      if (!r || typeof r !== "object" || !["store", "folder", "git", "raycast-folder"].includes(r.kind)) throw new Error("Invalid install request");
      return install(r);
    },
    pickFolder: async (title: unknown, button: unknown): Promise<string | null> => {
      const res = await dialog.showOpenDialog({ title: str(title) || "Choose an extension folder", properties: ["openDirectory"], buttonLabel: str(button) || "Install" });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    /** Form.FilePicker: choose files and/or folders. */
    pickPaths: async (multiple: unknown, directories: unknown): Promise<string[]> => {
      const props: Array<"openFile" | "openDirectory" | "multiSelections"> = ["openFile"];
      if (directories === true) props.push("openDirectory");
      if (multiple === true) props.push("multiSelections");
      const res = await dialog.showOpenDialog({ properties: props });
      return res.canceled ? [] : res.filePaths;
    },
    uninstall: (name: unknown) => {
      for (const s of sessions?.running() ?? []) if (s.extName === str(name)) sessions?.kill(s.id);
      wiring?.tokens.clear(str(name));
      reg().uninstall(str(name));
      changed();
    },
    setEnabled: (name: unknown, enabled: unknown) => {
      reg().setEnabled(str(name), enabled === true);
      changed();
    },
    update: async (name: unknown) => {
      const ext = await reg().update(str(name), bundledDirFor);
      changed();
      return summary(ext);
    },
    reveal: (name: unknown) => {
      const ext = reg().get(str(name));
      if (ext) shell.showItemInFolder(path.join(ext.dir, "package.json"));
    },
    getPreferences: (name: unknown): PreferencesState | null => {
      const ext = reg().get(str(name));
      if (!ext?.manifest) return null;
      return {
        name: ext.name,
        title: ext.manifest.title,
        preferences: ext.manifest.preferences,
        values: resolvePreferences(ext.manifest, reg().getPreferences(ext.name)),
        commands: ext.manifest.commands.map((c) => ({ name: c.name, title: c.title })),
      };
    },
    setPreferences: (name: unknown, values: unknown) => {
      const ext = reg().get(str(name));
      if (!ext?.manifest) throw new Error("Unknown extension");
      const clean: Record<string, string | boolean> = {};
      const input = (values && typeof values === "object" ? values : {}) as Record<string, unknown>;
      // Keys are prefKey(p): command-scoped preferences are namespaced "<command>/<name>".
      for (const p of ext.manifest.preferences) {
        const key = prefKey(p);
        const v = input[key];
        if (p.type === "checkbox") clean[key] = v === true;
        else if (typeof v === "string") clean[key] = v;
      }
      reg().setPreferences(ext.name, clean);
      changed();
    },
    openStore: () => ctx?.openView({ id: `${ID}.store`, props: { title: "Store" } }),
    getSettings: (): ExtensionSettings => ctx?.settings(DEFAULTS) ?? DEFAULTS,
    setSettings: (patch: unknown) => {
      const p = (patch ?? {}) as Partial<ExtensionSettings>;
      if (typeof p.storeUrl === "string") {
        const url = p.storeUrl.trim();
        if (url && !/^https?:\/\//i.test(url)) throw new Error("Store index URL must start with http:// or https://");
        ctx?.setSettings({ storeUrl: url });
        remoteCache = null;
      }
      return ctx?.settings(DEFAULTS) ?? DEFAULTS;
    },
  },
};
