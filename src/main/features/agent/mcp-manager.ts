/**
 * Glide Agent's MCP client: owns the configured servers and their connections. Connections open
 * lazily (the first agent request that needs tools, or "Test connection"), stay up while Glide runs,
 * reconnect with backoff, and are closed (stdio children killed) on disable, removal, edit and quit.
 */
import type { Cipher } from "../ai/keystore";
import { maskSecrets, McpConfigStore, normalizeServer, parseImport, previewOf, restoreSecrets } from "./mcp-config";
import { McpConnection } from "./mcp-connection";
import { buildMcpTools, ServerRateLimit, toolViews } from "./mcp-tools";
import { createTransport, type TransportFactory } from "./mcp-transport";
import type { McpImportPreview, McpSaveResult, McpServerConfig, McpServerView, McpTestResult } from "./mcp-types";
import type { AgentToolOf } from "./tooling";

export interface McpManagerOptions {
  file: () => string;
  cipher: Cipher;
  log?: (...a: unknown[]) => void;
  /** Called whenever a server's state or tools change. */
  onChange?: () => void;
  factory?: TransportFactory;
  connectTimeoutMs?: number;
  backoffBaseMs?: number;
  now?: () => number;
}

export interface McpToolset<C> {
  tools: AgentToolOf<C>[];
  /** Plain-English problems (servers that couldn't connect), shown in the transcript. */
  problems: string[];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class McpManager {
  readonly store: McpConfigStore;
  private conns = new Map<string, McpConnection>();
  private limiter: ServerRateLimit;
  private factory: TransportFactory;

  constructor(private readonly opts: McpManagerOptions) {
    this.store = new McpConfigStore(opts.file, opts.cipher, opts.log);
    this.limiter = new ServerRateLimit(opts.now);
    this.factory = opts.factory ?? ((c) => createTransport(c));
  }

  private conn(config: McpServerConfig): McpConnection {
    let c = this.conns.get(config.id);
    if (!c) {
      c = new McpConnection(config, { factory: this.factory, log: this.opts.log, onChange: () => this.opts.onChange?.(), connectTimeoutMs: this.opts.connectTimeoutMs, backoffBaseMs: this.opts.backoffBaseMs, now: this.opts.now });
      this.conns.set(config.id, c);
    } else c.config = config;
    return c;
  }

  list(): McpServerView[] {
    const taken = new Set<string>();
    return this.store.list().map((s) => {
      const c = this.conns.get(s.id);
      return {
        ...maskSecrets(s),
        state: c?.state ?? "idle",
        ...(c?.error ? { error: c.error } : {}),
        ...(c?.serverInfo ? { serverInfo: c.serverInfo } : {}),
        tools: c ? toolViews(s, c.tools, taken) : [],
        ...(c?.pid ? { pid: c.pid } : {}),
      };
    });
  }

  /** Tools for one agent run: connects every enabled server (in parallel), skipping the ones that fail. */
  async agentTools<C>(): Promise<McpToolset<C>> {
    const servers = this.store.list().filter((s) => s.enabled);
    const problems: string[] = [];
    await Promise.all(
      servers.map(async (s) => {
        try {
          await this.conn(s).ensure();
        } catch (err) {
          problems.push(`MCP server “${s.name}” is unavailable, so its tools can't be used: ${errText(err).split("\n")[0]}`);
        }
      }),
    );
    const taken = new Set<string>();
    const tools: AgentToolOf<C>[] = [];
    for (const s of servers) {
      const c = this.conns.get(s.id);
      if (c?.state !== "ready") continue;
      tools.push(...buildMcpTools<C>(s, c.tools, c, this.limiter, taken));
    }
    return { tools, problems };
  }

  /** "Test connection": a saved server by id (keeps the connection), or an unsaved draft (temporary). */
  async test(input: unknown): Promise<McpTestResult> {
    const started = (this.opts.now ?? Date.now)();
    const ms = () => (this.opts.now ?? Date.now)() - started;
    let config: McpServerConfig;
    let temporary = false;
    if (typeof input === "string") {
      const saved = this.store.get(input);
      if (!saved) return { ok: false, error: "Unknown server", tools: [], ms: 0 };
      config = saved;
    } else {
      const n = normalizeServer(input);
      if ("error" in n) return { ok: false, error: n.error, tools: [], ms: 0 };
      config = restoreSecrets(n, this.store.get(n.id));
      temporary = true;
    }
    const c = temporary ? new McpConnection(config, { factory: this.factory, log: this.opts.log, connectTimeoutMs: this.opts.connectTimeoutMs }) : this.conn(config);
    try {
      if (!temporary && c.state === "error") await c.close();
      await c.ensure();
      return { ok: true, serverInfo: c.serverInfo, tools: toolViews(config, c.tools), ms: ms() };
    } catch (err) {
      return { ok: false, error: errText(err), tools: [], ms: ms() };
    } finally {
      if (temporary) await c.close();
      this.opts.onChange?.();
    }
  }

  async save(input: unknown): Promise<McpSaveResult> {
    const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const isNew = typeof raw.id !== "string" || !this.store.get(raw.id);
    const n = normalizeServer(isNew ? { ...raw, id: undefined } : raw);
    if ("error" in n) return { ok: false, error: n.error };
    const prev = isNew ? undefined : this.store.get(n.id);
    const next = restoreSecrets(n, prev);
    let saved: McpServerConfig;
    try {
      saved = this.store.upsert(next, isNew);
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
    // Anything that changes how we connect (or disabling) drops the live connection.
    const c = this.conns.get(saved.id);
    if (c) {
      const connKey = (s: McpServerConfig) => JSON.stringify([s.transport, s.command, s.args, s.env, s.cwd, s.url, s.headers, s.timeoutMs, s.name]);
      if (!saved.enabled || !prev || connKey(prev) !== connKey(saved)) {
        await c.close();
        this.conns.delete(saved.id);
      } else c.config = saved;
    }
    this.opts.onChange?.();
    return { ok: true, server: this.list().find((s) => s.id === saved.id) };
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpSaveResult> {
    const s = this.store.get(id);
    if (!s) return { ok: false, error: "Unknown server" };
    return this.save({ ...s, enabled });
  }

  async remove(id: string): Promise<boolean> {
    const c = this.conns.get(id);
    if (c) {
      await c.close();
      this.conns.delete(id);
    }
    const ok = this.store.remove(id);
    this.opts.onChange?.();
    return ok;
  }

  async reconnect(id: string): Promise<McpTestResult> {
    const c = this.conns.get(id);
    if (c) await c.close();
    return this.test(id);
  }

  /** Parse (preview) or apply an import of a Claude Desktop / .mcp.json config. */
  import(textInput: unknown, apply: boolean): McpImportPreview {
    if (typeof textInput !== "string" || !textInput.trim()) return { ok: false, error: "Paste a config or choose a file", servers: [] };
    if (textInput.length > 1_000_000) return { ok: false, error: "That file is too large", servers: [] };
    const parsed = parseImport(textInput);
    if ("error" in parsed) return { ok: false, error: parsed.error, servers: [] };
    const preview = previewOf(parsed, this.store.list());
    if (!apply) return preview;
    let imported = 0;
    const errors: string[] = parsed.errors.slice();
    for (const s of parsed.servers) {
      if (this.store.list().some((e) => e.name.toLowerCase() === s.name.toLowerCase())) {
        errors.push(`“${s.name}” already exists — skipped`);
        continue;
      }
      try {
        this.store.upsert(s, true);
        imported++;
      } catch (err) {
        errors.push(errText(err));
      }
    }
    this.opts.onChange?.();
    return { ...previewOf(parsed, this.store.list()), imported, ...(errors.length ? { error: errors.join("\n") } : {}) };
  }

  connection(id: string): McpConnection | undefined {
    return this.conns.get(id);
  }

  /** Graceful shutdown of every connection. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.close()));
    this.conns.clear();
  }

  /** For will-quit: signal every stdio child now (cannot await). */
  killAll(): void {
    for (const c of this.conns.values()) c.killNow();
    void this.closeAll();
  }
}
