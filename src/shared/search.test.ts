import { describe, expect, it } from "vitest";
import { createEngine } from "@engine/index";
import type { ScoredItem, SearchItem, SearchResponse } from "./types";
import { createSearchApi, flattenResponse, type SearchProvider } from "./search";
import { didYouMean, isWeak, realResults, typoVariants } from "./did-you-mean";

const item = (id: string, title: string, extra: Partial<SearchItem> = {}): SearchItem => ({ id, kind: "app", title, ...extra });
const CATALOGUE: SearchItem[] = [
  item("app:safari", "Safari"),
  item("app:slack", "Slack"),
  item("app:terminal", "Terminal"),
  item("app:settings", "System Settings"),
  item("wf:standup", "Standup Notes", { kind: "workflow", workflowId: "standup" }),
  item("clip:history", "Clipboard History", { kind: "command", feature: "clipboard", kindLabel: "Clipboard" }),
  item("fb:google", "Search Google", { kind: "fallback", url: "https://google.com/?q={query}" }),
];

function makeProvider() {
  const engine = createEngine({ sectionLimit: 8 });
  engine.setItems(CATALOGUE);
  // Same shape as ipc.ts runSearch: engine + dynamic items, with an optional larger section cap.
  const dynamic = (q: string): ScoredItem[] =>
    /^\d+\s*km/.test(q) ? [{ item: { id: `convert:${q}`, kind: "calculator", title: "6.2 mi", text: "6.2137", feature: "convert" }, score: 1000, matchScore: 1000, matchKind: "exact", frecency: 0, ranges: [] }] : [];
  const run = async (q: string, opts: { sectionLimit?: number } = {}): Promise<SearchResponse> => {
    if (opts.sectionLimit && opts.sectionLimit > 8) {
      engine.configure({ sectionLimit: opts.sectionLimit });
      try {
        return engine.search(q, { dynamicItems: dynamic(q) });
      } finally {
        engine.configure({ sectionLimit: 8 });
      }
    }
    return engine.search(q, { dynamicItems: dynamic(q) });
  };
  const byId = new Map(CATALOGUE.map((i) => [i.id, i]));
  const provider: SearchProvider = { run, find: (id) => byId.get(id), suggest: (q) => didYouMean(q, (v) => engine.search(v)) };
  return { engine, run, provider };
}

describe("FeatureContext.search (createSearchApi)", () => {
  it("returns the launcher's ranking, flattened in section order, without fallbacks", async () => {
    const { run, provider } = makeProvider();
    const api = createSearchApi(() => provider);
    const launcher = await run("sa");
    const expected = launcher.sections.filter((s) => s.id !== "fallbacks").flatMap((s) => s.items.map((i) => i.item.id));
    const got = (await api.search("sa")).map((s) => s.item.id);
    expect(got).toEqual(expected);
    expect(got[0]).toBe("app:safari");
    expect(got).not.toContain("fb:google");
  });

  it("includes fallbacks on request and filters by kind / feature / limit", async () => {
    const { provider } = makeProvider();
    const api = createSearchApi(() => provider);
    expect((await api.search("zzz", { includeFallbacks: true })).map((s) => s.item.id)).toContain("fb:google");
    expect((await api.search("s", { kinds: ["workflow"] })).every((s) => s.item.kind === "workflow")).toBe(true);
    expect((await api.search("clip", { feature: "clipboard" })).map((s) => s.item.id)).toEqual(["clip:history"]);
    expect(await api.search("s", { limit: 2 })).toHaveLength(2);
  });

  it("includes dynamic items and findItem resolves them after a search", async () => {
    const { provider } = makeProvider();
    const api = createSearchApi(() => provider);
    expect(api.findItem("app:slack")?.title).toBe("Slack");
    expect(api.findItem("convert:10 km")).toBeUndefined();
    const res = await api.search("10 km");
    expect(res[0]?.item.id).toBe("convert:10 km");
    expect(api.findItem("convert:10 km")?.text).toBe("6.2137");
  });

  it("returns [] before the host wires a provider", async () => {
    const api = createSearchApi(() => null);
    expect(await api.search("safari")).toEqual([]);
    expect(api.findItem("app:safari")).toBeUndefined();
    expect(api.suggest("safri")).toBeNull();
  });

  it("flattenResponse de-duplicates favorites that repeat a result", () => {
    const s = (id: string): ScoredItem => ({ item: item(id, id), score: 1, matchScore: 1, matchKind: "exact", frecency: 0, ranges: [] });
    const res: SearchResponse = { query: "", total: 2, tookMs: 0, sections: [{ id: "favorites", title: "Favorites", items: [s("a")] }, { id: "results", title: "Results", items: [s("a"), s("b")] }] };
    expect(flattenResponse(res).map((x) => x.item.id)).toEqual(["a", "b"]);
  });
});

describe("did you mean", () => {
  it("suggests a correction for a typo with no results", () => {
    const { engine } = makeProvider();
    const sug = didYouMean("sfaari", (q) => engine.search(q));
    expect(sug?.items[0]?.item.title).toBe("Safari");
  });
  it("also fires when the only hits are loose fuzzy matches", () => {
    const engine = createEngine({ sectionLimit: 8 });
    engine.setItems([...CATALOGUE, item("app:scan", "Scan QR Code from Clipboard Image")]);
    const search = (q: string) => engine.search(q);
    expect(isWeak(search("sfaari"))).toBe(true);
    expect(didYouMean("saffari", search)?.items[0]?.item.title).toBe("Safari");
    expect(isWeak(search("safari"))).toBe(false);
  });
  it("stays quiet when the query already has results, is short, or is arithmetic", () => {
    const { engine } = makeProvider();
    const search = (q: string) => engine.search(q);
    expect(didYouMean("safari", search)).toBeNull();
    expect(didYouMean("sf", search)).toBeNull();
    expect(didYouMean("12*(3+4)", search)).toBeNull();
    expect(didYouMean("zzqxj", search)).toBeNull();
  });
  it("variants are single deletions and adjacent swaps", () => {
    expect(typoVariants("abc").sort()).toEqual(["ab", "ac", "acb", "bac", "bc"].sort());
  });
  it("realResults ignores fallbacks", () => {
    const { engine } = makeProvider();
    expect(realResults(engine.search("zzqxj"))).toEqual([]);
  });
});
