#!/usr/bin/env node
// A small MCP server built with the OFFICIAL TypeScript SDK (@modelcontextprotocol/sdk from ../node_modules), used
// to test Glide's MCP client (Sources/Features/MCPClient) against a real implementation. Loopback only.
//
//   node sdk-test-server.mjs --stdio
//   node sdk-test-server.mjs --http [--json] [--token T]   → prints {"port":N,"url":...} on stdout, Streamable HTTP
//   node sdk-test-server.mjs --sse  [--token T]            → legacy HTTP+SSE transport (GET /sse, POST /messages)
//
// Tools: echo (read-only), add, fail (isError result), throw (JSON-RPC error), slow {ms}, toggle (adds/removes
// "extra" and sends notifications/tools/list_changed after the response), ping_client (server → client ping),
// stats (cancellations seen, sessions), expire_session (HTTP: forget every session → next request 404),
// crash (exit 1). tools/list is paginated (3 per page) to exercise nextCursor.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const token = opt("--token");
const stats = { cancelled: 0, initialized: 0, calls: 0, clients: [] };
let extra = false;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); stats.cancelled++; reject(new Error("cancelled")); });
});

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
function toolList() {
  const list = [
    { name: "echo", title: "Echo", description: "Echo the text back", inputSchema: obj({ text: { type: "string" } }, ["text"]), annotations: { readOnlyHint: true } },
    { name: "add", description: "Add two numbers", inputSchema: obj({ a: { type: "number" }, b: { type: "number" } }, ["a", "b"]), annotations: { readOnlyHint: true, idempotentHint: true } },
    { name: "fail", description: "Returns an isError result", inputSchema: obj() },
    { name: "throw", description: "Answers with a JSON-RPC error", inputSchema: obj() },
    { name: "slow", description: "Waits ms milliseconds", inputSchema: obj({ ms: { type: "number" } }), annotations: { readOnlyHint: true } },
    { name: "toggle", description: "Adds or removes the extra tool", inputSchema: obj(), annotations: { destructiveHint: false } },
    { name: "ping_client", description: "Pings the client from the server", inputSchema: obj(), annotations: { readOnlyHint: true } },
    { name: "stats", description: "Server-side counters", inputSchema: obj(), annotations: { readOnlyHint: true } },
    { name: "expire_session", description: "Forget all HTTP sessions", inputSchema: obj() },
    { name: "crash", description: "Exit the server process", inputSchema: obj() },
  ];
  if (extra) list.push({ name: "extra", description: "Appears after toggle", inputSchema: obj() });
  return list;
}

const servers = new Set();
let expireSessions = () => {};

function makeServer() {
  const server = new Server({ name: "sdk-test-server", version: "1.2.3" }, { capabilities: { tools: { listChanged: true } }, instructions: "SDK test server" });
  servers.add(server);
  server.oninitialized = () => { stats.initialized++; stats.clients.push(server.getClientVersion()?.name ?? "?"); };
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const all = toolList();
    const start = Number(req.params?.cursor ?? 0) || 0;
    const page = all.slice(start, start + 3);
    return start + 3 < all.length ? { tools: page, nextCursor: String(start + 3) } : { tools: page };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extraCtx) => {
    stats.calls++;
    const a = req.params.arguments ?? {};
    switch (req.params.name) {
      case "echo": return { content: [{ type: "text", text: String(a.text ?? "") }] };
      case "add": return { content: [{ type: "text", text: String(Number(a.a) + Number(a.b)) }], structuredContent: { sum: Number(a.a) + Number(a.b) } };
      case "fail": return { content: [{ type: "text", text: "it failed on purpose" }], isError: true };
      case "throw": throw new McpError(ErrorCode.InvalidParams, "bad params on purpose");
      case "slow": await sleep(Number(a.ms ?? 5000), extraCtx.signal); return { content: [{ type: "text", text: "slow done" }] };
      case "toggle":
        extra = !extra;
        // After the response, on the standalone stream (HTTP GET / stdio), to every connected session.
        setTimeout(() => { for (const s of servers) s.sendToolListChanged().catch(() => {}); }, 50);
        return { content: [{ type: "text", text: extra ? "extra on" : "extra off" }] };
      case "ping_client": { const r = await server.ping(); return { content: [{ type: "text", text: `client answered ${JSON.stringify(r)}` }] }; }
      case "stats": return { content: [{ type: "text", text: JSON.stringify(stats) }] };
      case "expire_session": setTimeout(() => expireSessions(), 50); return { content: [{ type: "text", text: "sessions will expire" }] };
      case "crash": setTimeout(() => process.exit(1), 30); return { content: [{ type: "text", text: "bye" }] };
      case "extra": if (extra) return { content: [{ type: "text", text: "extra ran" }] };
      // fallthrough
      default: throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);
    }
  });
  server.onclose = () => servers.delete(server);
  return server;
}

const authorized = (req) => !token || req.headers.authorization === `Bearer ${token}`;
async function readBody(req) {
  let buf = "";
  for await (const c of req) buf += c;
  try { return buf ? JSON.parse(buf) : undefined; } catch { return undefined; }
}

if (flag("--stdio")) {
  const s = makeServer();
  await s.connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));
} else if (flag("--http")) {
  const sessions = new Map();
  expireSessions = () => { for (const [id, t] of sessions) { sessions.delete(id); t.close().catch(() => {}); } };
  const httpServer = http.createServer(async (req, res) => {
    if (!authorized(req)) { res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "unauthorized" })); return; }
    if (!req.url?.startsWith("/mcp")) { res.writeHead(404).end(); return; }
    const sid = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await readBody(req) : undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (sid && !transport) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null })); return; }
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: flag("--json"),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await makeServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  httpServer.listen(Number(opt("--port") ?? 0), "127.0.0.1", () => {
    const { port } = httpServer.address();
    process.stdout.write(JSON.stringify({ port, url: `http://127.0.0.1:${port}/mcp` }) + "\n");
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} else if (flag("--sse")) {
  const transports = new Map();
  expireSessions = () => { for (const [id, t] of transports) { transports.delete(id); t.close().catch(() => {}); } };
  const httpServer = http.createServer(async (req, res) => {
    if (!authorized(req)) { res.writeHead(401).end("unauthorized"); return; }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/sse") {
      const t = new SSEServerTransport("/messages", res);
      transports.set(t.sessionId, t);
      res.on("close", () => transports.delete(t.sessionId));
      await makeServer().connect(t);
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const t = transports.get(url.searchParams.get("sessionId") ?? "");
      if (!t) { res.writeHead(404).end("unknown session"); return; }
      await t.handlePostMessage(req, res, await readBody(req));
      return;
    }
    res.writeHead(404).end();
  });
  httpServer.listen(Number(opt("--port") ?? 0), "127.0.0.1", () => {
    const { port } = httpServer.address();
    process.stdout.write(JSON.stringify({ port, url: `http://127.0.0.1:${port}/sse` }) + "\n");
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} else {
  console.error("usage: sdk-test-server.mjs --stdio | --http [--json] [--token T] | --sse [--token T]");
  process.exit(2);
}
