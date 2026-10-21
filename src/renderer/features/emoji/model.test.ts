import { describe, expect, it } from "vitest";
import { allEmoji, findEmoji, parseRows, searchEmoji, usageSections, withTone } from "./model";

describe("emoji dataset", () => {
  it("parses the generated rows without skin-tone duplicates", () => {
    const list = allEmoji();
    expect(list.length).toBeGreaterThan(1500);
    expect(list.some((e) => /[\u{1F3FB}-\u{1F3FF}]/u.test(e.char))).toBe(false);
    expect(new Set(list.map((e) => e.char)).size).toBe(list.length);
  });

  it("parses a row", () => {
    expect(parseRows("😀|grinning face|grin smile|0|")).toEqual([{ char: "😀", name: "grinning face", keywords: ["grin", "smile"], category: 0, skin: "" }]);
  });
});

describe("searchEmoji", () => {
  it("finds by name prefix first", () => {
    expect(searchEmoji("thumbs")[0].char).toBe("👍");
  });
  it("finds by keyword", () => {
    const res = searchEmoji("laugh").map((e) => e.char);
    expect(res).toContain("😂");
  });
  it("requires every token to match", () => {
    const res = searchEmoji("red heart");
    expect(res[0].char).toBe("❤️");
    expect(res.every((e) => /red/.test(e.name + e.keywords.join(" ")))).toBe(true);
  });
  it("strips :shortcode colons", () => {
    expect(searchEmoji(":fire:")[0].char).toBe("🔥");
  });
  it("returns nothing for gibberish", () => {
    expect(searchEmoji("zzqqxx")).toHaveLength(0);
  });
  it("respects the limit", () => {
    expect(searchEmoji("face", undefined, 5)).toHaveLength(5);
  });
});

describe("skin tones", () => {
  it("applies a modifier after the first code point", () => {
    const wave = findEmoji("👋")!;
    expect(withTone(wave, 0)).toBe("👋");
    expect(withTone(wave, 3)).toBe("👋🏽");
  });
  it("drops VS16 before the modifier", () => {
    const hand = findEmoji("✌️")!;
    expect(withTone(hand, 1)).toBe("✌🏻");
  });
  it("handles ZWJ sequences", () => {
    const mechanic = findEmoji("👩‍🔧")!;
    expect(withTone(mechanic, 5)).toBe("👩🏿‍🔧");
  });
  it("leaves unsupported emoji alone", () => {
    expect(withTone(findEmoji("🔥")!, 4)).toBe("🔥");
  });
  it("uses the explicit template for multi-person emoji", () => {
    const hands = allEmoji().find((e) => e.name.includes("people holding hands"))!;
    expect(withTone(hands, 2)).toBe("🧑🏼‍🤝‍🧑🏼");
  });
});

describe("usageSections", () => {
  it("splits recent and frequent", () => {
    const u = { a: { count: 5, last: 1 }, b: { count: 1, last: 10 }, c: { count: 3, last: 5 }, d: { count: 9, last: 0 } };
    const { recent, frequent } = usageSections(u, 2, 5);
    expect(recent).toEqual(["b", "c"]);
    expect(frequent).toEqual(["d", "a"]);
  });
});
