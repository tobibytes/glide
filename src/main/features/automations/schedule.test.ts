import { describe, expect, it } from "vitest";
import { dueDecision, nextFire, nextTimeOfDay } from "./schedule";

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe("nextTimeOfDay", () => {
  it("returns later today when the time hasn't passed", () => {
    expect(nextTimeOfDay("09:00", [], at(2026, 10, 21, 8, 30))).toBe(at(2026, 10, 21, 9, 0));
  });
  it("rolls to tomorrow once the minute has passed (strictly after)", () => {
    expect(nextTimeOfDay("09:00", [], at(2026, 10, 21, 9, 0))).toBe(at(2026, 10, 22, 9, 0));
    expect(nextTimeOfDay("09:00", [], at(2026, 10, 21, 17, 0))).toBe(at(2026, 10, 22, 9, 0));
  });
  it("honours days of week (2026-10-23 is a Friday)", () => {
    expect(new Date(at(2026, 10, 23)).getDay()).toBe(5);
    // Weekdays only: Friday evening → Monday morning.
    expect(nextTimeOfDay("07:15", [1, 2, 3, 4, 5], at(2026, 10, 23, 20, 0))).toBe(at(2026, 10, 26, 7, 15));
    // Sunday only.
    expect(nextTimeOfDay("12:00", [0], at(2026, 10, 21, 12, 0))).toBe(at(2026, 10, 25, 12, 0));
  });
});

describe("nextFire", () => {
  it("interval: since + minutes", () => {
    expect(nextFire({ kind: "interval", minutes: 5 }, 1_000)).toBe(1_000 + 300_000);
  });
  it("event triggers are not scheduled", () => {
    expect(nextFire({ kind: "launch" }, 0)).toBeNull();
    expect(nextFire({ kind: "app", event: "launched", app: "" }, 0)).toBeNull();
  });
});

describe("dueDecision", () => {
  it("waits, fires within grace, and skips stale slots", () => {
    expect(dueDecision(1000, 999, 100)).toBe("wait");
    expect(dueDecision(1000, 1000, 100)).toBe("fire");
    expect(dueDecision(1000, 1100, 100)).toBe("fire");
    expect(dueDecision(1000, 1101, 100)).toBe("missed");
  });
});
