import { describe, expect, it } from "vitest";
import { BUILTINS, DEFAULT_SETTINGS, enabledFallbacks, fillQuery, moveId, orderedFallbacks, placeId, quicklinkFallbackId, validTemplate, type FallbackSettings } from "./model";

const s = (patch: Partial<FallbackSettings>): FallbackSettings => ({ ...DEFAULT_SETTINGS, disabled: [], ...patch });
const ql = [
  { id: "a", name: "Docs", url: "https://docs.example.com/?q={query}" },
  { id: "b", name: "Wiki", url: "https://wiki.example.com/{query}" },
];

describe("fallback ordering", () => {
  it("defaults to built-in order", () => {
    expect(orderedFallbacks(s({}), []).map((f) => f.id)).toEqual(BUILTINS.map((b) => b.id));
  });

  it("puts ordered ids first and appends the rest in default order", () => {
    const ids = orderedFallbacks(s({ order: ["github", "google"] }), []).map((f) => f.id);
    expect(ids.slice(0, 2)).toEqual(["github", "google"]);
    expect(ids).toHaveLength(BUILTINS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ignores unknown ids in order", () => {
    expect(orderedFallbacks(s({ order: ["nope", "maps"] }), [])[0].id).toBe("maps");
  });

  it("includes custom fallbacks and opted-in quicklinks only", () => {
    const list = orderedFallbacks(s({ custom: [{ id: "c1", name: "Search MDN", url: "https://mdn.dev/?q={query}" }], quicklinks: ["b"] }), ql);
    expect(list.map((f) => f.id)).toContain("c1");
    expect(list.map((f) => f.id)).toContain(quicklinkFallbackId("b"));
    expect(list.map((f) => f.id)).not.toContain(quicklinkFallbackId("a"));
  });

  it("drops disabled ones from the enabled list", () => {
    const ids = enabledFallbacks(s({ disabled: ["google", "ai"] }), []).map((f) => f.id);
    expect(ids).not.toContain("google");
    expect(ids).not.toContain("ai");
    expect(ids[0]).toBe("files");
  });

  it("default settings disable DuckDuckGo and Maps", () => {
    const ids = enabledFallbacks(DEFAULT_SETTINGS, []).map((f) => f.id);
    expect(ids).not.toContain("duckduckgo");
    expect(ids).not.toContain("maps");
  });
});

describe("moveId / placeId", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves up and down with clamping", () => {
    expect(moveId(ids, "c", -1)).toEqual(["a", "c", "b", "d"]);
    expect(moveId(ids, "a", -1)).toEqual(ids);
    expect(moveId(ids, "d", 5)).toEqual(ids);
    expect(moveId(ids, "a", 2)).toEqual(["b", "c", "a", "d"]);
  });
  it("places at an index", () => {
    expect(placeId(ids, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(placeId(ids, "a", 3)).toEqual(["b", "c", "d", "a"]);
  });
  it("leaves the input untouched", () => {
    moveId(ids, "a", 1);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });
});

describe("templates", () => {
  it("fills and encodes the query", () => {
    expect(fillQuery("https://x.com/?q={query}&r={query}", "a b&c")).toBe("https://x.com/?q=a%20b%26c&r=a%20b%26c");
  });
  it("validates templates", () => {
    expect(validTemplate("")).toMatch(/required/);
    expect(validTemplate("https://x.com")).toMatch(/\{query\}/);
    expect(validTemplate("x.com/{query}")).toMatch(/scheme/);
    expect(validTemplate("https://x.com/{query}")).toBeNull();
  });
});
