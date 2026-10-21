// Keyboard & accessibility audit: walks every registered launcher view and every settings page
// (from the renderer registry, so new features are picked up automatically) and checks that
// interactive elements are keyboard reachable, named, show a focus indicator and that text meets
// WCAG AA contrast. Fails on violations that are not in tests/a11y/baseline.json.
//
//   node scripts/a11y-audit.mjs [--update] [--only=launcher|settings] [--verbose]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { launchGlide, snapshotApp, ROOT, sleep } from "../tests/harness/index.mjs";
import { activeSignature, auditDocument, auditFocusRings, tabbableSignatures } from "../tests/harness/a11y-probe.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const BASELINE = path.join(ROOT, "tests/a11y/baseline.json");
const OUT = path.join(ROOT, "tests/a11y/out");
const RULES = ["name", "keyboard", "focus-visible", "contrast", "arrow-nav", "tab-order", "crash"];

/** Views that need props from the item that opens them; opening them bare is not a meaningful audit. */
const SKIP_VIEWS = new Set(String(args["skip-views"] ?? "").split(",").filter(Boolean));

async function keyboardModality(page) {
  // A real key press makes later programmatic focus match :focus-visible (Chromium heuristic).
  await page.press("Shift", { delay: 0 });
}

async function arrowNav(page, screen) {
  const before = await page.eval(() => {
    const opts = [...document.querySelectorAll('[role="listbox"] [role="option"]')].filter((o) => o.getClientRects().length);
    if (opts.length < 2) return null;
    const input = document.querySelector('.launcher input, input');
    input?.focus();
    return { n: opts.length, sel: opts.findIndex((o) => o.getAttribute("aria-selected") === "true"), active: input?.getAttribute("aria-activedescendant") ?? null };
  });
  if (!before) return [];
  await page.press("ArrowDown");
  await sleep(80);
  const after = await page.eval(() => {
    const opts = [...document.querySelectorAll('[role="listbox"] [role="option"]')].filter((o) => o.getClientRects().length);
    return { sel: opts.findIndex((o) => o.getAttribute("aria-selected") === "true"), active: document.querySelector('.launcher input, input')?.getAttribute("aria-activedescendant") ?? null };
  });
  const moved = after.sel !== before.sel || after.active !== before.active;
  return moved ? [] : [{ rule: "arrow-nav", key: `arrow-nav|${screen}`, detail: `ArrowDown did not move the selection (${JSON.stringify({ before, after })})` }];
}

async function tabWalk(page, screen) {
  await page.eval(() => document.activeElement?.blur?.());
  const expected = await page.eval(tabbableSignatures);
  if (!expected.length) return { reached: 0, expected: 0, violations: [] };
  const seen = [];
  const violations = [];
  let stuck = 0;
  const limit = Math.min(expected.length + 5, 200);
  for (let i = 0; i < limit; i++) {
    await page.press("Tab", { delay: 15 });
    const sig = await page.eval(activeSignature);
    if (!sig) continue;
    if (seen.length && seen[seen.length - 1] === sig) {
      if (++stuck >= 2) {
        const label = expected.find((e) => e.path === sig)?.label ?? sig;
        violations.push({ rule: "tab-order", key: `tab-order|trap ${screen} ${label}`, detail: `Tab does not leave ${label}` });
        break;
      }
      continue;
    }
    stuck = 0;
    if (seen.includes(sig)) break; // wrapped around
    seen.push(sig);
  }
  const reached = new Set(seen);
  for (const e of expected) if (!reached.has(e.path)) violations.push({ rule: "tab-order", key: `tab-order|unreached ${screen} ${e.label}`, detail: "focusable but not reached with Tab" });
  return { reached: expected.filter((e) => reached.has(e.path)).length, expected: expected.length, violations };
}

async function auditScreen(page, screen, { tab = false, nav = true } = {}) {
  const since = Date.now();
  await keyboardModality(page);
  const doc = await page.eval(auditDocument, screen);
  const rings = await page.eval(auditFocusRings, screen);
  const violations = [...doc.violations, ...rings.violations];
  if (nav) violations.push(...(await arrowNav(page, screen)));
  let tabInfo;
  if (tab) {
    tabInfo = await tabWalk(page, screen);
    violations.push(...tabInfo.violations);
  }
  const crashes = page.errorsSince(since).filter((e) => /crashed|Uncaught|TypeError|ReferenceError/.test(e.text));
  for (const c of crashes) violations.push({ rule: "crash", key: `crash|${screen} ${c.text.split("\n")[0].slice(0, 80)}`, detail: c.text.slice(0, 300) });
  // One entry per key (repeated rows collapse), keeping a count.
  const byKey = new Map();
  for (const v of violations) {
    const e = byKey.get(v.key);
    if (e) e.count++;
    else byKey.set(v.key, { ...v, screen, count: 1 });
  }
  return { screen, interactive: doc.interactive, focusables: doc.focusables, textChecked: doc.textChecked, ringsChecked: rings.checked, tab: tabInfo, violations: [...byKey.values()] };
}

async function reloadLauncher(page) {
  await page.cdp.send("Page.reload", {});
  await sleep(150);
  await page.waitForSelector("input", { timeout: 15000 });
  await page.addStyle("body *{pointer-events:none!important}");
  await page.waitFor(() => document.querySelectorAll('[role="option"]').length > 0, { timeout: 8000 }).catch(() => {});
}

async function main() {
  const screens = [];
  const app = await launchGlide({ fixture: { theme: "dark" }, appDir: snapshotApp() });
  try {
    if (args.only !== "settings") {
      const l = await app.launcher();
      await l.setViewport(760, 560);
      await reloadLauncher(l);
      screens.push(await auditScreen(l, "launcher:root"));
      await reloadLauncher(l);
      await l.type("fixture", { selector: "input" });
      await sleep(400);
      screens.push(await auditScreen(l, "launcher:root-query"));
      await l.press("cmd+k");
      await l.waitForSelector('[role="dialog"][aria-label="Actions"], .actions', { timeout: 3000 }).catch(() => {});
      screens.push(await auditScreen(l, "launcher:actions-panel", { nav: false }));

      const views = (await l.eval("window.__glideLauncher?.views() ?? []")) ?? [];
      for (const v of views) {
        if (SKIP_VIEWS.has(v)) continue;
        if (args.verbose) console.error(`[a11y] view ${v}`);
        await reloadLauncher(l);
        const pushed = await l.eval((id) => window.__glideLauncher.openView({ id, props: {} }), v);
        if (pushed === false) {
          screens.push({ screen: `view:${v}`, interactive: 0, focusables: 0, textChecked: 0, ringsChecked: 0, violations: [{ rule: "crash", key: `crash|view:${v} openView false`, detail: "openView returned false", count: 1 }] });
          continue;
        }
        await sleep(450);
        await l.waitForIdle({ quietMs: 150, timeout: 1500 });
        screens.push(await auditScreen(l, `view:${v}`));
      }
    }

    if (args.only !== "launcher") {
      let s = await app.settings("general");
      await s.setViewport(1040, 720);
      await s.addStyle("body *{pointer-events:none!important}");
      // Discover every sidebar page by activating each entry (programmatic click, no real pointer).
      const routes = await s.eval(async () => {
        const out = [];
        const items = [...document.querySelectorAll(".sidebar .navitem, nav [role='tab'], nav a, nav button")];
        for (let i = 0; i < items.length; i++) {
          const el = [...document.querySelectorAll(".sidebar .navitem, nav [role='tab'], nav a, nav button")][i];
          el?.click();
          await new Promise((r) => setTimeout(r, 60));
          if (!out.includes(location.hash)) out.push(location.hash);
        }
        return out;
      });
      for (const r of routes) {
        const screen = `settings:${r.replace(/^#\/settings\/?/, "") || "general"}`;
        try {
          await s.eval((h) => (location.hash = h), r);
          await sleep(350);
          await s.waitForIdle({ quietMs: 150, timeout: 1500 });
          screens.push(await auditScreen(s, screen, { tab: true, nav: false }));
        } catch (err) {
          // The page went away (renderer crash or the window closed itself): record it and reopen.
          screens.push({ screen, interactive: 0, focusables: 0, textChecked: 0, ringsChecked: 0, violations: [{ rule: "crash", key: `crash|${screen} ${String(err.message).slice(0, 60)}`, detail: String(err.message), count: 1 }] });
          s.close();
          s = await app.settings("general");
          await s.setViewport(1040, 720);
          await s.addStyle("body *{pointer-events:none!important}");
        }
      }
    }
  } finally {
    await app.close();
  }

  const current = [...new Set(screens.flatMap((s) => s.violations.map((v) => v.key)))].sort();
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  const known = new Set(baseline?.violations ?? []);
  const fresh = current.filter((k) => !known.has(k));
  const fixed = [...known].filter((k) => !current.includes(k));

  // Table
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad("screen", 34)}${pad("inter", 6)}${pad("focus", 6)}${pad("text", 6)}${RULES.map((r) => pad(r.replace("focus-visible", "ring").replace("arrow-nav", "nav").replace("tab-order", "tab"), 9)).join("")}new`);
  for (const s of screens) {
    const counts = Object.fromEntries(RULES.map((r) => [r, s.violations.filter((v) => v.rule === r).length]));
    const nNew = s.violations.filter((v) => !known.has(v.key)).length;
    console.log(`${pad(s.screen.slice(0, 33), 34)}${pad(s.interactive, 6)}${pad(s.focusables, 6)}${pad(s.textChecked, 6)}${RULES.map((r) => pad(counts[r] || "·", 9)).join("")}${nNew || "·"}`);
  }
  const totals = Object.fromEntries(RULES.map((r) => [r, screens.reduce((n, s) => n + s.violations.filter((v) => v.rule === r).length, 0)]));
  console.log(`\nscreens: ${screens.length}  violations: ${current.length} (${RULES.map((r) => `${r} ${totals[r]}`).join(", ")})`);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ screens, newViolations: fresh, fixed }, null, 2));
  if (args.verbose || fresh.length) {
    const detail = new Map();
    for (const s of screens) for (const v of s.violations) {
      const d = detail.get(v.key) ?? { detail: v.detail, screens: [] };
      d.screens.push(s.screen);
      detail.set(v.key, d);
    }
    for (const k of args.verbose ? current : fresh) {
      const d = detail.get(k);
      console.log(`${known.has(k) ? "  known" : "  NEW  "} ${k}  — ${d?.detail ?? ""}  [${d?.screens.length > 3 ? `${d.screens.slice(0, 3).join(", ")} +${d.screens.length - 3}` : d?.screens.join(", ")}]`);
    }
  }
  if (args.update || !baseline) {
    mkdirSync(path.dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify({ note: "Known a11y violations; regenerate with `pnpm test:a11y -- --update` after fixing or accepting them.", violations: current }, null, 2) + "\n");
    console.log(`\n[a11y] baseline ${baseline ? "updated" : "created"} with ${current.length} known violations (${path.relative(ROOT, BASELINE)})`);
    process.exit(0);
  }
  if (fixed.length) console.log(`\n[a11y] ${fixed.length} baseline violations are fixed — run with --update to lock that in.`);
  console.log(`[a11y] ${fresh.length ? `FAIL: ${fresh.length} new violation(s)` : "PASS: no new violations"} (report: ${path.relative(ROOT, path.join(OUT, "report.json"))})`);
  process.exit(fresh.length ? 1 : 0);
}

await main();
