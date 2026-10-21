// Samples the launcher's input value and rows over time to expose response-ordering bugs.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
// The electron package exports the real binary path; spawning node_modules/.bin/electron
// would kill only the wrapper and orphan Electron, which then holds the single-instance lock.
const electronBin = createRequire(import.meta.url)("electron");
import path from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keep = setInterval(() => {}, 1000);
const app = spawn(electronBin, ["--remote-debugging-port=9333", "."], {
  env: { ...process.env, GLIDE_USER_DATA: process.argv[2], GLIDE_SHOW_ON_START: "1" }, stdio: "ignore" });
const json = async (u) => { for (let i = 0; i < 40; i++) { try { return await (await fetch(u)).json(); } catch {} await sleep(250); } };
const page = (await json("http://127.0.0.1:9333/json/list")).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pend.get(m.id)?.(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const snap = async () => (await send("Runtime.evaluate", { expression: `(() => { const r=[...document.querySelectorAll('[role=option]')]; return document.querySelector('input').value + ' | ' + r.length + ' rows | ' + r.slice(0,2).map(e=>e.querySelector('.row__title')?.textContent).join(', ') + ' | selected=' + r.findIndex(e=>e.getAttribute('aria-selected')==='true'); })()`, returnByValue: true })).result.result.value;
const t0 = Date.now(); const log = async (label) => console.log(String(Date.now() - t0).padStart(5), label.padEnd(14), await snap());
for (const ms of [0, 300, 900, 1500]) { await sleep(ms ? ms - (Date.now() - t0) : 0); await log("idle"); }
await send("Runtime.evaluate", { expression: "document.querySelector('input').focus()" });
await send("Input.insertText", { text: "safari" });
for (let i = 0; i < 8; i++) { await log("after 'safari'"); await sleep(150); }
app.kill("SIGKILL"); clearInterval(keep); process.exit(0);
