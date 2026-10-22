// Headless CDP proof for Glide Agent as an MCP client (GLIDE_HEADLESS=1, mock Claude client, our own fixture server).
//  1. configure a stdio fixture server via the agent's methods, Test Connection from Settings → Agent
//  2. a scripted agent turn calls one read-only tool (auto-runs) and one that needs confirmation
//  3. quit Glide (app.quit() via the main inspector → will-quit) → the stdio server is gone
//  4. relaunch, connect, SIGKILL Glide (crash) → the watchdog stops the server
// Usage (after pnpm build:main && pnpm build:renderer):
//   GLIDE_TEST_TMP=<scratch> GLIDE_TEST_PORT_BASE=9497 GLIDE_TEST_PORT_COUNT=2 node src/main/features/agent/e2e/mcp-cdp.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchGlide, snapshotApp, sleep, testTmpRoot } from "../../../../../tests/harness/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "mcp-fixture-server.mjs");
const outDir = fs.mkdtempSync(path.join(testTmpRoot(), "glide-mcp-e2e-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}
const serverPids = (log) => (fs.existsSync(log) ? [...fs.readFileSync(log, "utf8").matchAll(/^pid (\d+)$/gm)].map((m) => Number(m[1])) : []);
const toolCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).tool) : []);
const serverConfig = (log) => ({ name: "fixture", transport: "stdio", command: process.execPath, args: [FIXTURE], env: { FIXTURE_LOG: log }, autoRunReadOnly: true, enabled: true });

const appDir = snapshotApp();
const env = { GLIDE_AGENT_MOCK: path.join(here, "mcp-mock.json") };

async function phase1() {
  const log = path.join(outDir, "fixture-1.log");
  const app = await launchGlide({ appDir, env, inspectMain: true });
  try {
    const page = await app.launcher();
    const saved = await page.eval((cfg) => window.glide.feature("agent", "mcpSave", cfg), serverConfig(log));
    check("server saved; secrets masked in what the renderer gets", saved.ok && saved.server.env.FIXTURE_LOG === "__glide_secret_unchanged__", JSON.stringify(saved.server?.env));
    const onDisk = fs.readFileSync(path.join(app.dataDir, "features/agent/mcp-servers.json"), "utf8");
    check("env value encrypted on disk", !onDisk.includes(log) && onDisk.includes('"enc"'));
    check("lazy: nothing spawned before it's needed", serverPids(log).length === 0);

    // Settings → Agent → MCP Servers → Test Connection.
    const settings = await app.settings("agent");
    await settings.waitForSelector('[data-testid="agent-mcp-server"]', { timeout: 10000 });
    await settings.eval(() => document.querySelector('[data-testid="agent-mcp-test"]').click());
    const tested = await settings.waitFor(() => document.querySelector('[data-testid="agent-mcp-test-result"]')?.textContent, { timeout: 15000 }).catch((e) => String(e));
    check("Test Connection lists the tools", /Connected to glide-fixture .* 8 tools/.test(tested), tested);
    const toolRows = await settings.eval(() => [...document.querySelectorAll('[data-testid="agent-mcp-tool"]')].map((r) => r.dataset.tool));
    check("tool rows show namespaced names", toolRows.includes("mcp__fixture__echo") && toolRows.includes("mcp__fixture__add_note"), toolRows.join(","));
    await settings.eval(() => document.querySelector('[data-testid="agent-mcp"]').scrollIntoView());
    fs.writeFileSync(path.join(outDir, "1-settings-mcp.png"), await settings.screenshot());

    // Agent turn: echo (readOnlyHint, server trusted) runs directly; add_note asks first.
    await page.eval(() => window.glide.feature("agent", "openFromLauncher", "use the fixture server"));
    const confirming = await page.waitFor(() => document.querySelector('[data-testid="agent-view"]')?.dataset.status === "confirming", { timeout: 15000 }).catch(() => false);
    check("run pauses for confirmation", confirming);
    const v1 = await page.eval(() => ({
      steps: [...document.querySelectorAll('[data-testid="agent-step"]')].map((s) => `${s.dataset.tool}:${s.dataset.status}`),
      confirm: [...document.querySelectorAll('[data-testid="agent-confirm"] li')].map((li) => li.textContent),
      titles: [...document.querySelectorAll(".agent-row__tool")].map((t) => t.textContent),
    }));
    check("read-only tool isn't part of the confirmation (it runs without asking)", v1.steps.join(",") === "mcp__fixture__echo:queued,mcp__fixture__add_note:awaiting", v1.steps.join(","));
    check("confirmation shows the plain-English MCP summary", v1.confirm.length === 1 && v1.confirm[0] === 'Run add_note on fixture with {"text":"buy milk"}', JSON.stringify(v1.confirm));
    check("transcript shows the server name", v1.titles.some((t) => t === "fixture › Echo") && v1.titles.some((t) => t === "fixture › add_note"), JSON.stringify(v1.titles));
    check("add_note not run before approval", !toolCalls(log).includes("add_note"), toolCalls(log).join(","));
    fs.writeFileSync(path.join(outDir, "2-confirm.png"), await page.screenshot());
    await page.press("Enter");
    const done = await page.waitFor(() => document.querySelector('[data-testid="agent-view"]')?.dataset.status === "done", { timeout: 15000 }).catch(() => false);
    check("run finishes after ⏎", done);
    const v2 = await page.eval(() => ({
      steps: [...document.querySelectorAll('[data-testid="agent-step"]')].map((s) => `${s.dataset.tool}:${s.dataset.status}`),
      summary: document.querySelector('[data-testid="agent-summary"]')?.textContent ?? "",
      texts: [...document.querySelectorAll(".agent-row__text")].map((t) => t.textContent),
    }));
    check("both MCP steps ✓", v2.steps.join(",") === "mcp__fixture__echo:ok,mcp__fixture__add_note:ok", v2.steps.join(","));
    check("summary counts the action and the lookup", /1 action done · 1 lookup/.test(v2.summary), v2.summary);
    check("fixture server received echo then add_note", toolCalls(log).join(",") === "echo,add_note", toolCalls(log).join(","));
    fs.writeFileSync(path.join(outDir, "3-done.png"), await page.screenshot());

    const pids = serverPids(log);
    const pid = pids.at(-1);
    check("one long-lived stdio server (connection reused across Test + run)", pids.length === 1 && alive(pid), pids.join(","));

    // Quit like ⌘Q / "Quit Glide": app.quit() → will-quit → agent stop() → killAll.
    await app.mainEval("process.mainModule.require('electron').app.quit()").catch(() => undefined);
    // An attached inspector keeps the process alive ("Waiting for the debugger to disconnect"): detach it.
    app._main?.close();
    await until(() => app.exited, 8000);
    check("Glide exited", app.exited);
    check("stdio server is gone after quit", await until(() => !alive(pid), 5000), `pid ${pid}`);
  } finally {
    fs.writeFileSync(path.join(outDir, "app-1.log"), app.log);
    await app.close();
  }
}

async function phase2() {
  const log = path.join(outDir, "fixture-2.log");
  const app = await launchGlide({ appDir, env });
  try {
    const page = await app.launcher();
    const saved = await page.eval((cfg) => window.glide.feature("agent", "mcpSave", cfg), serverConfig(log));
    const test = await page.eval((id) => window.glide.feature("agent", "mcpTest", id), saved.server.id);
    check("phase 2: connected", test.ok, test.error ?? "");
    const pid = serverPids(log).at(-1);
    app.proc.kill("SIGKILL");
    await until(() => app.exited, 5000);
    check("watchdog stops the server after Glide is killed (crash)", await until(() => !alive(pid), 6000), `pid ${pid}`);
  } finally {
    await app.close();
  }
}

try {
  await phase1();
  await phase2();
} catch (err) {
  check("script error", false, String(err?.stack ?? err));
}
const failed = results.filter((r) => !r.ok);
console.log(`artifacts: ${outDir}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
