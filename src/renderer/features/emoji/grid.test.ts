import { describe, expect, it } from "vitest";
import { keyToMove, layoutRows, move } from "./grid";

const rows = layoutRows(
  [
    { id: "a", title: "A", items: [1, 2, 3] },
    { id: "b", title: "B", items: [4, 5, 6, 7, 8, 9, 10] },
  ],
  4,
);

describe("layoutRows", () => {
  it("wraps sections into rows and marks section starts", () => {
    expect(rows.map((r) => r.items)).toEqual([[1, 2, 3], [4, 5, 6, 7], [8, 9, 10]]);
    expect(rows.map((r) => r.first)).toEqual([true, true, false]);
  });
});

describe("move", () => {
  it("moves horizontally across row boundaries", () => {
    expect(move(rows, { row: 0, col: 2 }, "right")).toEqual({ row: 1, col: 0 });
    expect(move(rows, { row: 1, col: 0 }, "left")).toEqual({ row: 0, col: 2 });
    expect(move(rows, { row: 0, col: 0 }, "left")).toEqual({ row: 0, col: 0 });
    expect(move(rows, { row: 2, col: 2 }, "right")).toEqual({ row: 2, col: 2 });
  });
  it("clamps the column on vertical moves into shorter rows", () => {
    expect(move(rows, { row: 1, col: 3 }, "up")).toEqual({ row: 0, col: 2 });
    expect(move(rows, { row: 1, col: 3 }, "down")).toEqual({ row: 2, col: 2 });
    expect(move(rows, { row: 2, col: 0 }, "down")).toEqual({ row: 2, col: 0 });
  });
  it("jumps between sections and to the ends", () => {
    expect(move(rows, { row: 0, col: 1 }, "nextSection")).toEqual({ row: 1, col: 0 });
    expect(move(rows, { row: 2, col: 1 }, "prevSection")).toEqual({ row: 1, col: 0 });
    expect(move(rows, { row: 1, col: 0 }, "prevSection")).toEqual({ row: 0, col: 0 });
    expect(move(rows, { row: 0, col: 0 }, "end")).toEqual({ row: 2, col: 2 });
    expect(move(rows, { row: 2, col: 2 }, "home")).toEqual({ row: 0, col: 0 });
  });
  it("handles an empty grid", () => {
    expect(move([], { row: 3, col: 3 }, "down")).toEqual({ row: 0, col: 0 });
  });
});

describe("keyToMove", () => {
  const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  it("always accepts arrows and Ctrl+H/J/K/L", () => {
    expect(keyToMove(ev("ArrowLeft"), false)).toBe("left");
    expect(keyToMove(ev("j", { ctrlKey: true }), false)).toBe("down");
    expect(keyToMove(ev("h", { ctrlKey: true }), false)).toBe("left");
  });
  it("accepts bare h/j/k/l only in normal mode", () => {
    expect(keyToMove(ev("l"), false)).toBeNull();
    expect(keyToMove(ev("l"), true)).toBe("right");
    expect(keyToMove(ev("G"), true)).toBe("end");
  });
});
