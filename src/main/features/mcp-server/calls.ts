/**
 * One tools/call from an MCP client, end to end: permission policy → rate limits → argument
 * validation → in-Glide confirmation (state-changing tools) → run → request log. Pure apart from
 * the injected backend, so it is unit-tested with fakes.
 */
import type { Confirmations } from "./confirm";
import { gateFor, type McpServerSettings } from "./policy";
import type { RateLimiter } from "./ratelimit";
import type { LogEntry, RequestLog } from "./requestlog";
import type { McpToolDef } from "./tools";

export interface PreparedCall {
  describe(): Promise<string>;
  run(): Promise<string>;
}

export interface McpBackend {
  available(t: McpToolDef): boolean;
  prepare(t: McpToolDef, args: Record<string, unknown>): PreparedCall | { error: string };
}

export interface CallResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface CallDeps {
  tools: readonly McpToolDef[];
  settings(): McpServerSettings;
  backend: McpBackend;
  confirm: Confirmations;
  limiter: RateLimiter;
  log: RequestLog;
  grantAlways(client: string, tool: string): void;
  now?(): number;
}

const text = (t: string, isError = false): CallResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Tools whose arguments are clipboard-like or free text: the log keeps only the tool title. */
const PRIVATE_SUMMARY = new Set(["clipboard_history_search", "transform_text", "create_note", "capture_text_from_image"]);

export function createCallHandler(deps: CallDeps) {
  const now = deps.now ?? Date.now;

  /** Tools this client may see in tools/list (installed and not turned off). */
  const visibleTools = (client: string): McpToolDef[] => {
    const s = deps.settings();
    return deps.tools.filter((t) => deps.backend.available(t) && gateFor(t, s, client).kind !== "deny");
  };

  async function call(client: string, name: string, rawArgs: unknown): Promise<CallResult> {
    const t0 = now();
    const s = deps.settings();
    const tool = deps.tools.find((t) => t.name === name && deps.backend.available(t));
    const record = (e: Omit<LogEntry, "id" | "at" | "client" | "tool" | "ms">) =>
      deps.log.add({ at: t0, client, tool: name, ms: now() - t0, ...e, summary: tool && PRIVATE_SUMMARY.has(tool.name) ? tool.title : e.summary });
    if (!tool) {
      record({ summary: `Unknown tool ${name}`, outcome: "invalid" });
      return text(`Unknown tool ${name}`, true);
    }
    const gate = gateFor(tool, s, client);
    if (gate.kind === "deny") {
      record({ summary: tool.title, outcome: "off" });
      return text(gate.reason, true);
    }
    if (!deps.limiter.take(`all:${client}`, s.rateLimitPerMin) || (!tool.readOnly && !deps.limiter.take(`mut:${client}`, s.mutatingPerMin))) {
      record({ summary: tool.title, outcome: "rate-limited" });
      return text("Too many Glide requests: rate limit reached. Wait a minute and try again.", true);
    }
    const args = { ...(tool.defaults ?? {}), ...(rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {}) };
    const prepared = deps.backend.prepare(tool, args);
    if ("error" in prepared) {
      record({ summary: tool.title, outcome: "invalid", error: prepared.error });
      return text(prepared.error, true);
    }
    let summary = tool.title;
    try {
      summary = await prepared.describe();
    } catch {
      // keep the title
    }
    let approval: LogEntry["approval"] = "auto";
    if (gate.kind === "confirm") {
      const outcome = await deps.confirm.request({ client, tool: tool.name, toolTitle: tool.title, summary });
      if (outcome === "deny" || outcome === "timeout") {
        record({ summary, outcome: outcome === "deny" ? "denied" : "timeout" });
        return text(outcome === "deny" ? "The user denied this request in Glide." : "No answer in Glide before the confirmation timed out, so the request was denied.", true);
      }
      if (outcome === "always") deps.grantAlways(client, tool.name);
      approval = outcome === "always" ? "always" : "user";
    } else if ((s.always[client] ?? []).includes(tool.name)) approval = "always";
    try {
      const out = await prepared.run();
      record({ summary, outcome: "ok", approval });
      return text(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record({ summary, outcome: "error", error: message, approval });
      return text(message, true);
    }
  }

  return { call, visibleTools };
}

export type CallHandler = ReturnType<typeof createCallHandler>;
