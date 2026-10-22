/**
 * Turns a connected server's MCP tools into Glide Agent tools. Policy:
 * - readOnlyHint tools are not state-changing (offered in Read-only mode). They run directly only when
 *   the user trusts that server's hints ("Run read-only tools without asking"); otherwise they ask first.
 * - every other tool is state-changing: it goes through the confirmation step unless allow-listed.
 * - per-server rate limit, per-call timeout (in the connection), errors become tool errors.
 */
import { argsSummary, mcpToolName, resultText, toInputSchema, toolDescription } from "./mcp-schema";
import type { CallOutcome, McpToolDef } from "./mcp-connection";
import type { McpServerConfig, McpToolView } from "./mcp-types";
import { ToolFailure, type AgentToolOf, type ToolOutput } from "./tooling";

export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<CallOutcome>;
}

/** Sliding one-minute window per server. */
export class ServerRateLimit {
  private hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  take(serverId: string, perMinute: number): string | null {
    if (perMinute <= 0) return null;
    const t = this.now();
    const hits = (this.hits.get(serverId) ?? []).filter((h) => t - h < 60_000);
    if (hits.length >= perMinute) {
      this.hits.set(serverId, hits);
      return `Rate limited: at most ${perMinute} calls per minute to this MCP server. Try again in ${Math.ceil((60_000 - (t - hits[0]!)) / 1000)} s.`;
    }
    hits.push(t);
    this.hits.set(serverId, hits);
    return null;
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function toolTitle(t: McpToolDef): string {
  return (t.title ?? t.annotations?.title ?? t.name).slice(0, 80);
}

export function toolViews(config: McpServerConfig, tools: McpToolDef[], taken = new Set<string>()): McpToolView[] {
  return tools.map((t) => ({
    name: t.name,
    agentName: mcpToolName(config.name, t.name, taken),
    title: toolTitle(t),
    description: (t.description ?? "").slice(0, 400),
    readOnly: t.annotations?.readOnlyHint === true,
    destructive: t.annotations?.readOnlyHint !== true && t.annotations?.destructiveHint !== false,
    enabled: !config.disabledTools.includes(t.name),
  }));
}

export function buildMcpTools<C>(config: McpServerConfig, tools: McpToolDef[], caller: McpCaller, limiter: ServerRateLimit, taken: Set<string>): AgentToolOf<C>[] {
  const out: AgentToolOf<C>[] = [];
  for (const t of tools) {
    const agentName = mcpToolName(config.name, t.name, taken);
    if (config.disabledTools.includes(t.name)) continue;
    const readOnly = t.annotations?.readOnlyHint === true;
    // MCP's default for destructiveHint (when not read-only) is true.
    const destructive = !readOnly && t.annotations?.destructiveHint !== false;
    const schema = toInputSchema(t.inputSchema);
    const required = Array.isArray(schema.required) ? schema.required : [];
    const notes = [readOnly ? "read-only" : destructive ? "may change or delete data" : "changes data", t.annotations?.openWorldHint ? "reaches outside services" : ""].filter(Boolean);
    out.push({
      name: agentName,
      title: `${config.name} › ${toolTitle(t)}`,
      description: toolDescription(config.name, t.description, notes),
      mutating: !readOnly,
      ...(readOnly && !config.autoRunReadOnly ? { askFirst: true } : {}),
      schema,
      prepare(input) {
        if (!isRec(input)) return { error: "Tool input must be a JSON object" };
        const missing = required.filter((k) => input[k] === undefined);
        if (missing.length) return { error: `missing required ${missing.map((m) => `"${m}"`).join(", ")}` };
        return {
          describe: async () => `Run ${t.name} on ${config.name} with ${argsSummary(input)}${destructive ? " — the server says this may change or delete data" : ""}`,
          run: async (): Promise<ToolOutput> => {
            const limited = limiter.take(config.id, config.rateLimitPerMinute);
            if (limited) throw new ToolFailure(limited);
            let res: CallOutcome;
            try {
              res = await caller.callTool(t.name, input);
            } catch (err) {
              throw new ToolFailure(`MCP ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
            const text = resultText(res);
            if (res.isError) throw new ToolFailure(text);
            return { text };
          },
        };
      },
    });
  }
  return out;
}
