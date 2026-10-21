import { describe, expect, it } from "vitest";
import { findDisplay, mapFrame, matchWindows, missingApps, normalizeTitle, planRestore, titleSimilarity } from "./match";
import type { LiveWindow, SavedDisplay, SavedWindow } from "./model";

const main: SavedDisplay = { id: 1, uuid: "MAIN", name: "Built-in", frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 33, width: 1512, height: 888 }, main: true };
const ext: SavedDisplay = { id: 2, uuid: "EXT", name: "Studio Display", frame: { x: 1512, y: -200, width: 2560, height: 1440 }, visible: { x: 1512, y: -175, width: 2560, height: 1415 }, main: false };

const sw = (bundleId: string, title: string, order: number, x = 0, display = 0): SavedWindow => ({ bundleId, appName: bundleId, appPath: null, title, frame: { x, y: 40, width: 600, height: 400 }, display, order });
let ref = 1;
const lw = (bundleId: string, title: string, order: number, extra: Partial<LiveWindow> = {}): LiveWindow => ({ ref: ref++, bundleId, appName: bundleId, appPath: null, title, frame: { x: 10, y: 50, width: 300, height: 200 }, display: 0, order, ...extra });

describe("titles", () => {
  it("normalizes edited markers and bullets", () => {
    expect(normalizeTitle("Notes.txt — Edited")).toBe("notes.txt");
    expect(normalizeTitle("● main.ts - glide")).toBe("main.ts - glide");
    expect(normalizeTitle("  A   B ")).toBe("a b");
  });
  it("scores similarity", () => {
    expect(titleSimilarity("Report.docx", "Report.docx — Edited")).toBe(1);
    expect(titleSimilarity("Inbox", "Inbox (3 unread)")).toBe(0.8);
    expect(titleSimilarity("glide — main.ts", "glide — helper.ts")).toBeGreaterThan(0.3);
    expect(titleSimilarity("", "x")).toBe(0);
  });
});

describe("matchWindows", () => {
  it("matches by exact title regardless of order", () => {
    const saved = [sw("com.apple.TextEdit", "A.txt", 0), sw("com.apple.TextEdit", "B.txt", 1)];
    const live = [lw("com.apple.TextEdit", "B.txt", 0), lw("com.apple.TextEdit", "A.txt", 1)];
    const { pairs, unmatched } = matchWindows(saved, live);
    expect(unmatched).toEqual([]);
    expect(pairs.map((p) => [p.saved.title, p.live.title, p.how])).toEqual([
      ["A.txt", "A.txt", "title"],
      ["B.txt", "B.txt", "title"],
    ]);
  });
  it("falls back to similar titles, then order", () => {
    const saved = [sw("com.google.Chrome", "GitHub - Pull requests", 0), sw("com.google.Chrome", "Old tab", 1), sw("com.google.Chrome", "Gone", 2)];
    const live = [lw("com.google.Chrome", "Something else", 0), lw("com.google.Chrome", "GitHub - Pull requests (2)", 1)];
    const { pairs, unmatched } = matchWindows(saved, live);
    expect(pairs.map((p) => [p.saved.title, p.live.title, p.how])).toEqual([
      ["GitHub - Pull requests", "GitHub - Pull requests (2)", "similar"],
      ["Old tab", "Something else", "order"],
    ]);
    expect(unmatched.map((w) => w.title)).toEqual(["Gone"]);
  });
  it("never crosses apps and skips full-screen windows", () => {
    const saved = [sw("a", "x", 0), sw("b", "x", 0)];
    const live = [lw("a", "x", 0, { fullScreen: true }), lw("b", "y", 0)];
    const { pairs, unmatched } = matchWindows(saved, live);
    expect(pairs.map((p) => [p.saved.bundleId, p.live.bundleId, p.how])).toEqual([["b", "b", "order"]]);
    expect(unmatched.map((w) => w.bundleId)).toEqual(["a"]);
  });
  it("uses each live window once", () => {
    const saved = [sw("a", "same", 0), sw("a", "same", 1)];
    const live = [lw("a", "same", 0)];
    const { pairs, unmatched } = matchWindows(saved, live);
    expect(pairs).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
  });
});

describe("displays", () => {
  it("finds displays by uuid, then geometry, else main", () => {
    expect(findDisplay(ext, [main, { ...ext, id: 99 }])?.id).toBe(99);
    expect(findDisplay({ ...ext, uuid: "OTHER" }, [main, { ...ext, uuid: "NEW", id: 5 }])?.id).toBe(5);
    expect(findDisplay(ext, [main])?.id).toBe(1);
    expect(findDisplay(undefined, [ext, main])?.id).toBe(1);
  });
  it("keeps frames exactly on an unchanged display", () => {
    const f = { x: 1600, y: -100, width: 800, height: 600 };
    expect(mapFrame(f, ext, [main, ext])).toEqual(f);
  });
  it("scales a frame from a missing external display onto the main display", () => {
    // Right half of the external display's visible area → right half of the main visible area.
    const f = { x: 1512 + 1280, y: -175, width: 1280, height: 1415 };
    expect(mapFrame(f, ext, [main])).toEqual({ x: 756, y: 33, width: 756, height: 888 });
  });
  it("follows a display that moved to a new origin", () => {
    const moved = { ...ext, frame: { ...ext.frame, x: -2560, y: 0 }, visible: { ...ext.visible, x: -2560, y: 25 } };
    const f = { x: 1612, y: -75, width: 1000, height: 700 };
    expect(mapFrame(f, ext, [main, moved])).toEqual({ x: -2460, y: 125, width: 1000, height: 700 });
  });
  it("clamps oversized windows into the visible area", () => {
    const f = { x: -50, y: 0, width: 3000, height: 2000 };
    expect(mapFrame(f, main, [main])).toEqual({ x: 0, y: 33, width: 1512, height: 888 });
  });
});

describe("planRestore / missingApps", () => {
  it("plans moves with mapped frames", () => {
    const saved = { displays: [main, ext], windows: [sw("a", "doc", 0, 1600, 1)] };
    const live = [lw("a", "doc", 0)];
    const { moves } = planRestore(saved, live, [main]);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.ref).toBe(live[0]!.ref);
    expect(moves[0]!.frame.x).toBeGreaterThanOrEqual(0);
    expect(moves[0]!.frame.x + moves[0]!.frame.width).toBeLessThanOrEqual(1512);
  });
  it("reports apps that are not running or have no windows", () => {
    const saved = [sw("a", "1", 0), sw("b", "1", 0), sw("c", "1", 0), sw("a", "2", 1)];
    expect(missingApps(saved, [lw("a", "1", 0)], ["a", "b"])).toEqual(["b", "c"]);
  });
});
