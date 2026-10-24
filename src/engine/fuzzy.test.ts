import { describe, expect, it } from "vitest";
import {
  EXACT_SCORE,
  containsWholeWord,
  foldText,
  fuzzyMatch,
  passesSensitivity,
  prepareText,
  wholeWordFloor,
} from "./fuzzy";

describe("fuzzyMatch — exact / prefix", () => {
  it("whole-text equality is exact (case-insensitive) with full range", () => {
    const m = fuzzyMatch("Code", "code");
    expect(m).not.toBeNull();
    expect(m!.exact).toBe(true);
    expect(m!.score).toBe(EXACT_SCORE);
    expect(m!.ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it("prefix: startsWith and text longer than query; perfect run from 0 scores 4 + 2·(len−1)", () => {
    const m = fuzzyMatch("Code Editor", "cod")!;
    expect(m.exact).toBe(false);
    expect(m.prefix).toBe(true);
    expect(m.score).toBe(4 + 2 + 2);
    expect(m.ranges).toEqual([{ start: 0, end: 3 }]);
  });

  it("returns null when a non-separator query char is missing", () => {
    expect(fuzzyMatch("Code", "codex")).toBeNull();
    expect(fuzzyMatch("Safari", "xyz")).toBeNull();
    expect(fuzzyMatch("ab", "abc")).toBeNull(); // more required chars than text
  });

  it("empty query never matches", () => {
    expect(fuzzyMatch("Code", "")).toBeNull();
  });
});

describe("fuzzyMatch — boundary scoring", () => {
  it('"vsc" vs "Visual Studio Code" = 4 + 3 + 3 − 2 gaps = 8', () => {
    const m = fuzzyMatch("Visual Studio Code", "vsc")!;
    expect(m.score).toBe(8);
    expect(m.ranges).toEqual([
      { start: 0, end: 1 },
      { start: 7, end: 8 },
      { start: 14, end: 15 },
    ]);
  });

  it("camelCase edges count as word boundaries (computed on original case)", () => {
    // i(4) P(3, camel edge) → gap-free: 7
    expect(fuzzyMatch("iPhone", "ip")!.score).toBe(7);
    // lowercase text has no camel edge: i(4) p(2) = 6
    expect(fuzzyMatch("iphone", "ip")!.score).toBe(6);
  });

  it("start-of-text bonus (4) applies only when the first query char is the first text char", () => {
    expect(fuzzyMatch("abc", "a")!.score).toBe(4);
    expect(fuzzyMatch("xabc", "a")!.score).toBe(2);
    expect(fuzzyMatch("x abc", "a")!.score).toBe(3);
  });

  it("gap of any length costs exactly 1; consecutive matches are free", () => {
    expect(fuzzyMatch("cex", "ce")!.score).toBe(6); // 4 + 2
    expect(fuzzyMatch("code", "ce")!.score).toBe(5); // 4 + 2 − 1
    expect(fuzzyMatch("cxxxxxxe", "ce")!.score).toBe(5); // same gap cost
  });

  it("prefers the higher-scoring path and reports its ranges", () => {
    // "st" in "Visual Studio": s(7 boundary 3)+t(8 consecutive 2)=5 beats s(2)+t(8) gap
    const m = fuzzyMatch("Visual Studio", "st")!;
    expect(m.score).toBe(5);
    expect(m.ranges).toEqual([{ start: 7, end: 9 }]);
  });
});

describe("fuzzyMatch — separators", () => {
  it("a query separator matching a different text separator is worth 1", () => {
    // visual(4+2*5=14) '-'→' ' (1) studio(3 boundary + 2*5) = 28
    const m = fuzzyMatch("Visual Studio", "visual-studio")!;
    expect(m.score).toBe(28);
    expect(m.skipped).toBe(0);
    expect(m.ranges).toEqual([{ start: 0, end: 13 }]);
  });

  it("a query separator without counterpart is skipped (counted) and does not break the run", () => {
    // VisualStudio: visual=14, '/' skipped, s(6) camel boundary 3 consecutive from l(5), tudio=10 → 27
    const m = fuzzyMatch("VisualStudio", "visual/studio")!;
    expect(m.score).toBe(27);
    expect(m.skipped).toBe(1);
  });

  it("dots in the query are literal by default (literalQueryDots), skippable when disabled", () => {
    expect(fuzzyMatch("github.com", "github.com")!.exact).toBe(true);
    expect(fuzzyMatch("githubcom", "github.com")).toBeNull();
    expect(fuzzyMatch("githubcom", "github.com", { literalQueryDots: false })!.skipped).toBe(1);
  });

  it("a query made only of separators that cannot match is unmatched", () => {
    expect(fuzzyMatch("abc", "-")).toBeNull();
  });
});

describe("fuzzyMatch — diacritic folding", () => {
  it('"cafe" matches "Café" exactly and keeps 1:1 indices', () => {
    const m = fuzzyMatch("Café", "cafe")!;
    expect(m.exact).toBe(true);
    expect(m.ranges).toEqual([{ start: 0, end: 4 }]);
    expect(fuzzyMatch("Café Bar", "cafe")!.prefix).toBe(true);
    expect(fuzzyMatch("Café", "café")!.exact).toBe(true);
  });

  it("foldText preserves length even for decomposed input", () => {
    const decomposed = "Café"; // e + combining acute
    expect(foldText(decomposed).length).toBe(decomposed.length);
    expect(foldText("Ünïcödé")).toBe("unicode");
  });
});

describe("passesSensitivity", () => {
  it("low: any match passes", () => {
    expect(passesSensitivity(1, 10, 0, "low")).toBe(true);
  });

  it("medium: score ≥ 1.5·(len − skipped − 2) + 4", () => {
    // len 3, skipped 0 → threshold 5.5
    expect(passesSensitivity(5.5, 3, 0, "medium")).toBe(true);
    expect(passesSensitivity(5.4, 3, 0, "medium")).toBe(false);
    // skipped lowers the bar: len 4 skipped 1 → 5.5
    expect(passesSensitivity(5.5, 4, 1, "medium")).toBe(true);
  });

  it("high: score > 2·(len − skipped)", () => {
    expect(passesSensitivity(6, 3, 0, "high")).toBe(false);
    expect(passesSensitivity(6.5, 3, 0, "high")).toBe(true);
    expect(passesSensitivity(6, 4, 1, "high")).toBe(false);
    expect(passesSensitivity(7, 4, 1, "high")).toBe(true);
  });

  it("exact always passes, unmatched never", () => {
    expect(passesSensitivity(EXACT_SCORE, 100, 0, "high")).toBe(true);
    expect(passesSensitivity(-Number.MAX_SAFE_INTEGER, 1, 0, "low")).toBe(false);
  });

  it('"vsc" (8) passes high for Visual Studio Code, a plain scattered match does not', () => {
    const vsc = fuzzyMatch("Visual Studio Code", "vsc")!;
    expect(passesSensitivity(vsc.score, 3, vsc.skipped, "high")).toBe(true);
    const weak = fuzzyMatch("xavxbxc", "abc")!; // 2+2+2 − 2 = 4
    expect(passesSensitivity(weak.score, 3, weak.skipped, "high")).toBe(false);
    expect(passesSensitivity(weak.score, 3, weak.skipped, "low")).toBe(true);
  });
});

describe("whole-word floor", () => {
  it("wholeWordFloor(len) = 4 + (len−1)·2 + 0.5", () => {
    expect(wholeWordFloor(4)).toBe(10.5);
  });

  it("containsWholeWord respects separators and camelCase bounds", () => {
    expect(containsWholeWord(prepareText("Visual Studio Code"), "code")).toBe(true);
    expect(containsWholeWord(prepareText("Xcode"), "code")).toBe(false);
    expect(containsWholeWord(prepareText("Codex"), "code")).toBe(false);
    expect(containsWholeWord(prepareText("vsCode"), "code")).toBe(true);
    // camelCase boundaries are [a-z0-9]→[A-Z] only: "S→C" is not an edge
    expect(containsWholeWord(prepareText("VSCode"), "code")).toBe(false);
  });
});
