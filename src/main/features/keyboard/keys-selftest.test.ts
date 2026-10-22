/**
 * The keyboard tap's decision table (src/native/GlideHelper/KeysLogic.swift), asserted by running the real
 * helper in its offline `--selftest-keys` mode: synthetic key sequences in, decisions out as JSON. The mode
 * never creates an event tap, posts events or touches the pasteboard.
 *
 * Uses build/bin/glide-helper (or GLIDE_SELFTEST_HELPER) when it is newer than the Swift sources it tests;
 * otherwise the suite is skipped — run `pnpm build:helper` first.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "./keys-selftest.json";

const root = path.resolve(__dirname, "../../../..");
const binary = process.env.GLIDE_SELFTEST_HELPER ?? path.join(root, "build/bin/glide-helper");
const sources = ["KeysLogic.swift", "KeysSelfTest.swift"].map((f) => path.join(root, "src/native/GlideHelper", f));
const mtime = (f: string) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : Number.POSITIVE_INFINITY);
const fresh = process.platform === "darwin" && fs.existsSync(binary) && sources.every((s) => mtime(s) <= mtime(binary));

interface SelfTestOutput {
  cases: Array<{ name: string; decisions: string[] }>;
  extra: { backspaces: Array<{ keyword: string; count: number }> };
}

function runSelfTest(): SelfTestOutput {
  const out = execFileSync(binary, ["--selftest-keys", path.join(__dirname, "keys-selftest.json")], {
    input: "",
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, GLIDE_HELPER_DRY_RUN: "1" },
  });
  return JSON.parse(out.trim().split("\n").pop()!) as SelfTestOutput;
}

describe.skipIf(!fresh)("glide-helper --selftest-keys", () => {
  const out = fresh ? runSelfTest() : { cases: [], extra: { backspaces: [] } };

  it("runs every fixture case", () => {
    expect(out.cases.map((c) => c.name)).toEqual(fixture.cases.map((c) => c.name));
  });

  for (const [i, c] of fixture.cases.entries()) {
    it(c.name, () => {
      expect(out.cases[i]?.decisions).toEqual(c.expect);
    });
  }

  it("deletes one backspace per grapheme cluster", () => {
    expect(out.extra.backspaces.map((b) => b.count)).toEqual(fixture.expectBackspaces);
  });
});

describe("decision table fixture", () => {
  it("is well-formed (every case has expectations)", () => {
    for (const c of fixture.cases) expect(c.expect.length, c.name).toBeGreaterThan(0);
    expect(fixture.expectBackspaces).toHaveLength(fixture.backspaces.length);
  });
});
