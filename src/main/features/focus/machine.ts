/** Focus session timer as a pure state machine plus stats and block-list matching. */
export type FocusStatus = "running" | "paused";

export interface FocusSession {
  id: string;
  goal: string;
  durationMs: number;
  startedAt: number;
  status: FocusStatus;
  /** focused time accumulated before the current running segment */
  accumulatedMs: number;
  /** start of the current running segment (null while paused) */
  segmentStartedAt: number | null;
  blockedApps: BlockedApp[];
  blockedSites: string[];
}

export interface BlockedApp {
  name: string;
  bundleId?: string;
  path?: string;
}

export interface FocusRecord {
  id: string;
  goal: string;
  startedAt: number;
  endedAt: number;
  focusedMs: number;
  plannedMs: number;
  completed: boolean;
}

export function startSession(now: number, opts: { goal: string; minutes: number; blockedApps?: BlockedApp[]; blockedSites?: string[] }): FocusSession {
  const minutes = Math.min(24 * 60, Math.max(1, Math.round(opts.minutes)));
  return {
    id: `focus-${now.toString(36)}`,
    goal: opts.goal.trim(),
    durationMs: minutes * 60_000,
    startedAt: now,
    status: "running",
    accumulatedMs: 0,
    segmentStartedAt: now,
    blockedApps: opts.blockedApps ?? [],
    blockedSites: (opts.blockedSites ?? []).map(normalizeSite).filter(Boolean),
  };
}

export function elapsed(s: FocusSession, now: number): number {
  return s.accumulatedMs + (s.status === "running" && s.segmentStartedAt !== null ? Math.max(0, now - s.segmentStartedAt) : 0);
}

export function remaining(s: FocusSession, now: number): number {
  return Math.max(0, s.durationMs - elapsed(s, now));
}

export function isComplete(s: FocusSession, now: number): boolean {
  return remaining(s, now) === 0;
}

export function pause(s: FocusSession, now: number): FocusSession {
  if (s.status !== "running") return s;
  return { ...s, status: "paused", accumulatedMs: Math.min(s.durationMs, elapsed(s, now)), segmentStartedAt: null };
}

export function resume(s: FocusSession, now: number): FocusSession {
  if (s.status !== "paused") return s;
  return { ...s, status: "running", segmentStartedAt: now };
}

export function togglePause(s: FocusSession, now: number): FocusSession {
  return s.status === "running" ? pause(s, now) : resume(s, now);
}

/** Add (or remove, with a negative value) minutes to the planned duration; never below what has elapsed + 1 min. */
export function extend(s: FocusSession, now: number, minutes: number): FocusSession {
  const floor = elapsed(s, now) + 60_000;
  return { ...s, durationMs: Math.max(floor, s.durationMs + minutes * 60_000) };
}

export function finish(s: FocusSession, now: number): FocusRecord {
  const focused = Math.min(s.durationMs, elapsed(s, now));
  return { id: s.id, goal: s.goal, startedAt: s.startedAt, endedAt: now, focusedMs: focused, plannedMs: s.durationMs, completed: focused >= s.durationMs };
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Week starts on Monday. */
const startOfWeek = (t: number) => {
  const d = new Date(startOfDay(t));
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getTime();
};

export interface FocusStats {
  todayMs: number;
  weekMs: number;
  sessionsToday: number;
  sessionsWeek: number;
  completedWeek: number;
  /** focused ms per day for the last 7 days, oldest first */
  last7: Array<{ day: number; ms: number }>;
}

export function computeStats(records: FocusRecord[], now: number, current?: FocusSession | null): FocusStats {
  const all = current ? [...records, finish(current, now)] : records;
  const today = startOfDay(now);
  const week = startOfWeek(now);
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (6 - i));
    return { day: d.getTime(), ms: 0 };
  });
  const stats: FocusStats = { todayMs: 0, weekMs: 0, sessionsToday: 0, sessionsWeek: 0, completedWeek: 0, last7 };
  for (const r of all) {
    const day = startOfDay(r.startedAt);
    if (day === today) {
      stats.todayMs += r.focusedMs;
      stats.sessionsToday++;
    }
    if (r.startedAt >= week) {
      stats.weekMs += r.focusedMs;
      stats.sessionsWeek++;
      if (r.completed) stats.completedWeek++;
    }
    const slot = last7.find((d) => d.day === day);
    if (slot) slot.ms += r.focusedMs;
  }
  return stats;
}

/** "https://www.YouTube.com/watch" → "youtube.com" */
export function normalizeSite(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : "";
}

/** True when `url`'s host is `site` or a subdomain of it. */
export function siteMatches(url: string, sites: string[]): string | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  return sites.find((s) => host === s || host.endsWith(`.${s}`)) ?? null;
}

export function appMatches(app: { name: string; bundleId: string | null }, blocked: BlockedApp[]): BlockedApp | null {
  return blocked.find((b) => (b.bundleId && app.bundleId ? b.bundleId === app.bundleId : b.name.toLowerCase() === app.name.toLowerCase())) ?? null;
}
