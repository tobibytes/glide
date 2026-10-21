import { describe, expect, it } from "vitest";
import { dayLabel, looksLikeCode, relativeTime } from "./format";

describe("clipboard format helpers", () => {
  it("labels days", () => {
    const now = new Date(2026, 9, 19, 15, 0).getTime();
    expect(dayLabel(new Date(2026, 9, 19, 1, 0).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 18, 23, 0).getTime(), now)).toBe("Yesterday");
  });
  it("relative time", () => {
    expect(relativeTime(1000, 1000)).toBe("now");
    expect(relativeTime(0, 5 * 60_000)).toBe("5m");
    expect(relativeTime(0, 3 * 3_600_000)).toBe("3h");
  });
  it("detects code", () => {
    expect(looksLikeCode('{\n  "a": 1\n}')).toBe(true);
    expect(looksLikeCode("function f() {\n  return 1;\n}")).toBe(true);
    expect(looksLikeCode("Hello there, this is a sentence.")).toBe(false);
    expect(looksLikeCode("Dear team,\nThanks for the update.\nBest")).toBe(false);
  });
});
