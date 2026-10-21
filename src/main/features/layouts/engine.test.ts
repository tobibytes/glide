import { describe, expect, it, vi } from "vitest";
import type { HelperWindow } from "../../native/helper";
import { captureLayout, restoreLayout, type EngineDeps } from "./engine";
import type { Layout } from "./model";

const display = { id: 1, uuid: "U", name: "Built-in", frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 33, width: 1512, height: 888 }, main: true };
const win = (ref: number, bundleId: string, title: string, order = 0): HelperWindow => ({ ref, pid: 10, bundleId, appName: bundleId, appPath: null, title, frame: { x: 5, y: 40, width: 300, height: 300 }, display: 0, order, fullScreen: false });

function fakeDeps(captures: HelperWindow[][], opts: { running?: string[]; ax?: boolean } = {}) {
  let i = 0;
  let t = 0;
  const calls: Array<{ method: string; params: unknown }> = [];
  const launch = vi.fn(async () => undefined);
  const deps: EngineDeps = {
    helper: {
      available: () => true,
      call: (async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "layouts.capture") {
          if (opts.ax === false) return { ok: false, error: "Accessibility permission required" };
          const w = captures[Math.min(i++, captures.length - 1)]!;
          return { ok: true, displays: [display], windows: w };
        }
        if (method === "layouts.apps") return (opts.running ?? []).map((b) => ({ name: b, bundleId: b, pid: 1, path: null, hidden: false }));
        if (method === "layouts.move") {
          const moves = (params as { moves: Array<{ ref: number; frame: unknown }> }).moves;
          return { ok: true, results: moves.map((m) => ({ ref: m.ref, ok: true, frame: m.frame })) };
        }
        throw new Error(`unexpected ${method}`);
      }) as EngineDeps["helper"]["call"],
    },
    launch,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { deps, calls, launch };
}

const layout: Layout = {
  id: "l",
  name: "Test",
  createdAt: 0,
  updatedAt: 0,
  displays: [display],
  windows: [
    { bundleId: "com.apple.TextEdit", appName: "TextEdit", appPath: null, title: "a.txt", frame: { x: 100, y: 100, width: 500, height: 400 }, display: 0, order: 0 },
    { bundleId: "com.apple.Notes", appName: "Notes", appPath: null, title: "Notes", frame: { x: 700, y: 100, width: 600, height: 500 }, display: 0, order: 0 },
  ],
};

describe("engine", () => {
  it("captures a layout and rejects an empty one", async () => {
    const { deps } = fakeDeps([[win(1, "com.apple.TextEdit", "a.txt")], []]);
    const l = await captureLayout(deps, "Mine");
    expect(l.windows).toHaveLength(1);
    await expect(captureLayout(deps, "Empty")).rejects.toThrow(/No windows/);
  });

  it("explains missing Accessibility", async () => {
    const { deps } = fakeDeps([[]], { ax: false });
    const r = await restoreLayout(deps, layout, { relaunch: false, launchTimeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Accessibility/);
  });

  it("moves matched windows and reports the rest", async () => {
    const { deps, calls, launch } = fakeDeps([[win(7, "com.apple.TextEdit", "a.txt — Edited")]]);
    const r = await restoreLayout(deps, layout, { relaunch: false, launchTimeoutMs: 1000 });
    expect(launch).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, moved: 1, total: 2, unmatched: [{ appName: "Notes", title: "Notes" }] });
    const move = calls.find((c) => c.method === "layouts.move")!.params as { moves: unknown[] };
    expect(move.moves).toEqual([{ ref: 7, frame: { x: 100, y: 100, width: 500, height: 400 } }]);
  });

  it("relaunches missing apps and waits for their windows", async () => {
    const { deps, launch } = fakeDeps(
      [[win(1, "com.apple.TextEdit", "a.txt")], [win(2, "com.apple.TextEdit", "a.txt")], [win(3, "com.apple.TextEdit", "a.txt"), win(4, "com.apple.Notes", "Notes")]],
      { running: ["com.apple.TextEdit"] },
    );
    const r = await restoreLayout(deps, layout, { relaunch: true, launchTimeoutMs: 5000 });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(r.launched).toEqual(["Notes"]);
    expect(r.moved).toBe(2);
    expect(r.unmatched).toEqual([]);
  });

  it("gives up waiting after the timeout", async () => {
    const { deps } = fakeDeps([[]], { running: [] });
    const r = await restoreLayout(deps, layout, { relaunch: true, launchTimeoutMs: 1000 });
    expect(r.launched).toEqual(["TextEdit", "Notes"]);
    expect(r.moved).toBe(0);
    expect(r.unmatched).toHaveLength(2);
  });
});
