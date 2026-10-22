// Headless end-to-end test of Glide's MCP server.
//   pnpm build:main && pnpm build:renderer && node scripts/glide-mcp.mjs
//   GLIDE_TEST_TMP=<dir> node src/main/features/mcp-server/e2e/mcp-e2e.mjs [--shots=<dir>]
// Starts Glide headless (CDP 9495) with the server enabled on 127.0.0.1:9496 through fixture
// settings, connects the MCP SDK Client over HTTP and through the glide-mcp stdio shim, and answers
// confirmations in the launcher's confirmation view (keyboard) and through the respond() hook.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROOT, snapshotApp, withGlide } from "../../../../../tests/harness/app.mjs";
import { sleep } from "../../../../../tests/harness/page.mjs";
import { createReporter } from "../../../../../tests/harness/report.mjs";

const CDP_PORT = Number(process.env.GLIDE_MCP_E2E_CDP ?? 9495);
const MCP_PORT = Number(process.env.GLIDE_MCP_E2E_PORT ?? 9496);
const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice(8);
const r = createReporter("mcp-server e2e");
const text = (res) => (res.content ?? []).map((c) => c.text ?? "").join("\n");

await withGlide(
  {
    appDir: snapshotApp(),
    port: CDP_PORT,
    fixture: { features: { "mcp-server": { enabled: true, port: MCP_PORT, tools: { start_timer: "ask" }, confirmTimeoutSec: 30 } } },
  },
  async (app) => {
    const line = await app.waitForLog(/\[mcp-server\] listening on /, { timeout: 20000 });
    const url = line.match(/listening on (\S+)/)[1];
    r.check("server listens on 127.0.0.1 at the configured port", url === `http://127.0.0.1:${MCP_PORT}/mcp`, line);
    const dir = path.join(app.dataDir, "features", "mcp-server");
    const token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
    r.check("token file is 0600", (fs.statSync(path.join(dir, "token")).mode & 0o777) === 0o600);
    r.check("server.json is 0600 and names the port", (fs.statSync(path.join(dir, "server.json")).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8")).port === MCP_PORT);

    const unauth = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    r.check("request without token → 401", unauth.status === 401, String(unauth.status));

    const launcher = await app.launcher();
    const client = new Client({ name: "E2E Agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    r.check("tools/list has read-only tools", ["search_glide", "list_workflows", "list_timers", "convert", "search_notes"].every((n) => names.includes(n)), names.join(","));
    r.check("tools/list hides off tools (run_command, clipboard)", !names.includes("run_command") && !names.includes("clipboard_history_search"));
    r.check("start_timer listed (ask) with readOnlyHint=false", tools.find((t) => t.name === "start_timer")?.annotations?.readOnlyHint === false);

    const search = await client.callTool({ name: "search_glide", arguments: { query: "Fixture Greeting" } });
    r.check("search_glide finds the fixture workflow", !search.isError && /Fixture Greeting/.test(text(search)), text(search).slice(0, 200));

    const wf = await client.callTool({ name: "list_workflows", arguments: {} });
    r.check("list_workflows returns fixture workflows", /wf-morning-setup/.test(text(wf)));

    // State-changing call #1: answered with the keyboard in the launcher's confirmation view.
    const p1 = client.callTool({ name: "start_timer", arguments: { minutes: 5, name: "MCP e2e" } });
    await launcher.waitFor(() => !!document.querySelector('[role="dialog"][aria-label="MCP request"] [role="option"]'), { timeout: 10000 });
    const viewText = await launcher.eval(() => document.querySelector('[role="dialog"][aria-label="MCP request"]')?.textContent ?? "");
    r.check("confirmation view names the client and the action", /E2E Agent/.test(viewText) && /5 min timer/.test(viewText), viewText.slice(0, 200));
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      await launcher.stabilise?.();
      fs.writeFileSync(path.join(shots, "mcp-confirm.png"), await launcher.screenshot());
    }
    await app.waitForLog(/\[headless\] notification .*MCP request from E2E Agent/, { timeout: 5000 }).then(
      () => r.check("a notification announced the request", true),
      () => r.check("a notification announced the request", false),
    );
    await launcher.press("Enter");
    const res1 = await p1;
    r.check("start_timer allowed via Enter runs", !res1.isError && /started/i.test(text(res1)), text(res1));
    const timers = await launcher.eval(() => window.glide.feature("timers", "state"));
    const timer = timers.timers.find((t) => t.name === "MCP e2e");
    r.check("the timer exists in Glide", !!timer && timer.durationMs === 300000);

    // State-changing call #2: denied through the respond() test hook.
    const p2 = client.callTool({ name: "start_timer", arguments: { minutes: 1, name: "should not exist" } });
    let pending = [];
    for (let i = 0; i < 100 && !pending.length; i++) {
      pending = await launcher.eval(() => window.glide.feature("mcp-server", "pending"));
      if (!pending.length) await sleep(50);
    }
    await launcher.eval((id) => window.glide.feature("mcp-server", "respond", id, "deny"), pending[0].id);
    const res2 = await p2;
    r.check("denied call returns isError and does nothing", res2.isError === true && /denied/.test(text(res2)));
    const timers2 = await launcher.eval(() => window.glide.feature("timers", "state"));
    r.check("no timer from the denied call", !timers2.timers.some((t) => t.name === "should not exist"));

    const lt = await client.callTool({ name: "list_timers", arguments: {} });
    r.check("list_timers shows the new timer", /MCP e2e/.test(text(lt)));
    const off = await client.callTool({ name: "run_command", arguments: { id: "x" } });
    r.check("run_command (off) refused", off.isError === true && /turned off/.test(text(off)));
    await client.close();

    // The stdio shim, as Claude Desktop / Goose would launch it.
    const shim = path.join(ROOT, "dist/mcp/glide-mcp.cjs");
    if (!fs.existsSync(shim)) r.check("dist/mcp/glide-mcp.cjs built", false, "run node scripts/glide-mcp.mjs");
    else {
      const sc = new Client({ name: "Shim Agent", version: "1.0.0" });
      await sc.connect(new StdioClientTransport({ command: process.execPath, args: [shim, "--data-dir", app.dataDir], env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" }));
      const st = await sc.listTools();
      r.check("shim: tools/list through stdio", st.tools.some((t) => t.name === "search_glide"));
      const conv = await sc.callTool({ name: "convert", arguments: { query: "10 km in miles" } });
      r.check("shim: convert works", !conv.isError && /6\.2/.test(text(conv)), text(conv).slice(0, 200));
      await sc.close();
    }

    const log = await launcher.eval(() => window.glide.feature("mcp-server", "log"));
    const outcomes = log.map((e) => `${e.client}:${e.tool}:${e.outcome}`);
    r.check("request log recorded the calls", ["E2E Agent:start_timer:ok", "E2E Agent:start_timer:denied", "E2E Agent:run_command:off", "Shim Agent:convert:ok"].every((x) => outcomes.includes(x)), outcomes.join(" | "));

    if (shots) {
      const settings = await app.settings("mcp-server", { via: launcher });
      await settings.waitFor(() => !!document.querySelector(".mcp-server-page"), { timeout: 10000 });
      await sleep(300);
      fs.writeFileSync(path.join(shots, "mcp-settings.png"), await settings.screenshot());
    }
    r.check("no uncaught errors", app.errors().length === 0, app.errors().slice(0, 5).join("\n"));
  },
);
process.exit(r.summary() ? 1 : 0);
