/**
 * Finder commands that act on Finder's selection (helper "finder.selection", read via
 * Accessibility): Copy Path, Open Terminal Here, New File Here…, Move Selection to…, Compress
 * Selection, Open Selection With…. Every command runs only when the user picks it. "Toggle Hidden
 * Files" already exists in syscmds and is not duplicated. Also hosts the Wi-Fi name settings (see
 * src/main/native/wifi.ts) because it needs a user-initiated Location prompt button.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clipboard, shell } from "electron";
import type { ExecuteModifiers, ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import { HEADLESS } from "../../headless";
import { getWifiInfo, requestWifiLocation } from "../../native/wifi";
import { exec } from "../../util/exec";
import type { FeatureContext, FeatureModule } from "../types";
import { completeFolder, createEmptyFile, listApps, moveItems } from "./ops";
import { compressPlan, describeSelection, expandPath, formatPaths, hereFolder, movePlan, openWithSteps, terminalSteps, TERMINALS, type PathFormat, type Step, type TerminalApp } from "./paths";
import type { DestinationRow, FinderSettings, FinderSettingsState, SelectionState } from "./types";

const ID = "finder";
const DEFAULTS: FinderSettings = { terminal: "Terminal", pathFormat: "posix", automation: false, recentDestinations: [] };
const HOME = os.homedir();
const APP_DIRS = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", path.join(HOME, "Applications")];

let ctx: FeatureContext | undefined;
const settings = (): FinderSettings => ctx?.settings(DEFAULTS) ?? DEFAULTS;

/** Headless test runs record what would run instead of touching the user's files or apps. */
function headlessRecord(kind: string, detail: unknown): void {
  console.log(`[headless] finder.${kind} ${JSON.stringify(detail)}`);
}

async function runSteps(steps: Step[]): Promise<void> {
  for (const s of steps) {
    if (HEADLESS) {
      headlessRecord("exec", s);
      continue;
    }
    const res = await exec(s.cmd, s.args, { cwd: s.cwd, timeoutMs: 120_000 });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `${path.basename(s.cmd)} exited with ${res.code}`);
  }
}

async function selection(): Promise<SelectionState> {
  if (!ctx?.helper.available()) return { paths: [], folder: null, error: "Finder commands need the Glide helper, which isn’t running." };
  let res: { paths: string[]; folder?: string | null; error?: string } = { paths: [] };
  try {
    res = await ctx.helper.call("finder.selection");
  } catch (err) {
    res = { paths: [], error: err instanceof Error ? err.message : String(err) };
  }
  if (!res.paths.length && settings().automation) {
    try {
      const viaAE = await ctx.helper.call("finder.selectionViaAutomation");
      if (viaAE.paths.length || viaAE.folder) res = viaAE;
    } catch (err) {
      ctx.log("finder automation fallback failed", err);
    }
  }
  return { paths: res.paths, folder: res.folder ?? null, ...(res.error ? { error: res.error } : {}) };
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function noSelection(sel: SelectionState): ExecuteResult {
  return { ok: false, error: sel.error ?? "Select one or more items in Finder first" };
}

async function writeClipboard(text: string): Promise<void> {
  await Promise.resolve(clipboard.writeText(text));
}

async function copyPaths(format?: PathFormat): Promise<ExecuteResult> {
  const sel = await selection();
  if (!sel.paths.length) return noSelection(sel);
  await writeClipboard(formatPaths(sel.paths, format ?? settings().pathFormat, HOME));
  return { ok: true, hide: true, message: sel.paths.length === 1 ? "Copied path" : `Copied ${sel.paths.length} paths` };
}

async function openTerminal(app?: TerminalApp): Promise<ExecuteResult> {
  const sel = await selection();
  const dir = hereFolder(sel.paths, sel.folder, isDir);
  if (!dir) return { ok: false, error: sel.error ?? "Open a Finder window first" };
  try {
    await runSteps(terminalSteps(app ?? settings().terminal, dir));
  } catch (err) {
    return { ok: false, error: `Could not open ${app ?? settings().terminal}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, hide: true };
}

async function compress(): Promise<ExecuteResult> {
  const sel = await selection();
  if (!sel.paths.length) return noSelection(sel);
  const plan = compressPlan(sel.paths, (p) => fs.existsSync(p));
  if (!plan) return noSelection(sel);
  try {
    await runSteps(plan.steps);
  } catch (err) {
    return { ok: false, error: `Compression failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, hide: true, message: `Created ${path.basename(plan.output)}` };
}

const COMMANDS: Array<{ id: string; title: string; subtitle: string; icon: string; keywords: string[] }> = [
  { id: "copyPath", title: "Copy Path of Selection", subtitle: "Finder", icon: "📋", keywords: ["copy path", "finder", "file path", "selection", "pwd"] },
  { id: "terminal", title: "Open Terminal Here", subtitle: "Finder", icon: "🖥️", keywords: ["terminal", "iterm", "ghostty", "shell", "cd", "finder"] },
  { id: "newFile", title: "New File Here…", subtitle: "Finder", icon: "📄", keywords: ["new file", "touch", "create file", "finder", "empty"] },
  { id: "move", title: "Move Selection to…", subtitle: "Finder", icon: "📦", keywords: ["move", "mv", "relocate", "finder", "folder"] },
  { id: "compress", title: "Compress Selection", subtitle: "Finder", icon: "🗜️", keywords: ["zip", "compress", "archive", "finder"] },
  { id: "openWith", title: "Open Selection With…", subtitle: "Finder", icon: "🪟", keywords: ["open with", "application", "finder"] },
];

function places(): DestinationRow[] {
  const p = (name: string, rel: string): DestinationRow => ({ name, path: path.join(HOME, rel), kind: "place" });
  const list: DestinationRow[] = [p("Desktop", "Desktop"), p("Documents", "Documents"), p("Downloads", "Downloads"), { name: "Home", path: HOME, kind: "place" }, { name: "Applications", path: "/Applications", kind: "place" }];
  return list.filter((d) => isDir(d.path));
}

async function destinations(query: unknown, base: unknown): Promise<DestinationRow[]> {
  const q = typeof query === "string" ? query : "";
  const from = typeof base === "string" && base ? base : HOME;
  const rows: DestinationRow[] = [];
  const add = (r: DestinationRow) => {
    if (!rows.some((x) => x.path === r.path)) rows.push(r);
  };
  if (/^[~/.]/.test(q.trim())) {
    const abs = expandPath(q, HOME, from);
    if (isDir(abs)) add({ path: abs, name: path.basename(abs) || "/", kind: "typed" });
    for (const s of await completeFolder(abs, q.trim().endsWith("/"))) add({ ...s, kind: "child" });
    return rows;
  }
  const needle = q.trim().toLowerCase();
  const match = (r: DestinationRow) => !needle || r.name.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle);
  for (const r of settings().recentDestinations) if (isDir(r)) add({ path: r, name: path.basename(r) || "/", kind: "recent" });
  for (const r of places()) add(r);
  return rows.filter(match);
}

function rememberDestination(dest: string): void {
  const recent = [dest, ...settings().recentDestinations.filter((d) => d !== dest)].slice(0, 8);
  ctx?.setSettings({ recentDestinations: recent });
}

let appsCache: { at: number; apps: Array<{ name: string; path: string }> } | null = null;
async function apps(query: unknown): Promise<Array<{ name: string; path: string }>> {
  if (!appsCache || Date.now() - appsCache.at > 60_000) appsCache = { at: Date.now(), apps: await listApps(APP_DIRS) };
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) return appsCache.apps;
  const starts = appsCache.apps.filter((a) => a.name.toLowerCase().startsWith(q));
  const contains = appsCache.apps.filter((a) => !a.name.toLowerCase().startsWith(q) && a.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && path.isAbsolute(x)) : []);

async function settingsState(): Promise<FinderSettingsState> {
  let accessibility: boolean | null = null;
  if (ctx?.helper.available()) {
    try {
      accessibility = (await ctx.helper.call("permissions.status")).accessibility;
    } catch {
      accessibility = null;
    }
  }
  return { settings: settings(), helper: !!ctx?.helper.available(), accessibility, wifi: ctx ? await getWifiInfo(ctx.helper) : null };
}

export const feature: FeatureModule = {
  id: ID,
  start(c) {
    ctx = c;
  },
  items: () =>
    COMMANDS.map(
      (c): SearchItem => ({
        id: `finder:${c.id}`,
        kind: "command",
        kindLabel: "Finder",
        title: c.title,
        subtitle: c.subtitle,
        icon: { kind: "emoji", value: c.icon },
        keywords: c.keywords,
        feature: ID,
        data: { command: c.id },
      }),
    ),
  actions(item): ItemAction[] {
    const cmd = item.data?.command;
    if (cmd === "copyPath")
      return [
        { id: "run", title: "Copy Path", shortcut: "⏎" },
        { id: "copy:tilde", title: "Copy Path with ~", shortcut: "⌘⏎" },
        { id: "copy:quoted", title: "Copy as Shell Arguments" },
        { id: "copy:url", title: "Copy as file:// URL" },
      ];
    if (cmd === "terminal") {
      const def = settings().terminal;
      return [{ id: "run", title: `Open in ${def}`, shortcut: "⏎" }, ...TERMINALS.filter((t) => t !== def).map((t, i) => ({ id: `terminal:${t}`, title: `Open in ${t}`, ...(i === 0 ? { shortcut: "⌘⏎" } : {}) }))];
    }
    return [{ id: "run", title: "Run", shortcut: "⏎" }];
  },
  async runAction(scored, actionId, _mods?: ExecuteModifiers): Promise<ExecuteResult> {
    const cmd = scored.item.data?.command;
    if (actionId.startsWith("copy:")) return copyPaths(actionId.slice(5) as PathFormat);
    if (actionId.startsWith("terminal:")) {
      const t = actionId.slice(9) as TerminalApp;
      return TERMINALS.includes(t) ? openTerminal(t) : { ok: false, error: "Unknown terminal" };
    }
    if (actionId !== "run") return { ok: false, error: `Unknown action ${actionId}` };
    switch (cmd) {
      case "copyPath":
        return copyPaths();
      case "terminal":
        return openTerminal();
      case "compress":
        return compress();
      case "newFile": {
        const sel = await selection();
        const folder = hereFolder(sel.paths, sel.folder, isDir);
        if (!folder) return { ok: false, error: sel.error ?? "Open a Finder window first" };
        return { ok: true, view: { id: "finder.newFile", props: { folder } } };
      }
      case "move": {
        const sel = await selection();
        if (!sel.paths.length) return noSelection(sel);
        return { ok: true, view: { id: "finder.move", props: { paths: sel.paths, folder: sel.folder } } };
      }
      case "openWith": {
        const sel = await selection();
        if (!sel.paths.length) return noSelection(sel);
        return { ok: true, view: { id: "finder.openWith", props: { paths: sel.paths } } };
      }
      default:
        return { ok: false, error: "Unknown command" };
    }
  },
  methods: {
    selection: () => selection(),
    destinations,
    apps,
    newFile: async (folder: unknown, name: unknown, open: unknown) => {
      if (typeof folder !== "string" || !path.isAbsolute(folder) || typeof name !== "string") return { ok: false, error: "Invalid request" };
      if (HEADLESS) {
        headlessRecord("newFile", { folder, name, open: !!open });
        return { ok: true, path: path.join(folder, name.trim()) };
      }
      const r = await createEmptyFile(folder, name);
      if (r.ok && r.path) {
        if (open) await shell.openPath(r.path);
        else shell.showItemInFolder(r.path);
      }
      return r;
    },
    move: async (paths: unknown, dest: unknown) => {
      const list = strings(paths);
      if (!list.length || typeof dest !== "string" || !path.isAbsolute(dest)) return { ok: false, error: "Invalid request" };
      rememberDestination(dest);
      if (HEADLESS) {
        const plan = movePlan(list, dest, (p) => fs.existsSync(p));
        headlessRecord("move", { paths: list, dest, plan });
        return plan.conflicts.length ? { ok: false, moved: [], error: plan.conflicts.join("; ") } : { ok: true, moved: plan.moves, skipped: plan.skipped.length };
      }
      const r = await moveItems(list, dest);
      return { ok: r.ok, moved: r.moved, error: r.error, skipped: r.plan.skipped.length };
    },
    openWith: async (appPath: unknown, paths: unknown) => {
      const list = strings(paths);
      if (!list.length || typeof appPath !== "string" || !appPath.endsWith(".app")) return { ok: false, error: "Invalid request" };
      try {
        await runSteps(openWithSteps(appPath, list));
        return { ok: true, hide: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    settingsState,
    setSettings: async (patch: unknown) => {
      if (patch && typeof patch === "object") {
        const p = patch as Partial<FinderSettings>;
        const next: Record<string, unknown> = {};
        if (p.terminal && TERMINALS.includes(p.terminal)) next.terminal = p.terminal;
        if (p.pathFormat && ["posix", "tilde", "quoted", "url"].includes(p.pathFormat)) next.pathFormat = p.pathFormat;
        if (typeof p.automation === "boolean") next.automation = p.automation;
        ctx?.setSettings(next);
      }
      return settingsState();
    },
    /** Explicit user action only (Settings → "Allow Location Access…"). */
    requestLocation: async () => {
      if (ctx) await requestWifiLocation(ctx.helper);
      return settingsState();
    },
    openLocationSettings: async () => {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices");
      return true;
    },
    openAccessibilitySettings: async () => {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
      return true;
    },
    describe: (paths: unknown) => describeSelection(strings(paths)),
    /** Headless e2e only: push a Finder view without a real Finder selection. */
    testOpenView: (view: unknown) => {
      if (!HEADLESS || !view || typeof view !== "object" || typeof (view as { id?: unknown }).id !== "string") return false;
      const v = view as { id: string; props?: Record<string, unknown> };
      if (!v.id.startsWith("finder.") && !v.id.startsWith("reminders.")) return false;
      ctx?.openView({ id: v.id, props: v.props });
      return true;
    },
  },
};
