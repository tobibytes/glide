/**
 * Glide Agent as an MCP client, against fixture servers written for these tests: in-process
 * (SDK Server + InMemoryTransport), a real stdio child under the watchdog, and Streamable HTTP on 127.0.0.1.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Cipher } from "../ai/keystore";
import { buildParams } from "./client";
import { createFixtureServer, startHttpFixture } from "./e2e/mcp-fixture-server.mjs";
import { DECLINED_RESULT, runAgentFull, type LoopOptions } from "./loop";
import { maskSecrets, McpConfigStore, normalizeServer, parseImport, restoreSecrets } from "./mcp-config";
import { McpManager } from "./mcp-manager";
import { argsSummary, isMcpToolName, mcpToolName, resultText, toInputSchema, truncateResult } from "./mcp-schema";
import { createTransport } from "./mcp-transport";
import { SECRET_KEEP, type McpServerConfig } from "./mcp-types";
import { fakeCaps, scripted } from "./test-fakes";
import type { AgentCapabilities, AgentTool } from "./tools";
import type { RunSnapshot } from "./types";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "e2e/mcp-fixture-server.mjs");
const tmpRoot = fs.mkdtempSync(path.join(process.env.GLIDE_TEST_TMP ?? os.tmpdir(), "glide-mcp-test-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const tmpFile = (name: string) => path.join(tmpRoot, `${++n}-${name}`);

const cipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString("hex")}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), "hex").toString(),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

// --- in-memory fixture --------------------------------------------------------------------

interface Fixture {
  manager: McpManager;
  servers: Server[];
  calls: string[];
  connects: number;
}

function memoryManager(over: Partial<McpServerConfig> = {}): Fixture {
  const fx: Fixture = { manager: undefined as unknown as McpManager, servers: [], calls: [], connects: 0 };
  fx.manager = new McpManager({
    file: () => tmpFile("mcp.json"),
    cipher,
    backoffBaseMs: 20,
    connectTimeoutMs: 3000,
    factory: () => {
      fx.connects++;
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const { server } = createFixtureServer({ log: (l) => fx.calls.push(l) });
      fx.servers.push(server);
      void server.connect(serverSide);
      return { transport: clientSide };
    },
  });
  return fx;
}

async function addServer(fx: Fixture, over: Partial<McpServerConfig> = {}) {
  const res = await fx.manager.save({ name: "fixture", transport: "stdio", command: "in-memory", autoRunReadOnly: true, ...over });
  expect(res.ok).toBe(true);
  return res.server!;
}

function loopOptions(tools: AgentTool[], client: ReturnType<typeof scripted>, over: Partial<LoopOptions> = {}): LoopOptions {
  return {
    runId: "r1",
    prompt: "use the fixture",
    client,
    tools,
    caps: fakeCaps(),
    model: "claude-opus-5-5",
    effort: "medium",
    system: "sys",
    context: "",
    signal: new AbortController().signal,
    isAllowed: () => false,
    confirm: async () => true,
    onChange: () => undefined,
    describeError: (e) => ({ message: e instanceof Error ? e.message : String(e), kind: "other" }),
    isAbort: () => false,
    ...over,
  };
}
const steps = (s: RunSnapshot) => s.entries.flatMap((e) => (e.kind === "step" ? [e.step] : []));

// --- naming / schema / results ----------------------------------------------------------------

describe("MCP ↔ Messages API mapping", () => {
  it("namespaces tool names within the API's rules", () => {
    expect(mcpToolName("GitHub", "create_issue")).toBe("mcp__GitHub__create_issue");
    expect(mcpToolName("my server!", "weird.schema/tool")).toBe("mcp__my_server__weird_schema_tool");
    const long = mcpToolName("a-very-long-server-name-that-goes-on", "and_an_even_longer_tool_name_for_good_measure_x");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(isMcpToolName(long)).toBe(true);
    const taken = new Set<string>();
    const a = mcpToolName("s", "a.b", taken);
    const b = mcpToolName("s", "a/b", taken);
    expect(a).not.toBe(b);
    expect([a, b].every((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x))).toBe(true);
  });

  it("passes the schema through, fixing what input_schema rejects", () => {
    const s = toInputSchema({ $schema: "x", anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "number" } } }] }) as unknown as Record<string, unknown>;
    expect(s).toEqual({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } } });
    const nested = { type: "object", properties: { q: { type: "string", enum: ["x", "y"] }, opts: { type: "object", properties: { n: { type: "integer", minimum: 1 } } } }, required: ["q"], $defs: { z: { type: "string" } } };
    expect(toInputSchema(nested)).toEqual(nested);
    expect(toInputSchema(undefined)).toMatchObject({ type: "object", properties: {} });
    const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`p${i}`, { type: "string", description: "long description" }])) };
    expect(Object.keys((toInputSchema(huge) as { properties: object }).properties)).toHaveLength(0);
  });

  it("maps content: text, images noted, resource links, truncation", () => {
    const t = resultText({ content: [{ type: "text", text: "hello" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "resource_link", uri: "file:///a", name: "a" }] });
    expect(t).toContain("hello");
    expect(t).toMatch(/\[image image\/png, ~1 KB — returned by the tool but not shown to the model\]/);
    expect(t).toContain("[resource link: a <file:///a>]");
    expect(resultText({ content: [], structuredContent: { ok: 1 } })).toBe('{"ok":1}');
    const big = truncateResult("x".repeat(9000));
    expect(big.length).toBeLessThan(5200);
    expect(big).toContain("[output truncated: 4000 more characters were not included]");
    expect(argsSummary({})).toBe("no arguments");
  });
});

// --- config / import / secrets -----------------------------------------------------------------

describe("MCP server config", () => {
  it("imports Claude Desktop and .mcp.json formats (disabled until reviewed)", () => {
    const desktop = parseImport(JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "@x/fs", "/tmp"], env: { TOKEN: "t" } } } }));
    expect(desktop).toMatchObject({ format: "claude-desktop", servers: [{ name: "files", transport: "stdio", command: "npx", args: ["-y", "@x/fs", "/tmp"], env: { TOKEN: "t" }, enabled: false }] });
    const project = parseImport(JSON.stringify({ mcpServers: { api: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer abc" } }, old: { type: "sse", url: "http://127.0.0.1:1/sse" }, bad: { type: "ftp" } } }));
    expect(project).toMatchObject({ format: "mcp-json", servers: [{ name: "api", transport: "http" }, { name: "old", transport: "sse" }] });
    expect("errors" in project && project.errors).toHaveLength(1);
    expect(parseImport("{nope")).toMatchObject({ error: expect.stringContaining("valid JSON") });
    expect(parseImport("{}")).toMatchObject({ error: expect.stringContaining("mcpServers") });
  });

  it("encrypts headers/env on disk and never returns them", () => {
    const file = tmpFile("store.json");
    const store = new McpConfigStore(() => file, cipher);
    const s = normalizeServer({ name: "API", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer supersecret" } });
    if ("error" in s) throw new Error(s.error);
    store.upsert(s, true);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("supersecret");
    expect(new McpConfigStore(() => file, cipher).list()[0]?.headers).toEqual({ Authorization: "Bearer supersecret" });
    const masked = maskSecrets(s);
    expect(masked.headers).toEqual({ Authorization: SECRET_KEEP });
    expect(restoreSecrets({ ...masked, headers: { Authorization: SECRET_KEEP, "X-New": "1" } }, s).headers).toEqual({ Authorization: "Bearer supersecret", "X-New": "1" });
    expect(() => new McpConfigStore(() => tmpFile("x.json"), { ...cipher, isEncryptionAvailable: () => false }).upsert(s, true)).toThrow(/Secure storage/);
  });
});

// --- lifecycle, tools and policy against the in-memory fixture ---------------------------------

describe("MCP client (in-memory fixture)", () => {
  let fx: Fixture;
  afterEach(async () => fx && (await fx.manager.closeAll()));

  it("connects lazily, lists tools and calls one", async () => {
    fx = memoryManager();
    await addServer(fx);
    expect(fx.connects).toBe(0);
    const { tools, problems } = await fx.manager.agentTools<AgentCapabilities>();
    expect(problems).toEqual([]);
    expect(fx.connects).toBe(1);
    expect(tools.map((t) => t.name)).toEqual(["mcp__fixture__echo", "mcp__fixture__add_note", "mcp__fixture__delete_all", "mcp__fixture__slow", "mcp__fixture__big", "mcp__fixture__picture", "mcp__fixture__fail", "mcp__fixture__weird_schema_tool"]);
    const echo = tools[0]!;
    expect(echo.title).toBe("fixture › Echo");
    const prepared = echo.prepare({ text: "hi" }, fakeCaps());
    if ("error" in prepared) throw new Error(prepared.error);
    expect(await prepared.describe()).toBe('Run echo on fixture with {"text":"hi"}');
    expect((await prepared.run()).text).toBe("echo: hi");
    expect(echo.prepare({}, fakeCaps())).toEqual({ error: 'missing required "text"' });
    // The same connection is reused.
    await fx.manager.agentTools();
    expect(fx.connects).toBe(1);
    expect(fx.manager.list()[0]).toMatchObject({ state: "ready", serverInfo: { name: "glide-fixture" } });
  });

  it("sends the server's schema to the API under the namespaced name", async () => {
    fx = memoryManager();
    await addServer(fx);
    const { tools } = await fx.manager.agentTools<AgentCapabilities>();
    const params = buildParams({ model: "m", effort: "medium", system: "s", context: "", tools: tools as AgentTool[], messages: [] });
    const weird = params.tools?.find((t) => "name" in t && t.name === "mcp__fixture__weird_schema_tool");
    expect(weird).toMatchObject({ input_schema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } });
    expect(JSON.stringify(weird)).not.toContain("$schema");
    expect(params.tools?.find((t) => "name" in t && t.name === "mcp__fixture__echo")).toMatchObject({ description: expect.stringContaining("[MCP server “fixture”; read-only]") });
  });

  it("annotations drive confirmation: read-only auto-runs when trusted, others ask", async () => {
    fx = memoryManager();
    await addServer(fx, { autoRunReadOnly: true });
    const { tools } = await fx.manager.agentTools<AgentCapabilities>();
    const client = scripted([{ tools: [{ name: "mcp__fixture__echo", input: { text: "a" } }, { name: "mcp__fixture__add_note", input: { text: "n1" } }] }, { text: "ok" }]);
    const confirm = vi.fn(async () => true);
    const out = await runAgentFull(loopOptions(tools as AgentTool[], client, { confirm }));
    expect(confirm).toHaveBeenCalledTimes(1);
    const [c] = confirm.mock.calls[0] as unknown as [{ stepIds: string[] }];
    const st = steps(out.snapshot);
    expect(c.stepIds).toEqual([st[1]!.id]);
    expect(st.map((s) => [s.tool, s.status, s.mutating])).toEqual([["mcp__fixture__echo", "ok", false], ["mcp__fixture__add_note", "ok", true]]);
    expect(st[1]!.summary).toBe('Run add_note on fixture with {"text":"n1"}');
    expect(fx.calls.map((l) => JSON.parse(l).tool)).toEqual(["echo", "add_note"]);
  });

  it("untrusted read-only tools ask too; declines never reach the server; allow-list skips the question", async () => {
    fx = memoryManager();
    await addServer(fx, { autoRunReadOnly: false });
    const { tools } = await fx.manager.agentTools<AgentCapabilities>();
    const turn = [{ tools: [{ name: "mcp__fixture__echo", input: { text: "a" } }, { name: "mcp__fixture__delete_all", input: {} }] }, { text: "ok" }];
    const confirm = vi.fn(async () => false);
    const out = await runAgentFull(loopOptions(tools as AgentTool[], scripted(turn), { confirm }));
    expect((confirm.mock.calls[0] as unknown as [{ stepIds: string[] }])[0].stepIds).toHaveLength(2);
    expect(steps(out.snapshot).map((s) => s.status)).toEqual(["declined", "declined"]);
    expect(steps(out.snapshot)[1]!.summary).toContain("may change or delete data");
    expect(JSON.stringify(out.messages)).toContain(DECLINED_RESULT.slice(0, 30));
    expect(fx.calls).toEqual([]);

    const allowed = new Set(["mcp__fixture__echo"]);
    const confirm2 = vi.fn(async () => true);
    const out2 = await runAgentFull(loopOptions(tools as AgentTool[], scripted([{ tools: [{ name: "mcp__fixture__echo", input: { text: "b" } }] }, { text: "ok" }]), { confirm: confirm2, isAllowed: (t) => allowed.has(t) }));
    expect(confirm2).not.toHaveBeenCalled();
    expect(steps(out2.snapshot)[0]).toMatchObject({ status: "ok", autoApproved: true });
  });

  it("read-only mode offers only readOnlyHint tools", async () => {
    fx = memoryManager();
    await addServer(fx);
    const { tools } = await fx.manager.agentTools<AgentCapabilities>();
    const client = scripted([{ tools: [{ name: "mcp__fixture__add_note", input: { text: "x" } }] }, { text: "ok" }]);
    const out = await runAgentFull(loopOptions(tools as AgentTool[], client, { readOnly: true }));
    const offered = client.requests[0]!.tools as unknown as string[];
    expect(offered).toContain("mcp__fixture__echo");
    expect(offered).not.toContain("mcp__fixture__add_note");
    expect(offered).not.toContain("mcp__fixture__delete_all");
    expect(steps(out.snapshot)[0]).toMatchObject({ status: "error", result: expect.stringContaining("Read-only mode") });
    expect(fx.calls).toEqual([]);
  });

  it("disabled tools aren't offered", async () => {
    fx = memoryManager();
    await addServer(fx, { disabledTools: ["delete_all"] });
    const { tools } = await fx.manager.agentTools<AgentCapabilities>();
    expect(tools.map((t) => t.name)).not.toContain("mcp__fixture__delete_all");
    expect(fx.manager.list()[0]!.tools.find((t) => t.name === "delete_all")).toMatchObject({ enabled: false, agentName: "mcp__fixture__delete_all" });
  });

  it("tool errors, timeouts, rate limits and huge outputs are tool errors, not crashes", async () => {
    fx = memoryManager();
    await addServer(fx, { timeoutMs: 1000, rateLimitPerMinute: 3 });
    const { tools } = await fx.manager.agentTools<AgentCapabilities>();
    const client = scripted([
      { tools: [{ name: "mcp__fixture__fail", input: {} }, { name: "mcp__fixture__slow", input: { ms: 3000 } }, { name: "mcp__fixture__big", input: { n: 20000 } }, { name: "mcp__fixture__picture", input: {} }] },
      { text: "ok" },
    ]);
    const t0 = Date.now();
    const out = await runAgentFull(loopOptions(tools as AgentTool[], client));
    expect(Date.now() - t0).toBeLessThan(2900);
    const st = steps(out.snapshot);
    expect(st[0]).toMatchObject({ status: "error", result: "fixture failure" });
    expect(st[1]).toMatchObject({ status: "error", result: expect.stringContaining("timed out after 1 s") });
    expect(st[2]).toMatchObject({ status: "ok", result: expect.stringContaining("[output truncated") });
    expect(st[3]).toMatchObject({ status: "error", result: expect.stringContaining("Rate limited") });
    expect(out.snapshot.status).toBe("done");
    const results = JSON.stringify(client.requests[1]!.messages.at(-1));
    expect(results).toContain('"is_error":true');
  });

  it("reconnects with backoff after the server drops", async () => {
    fx = memoryManager();
    await addServer(fx);
    await fx.manager.agentTools();
    expect(fx.connects).toBe(1);
    await fx.servers[0]!.close();
    expect(await waitFor(() => fx.connects === 2 && fx.manager.list()[0]?.state === "ready", 3000)).toBe(true);
    const { tools } = await fx.manager.agentTools<AgentCapabilities>();
    const p = tools[0]!.prepare({ text: "again" }, fakeCaps());
    if ("error" in p) throw new Error(p.error);
    expect((await p.run()).text).toBe("echo: again");
  });

  it("an unreachable server becomes a transcript notice, not a failure", async () => {
    const manager = new McpManager({ file: () => tmpFile("m.json"), cipher, connectTimeoutMs: 1000, factory: () => { throw new Error("spawn nothing ENOENT"); } });
    await manager.save({ name: "broken", command: "nothing" });
    const res = await manager.agentTools<AgentCapabilities>();
    expect(res.tools).toEqual([]);
    expect(res.problems[0]).toMatch(/MCP server “broken” is unavailable/);
    const client = scripted([{ text: "fine" }]);
    const out = await runAgentFull(loopOptions([], client, { notices: res.problems }));
    expect(out.snapshot.entries.find((e) => e.kind === "notice")).toMatchObject({ tone: "warning", text: expect.stringContaining("broken") });
  });

  it("disabling or editing a server closes its connection", async () => {
    fx = memoryManager();
    const s = await addServer(fx);
    await fx.manager.agentTools();
    expect(fx.manager.list()[0]!.state).toBe("ready");
    await fx.manager.setEnabled(s.id, false);
    expect(fx.manager.list()[0]!.state).toBe("idle");
    expect((await fx.manager.agentTools()).tools).toEqual([]);
  });

  it("imports through the manager without overwriting existing servers", async () => {
    fx = memoryManager();
    await addServer(fx);
    const text = JSON.stringify({ mcpServers: { fixture: { command: "x" }, other: { command: "y", env: { K: "v" } } } });
    const preview = fx.manager.import(text, false);
    expect(preview.servers.map((s) => [s.name, s.exists, s.envKeys])).toEqual([["fixture", true, []], ["other", false, ["K"]]]);
    const done = fx.manager.import(text, true);
    expect(done.imported).toBe(1);
    expect(fx.manager.list().map((s) => [s.name, s.enabled, s.env])).toEqual([["fixture", true, undefined], ["other", false, { K: SECRET_KEEP }]]);
  });
});

// --- real stdio child + watchdog ------------------------------------------------------------------

const stdioConfig = (log: string): McpServerConfig => {
  const n = normalizeServer({ name: "stdio-fixture", command: process.execPath, args: [FIXTURE], env: { FIXTURE_LOG: log }, autoRunReadOnly: true });
  if ("error" in n) throw new Error(n.error);
  return n;
};
const serverPid = (log: string) => Number(/pid (\d+)/.exec(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "")?.[1] ?? 0);

describe("MCP client (stdio child)", () => {
  it("lists and calls over stdio, and leaves no process behind after close", async () => {
    const log = tmpFile("stdio.log");
    const file = tmpFile("stdio.json");
    const manager = new McpManager({ file: () => file, cipher });
    await manager.save(stdioConfig(log));
    const { tools, problems } = await manager.agentTools<AgentCapabilities>();
    expect(problems).toEqual([]);
    const p = tools.find((t) => t.name === "mcp__stdio-fixture__echo")!.prepare({ text: "over stdio" }, fakeCaps());
    if ("error" in p) throw new Error(p.error);
    expect((await p.run()).text).toBe("echo: over stdio");
    const pid = serverPid(log);
    const watchdog = manager.list()[0]!.pid!;
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid) && alive(watchdog)).toBe(true);
    await manager.closeAll();
    expect(await waitFor(() => !alive(pid) && !alive(watchdog))).toBe(true);
  }, 20_000);

  it("killAll (quit) stops the child synchronously-signalled", async () => {
    const log = tmpFile("quit.log");
    const manager = new McpManager({ file: () => tmpFile("q.json"), cipher });
    await manager.save(stdioConfig(log));
    await manager.agentTools();
    const pid = serverPid(log);
    expect(alive(pid)).toBe(true);
    manager.killAll();
    expect(await waitFor(() => !alive(pid), 4000)).toBe(true);
  }, 20_000);

  it("watchdog kills the server when Glide's process disappears", async () => {
    const log = tmpFile("watchdog.log");
    // Stand-in for Glide: a process we own; the watchdog watches its pid.
    const fakeGlide = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const built = createTransport(stdioConfig(log), { parentPid: fakeGlide.pid });
    await built.transport.start();
    expect(await waitFor(() => serverPid(log) > 0)).toBe(true);
    const pid = serverPid(log);
    const watchdog = built.pid!()!;
    fakeGlide.kill("SIGKILL");
    expect(await waitFor(() => !alive(pid) && !alive(watchdog), 5000)).toBe(true);
    await built.transport.close();
  }, 20_000);

  it("a missing command is a clear error", async () => {
    const manager = new McpManager({ file: () => tmpFile("missing.json"), cipher, connectTimeoutMs: 3000 });
    const res = await manager.test({ name: "nope", command: "/definitely/not/here-glide" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wasn't found|not found|No such file/);
  }, 20_000);
});

// --- Streamable HTTP on 127.0.0.1 -------------------------------------------------------------------

describe("MCP client (Streamable HTTP)", () => {
  let http: { port: number; close(): Promise<void> };
  beforeAll(async () => {
    http = await startHttpFixture({ token: "tok123" });
  });
  afterAll(async () => http.close());

  it("sends the bearer token header and calls a tool", async () => {
    const manager = new McpManager({ file: () => tmpFile("http.json"), cipher });
    const saved = await manager.save({ name: "web", transport: "http", url: `http://127.0.0.1:${http.port}/mcp`, headers: { Authorization: "Bearer tok123" }, autoRunReadOnly: true });
    expect(saved.server?.headers).toEqual({ Authorization: SECRET_KEEP });
    const test = await manager.test(saved.server!.id);
    expect(test).toMatchObject({ ok: true, serverInfo: { name: "glide-fixture" } });
    expect(test.tools.map((t) => t.agentName)).toContain("mcp__web__echo");
    const { tools } = await manager.agentTools<AgentCapabilities>();
    const p = tools.find((t) => t.name === "mcp__web__echo")!.prepare({ text: "http" }, fakeCaps());
    if ("error" in p) throw new Error(p.error);
    expect((await p.run()).text).toBe("echo: http");
    await manager.closeAll();
  });

  it("a wrong token reports 401 in plain English", async () => {
    const manager = new McpManager({ file: () => tmpFile("http2.json"), cipher });
    const res = await manager.test({ name: "web", transport: "http", url: `http://127.0.0.1:${http.port}/mcp`, headers: { Authorization: "Bearer wrong" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/401/);
  });
});
