// Headless CDP proof for Glide Agent 2.0: ⌘⏎ from the launcher, plan + confirmation, follow-up
// (multi-turn via the mock script), ⌘Z undo, history. Never shows a window (GLIDE_HEADLESS=1).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Usage: GLIDE_E2E_TMP=<scratch dir> node src/main/features/agent/e2e/agent-cdp.mjs  (after pnpm build:main && pnpm build:renderer)
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../../../../..");
const outDir = fs.mkdtempSync(path.join(process.env.GLIDE_E2E_TMP ?? os.tmpdir(), "glide-agent-e2e-"));
const electronBin = createRequire(path.join(root, "package.json"))("electron");
const port = Number(process.env.GLIDE_E2E_PORT ?? 9469);
const dataDir = fs.mkdtempSync(path.join(outDir, "userdata-"));
const app = spawn(electronBin, [`--remote-debugging-port=${port}`, "."], {
  cwd: root,
  env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GLIDE_USER_DATA: dataDir, GLIDE_SHOW_ON_START: "1", GLIDE_HEADLESS: "1", GLIDE_AGENT_MOCK: path.join(here, "agent-mock.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && !/#\/./.test(t.url));
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error("no renderer target");
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => (pending.delete(n), reject(new Error(`CDP ${method} timed out`))), 8000);
      pending.set(n, (m) => (clearTimeout(t), resolve(m)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, close: () => ws.close() });
    ws.onerror = () => reject(new Error("ws error"));
  });
}

async function main() {
  const page = await target();
  const cdp = await connect(page.webSocketDebuggerUrl);
  const evaluate = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const key = async (k, code, vk, modifiers = 0) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const META = 4;
  const typeText = async (text) => {
    await evaluate(`document.querySelector('.launcher__input')?.focus()`);
    await cdp.send("Input.insertText", { text });
  };
  const waitFor = async (expr, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expr).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  };
  const shot = async (name) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) fs.writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, "base64"));
  };
  const view = () =>
    evaluate(`(() => {
      const v = document.querySelector('[data-testid="agent-view"]');
      return v && {
        status: v.dataset.status, runs: Number(v.dataset.runs), conversation: v.dataset.conversation,
        steps: [...v.querySelectorAll('[data-testid="agent-step"]')].map((s) => ({ tool: s.dataset.tool, status: s.dataset.status, undo: s.dataset.undo })),
        plan: [...v.querySelectorAll('[data-testid="agent-plan"] li')].map((li) => li.dataset.status + ":" + li.textContent),
        confirm: [...v.querySelectorAll('[data-testid="agent-confirm"] li')].map((li) => li.textContent),
        summary: [...v.querySelectorAll('[data-testid="agent-summary"]')].map((s) => s.textContent),
        texts: [...v.querySelectorAll('.agent-row__text')].map((t) => t.textContent),
      };
    })()`);
  const data = () => evaluate(`window.glide.getData().then((d) => ({ snippets: d.snippets.map((s) => s.name), quicklinks: d.quicklinks.map((q) => q.name), workflows: d.workflows.map((w) => w.name) }))`);
  const timers = () => evaluate(`window.glide.feature("timers", "state").then((s) => s.timers.length)`);

  await waitFor(`!!document.querySelector('.launcher__input')`, 15000);
  await sleep(800);
  await evaluate(`(() => { const st = document.createElement('style'); st.textContent = '.launcher * { pointer-events: none !important; }'; document.head.append(st); })()`);
  const status = await evaluate(`window.glide.feature("agent", "status")`);
  check("agent uses the scripted mock client (no API key, no network)", status?.mock === true && status?.hasKey === true, JSON.stringify(status));

  // 1. ⌘⏎ from the root search sends the query straight to the agent.
  await typeText("make me a signature snippet and a GitHub search quicklink");
  await sleep(300);
  await key("Enter", "Enter", 13, META);
  check("⌘⏎ in the launcher opens the agent view with the query", await waitFor(`!!document.querySelector('.launcher__view[data-view="agent.run"] [data-testid="agent-view"]')`), "");
  check("plan + confirmation shown before anything runs", await waitFor(`document.querySelector('[data-testid="agent-view"]')?.dataset.status === "confirming"`), "");
  let v = await view();
  check("plan lists 2 items", v.plan.length === 2, JSON.stringify(v.plan));
  check("confirmation lists plain-English summaries", v.confirm.length === 2 && v.confirm[0].includes("Create the snippet “Sig”"), JSON.stringify(v.confirm));
  let d = await data();
  check("nothing created before approval", !d.snippets.includes("Sig") && !d.quicklinks.includes("GH Search"), JSON.stringify(d));
  await shot("1-confirm.png");
  await key("Enter", "Enter", 13);
  check("run finishes after ⏎", await waitFor(`document.querySelector('[data-testid="agent-view"]')?.dataset.status === "done"`), "");
  await sleep(200);
  v = await view();
  d = await data();
  check("snippet and quicklink created", d.snippets.includes("Sig") && d.quicklinks.includes("GH Search"), JSON.stringify(d));
  check("live step list: both steps ✓ with undo available", v.steps.length === 2 && v.steps.every((s) => s.status === "ok" && s.undo === "available"), JSON.stringify(v.steps));
  check("plan items show ✓ status", v.plan.every((p) => p.startsWith("ok:")), JSON.stringify(v.plan));
  check("final summary entry", v.summary.length === 1 && v.summary[0].includes("2 actions done"), JSON.stringify(v.summary));

  // 2. Follow-up in the same conversation (mock turn 3 is only reached when history is carried).
  await typeText("also start a 1 minute tea timer");
  await key("Enter", "Enter", 13);
  check("follow-up asks for confirmation", await waitFor(`(() => { const v = document.querySelector('[data-testid="agent-view"]'); return v?.dataset.status === "confirming" && v.dataset.runs === "2"; })()`), "");
  v = await view();
  check("follow-up step is start_timer (mock turn 3 ⇒ earlier turns were sent)", v.confirm.some((c) => c.includes("1 min timer")), JSON.stringify(v.confirm));
  await key("Enter", "Enter", 13);
  check("follow-up finishes", await waitFor(`document.querySelector('[data-testid="agent-view"]')?.dataset.status === "done"`), "");
  await sleep(200);
  v = await view();
  check("one conversation, two requests, same conversation id", v.runs === 2 && !!v.conversation, JSON.stringify({ runs: v.runs, c: v.conversation }));
  check("follow-up reply rendered", v.texts.some((t) => t.includes("follow-up")), JSON.stringify(v.texts));
  check("timer running", (await timers()) === 1, "");
  await shot("2-followup.png");

  // 2b. ⌘S saves the follow-up's steps as a Glide workflow (timers.start feature action).
  await key("s", "KeyS", 83, META);
  check("⌘S saves the last request as a workflow", await waitFor(`window.glide.getData().then((d) => d.workflows.some((w) => w.name.startsWith("also start a 1 minute tea timer") && w.actions[0]?.type === "feature" && w.actions[0]?.params.action === "start"))`), JSON.stringify((await data()).workflows));

  // 3. ⌘Z undoes the newest request, then the one before.
  await key("z", "KeyZ", 90, META);
  check("⌘Z cancels the follow-up's timer", await waitFor(`window.glide.feature("timers", "state").then((s) => s.timers.length === 0)`), "");
  await sleep(200);
  await key("z", "KeyZ", 90, META);
  check("second ⌘Z deletes the snippet and quicklink", await waitFor(`window.glide.getData().then((d) => !d.snippets.some((s) => s.name === "Sig") && !d.quicklinks.some((q) => q.name === "GH Search"))`), "");
  await sleep(200);
  v = await view();
  check("steps marked undone", v.steps.every((s) => s.undo === "done"), JSON.stringify(v.steps));
  await shot("3-undone.png");

  // 4. History: saved, searchable, redacted file on disk; ⌘Y opens the history view.
  const list = await evaluate(`window.glide.feature("agent", "listConversations", "signature")`);
  check("conversation saved and searchable", list.length === 1 && list[0].runs === 2, JSON.stringify(list));
  await key("y", "KeyY", 89, META);
  check("⌘Y opens agent history", await waitFor(`document.querySelectorAll('[data-testid="agent-history-row"]').length === 1`), "");
  await shot("4-history.png");

  // 5. Read-only mode hides mutating tools (status reflects it).
  await evaluate(`window.glide.feature("agent", "setSettings", { readOnly: true })`);
  const st2 = await evaluate(`window.glide.feature("agent", "status")`);
  check("read-only toggle persists", st2.readOnly === true, "");
  cdp.close();
}

try {
  await main();
} catch (err) {
  check("script error", false, String(err?.stack ?? err));
} finally {
  app.kill("SIGTERM");
  await sleep(800);
  if (app.exitCode === null) app.kill("SIGKILL");
  const file = fs.readdirSync(dataDir, { recursive: true }).find((f) => String(f).endsWith("conversations.json"));
  if (file) {
    const raw = fs.readFileSync(path.join(dataDir, String(file)), "utf8");
    check("conversations.json written on disk", raw.includes("signature snippet"), String(file));
  } else check("conversations.json written on disk", false, "missing");
  const headlessLines = appLog.split("\n").filter((l) => l.includes("[headless]")).slice(0, 12);
  fs.writeFileSync(path.join(outDir, "app.log"), appLog);
  console.log(`screenshots and log: ${outDir}`);
  console.log("headless log sample:\n" + headlessLines.join("\n"));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
