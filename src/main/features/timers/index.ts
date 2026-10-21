/**
 * Timers & stopwatches: "timer 25m", "start timer 10 min tea", presets, stopwatches with laps.
 * Running timers show in the launcher and in the menu-bar title (via setTrayTitle in ../../tray),
 * notify + play a sound when done, and persist across restarts (absolute timestamps on disk).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, Notification } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { setTrayTitle } from "../../tray";
import type { FeatureContext, FeatureModule } from "../types";
import {
  addTime, createStopwatch, createTimer, DEFAULT_PRESETS, formatClock, formatDuration, isPreset, isStopwatch, isTimer, lap, newId, parseDurationAndName,
  parseTimerQuery, resetStopwatch, restartTimer, reviveTimers, soundCommand, SOUNDS, stopwatchElapsed, timerDone, timerEndsAt, timerLabel, timerRemaining,
  toggleStopwatch, toggleTimer, trayTitleFor, type Preset, type Stopwatch, type Timer, type TimersData,
} from "./model";

export interface TimerSettings {
  sound: string; // one of SOUNDS or "none"
  showInMenuBar: boolean;
}
const DEFAULT_SETTINGS: TimerSettings = { sound: "Glass", showInMenuBar: true };

export interface TimersState extends TimersData {
  now: number;
  settings: TimerSettings;
  sounds: readonly string[];
}

let ctx: FeatureContext | undefined;
let data: TimersData = { timers: [], stopwatches: [], presets: DEFAULT_PRESETS };
let tick: NodeJS.Timeout | undefined;

const file = () => (ctx ? path.join(ctx.dataDir(), "timers.json") : "");

function settings(): TimerSettings {
  const s = ctx?.settings(DEFAULT_SETTINGS as unknown as Record<string, unknown>) ?? {};
  return {
    sound: typeof s.sound === "string" && (s.sound === "none" || (SOUNDS as readonly string[]).includes(s.sound)) ? s.sound : "Glass",
    showInMenuBar: s.showInMenuBar !== false,
  };
}

function load(): Timer[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Record<keyof TimersData, unknown[]>>;
    const timers = Array.isArray(raw.timers) ? raw.timers.filter(isTimer) : [];
    const { running, finished } = reviveTimers(timers, Date.now());
    data = {
      timers: running,
      stopwatches: Array.isArray(raw.stopwatches) ? raw.stopwatches.filter(isStopwatch) : [],
      presets: Array.isArray(raw.presets) ? raw.presets.filter(isPreset) : DEFAULT_PRESETS,
    };
    return finished;
  } catch {
    return [];
  }
}

function save() {
  if (!ctx) return;
  try {
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    ctx.log("could not save timers", err);
  }
}

function state(): TimersState {
  return { ...data, now: Date.now(), settings: settings(), sounds: SOUNDS };
}

function playSound() {
  const cmd = soundCommand(settings().sound);
  if (!cmd) return;
  try {
    const child = spawn(cmd.cmd, cmd.args, { stdio: "ignore", detached: false });
    child.on("error", () => undefined);
  } catch {
    // no sound is fine
  }
}

function notifyDone(t: Timer, whileClosed = false) {
  if (Notification.isSupported()) {
    const n = new Notification({
      title: `⏱ ${timerLabel(t)} is done`,
      body: whileClosed ? `Finished while Glide was closed (${formatDuration(t.durationMs)} timer).` : `${formatDuration(t.durationMs)} timer finished.`,
      silent: true, // our own sound plays, so the user's choice applies even if notifications are muted
    });
    n.on("click", () => ctx?.openView({ id: "timers.list" }));
    n.show();
  }
  if (!whileClosed) playSound();
}

function updateTray() {
  setTrayTitle(settings().showInMenuBar ? trayTitleFor(data, Date.now()) : "");
}

function ensureTicking() {
  const active = data.timers.length > 0 || data.stopwatches.some((s) => s.pausedAt === null);
  if (active && !tick) tick = setInterval(onTick, 1000);
  if (!active && tick) {
    clearInterval(tick);
    tick = undefined;
  }
  updateTray();
}

function onTick() {
  const now = Date.now();
  const done = data.timers.filter((t) => timerDone(t, now));
  if (done.length) {
    data = { ...data, timers: data.timers.filter((t) => !done.includes(t)) };
    for (const t of done) notifyDone(t);
    changed();
    return;
  }
  updateTray();
}

function changed() {
  save();
  ensureTicking();
  ctx?.refreshCatalogue();
  ctx?.emit("state", state());
}

// --- operations --------------------------------------------------------------

function startTimer(ms: number, name: string): ExecuteResult {
  if (!(ms > 0)) return { ok: false, error: "Enter a duration such as 25m, 1h30m or 5:00" };
  const t = createTimer(Date.now(), ms, name);
  data = { ...data, timers: [...data.timers, t] };
  changed();
  return { ok: true, hide: true, message: `${timerLabel(t)} started — ${formatClock(ms)}` };
}

function updateTimer(id: string, fn: (t: Timer) => Timer | null): ExecuteResult {
  const t = data.timers.find((x) => x.id === id);
  if (!t) return { ok: false, error: "That timer is no longer running" };
  const next = fn(t);
  data = { ...data, timers: next ? data.timers.map((x) => (x.id === id ? next : x)) : data.timers.filter((x) => x.id !== id) };
  changed();
  return { ok: true, message: next ? `${timerLabel(next)}: ${formatClock(timerRemaining(next, Date.now()))} left${next.pausedAt !== null ? " (paused)" : ""}` : `${timerLabel(t)} stopped` };
}

function updateStopwatch(id: string, fn: (s: Stopwatch) => Stopwatch | null): ExecuteResult {
  const s = data.stopwatches.find((x) => x.id === id);
  if (!s) return { ok: false, error: "That stopwatch no longer exists" };
  const next = fn(s);
  data = { ...data, stopwatches: next ? data.stopwatches.map((x) => (x.id === id ? next : x)) : data.stopwatches.filter((x) => x.id !== id) };
  changed();
  return { ok: true, message: next ? `${next.name || "Stopwatch"}: ${formatClock(stopwatchElapsed(next, Date.now()), false)}` : "Stopwatch removed" };
}

function startStopwatch(name: string): ExecuteResult {
  const s = createStopwatch(Date.now(), name);
  data = { ...data, stopwatches: [...data.stopwatches, s] };
  changed();
  return { ok: true, message: `${s.name || "Stopwatch"} started`, view: { id: "timers.list", props: { select: s.id } } };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const msArg = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// --- search items --------------------------------------------------------------

const item = (id: string, title: string, subtitle: string, icon: string, keywords: string[], extra: Partial<SearchItem> = {}): SearchItem => ({
  id: `timers:${id}`,
  kind: "command",
  kindLabel: "Timer",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "timers",
  data: { action: id },
  ...extra,
});

function runningItems(query: string): ScoredItem[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const now = Date.now();
  const relevant = (name: string) => "timers".startsWith(q) || q.startsWith("timer") || "stopwatch".startsWith(q) || (q.length >= 3 && name.toLowerCase().includes(q));
  const out: ScoredItem[] = [];
  for (const t of data.timers) {
    if (!relevant(timerLabel(t))) continue;
    const left = formatClock(timerRemaining(t, now));
    out.push({
      item: item(`running:${t.id}`, `${timerLabel(t)} — ${left} left`, t.pausedAt !== null ? "Paused · ⏎ resume · ⌘⏎ +1 min" : `Ends ${new Date(timerEndsAt(t)).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · ⏎ pause · ⌘⏎ +1 min`, t.pausedAt !== null ? "⏸️" : "⏱️", ["timer", "running", t.name], { data: { action: "running", timerId: t.id, noUsage: true } }),
      score: 500,
      matchScore: 500,
      matchKind: "keyword",
      frecency: 0,
      ranges: [],
    });
  }
  for (const s of data.stopwatches) {
    if (!relevant(s.name || "stopwatch")) continue;
    out.push({
      item: item(`sw:${s.id}`, `${s.name || "Stopwatch"} — ${formatClock(stopwatchElapsed(s, now), false)}`, `${s.laps.length} lap${s.laps.length === 1 ? "" : "s"} · ⏎ lap · ⌘⏎ ${s.pausedAt === null ? "pause" : "resume"}`, "⏱️", ["stopwatch", "running", s.name], { data: { action: "stopwatch", stopwatchId: s.id, noUsage: true } }),
      score: 499,
      matchScore: 499,
      matchKind: "keyword",
      frecency: 0,
      ranges: [],
    });
  }
  return out;
}

function quickStartItem(query: string): ScoredItem[] {
  const p = parseTimerQuery(query);
  if (!p) return [];
  const label = p.name ? `${formatDuration(p.ms)} · ${p.name}` : formatDuration(p.ms);
  return [
    {
      item: {
        id: `timers:quick:${query.trim().toLowerCase()}`,
        kind: "calculator",
        title: `Start ${label} Timer`,
        subtitle: `Ends around ${new Date(Date.now() + p.ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · ⏎ start · ⌘⏎ save as preset`,
        icon: { kind: "emoji", value: "⏱️" },
        feature: "timers",
        kindLabel: "Timer",
        data: { action: "quick", ms: p.ms, name: p.name, noUsage: true },
      },
      score: 998,
      matchScore: 998,
      matchKind: "exact",
      frecency: 0,
      ranges: [],
    },
  ];
}

function savePreset(name: string, ms: number): ExecuteResult {
  if (!(ms > 0)) return { ok: false, error: "Invalid duration" };
  const p: Preset = { id: newId("p", Date.now()), name: name.trim() || `${formatDuration(ms)}`, durationMs: ms };
  data = { ...data, presets: [...data.presets, p] };
  changed();
  return { ok: true, message: `Saved preset “${p.name}”` };
}

export const feature: FeatureModule = {
  id: "timers",
  start(c) {
    ctx = c;
    const finished = load();
    for (const t of finished) notifyDone(t, true);
    if (finished.length) save();
    ensureTicking();
    app.on("before-quit", save);
  },
  stop() {
    save();
    if (tick) clearInterval(tick);
    tick = undefined;
    setTrayTitle("");
  },
  items() {
    const n = data.timers.length;
    const running = n ? `${n} running · next ${formatClock(Math.min(...data.timers.map((t) => timerRemaining(t, Date.now()))))}` : "Timers & Stopwatches";
    return [
      item("start", "Start Timer", "Type a duration: 25m, 1h30m, 5:00 · Tab for presets", "⏱️", ["timer", "countdown", "alarm", "pomodoro", "egg", "tea", "kitchen"], { acceptsArgument: true }),
      item("list", "Timers", running, "⏲️", ["timer", "timers", "running", "countdown", "stopwatch", "presets"]),
      item("stopwatch", "Start Stopwatch", "Stopwatch with laps", "⏱️", ["stopwatch", "lap", "chronometer", "elapsed", "time"], { acceptsArgument: true }),
    ];
  },
  dynamicItems(query) {
    return [...quickStartItem(query), ...runningItems(query)];
  },
  actions(i): ItemAction[] {
    switch (i.data?.action) {
      case "start":
        return [{ id: "start", title: "Start Timer", shortcut: "⏎" }, { id: "list", title: "Show Timers", shortcut: "⌘⏎" }];
      case "list":
        return [{ id: "list", title: "Show Timers", shortcut: "⏎" }];
      case "quick":
        return [{ id: "quick", title: "Start Timer", shortcut: "⏎" }, { id: "savePreset", title: "Save as Preset", shortcut: "⌘⏎" }];
      case "running":
        return [
          { id: "toggle", title: "Pause / Resume", shortcut: "⏎" },
          { id: "plus1", title: "Add 1 Minute", shortcut: "⌘⏎" },
          { id: "plus5", title: "Add 5 Minutes" },
          { id: "restart", title: "Restart" },
          { id: "list", title: "Show Timers", shortcut: "⌘T" },
          { id: "stop", title: "Stop Timer", shortcut: "⌃X", destructive: true },
        ];
      case "stopwatch-running":
      case "stopwatch":
        return i.data?.stopwatchId
          ? [
              { id: "lap", title: "Lap", shortcut: "⏎" },
              { id: "swToggle", title: "Pause / Resume", shortcut: "⌘⏎" },
              { id: "swReset", title: "Reset" },
              { id: "list", title: "Show Timers", shortcut: "⌘T" },
              { id: "swStop", title: "Remove Stopwatch", shortcut: "⌃X", destructive: true },
            ]
          : [{ id: "stopwatch", title: "Start Stopwatch", shortcut: "⏎" }, { id: "list", title: "Show Timers", shortcut: "⌘⏎" }];
    }
    return [];
  },
  async runAction(scored, actionId) {
    const d = scored.item.data ?? {};
    const arg = (scored.argument ?? "").trim().replace(/^timer\s+/i, "");
    const timerId = str(d.timerId);
    const swId = str(d.stopwatchId);
    switch (actionId) {
      case "start": {
        const p = arg ? parseDurationAndName(arg) : undefined;
        if (p) return startTimer(p.ms, p.name);
        return { ok: true, view: { id: "timers.list", props: arg ? { query: arg } : {} } };
      }
      case "list":
        return { ok: true, view: { id: "timers.list" } };
      case "stopwatch":
        return startStopwatch(arg);
      case "quick":
        return startTimer(msArg(d.ms), str(d.name));
      case "savePreset":
        return savePreset(str(d.name), msArg(d.ms));
      case "toggle":
        return updateTimer(timerId, (t) => toggleTimer(t, Date.now()));
      case "plus1":
        return updateTimer(timerId, (t) => addTime(t, 60_000));
      case "plus5":
        return updateTimer(timerId, (t) => addTime(t, 5 * 60_000));
      case "restart":
        return updateTimer(timerId, (t) => restartTimer(t, Date.now()));
      case "stop":
        return updateTimer(timerId, () => null);
      case "lap":
        return updateStopwatch(swId, (s) => lap(s, Date.now()));
      case "swToggle":
        return updateStopwatch(swId, (s) => toggleStopwatch(s, Date.now()));
      case "swReset":
        return updateStopwatch(swId, (s) => resetStopwatch(s, Date.now()));
      case "swStop":
        return updateStopwatch(swId, () => null);
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    state: () => state(),
    start: (ms: unknown, name: unknown) => startTimer(msArg(ms), str(name)),
    startPreset: (id: unknown) => {
      const p = data.presets.find((x) => x.id === id);
      return p ? startTimer(p.durationMs, p.name) : { ok: false, error: "Unknown preset" };
    },
    toggle: (id: unknown) => updateTimer(str(id), (t) => toggleTimer(t, Date.now())),
    add: (id: unknown, ms: unknown) => updateTimer(str(id), (t) => addTime(t, msArg(ms))),
    restart: (id: unknown) => updateTimer(str(id), (t) => restartTimer(t, Date.now())),
    stop: (id: unknown) => updateTimer(str(id), () => null),
    savePreset: (name: unknown, ms: unknown) => savePreset(str(name), msArg(ms)),
    deletePreset: (id: unknown) => {
      data = { ...data, presets: data.presets.filter((p) => p.id !== id) };
      changed();
      return { ok: true, message: "Preset deleted" };
    },
    resetPresets: () => {
      data = { ...data, presets: DEFAULT_PRESETS };
      changed();
      return { ok: true, message: "Presets restored" };
    },
    stopwatchStart: (name: unknown) => startStopwatch(str(name)),
    lap: (id: unknown) => updateStopwatch(str(id), (s) => lap(s, Date.now())),
    stopwatchToggle: (id: unknown) => updateStopwatch(str(id), (s) => toggleStopwatch(s, Date.now())),
    stopwatchReset: (id: unknown) => updateStopwatch(str(id), (s) => resetStopwatch(s, Date.now())),
    stopwatchRemove: (id: unknown) => updateStopwatch(str(id), () => null),
    setSettings: (patch: unknown) => {
      const p = (patch ?? {}) as Partial<TimerSettings>;
      const clean: Partial<TimerSettings> = {};
      if (typeof p.sound === "string" && (p.sound === "none" || (SOUNDS as readonly string[]).includes(p.sound))) clean.sound = p.sound;
      if (typeof p.showInMenuBar === "boolean") clean.showInMenuBar = p.showInMenuBar;
      ctx?.setSettings(clean as Record<string, unknown>);
      updateTray();
      return state();
    },
    previewSound: (sound: unknown) => {
      const cmd = typeof sound === "string" ? soundCommand(sound) : undefined;
      if (cmd) spawn(cmd.cmd, cmd.args, { stdio: "ignore" }).on("error", () => undefined);
      return !!cmd;
    },
    /** Test hook: what the menu bar shows right now. */
    trayTitle: () => (settings().showInMenuBar ? trayTitleFor(data, Date.now()) : ""),
  },
};
