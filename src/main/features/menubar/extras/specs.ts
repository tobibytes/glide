/**
 * Pure builders for the built-in menu-bar extras: data in, MenuBarItemSpec (minus id) out.
 * Returning null hides the extra (e.g. no timer running). Runtime wiring lives in ./runtime.ts.
 */
import type { MenuBarItemSpec, MenuBarMenuItem } from "../../../menubar";
import type { ClipSummary } from "../../clipboard/model";
import type { ScheduleResult, ScheduleEvent } from "../../calendar/types";
import type { RunSnapshot } from "../../agent/types";
import { formatClock, timerEndsAt, timerLabel, timerRemaining, stopwatchElapsed, type Preset, type Stopwatch, type Timer } from "../../timers/model";
import { formatBytes, type MemoryInfo } from "../../sysmon/parse";

export type ExtraSpec = Omit<MenuBarItemSpec, "id">;

export const sep: MenuBarMenuItem = { separator: true };
const info = (title: string, subtitle?: string): MenuBarMenuItem => ({ title, ...(subtitle ? { subtitle } : {}), enabled: false });

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…` : t;
}

export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// --- Timers --------------------------------------------------------------------------------------

export interface TimersInput {
  timers: Timer[];
  stopwatches: Stopwatch[];
  presets: Preset[];
  settings: { showInMenuBar: boolean };
}

export interface TimerActions {
  toggle(id: string): void;
  add(id: string, ms: number): void;
  stop(id: string): void;
  stopwatchToggle(id: string): void;
  stopwatchRemove(id: string): void;
  startPreset(id: string): void;
  show(): void;
}

/** One row per running timer / stopwatch with a pause-resume / stop submenu (shared with the Glide menu). */
export function timerRows(s: Pick<TimersInput, "timers" | "stopwatches">, now: number, a: TimerActions, withCountdown: boolean): MenuBarMenuItem[] {
  const rows: MenuBarMenuItem[] = [];
  for (const t of s.timers) {
    const paused = t.pausedAt !== null;
    const left = withCountdown ? ` — ${formatClock(timerRemaining(t, now))}` : "";
    rows.push({
      title: `${timerLabel(t)}${left}`,
      subtitle: paused ? "Paused" : `Ends ${clockTime(timerEndsAt(t))}`,
      icon: paused ? "⏸️" : "⏱️",
      submenu: [
        { title: paused ? "Resume" : "Pause", onClick: () => a.toggle(t.id) },
        { title: "Add 1 Minute", onClick: () => a.add(t.id, 60_000) },
        { title: "Add 5 Minutes", onClick: () => a.add(t.id, 5 * 60_000) },
        sep,
        { title: "Stop Timer", onClick: () => a.stop(t.id) },
      ],
    });
  }
  for (const w of s.stopwatches) {
    const paused = w.pausedAt !== null;
    const elapsed = withCountdown ? ` — ${formatClock(stopwatchElapsed(w, now), false)}` : "";
    rows.push({
      title: `${w.name || "Stopwatch"}${elapsed}`,
      subtitle: paused ? "Paused" : "Running",
      icon: "⏱️",
      submenu: [
        { title: paused ? "Resume" : "Pause", onClick: () => a.stopwatchToggle(w.id) },
        sep,
        { title: "Remove Stopwatch", onClick: () => a.stopwatchRemove(w.id) },
      ],
    });
  }
  return rows;
}

/**
 * The countdown title comes from the timers feature (via the setTrayTitle shim) so its formatting
 * and "show in menu bar" setting stay the timers feature's call. Menu rows carry no ticking text,
 * so the native menu is rebuilt only when timers start/stop/pause, not every second.
 */
export function timersSpec(s: TimersInput, title: string, now: number, a: TimerActions): ExtraSpec | null {
  if (!s.settings.showInMenuBar) return null;
  if (!s.timers.length && !s.stopwatches.length) return null;
  return {
    title: title || "⏱",
    tooltip: "Glide Timers",
    menu: [
      ...timerRows(s, now, a, false),
      sep,
      { title: "Start Preset", submenu: s.presets.slice(0, 12).map((p) => ({ title: p.name, subtitle: formatClock(p.durationMs), onClick: () => a.startPreset(p.id) })) },
      { title: "Show Timers…", onClick: a.show },
    ],
  };
}

// --- System monitor ------------------------------------------------------------------------------

export interface SysmonInput {
  cpu: number; // 0..1
  cores: number;
  load: [number, number, number];
  memory?: MemoryInfo;
}

const pct = (x: number) => `${Math.round(Math.min(1, Math.max(0, x)) * 100)}%`;

export function sysmonTitle(cpu: number, memory?: MemoryInfo): string {
  const parts = [`CPU ${pct(cpu)}`];
  if (memory && memory.totalBytes > 0) parts.push(`MEM ${pct(memory.usedBytes / memory.totalBytes)}`);
  return parts.join(" · ");
}

export function sysmonSpec(s: SysmonInput, open: () => void): ExtraSpec {
  const mem = s.memory;
  return {
    title: sysmonTitle(s.cpu, mem),
    tooltip: "Glide System Monitor",
    menu: [
      info(`CPU ${pct(s.cpu)}`, `${s.cores} cores`),
      info(`Load ${s.load.map((l) => l.toFixed(2)).join("  ")}`),
      ...(mem ? [info(`Memory ${pct(mem.usedBytes / mem.totalBytes)}`, `${formatBytes(mem.usedBytes)} of ${formatBytes(mem.totalBytes)} used`)] : []),
      sep,
      { title: "Open System Monitor…", onClick: open },
    ],
  };
}

// --- Next meeting --------------------------------------------------------------------------------

export interface MeetingActions {
  join(url: string): void;
  openCalendar(iso: string): void;
  schedule(): void;
  requestAccess(): void;
  refresh(): void;
}

const isToday = (iso: string, now: number) => new Date(iso).toDateString() === new Date(now).toDateString();

export function todaysEvents(events: ScheduleEvent[], now: number): ScheduleEvent[] {
  return events.filter((e) => isToday(e.start, now) || (Date.parse(e.start) <= now && Date.parse(e.end) > now));
}

/** The ongoing or next timed event that has not ended yet (today only). */
export function nextEvent(events: ScheduleEvent[], now: number): ScheduleEvent | undefined {
  return todaysEvents(events, now)
    .filter((e) => !e.allDay && Date.parse(e.end) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
}

/** "now", "in 5m", "in 1h 20m". */
export function untilLabel(startMs: number, now: number): string {
  const mins = Math.ceil((startMs - now) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

export function meetingTitle(events: ScheduleEvent[], now: number): string {
  const e = nextEvent(events, now);
  if (!e) return "";
  return `${truncate(e.title || "Event", 18)} ${untilLabel(Date.parse(e.start), now)}`;
}

export function meetingSpec(r: ScheduleResult | undefined, now: number, a: MeetingActions): ExtraSpec {
  const footer: MenuBarMenuItem[] = [sep, { title: "Open My Schedule…", onClick: a.schedule }, { title: "Refresh", onClick: a.refresh }];
  if (!r) return { title: "", icon: "📅", tooltip: "Next Meeting", menu: [info("Loading calendar…"), ...footer] };
  if (r.status !== "ok") {
    const fix: MenuBarMenuItem[] = r.status === "notDetermined" ? [{ title: "Grant Calendar Access…", onClick: a.requestAccess }] : [];
    return { title: "", icon: "📅", tooltip: "Next Meeting", menu: [info(r.message ?? "Calendar unavailable"), ...fix, ...footer] };
  }
  const today = todaysEvents(r.events, now);
  const next = nextEvent(r.events, now);
  const rows: MenuBarMenuItem[] = today.map((e) => {
    const when = e.allDay ? "All day" : clockTime(Date.parse(e.start));
    const ended = !e.allDay && Date.parse(e.end) <= now;
    const link = e.meeting;
    return {
      title: `${when}  ${truncate(e.title || "Event", 40)}`,
      subtitle: link ? `Join ${link.provider}` : (e.location ? truncate(e.location, 40) : e.calendar),
      ...(link ? { icon: "📹" } : {}),
      ...(ended ? { enabled: false } : {}),
      onClick: link ? () => a.join(link.url) : () => a.openCalendar(e.start),
    };
  });
  const head: MenuBarMenuItem[] = next?.meeting ? [{ title: `Join “${truncate(next.title, 30)}”`, subtitle: next.meeting.provider, icon: "📹", shortcut: "CommandOrControl+J", onClick: () => a.join(next.meeting!.url) }, sep] : [];
  return {
    title: meetingTitle(r.events, now),
    icon: "📅",
    tooltip: next ? `${next.title} · ${clockTime(Date.parse(next.start))}` : "No more events today",
    menu: [...head, info("Today"), ...(rows.length ? rows : [info("No events today")]), ...footer],
  };
}

// --- Clipboard -----------------------------------------------------------------------------------

const CLIP_ICONS: Record<string, string> = { text: "📝", image: "🖼️", link: "🔗", color: "🎨", file: "📁" };

export function clipboardSpec(entries: Pick<ClipSummary, "id" | "type" | "title" | "pinned">[], paste: (id: string) => void, open: () => void): ExtraSpec {
  const rows: MenuBarMenuItem[] = entries.slice(0, 10).map((e, i) => ({
    title: truncate(e.title || "(empty)", 48),
    icon: e.pinned ? "📌" : (CLIP_ICONS[e.type] ?? "📝"),
    shortcut: `CommandOrControl+${(i + 1) % 10}`,
    onClick: () => paste(e.id),
  }));
  return {
    title: "",
    icon: "📋",
    tooltip: "Glide Clipboard",
    menu: [info("Paste from History"), ...(rows.length ? rows : [info("Nothing copied yet")]), sep, { title: "Open Clipboard History…", onClick: open }],
  };
}

// --- Agent ---------------------------------------------------------------------------------------

export const AGENT_SUGGESTIONS = ["Arrange my windows side by side", "Start a 25 minute focus timer", "Summarize what’s on my clipboard"];

export interface AgentActions {
  ask(prompt?: string): void;
  cancel(runId: string): void;
}

export function agentSpec(run: Pick<RunSnapshot, "runId" | "prompt" | "status"> | null, a: AgentActions): ExtraSpec {
  const busy = !!run && (run.status === "running" || run.status === "confirming");
  const status: MenuBarMenuItem[] = busy
    ? [
        info(run!.status === "confirming" ? "Waiting for your approval" : "Working…", truncate(run!.prompt, 48)),
        { title: run!.status === "confirming" ? "Review…" : "Show Run…", onClick: () => a.ask() },
        { title: "Cancel Run", onClick: () => a.cancel(run!.runId) },
        sep,
      ]
    : [];
  return {
    title: busy ? "…" : "",
    icon: "🪄",
    tooltip: "Glide Agent",
    menu: [...status, { title: "Ask Glide Agent…", onClick: () => a.ask() }, { title: "Try", submenu: AGENT_SUGGESTIONS.map((p) => ({ title: p, onClick: () => a.ask(p) })) }],
  };
}
