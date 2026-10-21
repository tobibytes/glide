import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, DEFAULT_APPEARANCE, normalizeAppearance, parseHex, PRESETS, presetById, resolvePreset, themeTokens, tokensFor } from "./themes";

const REQUIRED_PRESETS = ["glide-dark", "glide-light", "midnight", "nord", "solarized", "dracula", "mocha", "dawn", "high-contrast"];

describe("presets", () => {
  it("ships every required preset with valid colors", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(REQUIRED_PRESETS));
    for (const p of PRESETS) for (const k of ["bg", "surface", "surface2", "surface3", "text", "text2", "text3", "accent"] as const) expect(parseHex(p[k]), `${p.id}.${k}`).not.toBeNull();
  });
  it("body text is readable on every preset (≥ 7:1) and secondary text ≥ 3:1", () => {
    for (const p of PRESETS) {
      expect(contrastRatio(parseHex(p.text)!, parseHex(p.bg)!), p.id).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(parseHex(p.text3)!, parseHex(p.bg)!), p.id).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("normalizeAppearance", () => {
  it("fills defaults and clamps", () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    const n = normalizeAppearance({ fontSize: 99, radius: -4, width: 700.4, translucency: "a", density: "compact", darkTheme: "nope", lightTheme: "dawn", accent: "#ABC", vibrancy: false });
    expect(n).toMatchObject({ fontSize: 17, radius: 0, width: 700, translucency: DEFAULT_APPEARANCE.translucency, density: "compact", darkTheme: "glide-dark", lightTheme: "dawn", accent: "#aabbcc", vibrancy: false });
    expect(normalizeAppearance({ accent: "red" }).accent).toBe("");
  });
});

describe("resolvePreset", () => {
  const s = { ...DEFAULT_APPEARANCE, darkTheme: "nord", lightTheme: "dawn" };
  it("follows the system in system mode and is fixed otherwise", () => {
    expect(resolvePreset("system", true, s).id).toBe("nord");
    expect(resolvePreset("system", false, s).id).toBe("dawn");
    expect(resolvePreset("dark", false, s).id).toBe("nord");
    expect(resolvePreset("light", true, s).id).toBe("dawn");
  });
});

describe("themeTokens", () => {
  it("emits every token the stylesheets use", () => {
    const css = ["tokens.css", "launcher.css", "base.css", "settings.css"].map((f) => readFileSync(path.join(__dirname, "../../../renderer/styles", f), "utf8")).join("\n");
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    const tokens = themeTokens(presetById("glide-dark")!, DEFAULT_APPEARANCE);
    const structural = new Set(["--mono", "--sans", "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--ease", "--ease-out", "--dur"]);
    const missing = [...used].filter((v) => !(v in tokens) && !structural.has(v));
    expect(missing).toEqual([]);
  });
  it("applies accent, density, font size, radius, width and translucency", () => {
    const p = presetById("glide-dark")!;
    const base = themeTokens(p, DEFAULT_APPEARANCE);
    const t = themeTokens(p, { ...DEFAULT_APPEARANCE, accent: "#7c8cff", density: "compact", fontSize: 16, radius: 4, width: 900, translucency: 0 });
    expect(t["--accent"]).toBe("#7c8cff");
    expect(t["--row-h"]).toBe("38px");
    expect(base["--row-h"]).toBe("42px");
    expect(t["--fs-title"]).toBe("16px");
    expect(t["--radius"]).toBe("4px");
    expect(t["--launcher-width"]).toBe("900px");
    expect(t["--panel"]).toMatch(/, 1\)$/);
    expect(base["--panel"]).not.toMatch(/, 1\)$/);
  });
  it("text on the accent and accent-colored text stay readable", () => {
    for (const p of PRESETS) {
      const t = themeTokens(p, DEFAULT_APPEARANCE);
      expect(contrastRatio(parseHex(t["--accent-contrast"])!, parseHex(t["--accent"])!), p.id).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(parseHex(t["--accent-text"])!, parseHex(t["--panel-solid"])!), p.id).toBeGreaterThanOrEqual(4);
    }
  });
  it("high contrast has stronger borders and selection than the default", () => {
    const hc = themeTokens(presetById("high-contrast")!, DEFAULT_APPEARANCE);
    const gd = themeTokens(presetById("glide-dark")!, DEFAULT_APPEARANCE);
    const alpha = (v: string) => Number(/([\d.]+)\)$/.exec(v)![1]);
    expect(alpha(hc["--border"])).toBeGreaterThan(alpha(gd["--border"]));
    expect(alpha(hc["--selected"])).toBeGreaterThan(alpha(gd["--selected"]));
  });
  it("tokensFor honours a preview override", () => {
    expect(tokensFor("dark", true, {}, "dawn").preset.id).toBe("dawn");
    expect(tokensFor("dark", true, {}, null).preset.id).toBe("glide-dark");
    expect(tokensFor("dark", true, {}, "missing").preset.id).toBe("glide-dark");
  });
  it("tokens.css first-paint defaults match the generated Glide Dark / Light tokens", () => {
    const css = readFileSync(path.join(__dirname, "../../../renderer/styles/tokens.css"), "utf8");
    for (const id of ["glide-light", "glide-dark"]) {
      const t = themeTokens(presetById(id)!, DEFAULT_APPEARANCE);
      for (const k of ["--accent", "--panel", "--text", "--selected"]) expect(css, `${id} ${k}`).toContain(`${k}: ${t[k]};`);
    }
  });
});
