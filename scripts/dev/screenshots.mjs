// Captures screenshots of the launcher and the workflow editor from the real app.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
const electronBin = createRequire(import.meta.url)("electron");
const [dataDir, outDir] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keep = setInterval(() => {}, 1000);
const app = spawn(electronBin, ["--remote-debugging-port=9333", "."], { env: { ...process.env, GLIDE_USER_DATA: dataDir, GLIDE_SHOW_ON_START: "1" }, stdio: "ignore" });
const list = async () => { for (let i = 0; i < 40; i++) { try { const l = await (await fetch("http://127.0.0.1:9333/json/list")).json(); if (l.some((t) => t.type === "page")) return l; } catch {} await sleep(250); } return []; };
process.on("exit", () => app.kill());
const connect = async (url) => { const ws = new WebSocket(url); let id = 0; const p = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { p.get(m.id)?.(m); p.delete(m.id); } }; await new Promise((r) => (ws.onopen = r)); return (method, params = {}) => new Promise((res) => { const n = ++id; p.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); }); };
const shot = async (send, name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, "base64")); console.log("saved", name); };
const launcher = await connect((await list()).find((t) => t.type === "page").webSocketDebuggerUrl);
await sleep(2000);
await shot(launcher, "launcher-empty.png");
await launcher("Runtime.evaluate", { expression: "document.querySelector('input').focus()" });
await launcher("Input.insertText", { text: "s" });
await sleep(1200);
await shot(launcher, "launcher-query.png");
await launcher("Runtime.evaluate", { expression: "window.glide.getData().then(d => window.glide.openSettings('workflows/' + d.workflows[0].id))", awaitPromise: true });
let page; for (let i = 0; i < 25 && !page; i++) { await sleep(200); page = (await list()).find((t) => t.url.includes("#/settings")); }
const settings = await connect(page.webSocketDebuggerUrl);
await sleep(2000);
await shot(settings, "workflow-editor.png");
app.kill(); clearInterval(keep); process.exit(0);
