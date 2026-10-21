// Headless end-to-end smoke suite built on tests/harness. Written to survive UI churn: it uses
// roles (combobox/listbox/option/dialog), the renderer registry and "[headless]" log lines rather
// than layout, and tolerates new rows, sections, views and settings pages.
//
//   node tests/e2e/smoke.mjs        (needs `pnpm build` first)
import { launchGlide, snapshotApp, sleep, createReporter } from "../harness/index.mjs";

const r = createReporter("e2e-smoke");
// ErrorBoundary output ("Something went wrong: <msg>", "<title> crashed: <msg>") — not a view's own error state.
const CRASH = /crashed:|Something went wrong:/;
// Without the native helper (always the case in CI) these are expected degradations, not crashes.
const HELPER_MISSING = /helper (is not running|not available|is not available)|need the Glide helper|helper method .* disabled in headless/i;

const rows = (page) => page.eval(() => [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => ({
  title: o.querySelector(".row__title")?.textContent?.trim() ?? o.textContent.trim().slice(0, 60),
  selected: o.getAttribute("aria-selected") === "true",
})));

async function search(page, text) {
  await page.clear("input");
  await page.type(text, { selector: "input" });
  await sleep(350);
  return rows(page);
}

async function reload(page) {
  await page.cdp.send("Page.reload", {});
  await sleep(150);
  await page.waitForSelector("input", { timeout: 15000 });
  await page.addStyle("body *{pointer-events:none!important}");
}

let current = "";
const app = await launchGlide({ appDir: snapshotApp() });
try {
  const page = await app.launcher();
  await page.addStyle("body *{pointer-events:none!important}");

  await r.step("launcher renders with the real preload bridge", async () => {
    const s = await page.eval(() => ({ bridge: typeof window.glide?.search === "function", mock: !!window.__glideMock }));
    return { ok: s.bridge && !s.mock, detail: JSON.stringify(s) };
  });
  await r.step("root list renders with exactly one selected row", async () => {
    await page.waitFor(() => document.querySelectorAll('[role="option"]').length > 0, { timeout: 8000 });
    const rs = await rows(page);
    return { ok: rs.length > 0 && rs.filter((x) => x.selected).length === 1, detail: `${rs.length} rows` };
  });
  await r.step("fixture apps are indexed (isolated appDirectories)", async () => {
    const rs = await search(page, "fixture");
    const apps = rs.filter((x) => /^Fixture (Browser|Mail|Music|Notes|Terminal)$/.test(x.title));
    return { ok: apps.length >= 3 && rs[0]?.selected, detail: rs.slice(0, 6).map((x) => x.title).join(", ") };
  });
  await r.step("calculator: 12*(3+4) = 84", async () => {
    const rs = await search(page, "12*(3+4)");
    return { ok: rs.some((x) => x.title.includes("84")), detail: rs.slice(0, 2).map((x) => x.title).join(", ") };
  });
  await r.step("ArrowDown moves the selection", async () => {
    await search(page, "fixture");
    const before = (await rows(page)).findIndex((x) => x.selected);
    await page.press("ArrowDown");
    await sleep(80);
    const after = (await rows(page)).findIndex((x) => x.selected);
    return { ok: after === before + 1, detail: `${before} -> ${after}` };
  });
  await r.step("⌘K opens the action panel and Esc closes it", async () => {
    await page.press("cmd+k");
    const open = await page.waitFor(() => !!document.querySelector('[role="dialog"][aria-label="Actions"]'), { timeout: 3000 }).catch(() => false);
    await page.press("Escape");
    await sleep(200);
    const closed = await page.eval(() => !document.querySelector('[role="dialog"][aria-label="Actions"]'));
    return { ok: open && closed, detail: JSON.stringify({ open, closed }) };
  });
  await r.step("quicklink with argument opens the URL (recorded, not opened)", async () => {
    await reload(page);
    const since = Date.now();
    await search(page, "github glide harness");
    const top = (await rows(page))[0];
    await page.press("Enter");
    const line = await app.waitForLog(/\[headless\] shell\.openExternal .*github\.com\/search\?q=glide(%20|\+)harness/, { timeout: 4000, since }).catch(() => null);
    return { ok: !!line, detail: line ?? `top row: ${top?.title}; recent: ${app.headless().slice(-3).map((h) => h.kind).join(",")}` };
  });
  await r.step("workflow runs through the real runtime with {{input}}", async () => {
    await reload(page);
    const res = await page.eval(() => window.glide.runWorkflow("wf-fixture-greet", "Tobi"));
    return { ok: res?.ok && res?.variables?.greeting === "Hello Tobi", detail: JSON.stringify(res?.variables ?? res) };
  });

  // Every registered launcher view opens without crashing.
  const views = (await page.eval("window.__glideLauncher?.views() ?? []")) ?? [];
  r.check("feature views are registered", views.length > 0, `${views.length} views`);
  const crashed = [];
  let lp = page;
  for (const v of views) {
    if (process.env.GLIDE_TEST_DEBUG) console.error(`[smoke] view ${v}`);
    current = v;
    try {
      await reload(lp);
      const since = Date.now();
      const pushed = await lp.eval((id) => window.__glideLauncher.openView({ id, props: {} }), v).catch((e) => String(e));
      await sleep(350);
      const dom = await lp.eval(() => ({ view: document.querySelector(".launcher__view")?.dataset.view ?? null, text: document.querySelector(".launcher__view")?.innerText?.slice(0, 200) ?? "", toast: document.querySelector(".toast")?.textContent ?? "" }));
      const errs = lp.errorsSince(since).filter((e) => CRASH.test(e.text));
      if (pushed === false || CRASH.test(dom.toast) || CRASH.test(dom.text) || errs.length) crashed.push(`${v}: ${(errs[0]?.text ?? dom.toast ?? dom.text).split("\n")[0].slice(0, 120)}`);
    } catch (err) {
      // A frozen renderer/main (CDP timeout): record it, reconnect and keep auditing the rest.
      crashed.push(`${v}: ${String(err.message).slice(0, 120)}`);
      lp.close();
      lp = await app.launcher({ timeout: 30000 });
    }
  }
  current = "";
  r.check(`all ${views.length} launcher views open without crashing`, crashed.length === 0, crashed.join(" | "));

  // Every settings page renders without hitting its error boundary.
  const settings = await app.settings("general", { via: lp });
  const pages = await settings.eval(async () => {
    const out = [];
    const sel = ".sidebar .navitem";
    const n = document.querySelectorAll(sel).length;
    for (let i = 0; i < n; i++) {
      document.querySelectorAll(sel)[i]?.click();
      await new Promise((res) => setTimeout(res, 120));
      const crash = [...document.querySelectorAll(".error-banner, .launcher__empty")].map((e) => e.textContent).find((t) => /crashed|went wrong/.test(t));
      out.push({ hash: location.hash, crash: crash ?? null, heading: !!document.querySelector("main, .page, h1, h2") });
    }
    return out;
  });
  const badPages = pages.filter((p) => p.crash);
  r.check(`all ${pages.length} settings pages render without crashing`, pages.length >= 6 && badPages.length === 0, badPages.map((p) => `${p.hash}: ${p.crash}`).join(" | "));
  await r.step("⌘1 returns to the first settings page", async () => {
    await settings.press("cmd+1");
    await sleep(200);
    const h = await settings.location();
    return { ok: /#\/settings(\/general)?$/.test(h), detail: h };
  });

  r.check("headless mode: global shortcuts are faked, never registered", app.headless("globalShortcut.register").length >= 1, app.headless("globalShortcut.register").map((h) => h.detail).join(", "));
  const errors = app.errors();
  const helperErrors = errors.filter((e) => HELPER_MISSING.test(e));
  const realErrors = errors.filter((e) => !HELPER_MISSING.test(e));
  r.check("no main-process errors logged", realErrors.length === 0, realErrors.slice(0, 5).join(" | "));
  if (helperErrors.length) r.warn(`${helperErrors.length} IPC handler(s) threw because the helper is missing (should degrade with a message instead)`, helperErrors.slice(0, 3).join(" | "));
} catch (err) {
  r.check("suite ran to completion", false, `${current ? `while on view ${current}: ` : ""}${String(err?.stack ?? err)}`);
} finally {
  await app.close();
}
process.exit(r.summary() ? 1 : 0);
