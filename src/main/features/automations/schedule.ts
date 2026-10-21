/** Pure scheduling math for time-of-day and interval triggers (local time, DST-safe via Date fields). */
import type { Trigger } from "./model";

/** First moment strictly after `after` that matches HH:MM on one of `days` (empty = every day). */
export function nextTimeOfDay(time: string, days: number[], after: number): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const base = new Date(after);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0);
    if (d.getTime() <= after) continue;
    if (days.length && !days.includes(d.getDay())) continue;
    return d.getTime();
  }
  return Number.POSITIVE_INFINITY; // unreachable with valid input
}

/** Next fire time for a scheduled trigger, or null for event triggers. `since` is when scheduling (re)started. */
export function nextFire(trigger: Trigger, since: number): number | null {
  if (trigger.kind === "time") return nextTimeOfDay(trigger.time, trigger.days, since);
  if (trigger.kind === "interval") return since + trigger.minutes * 60_000;
  return null;
}

export type DueDecision = "wait" | "fire" | "missed";

/**
 * A scheduled time is "missed" (skipped, not fired) when we notice it more than `graceMs` late —
 * e.g. the Mac slept through it — so waking up never replays a burst of stale runs.
 */
export function dueDecision(nextAt: number, now: number, graceMs: number): DueDecision {
  if (now < nextAt) return "wait";
  return now - nextAt <= graceMs ? "fire" : "missed";
}
