// Shared helpers for the MCP conformance scripts: spawn Glide headless with its test channel, a tiny check
// recorder, and process bookkeeping so every child we start is killed (by pid, never by name).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const here = path.dirname(new URL(import.meta.url).pathname);
export const macosRoot = path.resolve(here, "../..");

export function binaryPath() {
  const i = process.argv.indexOf("--binary");
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  if (process.env.GLIDE_BINARY) return path.resolve(process.env.GLIDE_BINARY);
  return path.join(macosRoot, ".build/debug/Glide");
}

/** A fresh data dir under $GLIDE_E2E_TMP (or $TMPDIR). */
export function freshDir(prefix) {
  const root = process.env.GLIDE_E2E_TMP || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${prefix}-`));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- checks ----------
export const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  return !!ok;
}
export async function checkAsync(name, fn) {
  try {
    const r = await fn();
    if (r === false) return check(name, false, "returned false");
    return check(name, true);
  } catch (e) {
    return check(name, false, e?.stack?.split("\n").slice(0, 3).join(" | ") ?? String(e));
  }
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  return failed.length;
}
export function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- child bookkeeping ----------
const children = new Set();
export function track(child) {
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
export function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
export async function killChild(child, graceMs = 1500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch {}
  const end = Date.now() + graceMs;
  while (Date.now() < end && child.exitCode === null && child.signalCode === null) await sleep(25);
  if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch {} await sleep(50); }
}
process.on("exit", () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

// ---------- Glide over the test channel ----------
export class Glide {
  constructor({ binary = binaryPath(), dataDir = freshDir("glide-conf"), env = {} } = {}) {
    this.binary = binary;
    this.dataDir = dataDir;
    this.pending = new Map();
    this.nextId = 1;
    this.lines = [];
    this.child = track(spawn(binary, ["--test-server"], {
      env: { ...process.env, GLIDE_HEADLESS: "1", GLIDE_TEST_SERVER: "1", GLIDE_USER_DATA: dataDir, GLIDE_TEST_PARENT_PID: String(process.pid), GLIDE_HELPER_DRY_RUN: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }));
    this.pid = this.child.pid;
    this.child.stderr.on("data", (d) => { this.stderr = ((this.stderr ?? "") + d).slice(-8000); });
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Glide not ready after 30 s")), 30_000);
      readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
        this.lines.push(line);
        if (line.startsWith("[headless]")) return;
        let obj;
        try { obj = JSON.parse(line); } catch { return; }
        if (obj.event === "ready") { clearTimeout(t); return resolve(obj); }
        this.pending.get(obj.id)?.(obj);
      });
      this.child.on("exit", (code) => { clearTimeout(t); reject(new Error(`Glide exited early (${code})`)); });
    });
  }

  send(cmd, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`test channel timeout: ${JSON.stringify(cmd)}`)); }, timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(t); this.pending.delete(id); resolve(r); });
      this.child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }

  async invoke(feature, method, args = null) {
    const r = await this.send({ cmd: "invoke", feature, method, args });
    if (r.ok === false) throw new Error(`invoke ${feature}/${method}: ${r.error}`);
    return r.result;
  }

  async stop() {
    if (this.child.exitCode === null) {
      await Promise.race([this.send({ cmd: "quit" }, 4000).catch(() => {}), sleep(4000)]);
      const end = Date.now() + 3000;
      while (Date.now() < end && this.child.exitCode === null && this.child.signalCode === null) await sleep(25);
    }
    await killChild(this.child);
    return !alive(this.pid);
  }
}
