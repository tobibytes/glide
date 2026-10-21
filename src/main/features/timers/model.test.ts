import { describe, expect, it } from "vitest";
import {
  addTime, createStopwatch, createTimer, formatClock, formatDuration, formatStopwatch, lap, lapSplits, parseDuration, parseDurationAndName, parseTimerQuery,
  resetStopwatch, restartTimer, reviveTimers, soundCommand, stopwatchElapsed, timerDone, timerEndsAt, timerRemaining, toggleStopwatch, toggleTimer, trayTitleFor,
} from "./model";

const MIN = 60_000;

describe("duration parsing", () => {
  it("parses unit, compound, clock and bare forms", () => {
    expect(parseDuration("25m")).toBe(25 * MIN);
    expect(parseDuration("25 min")).toBe(25 * MIN);
    expect(parseDuration("1h30m")).toBe(90 * MIN);
    expect(parseDuration("1 h 30 min")).toBe(90 * MIN);
    expect(parseDuration("1 hour and 15 minutes")).toBe(75 * MIN);
    expect(parseDuration("1.5h")).toBe(90 * MIN);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("5:00")).toBe(5 * MIN);
    expect(parseDuration("1:30:00")).toBe(90 * MIN);
    expect(parseDuration("10")).toBe(10 * MIN);
    expect(parseDuration("tea")).toBeUndefined();
    expect(parseDuration("0m")).toBeUndefined();
    expect(parseDuration("10 mangoes")).toBeUndefined();
  });
  it("splits duration and name in either order", () => {
    expect(parseDurationAndName("10 min tea")).toEqual({ ms: 10 * MIN, name: "tea" });
    expect(parseDurationAndName("for 25m deep work")).toEqual({ ms: 25 * MIN, name: "deep work" });
    expect(parseDurationAndName("tea 3m")).toEqual({ ms: 3 * MIN, name: "tea" });
    expect(parseDurationAndName("pasta for 11 minutes")).toEqual({ ms: 11 * MIN, name: "pasta" });
    expect(parseDurationAndName("tea")).toBeUndefined();
  });
  it("recognises root-search timer phrases", () => {
    expect(parseTimerQuery("timer 25m")).toEqual({ ms: 25 * MIN, name: "" });
    expect(parseTimerQuery("Start Timer 25m")).toEqual({ ms: 25 * MIN, name: "" });
    expect(parseTimerQuery("timer 10 min tea")).toEqual({ ms: 10 * MIN, name: "tea" });
    expect(parseTimerQuery("set a timer for 5 minutes")).toEqual({ ms: 5 * MIN, name: "" });
    expect(parseTimerQuery("25m timer")).toEqual({ ms: 25 * MIN, name: "" });
    expect(parseTimerQuery("timer")).toBeUndefined();
    expect(parseTimerQuery("timers")).toBeUndefined();
    expect(parseTimerQuery("egg timer")).toBeUndefined();
  });
});

describe("timers", () => {
  it("counts down, pauses, resumes and extends", () => {
    let t = createTimer(0, 10 * MIN, " tea ");
    expect(t.name).toBe("tea");
    expect(timerRemaining(t, 4 * MIN)).toBe(6 * MIN);
    t = toggleTimer(t, 4 * MIN); // pause
    expect(timerRemaining(t, 100 * MIN)).toBe(6 * MIN);
    expect(timerEndsAt(t)).toBe(Infinity);
    expect(timerDone(t, 100 * MIN)).toBe(false);
    t = toggleTimer(t, 10 * MIN); // resume after 6 min paused
    expect(timerRemaining(t, 10 * MIN)).toBe(6 * MIN);
    expect(timerEndsAt(t)).toBe(16 * MIN);
    t = addTime(t, MIN);
    expect(timerEndsAt(t)).toBe(17 * MIN);
    expect(timerDone(t, 17 * MIN)).toBe(true);
    expect(timerRemaining(restartTimer(t, 20 * MIN), 20 * MIN)).toBe(11 * MIN);
  });
  it("revives persisted timers: running ones continue, finished ones are reported", () => {
    const a = createTimer(0, 5 * MIN, "a");
    const b = createTimer(0, 50 * MIN, "b");
    const c = toggleTimer(createTimer(0, 1 * MIN, "paused"), 30_000);
    const { running, finished } = reviveTimers([a, b, c], 10 * MIN);
    expect(running.map((t) => t.name)).toEqual(["b", "paused"]);
    expect(finished.map((t) => t.name)).toEqual(["a"]);
  });
  it("builds the menu-bar title from the soonest timer", () => {
    const a = createTimer(0, 25 * MIN, "a");
    const b = createTimer(0, 3 * MIN, "b");
    expect(trayTitleFor({ timers: [a, b], stopwatches: [] }, 0)).toBe("⏱ 3:00 +1");
    expect(trayTitleFor({ timers: [toggleTimer(a, 60_000)], stopwatches: [] }, 120_000)).toBe("⏱ 24:00 ❚❚");
    expect(trayTitleFor({ timers: [], stopwatches: [createStopwatch(0, "")] }, 65_000)).toBe("⏱ 1:05");
    expect(trayTitleFor({ timers: [], stopwatches: [] }, 0)).toBe("");
  });
});

describe("stopwatches", () => {
  it("records laps and splits, pauses and resets", () => {
    let s = createStopwatch(0, "run");
    s = lap(s, 10_000);
    s = lap(s, 25_000);
    expect(s.laps).toEqual([10_000, 25_000]);
    expect(lapSplits(s)).toEqual([10_000, 15_000]);
    s = toggleStopwatch(s, 30_000);
    expect(lap(s, 40_000)).toBe(s); // no laps while paused
    expect(stopwatchElapsed(s, 90_000)).toBe(30_000);
    s = toggleStopwatch(s, 90_000);
    expect(stopwatchElapsed(s, 100_000)).toBe(40_000);
    s = resetStopwatch(s, 100_000);
    expect(stopwatchElapsed(s, 101_000)).toBe(1000);
    expect(s.laps).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats clocks and durations", () => {
    expect(formatClock(25 * MIN)).toBe("25:00");
    expect(formatClock(24 * MIN + 59_001)).toBe("25:00"); // rounds up while counting down
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatStopwatch(62_345)).toBe("1:02.3");
    expect(formatDuration(90 * MIN)).toBe("1 h 30 min");
    expect(formatDuration(45_000)).toBe("45 s");
  });
  it("builds the sound command only for known system sounds", () => {
    expect(soundCommand("Glass")).toEqual({ cmd: "/usr/bin/afplay", args: ["/System/Library/Sounds/Glass.aiff"] });
    expect(soundCommand("none")).toBeUndefined();
    expect(soundCommand("../../etc/passwd")).toBeUndefined();
  });
});
