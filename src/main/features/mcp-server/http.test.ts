import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authorized, defaultServerDir, loadOrCreateToken, readDiscovery, regenerateToken, removeDiscovery, writeDiscovery } from "./auth";
import { checkHostOrigin, type McpHttpServer } from "./http";
import { harness, until } from "./test-kit";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tmp = fs.mkdtempSync(path.join(process.env.GLIDE_TEST_TMP ?? os.tmpdir(), "glide-mcp-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("token and discovery files", () => {
  it("creates a private token once and checks it in constant time", () => {
    const dir = path.join(tmp, "auth");
    const t = loadOrCreateToken(dir);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.statSync(path.join(dir, "token")).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(dir)).toBe(t);
    expect(authorized(`Bearer ${t}`, t)).toBe(true);
    expect(authorized(`bearer ${t}`, t)).toBe(true);
    expect(authorized(`Bearer ${t}x`, t)).toBe(false);
    expect(authorized(t, t)).toBe(false);
    expect(authorized(undefined, t)).toBe(false);
    expect(regenerateToken(dir)).not.toBe(t);
  });

  it("writes server.json 0600 and only removes its own", () => {
    const dir = path.join(tmp, "disc");
    writeDiscovery(dir, { port: 1234, pid: 42, url: "http://127.0.0.1:1234/mcp", version: "1", startedAt: 1 });
    expect(fs.statSync(path.join(dir, "server.json")).mode & 0o777).toBe(0o600);
    removeDiscovery(dir, 7);
    expect(readDiscovery(dir)?.port).toBe(1234);
    removeDiscovery(dir, 42);
    expect(readDiscovery(dir)).toBeNull();
    expect(defaultServerDir({ GLIDE_USER_DATA: "/x" }, "/h")).toBe("/x/features/mcp-server");
    expect(defaultServerDir({}, "/h")).toBe("/h/Library/Application Support/Glide/features/mcp-server");
  });

  it("checks Host and Origin against DNS rebinding", () => {
    expect(checkHostOrigin("127.0.0.1:5000", undefined, 5000)).toBe(true);
    expect(checkHostOrigin("localhost:5000", "http://localhost:5000", 5000)).toBe(true);
    expect(checkHostOrigin("evil.com:5000", undefined, 5000)).toBe(false);
    expect(checkHostOrigin("127.0.0.1:5000", "https://evil.com", 5000)).toBe(false);
    expect(checkHostOrigin(undefined, undefined, 5000)).toBe(false);
  });
});

describe("Streamable HTTP server", () => {
  const TOKEN = "t".repeat(43);
  const h = harness({ tools: { start_timer: "ask" } });
  let srv: McpHttpServer;
  beforeAll(async () => {
    srv = await h.serve(TOKEN);
  });
  afterAll(async () => srv.close());

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } };
  const post = (headers: Record<string, string>, body: unknown = init) =>
    fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

  it("listens on loopback only", () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("rejects missing or wrong tokens and foreign origins", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status).toBe(403);
    const other = await fetch(srv.url.replace("/mcp", "/other"), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(other.status).toBe(404);
    expect((await post({ authorization: `Bearer ${TOKEN}`, "mcp-session-id": "bogus" })).status).toBe(404);
  });

  it("serves the SDK client: tools, calls with confirmation, resources", async () => {
    const client = new Client({ name: "Vitest Agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    expect(client.getServerVersion()?.name).toBe("glide");
    expect(client.getInstructions()).toMatch(/search_glide/);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_glide");
    expect(names).toContain("start_timer"); // "ask"
    expect(names).not.toContain("run_command"); // off
    expect(tools.find((t) => t.name === "search_glide")?.annotations?.readOnlyHint).toBe(true);

    const r = await client.callTool({ name: "search_glide", arguments: { query: "safari" } });
    expect(r.content).toEqual([{ type: "text", text: "ran search_glide" }]);

    const pending = client.callTool({ name: "start_timer", arguments: { minutes: 5 } });
    const req = await until(() => h.requests.find((x) => x.tool === "start_timer"));
    expect(req.client).toBe("Vitest Agent");
    h.confirm.respond(req.id, "allow");
    expect((await pending).content).toEqual([{ type: "text", text: "ran start_timer" }]);

    const res = await client.listResources();
    expect(res.resources.map((x) => x.uri)).toEqual(["glide://notes/n1"]);
    const note = await client.readResource({ uri: "glide://notes/n1" });
    expect(note.contents[0]).toMatchObject({ mimeType: "text/markdown", text: "# Groceries\nmilk" });
    expect(srv.sessions()).toBe(1);
    await client.close();
  });

  it("bridges stdio ⇄ HTTP with the bundled glide-mcp shim", async () => {
    execFileSync(process.execPath, [path.join(ROOT, "scripts/glide-mcp.mjs")], { stdio: "ignore" });
    const dir = path.join(tmp, "shim");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "token"), `${TOKEN}\n`, { mode: 0o600 });
    writeDiscovery(dir, { port: srv.port, pid: process.pid, url: srv.url, version: "test", startedAt: Date.now() });

    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "dist/mcp/glide-mcp.cjs")], env: { GLIDE_MCP_DIR: dir, PATH: process.env.PATH ?? "" }, stderr: "pipe" });
    const client = new Client({ name: "Stdio Agent", version: "1.0.0" });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("glide");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("convert");
    const r = await client.callTool({ name: "convert", arguments: { query: "1 mi in km" } });
    expect(r.content).toEqual([{ type: "text", text: "ran convert" }]);
    const log = h.log.list()[0]!;
    expect(log).toMatchObject({ client: "Stdio Agent", tool: "convert", outcome: "ok" });
    await client.close();
  });

  it("shim reports a stopped server clearly", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty, { recursive: true });
    let out = "";
    try {
      execFileSync(process.execPath, [path.join(ROOT, "dist/mcp/glide-mcp.cjs")], { env: { GLIDE_MCP_DIR: empty }, input: "", stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      out = String((err as { stderr?: Buffer }).stderr ?? "");
      expect((err as { status?: number }).status).toBe(1);
    }
    expect(out).toMatch(/not running/);
  });
});
