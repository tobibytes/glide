/**
 * One live MCP server connection: lazy connect, cached tool list (refreshed on list_changed),
 * per-call timeouts, automatic reconnect with exponential backoff after an unexpected close, and
 * close/kill that never leaves a stdio child behind.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BuiltTransport, TransportFactory } from "./mcp-transport";
import type { McpConnectionState, McpServerConfig } from "./mcp-types";

export const CONNECT_TIMEOUT_MS = 15_000;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const MAX_AUTO_RECONNECTS = 5;

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface CallOutcome {
  content?: unknown;
  structuredContent?: unknown;
  toolResult?: unknown;
  isError?: boolean;
}

export interface ConnectionOptions {
  factory: TransportFactory;
  log?: (...a: unknown[]) => void;
  onChange?: () => void;
  connectTimeoutMs?: number;
  backoffBaseMs?: number;
  now?: () => number;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class McpConnection {
  state: McpConnectionState = "idle";
  error?: string;
  tools: McpToolDef[] = [];
  serverInfo?: { name: string; version: string };
  private client?: Client;
  private built?: BuiltTransport;
  private connecting?: Promise<void>;
  private closing = false;
  private attempts = 0;
  private retryTimer?: NodeJS.Timeout;
  private nextRetryAt = 0;

  constructor(
    public config: McpServerConfig,
    private readonly opts: ConnectionOptions,
  ) {}

  get pid(): number | undefined {
    return this.state === "ready" ? (this.built?.pid?.() ?? undefined) : undefined;
  }

  private set(state: McpConnectionState, error?: string) {
    this.state = state;
    this.error = error;
    this.opts.onChange?.();
  }

  /** Connects if needed. During a backoff wait it fails fast with the last error instead of hammering the server. */
  async ensure(): Promise<void> {
    if (this.state === "ready" && this.client) return;
    if (this.connecting) return this.connecting;
    const now = (this.opts.now ?? Date.now)();
    if (this.retryTimer && now < this.nextRetryAt) throw new Error(`${this.error ?? "Not connected"} (retrying in ${Math.ceil((this.nextRetryAt - now) / 1000)} s)`);
    this.closing = false;
    this.connecting = this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<void> {
    this.clearRetry();
    this.set("connecting");
    const client = new Client({ name: "Glide Agent", version: "1.0.0" }, { capabilities: {} });
    let built: BuiltTransport;
    try {
      built = this.opts.factory(this.config);
    } catch (err) {
      this.set("error", errText(err));
      throw err;
    }
    this.built = built;
    try {
      await client.connect(built.transport, { timeout: this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS });
      const listed = await this.listAll(client);
      // Only now does a close count as "unexpected".
      client.onclose = () => this.onUnexpectedClose(client);
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          this.tools = await this.listAll(client);
          this.opts.onChange?.();
        } catch (err) {
          this.opts.log?.(`mcp ${this.config.name}: tool list refresh failed`, errText(err));
        }
      });
      this.client = client;
      this.tools = listed;
      const v = client.getServerVersion();
      this.serverInfo = v ? { name: v.name, version: v.version } : undefined;
      this.attempts = 0;
      this.set("ready");
    } catch (err) {
      const stderr = built.stderr?.();
      const msg = describeConnectError(err, this.config, stderr);
      client.onclose = undefined;
      await client.close().catch(() => undefined);
      this.killChild();
      this.built = undefined;
      this.set("error", msg);
      throw new Error(msg);
    }
  }

  private async listAll(client: Client): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS });
      out.push(...(r.tools as McpToolDef[]));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  private onUnexpectedClose(client: Client) {
    if (this.client !== client || this.closing) return;
    this.client = undefined;
    const stderr = this.built?.stderr?.();
    this.built = undefined;
    this.set("error", `Disconnected from “${this.config.name}”${stderr ? `: ${stderr.split("\n").slice(-1)[0]}` : ""}`);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closing || !this.config.enabled || this.attempts >= MAX_AUTO_RECONNECTS) return;
    const delay = Math.min(BACKOFF_MAX_MS, (this.opts.backoffBaseMs ?? BACKOFF_BASE_MS) * 2 ** this.attempts);
    this.attempts++;
    this.nextRetryAt = (this.opts.now ?? Date.now)() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.closing) return;
      this.connecting = this.connect()
        .catch(() => this.scheduleReconnect())
        .finally(() => (this.connecting = undefined));
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallOutcome> {
    await this.ensure();
    const client = this.client;
    if (!client) throw new Error(`“${this.config.name}” is not connected`);
    const timeout = this.config.timeoutMs;
    try {
      return (await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout, ...(signal ? { signal } : {}) })) as CallOutcome;
    } catch (err) {
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) throw new Error(`“${name}” on ${this.config.name} timed out after ${Math.round(timeout / 1000)} s`);
      if (err instanceof McpError && err.code === ErrorCode.ConnectionClosed) throw new Error(`${this.config.name} disconnected during the call`);
      throw err;
    }
  }

  /** Graceful close (SDK closes stdin, then SIGTERM/SIGKILL); resolves when the transport is closed. */
  async close(): Promise<void> {
    this.closing = true;
    this.clearRetry();
    const client = this.client;
    this.client = undefined;
    this.tools = this.state === "ready" ? this.tools : [];
    if (client) {
      client.onclose = undefined;
      const pid = this.built?.pid?.() ?? null;
      await client.close().catch(() => undefined);
      if (pid) signal(pid, "SIGTERM");
    }
    this.built = undefined;
    if (this.state !== "idle") this.set("closed");
  }

  /** Synchronous kill for app quit (will-quit can't await). The watchdog forwards it to the server. */
  killNow(): void {
    this.closing = true;
    this.clearRetry();
    this.killChild();
  }

  private killChild() {
    const pid = this.built?.pid?.() ?? null;
    if (pid) signal(pid, "SIGTERM");
  }
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

function describeConnectError(err: unknown, config: McpServerConfig, stderr?: string): string {
  const base = errText(err);
  const where = config.transport === "stdio" ? `\`${config.command}\`` : config.url;
  let msg = `Couldn't connect to “${config.name}” (${where}): ${base}`;
  if (/ENOENT|not found|exit(ed)? with (code|status) 127/i.test(base + (stderr ?? ""))) msg = `Couldn't start “${config.name}”: ${config.command} wasn't found. Use the full path to the command.`;
  if (/\b401\b|unauthori[sz]ed/i.test(base)) msg = `“${config.name}” refused the connection (401 Unauthorized). Check the bearer token or headers.`;
  if (stderr) msg += `\n${stderr.split("\n").slice(-3).join("\n")}`;
  return msg.slice(0, 1200);
}
