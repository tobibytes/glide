/**
 * Builds the SDK transport for a server config. Stdio servers run under a /bin/sh watchdog that
 * kills the server when Glide's process disappears (crash, force quit), so no server is ever orphaned;
 * a normal quit or disable also SIGTERMs the watchdog, which forwards it.
 */
import os from "node:os";
import path from "node:path";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./mcp-types";

/**
 * Runs "$@" with stdin/stdout inherited (`<&0` stops sh from giving a background job /dev/null),
 * then polls: if Glide (pid $1) is gone, terminate the server. SIGTERM/INT/HUP are forwarded.
 * Exits with the server's status when the server exits on its own.
 */
export const WATCHDOG_SCRIPT = [
  'glide="$1"; shift',
  '"$@" <&0 &',
  "child=$!",
  "stop() { kill -TERM \"$child\" 2>/dev/null; sleep 1; kill -KILL \"$child\" 2>/dev/null; exit 143; }",
  "trap stop TERM INT HUP",
  'while kill -0 "$child" 2>/dev/null; do',
  '  if ! kill -0 "$glide" 2>/dev/null; then stop; fi',
  "  sleep 0.5",
  "done",
  'wait "$child"',
].join("\n");

/** GUI apps get a minimal PATH; add the usual places npx/uvx/node live. */
export function serverPath(base = process.env.PATH ?? ""): string {
  const home = os.homedir();
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local/bin"), path.join(home, ".bun/bin"), path.join(home, ".cargo/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const parts = base.split(":").filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  return parts.join(":");
}

export interface BuiltTransport {
  transport: Transport;
  /** Stdio only: the watchdog's pid (signal it to stop the server). */
  pid?: () => number | null;
  /** Stdio only: recent stderr output, for error messages. */
  stderr?: () => string;
}

export type TransportFactory = (config: McpServerConfig) => BuiltTransport;

export function createTransport(config: McpServerConfig, opts: { parentPid?: number; watchdog?: boolean } = {}): BuiltTransport {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("No command configured");
    const watchdog = opts.watchdog !== false && process.platform !== "win32";
    const env: Record<string, string> = { PATH: serverPath(), ...(config.env ?? {}) };
    const t = new StdioClientTransport({
      command: watchdog ? "/bin/sh" : config.command,
      args: watchdog ? ["-c", WATCHDOG_SCRIPT, "glide-mcp-watchdog", String(opts.parentPid ?? process.pid), config.command, ...(config.args ?? [])] : (config.args ?? []),
      env,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      stderr: "pipe",
    });
    let tail = "";
    t.stderr?.on("data", (d: Buffer | string) => {
      tail = (tail + d.toString()).slice(-2000);
    });
    return { transport: t, pid: () => t.pid, stderr: () => tail.trim() };
  }
  if (!config.url) throw new Error("No URL configured");
  const requestInit: RequestInit = config.headers ? { headers: { ...config.headers } } : {};
  const url = new URL(config.url);
  if (config.transport === "sse") return { transport: new SSEClientTransport(url, { requestInit }) };
  return { transport: new StreamableHTTPClientTransport(url, { requestInit }) };
}
