import { describe, expect, it } from "vitest";
import type { ScoredItem, SearchItem, UsageRecord } from "@shared/types";
import { createEngine } from "./index";

const T0 = 1_700_000_000_000;

const item = (id: string, title: string, extra: Partial<SearchItem> = {}): SearchItem => ({ id, kind: "app", title, ...extra });
const usage = (itemId: string, launches: number[]): UsageRecord => ({
  itemId,
  launches,
  count: launches.length,
  lastLaunchedAt: Math.max(...launches),
});
const dyn = (it: SearchItem, score: number, matchKind: ScoredItem["matchKind"]): ScoredItem => ({
  item: it,
  score,
  matchScore: score,
  matchKind,
  frecency: 0,
  ranges: [],
});

describe("sections — empty query", () => {
  it("a fresh install with no usage or favorites still shows the user's workflows", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([
      item("app", "Safari"),
      item("w1", "Morning Setup", { kind: "workflow" }),
      item("w2", "Quick Note", { kind: "workflow" }),
    ]);
    const res = engine.search("");
    expect(res.sections.map((s) => s.id)).toEqual(["workflows"]);
    expect(res.sections[0].items.map((i) => i.item.title).sort()).toEqual(["Morning Setup", "Quick Note"]);
  });

  it("does not repeat a workflow that already appears under Suggestions", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("w1", "Morning Setup", { kind: "workflow" }), item("w2", "Quick Note", { kind: "workflow" })]);
    engine.setUsage([usage("w1", [T0 - 1000])]);
    const res = engine.search("");
    expect(res.sections.map((s) => s.id)).toEqual(["suggestions", "workflows"]);
    expect(res.sections[1].items.map((i) => i.item.id)).toEqual(["w2"]);
  });

  it("favorites (in favorite order) then suggestions by frecency, excluding favorites and hotkey items", () => {
    const engine = createEngine({ now: () => T0, favorites: new Set(["c", "a"]) });
    engine.setItems([
      item("a", "Alpha"),
      item("b", "Beta"),
      item("c", "Gamma"),
      item("d", "Delta"),
      item("h", "Hot", { hotkey: "⌘H" }),
      item("f", "Fallback", { kind: "fallback" }),
    ]);
    engine.setUsage([
      usage("a", [T0 - 1000]),
      usage("b", [T0 - 1000]),
      usage("d", [T0 - 1000, T0 - 2000]),
      usage("h", [T0 - 500, T0 - 600, T0 - 700]),
      usage("f", [T0 - 500, T0 - 600, T0 - 700]),
    ]);
    const res = engine.search("");
    expect(res.sections.map((s) => s.id)).toEqual(["favorites", "suggestions"]);
    expect(res.sections[0].items.map((i) => i.item.id)).toEqual(["c", "a"]);
    expect(res.sections[1].items.map((i) => i.item.id)).toEqual(["d", "b"]);
    expect(res.sections[1].items[0].frecency).toBeGreaterThan(res.sections[1].items[1].frecency);
  });

  it("never-used items are not suggested; whitespace-only queries count as empty", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("a", "Alpha")]);
    expect(engine.search("   ").sections).toEqual([]);
  });

  it("honours sectionLimit for suggestions", () => {
    const engine = createEngine({ now: () => T0, sectionLimit: 2 });
    engine.setItems([item("a", "A"), item("b", "B"), item("c", "C")]);
    engine.setUsage([usage("a", [T0 - 1]), usage("b", [T0 - 2]), usage("c", [T0 - 3])]);
    expect(engine.search("").sections[0].items).toHaveLength(2);
    engine.configure({ sectionLimit: 3 });
    expect(engine.search("").sections[0].items).toHaveLength(3);
  });
});

describe("sections — searching", () => {
  it('argument extraction: "g electron" → quicklink "Google" with argument "electron", pinned first', () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([
      item("g", "Google", { kind: "quicklink", alias: "g", acceptsArgument: true, url: "https://google.com/search?q={query}" }),
      item("gh", "GitHub", { kind: "quicklink", acceptsArgument: true }),
      item("ge", "Gelectron Thing"),
    ]);
    const res = engine.search("g electron");
    const results = res.sections.find((s) => s.id === "results")!;
    expect(results.items[0].item.id).toBe("g");
    expect(results.items[0].argument).toBe("electron");
    expect(results.items[0].matchKind).toBe("alias");
    expect(results.items.slice(1).every((i) => i.argument === undefined)).toBe(true);
  });

  it("argument extraction also accepts a title prefix and prefers exact alias", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([
      item("w", "Translate", { kind: "workflow", acceptsArgument: true }),
      item("t", "Terminal", { kind: "app" }),
    ]);
    const res = engine.search("trans hello world");
    expect(res.sections[0].items[0].item.id).toBe("w");
    expect(res.sections[0].items[0].argument).toBe("hello world");
  });

  it("items without acceptsArgument never receive an argument", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("t", "Terminal")]);
    const res = engine.search("terminal foo");
    expect(res.sections.find((s) => s.id === "results")).toBeUndefined();
  });

  it("routes calculator and file dynamic items to their sections, results in between", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("a", "2048 Game")]);
    const res = engine.search("2+2", {
      dynamicItems: [
        dyn(item("calc", "4", { kind: "calculator" }), 1000, "exact"),
        dyn(item("f1", "2+2.txt", { kind: "file", path: "/tmp/2+2.txt" }), 25, "fuzzy"),
        dyn(item("f2", "notes 2+2", { kind: "file" }), 30, "fuzzy"),
      ],
    });
    expect(res.sections.map((s) => s.id)).toEqual(["calculator", "files"]);
    expect(res.sections[1].items.map((i) => i.item.id)).toEqual(["f2", "f1"]);
    expect(res.total).toBe(4);
  });

  it("suppresses the calculator when a result's title starts with the query (Raycast _Xi)", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("pi", "Pixelmator")]);
    const res = engine.search("pi", { dynamicItems: [dyn(item("calc", "3.14159", { kind: "calculator" }), 1000, "exact")] });
    expect(res.sections.map((s) => s.id)).toEqual(["results"]);
  });

  it("fallback items appear last with the query as argument and never in results", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([
      item("a", "Safari"),
      item("fb", "Search Google", { kind: "fallback", url: "https://google.com/search?q={query}" }),
    ]);
    const res = engine.search("saf");
    expect(res.sections.map((s) => s.id)).toEqual(["results", "fallbacks"]);
    expect(res.sections[0].items.map((i) => i.item.id)).toEqual(["a"]);
    expect(res.sections[1].items[0].argument).toBe("saf");
    const none = engine.search("zzz");
    expect(none.sections.map((s) => s.id)).toEqual(["fallbacks"]);
  });

  it("honours sectionLimit (results ≤ 2·limit, files ≤ limit)", () => {
    const engine = createEngine({ now: () => T0, sectionLimit: 2 });
    engine.setItems(Array.from({ length: 10 }, (_, i) => item(`a${i}`, `Alpha ${i}`)));
    const files = Array.from({ length: 5 }, (_, i) => dyn(item(`f${i}`, `alpha${i}.txt`, { kind: "file" }), 25, "fuzzy"));
    const res = engine.search("alpha", { dynamicItems: files });
    expect(res.sections.find((s) => s.id === "results")!.items).toHaveLength(4);
    expect(res.sections.find((s) => s.id === "files")!.items).toHaveLength(2);
  });

  it("other dynamic kinds are merged into results (ranked when they match, appended otherwise)", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("a", "Safari")]);
    const res = engine.search("saf", {
      dynamicItems: [dyn(item("s", "Safe Snippet", { kind: "snippet" }), 10, "fuzzy"), dyn(item("x", "Unrelated", { kind: "snippet" }), 5, "none")],
    });
    expect(res.sections[0].items.map((i) => i.item.id)).toEqual(["a", "s", "x"]);
  });

  it("reports tookMs and the query verbatim", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("a", "Safari")]);
    const res = engine.search("Saf ");
    expect(res.query).toBe("Saf ");
    expect(res.tookMs).toBeGreaterThanOrEqual(0);
  });
});

describe("usage round-trip", () => {
  it("recordUsage returns a record main can persist and setUsage restores it", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("a", "Safari")]);
    const rec = engine.recordUsage("a", "saf");
    expect(rec.count).toBe(1);
    expect(rec.launches).toEqual([T0]);
    expect(rec.lastLaunchedAt).toBe(T0);
    const restored = createEngine({ now: () => T0 + 1 });
    restored.setItems([item("a", "Safari")]);
    restored.setUsage(JSON.parse(JSON.stringify(engine.getUsage())));
    expect(restored.search("").sections[0].items[0].frecency).toBeCloseTo(101, 2);
  });

  it("the launch ring is bounded to 10 while count keeps growing", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("a", "Safari")]);
    let rec = engine.recordUsage("a");
    for (let i = 0; i < 14; i++) rec = engine.recordUsage("a");
    expect(rec.launches).toHaveLength(10);
    expect(rec.count).toBe(15);
  });
});

describe("argument extraction vs multi-word titles", () => {
  it("does not split a fully typed multi-word title into head + argument", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("s", "Two Args", { kind: "command", acceptsArgument: true })]);
    const top = engine.search("two args").sections.flatMap((s) => s.items)[0];
    expect(top?.item.id).toBe("s");
    expect(top?.argument).toBeUndefined();
  });

  it("still extracts an argument when the text goes beyond the title", () => {
    const engine = createEngine({ now: () => T0 });
    engine.setItems([item("g", "Google", { kind: "quicklink", acceptsArgument: true })]);
    const top = engine.search("google electron").sections.flatMap((s) => s.items)[0];
    expect(top?.item.id).toBe("g");
    expect(top?.argument).toBe("electron");
  });
});
