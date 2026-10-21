import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/types";
import { buildExport, freshData, parseImport } from "./dataio";

describe("settings import", () => {
  it("round-trips an export", () => {
    const data = { ...freshData(1), favorites: ["a"], aliases: { x: "y" } };
    data.settings = { ...data.settings, hotkey: "Cmd+Space", features: { app: { updateFeed: "o/r" } } };
    expect(parseImport(JSON.parse(JSON.stringify(buildExport(data, "0.1.0"))))).toEqual(data);
  });
  it("accepts a raw data.json, drops wrong-typed settings and malformed records", () => {
    const out = parseImport({ settings: { hotkey: 5, theme: "dark", appDirectories: "nope", bogus: 1 }, workflows: [{ id: "w", name: "W", actions: [] }, { id: 3 }], favorites: ["a", 2] });
    expect(out.settings.hotkey).toBe(DEFAULT_SETTINGS.hotkey);
    expect(out.settings.theme).toBe("dark");
    expect(out.settings.appDirectories).toEqual(DEFAULT_SETTINGS.appDirectories);
    expect("bogus" in out.settings).toBe(false);
    expect(out.workflows).toHaveLength(1);
    expect(out.favorites).toEqual(["a"]);
  });
  it("rejects files that are not Glide data", () => {
    expect(() => parseImport([1, 2])).toThrow(/not a Glide/);
    expect(() => parseImport({ hello: 1 })).toThrow(/not a Glide/);
  });
});
