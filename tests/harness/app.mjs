// Launch Glide headless with an isolated data dir and guaranteed cleanup.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectCdp, listTargets } from "./cdp.mjs";
import { seedDataDir } from "./fixtures.mjs";
import { Page, sleep } from "./page.mjs";
import { allocatePort, releasePort } from "./ports.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The electron package exports the real binary; spawning node_modules/.bin/electron would only
// kill the wrapper and orphan Electron (which then holds the single-instance lock).
const ELECTRON = createRequire(import.meta.url)("electron");

/** Where per-run data dirs go: GLIDE_TEST_TMP, else the OS temp dir. */
export function testTmpRoot() {
  const dir = process.env.GLIDE_TEST_TMP ?? path.join(tmpdir(), "glide-tests");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copy the built app (dist/ + package.json) to a private directory so a parallel `pnpm build`
 * cannot swap bundles under a running suite. node_modules and other assets are symlinked.
 * Returns the directory to pass as `appDir`. Disable with GLIDE_TEST_SNAPSHOT=0.
 */
export function snapshotApp() {
  if (process.env.GLIDE_TEST_SNAPSHOT === "0") return ROOT;
  for (const f of ["dist/main/index.cjs", "dist/preload/index.cjs", "dist/renderer/index.html"])
    if (!existsSync(path.join(ROOT, f))) throw new Error(`${f} missing: run \`pnpm build\` first`);
  const dir = mkdtempSync(path.join(testTmpRoot(), "app-"));
  cpSync(path.join(ROOT, "dist"), path.join(dir, "dist"), { recursive: true });
  cpSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  for (const link of ["node_modules", "build", "extensions-examples", "store"])
    if (existsSync(path.join(ROOT, link))) symlinkSync(path.join(ROOT, link), path.join(dir, link));
  snapshots.add(dir);
  return dir;
}
const snapshots = new Set();
function removeSnapshots() {
  for (const d of snapshots) rmSync(d, { recursive: true, force: true });
  snapshots.clear();
}

const live = new Set();
let hooksInstalled = false;
function installCleanupHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // Last resort: synchronous SIGKILL of everything we started (exit handlers cannot await).
  process.on("exit", () => {
    for (const a of live) a.cleanupSync();
    removeSnapshots();
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      for (const a of live) a.cleanupSync();
      process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[sig] ?? 0));
    });
  }
  process.on("uncaughtException", (err) => {
    console.error("[harness] uncaught:", err);
    for (const a of live) a.cleanupSync();
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[harness] unhandled rejection:", err);
    for (const a of live) a.cleanupSync();
    process.exit(1);
  });
}

/** PIDs of every descendant of `pid` (read-only `ps`). */
export function descendants(pid) {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of out.trim().split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp).push(p);
  }
  const found = [];
  const walk = (p) => {
    for (const c of children.get(p) ?? []) {
      found.push(c);
      walk(c);
    }
  };
  walk(pid);
  return found;
}

/** Resident set size (KB) of `pid` and all its descendants, per process. */
export function processTreeRss(pid) {
  const pids = [pid, ...descendants(pid)];
  let out = "";
  try {
    out = execFileSync("ps", ["-o", "pid=,rss=,comm=", "-p", pids.join(",")], { encoding: "utf8" });
  } catch {
    return { totalKb: 0, processes: [] };
  }
  const processes = out.trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), rssKb: Number(m[2]), command: path.basename(m[3]) } : null;
  }).filter(Boolean);
  return { totalKb: processes.reduce((s, p) => s + p.rssKb, 0), processes };
}

export class GlideApp {
  constructor({ proc, port, dataDir, keepData, spawnedAt }) {
    this.proc = proc;
    this.pid = proc.pid;
    this.port = port;
    this.dataDir = dataDir;
    this.keepData = keepData;
    this.spawnedAt = spawnedAt;
    this.lines = [];
    this.pages = new Set();
    this.exited = false;
    this.exitCode = null;
    this._exit = new Promise((resolve) => proc.once("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code ?? signal;
      resolve();
    }));
    let buf = "";
    const onData = (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.lines.push({ at: Date.now(), line });
        if (process.env.GLIDE_TEST_DEBUG) console.error(`[glide:${this.pid}] ${line}`);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    // Node's WebSocket does not keep the event loop alive while awaiting CDP replies.
    this._keepAlive = setInterval(() => {}, 1000);
  }

  get log() {
    return this.lines.map((l) => l.line).join("\n");
  }

  /** Parsed "[headless] <kind> <detail>" lines (optionally filtered by kind). */
  headless(kind) {
    const out = [];
    for (const { at, line } of this.lines) {
      const m = line.match(/^\[headless\] (\S+) ?(.*)$/);
      if (!m || (kind && m[1] !== kind)) continue;
      let detail = m[2];
      try {
        detail = JSON.parse(m[2]);
      } catch {}
      out.push({ at, kind: m[1], detail });
    }
    return out;
  }

  /** Wait for a log line matching `re` that arrived after `since` (ms epoch). */
  async waitForLog(re, { timeout = 5000, since = 0 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const hit = this.lines.find((l) => l.at >= since && re.test(l.line));
      if (hit) return hit.line;
      if (this.exited) break;
      await sleep(50);
    }
    throw new Error(`log line ${re} not seen within ${timeout} ms`);
  }

  /** Error-looking lines, minus Chromium/macOS noise. */
  errors() {
    return this.lines.map((l) => l.line).filter((l) => /\b(Error|Uncaught|TypeError|ReferenceError)\b/.test(l) && !/DevTools|Autofill|GPU|CoreText|IMKClient|NSOpenPanel|\[headless\]/.test(l));
  }

  async targets() {
    return (await listTargets(this.port)).filter((t) => t.type === "page");
  }

  /**
   * Connect to a renderer page. `which` is "launcher", "settings", a hash prefix ("#/settings/general")
   * or a predicate over the CDP target.
   */
  async page(which = "launcher", { timeout = 20000 } = {}) {
    const match =
      typeof which === "function" ? which
      : which === "launcher" ? (t) => { const h = new URL(t.url).hash; return t.url.startsWith("file:") || t.url.startsWith("http") ? h === "" || h === "#/" || h === "#" : false; }
      : which === "settings" ? (t) => new URL(t.url).hash.startsWith("#/settings")
      : (t) => new URL(t.url).hash.startsWith(which);
    const t0 = Date.now();
    let lastErr;
    while (Date.now() - t0 < timeout) {
      if (this.exited) throw new Error(`Glide exited (${this.exitCode}) before page ${which} appeared:\n${this.log.slice(-2000)}`);
      try {
        const target = (await this.targets()).find(match);
        if (target) {
          const page = await Page.connect(target);
          this.pages.add(page);
          return page;
        }
      } catch (err) {
        lastErr = err;
      }
      await sleep(150);
    }
    throw new Error(`page ${which} not found within ${timeout} ms${lastErr ? `: ${lastErr.message}` : ""}`);
  }

  /** The launcher page once the React root rendered (search field present). */
  async launcher(opts = {}) {
    const page = await this.page("launcher", opts);
    await page.waitForSelector(".launcher input, input", { timeout: opts.timeout ?? 20000 });
    return page;
  }

  /** Open settings (optionally on `route`, e.g. "appearance") and return its page. */
  async settings(route = "", { via } = {}) {
    const launcher = via ?? (await this.launcher());
    await launcher.eval((r) => window.glide.openSettings(r || undefined), route);
    const page = await this.page("settings");
    await page.waitForSelector(".sidebar, nav, main", { timeout: 15000 });
    return page;
  }

  memory() {
    return processTreeRss(this.pid);
  }

  /**
   * Evaluate an expression in the MAIN process (needs `inspectMain: true`). The expression runs in
   * the inspector's global scope: use `process`, `globalThis`; `require` is process.mainModule.require.
   */
  async mainEval(expression, { timeout = 10000 } = {}) {
    if (!this.inspectPort) throw new Error("launch with { inspectMain: true } to evaluate in main");
    if (!this._main) {
      const t0 = Date.now();
      let target;
      while (!target && Date.now() - t0 < timeout) {
        target = (await listTargets(this.inspectPort).catch(() => []))[0];
        if (!target) await sleep(100);
      }
      if (!target) throw new Error("main inspector not reachable");
      this._main = await connectCdp(target.webSocketDebuggerUrl);
      this.pages.add({ close: () => this._main.close() });
    }
    const r = await this._main.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
    if (r.exceptionDetails) throw new Error(`main eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }

  killSync() {
    if (this.exited) return;
    for (const p of [...descendants(this.pid), this.pid]) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
  }

  /** Synchronous kill + data-dir removal for exit paths that cannot await. */
  cleanupSync() {
    this.killSync();
    live.delete(this);
    if (!this.keepData) {
      try {
        rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {}
    }
  }

  async close() {
    live.delete(this);
    clearInterval(this._keepAlive);
    for (const p of this.pages) p.close();
    if (!this.exited) {
      // Only processes we spawned (and their descendants) are ever signalled.
      const kids = descendants(this.pid);
      this.proc.kill("SIGTERM");
      await Promise.race([this._exit, sleep(4000)]);
      if (!this.exited) this.proc.kill("SIGKILL");
      await Promise.race([this._exit, sleep(2000)]);
      for (const k of kids) {
        try {
          process.kill(k, 0);
          process.kill(k, "SIGKILL");
        } catch {}
      }
    }
    releasePort(this.port);
    if (this.inspectPort) releasePort(this.inspectPort);
    if (!this.keepData) {
      for (let i = 0; i < 3; i++) {
        try {
          rmSync(this.dataDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(200);
        }
      }
    }
  }
}

/**
 * Start Glide headless.
 * @param {{ fixture?: boolean | object, dataDir?: string, port?: number, appDir?: string, env?: Record<string,string>,
 *   keepData?: boolean, helper?: boolean, realHome?: boolean, realKeychain?: boolean, inspectMain?: boolean, watchdogMs?: number, extraArgs?: string[] }} [opts]
 */
export async function launchGlide(opts = {}) {
  installCleanupHooks();
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(testTmpRoot(), "data-"));
  let seeded;
  if (opts.fixture !== false) seeded = seedDataDir(dataDir, typeof opts.fixture === "object" ? opts.fixture : {});
  const port = opts.port ?? (await allocatePort());
  const inspectPort = opts.inspectMain ? await allocatePort() : null;
  const appDir = opts.appDir ?? process.env.GLIDE_APP_DIR ?? ROOT;
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    // The helper is disabled by default (deterministic, no TCC prompts): features must degrade gracefully.
    ...(opts.helper ? {} : { GLIDE_HELPER_PATH: path.join(dataDir, "no-helper") }),
    GLIDE_UPDATE_BASE_URL: "http://127.0.0.1:9/",
    // A fixture home: features that read ~ (browser bookmarks, scripts, notes, file index) see
    // fixture data instead of the user's. Opt out with { realHome: true }.
    ...(opts.realHome ? {} : { HOME: path.join(dataDir, "home") }),
    // The first-run tour opens its own window on fresh data dirs; suites opt in with { env: { GLIDE_SKIP_ONBOARDING: "0" } }.
    GLIDE_SKIP_ONBOARDING: "1",
    ...(opts.env ?? {}),
    // Not overridable: tests must never put anything on screen.
    GLIDE_HEADLESS: "1",
    GLIDE_USER_DATA: dataDir,
    GLIDE_SHOW_ON_START: "1",
  };
  delete env.GLIDE_DEV_SERVER;
  delete env.ELECTRON_RUN_AS_NODE;
  const spawnedAt = Date.now();
  const proc = spawn(ELECTRON, [`--remote-debugging-port=${port}`, "--remote-allow-origins=*", ...(inspectPort ? [`--inspect=127.0.0.1:${inspectPort}`] : []),
    // safeStorage (AI/agent key stores) would otherwise read/create items in the user's login keychain.
    ...(opts.realKeychain ? [] : ["--use-mock-keychain"]),
    ...(opts.extraArgs ?? []), appDir], {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const app = new GlideApp({ proc, port, dataDir, keepData: opts.keepData, spawnedAt });
  app.seeded = seeded;
  app.inspectPort = inspectPort;
  live.add(app);
  const watchdogMs = opts.watchdogMs ?? Number(process.env.GLIDE_TEST_WATCHDOG_MS ?? 300000);
  const wd = setTimeout(() => {
    console.error(`[harness] watchdog: killing Glide pid ${app.pid} after ${watchdogMs} ms`);
    app.killSync();
  }, watchdogMs);
  wd.unref();
  proc.once("exit", () => clearTimeout(wd));
  return app;
}

/** Launch, run `fn(app)`, and always clean up. */
export async function withGlide(opts, fn) {
  const app = await launchGlide(opts);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}
