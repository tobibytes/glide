#!/usr/bin/env node
// Node driver for the Glide test channel (no dependencies). Usage:
//   node Tests/Harness/glide-driver.mjs [--binary .build/debug/Glide] [--seed data.json] [--keep] script.json
// script.json: [{ "cmd": "show" }, { "cmd": "type", "text": "saf", "expect": { "rows.0.title": "Safari" } }, …]
// `expect` maps dotted paths of the response to expected values (deep-equal on JSON). `"print": true` echoes the
// response. Exit code 1 on failure.
// The app always runs headless with a temp GLIDE_USER_DATA, exits if this process dies (GLIDE_TEST_PARENT_PID),
// and is killed with SIGTERM then SIGKILL when the script ends.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const binary = opt("--binary") ?? process.env.GLIDE_BINARY ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.build/debug/Glide");
const seed = opt("--seed");
const keep = args.includes("--keep") && args.splice(args.indexOf("--keep"), 1);
const script = JSON.parse(fs.readFileSync(args[0], "utf8"));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "glide-e2e-"));
if (seed) fs.copyFileSync(seed, path.join(dataDir, "data.json"));
const child = spawn(binary, ["--test-server"], {
  env: { ...process.env, GLIDE_HEADLESS: "1", GLIDE_TEST_SERVER: "1", GLIDE_USER_DATA: dataDir, GLIDE_TEST_PARENT_PID: String(process.pid), GLIDE_HELPER_DRY_RUN: "1" },
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
let ready;
const readyP = new Promise((r) => (ready = r));
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  if (line.startsWith("[headless]")) return console.log(line);
  let obj;
  try { obj = JSON.parse(line); } catch { return console.log(line); }
  if (obj.event === "ready") return ready(obj);
  pending.get(obj.id)?.(obj);
});

let nextId = 1;
const send = (cmd, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(cmd)}`)), timeoutMs);
  pending.set(id, (r) => { clearTimeout(t); pending.delete(id); resolve(r); });
  child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
});
const get = (obj, p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const kill = () => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1500).unref();
};
process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} if (!keep) fs.rmSync(dataDir, { recursive: true, force: true }); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { kill(); process.exit(130); });

let failed = 0;
try {
  await Promise.race([readyP, new Promise((_, rej) => setTimeout(() => rej(new Error("app not ready")), 20000))]);
  for (const step of script) {
    const { expect, print, ...cmd } = step;
    const res = await send(cmd);
    let ok = res.ok !== false;
    for (const [p, want] of Object.entries(expect ?? {})) {
      const got = get(res, p);
      if (JSON.stringify(got) !== JSON.stringify(want)) { ok = false; console.log(`  ✗ ${p}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
    }
    console.log(`${ok ? "✓" : "✗"} ${JSON.stringify(cmd)}`);
    if (print) console.log(`    → ${JSON.stringify(res)}`);
    if (!ok) failed++;
  }
  await send({ cmd: "quit" }).catch(() => {});
} catch (e) {
  console.error(String(e));
  failed++;
} finally {
  kill();
}
console.log(failed ? `${failed} step(s) failed` : "all steps passed");
process.exitCode = failed ? 1 : 0;
