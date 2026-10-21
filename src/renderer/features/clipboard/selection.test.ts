import { describe, expect, it } from "vitest";
import { extendMark, gridColumns, gridMove, pruneMarks, toggleMark } from "./selection";

describe("grid navigation", () => {
  // 3 columns, 7 items: rows [0 1 2] [3 4 5] [6]
  it("moves within rows and columns", () => {
    expect(gridMove(0, 7, 3, "right")).toBe(1);
    expect(gridMove(0, 7, 3, "left")).toBe(0);
    expect(gridMove(1, 7, 3, "down")).toBe(4);
    expect(gridMove(4, 7, 3, "up")).toBe(1);
    expect(gridMove(1, 7, 3, "up")).toBe(1);
  });
  it("lands on the last cell of a partial last row", () => {
    expect(gridMove(5, 7, 3, "down")).toBe(6);
    expect(gridMove(6, 7, 3, "down")).toBe(6);
  });
  it("handles empty lists and column math", () => {
    expect(gridMove(0, 0, 3, "down")).toBe(-1);
    expect(gridColumns(470)).toBe(4);
    expect(gridColumns(50)).toBe(1);
  });
});

describe("marks", () => {
  it("toggles, extends and prunes", () => {
    const a = toggleMark(new Set(), "a");
    expect([...a]).toEqual(["a"]);
    expect(toggleMark(a, "a").size).toBe(0);
    expect([...extendMark(a, "a")]).toEqual(["a"]);
    const ab = extendMark(a, "b");
    expect([...pruneMarks(ab, ["b", "c"])]).toEqual(["b"]);
    expect(pruneMarks(ab, ["a", "b"])).toBe(ab);
  });
});
