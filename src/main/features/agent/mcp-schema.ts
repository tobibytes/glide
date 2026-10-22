/**
 * Mapping between MCP and the Messages API: namespaced tool names (`mcp__<server>__<tool>`, limited to
 * [A-Za-z0-9_-]{1,64}), input schemas trimmed to what `input_schema` accepts, and tool results flattened
 * into tool_result text (images and binary resources are noted, not sent; huge outputs are truncated).
 */
import { createHash } from "node:crypto";
import type { JsonSchema } from "./tooling";

export const MCP_PREFIX = "mcp__";
export const MAX_TOOL_NAME = 64;
export const MAX_RESULT_CHARS = 5000;
const MAX_SCHEMA_BYTES = 32_000;
const MAX_SCHEMA_DEPTH = 12;
const MAX_DESCRIPTION = 1500;

const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_{3,}/g, "__").replace(/^_+|_+$/g, "");
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 6);

export const isMcpToolName = (name: string): boolean => name.startsWith(MCP_PREFIX) && /^[A-Za-z0-9_-]{1,64}$/.test(name);

/** `mcp__<server>__<tool>`, sanitized, ≤ 64 chars, unique within `taken` (which it updates). */
export function mcpToolName(server: string, tool: string, taken?: Set<string>): string {
  const s = clean(server) || "server";
  const t = clean(tool) || "tool";
  let name = `${MCP_PREFIX}${s}__${t}`;
  if (name.length > MAX_TOOL_NAME) {
    // Keep it readable: shorten both parts, then a hash of the full original keeps it unique.
    const h = hash(`${server}\0${tool}`);
    const room = MAX_TOOL_NAME - MCP_PREFIX.length - 2 - 1 - h.length;
    const sPart = s.slice(0, Math.min(s.length, Math.max(8, Math.floor(room / 3))));
    const tPart = t.slice(0, room - sPart.length);
    name = `${MCP_PREFIX}${sPart}__${tPart}_${h}`;
  }
  if (taken) {
    let candidate = name;
    for (let i = 2; taken.has(candidate); i++) candidate = `${name.slice(0, MAX_TOOL_NAME - String(i).length - 1)}_${i}`;
    taken.add(candidate);
    name = candidate;
  }
  return name;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Deep copy keeping only JSON values; drops cycles and anything below MAX_SCHEMA_DEPTH. */
function jsonOnly(v: unknown, depth: number, seen: Set<unknown>): Json | undefined {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "object" || depth > MAX_SCHEMA_DEPTH || seen.has(v)) return undefined;
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => jsonOnly(x, depth + 1, seen)).filter((x): x is Json => x !== undefined);
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) {
      const j = jsonOnly(x, depth + 1, seen);
      if (j !== undefined) out[k] = j;
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

const isRec = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The server's JSON Schema, passed through as far as the Messages API allows: the top level must be
 * `type: "object"` and can't be a oneOf/anyOf/allOf union (their object branches are merged into
 * optional properties), `$schema`/`$id` are dropped, and oversized schemas fall back to a free-form object.
 */
export function toInputSchema(schema: unknown): JsonSchema {
  const fallback = { type: "object", properties: {}, additionalProperties: true } as unknown as JsonSchema;
  const s = jsonOnly(schema, 0, new Set());
  if (!isRec(s)) return fallback;
  const { $schema: _s, $id: _i, oneOf, anyOf, allOf, type: _t, ...rest } = s;
  const out: Record<string, Json> = { ...rest, type: "object" };
  const props: Record<string, Json> = isRec(rest.properties) ? { ...rest.properties } : {};
  const required = new Set(Array.isArray(rest.required) ? rest.required.filter((r): r is string => typeof r === "string") : []);
  const branches = [oneOf, anyOf, allOf].flatMap((b) => (Array.isArray(b) ? b.filter(isRec) : []));
  for (const b of branches) if (isRec(b.properties)) for (const [k, v] of Object.entries(b.properties)) if (!(k in props)) props[k] = v;
  // allOf branches all apply, so their required keys stay required.
  if (Array.isArray(allOf)) for (const b of allOf.filter(isRec)) if (Array.isArray(b.required)) for (const r of b.required) if (typeof r === "string") required.add(r);
  out.properties = props;
  if (required.size) out.required = [...required].filter((r) => r in props || !branches.length);
  else delete out.required;
  if (JSON.stringify(out).length > MAX_SCHEMA_BYTES) return fallback;
  return out as unknown as JsonSchema;
}

export function toolDescription(server: string, description: string | undefined, notes: string[]): string {
  const d = (description ?? "").trim() || "(no description)";
  const head = `[MCP server “${server}”${notes.length ? `; ${notes.join(", ")}` : ""}] `;
  const body = d.length > MAX_DESCRIPTION ? `${d.slice(0, MAX_DESCRIPTION)}…` : d;
  return head + body;
}

// --- results ----------------------------------------------------------------------------

export interface McpContentLike {
  type: string;
  [k: string]: unknown;
}

const kb = (base64: unknown) => (typeof base64 === "string" ? Math.max(1, Math.round((base64.length * 3) / 4 / 1024)) : 0);

function contentText(c: McpContentLike): string {
  switch (c.type) {
    case "text":
      return typeof c.text === "string" ? c.text : "";
    case "image":
      return `[image ${String(c.mimeType ?? "")}, ~${kb(c.data)} KB — returned by the tool but not shown to the model]`;
    case "audio":
      return `[audio ${String(c.mimeType ?? "")}, ~${kb(c.data)} KB — not shown to the model]`;
    case "resource_link":
      return `[resource link: ${String(c.name ?? c.title ?? "")} <${String(c.uri ?? "")}>${c.mimeType ? ` (${String(c.mimeType)})` : ""}${c.description ? ` — ${String(c.description)}` : ""}]`;
    case "resource": {
      const r = (c.resource ?? {}) as Record<string, unknown>;
      if (typeof r.text === "string") return `[resource <${String(r.uri ?? "")}>]\n${r.text}`;
      return `[binary resource <${String(r.uri ?? "")}>${r.mimeType ? ` (${String(r.mimeType)})` : ""}, ~${kb(r.blob)} KB — not shown to the model]`;
    }
    default:
      return `[${c.type} content not supported]`;
  }
}

export function truncateResult(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[output truncated: ${text.length - max} more characters were not included]`;
}

/** Flattens a CallToolResult into the text of one tool_result. */
export function resultText(result: { content?: unknown; structuredContent?: unknown; toolResult?: unknown }): string {
  const parts = Array.isArray(result.content) ? (result.content as McpContentLike[]).filter((c) => c && typeof c.type === "string").map(contentText).filter(Boolean) : [];
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  if (!parts.length && result.toolResult !== undefined) parts.push(typeof result.toolResult === "string" ? result.toolResult : JSON.stringify(result.toolResult));
  return truncateResult(parts.join("\n") || "(the tool returned no content)");
}

/** Short one-line JSON of the arguments for the plain-English summary. */
export function argsSummary(args: Record<string, unknown>, max = 200): string {
  if (!Object.keys(args).length) return "no arguments";
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = "{…}";
  }
  return s.length > max ? `${s.slice(0, max)}…}` : s;
}
