import { describe, expect, it } from "vitest";
import { describeLayout, layoutApps, layoutFromCapture, normalizeUrl, parseFile, serializeFile, type LayoutsFile } from "./model";

const display = { id: 1, uuid: "U", name: "Built-in", frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 33, width: 1512, height: 888 }, main: true };

describe("layout serialization", () => {
  it("round-trips a captured layout", () => {
    const layout = layoutFromCapture(
      "  Coding ",
      [display],
      [
        { ref: 1, bundleId: "com.apple.TextEdit", appName: "TextEdit", appPath: "/System/Applications/TextEdit.app", title: "a.txt", frame: { x: 10, y: 40, width: 500, height: 400 }, display: 0, order: 0 },
        { ref: 2, bundleId: null, appName: "Weird", appPath: null, title: "", frame: { x: 0, y: 0, width: 100, height: 100 }, display: 0, order: 0 },
        { ref: 3, bundleId: "com.apple.Safari", appName: "Safari", appPath: null, title: "full", frame: { x: 0, y: 0, width: 1512, height: 982 }, display: 0, order: 0, fullScreen: true },
      ],
      1000,
      "layout-1",
    );
    expect(layout.name).toBe("Coding");
    expect(layout.windows).toHaveLength(1);
    const file: LayoutsFile = { version: 1, layouts: [layout], workspaces: [] };
    expect(parseFile(serializeFile(file))).toEqual(file);
    expect(describeLayout(layout)).toBe("1 window · 1 app");
    expect(layoutApps(layout)).toEqual([{ name: "TextEdit", bundleId: "com.apple.TextEdit", path: "/System/Applications/TextEdit.app" }]);
  });

  it("drops invalid entries and repairs references", () => {
    const raw = JSON.stringify({
      version: 1,
      layouts: [
        { id: "l1", name: "Ok", createdAt: 1, displays: [display], windows: [{ bundleId: "x", title: "t", frame: { x: 0, y: 0, width: 10, height: 10 }, display: 7, order: 0 }, { bundleId: "", frame: {} }] },
        { id: "l2", name: "   " },
        "junk",
      ],
      workspaces: [
        { id: "w1", name: "Work", layoutId: "missing", launchApps: [{ bundleId: "a", name: "A" }, { bundleId: "a" }, { name: "no id" }], urls: ["github.com", "notaurl", "https://x.y", "~/Projects"], focus: { goal: "Ship", minutes: 25.4 }, shortcut: "  Work Focus " },
        { id: "w2" },
      ],
    });
    const f = parseFile(raw);
    expect(f.layouts.map((l) => l.id)).toEqual(["l1"]);
    expect(f.layouts[0]!.windows).toHaveLength(1);
    expect(f.layouts[0]!.windows[0]!.display).toBe(0);
    expect(f.layouts[0]!.updatedAt).toBe(1);
    const w = f.workspaces[0]!;
    expect(f.workspaces).toHaveLength(1);
    expect(w.layoutId).toBeNull();
    expect(w.launchApps).toEqual([{ bundleId: "a", name: "A", path: null }]);
    expect(w.urls).toEqual(["https://github.com", "https://x.y", "~/Projects"]);
    expect(w.focus).toEqual({ goal: "Ship", minutes: 25 });
    expect(w.shortcut).toBe("Work Focus");
    expect(w.quitApps).toEqual([]);
  });

  it("survives garbage", () => {
    expect(parseFile("not json")).toEqual({ version: 1, layouts: [], workspaces: [] });
    expect(parseFile("[]")).toEqual({ version: 1, layouts: [], workspaces: [] });
  });

  it("normalizes urls", () => {
    expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("raycast://extensions")).toBe("raycast://extensions");
    expect(normalizeUrl("hello world")).toBeNull();
  });
});
