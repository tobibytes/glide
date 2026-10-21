import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
vi.mock("../app/hud", () => ({ hud: vi.fn() }));
vi.mock("../../workflows/runtime", () => ({ pasteFromClipboard: vi.fn() }));

import { formatColor, hexOf, luminance, parseColor, rgbToHsl } from "./colors";
import { addToHistory, feature } from "./index";

const root = path.resolve(__dirname, "../../../..");

describe("color parsing", () => {
  it("parses hex in all lengths", () => {
    expect(parseColor("#ff8800")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor("#F80")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor("#ff880080")?.a).toBeCloseTo(0.5, 2);
    expect(parseColor("#ff88")).toEqual({ r: 255, g: 255, b: 136, a: 0.53 });
    expect(parseColor("#ggg")).toBeUndefined();
    expect(parseColor("ff8800")).toBeUndefined();
  });
  it("parses rgb()/rgba()/hsl() in legacy and modern syntax", () => {
    expect(parseColor("rgb(255, 136, 0)")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor("rgba(255 136 0 / 50%)")).toEqual({ r: 255, g: 136, b: 0, a: 0.5 });
    expect(parseColor("rgb(100%, 0%, 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("hsl(32, 100%, 50%)")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor("hsl(120deg 100% 25%)")).toEqual({ r: 0, g: 128, b: 0, a: 1 });
    expect(parseColor("rgb(1, 2)")).toBeUndefined();
    expect(parseColor("hsl(10, 50, 50)")).toBeUndefined();
  });
});

describe("color formatting", () => {
  const c = { r: 255, g: 136, b: 0, a: 1 };
  it("formats every copy format", () => {
    expect(formatColor(c, "hex")).toBe("#FF8800");
    expect(formatColor(c, "hexLower")).toBe("#ff8800");
    expect(formatColor(c, "rgb")).toBe("rgb(255, 136, 0)");
    expect(formatColor(c, "hsl")).toBe("hsl(32, 100%, 50%)");
    expect(formatColor(c, "swiftui")).toBe("Color(red: 1, green: 0.533, blue: 0)");
    expect(formatColor(c, "nscolor")).toBe("NSColor(srgbRed: 1, green: 0.533, blue: 0, alpha: 1)");
    expect(formatColor(c, "css")).toBe("color: #ff8800;");
    expect(formatColor({ ...c, a: 0.5 }, "rgb")).toBe("rgba(255, 136, 0, 0.5)");
    expect(formatColor({ ...c, a: 0.5 }, "hex")).toBe("#FF880080");
    expect(formatColor({ ...c, a: 0.5 }, "swiftui")).toBe("Color(red: 1, green: 0.533, blue: 0, opacity: 0.5)");
    expect(hexOf({ ...c, a: 0.2 })).toBe("#FF8800");
  });
  it("round-trips through HSL", () => {
    for (const hex of ["#123456", "#FF0000", "#808080", "#00FF7F"]) {
      const rgba = parseColor(hex)!;
      const { h, s, l } = rgbToHsl(rgba);
      const back = parseColor(`hsl(${h}, ${s}%, ${l}%)`)!;
      expect(Math.abs(back.r - rgba.r) + Math.abs(back.g - rgba.g) + Math.abs(back.b - rgba.b)).toBeLessThanOrEqual(6);
    }
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1);
  });
});

describe("color feature", () => {
  it("dedupes and caps history (newest first)", () => {
    let h = addToHistory([], { r: 1, g: 2, b: 3, a: 1 }, "picker", 1);
    h = addToHistory(h, { r: 4, g: 5, b: 6, a: 1 }, "picker", 2);
    h = addToHistory(h, { r: 1, g: 2, b: 3, a: 1 }, "search", 3);
    expect(h.map((e) => e.hex)).toEqual(["#010203", "#040506"]);
    for (let i = 0; i < 100; i++) h = addToHistory(h, { r: i, g: 0, b: 0, a: 1 }, "picker", i);
    expect(h).toHaveLength(60);
  });
  it("recognises typed colors in search and offers every copy format", async () => {
    const items = await feature.dynamicItems!("#ff8800");
    expect(items).toHaveLength(1);
    const it0 = items[0]!.item;
    expect(it0.title).toBe("#FF8800");
    expect(it0.icon).toEqual({ kind: "color", value: "#FF8800" });
    expect(feature.actions!(it0).map((a) => a.title)).toEqual([
      "Copy HEX", "Paste HEX", "Copy RGB", "Copy HSL", "Copy SwiftUI", "Copy CSS", "Copy NSColor", "Copy HEX (lowercase)", "Save to Color History",
    ]);
    expect(await feature.dynamicItems!("#safari")).toEqual([]);
    expect(await feature.dynamicItems!("rgb(255, 0, 0)")).toHaveLength(1);
  });
  it("has a color.pick helper method wired through Swift, protocol and client types", () => {
    expect(fs.readFileSync(path.join(root, "src/native/GlideHelper/main.swift"), "utf8")).toContain('case "color.pick":');
    expect(fs.readFileSync(path.join(root, "src/native/GlideHelper/ColorPicker.swift"), "utf8")).toContain("NSColorSampler()");
    expect(fs.readFileSync(path.join(root, "src/main/native/helper.ts"), "utf8")).toMatch(/"color\.pick": \{ params/);
  });
});
