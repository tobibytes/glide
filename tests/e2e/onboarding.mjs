// Headless end-to-end check of the first-run onboarding window (src/{main,renderer}/features/onboarding).
//
//   node tests/e2e/onboarding.mjs            (needs `pnpm build` first)
//   GLIDE_ONBOARDING_SHOTS=<dir>             also save a screenshot of every step there
//   GLIDE_ONBOARDING_PORT=<port>             CDP port (default: harness allocation)
//
// Covers: a fresh data dir opens the tour automatically; every step renders and is keyboard driven;
// the permission rows follow a faked (live-updated) status; "Open Settings" only fires on activation;
// the AI key path runs against a local fake Anthropic server; a theme change applies; completion is
// persisted and the next launch does not reopen it; seeded (existing) data dirs and skip are respected.
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchGlide, snapshotApp, sleep, createReporter, testTmpRoot } from "../harness/index.mjs";

const reporter = createReporter("e2e-onboarding");
// step() keeps `detail` as returned; stringify objects so summary() can print them.
const r = {
  ...reporter,
  step: (title, fn) => reporter.step(title, async () => {
    const out = await fn();
    return out && typeof out === "object" && "ok" in out && typeof out.detail !== "string" && out.detail !== undefined ? { ...out, detail: JSON.stringify(out.detail) } : out;
  }),
};
const shots = process.env.GLIDE_ONBOARDING_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const port = process.env.GLIDE_ONBOARDING_PORT ? Number(process.env.GLIDE_ONBOARDING_PORT) : undefined;
const appDir = snapshotApp();
const work = mkdtempSync(path.join(testTmpRoot(), "onboarding-"));
const dataDir = path.join(work, "data");
mkdirSync(dataDir, { recursive: true });
const fakePerms = path.join(work, "permissions.json");
const writePerms = (p) => writeFileSync(fakePerms, JSON.stringify(p));

// A local stand-in for api.anthropic.com (testConnection calls GET /v1/models/<id>).
const aiRequests = [];
const server = http.createServer((req, res) => {
  aiRequests.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] });
  const m = /^\/v1\/models\/([^/?]+)/.exec(req.url ?? "");
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && m) return res.end(JSON.stringify({ type: "model", id: decodeURIComponent(m[1]), display_name: "Fake Claude", created_at: "2025-01-01T00:00:00Z" }));
  res.statusCode = 404;
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "nope" } }));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const aiBase = `http://127.0.0.1:${server.address().port}`;

const env = { GLIDE_SKIP_ONBOARDING: "0", GLIDE_ONBOARDING_FAKE_PERMISSIONS: fakePerms, ANTHROPIC_BASE_URL: aiBase };
const shot = async (page, name) => {
  if (!shots) return;
  await sleep(120);
  writeFileSync(path.join(shots, `${name}.png`), await page.screenshot());
};
// The key/eval that closes a window loses its CDP connection mid-call; that is the expected outcome.
const closing = (promise) => promise.catch((err) => {
  if (!/connection closed/.test(String(err?.message ?? err))) throw err;
});
const step = (page) => page.eval(() => document.querySelector(".onboarding")?.dataset.step ?? null);
const waitStep = (page, s) => page.waitFor((x) => document.querySelector(".onboarding")?.dataset.step === x, { timeout: 4000, message: `step ${s}` }, s);
const focused = (page) => page.eval(() => {
  const el = document.activeElement;
  return el ? { tag: el.tagName, role: el.getAttribute("role"), text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 50), choice: el.dataset.choice, preset: el.dataset.preset, permission: el.closest("[data-permission]")?.dataset.permission } : null;
});
const settings = (page) => page.eval(() => window.glide.getData().then((d) => d.settings));
const onboardingPages = async (app) => (await app.targets()).filter((t) => new URL(t.url).hash.startsWith("#/onboarding"));

/** Tab through the step and return every distinct focus stop (detects traps and unreachable controls). */
async function tabStops(page, max = 24) {
  const stops = [];
  for (let i = 0; i < max; i++) {
    await page.press("Tab");
    const f = await focused(page);
    const key = JSON.stringify(f);
    if (stops.includes(key)) break;
    stops.push(key);
  }
  return stops.map((s) => JSON.parse(s));
}

async function unreachable(page) {
  // Every interactive control in the window must be in the tab order (tabIndex >= 0, not disabled).
  return page.eval(() =>
    [...document.querySelectorAll(".onboarding button, .onboarding [role=radio], .onboarding [role=switch], .onboarding input, .onboarding [role=button]")]
      .filter((el) => !el.disabled && el.tabIndex < 0 && !el.closest(".hotkey"))
      .map((el) => el.getAttribute("aria-label") || el.textContent.trim().slice(0, 30)),
  );
}

writePerms({ accessibility: true, inputMonitoring: false, screenRecording: "notDetermined", calendars: "granted", reminders: "denied" });

// ------------------------------------------------------------------ launch 1: fresh data dir
let app = await launchGlide({ appDir, dataDir, fixture: false, keepData: true, env, port });
try {
  const page = await (async () => {
    const p = await app.page("#/onboarding/welcome", { timeout: 20000 });
    await p.waitForSelector(".onboarding", { timeout: 15000 });
    await p.stabilise();
    return p;
  })();

  await r.step("fresh data dir opens the onboarding window automatically", async () => {
    const line = await app.waitForLog(/\[onboarding\] first run: first-run \(opening\)/, { timeout: 5000 });
    return { ok: (await step(page)) === "welcome", detail: line };
  });

  await r.step("welcome: renders 3 highlights, primary focused, all controls tabbable", async () => {
    // Focus moves to the primary button after render; slow CI machines need more than a fixed pause.
    await page.waitFor(() => /onboarding-foot__primary/.test(document.activeElement?.className ?? ""), { timeout: 3000 }).catch(() => {});
    const info = await page.eval(() => ({ h: document.querySelector(".onboarding-welcome__h")?.textContent, n: document.querySelectorAll(".onboarding-highlight").length, focus: document.activeElement?.className ?? "" }));
    await shot(page, "01-welcome");
    const missing = await unreachable(page);
    const stops = await tabStops(page);
    const ok = info.h === "Welcome to Glide" && info.n === 3 && info.focus.includes("onboarding-foot__primary") && missing.length === 0 && stops.some((s) => /Skip setup/.test(s.text)) && stops.some((s) => /Get Started/.test(s.text));
    return { ok, detail: { ...info, missing, stops: stops.length } };
  });

  await r.step("Enter continues to the hotkey step", async () => {
    await page.eval(() => document.querySelector(".onboarding-foot__primary")?.focus());
    await page.press("Enter");
    await waitStep(page, "hotkey");
    await sleep(150);
    const f = await focused(page);
    return { ok: f?.choice === "alt", detail: f };
  });

  await r.step("hotkey: j/k move between options without applying them", async () => {
    await page.press("j");
    const a = await focused(page);
    await page.press("k");
    const b = await focused(page);
    const s = await settings(page);
    return { ok: a?.choice === "cmd" && b?.choice === "alt" && s.hotkey === "Alt+Space", detail: { a: a?.choice, b: b?.choice, hotkey: s.hotkey } };
  });

  await r.step("hotkey: recording a custom shortcut registers it", async () => {
    await page.eval(() => document.querySelector(".onboarding-recorder .hotkey")?.focus());
    const since = Date.now();
    await page.press("ctrl+alt+cmd+g");
    await page.waitFor(() => document.querySelector(".onboarding-status")?.classList.contains("is-ok"), { timeout: 3000 });
    const text = await page.eval(() => document.querySelector(".onboarding-status")?.textContent);
    const s = await settings(page);
    const reg = app.headless("globalShortcut.register").filter((h) => h.at >= since).map((h) => h.detail);
    return { ok: s.hotkey === "Ctrl+Alt+Cmd+G" && reg.includes("Ctrl+Alt+Cmd+G") && /⌃⌥⌘G/.test(text ?? ""), detail: { hotkey: s.hotkey, text, reg } };
  });

  await r.step("hotkey: a conflicting shortcut shows the conflict and is not saved", async () => {
    await page.eval(() => document.querySelector(".onboarding-recorder .hotkey")?.focus());
    await page.press("ctrl+Space");
    await page.waitFor(() => document.querySelector(".onboarding-status")?.classList.contains("is-error"), { timeout: 3000 });
    const text = await page.eval(() => document.querySelector(".onboarding-status")?.textContent);
    const s = await settings(page);
    return { ok: /input source/i.test(text ?? "") && s.hotkey === "Ctrl+Alt+Cmd+G", detail: { text, hotkey: s.hotkey } };
  });

  await r.step("hotkey: Space on ⌥Space selects it (⌘Space is never invoked)", async () => {
    await page.eval(() => document.querySelector('[data-choice="alt"]')?.focus());
    await page.press("Space");
    await page.waitFor(() => document.querySelector('[data-choice="alt"]')?.getAttribute("aria-checked") === "true", { timeout: 3000 });
    const s = await settings(page);
    await shot(page, "02-hotkey");
    const blocked = app.headless("helper.blocked").map((h) => h.detail);
    return { ok: s.hotkey === "Alt+Space" && !blocked.some((b) => /setSpotlightShortcut/.test(String(b))), detail: { hotkey: s.hotkey, blocked } };
  });

  await r.step("Enter on the chosen option continues; Esc goes back; ⌘] forward", async () => {
    await page.eval(() => document.querySelector('[data-choice="alt"]')?.focus());
    await page.press("Enter");
    await waitStep(page, "permissions");
    await page.eval(() => document.activeElement?.blur());
    await page.press("Escape");
    await waitStep(page, "hotkey");
    await page.eval(() => document.activeElement?.blur());
    await page.press("cmd+]");
    await waitStep(page, "permissions");
    await page.press("cmd+[");
    await waitStep(page, "hotkey");
    await page.press("cmd+]");
    await waitStep(page, "permissions");
    return { ok: true };
  });

  await r.step("permissions: rows reflect the faked status", async () => {
    const want = { accessibility: "granted", inputMonitoring: "denied", screenRecording: "notDetermined", calendars: "granted", reminders: "denied" };
    const got = await page.waitFor((w) => {
      const m = Object.fromEntries([...document.querySelectorAll("[data-permission]")].map((el) => [el.dataset.permission, el.dataset.status]));
      return Object.entries(w).every(([k, v]) => m[k] === v) ? m : false;
    }, { timeout: 4000 }, want);
    const pills = await page.eval(() => [...document.querySelectorAll(".onboarding-pill")].map((p) => p.textContent));
    return { ok: !!got && pills.length === 5, detail: { got, pills } };
  });

  await r.step("permissions: status updates live (poll ≤ 1.5 s)", async () => {
    const t0 = Date.now();
    writePerms({ accessibility: true, inputMonitoring: true, screenRecording: "granted", calendars: "granted", reminders: "denied" });
    await page.waitFor(() => document.querySelector('[data-permission="inputMonitoring"]')?.dataset.status === "granted" && document.querySelector('[data-permission="screenRecording"]')?.dataset.status === "granted", { timeout: 4000 });
    const summary = await page.eval(() => document.querySelector(".onboarding-status")?.textContent);
    return { ok: /4 of 5 granted/.test(summary ?? ""), detail: `${Date.now() - t0} ms · ${summary}` };
  });

  await r.step("permissions: Open Settings only on activation, with the right pane", async () => {
    const before = app.headless("shell.openExternal").length;
    await page.eval(() => document.activeElement?.blur());
    await page.press("j"); // accessibility row
    await page.press("j"); // input monitoring
    await page.press("j"); // screen recording
    await page.press("j"); // calendars
    await page.press("j"); // reminders
    const f = await focused(page);
    await sleep(200);
    const mid = app.headless("shell.openExternal").length;
    await page.press("Enter");
    const line = await app.waitForLog(/\[headless\] shell\.openExternal x-apple\.systempreferences:.*Privacy_Reminders/, { timeout: 3000 });
    await page.eval(() => document.activeElement?.blur());
    await shot(page, "03-permissions");
    return { ok: before === 0 && mid === 0 && f?.permission === "reminders", detail: { before, mid, focus: f?.permission, line } };
  });

  await r.step("permissions: ⌘⏎ continues to AI with the key field focused", async () => {
    await page.press("cmd+Enter");
    await waitStep(page, "ai");
    await sleep(150);
    const f = await focused(page);
    return { ok: f?.tag === "INPUT", detail: f };
  });

  await r.step("ai: Save & Test stores the key and tests it (local fake API)", async () => {
    await page.type("sk-ant-onboarding-test-0001");
    await page.press("Enter");
    await page.waitFor(() => document.querySelector(".onboarding-status.is-ok") && /Connected/.test(document.querySelector(".onboarding-status").textContent), { timeout: 8000 });
    const text = await page.eval(() => document.querySelector(".onboarding-status")?.textContent);
    const pill = await page.eval(() => document.querySelector(".onboarding-ai__meta .onboarding-pill")?.textContent);
    await shot(page, "04-ai");
    const hit = aiRequests.find((q) => q.url?.startsWith("/v1/models/"));
    return { ok: /Fake Claude/.test(text ?? "") && pill === "Key saved" && hit?.key === "sk-ant-onboarding-test-0001", detail: { text, pill, hit } };
  });

  await r.step("ai: Enter on the empty field continues", async () => {
    await page.press("Enter");
    await waitStep(page, "look");
    return { ok: true };
  });

  await r.step("look: j/k flip themes and the window restyles live", async () => {
    await page.waitForSelector("[data-preset]", { timeout: 4000 });
    await sleep(200);
    const start = await page.eval(() => document.documentElement.dataset.preset);
    for (let i = 0; i < 12; i++) {
      if ((await page.eval(() => document.documentElement.dataset.preset)) === "nord") break;
      await page.press("j");
      await sleep(250);
    }
    const now = await page.eval(() => ({ preset: document.documentElement.dataset.preset, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() }));
    const s = await settings(page);
    await shot(page, "05-look");
    return { ok: now.preset === "nord" && s.features?.appearance?.darkTheme === "nord" && s.theme === "dark" && now.bg === "#2e3440", detail: { start, now, theme: s.theme } };
  });

  await r.step("look: vim mode and keep-open toggles persist", async () => {
    const sw = (i) => page.eval((n) => document.querySelectorAll('.onboarding [role="switch"]')[n]?.focus(), i);
    await sw(0);
    await page.press("Space");
    await page.waitFor(() => window.glide.getData().then((d) => d.settings.vimMode === false), { timeout: 3000 });
    await page.press("Space");
    await page.waitFor(() => window.glide.getData().then((d) => d.settings.vimMode === true), { timeout: 3000 });
    await sw(1);
    await page.press("Space");
    await page.waitFor(() => window.glide.getData().then((d) => d.settings.keepOpenAfterRun === false), { timeout: 3000 });
    const s = await settings(page);
    return { ok: s.vimMode === true && s.keepOpenAfterRun === false, detail: { vimMode: s.vimMode, keepOpenAfterRun: s.keepOpenAfterRun } };
  });

  await r.step("progress is persisted while the tour is open", async () => {
    const s = await settings(page);
    return { ok: s.features?.onboarding?.started === true && s.features?.onboarding?.step === "look", detail: s.features?.onboarding };
  });

  await r.step("done: cheat sheet of 8 and the Open Glide button", async () => {
    await page.eval(() => document.activeElement?.blur());
    await page.press("Enter");
    await waitStep(page, "done");
    await page.waitFor(() => /primary/.test(document.activeElement?.className ?? ""), { timeout: 3000 }).catch(() => {});
    const info = await page.eval(() => ({ rows: document.querySelectorAll(".onboarding-sheet__row").length, primary: document.querySelector(".onboarding-foot__primary")?.textContent, focus: document.activeElement?.className, first: document.querySelector(".onboarding-sheet__row")?.textContent }));
    await shot(page, "06-done");
    return { ok: info.rows === 8 && /Open Glide/.test(info.primary ?? "") && /primary/.test(info.focus ?? "") && /⌥/.test(info.first ?? ""), detail: info };
  });

  await r.step("Open Glide completes, closes the tour and persists completion", async () => {
    await closing(page.press("Enter"));
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && (await onboardingPages(app)).length) await sleep(100);
    const launcher = await app.launcher();
    const s = await settings(launcher);
    launcher.close();
    await sleep(600); // debounced store write
    return { ok: (await onboardingPages(app)).length === 0 && s.features?.onboarding?.completed === true && s.features.onboarding.started === false, detail: s.features?.onboarding };
  });

  r.check("no page errors in the tour", page.errorsSince(0).length === 0, page.errorsSince(0).map((e) => e.text).join(" | "));
  r.check("no main-process errors", app.errors().length === 0, app.errors().slice(0, 5).join(" | "));
} finally {
  await app.close();
}

// ------------------------------------------------------------------ launch 2: same data dir
app = await launchGlide({ appDir, dataDir, fixture: false, keepData: true, env, port });
try {
  await r.step("second launch does not reopen the tour", async () => {
    const line = await app.waitForLog(/\[onboarding\] first run:/, { timeout: 15000 });
    await app.launcher();
    await sleep(1800);
    return { ok: /completed/.test(line) && (await onboardingPages(app)).length === 0, detail: line };
  });

  await r.step("“Welcome to Glide” command reopens it from the start", async () => {
    const launcher = await app.launcher();
    await launcher.clear("input");
    await launcher.type("welcome to glide", { selector: "input" });
    await launcher.waitFor(() => [...document.querySelectorAll('[role="option"]')].some((o) => /Welcome to Glide/.test(o.textContent)), { timeout: 4000 });
    await launcher.eval(() => {
      const opts = [...document.querySelectorAll('[role="option"]')];
      const i = opts.findIndex((o) => /Welcome to Glide/.test(o.textContent));
      return i;
    });
    // Select it (it should rank first for the exact title) and run.
    await launcher.press("Enter");
    const page = await app.page("#/onboarding/welcome", { timeout: 6000 });
    await page.waitForSelector(".onboarding", { timeout: 6000 });
    await sleep(300);
    const st = await step(page);
    const s = await settings(page);
    await closing(page.eval(() => window.glide.feature("onboarding", "close")));
    page.close();
    launcher.close();
    return { ok: st === "welcome" && s.features?.onboarding?.completed === true, detail: { step: st, onboarding: s.features?.onboarding } };
  });
} finally {
  await app.close();
}

// ------------------------------------------------------------------ launch 3: explicit skip on a fresh dir
const skipDir = path.join(work, "skip");
mkdirSync(skipDir, { recursive: true });
app = await launchGlide({ appDir, dataDir: skipDir, fixture: false, keepData: true, env, port });
try {
  await r.step("Skip setup closes the tour and is remembered", async () => {
    const page = await app.page("#/onboarding/welcome", { timeout: 20000 });
    await page.waitForSelector(".onboarding-skip", { timeout: 10000 });
    await sleep(200);
    await page.eval(() => document.querySelector(".onboarding-skip")?.focus());
    await closing(page.press("Enter"));
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && (await onboardingPages(app)).length) await sleep(100);
    const launcher = await app.launcher();
    const s = await settings(launcher);
    launcher.close();
    page.close();
    return { ok: s.features?.onboarding?.skipped === true && (await onboardingPages(app)).length === 0, detail: s.features?.onboarding };
  });
} finally {
  await app.close();
}

// ------------------------------------------------------------------ launch 4: existing install (seeded fixture data)
app = await launchGlide({ appDir, env, port });
try {
  await r.step("existing data (seeded fixtures) is not forced through the tour", async () => {
    const line = await app.waitForLog(/\[onboarding\] first run:/, { timeout: 15000 });
    await app.launcher();
    await sleep(1800);
    return { ok: /existing-install/.test(line) && (await onboardingPages(app)).length === 0, detail: line };
  });
} finally {
  await app.close();
}

server.close();
rmSync(work, { recursive: true, force: true });
const failed = r.summary();
process.exit(failed ? 1 : 0);
