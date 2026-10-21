import { describe, expect, it } from "vitest";
import { appMatches, computeStats, elapsed, extend, finish, formatClock, formatDuration, isComplete, normalizeSite, pause, remaining, resume, siteMatches, startSession, togglePause, type FocusRecord } from "./machine";

const MIN = 60_000;

describe("timer state machine", () => {
  const s0 = startSession(1_000, { goal: "  write  ", minutes: 25 });

  it("starts running with a trimmed goal and clamped duration", () => {
    expect(s0).toMatchObject({ status: "running", goal: "write", durationMs: 25 * MIN, accumulatedMs: 0, segmentStartedAt: 1_000 });
    expect(startSession(0, { goal: "", minutes: 0 }).durationMs).toBe(MIN);
    expect(startSession(0, { goal: "", minutes: 99999 }).durationMs).toBe(24 * 60 * MIN);
  });

  it("counts elapsed time only while running", () => {
    const t1 = 1_000 + 5 * MIN;
    const p = pause(s0, t1);
    expect(p.status).toBe("paused");
    expect(elapsed(p, t1 + 10 * MIN)).toBe(5 * MIN);
    const r = resume(p, t1 + 10 * MIN);
    expect(elapsed(r, t1 + 12 * MIN)).toBe(7 * MIN);
    expect(remaining(r, t1 + 12 * MIN)).toBe(18 * MIN);
  });

  it("ignores pause while paused and resume while running", () => {
    const p = pause(s0, 2_000);
    expect(pause(p, 9_000)).toBe(p);
    expect(resume(s0, 9_000)).toBe(s0);
    expect(togglePause(togglePause(s0, 2_000), 3_000).status).toBe("running");
  });

  it("completes when remaining hits zero and never goes negative", () => {
    expect(isComplete(s0, 1_000 + 25 * MIN)).toBe(true);
    expect(remaining(s0, 1_000 + 30 * MIN)).toBe(0);
    expect(isComplete(s0, 1_000 + 24 * MIN)).toBe(false);
  });

  it("extends and shrinks the duration but not below elapsed + 1 min", () => {
    expect(extend(s0, 1_000, 5).durationMs).toBe(30 * MIN);
    expect(extend(s0, 1_000 + 20 * MIN, -10).durationMs).toBe(21 * MIN);
  });

  it("finishes into a record capped at the planned duration", () => {
    expect(finish(s0, 1_000 + 10 * MIN)).toMatchObject({ focusedMs: 10 * MIN, plannedMs: 25 * MIN, completed: false, goal: "write" });
    expect(finish(s0, 1_000 + 40 * MIN)).toMatchObject({ focusedMs: 25 * MIN, completed: true });
  });
});

describe("formatting", () => {
  it("formats the clock", () => {
    expect(formatClock(25 * MIN)).toBe("25:00");
    expect(formatClock(61_500)).toBe("01:02");
    expect(formatClock(90 * MIN)).toBe("1:30:00");
    expect(formatClock(0)).toBe("00:00");
  });
  it("formats durations", () => {
    expect(formatDuration(25 * MIN)).toBe("25 min");
    expect(formatDuration(90 * MIN)).toBe("1 h 30 min");
    expect(formatDuration(120 * MIN)).toBe("2 h");
  });
});

describe("stats", () => {
  const now = new Date(2026, 9, 21, 15, 0).getTime(); // Wednesday
  const at = (dayOffset: number, h = 10) => new Date(2026, 9, 21 + dayOffset, h, 0).getTime();
  const rec = (start: number, min: number, completed = true): FocusRecord => ({ id: String(start), goal: "", startedAt: start, endedAt: start + min * MIN, focusedMs: min * MIN, plannedMs: min * MIN, completed });

  it("sums today and this week (Monday start) and fills last 7 days", () => {
    const records = [rec(at(0), 25), rec(at(0, 12), 50, false), rec(at(-2), 90), rec(at(-3), 25)];
    const s = computeStats(records, now);
    expect(s.todayMs).toBe(75 * MIN);
    expect(s.sessionsToday).toBe(2);
    expect(s.weekMs).toBe(165 * MIN); // Mon (-2) counts, Sun (-3) does not
    expect(s.sessionsWeek).toBe(3);
    expect(s.completedWeek).toBe(2);
    expect(s.last7).toHaveLength(7);
    expect(s.last7[6].ms).toBe(75 * MIN);
    expect(s.last7[3].ms).toBe(25 * MIN);
  });

  it("includes the running session", () => {
    const cur = startSession(now - 10 * MIN, { goal: "x", minutes: 25 });
    expect(computeStats([], now, cur).todayMs).toBe(10 * MIN);
  });
});

describe("block lists", () => {
  it("normalizes sites", () => {
    expect(normalizeSite("https://www.YouTube.com/watch?v=1")).toBe("youtube.com");
    expect(normalizeSite("news.ycombinator.com:443")).toBe("news.ycombinator.com");
    expect(normalizeSite("not a site")).toBe("");
  });
  it("matches hosts and subdomains", () => {
    expect(siteMatches("https://m.youtube.com/x", ["youtube.com"])).toBe("youtube.com");
    expect(siteMatches("https://notyoutube.com", ["youtube.com"])).toBeNull();
    expect(siteMatches("garbage", ["youtube.com"])).toBeNull();
  });
  it("matches apps by bundle id, else name", () => {
    const blocked = [{ name: "Slack", bundleId: "com.tinyspeck.slackmacgap" }, { name: "Mail" }];
    expect(appMatches({ name: "Slack", bundleId: "com.tinyspeck.slackmacgap" }, blocked)?.name).toBe("Slack");
    expect(appMatches({ name: "mail", bundleId: "com.apple.mail" }, blocked)?.name).toBe("Mail");
    expect(appMatches({ name: "Safari", bundleId: "com.apple.Safari" }, blocked)).toBeNull();
  });
});
