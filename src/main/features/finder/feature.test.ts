import { beforeEach, describe, expect, it, vi } from "vitest";

const written: string[] = [];
vi.mock("electron", () => ({ clipboard: { writeText: (t: string) => void written.push(t) }, shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() } }));
vi.mock("../../headless", () => ({ HEADLESS: true }));
const execMock = vi.fn();
vi.mock("../../util/exec", () => ({ exec: (...a: unknown[]) => execMock(...a) }));

import type { FinderSelectionResult, HelperMethods, NativeHelper } from "../../native/helper";
import type { FeatureContext } from "../types";
import { feature } from "./index";

function ctxWith(sel: FinderSelectionResult, automation: FinderSelectionResult | null, store: Record<string, unknown>, calls: string[]): FeatureContext {
  const helper: NativeHelper = {
    available: () => true,
    call: ((m: keyof HelperMethods) => {
      calls.push(m);
      if (m === "finder.selection") return Promise.resolve(sel);
      if (m === "finder.selectionViaAutomation" && automation) return Promise.resolve(automation);
      return Promise.reject(new Error(`helper method ${m} is disabled in headless mode`));
    }) as NativeHelper["call"],
    on: () => () => undefined,
    dispose: () => undefined,
  };
  return {
    id: "finder",
    helper,
    settings: <T extends Record<string, unknown>>(d: T) => ({ ...d, ...store }) as T,
    setSettings: (p: Record<string, unknown>) => Object.assign(store, p),
    log: () => undefined,
  } as unknown as FeatureContext;
}

const item = (command: string) => ({ item: { id: `finder:${command}`, kind: "command" as const, title: command, feature: "finder", data: { command } }, score: 0, matchScore: 0, matchKind: "none" as const, frecency: 0, ranges: [] });

describe("finder feature", () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
    written.length = 0;
    execMock.mockReset();
  });

  it("copies selected paths in the configured format", async () => {
    feature.start?.(ctxWith({ paths: ["/Users/x/a.txt", "/Users/x/b c.txt"], folder: "/Users/x" }, null, { pathFormat: "quoted" }, calls));
    const r = await feature.runAction!(item("copyPath"), "run");
    expect(r).toMatchObject({ ok: true, message: "Copied 2 paths" });
    expect(written).toEqual([`/Users/x/a.txt '/Users/x/b c.txt'`]);
  });

  it("does not ask Finder over Apple Events unless the user opted in", async () => {
    feature.start?.(ctxWith({ paths: [], folder: null, error: "Accessibility permission is required to read Finder's selection" }, { paths: ["/a"], folder: "/" }, {}, calls));
    const r = await feature.runAction!(item("compress"), "run");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Accessibility/);
    expect(calls).toEqual(["finder.selection"]);

    calls.length = 0;
    feature.start?.(ctxWith({ paths: [], folder: null }, { paths: ["/a"], folder: "/" }, { automation: true }, calls));
    await feature.runAction!(item("copyPath"), "run");
    expect(calls).toEqual(["finder.selection", "finder.selectionViaAutomation"]);
    expect(written).toEqual(["/a"]);
  });

  it("records instead of running commands in headless mode", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    feature.start?.(ctxWith({ paths: [], folder: "/Users/x/Projects" }, null, { terminal: "Ghostty" }, calls));
    expect(await feature.runAction!(item("terminal"), "run")).toMatchObject({ ok: true, hide: true });
    expect(await feature.runAction!(item("terminal"), "terminal:iTerm")).toMatchObject({ ok: true });
    expect(execMock).not.toHaveBeenCalled();
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[headless] finder.exec") && l.includes("--working-directory=/Users/x/Projects"))).toBe(true);
    expect(lines.some((l) => l.includes('"iTerm"'))).toBe(true);
    log.mockRestore();
  });

  it("opens the follow-up views with the captured selection", async () => {
    feature.start?.(ctxWith({ paths: ["/Users/x/a.txt"], folder: "/Users/x" }, null, {}, calls));
    expect(await feature.runAction!(item("move"), "run")).toEqual({ ok: true, view: { id: "finder.move", props: { paths: ["/Users/x/a.txt"], folder: "/Users/x" } } });
    expect(await feature.runAction!(item("openWith"), "run")).toEqual({ ok: true, view: { id: "finder.openWith", props: { paths: ["/Users/x/a.txt"] } } });
    expect((await feature.runAction!(item("newFile"), "run")).view).toEqual({ id: "finder.newFile", props: { folder: "/Users/x" } });
  });
});
