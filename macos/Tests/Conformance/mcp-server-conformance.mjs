#!/usr/bin/env node
// Conformance: Glide's MCP server (Sources/Features/MCPServer) driven by the OFFICIAL MCP TypeScript SDK client
// (@modelcontextprotocol/sdk, read from ../node_modules — nothing downloaded) over both transports:
//   (a) Streamable HTTP straight to Glide's 127.0.0.1 endpoint with the bearer token,
//   (b) stdio through `Glide --mcp-stdio --data-dir <userData>` (the bridge).
// Glide runs headless (GLIDE_HEADLESS=1, fresh GLIDE_USER_DATA) and is driven over its test channel to enable the
// server, change tool policies and answer confirmation prompts. Every process started here is killed by pid.
//
//   node Tests/Conformance/mcp-server-conformance.mjs [--binary <path to Glide>]
// Env: GLIDE_BINARY, GLIDE_E2E_TMP (parent dir for the data dir). Exit code = number of failed checks (0 = pass).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EmptyResultSchema, LATEST_PROTOCOL_VERSION, McpError, ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Glide, alive, assert, check, checkAsync, sleep, summary } from "./lib.mjs";

const glide = new Glide();
let exitCode = 1;
const openClients = [];

async function waitFor(fn, timeoutMs = 8000, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}

/** Raw HTTP (node:http so Host/Origin can be forged) → {status, headers, body, json}. */
function raw(port, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const initBody = (version, id = 1) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "raw-conformance", version: "1" } } });

/** Waits until Glide has a pending confirmation for `tool`, then answers it through the test channel. */
async function answer(tool, decision) {
  const p = await waitFor(async () => (await glide.invoke("mcp-server", "pending")).find((r) => r.tool === tool), 10_000);
  assert(p, `no pending confirmation for ${tool}`);
  assert(await glide.invoke("mcp-server", "respond", { id: p.id, decision }), "respond returned false");
  return p;
}

const text = (r) => (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** The shared protocol suite, run once per transport. */
async function suite(label, makeTransport, { expectSessionId }) {
  const client = new Client({ name: `sdk-conformance-${label}`, version: "1.0.0" }, { capabilities: {} });
  openClients.push(client);
  const transport = makeTransport();
  const toolChanges = [];
  const resourceChanges = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => toolChanges.push(Date.now()));
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => resourceChanges.push(Date.now()));

  await checkAsync(`[${label}] initialize (SDK latest ${LATEST_PROTOCOL_VERSION})`, async () => {
    await client.connect(transport);
    const info = client.getServerVersion();
    assert(info?.name === "glide", `serverInfo ${JSON.stringify(info)}`);
    const caps = client.getServerCapabilities();
    assert(caps?.tools?.listChanged === true && caps?.resources, `capabilities ${JSON.stringify(caps)}`);
    assert(typeof client.getInstructions() === "string", "instructions");
    if (expectSessionId) assert(transport.sessionId, "Mcp-Session-Id was not set");
    // The SDK transport records the negotiated version; Glide must accept the SDK's latest.
    if ("protocolVersion" in transport) assert(transport.protocolVersion === LATEST_PROTOCOL_VERSION, `negotiated ${transport.protocolVersion}`);
  });

  await checkAsync(`[${label}] ping`, async () => { const r = await client.ping(); assert(r && typeof r === "object", "ping result"); });

  let tools = [];
  await checkAsync(`[${label}] tools/list shapes`, async () => {
    tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ["search_glide", "convert", "list_timers", "system_status"]) assert(names.includes(n), `missing ${n} in ${names.join(",")}`);
    for (const t of tools) {
      assert(t.inputSchema?.type === "object", `${t.name} inputSchema.type`);
      assert(typeof t.annotations?.readOnlyHint === "boolean", `${t.name} readOnlyHint`);
    }
    // State-changing tools are off by default, so they're not listed.
    assert(!names.includes("start_timer"), "start_timer listed while off");
  });

  await checkAsync(`[${label}] tools/call search_glide`, async () => {
    const r = await client.callTool({ name: "search_glide", arguments: { query: "timer" } });
    assert(!r.isError, text(r));
    assert(r.content?.[0]?.type === "text", "content[0].type");
  });
  await checkAsync(`[${label}] tools/call convert`, async () => {
    const r = await client.callTool({ name: "convert", arguments: { query: "2+2" } });
    assert(!r.isError && text(r).includes("4"), text(r));
  });
  await checkAsync(`[${label}] tools/call list_timers`, async () => {
    const r = await client.callTool({ name: "list_timers", arguments: {} });
    assert(!r.isError, text(r));
  });
  await checkAsync(`[${label}] tools/call system_status`, async () => {
    const r = await client.callTool({ name: "system_status", arguments: {} });
    assert(r.content?.length && typeof r.isError !== "string", JSON.stringify(r).slice(0, 200));
  });

  await checkAsync(`[${label}] bad arguments → tool execution error (isError)`, async () => {
    const r = await client.callTool({ name: "convert", arguments: {} });
    assert(r.isError === true && text(r).length > 0, JSON.stringify(r));
  });
  await checkAsync(`[${label}] unknown tool → JSON-RPC error -32602`, async () => {
    try {
      const r = await client.callTool({ name: "no_such_tool", arguments: {} });
      throw new Error(`expected an error, got ${JSON.stringify(r)}`);
    } catch (e) {
      assert(e instanceof McpError && e.code === -32602, `got ${e?.code} ${e?.message}`);
    }
  });
  await checkAsync(`[${label}] unknown method → -32601`, async () => {
    try {
      await client.request({ method: "glide/nope", params: {} }, EmptyResultSchema);
      throw new Error("expected an error");
    } catch (e) {
      assert(e instanceof McpError && e.code === -32601, `got ${e?.code} ${e?.message}`);
    }
  });

  // list_changed: turn on start_timer (Ask) and create_note (Ask) through the test channel.
  await checkAsync(`[${label}] notifications/tools/list_changed when policies change`, async () => {
    // HTTP: the GET stream opens asynchronously after notifications/initialized.
    await sleep(300);
    const before = toolChanges.length;
    await glide.invoke("mcp-server", "setToolPolicy", { name: "start_timer", policy: "ask" });
    await glide.invoke("mcp-server", "setToolPolicy", { name: "create_note", policy: "ask" });
    const got = await waitFor(() => toolChanges.length > before, 5000);
    assert(got, "no tools/list_changed notification");
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert(names.includes("start_timer") && names.includes("create_note"), `after: ${names.join(",")}`);
  });

  await checkAsync(`[${label}] state-changing tool waits for confirmation → Allow`, async () => {
    const call = client.callTool({ name: "start_timer", arguments: { minutes: 5, name: `conf-${label}` } });
    const p = await answer("start_timer", "allow");
    assert(p.client === `sdk-conformance-${label}`, `client label ${p.client}`);
    const r = await call;
    assert(!r.isError, text(r));
    const listed = await client.callTool({ name: "list_timers", arguments: {} });
    assert(text(listed).includes(`conf-${label}`), text(listed));
  });
  await checkAsync(`[${label}] state-changing tool → Deny is an isError result`, async () => {
    const call = client.callTool({ name: "start_timer", arguments: { minutes: 1, name: "denied" } });
    await answer("start_timer", "deny");
    const r = await call;
    assert(r.isError === true && /denied/i.test(text(r)), JSON.stringify(r));
  });

  await checkAsync(`[${label}] other requests are answered while a call waits for confirmation`, async () => {
    const call = client.callTool({ name: "start_timer", arguments: { minutes: 2, name: "concurrent" } });
    await waitFor(async () => (await glide.invoke("mcp-server", "pending")).some((r) => r.tool === "start_timer"), 10_000);
    const t0 = Date.now();
    await client.ping();
    const r = await client.callTool({ name: "convert", arguments: { query: "3*3" } });
    assert(text(r).includes("9"), text(r));
    assert(Date.now() - t0 < 5000, "blocked behind the pending call");
    await answer("start_timer", "deny");
    await call;
  });
  await checkAsync(`[${label}] notifications/cancelled withdraws the confirmation prompt`, async () => {
    const ac = new AbortController();
    const call = client.callTool({ name: "start_timer", arguments: { minutes: 3, name: "cancel-me" } }, undefined, { signal: ac.signal });
    await waitFor(async () => (await glide.invoke("mcp-server", "pending")).some((r) => r.tool === "start_timer"), 10_000);
    ac.abort("user gave up");
    await call.then(() => { throw new Error("call resolved after abort"); }, () => {});
    const gone = await waitFor(async () => !(await glide.invoke("mcp-server", "pending")).some((r) => r.tool === "start_timer"), 5000);
    assert(gone, "prompt still pending after notifications/cancelled");
    const log = await glide.invoke("mcp-server", "log");
    assert(log.some((e) => e.tool === "start_timer" && e.outcome === "cancelled"), `log: ${JSON.stringify(log.slice(0, 3))}`);
    const timers = text(await client.callTool({ name: "list_timers", arguments: {} }));
    assert(!timers.includes("cancel-me"), "cancelled call still ran");
  });
  await checkAsync(`[${label}] notifications/resources/list_changed when policies change`, async () => {
    const before = resourceChanges.length;
    await glide.invoke("mcp-server", "setToolPolicy", { name: "search_notes", policy: "allow" });
    assert(await waitFor(() => resourceChanges.length > before, 5000), "no resources/list_changed");
  });

  let noteId;
  await checkAsync(`[${label}] create_note (Allow) then resources/list + resources/read`, async () => {
    const call = client.callTool({ name: "create_note", arguments: { text: `Conformance ${label}\nbody line` } });
    await answer("create_note", "allow");
    const r = await call;
    assert(!r.isError, text(r));
    const list = (await client.listResources()).resources;
    const note = list.find((x) => x.uri.startsWith("glide://notes/") && (x.title ?? x.name).includes(`Conformance ${label}`));
    assert(note, `notes resources: ${JSON.stringify(list).slice(0, 300)}`);
    noteId = note.uri;
    const read = await client.readResource({ uri: note.uri });
    assert(read.contents?.[0]?.text?.includes("body line"), JSON.stringify(read).slice(0, 300));
    const templates = await client.listResourceTemplates();
    assert(templates.resourceTemplates?.some((t) => t.uriTemplate.startsWith("glide://notes/")), "templates");
  });
  await checkAsync(`[${label}] resources/read unknown → -32002`, async () => {
    try { await client.readResource({ uri: "glide://nothing/here" }); throw new Error("expected an error"); } catch (e) {
      assert(e instanceof McpError && e.code === -32002, `got ${e?.code} ${e?.message}`);
    }
  });

  // Put policies back so the next transport starts from defaults.
  await glide.invoke("mcp-server", "resetToolPolicies");
  return { client, transport, noteId };
}

try {
  await glide.ready;
  const st = await glide.invoke("mcp-server", "setSettings", { enabled: true, port: 0 });
  check("server starts on a free loopback port", st.running === true && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(st.url ?? ""), JSON.stringify(st).slice(0, 300));
  const port = st.port;
  const token = fs.readFileSync(path.join(glide.dataDir, "features/mcp-server/token"), "utf8").trim();
  const url = new URL(st.url);
  const auth = { Authorization: `Bearer ${token}` };

  // ---- (a) Streamable HTTP with the SDK client ----
  const a = await suite("http", () => new StreamableHTTPClientTransport(url, { requestInit: { headers: auth } }), { expectSessionId: true });

  await checkAsync("[http] session teardown (DELETE) then the old session id is 404", async () => {
    const sid = a.transport.sessionId;
    await a.transport.terminateSession();
    const r = await raw(port, { headers: { ...auth, "mcp-session-id": sid, accept: "application/json, text/event-stream", "mcp-protocol-version": LATEST_PROTOCOL_VERSION }, body: { jsonrpc: "2.0", id: 9, method: "ping" } });
    assert(r.status === 404, `status ${r.status}`);
    await a.client.close();
  });

  // ---- protocol version negotiation (raw JSON-RPC, so each version is requested explicitly) ----
  for (const v of ["2024-11-05", "2025-03-26", "2025-06-18", LATEST_PROTOCOL_VERSION]) {
    await checkAsync(`[http] negotiates protocol ${v} and serves requests with that MCP-Protocol-Version`, async () => {
      const r = await raw(port, { headers: { ...auth, accept: "application/json, text/event-stream" }, body: initBody(v) });
      assert(r.status === 200 && r.json?.result?.protocolVersion === v, `${r.status} ${r.body.slice(0, 200)}`);
      const sid = r.headers["mcp-session-id"];
      assert(sid, "no Mcp-Session-Id");
      const h = { ...auth, accept: "application/json, text/event-stream", "mcp-session-id": sid, ...(v >= "2025-06-18" ? { "mcp-protocol-version": v } : {}) };
      const n = await raw(port, { headers: h, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
      assert(n.status === 202, `initialized → ${n.status}`);
      const l = await raw(port, { headers: h, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
      assert(l.status === 200 && Array.isArray(l.json?.result?.tools), `tools/list → ${l.status}`);
      const d = await raw(port, { method: "DELETE", headers: h });
      assert(d.status === 200 || d.status === 204, `DELETE → ${d.status}`);
    });
  }
  await checkAsync("[http] unknown requested version → server answers with one it supports", async () => {
    const r = await raw(port, { headers: { ...auth, accept: "application/json, text/event-stream" }, body: initBody("1999-01-01") });
    assert(r.status === 200 && ["2025-11-25", "2025-06-18", "2025-03-26"].includes(r.json?.result?.protocolVersion), r.body.slice(0, 200));
    await raw(port, { method: "DELETE", headers: { ...auth, "mcp-session-id": r.headers["mcp-session-id"] } });
  });
  await checkAsync("[http] unsupported MCP-Protocol-Version header → 400", async () => {
    const r = await raw(port, { headers: { ...auth, accept: "application/json, text/event-stream" }, body: initBody("2025-06-18") });
    const sid = r.headers["mcp-session-id"];
    const bad = await raw(port, { headers: { ...auth, accept: "application/json, text/event-stream", "mcp-session-id": sid, "mcp-protocol-version": "1999-01-01" }, body: { jsonrpc: "2.0", id: 3, method: "ping" } });
    assert(bad.status === 400, `status ${bad.status}`);
    await raw(port, { method: "DELETE", headers: { ...auth, "mcp-session-id": sid } });
  });

  // ---- auth + DNS-rebinding guards ----
  await checkAsync("[http] no token → 401 with WWW-Authenticate", async () => {
    const r = await raw(port, { headers: { accept: "application/json, text/event-stream" }, body: initBody(LATEST_PROTOCOL_VERSION) });
    assert(r.status === 401 && /bearer/i.test(r.headers["www-authenticate"] ?? ""), `${r.status} ${JSON.stringify(r.headers)}`);
  });
  await checkAsync("[http] SDK client with a wrong token fails to connect (401)", async () => {
    const c = new Client({ name: "bad-token", version: "1" });
    try {
      await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer " + "x".repeat(43) } } }));
      throw new Error("connected with a wrong token");
    } catch (e) {
      assert(/401|unauthori[sz]ed|invalid bearer/i.test(String(e?.message ?? e)) || e?.code === 401, String(e?.message ?? e));
    } finally { await c.close().catch(() => {}); }
  });
  await checkAsync("[http] forged Host → 403", async () => {
    const r = await raw(port, { headers: { ...auth, host: `evil.example:${port}`, accept: "application/json, text/event-stream" }, body: initBody(LATEST_PROTOCOL_VERSION) });
    assert(r.status === 403, `status ${r.status}`);
  });
  await checkAsync("[http] cross-site Origin → 403; same-origin Origin accepted", async () => {
    const r = await raw(port, { headers: { ...auth, origin: "http://evil.example", accept: "application/json, text/event-stream" }, body: initBody(LATEST_PROTOCOL_VERSION) });
    assert(r.status === 403, `status ${r.status}`);
    const ok = await raw(port, { headers: { ...auth, origin: `http://127.0.0.1:${port}`, accept: "application/json, text/event-stream" }, body: initBody(LATEST_PROTOCOL_VERSION) });
    assert(ok.status === 200, `same-origin status ${ok.status}`);
    await raw(port, { method: "DELETE", headers: { ...auth, "mcp-session-id": ok.headers["mcp-session-id"] } });
  });
  await checkAsync("[http] request without a session that isn't initialize → 400", async () => {
    const r = await raw(port, { headers: { ...auth, accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    assert(r.status === 400 && r.json?.error, `status ${r.status}`);
  });
  await checkAsync("[http] malformed JSON → 400 parse error", async () => {
    const r = await raw(port, { headers: { ...auth, accept: "application/json, text/event-stream" }, body: "{not json" });
    assert(r.status === 400 && r.json?.error?.code === -32700, `${r.status} ${r.body}`);
  });

  // ---- (b) stdio through the bridge ----
  let bridgePid;
  const b = await suite("stdio", () => {
    const t = new StdioClientTransport({
      command: glide.binary,
      args: ["--mcp-stdio", "--data-dir", glide.dataDir],
      env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", GLIDE_HEADLESS: "1" },
      stderr: "pipe",
    });
    return t;
  }, { expectSessionId: false });
  bridgePid = b.transport.pid;
  await checkAsync("[stdio] bridge process exits when the client closes", async () => {
    assert(bridgePid && alive(bridgePid), "bridge not running before close");
    await b.client.close();
    const gone = await waitFor(() => !alive(bridgePid), 6000);
    assert(gone, `bridge pid ${bridgePid} still alive`);
  });
  await checkAsync("[stdio] the bridge's HTTP session was deleted on close", async () => {
    let last;
    const st2 = await waitFor(async () => { last = await glide.invoke("mcp-server", "state"); return last.sessions === 0 ? last : null; }, 5000);
    assert(st2, `sessions left open: ${last?.sessions}`);
  });
  await checkAsync("[stdio] bridge without a running server fails clearly", async () => {
    await glide.invoke("mcp-server", "setEnabled", { enabled: false });
    const c = new Client({ name: "no-server", version: "1" });
    const t = new StdioClientTransport({ command: glide.binary, args: ["--mcp-stdio", "--data-dir", glide.dataDir], env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" }, stderr: "pipe" });
    let err = "";
    t.stderr?.on("data", (d) => (err += d));
    try {
      await c.connect(t, { timeout: 8000 });
      throw new Error("connected without a server");
    } catch (e) {
      await sleep(200);
      assert(/not running/i.test(err + String(e?.message ?? e)), `stderr: ${err} / ${e?.message}`);
    } finally {
      const pid = t.pid;
      await c.close().catch(() => {});
      if (pid) assert(await waitFor(() => !alive(pid), 4000), "bridge left running");
    }
  });

  exitCode = summary();
} catch (e) {
  console.error("fatal:", e?.stack ?? e);
  if (glide.stderr) console.error("glide stderr tail:\n" + glide.stderr);
  summary();
  exitCode = 1;
} finally {
  for (const c of openClients) await c.close().catch(() => {});
  const stopped = await glide.stop();
  console.log(`Glide pid ${glide.pid} stopped: ${stopped}`);
  fs.rmSync(glide.dataDir, { recursive: true, force: true });
  process.exit(exitCode ? 1 : 0);
}
