// Smoke test for build/bin/glide-helper: spawns it, exercises safe read-only methods, the
// dry-run Hyper-key mapping path, and checks a clean exit on stdin EOF.
// Never calls keys.configure with hyperKey "capslock" or system.setSpotlightShortcut for real.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bin = path.join(root, "build/bin/glide-helper");
if (!existsSync(bin)) {
  console.error(`missing ${bin}; run pnpm build:helper`);
  process.exit(1);
}

function startHelper(env = {}) {
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const pending = new Map();
  const events = [];
  let stderr = "";
  let buf = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.event) events.push(msg);
      else pending.get(msg.id)?.(msg);
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 10_000);
      pending.set(id, (msg) => {
        clearTimeout(t);
        msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
      });
      child.stdin.write(JSON.stringify(params === undefined ? { id, method } : { id, method, params }) + "\n");
    });
  return { child, call, events, exited, stderr: () => stderr };
}

const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  const value = await fn();
  results.push({ name, ms: Date.now() - t });
  console.log(`✓ ${name} (${Date.now() - t} ms)`, value === undefined ? "" : JSON.stringify(value).slice(0, 240));
  return value;
};

// 1. Normal run
const h = startHelper();
await step("ping", async () => {
  const r = await h.call("ping");
  assert.equal(typeof r.version, "string");
  return r;
});
await step("permissions.status", async () => {
  const r = await h.call("permissions.status");
  assert.equal(typeof r.accessibility, "boolean");
  assert.equal(typeof r.inputMonitoring, "boolean");
  assert.ok(["authorized", "denied", "notDetermined", "restricted"].includes(r.calendar));
  return r;
});
await step("app.frontmost", async () => {
  const r = await h.call("app.frontmost");
  assert.ok(r === null || (typeof r.name === "string" && typeof r.pid === "number"));
  return r;
});
await step("menus.list", async () => {
  const r = await h.call("menus.list", {});
  assert.ok(Array.isArray(r));
  for (const m of r.slice(0, 50)) assert.ok(Array.isArray(m.path) && m.path.length >= 2 && typeof m.enabled === "boolean");
  return { count: r.length, sample: r.slice(0, 3) };
});
await step("selection.text", async () => {
  const r = await h.call("selection.text");
  assert.ok("text" in r);
  return r;
});
await step("system.spotlightShortcut (read only)", async () => {
  const r = await h.call("system.spotlightShortcut");
  assert.equal(typeof r.enabled, "boolean");
  return r;
});
await step("unknown method → error", async () => {
  await assert.rejects(h.call("does.not.exist"), /Unknown method/);
});
await step("debug hook disabled outside dry-run", async () => {
  await assert.rejects(h.call("debug.hyperDryRun"), /Unknown method/);
});
await step("windows.apply without permission is graceful", async () => {
  const r = await h.call("windows.apply", { action: "left-half" });
  assert.equal(typeof r.ok, "boolean");
  return r;
});
await step("keys.configure (snippets only, hyper off) → ok or keys.tapFailed", async () => {
  const r = await h.call("keys.configure", { snippets: [{ keyword: ";;glide-smoke-test", text: "x" }], hyperKey: "off" });
  if (!r.ok) {
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(h.events.some((e) => e.event === "keys.tapFailed" && typeof e.data.reason === "string"));
  }
  const off = await h.call("keys.configure", { snippets: [], hyperKey: "off" });
  assert.equal(off.ok, true);
  return { first: r, events: h.events.map((e) => e.event) };
});
await step("clean exit on stdin EOF", async () => {
  h.child.stdin.end();
  const r = await h.exited;
  assert.deepEqual(r, { code: 0, signal: null });
  return r;
});

// 2. Dry-run hidutil path (no real key mapping changes)
const d = startHelper({ GLIDE_HELPER_DRY_RUN: "1" });
await step("hyper key mapping plan (dry run)", async () => {
  const r = await d.call("debug.hyperDryRun");
  assert.equal(r.activeWhileEnabled, true);
  assert.equal(r.restored, true);
  assert.equal(r.commands.length, 2);
  const enable = JSON.parse(r.commands[0]).UserKeyMapping;
  assert.ok(enable.some((m) => m.HIDKeyboardModifierMappingSrc === 0x700000039 && m.HIDKeyboardModifierMappingDst === 0x70000006d));
  const restore = JSON.parse(r.commands[1]).UserKeyMapping;
  assert.ok(!restore.some((m) => m.HIDKeyboardModifierMappingSrc === 0x700000039 && m.HIDKeyboardModifierMappingDst === 0x70000006d));
  return r;
});
await step("SIGTERM exits cleanly", async () => {
  d.child.kill("SIGTERM");
  const r = await d.exited;
  assert.equal(r.code, 0);
  return r;
});
assert.match(d.stderr(), /\[dry-run\] hidutil property --set/);
console.log(`\nall ${results.length} helper smoke checks passed`);
