/**
 * MCP server settings and the per-tool permission model (pure; no Electron).
 *
 * Every tool has a policy: "off" (hidden from tools/list and refused), "ask" (each call needs an
 * in-Glide Allow/Deny unless the user chose "Always" for that client) or "allow" (runs without
 * asking). Read-only tools default to "allow"; state-changing tools and anything that returns
 * clipboard contents default to "off", so enabling the server exposes nothing that changes state.
 */
import type { McpToolMeta } from "./tools";

export type ToolPolicy = "off" | "ask" | "allow";

export interface McpServerSettings {
  [key: string]: unknown;
  /** Explicit user toggle (Settings → MCP Server). Off by default. */
  enabled: boolean;
  /** Preferred 127.0.0.1 port; 0 = any free port. Falls back to a free port when taken. */
  port: number;
  /** Per-tool overrides of the default policy. */
  tools: Record<string, ToolPolicy>;
  /** "Always allow" grants from the confirmation prompt: client name -> tool names. */
  always: Record<string, string[]>;
  /** Seconds a confirmation waits before it is denied. */
  confirmTimeoutSec: number;
  /** Calls per minute per client (all tools). */
  rateLimitPerMin: number;
  /** State-changing calls per minute per client. */
  mutatingPerMin: number;
}

export const DEFAULT_PORT = 47811;

export const DEFAULT_SETTINGS: McpServerSettings = {
  enabled: false,
  port: DEFAULT_PORT,
  tools: {},
  always: {},
  confirmTimeoutSec: 60,
  rateLimitPerMin: 120,
  mutatingPerMin: 20,
};

export function defaultPolicy(t: Pick<McpToolMeta, "readOnly" | "sensitive">): ToolPolicy {
  return t.readOnly && !t.sensitive ? "allow" : "off";
}

export function policyFor(t: Pick<McpToolMeta, "name" | "readOnly" | "sensitive">, s: Pick<McpServerSettings, "tools">): ToolPolicy {
  const p = s.tools[t.name];
  if (p === "off" || p === "ask" || p === "allow") {
    // A state-changing tool is never silently "allow"ed from settings: it asks unless the user granted Always per client.
    if (p === "allow" && !t.readOnly) return "ask";
    return p;
  }
  return defaultPolicy(t);
}

export type Gate = { kind: "deny"; reason: string } | { kind: "run" } | { kind: "confirm" };

/** What to do with one call before rate limiting. */
export function gateFor(t: Pick<McpToolMeta, "name" | "readOnly" | "sensitive">, s: Pick<McpServerSettings, "tools" | "always">, client: string): Gate {
  const p = policyFor(t, s);
  if (p === "off") return { kind: "deny", reason: `The Glide tool ${t.name} is turned off. The user can enable it in Glide Settings → MCP Server.` };
  if (p === "allow") return { kind: "run" };
  if ((s.always[client] ?? []).includes(t.name)) return { kind: "run" };
  return { kind: "confirm" };
}

/** Sanitise a settings patch coming from the renderer. */
export function cleanPatch(patch: unknown, knownTools: ReadonlySet<string>): Partial<McpServerSettings> {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const out: Partial<McpServerSettings> = {};
  if (typeof p.enabled === "boolean") out.enabled = p.enabled;
  if (typeof p.port === "number" && Number.isInteger(p.port) && (p.port === 0 || (p.port >= 1024 && p.port <= 65535))) out.port = p.port;
  if (typeof p.confirmTimeoutSec === "number" && p.confirmTimeoutSec >= 5 && p.confirmTimeoutSec <= 600) out.confirmTimeoutSec = Math.round(p.confirmTimeoutSec);
  if (typeof p.rateLimitPerMin === "number" && p.rateLimitPerMin >= 1 && p.rateLimitPerMin <= 10_000) out.rateLimitPerMin = Math.round(p.rateLimitPerMin);
  if (typeof p.mutatingPerMin === "number" && p.mutatingPerMin >= 1 && p.mutatingPerMin <= 1000) out.mutatingPerMin = Math.round(p.mutatingPerMin);
  if (p.tools && typeof p.tools === "object") {
    const tools: Record<string, ToolPolicy> = {};
    for (const [k, v] of Object.entries(p.tools as Record<string, unknown>)) if (knownTools.has(k) && (v === "off" || v === "ask" || v === "allow")) tools[k] = v;
    out.tools = tools;
  }
  if (p.always && typeof p.always === "object") {
    const always: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(p.always as Record<string, unknown>))
      if (Array.isArray(v)) {
        const names = v.filter((x): x is string => typeof x === "string" && knownTools.has(x));
        if (names.length) always[k.slice(0, 200)] = [...new Set(names)];
      }
    out.always = always;
  }
  return out;
}
