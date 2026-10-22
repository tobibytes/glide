/**
 * MCP client types shared by the agent's main process and the renderer (type-only on the renderer side).
 * Secret values (header and env values) never cross to the renderer: they come back as SECRET_KEEP.
 */

export type McpTransportKind = "stdio" | "http" | "sse";

/** Placeholder the renderer sends back for a saved secret it didn't change. */
export const SECRET_KEEP = "__glide_secret_unchanged__";

export interface McpServerConfig {
  id: string;
  /** Display name; also the tool namespace (mcp__<name>__<tool>). */
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  /** Secret: stored encrypted. */
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** Secret: stored encrypted (Authorization: Bearer …, API keys). */
  headers?: Record<string, string>;
  /** Tools the server marks read-only run without asking. Off: every call is confirmed. */
  autoRunReadOnly: boolean;
  /** Tool names (the server's own names) not offered to the agent. */
  disabledTools: string[];
  /** Per-call timeout. */
  timeoutMs: number;
  /** Calls per minute to this server across all runs (0 = unlimited). */
  rateLimitPerMinute: number;
}

export type McpConnectionState = "idle" | "connecting" | "ready" | "error" | "closed";

export interface McpToolView {
  /** The server's tool name. */
  name: string;
  /** The name Claude sees (mcp__server__tool). */
  agentName: string;
  title: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  enabled: boolean;
}

export interface McpServerView extends McpServerConfig {
  state: McpConnectionState;
  error?: string;
  serverInfo?: { name: string; version: string };
  /** Tools from the last successful listing (empty until connected). */
  tools: McpToolView[];
  /** Stdio child pid while connected (diagnostics). */
  pid?: number;
}

export interface McpTestResult {
  ok: boolean;
  error?: string;
  serverInfo?: { name: string; version: string };
  tools: McpToolView[];
  ms: number;
}

export interface McpImportPreview {
  ok: boolean;
  error?: string;
  /** Detected format. */
  format?: "claude-desktop" | "mcp-json";
  servers: Array<Pick<McpServerConfig, "name" | "transport" | "command" | "args" | "url"> & { envKeys: string[]; headerKeys: string[]; exists: boolean }>;
  imported?: number;
}

export interface McpSaveResult {
  ok: boolean;
  error?: string;
  server?: McpServerView;
}
