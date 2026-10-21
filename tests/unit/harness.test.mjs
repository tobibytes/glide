import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseKey, MOD } from "../harness/keys.mjs";
import { seedDataDir, syntheticQuicklinks, perfQueries } from "../harness/fixtures.mjs";
import { allocatePort, releasePort, PORT_RANGE } from "../harness/ports.mjs";

test("parseKey handles modifiers, letters and named keys", () => {
  assert.deepEqual(parseKey("cmd+k"), { key: "k", code: "KeyK", vk: 75, text: undefined, modifiers: MOD.meta });
  assert.equal(parseKey("G").modifiers, MOD.shift);
  assert.equal(parseKey("Enter").text, "\r");
  assert.equal(parseKey("shift+Tab").modifiers, MOD.shift);
  assert.throws(() => parseKey("hyper+x"));
});

test("fixtures are deterministic and complete", () => {
  assert.deepEqual(syntheticQuicklinks(50), syntheticQuicklinks(50));
  assert.equal(perfQueries(200).length, 200);
  const dir = mkdtempSync(path.join(tmpdir(), "glide-fx-"));
  try {
    seedDataDir(dir, { catalogueSize: 100, now: 1_700_000_000_000 });
    const data = JSON.parse(readFileSync(path.join(dir, "data.json"), "utf8"));
    assert.equal(data.quicklinks.length, 102);
    assert.equal(data.settings.fileSearch, false);
    assert.deepEqual(data.settings.features.fileindex.scopes, [path.join(dir, "fixture", "files")]);
    assert.ok(existsSync(path.join(dir, "features", "clipboard", "history.json")));
    assert.ok(existsSync(path.join(dir, "fixture", "Applications", "Safari.app", "Contents", "Info.plist")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ports come from the reserved window and are not handed out twice", async () => {
  const a = await allocatePort();
  const b = await allocatePort();
  assert.notEqual(a, b);
  for (const p of [a, b]) assert.ok(p >= PORT_RANGE.base && p < PORT_RANGE.base + PORT_RANGE.count);
  releasePort(a);
  releasePort(b);
});
