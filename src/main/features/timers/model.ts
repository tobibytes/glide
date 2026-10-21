/** Timers & stopwatches as plain data + pure functions (absolute timestamps, so they survive restarts). */

export interface Timer {
  id: string;
  name: string;
  durationMs: number;
  startedAt: number;
  /** Set while paused. */
  pausedAt: number | null;
  /** Total time spent paused before the current pause. */
  pausedMs: number;
}

export interface Stopwatch {
  id: string;
  name: string;
  startedAt: number;
  pausedAt: number | null;
  pausedMs: number;
  /** Elapsed ms at each lap press. */
  laps: number[];
}

export interface Preset {
  id: string;
  name: string;
  durationMs: number;
}

export interface TimersData {
  timers: Timer[];
  stopwatches: Stopwatch[];
  presets: Preset[];
}

const MIN = 60_000;
export const DEFAULT_PRESETS: Preset[] = [
  { id: "pomodoro", name: "Pomodoro", durationMs: 25 * MIN },
  { id: "short-break", name: "Short Break", durationMs: 5 * MIN },
  { id: "long-break", name: "Long Break", durationMs: 15 * MIN },
  { id: "tea", name: "Tea", durationMs: 3 * MIN },
  { id: "coffee", name: "French Press", durationMs: 4 * MIN },
  { id: "egg", name: "Soft-Boiled Egg", durationMs: 6 * MIN },
  { id: "nap", name: "Power Nap", durationMs: 20 * MIN },
  { id: "hour", name: "1 Hour", durationMs: 60 * MIN },
];

export const MAX_DURATION_MS = 7 * 24 * 60 * MIN;

let seq = 0;
export const newId = (prefix: string, now: number) => `${prefix}-${now.toString(36)}-${(seq++).toString(36)}`;

// --- timers -----------------------------------------------------------------

export function createTimer(now: number, durationMs: number, name: string): Timer {
  return { id: newId("t", now), name: name.trim(), durationMs, startedAt: now, pausedAt: null, pausedMs: 0 };
}

export function timerElapsed(t: Timer, now: number): number {
  return Math.max(0, (t.pausedAt ?? now) - t.startedAt - t.pausedMs);
}

export function timerRemaining(t: Timer, now: number): number {
  return Math.max(0, t.durationMs - timerElapsed(t, now));
}

export function timerDone(t: Timer, now: number): boolean {
  return t.pausedAt === null && timerRemaining(t, now) <= 0;
}

/** When the timer ends (unix ms); Infinity while paused. */
export function timerEndsAt(t: Timer): number {
  return t.pausedAt === null ? t.startedAt + t.pausedMs + t.durationMs : Infinity;
}

export function pauseTimer(t: Timer, now: number): Timer {
  return t.pausedAt === null ? { ...t, pausedAt: now } : t;
}

export function resumeTimer(t: Timer, now: number): Timer {
  return t.pausedAt === null ? t : { ...t, pausedAt: null, pausedMs: t.pausedMs + (now - t.pausedAt) };
}

export function toggleTimer(t: Timer, now: number): Timer {
  return t.pausedAt === null ? pauseTimer(t, now) : resumeTimer(t, now);
}

export function addTime(t: Timer, ms: number): Timer {
  return { ...t, durationMs: Math.min(MAX_DURATION_MS, Math.max(1000, t.durationMs + ms)) };
}

export function restartTimer(t: Timer, now: number): Timer {
  return { ...t, startedAt: now, pausedAt: null, pausedMs: 0 };
}

// --- stopwatches --------------------------------------------------------------

export function createStopwatch(now: number, name: string): Stopwatch {
  return { id: newId("s", now), name: name.trim(), startedAt: now, pausedAt: null, pausedMs: 0, laps: [] };
}

export function stopwatchElapsed(s: Stopwatch, now: number): number {
  return Math.max(0, (s.pausedAt ?? now) - s.startedAt - s.pausedMs);
}

export function lap(s: Stopwatch, now: number): Stopwatch {
  return s.pausedAt === null ? { ...s, laps: [...s.laps, stopwatchElapsed(s, now)] } : s;
}

export function toggleStopwatch(s: Stopwatch, now: number): Stopwatch {
  return s.pausedAt === null ? { ...s, pausedAt: now } : { ...s, pausedAt: null, pausedMs: s.pausedMs + (now - s.pausedAt) };
}

export function resetStopwatch(s: Stopwatch, now: number): Stopwatch {
  return { ...s, startedAt: now, pausedAt: s.pausedAt === null ? null : now, pausedMs: 0, laps: [] };
}

/** Split times between laps: [lap1, lap2 - lap1, …]. */
export function lapSplits(s: Stopwatch): number[] {
  return s.laps.map((t, i) => t - (i ? s.laps[i - 1]! : 0));
}

// --- parsing & formatting --------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
};
const UNIT = "(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)";
const TERM = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${UNIT}(?![a-z])\s*(?:and\s+|,\s*)?`, "iy");

/**
 * Duration at the start of `text`: "25m", "1h30m", "1 h 30 min", "1.5h", "5:00", "1:30:00", "25" (minutes).
 * Returns the duration and how many characters were consumed.
 */
function leadingDuration(text: string): { ms: number; length: number } | undefined {
  const clock = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?=\s|$)/.exec(text);
  if (clock) {
    const ms = clock[3] !== undefined
      ? Number(clock[1]) * 3_600_000 + Number(clock[2]) * MIN + Number(clock[3]) * 1000
      : Number(clock[1]) * MIN + Number(clock[2]) * 1000;
    return { ms, length: clock[0].length };
  }
  let ms = 0;
  let pos = 0;
  TERM.lastIndex = 0;
  for (;;) {
    TERM.lastIndex = pos;
    const m = TERM.exec(text);
    if (!m) break;
    ms += Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!;
    pos = TERM.lastIndex;
  }
  if (pos > 0) return { ms: Math.round(ms), length: pos };
  const bare = /^(\d+(?:\.\d+)?)(?=\s|$)/.exec(text);
  return bare ? { ms: Math.round(Number(bare[1]) * MIN), length: bare[0].length } : undefined;
}

export function parseDuration(text: string): number | undefined {
  const t = text.trim();
  const d = leadingDuration(t);
  return d && d.length >= t.length && d.ms > 0 && d.ms <= MAX_DURATION_MS ? d.ms : undefined;
}

/** "10 min tea" / "tea 10 min" / "for 25m" → duration + optional name. */
export function parseDurationAndName(text: string): { ms: number; name: string } | undefined {
  const t = text.trim().replace(/^for\s+/i, "");
  if (!t) return undefined;
  const lead = leadingDuration(t);
  if (lead && lead.ms > 0 && lead.ms <= MAX_DURATION_MS) {
    const rest = t.slice(lead.length).trim().replace(/^(?:for|called|named|-|–|:)\s*/i, "");
    return { ms: lead.ms, name: rest };
  }
  // Duration at the end: "tea 3m"
  const m = new RegExp(String.raw`^(.+?)\s+((?:\d+(?:\.\d+)?\s*${UNIT}(?![a-z])\s*)+)$`, "i").exec(t);
  if (m) {
    const ms = parseDuration(m[2]!);
    if (ms) return { ms, name: m[1]!.trim().replace(/\s+for$/i, "") };
  }
  return undefined;
}

/** Root-search timer phrases: "timer 25m", "start timer 10 min tea", "25m timer", "set a timer for 5 minutes". */
export function parseTimerQuery(query: string): { ms: number; name: string } | undefined {
  const q = query.trim().replace(/\s+/g, " ");
  let m = /^(?:start |set |new )?(?:an? )?timer(?: for)? (.+)$/i.exec(q);
  if (m) return parseDurationAndName(m[1]!);
  m = /^(.+?) timer(?: (.+))?$/i.exec(q);
  if (m) {
    const ms = parseDuration(m[1]!);
    if (ms) return { ms, name: (m[2] ?? "").trim() };
  }
  return undefined;
}

/** "4:32", "1:04:32" (rounded up so a fresh 25 min timer shows 25:00). */
export function formatClock(ms: number, roundUp = true): string {
  const total = roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Stopwatch style with tenths: "1:02.3". */
export function formatStopwatch(ms: number): string {
  return `${formatClock(ms, false)}.${Math.floor((ms % 1000) / 100)}`;
}

/** "25 min", "1 h 30 min", "45 s", "1 min 30 s". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s || !parts.length) parts.push(`${s} s`);
  return parts.join(" ");
}

export function timerLabel(t: Pick<Timer, "name" | "durationMs">): string {
  return t.name || `${formatDuration(t.durationMs)} Timer`;
}

/** Menu-bar title: the soonest running timer, plus a count of the others. */
export function trayTitleFor(data: Pick<TimersData, "timers" | "stopwatches">, now: number): string {
  const running = data.timers.filter((t) => t.pausedAt === null).sort((a, b) => timerEndsAt(a) - timerEndsAt(b));
  const next = running[0] ?? data.timers[0];
  if (next) {
    const more = data.timers.length > 1 ? ` +${data.timers.length - 1}` : "";
    return `⏱ ${formatClock(timerRemaining(next, now))}${next.pausedAt !== null ? " ❚❚" : ""}${more}`;
  }
  const sw = data.stopwatches.find((s) => s.pausedAt === null);
  return sw ? `⏱ ${formatClock(stopwatchElapsed(sw, now), false)}` : "";
}

/** Split loaded JSON into still-running timers and ones that finished while Glide was closed. */
export function reviveTimers(timers: Timer[], now: number): { running: Timer[]; finished: Timer[] } {
  const running: Timer[] = [];
  const finished: Timer[] = [];
  for (const t of timers) (timerDone(t, now) ? finished : running).push(t);
  return { running, finished };
}

export function isTimer(v: unknown): v is Timer {
  const t = v as Timer;
  return !!t && typeof t.id === "string" && typeof t.durationMs === "number" && typeof t.startedAt === "number" && typeof t.pausedMs === "number";
}

export function isStopwatch(v: unknown): v is Stopwatch {
  const s = v as Stopwatch;
  return !!s && typeof s.id === "string" && typeof s.startedAt === "number" && Array.isArray(s.laps);
}

export function isPreset(v: unknown): v is Preset {
  const p = v as Preset;
  return !!p && typeof p.id === "string" && typeof p.name === "string" && typeof p.durationMs === "number" && p.durationMs > 0;
}

/** Sound played when a timer finishes: macOS system sounds via afplay (no permission needed). */
export const SOUNDS = ["Glass", "Ping", "Hero", "Submarine", "Funk", "Purr", "Sosumi", "Tink", "Blow", "Bottle", "Frog", "Morse", "Pop", "Basso"] as const;
export function soundCommand(sound: string): { cmd: string; args: string[] } | undefined {
  if (!(SOUNDS as readonly string[]).includes(sound)) return undefined;
  return { cmd: "/usr/bin/afplay", args: [`/System/Library/Sounds/${sound}.aiff`] };
}
