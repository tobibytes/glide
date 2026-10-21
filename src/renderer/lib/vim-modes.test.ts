import { describe, expect, it } from "vitest";
import { INITIAL_VIM_STATE, modeAfter, vimKey, type VimContextInput, type VimMode } from "./vim";
import { initialChoiceIndex, loadTabChoice, type TabChoice } from "../screens/launcher/tabChoice";

/** Drive the launcher's model: vimKey for the command, modeAfter for the mode, push/pop for the stack. */
function simulate(keys: string[], start: { mode?: VimMode; depth?: number; query?: string } = {}) {
  let mode: VimMode = start.mode ?? "insert";
  let depth = start.depth ?? 0;
  let query = start.query ?? "";
  let state = INITIAL_VIM_STATE;
  const trace: string[] = [];
  for (const key of keys) {
    const ctx: VimContextInput = { enabled: true, mode, queryEmpty: !query, viewPushed: depth > 0, now: 1000 };
    const r = vimKey(state, { key }, ctx);
    state = r.state;
    const c = r.command;
    if (c?.type === "pop") {
      depth = Math.max(0, depth - 1);
      mode = modeAfter(mode, { type: "pop" });
    } else if (c) mode = modeAfter(mode, { type: "command", command: c });
    else if (mode === "insert" && key.length === 1) query += key;
    trace.push(`${key}:${c?.type ?? "-"}:${mode}:${depth}`);
  }
  return { mode, depth, query, trace };
}

describe("vim mode transitions", () => {
  it("Esc in a pushed view → NORMAL, h pops back to INSERT (field typeable)", () => {
    const r = simulate(["Escape", "h"], { depth: 1 });
    expect(r.depth).toBe(0);
    expect(r.mode).toBe("insert");
  });
  it("Backspace in NORMAL pops and lands in INSERT", () => {
    const r = simulate(["Escape", "Backspace"], { depth: 2 });
    expect(r.depth).toBe(1);
    expect(r.mode).toBe("insert");
  });
  it("Backspace on an empty view query in INSERT pops and stays INSERT", () => {
    const r = simulate(["Backspace"], { depth: 1 });
    expect(r).toMatchObject({ depth: 0, mode: "insert" });
  });
  it("after the pop, typing reaches the query", () => {
    const r = simulate(["Escape", "h", "s", "a"], { depth: 1 });
    expect(r.query).toBe("sa");
  });
  it("Esc with a root query enters NORMAL and i returns to INSERT", () => {
    expect(simulate(["Escape"], { query: "x" }).mode).toBe("normal");
    expect(simulate(["Escape", "i"], { query: "x" }).mode).toBe("insert");
    expect(simulate(["Escape", "/"], { query: "x" }).mode).toBe("insert");
  });
  it("NORMAL navigation keys keep NORMAL", () => {
    expect(simulate(["Escape", "j", "k", "G", "g", "g", "3", "j"], { query: "x" }).mode).toBe("normal");
  });
  it("push and show always land in INSERT", () => {
    expect(modeAfter("normal", { type: "push" })).toBe("insert");
    expect(modeAfter("normal", { type: "show" })).toBe("insert");
    expect(modeAfter("normal", { type: "needsInput" })).toBe("insert");
    expect(modeAfter("insert", { type: "command", command: { type: "normal" } })).toBe("normal");
  });
});

describe("Tab chooser choice", () => {
  const opts: TabChoice[] = [
    { id: "ai", title: "Ask AI" },
    { id: "agent", title: "Ask Glide Agent" },
    { id: "fallback", title: "Search Google" },
  ];
  it("preselects the remembered choice when offered, else the first", () => {
    expect(initialChoiceIndex(opts, "agent")).toBe(1);
    expect(initialChoiceIndex(opts, "fallback")).toBe(2);
    expect(initialChoiceIndex(opts.slice(0, 1), "agent")).toBe(0);
    expect(initialChoiceIndex(opts, null)).toBe(0);
  });
  it("loadTabChoice tolerates missing storage", () => {
    expect(loadTabChoice()).toBeNull();
  });
});
