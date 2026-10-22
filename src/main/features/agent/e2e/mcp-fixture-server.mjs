// Fixture MCP server written for Glide's tests (never a third-party server).
//   node mcp-fixture-server.mjs                 → stdio
//   node mcp-fixture-server.mjs --http <port>   → Streamable HTTP on 127.0.0.1 (requires Bearer $FIXTURE_TOKEN if set)
// FIXTURE_LOG=<file>: appends "pid <n>" at start and one JSON line per tool call (proves what ran).
import fs from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const FIXTURE_TOOLS = [
  { name: "echo", title: "Echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "add_note", description: "Store a note on the fixture server.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: "delete_all", description: "Deletes every note.", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Waits ms milliseconds.", inputSchema: { type: "object", properties: { ms: { type: "number" } } }, annotations: { readOnlyHint: true } },
  { name: "big", description: "Returns a lot of text.", inputSchema: { type: "object", properties: { n: { type: "number" } } }, annotations: { readOnlyHint: true } },
  { name: "picture", description: "Returns an image and a resource link.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  {
    name: "weird.schema/tool",
    description: "Top-level union schema.",
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "number" } } }] },
    annotations: { readOnlyHint: true },
  },
];

export function createFixtureServer(opts = {}) {
  const notes = [];
  const log = (line) => opts.log?.(line);
  const server = new Server({ name: "glide-fixture", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FIXTURE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    log(JSON.stringify({ tool: name, args }));
    switch (name) {
      case "echo":
        return { content: [{ type: "text", text: `echo: ${args.text}` }] };
      case "add_note":
        notes.push(String(args.text));
        return { content: [{ type: "text", text: `Saved note ${notes.length}: ${args.text}` }] };
      case "delete_all":
        notes.length = 0;
        return { content: [{ type: "text", text: "Deleted all notes" }] };
      case "slow":
        await new Promise((r) => setTimeout(r, Number(args.ms ?? 1000)));
        return { content: [{ type: "text", text: "done waiting" }] };
      case "big":
        return { content: [{ type: "text", text: "x".repeat(Number(args.n ?? 20000)) }] };
      case "picture":
        return {
          content: [
            { type: "image", data: TINY_PNG, mimeType: "image/png" },
            { type: "resource_link", uri: "file:///tmp/fixture.txt", name: "fixture.txt", mimeType: "text/plain" },
          ],
        };
      case "fail":
        return { content: [{ type: "text", text: "fixture failure" }], isError: true };
      case "weird.schema/tool":
        return { content: [{ type: "text", text: `weird ok ${JSON.stringify(args)}` }] };
      default:
        throw new Error(`unknown tool ${name}`);
    }
  });
  return { server, notes };
}

/** Streamable HTTP (stateless JSON) on 127.0.0.1; resolves with { port, close }. */
export function startHttpFixture({ port = 0, token, log } = {}) {
  const httpServer = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const { server } = createFixtureServer({ log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : port, close: () => new Promise((r) => (httpServer.closeAllConnections?.(), httpServer.close(() => r()))) });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const file = process.env.FIXTURE_LOG;
  const log = (line) => file && fs.appendFileSync(file, `${line}\n`);
  log(`pid ${process.pid}`);
  const i = process.argv.indexOf("--http");
  if (i > 0) {
    const { port } = await startHttpFixture({ port: Number(process.argv[i + 1] ?? 0), token: process.env.FIXTURE_TOKEN, log });
    process.stderr.write(`fixture http on ${port}\n`);
  } else {
    const { server } = createFixtureServer({ log });
    await server.connect(new StdioServerTransport());
    process.stdin.on("end", () => process.exit(0));
  }
}
