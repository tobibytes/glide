import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalAccelerator, parseAccelerator } from "./hotkey-accelerator";

interface Case {
  accel: string;
  kind?: "combo" | "modifier";
  mods?: string[];
  key?: string;
  mod?: string;
  side?: string;
  double?: boolean;
  canonical?: string;
  error?: boolean;
}

const table = JSON.parse(fs.readFileSync(path.join(__dirname, "../native/hotkey-accelerators.json"), "utf8")) as { cases: Case[] };

describe("parseAccelerator (mirror of Hotkeys.swift)", () => {
  for (const c of table.cases) {
    it(JSON.stringify(c.accel), () => {
      const p = parseAccelerator(c.accel);
      if (c.error) {
        expect("error" in p).toBe(true);
        return;
      }
      if ("error" in p) throw new Error(p.error);
      expect(p.kind).toBe(c.kind);
      expect(p.canonical).toBe(c.canonical);
      if (p.kind === "combo") {
        expect(p.mods).toEqual(c.mods);
        expect(p.key).toBe(c.key);
      } else {
        expect(p.mod).toBe(c.mod);
        expect(p.side).toBe(c.side);
        expect(p.double).toBe(c.double);
      }
    });
  }

  it("canonical forms are stable when re-parsed", () => {
    for (const c of table.cases) if (c.canonical) expect(canonicalAccelerator(c.canonical)).toBe(c.canonical);
  });
});
