import { describe, expect, it, vi } from "vitest";
import { AutomationEngine, type EngineDeps } from "./engine";
import type { Automation } from "./model";

/** Fake clock + recording runner; persist captures what would hit disk. */
function setup(over: Partial<EngineDeps> = {}) {
  let now = new Date(2026, 9, 21, 8, 59, 0).getTime();
  const runs: Array<{ id: string; input: string }> = [];
  const saved: Automation[][] = [];
  const deps: EngineDeps = {
    now: () => now,
    run: vi.fn(async (a: Automation, input: string) => {
      runs.push({ id: a.id, input });
      return { ok: true, message: "done" };
    }),
    confirm: vi.fn(async () => true),
    persist: (list) => saved.push(list),
    home: "/Users/me",
    ...over,
  };
  const engine = new AutomationEngine(deps);
  return { engine, deps, runs, saved, advance: (ms: number) => (now += ms), now: () => now };
}

const wfTarget = { kind: "workflow", workflowId: "w1" } as const;

describe("scheduling", () => {
  it("time-of-day fires once at the minute, then waits for tomorrow", async () => {
    const { engine, runs, advance } = setup();
    const r = engine.upsert({ id: "t", name: "Morning", trigger: { kind: "time", time: "09:00", days: [] }, target: wfTarget });
    expect(r.ok).toBe(true);
    await engine.tick();
    expect(runs).toHaveLength(0);
    advance(59_000);
    await engine.tick();
    expect(runs).toHaveLength(0);
    advance(1_000); // 09:00:00
    await engine.tick();
    expect(runs).toEqual([{ id: "t", input: "" }]);
    advance(30_000);
    await engine.tick();
    expect(runs).toHaveLength(1);
    expect(engine.nextRun("t")).toBe(new Date(2026, 9, 22, 9, 0).getTime());
  });

  it("interval fires every N minutes from when it was created", async () => {
    const { engine, runs, advance } = setup();
    engine.upsert({ id: "i", trigger: { kind: "interval", minutes: 1 }, target: wfTarget });
    await engine.tick(); // schedules
    for (let s = 0; s < 185; s++) {
      advance(1000);
      await engine.tick();
    }
    expect(runs).toHaveLength(3);
  });

  it("skips slots missed while asleep instead of replaying them", async () => {
    const { engine, runs, advance } = setup();
    engine.upsert({ id: "t", trigger: { kind: "time", time: "09:00", days: [] }, target: wfTarget });
    await engine.tick();
    advance(3 * 3600_000); // woke at 11:59
    await engine.tick();
    expect(runs).toHaveLength(0);
    expect(engine.nextRun("t")).toBe(new Date(2026, 9, 22, 9, 0).getTime());
  });

  it("disabling stops scheduled runs; re-enabling restarts the interval from now", async () => {
    const { engine, runs, advance } = setup();
    engine.upsert({ id: "i", trigger: { kind: "interval", minutes: 1 }, target: wfTarget });
    await engine.tick();
    advance(60_000);
    await engine.tick();
    expect(runs).toHaveLength(1);
    engine.setEnabled("i", false);
    expect(engine.nextRun("i")).toBeNull();
    advance(5 * 60_000);
    await engine.tick();
    expect(runs).toHaveLength(1);
    engine.setEnabled("i", true);
    await engine.tick();
    expect(runs).toHaveLength(1);
    advance(60_000);
    await engine.tick();
    expect(runs).toHaveLength(2);
  });
});

describe("events", () => {
  it("passes the added file's path as input", async () => {
    const { engine, runs } = setup();
    engine.upsert({ id: "f", trigger: { kind: "folder", path: "~/Downloads", event: "added" }, target: wfTarget });
    await engine.handleEvent({ type: "folder", path: "/Users/me/Downloads", event: "added", file: "/Users/me/Downloads/x.zip" });
    expect(runs).toEqual([{ id: "f", input: "/Users/me/Downloads/x.zip" }]);
  });

  it("only matching, enabled automations fire", async () => {
    const { engine, runs } = setup();
    engine.upsert({ id: "a", trigger: { kind: "app", event: "launched", app: "Safari" }, target: wfTarget });
    engine.upsert({ id: "b", enabled: false, trigger: { kind: "app", event: "launched", app: "" }, target: wfTarget });
    engine.upsert({ id: "c", trigger: { kind: "app", event: "quit", app: "Safari" }, target: wfTarget });
    await engine.handleEvent({ type: "app", event: "launched", name: "Safari" });
    expect(runs.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("rate limiting", () => {
  it("drops triggers within 10 s of the previous one, per automation", async () => {
    const { engine, runs, advance } = setup();
    engine.upsert({ id: "a", trigger: { kind: "display", event: "any" }, target: wfTarget });
    engine.upsert({ id: "b", trigger: { kind: "display", event: "connected" }, target: wfTarget });
    const ev = { type: "display", event: "connected", name: "LG" } as const;
    expect((await engine.handleEvent(ev)).every((r) => typeof r === "object")).toBe(true);
    advance(5_000);
    expect(await engine.handleEvent(ev)).toEqual(["rate-limited", "rate-limited"]);
    advance(4_999);
    expect(await engine.handleEvent(ev)).toEqual(["rate-limited", "rate-limited"]);
    advance(1);
    await engine.handleEvent(ev);
    expect(runs).toHaveLength(4);
  });

  it("a self-retriggering loop runs at most once per 10 s", async () => {
    const { engine, runs, advance } = setup();
    engine.upsert({ id: "loop", trigger: { kind: "folder", path: "/tmp/x", event: "any" }, target: wfTarget });
    for (let i = 0; i < 100; i++) {
      await engine.handleEvent({ type: "folder", path: "/tmp/x", event: "changed", file: "/tmp/x" });
      advance(500);
    }
    expect(runs).toHaveLength(5); // 50 s of events
  });

  it("never overlaps a run that's still going, and Run Now bypasses the rate limit", async () => {
    let release: () => void = () => undefined;
    const { engine, advance } = setup({ run: () => new Promise((r) => (release = () => r({ ok: true, message: "ok" }))) });
    engine.upsert({ id: "a", trigger: { kind: "launch" }, target: wfTarget });
    const first = engine.handleEvent({ type: "launch" });
    advance(20_000);
    expect(await engine.handleEvent({ type: "launch" })).toEqual(["busy"]);
    expect(await engine.runNow("a")).toBe("busy");
    release();
    await first;
    const now = engine.runNow("a");
    release();
    expect(await now).toMatchObject({ status: "ok", manual: true, trigger: "Run Now" });
  });
});

describe("ask before running, logging", () => {
  it("records skipped runs when the user declines, and runs when confirmed", async () => {
    const answers = [false, true];
    const { engine, runs, advance } = setup({ confirm: vi.fn(async () => answers.shift() ?? false) });
    engine.upsert({ id: "a", askBeforeRunning: true, trigger: { kind: "launch" }, target: wfTarget });
    await engine.handleEvent({ type: "launch" });
    expect(runs).toHaveLength(0);
    expect(engine.get("a")!.log[0]).toMatchObject({ status: "skipped" });
    advance(10_000);
    await engine.handleEvent({ type: "launch" });
    expect(runs).toHaveLength(1);
    expect(engine.get("a")!.log.map((l) => l.status)).toEqual(["ok", "skipped"]);
  });

  it("Run Now doesn't ask", async () => {
    const confirm = vi.fn(async () => false);
    const { engine, runs } = setup({ confirm });
    engine.upsert({ id: "a", askBeforeRunning: true, trigger: { kind: "launch" }, target: wfTarget });
    await engine.runNow("a");
    expect(confirm).not.toHaveBeenCalled();
    expect(runs).toHaveLength(1);
  });

  it("logs failures (thrown or reported) and caps the log at 50, newest first", async () => {
    let n = 0;
    const { engine, advance } = setup({
      run: async () => {
        n++;
        if (n === 1) throw new Error("boom");
        return { ok: n % 2 === 0, message: `run ${n}` };
      },
    });
    engine.upsert({ id: "a", trigger: { kind: "launch" }, target: wfTarget });
    await engine.handleEvent({ type: "launch" });
    expect(engine.get("a")!.log[0]).toMatchObject({ status: "error", message: "boom" });
    for (let i = 0; i < 60; i++) {
      advance(10_000);
      await engine.handleEvent({ type: "launch" });
    }
    const log = engine.get("a")!.log;
    expect(log).toHaveLength(50);
    expect(log[0]!.message).toBe("run 61");
    expect(log[0]!.at).toBeGreaterThan(log[1]!.at);
  });

  it("editing keeps the log; persist sees every change", async () => {
    const { engine, saved } = setup();
    engine.upsert({ id: "a", name: "A", trigger: { kind: "launch" }, target: wfTarget });
    await engine.runNow("a");
    engine.upsert({ id: "a", name: "Renamed", trigger: { kind: "launch" }, target: wfTarget });
    expect(engine.get("a")).toMatchObject({ name: "Renamed" });
    expect(engine.get("a")!.log).toHaveLength(1);
    expect(saved.at(-1)![0]!.name).toBe("Renamed");
    expect(engine.remove("a")).toBe(true);
    expect(saved.at(-1)).toEqual([]);
  });
});
