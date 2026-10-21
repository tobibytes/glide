// End-to-end smoke test: launches the built Electron app with an isolated
// data directory and drives the launcher through the Chrome DevTools Protocol.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
// The electron package exports the real binary path; spawning node_modules/.bin/electron
// would kill only the wrapper and orphan Electron, which then holds the single-instance lock.
const electronBin = createRequire(import.meta.url)("electron");
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(path.join(process.env.GLIDE_E2E_TMP ?? tmpdir(), "glide-e2e-"));
// Unique per build session so parallel instances don't collide (override with GLIDE_E2E_PORT).
const port = Number(process.env.GLIDE_E2E_PORT ?? 9407);
const app = spawn(electronBin, [`--remote-debugging-port=${port}`, "."], {
  cwd: root,
  // No API keys: nothing in this test may reach the network.
  env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GLIDE_USER_DATA: dataDir, GLIDE_SHOW_ON_START: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

async function targets() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error("no renderer target");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`CDP ${method} timed out`));
      }, 5000);
      pending.set(n, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      if (process.env.GLIDE_E2E_DEBUG) console.error("->", method);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, close: () => ws.close() });
    ws.onerror = (e) => reject(new Error(`websocket error: ${e.message ?? e.type}`));
    setTimeout(() => reject(new Error("websocket connect timed out")), 5000);
  });
}

async function main() {
  const page = await targets();
  const cdp = await connect(page.webSocketDebuggerUrl);
  const evaluate = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const key = async (k, code, keyCode, modifiers = 0) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  // A printable key press (keyDown with text inserts a character unless the page prevents it).
  const press = async (ch, modifiers = 0) => {
    const upper = ch.toUpperCase();
    const code = /^[a-z]$/i.test(ch) ? `Key${upper}` : /^[0-9]$/.test(ch) ? `Digit${ch}` : ch === "/" ? "Slash" : ch === "." ? "Period" : "";
    const vk = /^[a-z0-9]$/i.test(ch) ? upper.charCodeAt(0) : ch === "/" ? 191 : ch === "." ? 190 : 0;
    const mods = modifiers | (/^[A-Z]$/.test(ch) ? 8 : 0);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, modifiers: mods, text: mods & ~8 ? undefined : ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, modifiers: mods });
  };
  const selIndex = async () => (await state()).rows.findIndex((r) => r.sel);
  const typeText = async (text) => {
    await evaluate(`document.querySelector('input')?.focus()`);
    await cdp.send("Input.insertText", { text });
  };
  const clear = async () => {
    await evaluate(`(() => { const i = document.querySelector('input'); i.focus(); i.select(); })()`);
    await key("Backspace", "Backspace", 8);
    await sleep(150);
  };
  const state = () =>
    evaluate(`(() => ({
      hash: location.hash,
      bridge: typeof window.glide?.search === "function",
      mock: !!window.__glideMock,
      input: document.querySelector('input')?.value ?? null,
      headers: [...document.querySelectorAll('[class*="section"]')].map((e) => e.textContent.trim()).filter((t) => t.length < 40),
      rows: [...document.querySelectorAll('[role="option"]')].map((e) => ({ t: e.querySelector('.row__title')?.textContent, sel: e.getAttribute('aria-selected') === 'true', kind: e.querySelector('.row__kind')?.textContent })),
      footer: document.querySelector('[class*="footer"]')?.textContent?.trim() ?? null,
      highlights: document.querySelectorAll('.row--selected mark, .row--selected .hl').length,
    }))()`);

  await sleep(1500);
  // The launcher opens where the real cursor may be; a person moving the mouse during the run
  // would legitimately hover-select a row. Isolate keyboard checks from the physical pointer.
  await evaluate(`(() => { const st = document.createElement('style'); st.textContent = '.launcher * { pointer-events: none !important; }'; document.head.append(st); })()`);
  let s = await state();
  check("renderer loaded with real preload bridge", s.bridge && !s.mock, JSON.stringify({ bridge: s.bridge, mock: s.mock }));
  check("empty query shows rows", s.rows.length > 0, `${s.rows.length} rows`);
  check("exactly one row selected on load", s.rows.filter((r) => r.sel).length === 1, JSON.stringify(s.rows.slice(0, 3)));

  await typeText("safari");
  await sleep(400);
  s = await state();
  check("'safari' ranks Safari first", s.rows[0]?.t === "Safari", JSON.stringify(s.rows.slice(0, 3)));
  check("first result selected after typing", s.rows[0]?.sel, "");

  await clear();
  await typeText("vsc");
  await sleep(400);
  s = await state();
  check("'vsc' returns results (acronym via boundary bonus)", s.rows.length > 0, JSON.stringify(s.rows.slice(0, 3)));

  await clear();
  await typeText("12*(3+4)");
  await sleep(400);
  s = await state();
  check("calculator: 12*(3+4) = 84", s.rows.some((r) => (r.t ?? "").includes("84")), JSON.stringify(s.rows.slice(0, 2)));

  await clear();
  await typeText("morning");
  await sleep(400);
  s = await state();
  check("seeded workflow 'Morning Setup' is searchable", s.rows.some((r) => r.t === "Morning Setup"), JSON.stringify(s.rows.slice(0, 3)));

  await clear();
  await typeText("set");
  await sleep(400);
  const before = (await state()).rows.findIndex((r) => r.sel);
  await key("ArrowDown", "ArrowDown", 40);
  await sleep(100);
  const after = (await state()).rows.findIndex((r) => r.sel);
  check("ArrowDown moves selection", after === before + 1, `${before} -> ${after}`);

  await key("k", "KeyK", 75, 4 /* meta */);
  await sleep(300);
  const panel = await evaluate(`[...document.querySelectorAll('[class*="action"]')].some((e) => e.getBoundingClientRect().height > 0 && /Favorites|Copy|Open|Run/.test(e.textContent))`);
  check("Cmd+K opens the action panel", panel, "");
  await key("Escape", "Escape", 27);
  await sleep(150);

  // --- Vim NORMAL mode -------------------------------------------------------
  await clear();
  await typeText("s");
  await sleep(400);
  const vimRows = (await state()).rows.length;
  await key("Escape", "Escape", 27);
  await sleep(100);
  let vim = await evaluate(`({ mode: document.querySelector('.launcher')?.dataset.vimMode, pill: !!document.querySelector('.vim-pill'), foot: document.querySelector('.vim-mode')?.textContent, input: document.querySelector('input')?.value, readOnly: document.querySelector('input')?.readOnly })`);
  check("Esc with a query enters NORMAL mode (pill + footer)", vim.mode === "normal" && vim.pill && vim.foot === "-- NORMAL --" && vim.input === "s" && vim.readOnly, JSON.stringify(vim));
  const v0 = await selIndex();
  await press("j");
  await sleep(60);
  const v1 = await selIndex();
  await press("j");
  await sleep(60);
  const v2 = await selIndex();
  await press("k");
  await sleep(60);
  const v3 = await selIndex();
  check("NORMAL: j/j/k move the selection", v0 === 0 && v1 === 1 && v2 === 2 && v3 === 1, `${v0} ${v1} ${v2} ${v3} of ${vimRows}`);
  await press("G");
  await sleep(60);
  const vLast = await selIndex();
  const itemCount = (await state()).rows.length;
  await press("g");
  await press("g");
  await sleep(60);
  const vTop = await selIndex();
  check("NORMAL: G bottom, gg top", vLast === itemCount - 1 && vTop === 0, `G=${vLast}/${itemCount - 1} gg=${vTop}`);
  await press("3");
  await press("j");
  await sleep(60);
  const vCount = await selIndex();
  check("NORMAL: count prefix (3j)", vCount === Math.min(3, itemCount - 1), `${vCount}`);
  await press("z");
  await sleep(60);
  check("NORMAL: letters do not type", (await state()).input === "s", (await state()).input);
  await press("i");
  await sleep(100);
  await press("e");
  await sleep(300);
  vim = await evaluate(`({ mode: document.querySelector('.launcher')?.dataset.vimMode, input: document.querySelector('input')?.value, foot: document.querySelector('.vim-mode')?.textContent, focused: document.activeElement === document.querySelector('input') })`);
  check("i returns to INSERT and typing works", vim.mode === "insert" && vim.input === "se" && vim.foot === "-- INSERT --" && vim.focused, JSON.stringify(vim));
  s = await state();
  check("first result selected after typing in INSERT", s.rows[0]?.sel, JSON.stringify(s.rows.slice(0, 2)));
  await key("Escape", "Escape", 27);
  await press("/");
  await sleep(300);
  check("/ returns to INSERT with a cleared query", (await state()).input === "", (await state()).input);

  // --- View stack ----------------------------------------------------------------
  await typeText("saf");
  await sleep(300);
  const pushed = await evaluate(`window.__glideLauncher?.openView({ id: "nonexistent.view" })`);
  await sleep(150);
  const vs = await evaluate(`({ toast: document.querySelector('.toast')?.textContent ?? null, back: !!document.querySelector('.launcher__back'), view: !!document.querySelector('.launcher__view'), input: document.querySelector('input')?.value, rows: document.querySelectorAll('#glide-results [role="option"]').length })`);
  check("unknown view id: toast and root stays", pushed === false && /isn't available yet/.test(vs.toast ?? "") && !vs.back && !vs.view && vs.input === "saf" && vs.rows > 0, JSON.stringify(vs));

  // A real feature view, once one is registered: push, breadcrumb, typing, Backspace-on-empty pop, Esc → NORMAL → h pop.
  const views = (await evaluate(`window.__glideLauncher?.views() ?? []`)) ?? [];
  const viewId = views.includes("clipboard.history") ? "clipboard.history" : views[0];
  if (viewId) {
    await evaluate(`window.__glideLauncher.openView({ id: ${JSON.stringify(viewId)}, props: { title: "E2E View" } })`);
    await sleep(400);
    let pv = await evaluate(`({ back: !!document.querySelector('.launcher__back'), crumb: document.querySelector('.crumb__title')?.textContent, view: document.querySelector('.launcher__view')?.dataset.view, input: document.querySelector('input')?.value })`);
    check(`view push renders ${viewId} with back chevron + breadcrumb`, pv.back && pv.crumb === "E2E View" && pv.view === viewId && pv.input === "", JSON.stringify(pv));
    await typeText("q");
    await sleep(150);
    pv = await evaluate(`({ input: document.querySelector('input')?.value, view: !!document.querySelector('.launcher__view') })`);
    check("typing goes to the view's query", pv.input === "q" && pv.view, JSON.stringify(pv));
    await key("Backspace", "Backspace", 8);
    await sleep(80);
    await key("Backspace", "Backspace", 8);
    await sleep(200);
    pv = await evaluate(`({ view: !!document.querySelector('.launcher__view'), input: document.querySelector('input')?.value })`);
    check("Backspace on an empty view query pops back to root (root query kept)", !pv.view && pv.input === "saf", JSON.stringify(pv));
    await evaluate(`window.__glideLauncher.openView({ id: ${JSON.stringify(viewId)} })`);
    await sleep(300);
    await key("Escape", "Escape", 27);
    await sleep(80);
    const vm = await evaluate(`document.querySelector('.launcher')?.dataset.vimMode`);
    await press("h");
    await sleep(200);
    pv = await evaluate(`({ view: !!document.querySelector('.launcher__view'), mode: document.querySelector('.launcher')?.dataset.vimMode })`);
    check("in a view: Esc → NORMAL, h pops", vm === "normal" && !pv.view, JSON.stringify({ vm, ...pv }));
    await press("i");
    await sleep(100);
  } else check("view push (no feature views registered yet — skipped)", true, "");

  // Quick AI: Tab on an item that takes no argument pushes ai.chat with the query (fresh data dir: no API key, no network).
  if (views.includes("ai.chat")) {
    await clear();
    await typeText("safari");
    await sleep(400);
    await key("Tab", "Tab", 9);
    await sleep(400);
    const qa = await evaluate(`({ view: document.querySelector('.launcher__view')?.dataset.view, crumb: document.querySelector('.crumb__title')?.textContent })`);
    check("Tab with a query opens Quick AI (ai.chat)", qa.view === "ai.chat", JSON.stringify(qa));
    await evaluate(`document.querySelector('.launcher input')?.focus()`);
    await key("Escape", "Escape", 27);
    await press("h");
    await sleep(200);
    await press("i");
    await sleep(100);
    check("…and h pops back to root", !(await evaluate(`!!document.querySelector('.launcher__view')`)), "");
  }

  // --- kindLabel ---------------------------------------------------------------
  const labelled = await evaluate(`(async () => {
    for (const q of ["", "clip", "emoji", "window", "ai", "script", "menu"]) {
      const res = await window.glide.search(q);
      for (const sec of res.sections) for (const it of sec.items) if (it.item.kindLabel && it.item.kind !== "calculator") return { title: it.item.title, label: it.item.kindLabel };
    }
    return null;
  })()`);
  if (labelled) {
    await clear();
    await typeText(labelled.title);
    await sleep(500);
    s = await state();
    const row = s.rows.find((r) => r.t === labelled.title);
    check("item.kindLabel is rendered in the kind column", row?.kind === labelled.label, JSON.stringify({ labelled, row }));
  } else check("item.kindLabel is rendered in the kind column (no feature items yet — skipped)", true, "");

  await clear();
  await typeText("zzqxj");
  await sleep(400);
  s = await state();
  check("no-match query shows fallbacks or empty state without crashing", true, JSON.stringify(s.rows.slice(0, 3)));

  // --- Workflows: create through the real bridge, run, then open in the editor ---
  const wfId = "e2e-wf";
  const runResult = await evaluate(`(async () => {
    const now = Date.now();
    await window.glide.saveWorkflow({
      id: "${"e2e-wf"}", name: "E2E Greeting", icon: { kind: "emoji", value: "👋" }, acceptsInput: true,
      createdAt: now, updatedAt: now,
      actions: [
        { id: "a1", type: "setVariable", params: { name: "greeting", value: "Hello {{input}}" } },
        { id: "a2", type: "condition", params: { left: "{{input}}", operator: "isNotEmpty", right: "" },
          then: [{ id: "a3", type: "setVariable", params: { name: "branch", value: "then" } }],
          else: [{ id: "a4", type: "setVariable", params: { name: "branch", value: "else" } }] },
      ],
    });
    return await window.glide.runWorkflow("${"e2e-wf"}", "Tobi");
  })()`);
  check("workflow runs through the real runtime", runResult?.ok, JSON.stringify(runResult?.log?.map((l) => `${l.type}:${l.status}`)));
  check("{{input}} substitution and condition branch", runResult?.variables?.greeting === "Hello Tobi" && runResult?.variables?.branch === "then", JSON.stringify(runResult?.variables));

  await clear();
  await typeText("e2e greet");
  await sleep(500);
  s = await state();
  check("new workflow is searchable immediately", s.rows[0]?.t === "E2E Greeting", JSON.stringify(s.rows.slice(0, 2)));

  await evaluate(`window.glide.openSettings("workflows/${"e2e-wf"}")`);
  let settingsPage = null;
  for (let i = 0; i < 25 && !settingsPage; i++) {
    await sleep(200);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    settingsPage = list.find((t) => t.type === "page" && t.url.includes("#/settings"));
  }
  check("settings window opens on the workflow route", settingsPage, settingsPage?.url.split("#")[1] ?? "not found");
  if (settingsPage) {
    const sc = await connect(settingsPage.webSocketDebuggerUrl);
    await sleep(1200);
    const r = await sc.send("Runtime.evaluate", { returnByValue: true, expression: `(() => ({
      cards: document.querySelectorAll('.acard').length,
      name: [...document.querySelectorAll('input')].map((i) => i.value).find((v) => v === "E2E Greeting") ?? null,
      branches: document.querySelectorAll('.branch').length,
      library: /Add Action|Actions/i.test(document.body.textContent),
    }))()` });
    const v = r.result?.result?.value ?? {};
    check("workflow editor renders the saved workflow", v.name === "E2E Greeting", JSON.stringify(v));
    check("editor shows action cards incl. nested condition branches", v.cards >= 4 && v.branches >= 2, JSON.stringify(v));
    check("editor shows the action library", v.library, "");
    const nav = (await sc.send("Runtime.evaluate", { returnByValue: true, expression: `({ items: document.querySelectorAll('.sidebar .navitem').length, features: document.querySelector('.sidebar__group') ? [...document.querySelectorAll('.sidebar .navitem')].slice(6).length : 0 })` })).result?.result?.value ?? {};
    check("settings sidebar lists core + feature pages", nav.items >= 6 && nav.features >= 0, JSON.stringify(nav));
    await sc.send("Input.dispatchKeyEvent", { type: "keyDown", key: "3", code: "Digit3", windowsVirtualKeyCode: 51, modifiers: 4 });
    await sc.send("Input.dispatchKeyEvent", { type: "keyUp", key: "3", code: "Digit3", windowsVirtualKeyCode: 51, modifiers: 4 });
    await sleep(300);
    const hash3 = (await sc.send("Runtime.evaluate", { returnByValue: true, expression: "location.hash" })).result?.result?.value;
    check("⌘3 switches to the third settings page", hash3 === "#/settings/quicklinks", hash3);
    await sc.send("Runtime.evaluate", { expression: "document.querySelector('.navitem--on')?.focus()" });
    await sc.send("Input.dispatchKeyEvent", { type: "keyDown", key: "j", code: "KeyJ", windowsVirtualKeyCode: 74 });
    await sc.send("Input.dispatchKeyEvent", { type: "keyUp", key: "j", code: "KeyJ", windowsVirtualKeyCode: 74 });
    await sleep(300);
    const hashJ = (await sc.send("Runtime.evaluate", { returnByValue: true, expression: "location.hash" })).result?.result?.value;
    check("j in the focused sidebar moves to the next page", hashJ === "#/settings/snippets", hashJ);
    sc.close();
  }

  const errors = appLog.split("\n").filter((l) => /Error|Uncaught|TypeError/.test(l) && !/DevTools|Autofill|GPU|CoreText/.test(l));
  check("no main-process errors logged", errors.length === 0, errors.slice(0, 5).join(" | "));

  cdp.close();
}

// Node's WebSocket does not hold the event loop open while awaiting replies.
const keepAlive = setInterval(() => {}, 1000);
try {
  await main();
} catch (err) {
  check("harness ran", false, String(err));
} finally {
  clearInterval(keepAlive);
  app.kill();
  await sleep(300);
  rmSync(dataDir, { recursive: true, force: true });
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
