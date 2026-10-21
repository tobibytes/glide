import fs from "node:fs";
import path from "node:path";
import { app, Menu, nativeImage, Notification, screen, Tray, type BrowserWindow } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { appMatches, computeStats, elapsed, extend, finish, formatClock, formatDuration, isComplete, normalizeSite, remaining, siteMatches, startSession, togglePause, type BlockedApp, type FocusRecord, type FocusSession } from "./machine";
import { activeTabUrl, bundleIdOf, frontmostApp, isBrowser, quitApp, runShortcut } from "./system";
import { DEFAULT_FOCUS_SETTINGS, type BlockedInfo, type FocusSettings, type FocusState } from "./types";

const POLL_MS = 2_000;
const NEVER_BLOCK = new Set(["com.apple.finder", "com.apple.loginwindow", "dev.glide.launcher", "com.github.Electron"]);
const MAX_HISTORY = 1_000;

let ctx: FeatureContext | undefined;
let session: FocusSession | null = null;
let history: FocusRecord[] = [];
let tray: Tray | undefined;
let tick: NodeJS.Timeout | undefined;
let poll: NodeJS.Timeout | undefined;
let polling = false;
let blockedWin: BrowserWindow | undefined;
let blockedInfo: BlockedInfo | null = null;
const snoozed = new Map<string, number>(); // site -> until
const lastQuitAttempt = new Map<string, number>();

const file = () => (ctx ? path.join(ctx.dataDir(), "focus.json") : "");

function settings(): FocusSettings {
  const s = ctx?.settings(DEFAULT_FOCUS_SETTINGS) ?? DEFAULT_FOCUS_SETTINGS;
  return {
    defaultMinutes: typeof s.defaultMinutes === "number" && s.defaultMinutes > 0 ? s.defaultMinutes : 25,
    blockedApps: Array.isArray(s.blockedApps) ? s.blockedApps.filter((a): a is BlockedApp => !!a && typeof a.name === "string") : [],
    blockedSites: Array.isArray(s.blockedSites) ? s.blockedSites.filter((x): x is string => typeof x === "string") : [],
    dndOnShortcut: typeof s.dndOnShortcut === "string" ? s.dndOnShortcut : "",
    dndOffShortcut: typeof s.dndOffShortcut === "string" ? s.dndOffShortcut : "",
    quitBlockedApps: s.quitBlockedApps !== false,
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as { session?: FocusSession | null; history?: FocusRecord[] };
    session = raw.session && typeof raw.session.durationMs === "number" ? raw.session : null;
    history = Array.isArray(raw.history) ? raw.history.filter((r) => r && typeof r.focusedMs === "number") : [];
  } catch {
    session = null;
    history = [];
  }
}

function save() {
  if (!ctx) return;
  try {
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ session, history }));
    fs.renameSync(tmp, file());
  } catch (err) {
    ctx.log("could not save focus state", err);
  }
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
}

function state(): FocusState {
  const now = Date.now();
  return {
    session,
    remainingMs: session ? remaining(session, now) : 0,
    elapsedMs: session ? elapsed(session, now) : 0,
    stats: computeStats(history, now, session),
    settings: settings(),
    recent: history.slice(-20).reverse(),
  };
}

function broadcast() {
  ctx?.emit("state", state());
}

// ---------------------------------------------------------------------------
// Menu-bar item
// ---------------------------------------------------------------------------

function trayTitle(): string {
  if (!session) return "";
  const clock = formatClock(remaining(session, Date.now()));
  return session.status === "paused" ? `◷ ${clock} ❚❚` : `◷ ${clock}`;
}

function buildTrayMenu() {
  if (!tray || !session) return;
  const s = session;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s.goal ? `Focus: ${s.goal}` : "Focus Session", enabled: false },
      { label: `${formatDuration(s.durationMs)} session`, enabled: false },
      { type: "separator" },
      { label: s.status === "running" ? "Pause" : "Resume", click: () => doTogglePause() },
      { label: "Add 5 Minutes", click: () => doExtend(5) },
      { label: "Stop Session", click: () => void stop(false) },
      { type: "separator" },
      { label: "Focus Statistics…", click: () => ctx?.openView({ id: "focus.stats" }) },
    ]),
  );
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Glide Focus");
  buildTrayMenu();
}

function destroyTray() {
  tray?.destroy();
  tray = undefined;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function startTimers() {
  clearInterval(tick);
  tick = setInterval(() => {
    if (!session) return;
    if (isComplete(session, Date.now())) {
      void stop(true);
      return;
    }
    tray?.setTitle(trayTitle(), { fontType: "monospacedDigit" });
  }, 1_000);
  clearInterval(poll);
  poll = setInterval(() => void enforce(), POLL_MS);
  ensureTray();
  tray?.setTitle(trayTitle(), { fontType: "monospacedDigit" });
}

function stopTimers() {
  clearInterval(tick);
  clearInterval(poll);
  tick = poll = undefined;
  destroyTray();
  closeBlocked();
}

function changed() {
  save();
  buildTrayMenu();
  tray?.setTitle(trayTitle(), { fontType: "monospacedDigit" });
  ctx?.refreshCatalogue();
  broadcast();
}

async function start(goal: string, minutes: number): Promise<ExecuteResult> {
  if (session) await stop(false, true);
  const s = settings();
  session = startSession(Date.now(), { goal, minutes, blockedApps: s.blockedApps, blockedSites: s.blockedSites });
  snoozed.clear();
  startTimers();
  changed();
  if (s.dndOnShortcut) {
    const err = await runShortcut(s.dndOnShortcut);
    if (err) notify("Focus: Shortcut failed", `“${s.dndOnShortcut}”: ${err}`);
  }
  return { ok: true, hide: true, message: `Focusing for ${formatDuration(session.durationMs)}` };
}

async function stop(completed: boolean, silent = false): Promise<ExecuteResult> {
  if (!session) return { ok: false, error: "No focus session is running" };
  const rec = finish(session, Date.now());
  history = [...history, rec].slice(-MAX_HISTORY);
  session = null;
  stopTimers();
  changed();
  if (completed) notify("Focus session complete", `${formatDuration(rec.focusedMs)} of focus${rec.goal ? ` on “${rec.goal}”` : ""}. Take a break!`);
  const off = settings().dndOffShortcut;
  if (off && !silent) void runShortcut(off);
  return { ok: true, hide: true, message: `Focused for ${formatDuration(rec.focusedMs)}` };
}

function doTogglePause(): ExecuteResult {
  if (!session) return { ok: false, error: "No focus session is running" };
  session = togglePause(session, Date.now());
  changed();
  return { ok: true, hide: true, message: session.status === "paused" ? "Focus paused" : "Focus resumed" };
}

function doExtend(minutes: number): ExecuteResult {
  if (!session) return { ok: false, error: "No focus session is running" };
  session = extend(session, Date.now(), minutes);
  changed();
  return { ok: true, message: `${formatClock(remaining(session, Date.now()))} left` };
}

// ---------------------------------------------------------------------------
// Enforcement (apps: ask to quit; sites: reminder only)
// ---------------------------------------------------------------------------

async function enforce() {
  if (!session || session.status !== "running" || polling || !ctx) return;
  polling = true;
  try {
    const front = await frontmostApp(ctx.helper);
    if (!front || (front.bundleId && NEVER_BLOCK.has(front.bundleId)) || front.pid === process.pid) return;
    const hit = appMatches(front, session.blockedApps);
    if (hit) {
      const key = front.bundleId ?? front.name;
      const last = lastQuitAttempt.get(key) ?? 0;
      if (Date.now() - last > 10_000) {
        lastQuitAttempt.set(key, Date.now());
        const quit = settings().quitBlockedApps ? await quitApp(front) : false;
        notify(`${front.name} is blocked`, quit ? `Quit during your focus session${session.goal ? ` on “${session.goal}”` : ""}.` : `It is on your focus block list${session.goal ? ` — back to “${session.goal}”` : ""}.`);
      }
      return;
    }
    if (session.blockedSites.length && isBrowser(front.bundleId) && front.bundleId) {
      const url = await activeTabUrl(front.bundleId);
      const site = url ? siteMatches(url, session.blockedSites) : null;
      if (url && site && (snoozed.get(site) ?? 0) < Date.now()) showBlocked({ site, url, goal: session.goal, remainingMs: remaining(session, Date.now()) });
    }
  } catch (err) {
    ctx.log("focus poll failed", err);
  } finally {
    polling = false;
  }
}

function showBlocked(info: BlockedInfo) {
  if (!ctx) return;
  const sameSite = blockedInfo?.site === info.site && blockedWin && !blockedWin.isDestroyed() && blockedWin.isVisible();
  blockedInfo = info;
  if (sameSite) return;
  ctx.emit("blocked", info);
  if (!blockedWin || blockedWin.isDestroyed()) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.round(workArea.width * 0.8);
    const height = Math.round(workArea.height * 0.8);
    blockedWin = ctx.createWindow("focus/blocked", {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      roundedCorners: true,
      vibrancy: "fullscreen-ui",
      visualEffectState: "active",
    });
    blockedWin.setAlwaysOnTop(true, "floating");
    blockedWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const w = blockedWin;
    w.once("ready-to-show", () => {
      w.show();
      w.focus();
    });
    w.on("closed", () => {
      if (blockedWin === w) blockedWin = undefined;
    });
  } else {
    blockedWin.show();
    blockedWin.focus();
  }
}

function closeBlocked() {
  if (blockedWin && !blockedWin.isDestroyed()) blockedWin.close();
  blockedWin = undefined;
  blockedInfo = null;
}

// ---------------------------------------------------------------------------

const item = (id: string, title: string, subtitle: string, icon: string, keywords: string[], extra: Partial<SearchItem> = {}): SearchItem => ({
  id: `focus:${id}`,
  kind: "command",
  kindLabel: "Focus",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "focus",
  data: { action: id },
  ...extra,
});

export const feature: FeatureModule = {
  id: "focus",
  start(c) {
    ctx = c;
    load();
    if (session) {
      if (isComplete(session, Date.now())) void stop(true);
      else startTimers();
    }
    app.on("before-quit", save);
  },
  stop() {
    save();
    stopTimers();
  },
  items() {
    const list: SearchItem[] = [];
    if (session) {
      const left = formatClock(remaining(session, Date.now()));
      list.push(
        item("stop", "Stop Focus Session", `${session.goal || "Focus"} · ${left} left`, "⏹️", ["focus", "end", "finish", "pomodoro"]),
        item("pause", session.status === "running" ? "Pause Focus Session" : "Resume Focus Session", session.goal || "Focus", session.status === "running" ? "⏸️" : "▶️", ["focus", "pause", "resume", "pomodoro"]),
      );
    }
    list.push(
      item("start", session ? "Start New Focus Session" : "Start Focus Session", "Focus", "🎯", ["focus", "pomodoro", "timer", "deep work", "concentrate"], { acceptsArgument: true }),
      item("stats", "Focus Statistics", "Focus", "📊", ["focus", "stats", "history", "pomodoro"]),
    );
    return list;
  },
  actions(i): ItemAction[] {
    const a = i.data?.action;
    if (a === "start") return [{ id: "start", title: "Start Focus Session", shortcut: "⏎" }, { id: "quickStart", title: `Start ${settings().defaultMinutes} min Now`, shortcut: "⌘⏎" }];
    if (a === "stop") return [{ id: "stop", title: "Stop Focus Session", shortcut: "⏎" }];
    if (a === "pause") return [{ id: "pause", title: "Pause/Resume", shortcut: "⏎" }, { id: "extend", title: "Add 5 Minutes", shortcut: "⌘⏎" }];
    return [{ id: "stats", title: "Show Statistics", shortcut: "⏎" }];
  },
  async runAction(scored, actionId) {
    const goal = scored.argument?.trim() ?? "";
    switch (actionId) {
      case "start":
        return { ok: true, view: { id: "focus.start", props: { goal } } };
      case "quickStart":
        return start(goal, settings().defaultMinutes);
      case "stop":
        return stop(false);
      case "pause":
        return doTogglePause();
      case "extend":
        return doExtend(5);
      case "stats":
        return { ok: true, view: { id: "focus.stats" } };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    state: () => state(),
    start: (goal: unknown, minutes: unknown) => start(typeof goal === "string" ? goal : "", typeof minutes === "number" && minutes > 0 ? minutes : settings().defaultMinutes),
    stop: () => stop(false),
    togglePause: () => doTogglePause(),
    extend: (minutes: unknown) => doExtend(typeof minutes === "number" ? minutes : 5),
    setSettings: async (patch: unknown) => {
      if (!patch || typeof patch !== "object") return state();
      const p = patch as Partial<FocusSettings>;
      const clean: Partial<FocusSettings> = {};
      if (typeof p.defaultMinutes === "number" && p.defaultMinutes > 0) clean.defaultMinutes = Math.round(p.defaultMinutes);
      if (Array.isArray(p.blockedApps)) {
        const apps = p.blockedApps.filter((a) => a && typeof a.name === "string");
        // Bundle ids make matching robust against localized display names.
        clean.blockedApps = await Promise.all(apps.map(async (a) => ({ name: a.name, path: a.path, bundleId: a.bundleId ?? (a.path ? ((await bundleIdOf(a.path)) ?? undefined) : undefined) })));
      }
      if (Array.isArray(p.blockedSites)) clean.blockedSites = [...new Set(p.blockedSites.map((s) => normalizeSite(String(s))).filter(Boolean))];
      if (typeof p.dndOnShortcut === "string") clean.dndOnShortcut = p.dndOnShortcut.trim();
      if (typeof p.dndOffShortcut === "string") clean.dndOffShortcut = p.dndOffShortcut.trim();
      if (typeof p.quitBlockedApps === "boolean") clean.quitBlockedApps = p.quitBlockedApps;
      ctx?.setSettings(clean);
      // Apply block-list edits to the running session too.
      if (session && (clean.blockedApps || clean.blockedSites)) {
        session = { ...session, blockedApps: clean.blockedApps ?? session.blockedApps, blockedSites: clean.blockedSites ?? session.blockedSites };
        save();
      }
      broadcast();
      return state();
    },
    blockedInfo: () => blockedInfo,
    dismissBlocked: (snoozeMinutes: unknown) => {
      if (blockedInfo && typeof snoozeMinutes === "number" && snoozeMinutes > 0) snoozed.set(blockedInfo.site, Date.now() + snoozeMinutes * 60_000);
      else if (blockedInfo) snoozed.set(blockedInfo.site, Date.now() + 15_000); // grace period to switch tabs
      closeBlocked();
      return true;
    },
    testShortcut: async (name: unknown) => (typeof name === "string" && name.trim() ? runShortcut(name.trim()) : "Enter a Shortcut name"),
  },
};
