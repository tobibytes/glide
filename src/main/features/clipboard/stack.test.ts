import { describe, expect, it } from "vitest";
import { addToStack, clearStack, moveInStack, normalizeStack, pushStack, removeFromStack, setStackOrder, startStack, takeNext } from "./stack";

describe("paste stack", () => {
  it("FIFO pastes in copy order and stops after N copies", () => {
    let s = startStack("fifo", 3);
    for (const id of ["a", "b", "c", "d"]) s = pushStack(s, id);
    expect(s.items).toEqual(["a", "b", "c"]);
    expect(s.collecting).toBe(false);
    const r1 = takeNext(s);
    expect(r1.id).toBe("a");
    const r2 = takeNext(r1.stack);
    expect(r2.id).toBe("b");
    expect(r2.stack.items).toEqual(["c"]);
  });
  it("LIFO pastes the last copy first", () => {
    let s = startStack("lifo");
    for (const id of ["a", "b", "c"]) s = pushStack(s, id);
    expect(s.collecting).toBe(true);
    expect(takeNext(s).id).toBe("c");
  });
  it("re-copy moves an item instead of duplicating it", () => {
    let s = startStack("fifo");
    for (const id of ["a", "b", "a"]) s = pushStack(s, id);
    expect(s.items).toEqual(["b", "a"]);
  });
  it("skips deleted entries and returns null when empty", () => {
    const s = { ...startStack("fifo"), items: ["gone", "b"] };
    expect(takeNext(s, (id) => id !== "gone")).toEqual({ id: "b", stack: { ...s, items: [] } });
    expect(takeNext({ ...s, items: [] }).id).toBeNull();
  });
  it("ignores copies when not collecting but allows manual adds", () => {
    const s = clearStack(startStack("fifo"));
    expect(pushStack(s, "a").items).toEqual([]);
    expect(addToStack(s, "a").items).toEqual(["a"]);
  });
  it("reorders, removes and switches order", () => {
    const s = { ...startStack("fifo"), items: ["a", "b", "c"] };
    expect(moveInStack(s, "c", -1).items).toEqual(["a", "c", "b"]);
    expect(moveInStack(s, "a", -1).items).toEqual(["a", "b", "c"]);
    expect(moveInStack(s, "a", 1).items).toEqual(["b", "a", "c"]);
    expect(removeFromStack(s, "b").items).toEqual(["a", "c"]);
    const l = setStackOrder(s, "lifo");
    expect(l.items).toEqual(["c", "b", "a"]);
    expect(pushStack(l, "d").items[0]).toBe("d");
  });
  it("normalizes persisted state", () => {
    expect(normalizeStack({ collecting: true, limit: -2, items: ["a", 3], order: "x" })).toEqual({ collecting: true, limit: 0, collected: 0, order: "fifo", items: ["a"] });
    expect(normalizeStack(null).items).toEqual([]);
  });
});
