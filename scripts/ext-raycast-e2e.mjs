// End-to-end check of the Raycast compatibility layer: launches the built app with an isolated data
// directory, imports the local fixtures in extensions-examples/raycast-fixtures, and drives the
// launcher over the Chrome DevTools Protocol. Network use is limited to a 127.0.0.1 server started here.
//
//   pnpm build && node scripts/ext-raycast-e2e.mjs
//   GLIDE_E2E_PORT (default 9431) · GLIDE_E2E_TMP (parent of the temporary data dir)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const electronBin = createRequire(import.meta.url)("electron");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "extensions-examples/raycast-fixtures");
const dataDir = mkdtempSync(path.join(process.env.GLIDE_E2E_TMP ?? tmpdir(), "glide-rc-e2e-"));
const port = Number(process.env.GLIDE_E2E_PORT ?? 9431);

// --- local data server for rc-fetch (items) and rc-compat (OAuth token endpoint) ---------------
const ITEMS = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, name: `${i % 2 ? "Beta" : "Alpha"} ${i}`, kind: i % 2 ? "odd" : "even" }));
const hits = [];
const tokenBodies = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  hits.push(u.pathname + u.search);
  if (u.pathname === "/token") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      tokenBodies.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ access_token: "tok-e2e-42", refresh_token: "ref-e2e", expires_in: 3600 }));
    });
    return;
  }
  const q = (u.searchParams.get("q") ?? "").toLowerCase();
  const page = Number(u.searchParams.get("page") ?? 0);
  const matches = ITEMS.filter((x) => x.name.toLowerCase().includes(q));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ items: matches.slice(page * 10, page * 10 + 10), hasMore: (page + 1) * 10 < matches.length }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const serverUrl = `http://127.0.0.1:${server.address().port}`;

const app = spawn(electronBin, [`--remote-debugging-port=${port}`, "."], {
  cwd: root,
  // GLIDE_EXT_FAKE_AI: AI.ask answers from a local fake (headless only); GLIDE_EXT_INTERVAL_CAP_MS: background intervals ≤ 1.5 s.
  env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GLIDE_USER_DATA: dataDir, GLIDE_SKIP_ONBOARDING: "1", GLIDE_SHOW_ON_START: "1", GLIDE_HEADLESS: "1", GLIDE_EXT_FAKE_AI: "1", GLIDE_EXT_INTERVAL_CAP_MS: "1500" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  — ${detail}`}`);
};

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !t.url.includes("/hud/"));
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
      }, 15000);
      pending.set(n, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, close: () => ws.close() });
    ws.onerror = (e) => reject(new Error(`websocket error: ${e.message ?? e.type}`));
  });
}

async function main() {
  const page = await targets();
  const cdp = await connect(page.webSocketDebuggerUrl);
  const evaluate = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value;
  };
  const key = async (k, code, keyCode, modifiers = 0) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const press = async (ch, modifiers = 0) => {
    const upper = ch.toUpperCase();
    const code = /^[a-z]$/i.test(ch) ? `Key${upper}` : "";
    const vk = /^[a-z0-9]$/i.test(ch) ? upper.charCodeAt(0) : 0;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, modifiers, text: modifiers ? undefined : ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const META = 4;
  const CTRL = 2;
  const search = async (text) => {
    // Backspace on an empty query pops the view, so only clear when there is text.
    const had = await evaluate(`(() => { const i = document.querySelector('.launcher__head input') ?? document.querySelector('input'); i.focus(); i.select(); return i.value.length > 0; })()`);
    if (had) await key("Backspace", "Backspace", 8);
    if (text) await cdp.send("Input.insertText", { text });
    await sleep(350);
  };
  const ui = () =>
    evaluate(`(() => ({
      view: document.querySelector('.launcher__view')?.dataset.view ?? null,
      crumb: document.querySelector('.crumb__title')?.textContent ?? null,
      rows: [...document.querySelectorAll('[role="option"]')].filter((e) => !e.closest('.actions')).map((e) => ({ t: e.querySelector('.row__title, .extensions-cell__title')?.textContent ?? null, sub: e.querySelector('.row__subtitle')?.textContent ?? null, sel: e.getAttribute('aria-selected') === 'true' })),
      headers: [...document.querySelectorAll('.section-header')].map((e) => e.textContent),
      detailPane: document.querySelector('.navlist__detail')?.textContent ?? null,
      md: document.querySelector('.extensions-detail__body')?.textContent ?? null,
      meta: [...document.querySelectorAll('.extensions-meta dt')].map((e) => e.textContent),
      panel: [...document.querySelectorAll('.actions [role="option"] .action__title')].map((e) => e.textContent),
      toast: (document.querySelector('.extensions-toast') ?? document.querySelector('.toast'))?.textContent ?? null,
      submenu: document.querySelector('.extensions-submenu .actions__head')?.textContent ?? null,
      overlay: document.querySelector('.extensions-overlay')?.textContent ?? null,
      desc: [...document.querySelectorAll('.extensions-form__text')].map((e) => e.textContent),
      focusField: document.activeElement?.dataset?.field ?? null,
      fields: [...document.querySelectorAll('.extensions-form [data-field]')].map((e) => e.dataset.field),
      formErrors: [...document.querySelectorAll('.extensions-form__error')].map((e) => e.textContent),
      alert: document.querySelector('.extensions-alert__title')?.textContent ?? null,
      select: document.querySelector('.extensions-searchbar select')?.value ?? null,
      cells: document.querySelectorAll('.extensions-cell').length,
      empty: document.querySelector('.extensions-emptyview__title')?.textContent ?? null,
    }))()`);
  const waitUi = async (pred, ms = 6000) => {
    const until = Date.now() + ms;
    let s;
    for (;;) {
      s = await ui();
      if (pred(s)) return s;
      if (Date.now() > until) return s;
      await sleep(80);
    }
  };
  const selIndex = (s) => s.rows.findIndex((r) => r.sel);
  const backToRoot = async () => {
    for (let i = 0; i < 6; i++) {
      if (!(await ui()).view) return;
      await evaluate(`document.querySelector('.launcher__back')?.click()`);
      await sleep(250);
    }
  };
  const runCommand = async (title) => {
    await backToRoot();
    await search(title);
    const s = await ui();
    const idx = s.rows.findIndex((r) => r.t === title);
    if (idx < 0) return false;
    for (let i = selIndex(s); i < idx; i++) await key("ArrowDown", "ArrowDown", 40);
    await key("Enter", "Enter", 13);
    await sleep(500);
    return true;
  };

  await sleep(1500);
  await evaluate(`(() => { const st = document.createElement('style'); st.textContent = '.launcher * { pointer-events: none !important; }'; document.head.append(st); })()`);

  // --- import ---------------------------------------------------------------------------------------
  const support = await evaluate(`window.glide.feature("extensions", "raycastSupport")`);
  check("esbuild is available in the dev build", support?.canBuild === true, JSON.stringify(support));
  const imported = [];
  for (const name of ["rc-fruits", "rc-notes", "rc-colors", "rc-fetch", "rc-compat"]) {
    const res = await evaluate(`window.glide.feature("extensions", "install", { kind: "raycast-folder", path: ${JSON.stringify(path.join(fixtures, name))} }).then((r) => r.title + ":" + r.runtime + ":" + r.commands.length, (e) => "ERR " + e.message)`);
    imported.push(res);
  }
  check("imported 5 Raycast fixture extensions", imported.every((r) => /:raycast:\d+$/.test(r)), imported.join(" | "));
  await sleep(400);

  // --- rc-fruits: required preference prompt, List ----------------------------------------------------------
  await search("Browse Fruits");
  let s = await ui();
  check("imported command is searchable in the root launcher", s.rows.some((r) => r.t === "Browse Fruits"), JSON.stringify(s.rows.slice(0, 4)));
  const iconSrc = await evaluate(`[...document.querySelectorAll('[role="option"]')].find((e) => e.querySelector('.row__title')?.textContent === 'Browse Fruits')?.querySelector('img')?.getAttribute('src') ?? null`);
  check("command icon comes from the extension's assets/", /extension-icon\.png/.test(iconSrc ?? ""), String(iconSrc));
  await runCommand("Browse Fruits");
  s = await waitUi((x) => x.view === "extensions.preferences");
  check("required preference prompts a preferences form on first run", s.view === "extensions.preferences" && s.fields.includes("greeting"), JSON.stringify({ view: s.view, fields: s.fields }));
  await evaluate(`document.querySelector('[data-field="greeting"]').focus()`);
  await cdp.send("Input.insertText", { text: "Howdy" });
  await key("Enter", "Enter", 13, META);
  s = await waitUi((x) => x.view === "extensions.run" && x.rows.length >= 7);
  check("List renders items after saving preferences", s.view === "extensions.run" && s.rows.slice(0, 3).map((r) => r.t).join(",") === "Apple,Cherry,Strawberry", JSON.stringify(s.rows.slice(0, 4)));
  check("List sections render as headers", ["Red Fruits", "Yellow Fruits", "Green Fruits"].every((h) => s.headers.includes(h)), JSON.stringify(s.headers));
  const acc = await evaluate(`document.querySelector('[aria-selected="true"] .extensions-acc__text')?.textContent ?? null`);
  check("accessories render (price text)", acc === "$1.20", String(acc));

  await key("ArrowDown", "ArrowDown", 40);
  await sleep(80);
  const a1 = selIndex(await ui());
  await key("j", "KeyJ", 74, CTRL);
  await sleep(80);
  const a2 = selIndex(await ui());
  await key("Escape", "Escape", 27);
  await sleep(80);
  await press("j");
  await sleep(80);
  const a3 = selIndex(await ui());
  await press("k");
  await press("k");
  await sleep(80);
  const a4 = selIndex(await ui());
  await press("G");
  await sleep(80);
  const a5 = selIndex(await ui());
  await press("g");
  await press("g");
  await sleep(80);
  const a6 = selIndex(await ui());
  await press("i");
  await sleep(120);
  check("arrow / ⌃J / vim j k G gg navigation in the extension list", a1 === 1 && a2 === 2 && a3 === 3 && a4 === 1 && a5 === 6 && a6 === 0, `${a1} ${a2} ${a3} ${a4} ${a5} ${a6}`);

  await search("ban");
  s = await ui();
  check("built-in filtering (no onSearchTextChange)", s.rows.length === 1 && s.rows[0].t === "Banana", JSON.stringify(s.rows));
  await search("");

  await key("k", "KeyK", 75, META);
  await sleep(300);
  s = await ui();
  check("⌘K shows the item's ActionPanel", ["Show Fruit", "Show Details", "Eat Fruit"].every((t) => s.panel.some((p) => p.startsWith(t))), JSON.stringify(s.panel));
  await key("Escape", "Escape", 27);
  await sleep(150);

  await key("d", "KeyD", 68, META);
  s = await waitUi((x) => !!x.detailPane);
  check("⌘D (action shortcut) toggles isShowingDetail → detail pane", (s.detailPane ?? "").includes("Apple") && (s.detailPane ?? "").includes("Origin"), String(s.detailPane).slice(0, 80));

  await key("Enter", "Enter", 13);
  s = await waitUi((x) => !!x.md);
  check("⏎ runs Action.Push → Detail with markdown + metadata", (s.md ?? "").includes("Howdy, Apple!") && s.meta.includes("Origin") && s.meta.includes("Colour"), JSON.stringify({ md: s.md, meta: s.meta }));
  await key("b", "KeyB", 66, META);
  s = await waitUi((x) => !x.md && x.rows.length > 0);
  check("useNavigation().pop via ⌘B returns to the list", !s.md && s.rows.length >= 7, JSON.stringify({ md: s.md, rows: s.rows.length }));

  await evaluate(`(() => { const el = document.querySelector('.extensions-searchbar select'); el.value = 'Yellow'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  s = await waitUi((x) => x.rows.length === 2);
  check("searchBarAccessory dropdown filters through onChange", s.select === "Yellow" && s.rows.map((r) => r.t).join(",") === "Banana,Lemon", JSON.stringify({ select: s.select, rows: s.rows }));

  await key("x", "KeyX", 88, CTRL);
  s = await waitUi((x) => x.rows.length === 1);
  check("⌃X runs the destructive action (state update + toast)", s.rows[0]?.t === "Lemon" && /Ate Banana/.test(s.toast ?? ""), JSON.stringify({ rows: s.rows, toast: s.toast }));
  await key("x", "KeyX", 88, CTRL);
  s = await waitUi((x) => !!x.empty);
  check("List.EmptyView renders when nothing is left", s.empty === "No fruit left", JSON.stringify(s.empty));

  // --- rc-colors: Grid --------------------------------------------------------------------------------
  await runCommand("Show Color Grid");
  s = await waitUi((x) => x.cells >= 14);
  check("Grid renders sections and cells", s.cells === 14 && s.headers.includes("Colours") && s.headers.includes("Fruit"), JSON.stringify({ cells: s.cells, headers: s.headers }));
  const g0 = selIndex(s);
  await key("ArrowRight", "ArrowRight", 39);
  await sleep(80);
  const g1 = selIndex(await ui());
  await key("ArrowDown", "ArrowDown", 40);
  await sleep(80);
  const g2 = selIndex(await ui());
  await key("ArrowUp", "ArrowUp", 38);
  await key("ArrowLeft", "ArrowLeft", 37);
  await sleep(80);
  const g3 = selIndex(await ui());
  check("Grid keyboard: → moves a cell, ↓ moves a row (4 columns), ↑ ← back", g0 === 0 && g1 === 1 && g2 === 5 && g3 === 0, `${g0} ${g1} ${g2} ${g3}`);
  await key("ArrowDown", "ArrowDown", 40);
  await key("Enter", "Enter", 13);
  s = await waitUi((x) => !!x.md);
  check("Grid ⏎ pushes the item's Detail", (s.md ?? "").includes("Teal") && (s.md ?? "").includes("#008080"), String(s.md));

  // --- rc-notes: Form + LocalStorage + confirmAlert ---------------------------------------------------------
  await runCommand("New Quick Note");
  s = await waitUi((x) => x.fields.length >= 5);
  check("Form renders Raycast field types", ["title", "body", "pinned", "priority", "due", "tags"].every((f) => s.fields.includes(f)), JSON.stringify(s.fields));
  await key("Enter", "Enter", 13, META);
  s = await waitUi((x) => x.formErrors.length > 0);
  check("⌘⏎ with an empty required field shows useForm's validation error", s.formErrors.includes("The item is required"), JSON.stringify(s.formErrors));
  await evaluate(`document.querySelector('[data-field="title"]').focus()`);
  await cdp.send("Input.insertText", { text: "Buy oat milk" });
  await sleep(250);
  await key("Enter", "Enter", 13, META);
  s = await waitUi((x) => (x.md ?? "").includes("Buy oat milk"));
  check("Action.SubmitForm saves and pushes a Detail", (s.md ?? "").includes("Buy oat milk"), String(s.md));

  await runCommand("List Quick Notes");
  s = await waitUi((x) => x.rows.some((r) => r.t === "Buy oat milk"));
  check("LocalStorage persists between commands (usePromise list)", s.rows.some((r) => r.t === "Buy oat milk"), JSON.stringify(s.rows));
  await key("x", "KeyX", 88, CTRL);
  s = await waitUi((x) => !!x.alert);
  check("confirmAlert shows a modal alert", /Delete "Buy oat milk"/.test(s.alert ?? ""), String(s.alert));
  await key("Enter", "Enter", 13);
  s = await waitUi((x) => !x.alert && !!x.empty, 2000);
  // The alert can take a moment to take keyboard focus under load; press again if it is still up.
  if (s.alert) {
    await key("Enter", "Enter", 13);
    s = await waitUi((x) => !x.alert && !!x.empty);
  }
  check("confirming the alert runs the action", !s.alert && s.empty === "No notes yet", JSON.stringify({ alert: s.alert, empty: s.empty, rows: s.rows }));

  // --- rc-fetch: useFetch against the local server -----------------------------------------------------------
  await evaluate(`window.glide.feature("extensions", "setPreferences", "rc-fetch", { baseUrl: ${JSON.stringify(serverUrl)} })`);
  await runCommand("Search Fetched Items");
  s = await waitUi((x) => x.view === "extensions.run" && x.rows.length >= 10);
  check("useFetch renders data from 127.0.0.1", s.rows[0]?.t === "Alpha 0" && s.rows.length >= 10, JSON.stringify(s.rows.slice(0, 3)));
  await search("beta");
  s = await waitUi((x) => x.rows.length > 0 && x.rows.every((r) => (r.t ?? "").startsWith("Beta")));
  check("onSearchTextChange refetches with the query", s.rows.length > 0 && s.rows.every((r) => (r.t ?? "").startsWith("Beta")) && hits.includes("/items?q=beta&page=0"), JSON.stringify({ rows: s.rows.slice(0, 3), hits: hits.slice(-3) }));
  await key("G", "KeyG", 71, 8);
  for (let i = 0; i < 12; i++) await key("ArrowDown", "ArrowDown", 40);
  s = await waitUi((x) => x.rows.length > 10, 4000);
  check("pagination loads the next page near the end of the list", s.rows.length === 15 && hits.includes("/items?q=beta&page=1"), JSON.stringify({ rows: s.rows.length, hits: hits.slice(-3) }));

  // --- rc-compat: Raycast compatibility gaps ---------------------------------------------------------
  const poll = async (fn, ms = 6000, every = 100) => {
    const until = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v || Date.now() > until) return v;
      await sleep(every);
    }
  };
  const supportDir = path.join(dataDir, "features/extensions/support/rc-compat");
  const readLog = (f) => {
    try {
      return readFileSync(path.join(supportDir, f), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const openPanelAndRun = async (title) => {
    await key("k", "KeyK", 75, META);
    await sleep(250);
    await cdp.send("Input.insertText", { text: title });
    await sleep(120);
    await key("Enter", "Enter", 13);
    await sleep(300);
  };
  await evaluate(`window.glide.feature("extensions", "setPreferences", "rc-compat", { server: ${JSON.stringify(serverUrl)}, "actions-demo/label": "A-label", "tick/label": "T-label" })`);

  // Menu bar: a user launch registers the status item; clicks run onAction; the interval relaunches it in the background.
  await runCommand("Compat Menu Bar");
  const menuId = "ext:rc-compat/menu-status";
  const menuState = () => evaluate(`window.glide.feature("extensions", "menuBarState").then((l) => l.find((x) => x.id === ${JSON.stringify(menuId)}) ?? null)`);
  let mb = await poll(async () => {
    const m = await menuState();
    return m?.title === "C0" ? m : null;
  });
  check("menu-bar command renders MenuBarExtra as a status item (title, icon, tooltip)", mb?.title === "C0" && mb?.icon === "🧪" && mb?.tooltip === "Compat Lab", JSON.stringify(mb));
  check(
    "MenuBarExtra.Section / Item / Separator / Submenu map to menu items (disabled section titles and action-less items)",
    JSON.stringify((mb?.menu ?? []).map((m) => (m.separator ? "—" : m.title))) === JSON.stringify(["Counter", "Increment", "Read only", "—", "More"]) && mb.menu[0].enabled === false && mb.menu[2].enabled === false && mb.menu[4].submenu?.[0]?.title === "Say Hi" && mb.menu[1].shortcut === "CommandOrControl+I",
    JSON.stringify(mb?.menu),
  );
  await evaluate(`window.glide.feature("extensions", "menuBarClick", ${JSON.stringify(menuId)}, [1])`);
  mb = await poll(async () => {
    const m = await menuState();
    return m?.title === "C1" ? m : null;
  });
  check("clicking a menu item runs onAction in the extension (counter → C1)", mb?.title === "C1", JSON.stringify(mb?.title));
  await evaluate(`window.glide.feature("extensions", "menuBarClick", ${JSON.stringify(menuId)}, [4, 0])`);
  const hi = await poll(() => readLog("menu.log").includes("hi"));
  check("submenu item click runs its onAction", !!hi, JSON.stringify(readLog("menu.log")));
  const bgMenu = await poll(() => readLog("menu.log").some((l) => l.startsWith("render background")), 8000);
  check("menu-bar `interval` relaunches the command in the background (environment.launchType = background)", !!bgMenu && readLog("menu.log").some((l) => l.startsWith("render userInitiated")), JSON.stringify(readLog("menu.log")));

  // Background no-view interval command: first user launch activates it; it then runs with LaunchType.Background.
  await runCommand("Compat Tick");
  const ticks = await poll(() => {
    const l = readLog("tick.log");
    return l.filter((x) => x.startsWith("background")).length >= 2 ? l : null;
  }, 9000);
  check("no-view `interval` command runs on schedule in the background", !!ticks && ticks[0] === "userInitiated userInitiated T-label" && ticks.slice(1).every((x) => x === "background background T-label"), JSON.stringify(readLog("tick.log")));
  const bgState = await evaluate(`window.glide.feature("extensions", "backgroundState")`);
  const tickState = bgState.find((x) => x.command === "tick");
  check("backgroundState lists the toggle and run count", tickState?.enabled === true && tickState.runs >= 1 && tickState.interval === "10s", JSON.stringify(tickState));
  await evaluate(`window.glide.feature("extensions", "setBackground", "rc-compat", "tick", false)`);
  await sleep(300);
  const afterOff = readLog("tick.log").length;
  await sleep(3200);
  check("disabling the per-command toggle stops background runs", readLog("tick.log").length === afterOff, `${afterOff} → ${readLog("tick.log").length}`);
  await evaluate(`window.glide.feature("extensions", "setBackground", "rc-compat", "menu-status", false)`);
  const removed = await poll(async () => (await menuState()) === null);
  check("deactivating the menu-bar command removes its status item", !!removed, "");

  // Actions: selectedItemId, command-scoped preference, submenus, PickDate, Quick Look, toast actions, snippets.
  await runCommand("Compat Actions");
  s = await waitUi((x) => x.view === "extensions.run" && x.rows.length === 3 && (x.rows[2].sub ?? "").includes("finder=err"));
  check("List selectedItemId selects the item", s.rows[1]?.sel === true, JSON.stringify(s.rows));
  check("command-scoped preference is namespaced (actions-demo sees its own label)", s.rows[0]?.sub === "label=A-label", JSON.stringify(s.rows[0]));
  check(
    "getFrontmostApplication answers through the helper; getSelectedFinderItems fails with a clear error in headless",
    /front=(ok:|err:)/.test(s.rows[2]?.sub ?? "") && /finder=err:.*(not supported|unavailable)/i.test(s.rows[2]?.sub ?? ""),
    String(s.rows[2]?.sub),
  );
  await openPanelAndRun("Share");
  s = await waitUi((x) => !!x.submenu);
  check("ActionPanel.Submenu opens as its own nested ⌘K panel", s.submenu === "Share" && s.panel.some((t) => t.startsWith("Copy Label")) && s.panel.some((t) => t.startsWith("Nested")), JSON.stringify({ sub: s.submenu, panel: s.panel }));
  await cdp.send("Input.insertText", { text: "Nested" });
  await sleep(120);
  await key("Enter", "Enter", 13);
  s = await waitUi((x) => x.submenu === "Share › Nested");
  check("submenus nest (Share › Nested)", s.submenu === "Share › Nested" && s.panel.some((t) => t.startsWith("Deep Action")), JSON.stringify({ sub: s.submenu, panel: s.panel }));
  await key("Escape", "Escape", 27);
  s = await waitUi((x) => x.submenu === "Share");
  check("⎋ in a nested submenu goes back one level", s.submenu === "Share", String(s.submenu));
  await cdp.send("Input.insertText", { text: "Nested" });
  await sleep(120);
  await key("Enter", "Enter", 13);
  await sleep(200);
  await key("Enter", "Enter", 13);
  s = await waitUi((x) => !x.submenu && (x.rows[1]?.sub ?? "").includes("deep=1"));
  check("running an action inside a nested submenu calls its handler and closes the menus", !s.submenu && (s.rows[1]?.sub ?? "").includes("deep=1"), JSON.stringify({ sub: s.submenu, row: s.rows[1] }));

  await openPanelAndRun("Pick a Date");
  s = await waitUi((x) => !!x.overlay);
  const hasPicker = await evaluate(`document.querySelector('.extensions-pickdate input[data-pickdate]')?.type ?? null`);
  check("Action.PickDate opens a date picker overlay", hasPicker === "date", String(hasPicker));
  await key("Enter", "Enter", 13);
  s = await waitUi((x) => /picked=\d{4}-\d{2}-\d{2}/.test(x.rows[1]?.sub ?? ""));
  check("PickDate ⏎ passes a Date to onChange", /picked=\d{4}-\d{2}-\d{2}/.test(s.rows[1]?.sub ?? ""), String(s.rows[1]?.sub));

  await key("y", "KeyY", 89, META);
  s = await waitUi((x) => (x.overlay ?? "").includes("Quick Look preview text"));
  check("Action.ToggleQuickLook (⌘Y) previews the item's quickLook file inside the launcher", (s.overlay ?? "").includes("Quick Look preview text") && (s.overlay ?? "").includes("notes.txt"), String(s.overlay).slice(0, 120));
  await key("Escape", "Escape", 27);
  s = await waitUi((x) => !x.overlay);
  check("⎋ closes Quick Look", !s.overlay, String(s.overlay));
  check("nothing was opened outside the launcher for Quick Look", !/qlmanage|shell\.openPath/.test(appLog), "");

  await key("u", "KeyU", 85, META | 8);
  s = await waitUi((x) => (x.toast ?? "").includes("Archived"));
  check("toast primaryAction is shown on the toast", (s.toast ?? "").includes("Archived") && (s.toast ?? "").includes("Undo"), String(s.toast));
  await key("t", "KeyT", 84, META);
  s = await waitUi((x) => (x.rows[1]?.sub ?? "").includes("undone=true") && !x.toast);
  check("⌘T runs the toast's primary action; toast.hide() removes it", (s.rows[1]?.sub ?? "").includes("undone=true") && !s.toast, JSON.stringify({ toast: s.toast, row: s.rows[1]?.sub }));

  await openPanelAndRun("Create Snippet");
  s = await waitUi((x) => x.view === "extensions.createEntry" && x.fields.includes("text"));
  const snippetText = await evaluate(`document.querySelector('[data-field="text"]')?.value ?? null`);
  check("Action.CreateSnippet opens a prefilled snippet form", s.view === "extensions.createEntry" && snippetText === "Best, Glide", JSON.stringify({ view: s.view, snippetText }));
  await key("Enter", "Enter", 13, META);
  const snip = await poll(() => evaluate(`window.glide.getData().then((d) => d.snippets.find((x) => x.name === "Sig" && x.text === "Best, Glide") ?? null)`));
  check("⌘⏎ saves the snippet in Glide's snippet store", snip?.text === "Best, Glide" && snip?.name === "Sig", JSON.stringify(snip));

  // Form drafts + field refs.
  await runCommand("Compat Draft Form");
  s = await waitUi((x) => x.fields.includes("title"));
  check("Form without a draft shows defaults (draftValues undefined)", s.desc.includes("draft=none"), JSON.stringify(s.desc));
  await evaluate(`(() => { const el = document.querySelector('[data-field="title"]'); el.focus(); el.select(); })()`);
  await cdp.send("Input.insertText", { text: "Draft A" });
  await sleep(400);
  await backToRoot();
  await sleep(2200);
  await runCommand("Compat Draft Form");
  s = await waitUi((x) => x.desc.some((d) => d === "draft=Draft A"));
  const draftVal = await evaluate(`document.querySelector('[data-field="title"]')?.value ?? null`);
  check("enableDrafts restores unsent values (field + draftValues) on the next launch", s.desc.includes("draft=Draft A") && draftVal === "Draft A", JSON.stringify({ desc: s.desc, draftVal }));
  await key("b", "KeyB", 66, META | 8);
  s = await waitUi((x) => x.focusField === "body");
  check("field ref focus() moves focus to that field", s.focusField === "body", String(s.focusField));
  await key("r", "KeyR", 82, META | 8);
  const resetVal = await poll(async () => {
    const v = await evaluate(`document.querySelector('[data-field="title"]')?.value ?? null`);
    return v === "Untitled" ? v : null;
  });
  check("field ref reset() restores the field's defaultValue", resetVal === "Untitled", String(resetVal));
  await key("Enter", "Enter", 13, META);
  s = await waitUi((x) => (x.toast ?? "").includes("Saved Untitled"));
  check("submitting the form shows its toast", (s.toast ?? "").includes("Saved Untitled"), String(s.toast));
  await backToRoot();
  await sleep(2200);
  await runCommand("Compat Draft Form");
  s = await waitUi((x) => x.desc.length > 0);
  check("a submitted form clears its draft", s.desc.includes("draft=none"), JSON.stringify(s.desc));

  // AI (fake asker in headless).
  await runCommand("Compat AI");
  s = await waitUi((x) => (x.md ?? "").includes("Fake AI answer"));
  check("useAI / AI.ask stream from Glide's AI bridge; environment.canAccess(AI)", (s.md ?? "").includes("canAccess=true") && (s.md ?? "").includes("Fake AI answer to: Say hello to Glide"), String(s.md));

  // OAuth: PKCE + glide://oauth redirect (simulated) + token exchange against 127.0.0.1 + encrypted storage.
  await runCommand("Compat OAuth");
  s = await waitUi((x) => (x.overlay ?? "").includes("Sign in with Test Provider"));
  check("OAuth shows a sign-in card before anything is opened", (s.overlay ?? "").includes("Sign in with Test Provider") && !/openExternal .*\/authorize/.test(appLog), String(s.overlay).slice(0, 80));
  await key("Enter", "Enter", 13);
  const authUrl = await poll(() => /\[headless\] shell\.openExternal (\S+\/authorize\?\S+)/.exec(appLog)?.[1] ?? null);
  const authParams = authUrl ? new URL(authUrl).searchParams : new URLSearchParams();
  check("⏎ opens the provider's authorize URL (PKCE S256, glide://oauth redirect)", !!authUrl && authParams.get("code_challenge_method") === "S256" && authParams.get("redirect_uri") === "glide://oauth?package_name=rc-compat" && authParams.get("client_id") === "compat-client", String(authUrl));
  const delivered = await evaluate(`window.glide.feature("extensions", "oauthRedirect", ${JSON.stringify(`glide://oauth?code=e2e-code&state=${authParams.get("state")}`)})`);
  s = await waitUi((x) => (x.md ?? "").includes("token=tok-e2e-42"), 8000);
  const tokenForm = new URLSearchParams(tokenBodies[0] ?? "");
  check("simulated glide://oauth redirect completes the flow; the token endpoint got code + code_verifier", delivered === true && (s.md ?? "").includes("token=tok-e2e-42") && tokenForm.get("code") === "e2e-code" && (tokenForm.get("code_verifier") ?? "").length >= 43, JSON.stringify({ delivered, md: s.md, tokenBodies }));
  const tokenFile = path.join(dataDir, "features/extensions/oauth/rc-compat.bin");
  check("OAuth tokens are stored per extension, not in plain text", existsSync(tokenFile) && !readFileSync(tokenFile, "utf8").includes("tok-e2e-42"), tokenFile);
  await backToRoot();
  await sleep(2200);
  tokenBodies.length = 0;
  await runCommand("Compat OAuth");
  s = await waitUi((x) => (x.md ?? "").includes("token=tok-e2e-42"));
  check("stored tokens are reused on the next launch (no sign-in, no token request)", (s.md ?? "").includes("token=tok-e2e-42") && !s.overlay && tokenBodies.length === 0, JSON.stringify({ overlay: s.overlay, tokenBodies }));

  await backToRoot();
  cdp.close();
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error("e2e error:", err);
} finally {
  app.kill("SIGTERM");
  await sleep(500);
  if (app.exitCode === null) app.kill("SIGKILL");
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length || failed) {
  if (process.env.GLIDE_E2E_LOG) console.log(appLog.split("\n").filter((l) => /extension|rc-|error/i.test(l)).slice(-40).join("\n"));
  process.exit(1);
}
