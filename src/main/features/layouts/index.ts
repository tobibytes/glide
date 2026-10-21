/**
 * Window Layouts & Workspaces. A layout is a snapshot of every visible standard window (app, title, frame, display);
 * restoring matches live windows by app + title, then by order (match.ts). A workspace bundles a layout with apps to
 * launch, apps to quit (always confirmed in the launcher first), URLs, a Focus session, a Shortcut and a note.
 */
import fs from "node:fs";
import { BrowserWindow, shell } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import { execOk } from "../../util/exec";
import { hud } from "../app/hud";
import { feature as focusFeature } from "../focus";
import { bundleIdOf, runShortcut } from "../focus/system";
import { feature as notesFeature } from "../notes";
import type { FeatureContext, FeatureModule } from "../types";
import { captureLayout, restoreLayout, summarize, type EngineDeps } from "./engine";
import { describeLayout, layoutApps, newId, parseWorkspace, type AppRef, type Layout, type Workspace } from "./model";
import { LayoutStore } from "./store";

const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
export const DEFAULTS = { relaunchMissingApps: false, launchTimeoutSec: 10 };
export type LayoutSettings = typeof DEFAULTS;

let ctx: FeatureContext | null = null;
let store: LayoutStore | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const need = <T>(v: T | null): T => {
  if (!v) throw new Error("Window layouts are not ready");
  return v;
};
const settings = (): LayoutSettings => {
  const s = ctx?.settings(DEFAULTS) ?? DEFAULTS;
  return { relaunchMissingApps: s.relaunchMissingApps === true, launchTimeoutSec: Math.min(60, Math.max(2, Number(s.launchTimeoutSec) || 10)) };
};

async function launchApp(app: AppRef): Promise<void> {
  if (app.path && fs.existsSync(app.path)) await execOk("open", ["-a", app.path], { timeoutMs: 10_000 });
  else await execOk("open", ["-b", app.bundleId], { timeoutMs: 10_000 });
}

const deps = (): EngineDeps => ({ helper: need(ctx).helper, launch: launchApp, sleep, now: () => Date.now() });

function changed(): void {
  ctx?.refreshCatalogue();
  ctx?.emit("changed");
}

/** Let the previously frontmost app come back before touching windows. */
async function hideLauncherFirst(): Promise<void> {
  if (BrowserWindow.getFocusedWindow()) {
    ctx?.hideLauncher();
    await sleep(150);
  }
}

async function saveLayout(name: unknown, overwriteId?: unknown): Promise<Layout> {
  const s = need(store);
  const existing = typeof overwriteId === "string" ? s.layout(overwriteId) : undefined;
  const title = typeof name === "string" && name.trim() ? name.trim() : (existing?.name ?? `Layout ${s.layouts.length + 1}`);
  const layout = await captureLayout(deps(), title, existing?.id);
  const saved = existing ? { ...layout, createdAt: existing.createdAt } : layout;
  s.putLayout(saved);
  changed();
  return saved;
}

async function restore(id: string, relaunch?: boolean): Promise<ExecuteResult> {
  const layout = need(store).layout(id);
  if (!layout) return { ok: false, error: "That layout no longer exists" };
  await hideLauncherFirst();
  const report = await restoreLayout(deps(), layout, { relaunch: relaunch ?? settings().relaunchMissingApps, launchTimeoutMs: settings().launchTimeoutSec * 1000 });
  const text = summarize(layout.name, report);
  if (!report.ok) return { ok: false, hide: true, error: text };
  hud(text);
  return { ok: true, hide: true };
}

async function runningApps(): Promise<Set<string>> {
  const h = need(ctx).helper;
  if (!h.available()) return new Set();
  const apps = await h.call("layouts.apps").catch(() => []);
  return new Set(apps.map((a) => a.bundleId ?? "").filter(Boolean));
}

async function quitCandidates(ws: Workspace): Promise<AppRef[]> {
  const running = await runningApps();
  return ws.quitApps.filter((a) => running.has(a.bundleId));
}

export interface WorkspaceReport {
  ok: boolean;
  steps: string[];
  errors: string[];
}

async function runWorkspace(ws: Workspace, quit: boolean): Promise<WorkspaceReport> {
  const c = need(ctx);
  const report: WorkspaceReport = { ok: true, steps: [], errors: [] };
  await hideLauncherFirst();
  if (quit) {
    const ids = (await quitCandidates(ws)).map((a) => a.bundleId);
    if (ids.length) {
      const r = await c.helper.call("apps.quit", { bundleIds: ids }).catch((e: unknown) => ({ ok: false, asked: [] as string[], error: String(e) }));
      report.steps.push(`asked ${r.asked.length} app${r.asked.length === 1 ? "" : "s"} to quit`);
    }
  }
  const launched: string[] = [];
  const running = await runningApps();
  for (const app of ws.launchApps) {
    try {
      await launchApp(app);
      if (!running.has(app.bundleId)) launched.push(app.bundleId);
    } catch (err) {
      report.errors.push(`${app.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (ws.launchApps.length) report.steps.push(`opened ${ws.launchApps.length} app${ws.launchApps.length === 1 ? "" : "s"}`);
  for (const url of ws.urls) {
    try {
      if (url.startsWith("/") || url.startsWith("~/")) {
        const err = await shell.openPath(url.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
        if (err) throw new Error(err);
      } else await shell.openExternal(url);
    } catch (err) {
      report.errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (ws.urls.length) report.steps.push(`opened ${ws.urls.length} link${ws.urls.length === 1 ? "" : "s"}`);
  if (ws.shortcut) {
    const err = await runShortcut(ws.shortcut);
    if (err) report.errors.push(`Shortcut “${ws.shortcut}”: ${err}`);
    else report.steps.push(`ran “${ws.shortcut}”`);
  }
  if (ws.focus) {
    try {
      await focusFeature.methods?.start?.(ws.focus.goal, ws.focus.minutes);
      report.steps.push(`focus ${ws.focus.minutes} min`);
    } catch (err) {
      report.errors.push(`Focus: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const layout = ws.layoutId ? need(store).layout(ws.layoutId) : undefined;
  if (layout) {
    const r = await restoreLayout(deps(), layout, {
      relaunch: ws.relaunchLayoutApps,
      launchTimeoutMs: settings().launchTimeoutSec * 1000,
      alsoWaitFor: launched.filter((id) => layoutApps(layout).some((a) => a.bundleId === id)),
    });
    if (r.ok) report.steps.push(`${r.moved}/${r.total} windows placed`);
    else report.errors.push(r.error ?? "Layout failed");
  }
  if (ws.noteId) {
    try {
      await notesFeature.methods?.open?.(ws.noteId);
    } catch (err) {
      report.errors.push(`Note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}

/** Entry point for launcher items and hotkeys: confirm quits in the launcher, otherwise run right away. */
async function openWorkspace(id: string): Promise<ExecuteResult> {
  const ws = need(store).workspace(id);
  if (!ws) return { ok: false, error: "That workspace no longer exists" };
  if ((await quitCandidates(ws)).length) {
    const view = { id: "layouts.confirm", props: { workspaceId: ws.id, title: ws.name } };
    if (BrowserWindow.getFocusedWindow()) return { ok: true, view };
    need(ctx).openView(view);
    return { ok: true };
  }
  return finishWorkspace(ws, false);
}

async function finishWorkspace(ws: Workspace, quit: boolean): Promise<ExecuteResult> {
  const r = await runWorkspace(ws, quit);
  const text = `${ws.name}: ${r.steps.join(" · ") || "nothing to do"}`;
  if (!r.ok) return { ok: false, hide: true, error: `${text}. Problems: ${r.errors.join("; ")}` };
  hud(`${ws.name} ready`);
  return { ok: true, hide: true, message: text };
}

function saveWorkspace(raw: unknown): Workspace {
  const s = need(store);
  const now = Date.now();
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const id = typeof input.id === "string" && input.id ? input.id : newId("ws", now);
  const prev = s.workspace(id);
  const ws = parseWorkspace({ ...input, id, createdAt: prev?.createdAt ?? now, updatedAt: now });
  if (!ws) throw new Error("A workspace needs a name");
  if (ws.layoutId && !s.layout(ws.layoutId)) ws.layoutId = null;
  s.putWorkspace(ws);
  changed();
  return ws;
}

/** Workspace the settings page should open in its editor ("new" = blank); taken once by the page. */
let pendingEdit: string | null = null;
function editInSettings(target: string): void {
  pendingEdit = target;
  ctx?.openSettings("layouts");
  ctx?.emit("edit", target);
}

const layoutItemId = (id: string) => `layouts.layout.${id}`;
const workspaceItemId = (id: string) => `layouts.workspace.${id}`;

function workspaceSubtitle(ws: Workspace, layouts: LayoutStore): string {
  const bits: string[] = [];
  const l = ws.layoutId ? layouts.layout(ws.layoutId) : undefined;
  if (l) bits.push(`Layout “${l.name}”`);
  if (ws.launchApps.length) bits.push(`${ws.launchApps.length} to open`);
  if (ws.quitApps.length) bits.push(`${ws.quitApps.length} to quit`);
  if (ws.urls.length) bits.push(`${ws.urls.length} links`);
  if (ws.focus) bits.push(`Focus ${ws.focus.minutes} min`);
  return bits.join(" · ") || "Workspace";
}

function summaries() {
  const s = need(store);
  return {
    layouts: [...s.layouts].sort((a, b) => b.updatedAt - a.updatedAt).map((l) => ({ ...l, summary: describeLayout(l), apps: layoutApps(l), itemId: layoutItemId(l.id) })),
    workspaces: [...s.workspaces].sort((a, b) => a.name.localeCompare(b.name)).map((w) => ({ ...w, summary: workspaceSubtitle(w, s), itemId: workspaceItemId(w.id) })),
    settings: settings(),
  };
}
export type LayoutsState = ReturnType<typeof summaries>;

const str = (v: unknown) => (typeof v === "string" ? v : "");

export const feature: FeatureModule = {
  id: "layouts",
  start(c) {
    ctx = c;
    store = new LayoutStore(c.dataDir());
  },
  stop() {
    ctx = null;
    store = null;
  },
  items(): SearchItem[] {
    const s = store;
    const base: SearchItem[] = [
      { id: "layouts.save", kind: "command", title: "Save Window Layout", subtitle: "Window Layouts", icon: { kind: "emoji", value: "💾" }, keywords: ["layout", "windows", "snapshot", "arrangement"], feature: "layouts", kindLabel: "Layouts", data: { action: "save" } },
      { id: "layouts.list", kind: "command", title: "Window Layouts", subtitle: "Restore, update and manage layouts & workspaces", icon: { kind: "emoji", value: "🗂️" }, keywords: ["workspaces", "restore", "layout"], feature: "layouts", kindLabel: "Layouts", data: { action: "list" } },
      { id: "layouts.new-workspace", kind: "command", title: "Create Workspace", subtitle: "Window Layouts", icon: { kind: "emoji", value: "🧰" }, keywords: ["workspace", "layout", "project", "context"], feature: "layouts", kindLabel: "Layouts", data: { action: "new-workspace" } },
    ];
    if (!s) return base;
    return [
      ...base,
      ...s.layouts.map((l): SearchItem => ({
        id: layoutItemId(l.id),
        kind: "command",
        title: `Restore Layout ${l.name}`,
        subtitle: describeLayout(l),
        icon: { kind: "emoji", value: "🪟" },
        keywords: ["layout", "windows", l.name, ...layoutApps(l).map((a) => a.name)],
        feature: "layouts",
        kindLabel: "Layout",
        data: { action: "restore", layoutId: l.id },
      })),
      ...s.workspaces.map((w): SearchItem => ({
        id: workspaceItemId(w.id),
        kind: "command",
        title: `Open Workspace ${w.name}`,
        subtitle: workspaceSubtitle(w, s),
        icon: { kind: "emoji", value: "🧰" },
        keywords: ["workspace", w.name],
        feature: "layouts",
        kindLabel: "Workspace",
        data: { action: "workspace", workspaceId: w.id },
      })),
    ];
  },
  actions(item): ItemAction[] {
    const a = item.data?.action;
    if (a === "save") return [{ id: "save", title: "Save Window Layout", icon: "💾" }, { id: "settings", title: "Window Layout Settings…", icon: "⚙️" }];
    if (a === "list") return [{ id: "list", title: "Show Layouts", icon: "🗂️" }];
    if (a === "new-workspace") return [{ id: "new-workspace", title: "Create Workspace", icon: "🧰" }];
    if (a === "restore")
      return [
        { id: "restore", title: "Restore Layout", icon: "🪟" },
        { id: "restore-relaunch", title: "Restore & Launch Missing Apps", icon: "🚀", shortcut: "⌘⏎" },
        { id: "update", title: "Update with Current Windows", icon: "💾" },
        { id: "list", title: "Show Layouts", icon: "🗂️" },
        { id: "open-accessibility", title: "Open Accessibility Settings", icon: "🔐" },
      ];
    if (a === "workspace")
      return [
        { id: "workspace", title: "Open Workspace", icon: "🧰" },
        { id: "edit-workspace", title: "Edit Workspace…", icon: "✏️", shortcut: "⌘⏎" },
      ];
    return [];
  },
  async runAction(scored, actionId) {
    const d = scored.item.data ?? {};
    switch (actionId) {
      case "save":
        return { ok: true, view: { id: "layouts.save", props: { title: "Save Window Layout" } } };
      case "list":
        return { ok: true, view: { id: "layouts.list", props: { title: "Window Layouts" } } };
      case "settings":
        ctx?.openSettings("layouts");
        return { ok: true, hide: true };
      case "new-workspace":
      case "edit-workspace":
        editInSettings(actionId === "new-workspace" ? "new" : str(d.workspaceId));
        return { ok: true, hide: true };
      case "open-accessibility":
        await shell.openExternal(ACCESSIBILITY_PANE);
        return { ok: true, hide: true };
      case "restore":
      case "restore-relaunch":
        return restore(str(d.layoutId), actionId === "restore-relaunch" ? true : undefined);
      case "update": {
        await hideLauncherFirst();
        const l = await saveLayout(undefined, str(d.layoutId));
        hud(`Updated ${l.name}: ${describeLayout(l)}`);
        return { ok: true, hide: true };
      }
      case "workspace":
        return openWorkspace(str(d.workspaceId));
      default:
        return { ok: false, error: "Unknown layout action" };
    }
  },
  methods: {
    state: () => summaries(),
    /** Capture now (the launcher hides itself first only for the restore path; capture skips Glide's windows anyway). */
    save: async (name, overwriteId) => saveLayout(name, overwriteId),
    /** What "Save" would capture right now (nothing is stored). */
    // Returned, not thrown: a missing helper or permission is an expected state, not an IPC failure.
    preview: async () => {
      try {
        return await captureLayout(deps(), "Preview");
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    restore: (id, relaunch) => restore(str(id), typeof relaunch === "boolean" ? relaunch : undefined),
    rename: (id, name) => {
      const s = need(store);
      const l = s.layout(str(id));
      if (!l || !str(name).trim()) return false;
      s.putLayout({ ...l, name: str(name).trim(), updatedAt: Date.now() });
      changed();
      return true;
    },
    deleteLayout: (id) => {
      need(store).deleteLayout(str(id));
      changed();
      return true;
    },
    saveWorkspace: (ws) => saveWorkspace(ws),
    deleteWorkspace: (id) => {
      need(store).deleteWorkspace(str(id));
      changed();
      return true;
    },
    /** Running apps this workspace would quit (shown in the confirmation view). */
    quitCandidates: async (id) => {
      const ws = need(store).workspace(str(id));
      return ws ? quitCandidates(ws) : [];
    },
    openWorkspace: (id) => openWorkspace(str(id)),
    /** Called from the confirmation view; quit=false skips quitting but does everything else. */
    runWorkspace: async (id, quit) => {
      const ws = need(store).workspace(str(id));
      if (!ws) return { ok: false, error: "That workspace no longer exists" };
      return finishWorkspace(ws, quit === true);
    },
    setSettings: (patch) => {
      const p = (patch && typeof patch === "object" ? patch : {}) as Partial<LayoutSettings>;
      const clean: Partial<LayoutSettings> = {};
      if (typeof p.relaunchMissingApps === "boolean") clean.relaunchMissingApps = p.relaunchMissingApps;
      if (typeof p.launchTimeoutSec === "number" && Number.isFinite(p.launchTimeoutSec)) clean.launchTimeoutSec = Math.min(60, Math.max(2, Math.round(p.launchTimeoutSec)));
      ctx?.setSettings(clean);
      return summaries();
    },
    /** Bundle id for an app picked from the app list (workspace editor). */
    appRef: async (appPath, name) => {
      const p = str(appPath);
      const bundleId = p ? await bundleIdOf(p) : null;
      return bundleId ? { name: str(name) || bundleId, bundleId, path: p } : null;
    },
    runningApps: async () => {
      const h = need(ctx).helper;
      if (!h.available()) return [];
      const apps = await h.call("layouts.apps").catch(() => []);
      return apps.filter((a) => a.bundleId).map((a) => ({ name: a.name, bundleId: a.bundleId!, path: a.path }));
    },
    permission: async () => {
      const h = need(ctx).helper;
      if (!h.available()) return { helper: false, accessibility: false };
      const p = await h.call("permissions.status").catch(() => null);
      return { helper: true, accessibility: p?.accessibility === true };
    },
    openAccessibilitySettings: () => shell.openExternal(ACCESSIBILITY_PANE),
    takePendingEdit: () => {
      const t = pendingEdit;
      pendingEdit = null;
      return t;
    },
    editWorkspace: (id) => editInSettings(str(id) || "new"),
  },
};
