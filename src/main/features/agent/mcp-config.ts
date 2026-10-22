/**
 * MCP server configuration: validation, import from Claude Desktop / `.mcp.json` configs (parse only —
 * Glide never reads those files itself), and the on-disk store. Header and env values are secrets:
 * encrypted with safeStorage on disk and replaced by SECRET_KEEP before anything reaches the renderer.
 */
import fs from "node:fs";
import path from "node:path";
import type { Cipher } from "../ai/keystore";
import { SECRET_KEEP, type McpImportPreview, type McpServerConfig, type McpTransportKind } from "./mcp-types";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RATE_LIMIT = 30;
const MAX_SERVERS = 50;
const MAX_ARGS = 64;
const MAX_KV = 64;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function slugId(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "server";
}

function kv(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v).slice(0, MAX_KV)) {
    const key = k.trim();
    if (!key || key.length > 200 || /[\r\n\0]/.test(key)) continue;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[key] = String(val).slice(0, 8000);
  }
  return Object.keys(out).length ? out : undefined;
}

function transportOf(raw: Raw): McpTransportKind | null {
  const t = typeof raw.transport === "string" ? raw.transport : typeof raw.type === "string" ? raw.type : undefined;
  if (t === "stdio") return "stdio";
  if (t === "http" || t === "streamable-http" || t === "streamableHttp") return "http";
  if (t === "sse") return "sse";
  if (t !== undefined) return null;
  if (typeof raw.command === "string") return "stdio";
  if (typeof raw.url === "string") return "http";
  return null;
}

/** Validates any server-shaped object into a config, or returns why it's invalid. */
export function normalizeServer(raw: unknown, fallbackName?: string): McpServerConfig | { error: string } {
  if (!isObj(raw)) return { error: "Server config must be an object" };
  const name = text(raw.name, 60) ?? text(fallbackName, 60);
  if (!name) return { error: "Give the server a name" };
  const transport = transportOf(raw);
  if (!transport) return { error: `“${name}”: choose stdio (a command) or HTTP (a URL)` };
  const base = {
    id: text(raw.id, 60) && /^[a-z0-9-]+$/.test(String(raw.id)) ? String(raw.id) : slugId(name),
    name,
    enabled: raw.enabled !== false,
    transport,
    autoRunReadOnly: raw.autoRunReadOnly === true,
    disabledTools: Array.isArray(raw.disabledTools) ? raw.disabledTools.filter((t): t is string => typeof t === "string").slice(0, 500) : [],
    timeoutMs: typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? Math.max(1000, Math.min(600_000, Math.round(raw.timeoutMs))) : DEFAULT_TIMEOUT_MS,
    rateLimitPerMinute: typeof raw.rateLimitPerMinute === "number" && Number.isFinite(raw.rateLimitPerMinute) ? Math.max(0, Math.min(1000, Math.round(raw.rateLimitPerMinute))) : DEFAULT_RATE_LIMIT,
  };
  if (transport === "stdio") {
    const command = text(raw.command, 1000);
    if (!command) return { error: `“${name}”: a command is required` };
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string | number => typeof a === "string" || typeof a === "number").map(String).slice(0, MAX_ARGS) : [];
    const cwd = text(raw.cwd, 1000);
    const env = kv(raw.env);
    return { ...base, command, args, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) };
  }
  const url = text(raw.url, 2000);
  if (!url) return { error: `“${name}”: a URL is required` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `“${name}”: “${url}” isn't a valid URL` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { error: `“${name}”: the URL must start with https:// or http://` };
  const headers = kv(raw.headers);
  return { ...base, url: parsed.toString(), ...(headers ? { headers } : {}) };
}

// --- import -------------------------------------------------------------------------

export interface ParsedImport {
  format: "claude-desktop" | "mcp-json";
  servers: McpServerConfig[];
  errors: string[];
}

/**
 * Parses Claude Desktop's claude_desktop_config.json ({ mcpServers: { name: { command, args, env } } })
 * and project `.mcp.json` files (same map, entries may carry type: "stdio" | "http" | "sse", url, headers).
 * `${VAR}` placeholders are kept literally; the user can fill them in before enabling.
 */
export function parseImport(input: string): ParsedImport | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch (err) {
    return { error: `That isn't valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObj(json)) return { error: "Expected a JSON object with an mcpServers map" };
  const map = isObj(json.mcpServers) ? json.mcpServers : isObj(json.servers) ? json.servers : null;
  if (!map) return { error: "No “mcpServers” found — paste a Claude Desktop config or a .mcp.json file" };
  const entries = Object.entries(map);
  const typed = entries.some(([, v]) => isObj(v) && typeof v.type === "string");
  const servers: McpServerConfig[] = [];
  const errors: string[] = [];
  for (const [name, raw] of entries.slice(0, MAX_SERVERS)) {
    // Imported servers start disabled: the user reviews the command before Glide ever runs it.
    const n = normalizeServer(isObj(raw) ? { ...raw, name, id: undefined, enabled: false } : raw, name);
    if ("error" in n) errors.push(n.error);
    else servers.push(n);
  }
  return { format: typed || entries.some(([, v]) => isObj(v) && typeof v.url === "string") ? "mcp-json" : "claude-desktop", servers, errors };
}

export function previewOf(parsed: ParsedImport, existing: McpServerConfig[]): McpImportPreview {
  return {
    ok: true,
    format: parsed.format,
    ...(parsed.errors.length ? { error: parsed.errors.join("\n") } : {}),
    servers: parsed.servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      url: s.url,
      envKeys: Object.keys(s.env ?? {}),
      headerKeys: Object.keys(s.headers ?? {}),
      exists: existing.some((e) => e.id === s.id || e.name === s.name),
    })),
  };
}

// --- masking --------------------------------------------------------------------------

export function maskSecrets(s: McpServerConfig): McpServerConfig {
  const mask = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.keys(r).map((k) => [k, SECRET_KEEP])) : undefined);
  const out: McpServerConfig = { ...s, args: s.args ? [...s.args] : undefined, disabledTools: [...s.disabledTools] };
  if (s.env) out.env = mask(s.env);
  if (s.headers) out.headers = mask(s.headers);
  return out;
}

/** Replaces SECRET_KEEP values in an edited config by the saved ones. */
export function restoreSecrets(next: McpServerConfig, prev: McpServerConfig | undefined): McpServerConfig {
  const fill = (r: Record<string, string> | undefined, old: Record<string, string> | undefined) => {
    if (!r) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v === SECRET_KEEP) {
        if (old?.[k] !== undefined) out[k] = old[k];
      } else out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const out = { ...next };
  const env = fill(next.env, prev?.env);
  const headers = fill(next.headers, prev?.headers);
  if (env) out.env = env;
  else delete out.env;
  if (headers) out.headers = headers;
  else delete out.headers;
  return out;
}

// --- store ------------------------------------------------------------------------------

interface StoredSecret {
  enc: string;
}
type StoredServer = Omit<McpServerConfig, "env" | "headers"> & { env?: Record<string, StoredSecret>; headers?: Record<string, StoredSecret> };

/** <dataDir>/mcp-servers.json. Secrets are refused (not written in plaintext) when encryption is unavailable. */
export class McpConfigStore {
  private cache: McpServerConfig[] | null = null;

  constructor(
    private readonly file: () => string,
    private readonly cipher: Cipher,
    private readonly log: (...a: unknown[]) => void = () => undefined,
  ) {}

  list(): McpServerConfig[] {
    if (this.cache) return this.cache;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file(), "utf8"));
    } catch {
      return (this.cache = []);
    }
    const servers = isObj(raw) && Array.isArray(raw.servers) ? raw.servers : [];
    const out: McpServerConfig[] = [];
    for (const s of servers) {
      if (!isObj(s)) continue;
      const dec = (r: unknown): Record<string, string> | undefined => {
        if (!isObj(r)) return undefined;
        const o: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) {
          if (!isObj(v) || typeof v.enc !== "string") continue;
          try {
            o[k] = this.cipher.decryptString(Buffer.from(v.enc, "base64"));
          } catch {
            this.log(`mcp: couldn't decrypt ${k} for ${String(s.name)}`);
          }
        }
        return Object.keys(o).length ? o : undefined;
      };
      const n = normalizeServer({ ...s, env: dec(s.env), headers: dec(s.headers) });
      if (!("error" in n)) out.push(n);
    }
    return (this.cache = out);
  }

  get(id: string): McpServerConfig | undefined {
    return this.list().find((s) => s.id === id);
  }

  write(servers: McpServerConfig[]): void {
    const hasSecrets = servers.some((s) => Object.keys(s.env ?? {}).length || Object.keys(s.headers ?? {}).length);
    if (hasSecrets && !this.cipher.isEncryptionAvailable()) throw new Error("Secure storage is unavailable, so headers and environment values can't be saved");
    const enc = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { enc: this.cipher.encryptString(v).toString("base64") }])) : undefined);
    const stored: StoredServer[] = servers.slice(0, MAX_SERVERS).map((s) => {
      const { env, headers, ...rest } = s;
      return { ...rest, ...(env ? { env: enc(env) } : {}), ...(headers ? { headers: enc(headers) } : {}) };
    });
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    const tmp = `${this.file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, servers: stored }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file());
    this.cache = servers.slice(0, MAX_SERVERS);
  }

  /** Adds or replaces by id; a new server whose id is taken gets a numbered id. */
  upsert(server: McpServerConfig, isNew: boolean): McpServerConfig {
    const all = [...this.list()];
    let s = server;
    if (isNew) {
      let id = s.id;
      for (let i = 2; all.some((x) => x.id === id); i++) id = `${s.id}-${i}`;
      s = { ...s, id };
    }
    const i = all.findIndex((x) => x.id === s.id);
    if (i >= 0) all[i] = s;
    else all.push(s);
    if (all.some((x) => x.id !== s.id && x.name.toLowerCase() === s.name.toLowerCase())) throw new Error(`A server named “${s.name}” already exists`);
    this.write(all);
    return s;
  }

  remove(id: string): boolean {
    const all = this.list();
    if (!all.some((s) => s.id === id)) return false;
    this.write(all.filter((s) => s.id !== id));
    return true;
  }
}
