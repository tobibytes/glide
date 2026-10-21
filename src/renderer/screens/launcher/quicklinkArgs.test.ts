import { describe, expect, it } from "vitest";
import type { ScoredItem } from "@shared/types";
import { initMultiArg, multiArgKey, multiArgValues, needsArgEntry, wantsMultiArg } from "./quicklinkArgs";

const scored = (args: unknown[], argument?: string): ScoredItem => ({
  item: { id: "quicklink:x", kind: "quicklink", title: "X", acceptsArgument: true, data: { arguments: args } },
  score: 0,
  matchScore: 0,
  matchKind: "none",
  frecency: 0,
  ranges: [],
  argument,
});
const k = (key: string, shiftKey = false) => ({ key, shiftKey, metaKey: false, ctrlKey: false, altKey: false });

const ARGS = [
  { name: "text", placeholder: "text", optional: false },
  { name: "lang", placeholder: "lang", default: "en", optional: true },
  { name: "mode", placeholder: "mode", options: ["web", "images"], optional: false },
];

describe("launcher multi-argument entry", () => {
  it("only switches legacy {query} links to the multi-field UI when they need it", () => {
    expect(wantsMultiArg(scored([{ name: "query", placeholder: "Query", optional: false }]))).toBe(false);
    expect(wantsMultiArg(scored(ARGS))).toBe(true);
    expect(wantsMultiArg(scored([{ name: "q", placeholder: "q", optional: false }]))).toBe(true);
  });

  it("starts with defaults and the typed argument in the first field", () => {
    const init = initMultiArg(scored(ARGS, "hello"))!;
    expect(init.text).toBe("hello");
    expect(init.multi.values).toEqual(["hello", "en", ""]);
  });

  it("Tab / ⇧Tab step through arguments and keep what was typed", () => {
    let { multi, text } = initMultiArg(scored(ARGS))!;
    text = "bonjour";
    ({ multi, text } = multiArgKey(multi, k("Tab"), text)!);
    expect([multi.index, text]).toEqual([1, "en"]);
    ({ multi, text } = multiArgKey(multi, k("Tab"), "fr")!);
    expect([multi.index, text]).toEqual([2, ""]);
    ({ multi, text } = multiArgKey(multi, k("ArrowDown"), text)!);
    expect(text).toBe("web");
    ({ multi, text } = multiArgKey(multi, k("ArrowDown"), text)!);
    expect(text).toBe("images");
    ({ multi, text } = multiArgKey(multi, k("ArrowDown"), text)!);
    expect(text).toBe("web");
    expect(multiArgValues(multi, text)).toEqual({ text: "bonjour", lang: "fr", mode: "web" });
    ({ multi, text } = multiArgKey(multi, k("Tab", true), text)!);
    expect([multi.index, text]).toEqual([1, "fr"]);
    // Tab past the last field stays put
    ({ multi, text } = multiArgKey({ ...multi, index: 2 }, k("Tab"), "web")!);
    expect(multi.index).toBe(2);
  });

  it("Backspace on an empty field goes back; other keys are not ours", () => {
    const { multi } = initMultiArg(scored(ARGS))!;
    expect(multiArgKey({ ...multi, index: 1 }, k("Backspace"), "")?.multi.index).toBe(0);
    expect(multiArgKey(multi, k("Backspace"), "")).toBeNull();
    expect(multiArgKey(multi, k("a"), "")).toBeNull();
    expect(multiArgKey(multi, { ...k("Tab"), metaKey: true }, "")).toBeNull();
  });

  it("Enter opens the fields first when a required argument is empty", () => {
    expect(needsArgEntry(scored(ARGS))).toBe(true);
    expect(needsArgEntry(scored([{ name: "q", placeholder: "q", optional: false }], "typed"))).toBe(false);
    expect(needsArgEntry(scored([{ name: "query", placeholder: "Query", optional: false }]))).toBe(false);
  });
});
