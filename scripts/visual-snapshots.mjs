// Visual regression: capture key screens headless in several themes and pixel-diff them
// against tests/visual/baselines. `--update` rewrites the baselines.
//
//   node scripts/visual-snapshots.mjs [--update] [--only=root-empty,timers] [--themes=glide-dark,nord]
//                                     [--threshold=24] [--max-ratio=0.003]
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { launchGlide, snapshotApp, testTmpRoot, ROOT, sleep, decodePng, encodePng, diffImages, maskRects, downscale } from "../tests/harness/index.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const UPDATE = !!args.update;
const THRESHOLD = Number(args.threshold ?? process.env.GLIDE_VISUAL_THRESHOLD ?? 24);
const MAX_RATIO = Number(args["max-ratio"] ?? process.env.GLIDE_VISUAL_MAX_RATIO ?? 0.003);
const THEMES = String(args.themes ?? "glide-dark,glide-light,nord").split(",");
const ONLY = args.only ? new Set(String(args.only).split(",")) : null;
const BASE_DIR = path.join(ROOT, "tests/visual/baselines");
const OUT_DIR = path.join(ROOT, "tests/visual/out");
const LAUNCHER_SIZE = { width: 760, height: 560 };
const SETTINGS_SIZE = { width: 1040, height: 720 };
// Translucent panels are composited over this, not over whatever is behind the window.
const BACKDROP = { r: 128, g: 128, b: 128, a: 1 };
// Elements whose content legitimately changes between runs.
const GLOBAL_MASKS = [".toast", "[data-test-dynamic]", "time", "[class*='clock']", "[class*='elapsed']"];

/**
 * Launcher screens. `view` pushes a registered launcher view (skipped when the view no longer
 * exists); `query` types into the search field; `after` runs extra steps.
 */
const LAUNCHER_SCREENS = [
  { id: "root-empty" },
  { id: "root-query", query: "fixture" },
  { id: "actions-panel", query: "fixture", after: async (p) => {
    await p.press("cmd+k");
    await p.waitForSelector('[role="dialog"][aria-label="Actions"], .actions', { timeout: 3000 });
  } },
  { id: "conversions", query: "10 km to mi" },
  { id: "clipboard-history", view: "clipboard.history", title: "Clipboard History" },
  { id: "timers", view: "timers.list", title: "Timers" },
  { id: "color-history", view: "color.history", title: "Color History" },
  { id: "transforms", view: "transforms.transform", title: "Transform Text" },
  { id: "themes", view: "appearance.switch", title: "Switch Theme" },
];
const SETTINGS_SCREENS = [
  { id: "settings-general", route: "general" },
  { id: "settings-appearance", route: "appearance" },
  { id: "settings-workflows", route: "workflows" },
];

const want = (id) => !ONLY || ONLY.has(id);

async function freshLauncher(page) {
  await page.cdp.send("Page.reload", { ignoreCache: false });
  await sleep(150);
  await page.waitForSelector("input", { timeout: 15000 });
  await page.stabilise();
  // A reload loses the "show" reset; the root list renders from the initial search.
  await page.waitFor(() => document.querySelectorAll('[role="option"]').length > 0, { timeout: 8000 }).catch(() => {});
}

async function applyTheme(page, theme) {
  const r = await page.eval((id) => window.glide.feature("appearance", "applyPreset", id), theme);
  if (!r?.ok) throw new Error(`theme ${theme} not applied: ${JSON.stringify(r)}`);
  await sleep(400);
}

async function capture(page, size, masks) {
  await page.waitForIdle({ quietMs: 250, timeout: 3000 });
  await sleep(100);
  const rects = await page.rects([...GLOBAL_MASKS, ...(masks ?? [])]);
  let img = decodePng(await page.screenshot({ background: BACKDROP }));
  // Hosts that ignore the 1x override (rare) still produce 1x baselines.
  const factor = Math.round(img.width / size.width);
  if (factor > 1) img = downscale(img, factor);
  return maskRects(img, rects);
}

function compare(theme, id, img, results) {
  const file = path.join(BASE_DIR, theme, `${id}.png`);
  const rel = path.relative(ROOT, file);
  if (UPDATE || !existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, encodePng(img));
    results.push({ theme, id, status: UPDATE ? "updated" : "new", baseline: rel });
    return;
  }
  const base = decodePng(readFileSync(file));
  const d = diffImages(base, img, { threshold: THRESHOLD });
  const ok = !d.sizeMismatch && d.ratio <= MAX_RATIO;
  const entry = { theme, id, status: ok ? "pass" : "fail", ratio: Number(d.ratio.toFixed(5)), diffPixels: d.diffPixels, baseline: rel };
  if (!ok) {
    const dir = path.join(OUT_DIR, theme);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.actual.png`), encodePng(img));
    writeFileSync(path.join(dir, `${id}.diff.png`), encodePng(d.diff));
    entry.actual = path.relative(ROOT, path.join(dir, `${id}.actual.png`));
    entry.diff = path.relative(ROOT, path.join(dir, `${id}.diff.png`));
    if (d.sizeMismatch) entry.size = `${base.width}x${base.height} -> ${img.width}x${img.height}`;
  }
  results.push(entry);
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  const results = [];
  // A fixed data-dir path: some rows show paths under it (fake HOME), which must not vary per run.
  const dataDir = path.join(testTmpRoot(), "visual-data");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const app = await launchGlide({ fixture: { theme: "dark" }, appDir: snapshotApp(), dataDir });
  try {
    const launcher = await app.launcher();
    await launcher.setViewport(LAUNCHER_SIZE.width, LAUNCHER_SIZE.height);
    await launcher.waitForIdle({ quietMs: 300 });
    const views = new Set((await launcher.eval("window.__glideLauncher?.views() ?? []")) ?? []);

    for (const theme of THEMES) {
      await applyTheme(launcher, theme);
      for (const s of LAUNCHER_SCREENS) {
        if (!want(s.id)) continue;
        if (s.view && !views.has(s.view)) {
          results.push({ theme, id: s.id, status: "skipped", detail: `view ${s.view} not registered` });
          continue;
        }
        try {
          await freshLauncher(launcher);
          if (s.view) {
            const pushed = await launcher.eval((v, t) => window.__glideLauncher.openView({ id: v, props: { title: t } }), s.view, s.title ?? s.view);
            if (pushed === false) throw new Error(`openView(${s.view}) returned false`);
            await launcher.waitForSelector(`.launcher__view`, { timeout: 4000 });
          }
          if (s.query) {
            await launcher.type(s.query, { selector: "input" });
            await sleep(350);
          }
          if (s.after) await s.after(launcher);
          compare(theme, s.id, await capture(launcher, LAUNCHER_SIZE, s.masks), results);
        } catch (err) {
          results.push({ theme, id: s.id, status: "error", detail: String(err.message ?? err) });
        }
      }
    }

    const settingsWanted = SETTINGS_SCREENS.filter((s) => want(s.id));
    if (settingsWanted.length) {
      const settings = await app.settings("general", { via: launcher });
      await settings.setViewport(SETTINGS_SIZE.width, SETTINGS_SIZE.height);
      await settings.waitForIdle({ quietMs: 300 });
      for (const theme of THEMES) {
        await applyTheme(settings, theme);
        for (const s of settingsWanted) {
          try {
            await settings.eval((r) => (location.hash = `#/settings/${r}`), s.route);
            await sleep(200);
            await settings.stabilise();
            await settings.eval(() => {
              document.activeElement?.blur?.();
              for (const el of document.querySelectorAll("*")) if (el.scrollTop) el.scrollTop = 0;
            });
            compare(theme, s.id, await capture(settings, SETTINGS_SIZE, s.masks), results);
          } catch (err) {
            results.push({ theme, id: s.id, status: "error", detail: String(err.message ?? err) });
          }
        }
      }
    }
  } finally {
    await app.close();
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify({ threshold: THRESHOLD, maxRatio: MAX_RATIO, results }, null, 2));
  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(8)} ${r.theme.padEnd(12)} ${r.id.padEnd(20)} ${r.ratio !== undefined ? `diff=${(r.ratio * 100).toFixed(3)}%` : ""} ${r.detail ?? r.diff ?? ""}`);
  const bad = results.filter((r) => r.status === "fail" || r.status === "error");
  console.log(`\n[visual] ${results.length - bad.length}/${results.length} ok (${UPDATE ? "baselines updated" : `threshold ${THRESHOLD}, max ratio ${MAX_RATIO}`})`);
  process.exit(bad.length ? 1 : 0);
}

await main();
