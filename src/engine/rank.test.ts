import { describe, expect, it } from "vitest";
import type { SearchItem, UsageRecord } from "@shared/types";
import { createEngine } from "./index";
import { buildCandidate, compareRanked, computeFlags, evaluate, type Ranked } from "./rank";
import { prepareQuery } from "./fuzzy";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

const item = (id: string, title: string, extra: Partial<SearchItem> = {}): SearchItem => ({
  id,
  kind: "app",
  title,
  ...extra,
});

const usage = (itemId: string, launches: number[]): UsageRecord => ({
  itemId,
  launches,
  count: launches.length,
  lastLaunchedAt: Math.max(...launches),
});

function titles(items: SearchItem[], query: string, records: UsageRecord[] = [], now = T0): string[] {
  const engine = createEngine({ now: () => now });
  engine.setItems(items);
  engine.setUsage(records);
  const res = engine.search(query);
  return res.sections.find((s) => s.id === "results")?.items.map((i) => i.item.title) ?? [];
}

describe("rank — tiers", () => {
  it("an exact alias beats everything, even an exact title with high frecency", () => {
    const items = [item("code", "Code"), item("term", "Terminal", { alias: "code" })];
    const order = titles(items, "code", [usage("code", [T0 - 1000, T0 - 2000, T0 - 3000])]);
    expect(order).toEqual(["Terminal", "Code"]);
  });

  it("exact title beats prefix beats fuzzy", () => {
    const items = [item("x", "Xcode"), item("n", "Notes"), item("note", "Note"), item("sn", "Sticky Notes")];
    expect(titles(items, "note")).toEqual(["Note", "Notes", "Sticky Notes"]);
  });

  it("a whole-word hit floors just above a prefix run; a bare 8-point run is gated out at high sensitivity", () => {
    const items = [item("codex", "Codex"), item("vsc", "Visual Studio Code"), item("xcode", "Xcode")];
    // Codex: 4+2+2+2 = 10; Visual Studio Code: whole word → floor 10.5; Xcode: 2+2+2+2 = 8, not > 2·4
    expect(titles(items, "code")).toEqual(["Visual Studio Code", "Codex"]);
  });

  it("between equal match classes the higher frecency wins", () => {
    const items = [item("a", "Safari"), item("b", "Sabre")];
    expect(titles(items, "sa")).toEqual(["Sabre", "Safari"]); // collation tie-break
    expect(titles(items, "sa", [usage("a", [T0 - 1000])])).toEqual(["Safari", "Sabre"]);
  });

  it("frecency decays: an old launch loses to a fresh one", () => {
    const items = [item("a", "Safari"), item("b", "Sabre")];
    expect(titles(items, "sa", [usage("a", [T0 - 40 * DAY]), usage("b", [T0 - DAY])])).toEqual(["Sabre", "Safari"]);
  });

  it("kind priority breaks ties (app 5 > system 4 > quicklink 3 > setting 1)", () => {
    const items = [
      item("s", "Lock", { kind: "setting" }),
      item("q", "Lock", { kind: "quicklink" }),
      item("sys", "Lock", { kind: "system" }),
      item("app", "Lock", { kind: "app" }),
    ];
    const engine = createEngine({ now: () => T0 });
    engine.setItems(items);
    const kinds = engine.search("lock").sections[0].items.map((i) => i.item.kind);
    expect(kinds).toEqual(["app", "system", "quicklink", "setting"]);
  });

  it("keyword-only matches are eligible but sort last", () => {
    const items = [item("k", "Preview", { keywords: ["image", "pdf"] }), item("i", "Image Capture"), item("z", "Pixelmator")];
    expect(titles(items, "image")).toEqual(["Image Capture", "Preview"]);
    const engine = createEngine({ now: () => T0 });
    engine.setItems(items);
    const res = engine.search("pdf").sections[0].items;
    expect(res.map((i) => i.item.title)).toEqual(["Preview"]);
    expect(res[0].matchKind).toBe("keyword");
    expect(res[0].ranges).toEqual([]);
  });

  it("a keyword-only hit with high frecency still loses to a title match", () => {
    const items = [item("k", "Preview", { keywords: ["image"] }), item("i", "Image Capture")];
    expect(titles(items, "image", [usage("k", [T0 - 1000, T0 - 2000, T0 - 3000])])).toEqual(["Image Capture", "Preview"]);
  });

  it("hotkeys never affect order", () => {
    const items = [item("a", "Safari", { hotkey: "⌥⌘S" }), item("b", "Sabre")];
    expect(titles(items, "sa")).toEqual(["Sabre", "Safari"]);
    const swapped = [item("a", "Safari"), item("b", "Sabre", { hotkey: "⌥⌘S" })];
    expect(titles(swapped, "sa")).toEqual(["Sabre", "Safari"]);
  });

  it("alias prefix outranks a better fuzzy title score", () => {
    const items = [item("a", "Zed", { alias: "editor" }), item("b", "Edit Something")];
    expect(titles(items, "edi")).toEqual(["Zed", "Edit Something"]);
  });

  it("subtitle exact beats fuzzy title matches", () => {
    const items = [item("a", "Finder", { subtitle: "files" }), item("b", "Files Lite")];
    expect(titles(items, "files")).toEqual(["Finder", "Files Lite"]);
  });

  it("sensitivity high filters weak scattered matches", () => {
    const items = [item("a", "xaxbxcx"), item("b", "abc")];
    expect(titles(items, "abc")).toEqual(["abc"]);
  });

  it("stored search term exact lifts an item above a prefix title match", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("a", "Slack"), item("b", "Slides Pro")]);
    engine.recordUsage("b", "sl");
    const order = engine.search("sl").sections[0].items.map((i) => i.item.title);
    expect(order).toEqual(["Slides Pro", "Slack"]);
  });

  it("stored search terms expire after 17 days", () => {
    let now = T0;
    const engine = createEngine({ now: () => now });
    engine.setItems([item("a", "Slack"), item("b", "Slides Pro")]);
    engine.recordUsage("b", "sl");
    now = T0 + 18 * DAY;
    // frecency still > 1 (≈ 101 · 2^(−1.8) ≈ 29) but the window has passed; frecency tie-break keeps b first
    expect(engine.search("sl").sections[0].items.map((i) => i.item.title)).toEqual(["Slides Pro", "Slack"]);
    // with equal frecency the term is no longer decisive: the prefix score (Slack=4+2 vs Slides=4+2) ties → collation
    engine.recordUsage("a");
    engine.recordUsage("a");
    expect(engine.search("sl").sections[0].items.map((i) => i.item.title)).toEqual(["Slack", "Slides Pro"]);
  });

  it("aliases from configure() override item.alias", () => {
    const engine = createEngine({ now: () => T0, aliases: { b: "code" } });
    engine.setItems([item("a", "Code"), item("b", "Terminal", { alias: "zz" })]);
    expect(engine.search("code").sections[0].items[0].item.title).toBe("Terminal");
    engine.configure({ aliases: {} });
    expect(engine.search("code").sections[0].items[0].item.title).toBe("Code");
  });
});

describe("rank — evaluate / compareRanked primitives", () => {
  const ctx = { sensitivity: "high" as const, frecency: 1, searchTerms: [] as string[] };

  it("evaluate returns null for non-matching candidates", () => {
    expect(evaluate(buildCandidate(item("a", "Safari")), prepareQuery("zzz"), ctx)).toBeNull();
  });

  it("prefix title matches bypass the sensitivity gate", () => {
    const r = evaluate(buildCandidate(item("a", "Safari")), prepareQuery("s"), ctx)!;
    expect(r.ranking.titleMatch).toBe("prefix");
  });

  it("compareRanked orders by max(title, subtitle) then frecency then title score", () => {
    const q = prepareQuery("vsc");
    const a = evaluate(buildCandidate(item("a", "Visual Studio Code")), q, ctx) as Ranked;
    const b = evaluate(buildCandidate(item("b", "Vscode", { subtitle: "Visual Studio Code" })), q, ctx) as Ranked;
    const flags = computeFlags([a, b], 3);
    // b: title prefix run 4+2+2 = 8 and subtitle 8 → tie on T11; tie on frecency; title score tie → priority tie → collation
    expect(Math.sign(compareRanked(flags, a, b))).toBe(Math.sign("Visual Studio Code".localeCompare("Vscode")));
    const c = { ...a, frecency: 50 };
    expect(compareRanked(flags, c, b)).toBeLessThan(0);
  });
});

describe("rank — presentation", () => {
  it("exposes matchKind, matchScore, ranges and a strictly decreasing score", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("a", "Visual Studio Code"), item("b", "Vsc"), item("c", "Vscope"), item("d", "Term", { alias: "vsc" })]);
    const res = engine.search("vsc").sections[0].items;
    // prefix run (4+2+2) and acronym (4+3+3−2) both score 8 → collation decides ("Visual…" < "Vscope")
    expect(res.map((i) => i.matchKind)).toEqual(["alias", "exact", "acronym", "prefix"]);
    expect(res[3].ranges).toEqual([{ start: 0, end: 3 }]);
    expect(res[2].ranges).toEqual([
      { start: 0, end: 1 },
      { start: 7, end: 8 },
      { start: 14, end: 15 },
    ]);
    expect(res[2].matchScore).toBe(8);
    expect(res[3].matchScore).toBe(8);
    for (let i = 1; i < res.length; i++) expect(res[i].score).toBeLessThan(res[i - 1].score);
  });
});
