import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAutomation, type Automation } from "./model";
import { debouncedSaver, FILE_NAME, loadAutomations, saveAutomations } from "./persist";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "glide-automations-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

const make = (id: string): Automation => {
  const r = validateAutomation({ id, name: id, trigger: { kind: "interval", minutes: 5 }, target: { kind: "workflow", workflowId: "w" }, log: [{ id: "r1", at: 1, trigger: "x", status: "ok", message: "m", durationMs: 3 }] }, 1);
  if (!r.ok) throw new Error(r.error);
  return r.automation;
};

describe("persistence", () => {
  it("round-trips through automations.json", () => {
    const dir = tmp();
    const list = [make("a"), make("b")];
    saveAutomations(dir, list);
    expect(fs.existsSync(path.join(dir, FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${FILE_NAME}.tmp`))).toBe(false);
    expect(loadAutomations(dir)).toEqual(list);
  });

  it("returns [] for a missing or corrupt file and drops invalid / duplicate entries", () => {
    const dir = tmp();
    expect(loadAutomations(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, FILE_NAME), "{not json");
    expect(loadAutomations(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify({ version: 1, automations: [make("a"), { id: "bad", trigger: { kind: "zzz" } }, make("a"), make("c")] }));
    expect(loadAutomations(dir).map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("debounces bursts into one write and flushes on demand", () => {
    vi.useFakeTimers();
    const writes: Automation[][] = [];
    const s = debouncedSaver((l) => writes.push(l), 300);
    s.schedule([make("a")]);
    s.schedule([make("a"), make("b")]);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(writes.map((w) => w.length)).toEqual([2]);
    s.schedule([]);
    s.flush();
    expect(writes.map((w) => w.length)).toEqual([2, 0]);
  });
});
