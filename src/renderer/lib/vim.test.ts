import { describe, expect, it } from "vitest";
import { applyNav, findActionOfKind, GG_WINDOW_MS, INITIAL_VIM_STATE, vimKey, vimPanelKey, type VimContextInput, type VimKey, type VimState } from "./vim";

const ctx = (over: Partial<VimContextInput> = {}): VimContextInput => ({ enabled: true, mode: "normal", queryEmpty: true, viewPushed: false, now: 1000, ...over });
const press = (key: string, c: Partial<VimContextInput> = {}, mods: Partial<VimKey> = {}, state: VimState = INITIAL_VIM_STATE) => vimKey(state, { key, ...mods }, ctx(c));
const seq = (keys: Array<string | [string, number]>, c: Partial<VimContextInput> = {}) => {
  let state = INITIAL_VIM_STATE;
  let last = null as ReturnType<typeof vimKey> | null;
  for (const k of keys) {
    const [key, now] = typeof k === "string" ? [k, 1000] : k;
    last = vimKey(state, { key, shift: /^[A-Z{}]$/.test(key) }, ctx({ ...c, now }));
    state = last.state;
  }
  return last!;
};

describe("insert mode", () => {
  const ins = { mode: "insert" as const };
  it("arrows and ctrl alternates move", () => {
    expect(press("ArrowDown", ins).command).toEqual({ type: "move", delta: 1 });
    expect(press("ArrowUp", ins).command).toEqual({ type: "move", delta: -1 });
    for (const k of ["j", "n"]) expect(press(k, ins, { ctrl: true }).command).toEqual({ type: "move", delta: 1 });
    for (const k of ["k", "p"]) expect(press(k, ins, { ctrl: true }).command).toEqual({ type: "move", delta: -1 });
  });
  it("ctrl+d / ctrl+u half page, alt arrows page, cmd arrows section", () => {
    expect(press("d", ins, { ctrl: true }).command).toEqual({ type: "halfPage", dir: 1, count: 1 });
    expect(press("u", ins, { ctrl: true }).command).toEqual({ type: "halfPage", dir: -1, count: 1 });
    expect(press("ArrowDown", ins, { alt: true }).command).toEqual({ type: "move", delta: 5 });
    expect(press("ArrowUp", ins, { meta: true }).command).toEqual({ type: "section", dir: -1, count: 1 });
  });
  it("plain letters type (not consumed, no command)", () => {
    for (const k of ["j", "k", "g", "G", "x", "q", "/"]) {
      const r = press(k, ins);
      expect(r.command).toBeNull();
      expect(r.consumed).toBe(false);
    }
  });
  it("enter, cmd+enter, cmd+k", () => {
    expect(press("Enter", ins).command).toEqual({ type: "activate", mods: { cmd: false, shift: false, alt: false } });
    expect(press("Enter", ins, { shift: true }).command).toEqual({ type: "activate", mods: { cmd: false, shift: true, alt: false } });
    expect(press("Enter", ins, { meta: true }).command).toEqual({ type: "secondary" });
    expect(press("k", ins, { meta: true }).command).toEqual({ type: "actions" });
  });
  it("Esc with vim on: normal when query or view, else hide", () => {
    expect(press("Escape", { ...ins, queryEmpty: false }).command).toEqual({ type: "normal" });
    expect(press("Escape", { ...ins, viewPushed: true }).command).toEqual({ type: "normal" });
    expect(press("Escape", ins).command).toEqual({ type: "hide" });
  });
  it("Esc with vim off: clear, then pop, then hide", () => {
    const off = { ...ins, enabled: false };
    expect(press("Escape", { ...off, queryEmpty: false, viewPushed: true }).command).toEqual({ type: "clearQuery" });
    expect(press("Escape", { ...off, viewPushed: true }).command).toEqual({ type: "pop" });
    expect(press("Escape", off).command).toEqual({ type: "hide" });
  });
  it("vim off ignores normal mode state entirely", () => {
    expect(press("j", { enabled: false, mode: "normal" }).command).toBeNull();
  });
  it("Backspace on empty query pops a pushed view only", () => {
    expect(press("Backspace", { ...ins, viewPushed: true }).command).toEqual({ type: "pop" });
    expect(press("Backspace", { ...ins, viewPushed: true, queryEmpty: false }).command).toBeNull();
    expect(press("Backspace", ins).command).toBeNull();
  });
});

describe("normal mode", () => {
  it("j / k / arrows", () => {
    expect(press("j").command).toEqual({ type: "move", delta: 1 });
    expect(press("k").command).toEqual({ type: "move", delta: -1 });
    expect(press("ArrowDown").command).toEqual({ type: "move", delta: 1 });
    expect(press("j", {}, { ctrl: true }).command).toEqual({ type: "move", delta: 1 });
  });
  it("counts multiply motions", () => {
    expect(seq(["5", "j"]).command).toEqual({ type: "move", delta: 5 });
    expect(seq(["1", "2", "k"]).command).toEqual({ type: "move", delta: -12 });
    expect(seq(["3", "}"]).command).toEqual({ type: "section", dir: 1, count: 3 });
    expect(seq(["2", "d"].map((k) => k)).command).toBeNull(); // plain d is not a command
  });
  it("count prefix is consumed and kept in state", () => {
    const r = press("4");
    expect(r.consumed).toBe(true);
    expect(r.command).toBeNull();
    expect(r.state.count).toBe("4");
    expect(press("0").state.count).toBe(""); // leading 0 is not a count
    expect(seq(["1", "0", "j"]).command).toEqual({ type: "move", delta: 10 });
  });
  it("count resets after a command", () => {
    const r = seq(["5", "j"]);
    expect(r.state).toEqual(INITIAL_VIM_STATE);
  });
  it("ctrl+d / ctrl+u with count", () => {
    expect(seq(["2"]).state.count).toBe("2");
    const s = seq(["2"]).state;
    expect(vimKey(s, { key: "d", ctrl: true }, ctx()).command).toEqual({ type: "halfPage", dir: 1, count: 2 });
    expect(press("u", {}, { ctrl: true }).command).toEqual({ type: "halfPage", dir: -1, count: 1 });
  });
  it("gg within 500 ms goes to top", () => {
    expect(seq([["g", 1000], ["g", 1000 + GG_WINDOW_MS]]).command).toEqual({ type: "goto", index: 0 });
  });
  it("gg slower than 500 ms does not", () => {
    const r = seq([["g", 1000], ["g", 1000 + GG_WINDOW_MS + 1]]);
    expect(r.command).toBeNull();
    expect(r.state.gAt).toBe(1000 + GG_WINDOW_MS + 1); // second g starts a new window
    expect(seq([["g", 1000], ["g", 1601], ["g", 1700]]).command).toEqual({ type: "goto", index: 0 });
  });
  it("g followed by another key cancels the pending g", () => {
    expect(seq(["g", "j", "g"]).command).toBeNull();
  });
  it("G bottom, counted G/gg go to a row", () => {
    expect(seq(["G"]).command).toEqual({ type: "goto", index: "last" });
    expect(seq(["3", "G"]).command).toEqual({ type: "goto", index: 2 });
    expect(seq(["4", "g", "g"]).command).toEqual({ type: "goto", index: 3 });
  });
  it("shift alone does not cancel a pending count", () => {
    const s = press("5").state;
    expect(vimKey(s, { key: "Shift", shift: true }, ctx()).state.count).toBe("5");
  });
  it("sections", () => {
    expect(seq(["}"]).command).toEqual({ type: "section", dir: 1, count: 1 });
    expect(seq(["{"]).command).toEqual({ type: "section", dir: -1, count: 1 });
  });
  it("primary / secondary", () => {
    const primary = { type: "activate", mods: { cmd: false, shift: false, alt: false } };
    expect(press("l").command).toEqual(primary);
    expect(press("o").command).toEqual(primary);
    expect(press("Enter").command).toEqual(primary);
    expect(press("O", {}, { shift: true }).command).toEqual({ type: "secondary" });
    expect(press("Enter", {}, { meta: true }).command).toEqual({ type: "secondary" });
  });
  it("h / Backspace pop a view or clear the root query", () => {
    expect(press("h", { viewPushed: true }).command).toEqual({ type: "pop" });
    expect(press("Backspace", { viewPushed: true }).command).toEqual({ type: "pop" });
    expect(press("h").command).toEqual({ type: "clearQuery" });
    expect(press("Backspace", { queryEmpty: false }).command).toEqual({ type: "clearQuery" });
  });
  it("x / y / p", () => {
    expect(press("x").command).toEqual({ type: "delete" });
    expect(press("y").command).toEqual({ type: "copy" });
    expect(press("p").command).toEqual({ type: "paste" });
  });
  it("i / a keep the query, / clears it", () => {
    expect(press("i").command).toEqual({ type: "insert", clear: false });
    expect(press("a").command).toEqual({ type: "insert", clear: false });
    expect(press("/").command).toEqual({ type: "insert", clear: true });
  });
  it(". and ⌘K open the action panel", () => {
    expect(press(".").command).toEqual({ type: "actions" });
    expect(press("k", {}, { meta: true }).command).toEqual({ type: "actions" });
  });
  it("q and Esc hide", () => {
    expect(press("q").command).toEqual({ type: "hide" });
    expect(press("Escape", { queryEmpty: false, viewPushed: true }).command).toEqual({ type: "hide" });
  });
  it("other printable keys are swallowed; cmd shortcuts pass through", () => {
    const z = press("z");
    expect(z.command).toBeNull();
    expect(z.consumed).toBe(true);
    const c = press("c", {}, { meta: true });
    expect(c.consumed).toBe(false);
    expect(press("Tab").consumed).toBe(false);
  });
});

describe("action panel keys", () => {
  it("maps j/k/l/h", () => {
    expect(vimPanelKey({ key: "j" })).toEqual({ type: "move", delta: 1 });
    expect(vimPanelKey({ key: "k" })).toEqual({ type: "move", delta: -1 });
    expect(vimPanelKey({ key: "l" })).toEqual({ type: "run" });
    expect(vimPanelKey({ key: "Enter" })).toEqual({ type: "run" });
    expect(vimPanelKey({ key: "h" })).toEqual({ type: "close" });
    expect(vimPanelKey({ key: "Escape" })).toEqual({ type: "close" });
    expect(vimPanelKey({ key: "k", meta: true })).toEqual({ type: "close" });
    expect(vimPanelKey({ key: "/" })).toEqual({ type: "filter" });
    expect(vimPanelKey({ key: "z" })).toBeNull();
  });
});

describe("applyNav", () => {
  const sections = ["a", "a", "a", "b", "b", "c"];
  const shape = { length: 6, sections, halfPage: 2 };
  it("moves and clamps", () => {
    expect(applyNav({ type: "move", delta: 1 }, 0, shape)).toBe(1);
    expect(applyNav({ type: "move", delta: 10 }, 0, shape)).toBe(5);
    expect(applyNav({ type: "move", delta: -3 }, 1, shape)).toBe(0);
    expect(applyNav({ type: "move", delta: 1 }, 0, { length: 0 })).toBe(-1);
  });
  it("goto", () => {
    expect(applyNav({ type: "goto", index: "last" }, 0, shape)).toBe(5);
    expect(applyNav({ type: "goto", index: 0 }, 4, shape)).toBe(0);
    expect(applyNav({ type: "goto", index: 99 }, 0, shape)).toBe(5);
  });
  it("half page", () => {
    expect(applyNav({ type: "halfPage", dir: 1, count: 1 }, 0, shape)).toBe(2);
    expect(applyNav({ type: "halfPage", dir: -1, count: 2 }, 5, shape)).toBe(1);
  });
  it("sections", () => {
    expect(applyNav({ type: "section", dir: 1, count: 1 }, 0, shape)).toBe(3);
    expect(applyNav({ type: "section", dir: 1, count: 2 }, 0, shape)).toBe(5);
    expect(applyNav({ type: "section", dir: 1, count: 1 }, 5, shape)).toBe(5);
    expect(applyNav({ type: "section", dir: -1, count: 1 }, 4, shape)).toBe(3); // top of own section first
    expect(applyNav({ type: "section", dir: -1, count: 1 }, 3, shape)).toBe(0);
    expect(applyNav({ type: "section", dir: -1, count: 1 }, 0, shape)).toBe(0);
    expect(applyNav({ type: "section", dir: 1, count: 1 }, 0, { length: 4 })).toBe(3); // no sections: bottom
  });
});

describe("findActionOfKind", () => {
  const actions = [{ title: "Open" }, { title: "Copy Path" }, { title: "Paste to App" }, { title: "Remove from History" }, { title: "Delete All", destructive: true }];
  it("classifies", () => {
    expect(findActionOfKind(actions, "copy")?.title).toBe("Copy Path");
    expect(findActionOfKind(actions, "paste")?.title).toBe("Paste to App");
    expect(findActionOfKind(actions, "delete")?.title).toBe("Delete All");
    expect(findActionOfKind([{ title: "Remove" }], "delete")?.title).toBe("Remove");
    expect(findActionOfKind([{ title: "Open" }], "copy")).toBeUndefined();
  });
});
