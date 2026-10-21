// Performance suite: search latency over a 10k-item catalogue (engine-only and through the real
// IPC path), startup time to first render, and memory after warm-up. Writes
// tests/perf/out/perf-search.json and fails when search p95 exceeds tests/perf/thresholds.json.
//
//   node scripts/perf-search.mjs [--items=10000] [--queries=200] [--startup-runs=3] [--strict]
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchGlide, snapshotApp, ROOT, sleep, testTmpRoot, syntheticQuicklinks, perfQueries, rng } from "../tests/harness/index.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const ITEMS = Number(args.items ?? 10000);
const QUERIES = perfQueries(Number(args.queries ?? 200));
const STARTUP_RUNS = Number(args["startup-runs"] ?? 3);
// GLIDE_PERF_THRESHOLD_SCALE (or --scale) loosens every threshold on slow/shared hardware.
const SCALE = Number(args.scale ?? process.env.GLIDE_PERF_THRESHOLD_SCALE ?? 1);
const T = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(ROOT, "tests/perf/thresholds.json"), "utf8"))).map(([k, v]) => [k, typeof v === "number" ? v * SCALE : v]));
const OUT = path.join(ROOT, "tests/perf/out");

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const stats = (xs) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(2), p95: +pct(xs, 95).toFixed(2), p99: +pct(xs, 99).toFixed(2), max: +Math.max(...xs).toFixed(2), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) });

/** Engine only: bundle src/engine with esbuild and rank the same catalogue the app would see. */
async function engineOnly() {
  const outfile = path.join(testTmpRoot(), `engine-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(ROOT, "src/engine/index.ts")], outfile, bundle: true, format: "esm", platform: "node", target: "node22",
    alias: { "@shared": path.join(ROOT, "src/shared"), "@engine": path.join(ROOT, "src/engine") }, logLevel: "warning",
  });
  const { createEngine } = await import(pathToFileURL(outfile).href);
  rmSync(outfile, { force: true });
  const items = syntheticQuicklinks(ITEMS).map((q) => ({ id: `quicklink:${q.id}`, kind: "quicklink", title: q.name, subtitle: q.url, keywords: q.keywords, alias: q.alias, acceptsArgument: true }));
  const rnd = rng(3);
  const now = Date.now();
  const usage = Array.from({ length: 300 }, (_, i) => {
    const t = now - Math.floor(rnd() * 20) * 86_400_000;
    return { itemId: items[Math.floor(rnd() * items.length)].id, launches: [t], count: 1 + (i % 7), lastLaunchedAt: t };
  });
  const engine = createEngine({});
  const tSet = performance.now();
  engine.setItems(items);
  engine.setUsage(usage);
  const setItemsMs = performance.now() - tSet;
  for (const q of QUERIES.slice(0, 20)) engine.search(q); // JIT warm-up
  const times = [];
  let hits = 0; // rows returned (sum over sections), a sanity check that queries match
  for (const q of QUERIES) {
    const t0 = performance.now();
    hits += engine.search(q).sections.reduce((n, sec) => n + sec.items.length, 0);
    times.push(performance.now() - t0);
  }
  return { items: items.length, setItemsMs: +setItemsMs.toFixed(1), hits, ...stats(times) };
}

/** Spawn → renderer start, first paint and first result rows, from a cold process with a fresh data dir. */
async function startupOnce(appDir, catalogueSize) {
  const app = await launchGlide({ appDir, fixture: { catalogueSize } });
  try {
    const page = await app.launcher();
    await page.waitFor(() => document.querySelectorAll('[role="option"]').length > 0, { timeout: 20000, interval: 20 });
    const firstRowsAt = Date.now();
    const t = await page.eval(() => {
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      // Hidden (never shown) windows may not report paint timing; DOMContentLoaded is the fallback.
      return { origin: performance.timeOrigin, fcp: fcp ? fcp.startTime : null, domContentLoaded: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? null };
    });
    return {
      rendererStartMs: Math.round(t.origin - app.spawnedAt),
      domContentLoadedMs: t.domContentLoaded != null ? Math.round(t.origin + t.domContentLoaded - app.spawnedAt) : null,
      firstPaintMs: t.fcp != null ? Math.round(t.origin + t.fcp - app.spawnedAt) : null,
      // Upper bound: includes CDP connect/poll latency.
      firstRowsMs: firstRowsAt - app.spawnedAt,
    };
  } finally {
    await app.close();
  }
}

async function ipcAndMemory(appDir) {
  const app = await launchGlide({ appDir, fixture: { catalogueSize: ITEMS }, inspectMain: true });
  try {
    const page = await app.launcher();
    // Wait until the 10k catalogue is indexed (a synthetic item is findable).
    await page.waitFor(async () => {
      const r = await window.glide.search("report 12");
      return r.sections.some((s) => s.items.some((i) => String(i.item.id).startsWith("quicklink:fx-ql-")));
    }, { timeout: 30000, interval: 200, message: "10k catalogue indexed" });
    const catalogue = await page.eval(async () => (await window.glide.search("x")).total ?? null);
    const run = (qs) => page.eval(async (list) => {
      const times = [];
      let hits = 0;
      for (const q of list) {
        const t0 = performance.now();
        const r = await window.glide.search(q);
        times.push(performance.now() - t0);
        hits += r.sections.reduce((n, sec) => n + sec.items.length, 0);
      }
      return { times, hits };
    }, qs);
    await run(QUERIES.slice(0, 20)); // warm-up
    const { times, hits } = await run(QUERIES);
    // Touch a few views so memory reflects a used session, then let GC settle.
    for (const v of ["clipboard.history", "timers.list", "color.history"]) await page.eval((id) => window.__glideLauncher?.openView({ id, props: {} }), v).catch(() => {});
    await sleep(2000);
    await page.cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    await sleep(500);
    const heap = await page.cdp.send("Runtime.getHeapUsage").catch(() => null);
    const mainHeap = await app.mainEval(`(() => { globalThis.gc?.(); const m = process.memoryUsage(); return { heapUsedMb: +(m.heapUsed / 1048576).toFixed(1), heapTotalMb: +(m.heapTotal / 1048576).toFixed(1), externalMb: +(m.external / 1048576).toFixed(1), rssMb: +(m.rss / 1048576).toFixed(1) }; })()`).catch((e) => ({ error: e.message }));
    const mem = app.memory();
    const byType = {};
    for (const p of mem.processes) {
      const type = /Renderer/.test(p.command) ? "renderer" : /GPU/.test(p.command) ? "gpu" : /Helper/.test(p.command) ? "helper" : p.pid === app.pid ? "main" : "other";
      byType[type] = +((byType[type] ?? 0) + p.rssKb / 1024).toFixed(1);
    }
    return {
      ipc: { items: ITEMS, hits, ...stats(times) },
      memory: { totalRssMb: +(mem.totalKb / 1024).toFixed(1), byProcessMb: byType, processes: mem.processes.length, launcherJsHeapMb: heap ? +(heap.usedSize / 1048576).toFixed(1) : null, main: mainHeap },
      catalogueItemsConsidered: catalogue,
    };
  } finally {
    await app.close();
  }
}

const appDir = snapshotApp();
const engine = await engineOnly();
const startups = [];
for (let i = 0; i < STARTUP_RUNS; i++) startups.push(await startupOnce(appDir, 0));
const startupLarge = await startupOnce(appDir, ITEMS);
const { ipc, memory, catalogueItemsConsidered } = await ipcAndMemory(appDir);
const med = (k) => {
  const xs = startups.map((s) => s[k]).filter((x) => x != null);
  return xs.length ? pct(xs, 50) : null;
};
const result = {
  at: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version, ci: !!process.env.CI },
  queries: QUERIES.length,
  engine,
  ipc: { ...ipc, catalogueItemsConsidered },
  startup: { runs: startups, median: { rendererStartMs: med("rendererStartMs"), domContentLoadedMs: med("domContentLoadedMs"), firstPaintMs: med("firstPaintMs"), firstRowsMs: med("firstRowsMs") }, with10kCatalogue: startupLarge },
  memory,
  thresholds: T,
};
const checks = [
  { name: `engine p95 ${engine.p95} ms <= ${T.engineP95Ms} ms`, ok: engine.p95 <= T.engineP95Ms, hard: true },
  { name: `IPC p95 ${ipc.p95} ms <= ${T.ipcP95Ms} ms`, ok: ipc.p95 <= T.ipcP95Ms, hard: true },
  { name: `startup first rows ${result.startup.median.firstRowsMs} ms <= ${T.startupFirstRenderMs} ms`, ok: result.startup.median.firstRowsMs <= T.startupFirstRenderMs, hard: !!args.strict },
  { name: `memory ${memory.totalRssMb} MB <= ${T.memoryTotalMb} MB`, ok: memory.totalRssMb <= T.memoryTotalMb, hard: !!args.strict },
];
result.checks = checks;
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "perf-search.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ engine, ipc, startup: result.startup.median, startup10k: startupLarge, memory }, null, 2));
for (const c of checks) console.log(`${c.ok ? "PASS" : c.hard ? "FAIL" : "WARN"}  ${c.name}`);
const failed = checks.filter((c) => !c.ok && c.hard).length;
console.log(`\n[perf] ${failed ? `${failed} threshold(s) exceeded` : "within thresholds"} — ${path.relative(ROOT, path.join(OUT, "perf-search.json"))}`);
process.exit(failed ? 1 : 0);
