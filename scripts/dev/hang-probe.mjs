// Reproduces the launcher hang and captures the main-process stack via the Node inspector.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
// The electron package exports the real binary path; spawning node_modules/.bin/electron
// would kill only the wrapper and orphan Electron, which then holds the single-instance lock.
const electronBin = createRequire(import.meta.url)("electron");
import path from "node:path";
const root = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keep = setInterval(() => {}, 1000);
const app = spawn(electronBin, ["--inspect=9334", "--remote-debugging-port=9333", "."], {
  env: { ...process.env, GLIDE_USER_DATA: process.argv[2], GLIDE_SHOW_ON_START: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; app.stdout.on("data", (d) => (log += d)); app.stderr.on("data", (d) => (log += d));
function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const pend = new Map(); const events = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pend.get(m.id)?.(m); pend.delete(m.id); } else events.push(m); };
  const send = (method, params = {}, ms = 4000) => new Promise((res) => { const n = ++id; const t = setTimeout(() => { pend.delete(n); res({ timeout: true }); }, ms); pend.set(n, (m) => { clearTimeout(t); res(m); }); ws.send(JSON.stringify({ id: n, method, params })); });
  return new Promise((r) => (ws.onopen = () => r({ send, events, ws })));
}
const json = async (u) => { for (let i = 0; i < 40; i++) { try { return await (await fetch(u)).json(); } catch {} await sleep(250); } };
const page = (await json("http://127.0.0.1:9333/json/list")).find((t) => t.type === "page");
const node = (await json("http://127.0.0.1:9334/json/list"))[0];
const r = await cdp(page.webSocketDebuggerUrl);
const m = await cdp(node.webSocketDebuggerUrl);
await m.send("Debugger.enable");
await sleep(1500);
const ev = (e) => r.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
console.log("initial rows:", JSON.stringify((await ev(`document.querySelectorAll('[role=option]').length`)).result?.result?.value));
console.log("direct search:", JSON.stringify((await ev(`window.glide.search('').then(r => r.sections.map(s => s.id + ':' + s.items.length))`)).result?.result?.value));
await ev(`document.querySelector('input').focus()`);
console.log("insertText:", JSON.stringify(await r.send("Input.insertText", { text: "saf" })));
await sleep(800);
const probe = await ev(`document.querySelectorAll('[role=option]').length`);
console.log("after typing:", JSON.stringify(probe.timeout ? "RENDERER/BROWSER UNRESPONSIVE" : probe.result?.result?.value));
const p = await m.send("Debugger.pause", {}, 3000);
await sleep(500);
const paused = m.events.find((e) => e.method === "Debugger.paused");
if (paused) {
  console.log("MAIN PROCESS STACK:");
  for (const f of paused.params.callFrames.slice(0, 15)) console.log(`  ${f.functionName || "(anon)"}  ${f.url.split("/").slice(-2).join("/")}:${f.location.lineNumber + 1}`);
} else console.log("main process did not pause:", JSON.stringify(p).slice(0, 200));
console.log("--- app log (filtered) ---\n" + log.split("\n").filter((l) => l && !/DevTools|Debugger listening|For help/.test(l)).slice(0, 15).join("\n"));
app.kill("SIGKILL"); clearInterval(keep); process.exit(0);
