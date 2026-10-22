/**
 * glide-mcp: a stdio ⇄ Streamable HTTP proxy for MCP clients that launch servers as commands
 * (Claude Desktop, Goose, Cursor…). It reads the running server's port from server.json and the
 * bearer token from Glide's data dir, then relays JSON-RPC messages unchanged in both directions.
 * Plain Node + the MCP SDK (bundled by scripts/glide-mcp.mjs), no Electron.
 */
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { readDiscovery, readToken } from "./auth";

export interface BridgeOptions {
  dir: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Override the URL from server.json (tests). */
  url?: string;
}

export const NOT_RUNNING =
  "Glide's MCP server is not running. Open Glide → Settings → MCP Server and turn on “Enable MCP server”, then restart this MCP connection.";

const isRequest = (m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string } => "method" in m && "id" in m && m.id !== undefined;

/** Resolves with the exit code once either side closes. */
export async function runBridge(o: BridgeOptions): Promise<number> {
  const disc = readDiscovery(o.dir);
  const token = readToken(o.dir);
  const url = o.url ?? disc?.url;
  if (!url || !token) {
    o.stderr.write(`${NOT_RUNNING}\n(looked in ${o.dir})\n`);
    return 1;
  }
  const local = new StdioServerTransport(o.stdin, o.stdout);
  const remote = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const pendingInit = new Set<string | number>();

  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      void remote
        .terminateSession()
        .catch(() => undefined)
        .finally(() => {
          void remote.close().catch(() => undefined);
          void local.close().catch(() => undefined);
          resolve(code);
        });
    };

    local.onmessage = (m) => {
      if (isRequest(m) && m.method === "initialize") pendingInit.add(m.id);
      remote.send(m).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        o.stderr.write(`glide-mcp: ${message}\n`);
        if (isRequest(m)) {
          const hint = /ECONNREFUSED|fetch failed/i.test(message) ? NOT_RUNNING : `Glide MCP request failed: ${message}`;
          void local.send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: hint } });
        }
      });
    };
    remote.onmessage = (m) => {
      if ("id" in m && m.id !== undefined && pendingInit.has(m.id) && "result" in m) {
        pendingInit.delete(m.id);
        const v = (m.result as { protocolVersion?: unknown }).protocolVersion;
        if (typeof v === "string") remote.setProtocolVersion(v);
      }
      void local.send(m);
    };
    remote.onerror = (err) => o.stderr.write(`glide-mcp: ${err.message}\n`);
    local.onerror = (err) => o.stderr.write(`glide-mcp: ${err.message}\n`);
    local.onclose = () => finish(0);
    o.stdin.once("end", () => finish(0));
    o.stdin.once("close", () => finish(0));

    void remote
      .start()
      .then(() => local.start())
      .catch((err: unknown) => {
        o.stderr.write(`glide-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
        finish(1);
      });
  });
}
