// End-to-end check of the extension store: serves a test index + tarballs from a 127.0.0.1 server,
// launches Glide headless with GLIDE_STORE_URL pointing at it and drives the Store view over CDP:
// browse, search, category filter, details/screenshot, confirm + install (download and bundled),
// run the installed command, update, checksum/traversal rejection, uninstall.
//
//   pnpm build && node scripts/store-e2e.mjs
//   GLIDE_E2E_PORT (default 9463) · GLIDE_E2E_TMP (parent of temp dirs) · GLIDE_E2E_APP (app dir, default repo)
//   GLIDE_E2E_SHOT=<file.png> saves a screenshot of the store view.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTgz } from "../src/main/features/extensions/store-tar.ts";

const electronBin = createRequire(import.meta.url)("electron");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.resolve(process.env.GLIDE_E2E_APP ?? root);
const work = fs.mkdtempSync(path.join(process.env.GLIDE_E2E_TMP ?? tmpdir(), "glide-store-e2e-"));
const dataDir = path.join(work, "userdata");
const srv = path.join(work, "srv");
fs.mkdirSync(path.join(srv, "pkg"), { recursive: true });
const port = Number(process.env.GLIDE_E2E_PORT ?? 9463);

// --- fixtures -----------------------------------------------------------------------------------
function fixture(version) {
  const dir = path.join(work, `greeter-${version}`);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "e2e-greeter", version, author: "E2E", license: "MIT", glide: { title: "E2E Greeter", description: "Says hello for the store e2e test.", icon: "👋", commands: [{ name: "greet", title: "Say Hello From Store", mode: "no-view" }] } }),
  );
  fs.writeFileSync(path.join(dir, "dist", "greet.js"), `module.exports = async () => { console.log("STORE-E2E-RAN v${version}"); };\n`);
  return dir;
}
function pack(version) {
  const out = path.join(srv, "pkg", `e2e-greeter-${version}.tgz`);
  const json = execFileSync(process.execPath, [path.join(root, "scripts/store-pack.mjs"), fixture(version), "--out", out, "--url", `pkg/e2e-greeter-${version}.tgz`, "--categories", "Testing,Developer Tools"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const entry = JSON.parse(json);
  entry.screenshots = ["shot.png"];
  entry.changelog = [{ version, notes: version === "1.0.0" ? "First release." : "Now greets even harder." }, ...(version === "1.0.0" ? [] : [{ version: "1.0.0", notes: "First release." }])];
  return entry;
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const base = { author: "E2E", version: "1.0.0", categories: ["Testing"], kind: "glide", minGlideVersion: "0.1.0", screenshots: [], changelog: [] };
const tamperedTgz = createTgz([{ path: "package/package.json", data: JSON.stringify({ name: "e2e-tampered", version: "1.0.0", glide: { title: "Tampered", description: "x", commands: [{ name: "a", title: "A" }] } }) }, { path: "package/a.js", data: "module.exports=()=>{}" }]);
fs.writeFileSync(path.join(srv, "pkg", "tampered.tgz"), tamperedTgz);
const evilTgz = createTgz([{ path: "package/package.json", data: "{}" }, { path: "package/../../../store-e2e-escape.txt", data: "pwned" }]);
fs.writeFileSync(path.join(srv, "pkg", "evil.tgz"), evilTgz);
const extras = [
  { ...base, id: "e2e-tampered", name: "e2e-tampered", title: "Tampered Package", description: "Its checksum does not match.", commands: [{ name: "a", title: "A" }], download: { url: "pkg/tampered.tgz", sha256: "0".repeat(64), size: tamperedTgz.length } },
  { ...base, id: "e2e-evil", name: "e2e-evil", title: "Evil Package", description: "Tries to escape the install folder.", commands: [{ name: "a", title: "A" }], download: { url: "pkg/evil.tgz", sha256: sha(evilTgz), size: evilTgz.length } },
  { ...base, id: "e2e-future", name: "e2e-future", title: "Future Package", description: "Needs a newer Glide.", minGlideVersion: "99.0.0", commands: [{ name: "a", title: "A" }], download: { url: "pkg/evil.tgz", sha256: sha(evilTgz), size: evilTgz.length } },
];
let index = { schemaVersion: 1, extensions: [pack("1.0.0"), ...extras] };
const v11 = pack("1.1.0");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const hits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  hits.push(u.pathname);
  if (u.pathname === "/store/index.json") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(index));
  }
  if (u.pathname === "/store/shot.png") {
    res.setHeader("content-type", "image/png");
    return res.end(PNG);
  }
  const m = /^\/store\/pkg\/([\w.-]+\.tgz)$/.exec(u.pathname);
  if (m && fs.existsSync(path.join(srv, "pkg", m[1]))) {
    res.setHeader("content-type", "application/gzip");
    return res.end(fs.readFileSync(path.join(srv, "pkg", m[1])));
  }
  res.statusCode = 404;
  res.end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const storeUrl = `http://127.0.0.1:${server.address().port}/store/index.json`;

const app = spawn(electronBin, [`--remote-debugging-port=${port}`, "."], {
  cwd: appDir,
  env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GLIDE_USER_DATA: dataDir, GLIDE_SHOW_ON_START: "1", GLIDE_HEADLESS: "1", GLIDE_SKIP_ONBOARDING: "1", GLIDE_STORE_URL: storeUrl },
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

async function target() {
  for (let i = 0; i < 80; i++) {
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
      }, 20000);
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
  const page = await target();
  const cdp = await connect(page.webSocketDebuggerUrl);
  const evaluate = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value;
  };
  const META = 4;
  const key = async (k, code, keyCode, modifiers = 0) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const enter = () => key("Enter", "Enter", 13);
  const escape = () => key("Escape", "Escape", 27);
  const focusInput = () => evaluate(`(() => { const i = document.querySelector('.launcher__head input') ?? document.querySelector('input'); i?.focus(); return !!i; })()`);
  const search = async (text) => {
    const had = await evaluate(`(() => { const i = document.querySelector('.launcher__head input') ?? document.querySelector('input'); i.focus(); i.select(); return i.value.length > 0; })()`);
    if (had) await key("Backspace", "Backspace", 8);
    if (text) await cdp.send("Input.insertText", { text });
    await sleep(350);
  };
  const ui = () =>
    evaluate(`(() => ({
      view: document.querySelector('.launcher__view')?.dataset.view ?? null,
      rows: [...document.querySelectorAll('[role="option"]')].filter((e) => !e.closest('.actions')).map((e) => ({ t: e.querySelector('.row__title')?.textContent ?? null, sel: e.getAttribute('aria-selected') === 'true', badge: e.querySelector('[data-badge]')?.dataset.badge ?? null })),
      headers: [...document.querySelectorAll('.section-header')].map((e) => e.textContent),
      chip: document.querySelector('.extensions-store-chip--on')?.textContent ?? null,
      chips: [...document.querySelectorAll('.extensions-store-chip')].map((e) => e.textContent),
      detail: document.querySelector('.extensions-store-detail')?.textContent ?? null,
      status: document.querySelector('.extensions-store-detail [data-status]')?.textContent ?? null,
      shot: document.querySelector('.extensions-store-shot')?.getAttribute('src')?.slice(0, 22) ?? null,
      confirm: document.querySelector('.extensions-storeconfirm')?.textContent ?? null,
      toast: document.querySelector('.toast')?.textContent ?? null,
      banner: document.querySelector('.extensions-store-banner')?.textContent ?? null,
    }))()`);
  const waitUi = async (pred, ms = 8000) => {
    const until = Date.now() + ms;
    let s;
    for (;;) {
      s = await ui();
      if (pred(s)) return s;
      if (Date.now() > until) return s;
      await sleep(80);
    }
  };
  const select = async (title) => {
    for (let i = 0; i < 30; i++) {
      const s = await ui();
      const idx = s.rows.findIndex((r) => r.t === title);
      const sel = s.rows.findIndex((r) => r.sel);
      if (idx < 0) return false;
      if (idx === sel) return true;
      await key(idx > sel ? "ArrowDown" : "ArrowUp", idx > sel ? "ArrowDown" : "ArrowUp", idx > sel ? 40 : 38);
      await sleep(40);
    }
    return false;
  };
  const openStore = async () => {
    await evaluate(`window.glide.feature("extensions", "openStore")`);
    await waitUi((s) => s.view === "extensions.store" && s.rows.length > 0);
    await sleep(500);
    await focusInput();
  };
  const indexHits = () => hits.filter((h) => h === "/store/index.json").length;

  await sleep(1500);
  await evaluate(`(() => { const st = document.createElement('style'); st.textContent = '.launcher * { pointer-events: none !important; }'; document.head.append(st); })()`);
  check("no store request before the store is opened", hits.length === 0, JSON.stringify(hits));

  // --- open the store from the root search ---------------------------------------------------------
  let s;
  for (let attempt = 0; attempt < 3; attempt++) {
    await search("Store");
    s = await waitUi((x) => x.rows.some((r) => r.t === "Store"));
    await select("Store");
    await sleep(300);
    await enter();
    s = await waitUi((x) => x.view === "extensions.store" && x.rows.length >= 8);
    if (s.view === "extensions.store") break;
  }
  const titles = s.rows.map((r) => r.t);
  check("Store lists the 5 bundled examples", ["Color Converter", "GitHub Search", "Hacker News", "World Clocks", "UUID Generator"].every((t) => titles.includes(t)), JSON.stringify(titles));
  check("Store lists the remote (127.0.0.1) entries", ["E2E Greeter", "Tampered Package", "Evil Package", "Future Package"].every((t) => titles.includes(t)), JSON.stringify(titles));
  check("the index was fetched once, on open", indexHits() === 1, JSON.stringify(hits));
  check("category chips come from the index", ["All Categories", "Developer Tools", "News", "Testing"].every((c) => s.chips.includes(c)), JSON.stringify(s.chips));
  if (process.env.GLIDE_E2E_SHOT) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.GLIDE_E2E_SHOT, Buffer.from(shot.result.data, "base64"));
  }

  // --- search + details ------------------------------------------------------------------------------
  await search("greeter");
  s = await waitUi((x) => x.rows.length === 1);
  check("search filters the store", s.rows.length === 1 && s.rows[0].t === "E2E Greeter", JSON.stringify(s.rows));
  s = await waitUi((x) => x.shot === "data:image/png;base64,");
  check("details pane shows description, commands and changelog", /Says hello/.test(s.detail ?? "") && /Say Hello From Store/.test(s.detail ?? "") && /First release/.test(s.detail ?? ""), s.detail);
  check("details pane shows the screenshot (fetched by main as data: URL)", s.shot === "data:image/png;base64,", String(s.shot));

  // --- category filter (⌘] cycles) ------------------------------------------------------------------
  await search("");
  for (let i = 0; i < 8 && (await ui()).chip !== "Testing"; i++) {
    await key("]", "BracketRight", 221, META);
    await sleep(120);
  }
  s = await ui();
  check("⌘] selects the Testing category and filters", s.chip === "Testing" && s.rows.length === 4 && s.rows.every((r) => /E2E|Tampered|Evil|Future/.test(r.t)), JSON.stringify({ chip: s.chip, rows: s.rows }));
  for (let i = 0; i < 8 && (await ui()).chip !== "All Categories"; i++) {
    await key("[", "BracketLeft", 219, META);
    await sleep(120);
  }

  // --- confirm + cancel ----------------------------------------------------------------------------
  await search("UUID");
  await waitUi((x) => x.rows.length === 1);
  await enter();
  s = await waitUi((x) => !!x.confirm);
  check("Install asks for confirmation mentioning third-party code", /third-party code/.test(s.confirm ?? "") && /bundled with Glide/i.test(s.confirm ?? ""), s.confirm);
  await escape();
  s = await waitUi((x) => !x.confirm);
  await sleep(300);
  s = await ui();
  check("⎋ cancels: nothing installed, store stays open", s.view === "extensions.store" && !s.rows[0]?.badge, JSON.stringify(s));

  // --- bundled install (no network) ----------------------------------------------------------------
  const before = hits.length;
  await search("World Clocks");
  await waitUi((x) => x.rows.length === 1);
  await enter();
  await waitUi((x) => !!x.confirm);
  await enter();
  s = await waitUi((x) => x.rows[0]?.badge === "installed");
  check("bundled example installs without network", s.rows[0]?.badge === "installed" && hits.length === before, JSON.stringify({ rows: s.rows, hits: hits.slice(before) }));

  // --- download install ----------------------------------------------------------------------------
  await search("greeter");
  await waitUi((x) => x.rows.length === 1);
  await enter();
  s = await waitUi((x) => !!x.confirm);
  check("download confirm states size + checksum", /verifies its SHA-256/.test(s.confirm ?? ""), s.confirm);
  await enter();
  s = await waitUi((x) => x.rows[0]?.badge === "installed", 15000);
  check("E2E Greeter installs from the 127.0.0.1 tarball", s.rows[0]?.badge === "installed" && hits.includes("/store/pkg/e2e-greeter-1.0.0.tgz"), JSON.stringify({ rows: s.rows, toast: s.toast }));
  check("installed toast names the command", /Installed E2E Greeter v1\.0\.0/.test(s.toast ?? "") , String(s.toast));
  const list = await evaluate(`window.glide.feature("extensions", "list").then((l) => l.map((e) => e.name + "@" + e.version + ":" + (e.source?.kind ?? "")))`);
  check("registry has the store install", list.includes("e2e-greeter@1.0.0:store"), JSON.stringify(list));

  // --- run the installed command -----------------------------------------------------------------
  await enter(); // installed + up to date: ⏎ runs the first command
  for (let i = 0; i < 40 && !appLog.includes("STORE-E2E-RAN v1.0.0"); i++) await sleep(100);
  check("⏎ on an installed extension runs its command", appLog.includes("STORE-E2E-RAN v1.0.0"));
  await openStore();

  // --- update ----------------------------------------------------------------------------------------
  index = { schemaVersion: 1, extensions: [v11, ...extras] };
  await search("greeter");
  await key("r", "KeyR", 82, META);
  s = await waitUi((x) => x.rows[0]?.badge === "update");
  check("⌘R refreshes the index and shows Update", s.rows[0]?.badge === "update" && indexHits() === 2 && s.headers.includes("Updates Available"), JSON.stringify({ rows: s.rows, headers: s.headers, hits: indexHits() }));
  check("details show installed vs. available and what's new", /Installed v1\.0\.0 — v1\.1\.0 available/.test(s.status ?? "") && /Now greets even harder/.test(s.detail ?? ""), JSON.stringify({ status: s.status }));
  await enter();
  s = await waitUi((x) => !!x.confirm);
  check("update asks for confirmation", /Update E2E Greeter to v1\.1\.0/.test(s.confirm ?? ""), s.confirm);
  await enter();
  s = await waitUi((x) => x.rows[0]?.badge === "installed", 15000);
  check("update installs v1.1.0", s.rows[0]?.badge === "installed" && /Updated E2E Greeter v1\.1\.0/.test(s.toast ?? ""), JSON.stringify({ rows: s.rows, toast: s.toast }));
  await enter();
  for (let i = 0; i < 40 && !appLog.includes("STORE-E2E-RAN v1.1.0"); i++) await sleep(100);
  check("the updated command runs the new code", appLog.includes("STORE-E2E-RAN v1.1.0"));
  await openStore();

  // --- rejected packages -------------------------------------------------------------------------
  for (const [title, re, label] of [
    ["Tampered Package", /Checksum mismatch/, "sha256 mismatch is rejected"],
    ["Evil Package", /traversal/i, "path-traversal tarball is rejected"],
  ]) {
    await search(title);
    await waitUi((x) => x.rows.length === 1);
    await enter();
    await waitUi((x) => !!x.confirm);
    await enter();
    s = await waitUi((x) => re.test(x.toast ?? ""), 10000);
    await sleep(200);
    const after = await ui();
    check(label, re.test(s.toast ?? "") && !after.rows[0]?.badge, JSON.stringify({ toast: s.toast, rows: after.rows }));
  }
  const escaped = ["store-e2e-escape.txt", "userdata/store-e2e-escape.txt", "userdata/features/store-e2e-escape.txt", "userdata/features/extensions/store-e2e-escape.txt"].some((p) => fs.existsSync(path.join(work, p)));
  check("nothing escaped the extraction folder", !escaped);
  await search("Future Package");
  await waitUi((x) => x.rows.length === 1);
  s = await ui();
  check("an extension needing a newer Glide is marked unavailable", /Requires Glide 99\.0\.0/.test(s.detail ?? ""), s.detail);

  // --- uninstall --------------------------------------------------------------------------------------
  await search("greeter");
  await waitUi((x) => x.rows.length === 1);
  await key("x", "KeyX", 88, 2);
  s = await waitUi((x) => !!x.confirm);
  check("⌃X asks to confirm uninstall", /Uninstall E2E Greeter/.test(s.confirm ?? ""), s.confirm);
  await enter();
  s = await waitUi((x) => /Uninstalled/.test(x.toast ?? ""));
  await sleep(300);
  s = await ui();
  check("uninstall removes it", !s.rows[0]?.badge && /Uninstalled E2E Greeter/.test(s.toast ?? ""), JSON.stringify({ rows: s.rows, toast: s.toast }));
  const list2 = await evaluate(`window.glide.feature("extensions", "list").then((l) => l.map((e) => e.name))`);
  check("registry no longer lists it (World Clocks stays)", !list2.includes("e2e-greeter") && list2.includes("timezones"), JSON.stringify(list2));
  check("only 127.0.0.1 was contacted (no public index fetch)", !/raw\.githubusercontent/.test(appLog));
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
  if (!process.env.GLIDE_E2E_KEEP) fs.rmSync(work, { recursive: true, force: true });
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length || failed) {
  if (process.env.GLIDE_E2E_LOG) console.log(appLog.split("\n").filter((l) => /store|extension|error/i.test(l)).slice(-60).join("\n"));
  process.exit(1);
}
