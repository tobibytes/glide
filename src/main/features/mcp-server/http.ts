/**
 * Streamable HTTP endpoint for MCP on 127.0.0.1 only: http://127.0.0.1:<port>/mcp.
 *
 * Every request must carry `Authorization: Bearer <token>`. Host and Origin headers are checked
 * so a web page cannot reach the server through DNS rebinding. Each initialize creates a session
 * (its own SDK Server + transport, keyed by Mcp-Session-Id); idle sessions are dropped.
 */
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { authorized, MCP_PATH } from "./auth";

export interface HttpDeps {
  token(): string;
  /** A fresh protocol server for a new session. */
  createServer(): Server;
  onSessionsChanged?(count: number): void;
  log?(...args: unknown[]): void;
  maxSessions?: number;
  idleMs?: number;
  maxBodyBytes?: number;
}

export interface McpHttpServer {
  readonly port: number;
  readonly url: string;
  sessions(): number;
  /** Tell every session that tools/resources changed (policies were edited). */
  notifyListChanged(): void;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastSeen: number;
}

const HOST = "127.0.0.1";

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

const rpcError = (message: string, code = -32000) => JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Host must name this loopback server; Origin (browsers only) must be the same loopback origin. */
export function checkHostOrigin(host: string | undefined, origin: string | undefined, port: number): boolean {
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!host || !okHosts.has(host.toLowerCase())) return false;
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: HOST, exclusive: true });
  });
}

export async function startHttpServer(preferredPort: number, deps: HttpDeps): Promise<McpHttpServer> {
  const sessions = new Map<string, Session>();
  const maxSessions = deps.maxSessions ?? 32;
  const idleMs = deps.idleMs ?? 30 * 60_000;
  const maxBody = deps.maxBodyBytes ?? 4 * 1024 * 1024;
  let port = 0;
  const changed = () => deps.onSessionsChanged?.(sessions.size);

  const drop = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.server.close().catch(() => undefined);
    changed();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!checkHostOrigin(req.headers.host, req.headers.origin, port)) return send(res, 403, rpcError("Forbidden host or origin"));
    const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
    if (url.pathname !== MCP_PATH) return send(res, 404, rpcError("Not found"));
    if (!authorized(req.headers.authorization, deps.token())) return send(res, 401, rpcError("Missing or invalid bearer token"), { "www-authenticate": 'Bearer realm="glide"' });

    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return send(res, 404, rpcError("Unknown or expired session"));
      s.lastSeen = Date.now();
      const body = req.method === "POST" ? await readBody(req, maxBody) : undefined;
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== "POST") return send(res, 400, rpcError("Missing Mcp-Session-Id"));
    const body = await readBody(req, maxBody);
    if (!isInitializeRequest(body)) return send(res, 400, rpcError("The first request of a session must be initialize"));
    if (sessions.size >= maxSessions) {
      // Evict the least recently used session rather than refusing a new client.
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) drop(oldest[0]);
    }
    const server = deps.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastSeen: Date.now() });
        changed();
      },
      onsessionclosed: (id) => drop(id),
    });
    transport.onclose = () => {
      if (transport.sessionId) drop(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      deps.log?.("request failed", err instanceof Error ? err.message : err);
      send(res, 400, rpcError(err instanceof Error ? err.message : "Bad request", -32700));
    });
  });
  httpServer.keepAliveTimeout = 5000;

  try {
    port = await listen(httpServer, preferredPort);
  } catch (err) {
    if (preferredPort === 0) throw err;
    deps.log?.(`port ${preferredPort} unavailable (${err instanceof Error ? err.message : err}); using a free port`);
    port = await listen(httpServer, 0);
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) drop(id);
  }, Math.min(idleMs, 60_000));
  sweep.unref();

  return {
    get port() {
      return port;
    },
    get url() {
      return `http://${HOST}:${port}${MCP_PATH}`;
    },
    sessions: () => sessions.size,
    notifyListChanged() {
      for (const s of sessions.values()) {
        void s.server.sendToolListChanged().catch(() => undefined);
        void s.server.sendResourceListChanged().catch(() => undefined);
      }
    },
    async close() {
      clearInterval(sweep);
      for (const id of [...sessions.keys()]) drop(id);
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
