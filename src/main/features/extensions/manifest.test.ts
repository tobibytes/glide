import { describe, expect, it } from "vitest";
import { missingPreferences, resolvePreferences, splitArguments, validateManifest } from "./manifest";

const base = {
  name: "demo",
  version: "1.2.3",
  glide: {
    title: "Demo",
    description: "A demo",
    icon: "🧪",
    commands: [
      { name: "list", title: "List Things", mode: "view", keywords: ["things"] },
      { name: "go", title: "Go", mode: "no-view", arguments: [{ name: "q", placeholder: "Query", required: true }] },
    ],
    preferences: [
      { name: "token", title: "Token", type: "password", required: true },
      { name: "flag", title: "Flag", type: "checkbox", default: true },
      { name: "unit", title: "Unit", type: "dropdown", default: "c", data: [{ value: "c", title: "Celsius" }] },
    ],
  },
};

describe("validateManifest", () => {
  it("accepts a valid manifest and resolves entries", () => {
    const files = new Set(["dist/list.js", "go.js"]);
    const res = validateManifest(base, (p) => files.has(p));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.title).toBe("Demo");
    expect(res.manifest.commands.map((c) => [c.name, c.entry, c.mode])).toEqual([
      ["list", "dist/list.js", "view"],
      ["go", "go.js", "no-view"],
    ]);
    expect(res.manifest.commands[1].arguments).toEqual([{ name: "q", placeholder: "Query", required: true }]);
    expect(res.manifest.preferences[1]).toMatchObject({ type: "checkbox", default: true, required: false });
  });

  it("reports every problem", () => {
    const res = validateManifest(
      { name: "../evil", glide: { commands: [{ name: "a", title: "A", mode: "menu" }, { name: "a" }], preferences: [{ name: "p", type: "color" }, { name: "d", type: "dropdown" }] } },
      () => false,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const all = res.errors.join("\n");
    expect(all).toMatch(/"name" must be/);
    expect(all).toMatch(/glide.title/);
    expect(all).toMatch(/mode must be/);
    expect(all).toMatch(/duplicated/);
    expect(all).toMatch(/no entry file/);
    expect(all).toMatch(/type must be one of/);
    expect(all).toMatch(/dropdown preferences need/);
  });

  it("rejects non-objects and missing glide block", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest({ name: "x" }).ok).toBe(false);
    expect(validateManifest({ name: "x", glide: { title: "X", commands: [] } }).ok).toBe(false);
  });
});

describe("preferences and arguments", () => {
  const res = validateManifest(base);
  if (!res.ok) throw new Error("fixture invalid");
  const m = res.manifest;

  it("finds missing required preferences", () => {
    expect(missingPreferences(m, {}).map((p) => p.name)).toEqual(["token"]);
    expect(missingPreferences(m, { token: "abc" })).toEqual([]);
  });

  it("resolves values over defaults", () => {
    expect(resolvePreferences(m, { token: "t" })).toEqual({ token: "t", flag: true, unit: "c" });
  });

  it("splits launcher arguments", () => {
    expect(splitArguments([{ name: "q", required: true }], "  hello world ")).toEqual({ q: "hello world" });
    expect(splitArguments([{ name: "a", required: false }, { name: "b", required: false }], "x y z")).toEqual({ a: "x", b: "y z" });
    expect(splitArguments([{ name: "a", required: false }, { name: "b", required: false }], "")).toEqual({ a: "", b: "" });
  });
});
