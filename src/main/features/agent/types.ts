/**
 * Types shared by the agent's main process and renderer (type-only imports on the renderer side).
 * Nothing here references the API key.
 */

export type StepStatus = "queued" | "awaiting" | "running" | "ok" | "error" | "declined" | "skipped";

/** One tool call, as shown in the transcript. */
export interface AgentStep {
  id: string;
  tool: string;
  /** Human tool name, e.g. "Start Timer". */
  title: string;
  args: Record<string, unknown>;
  /** Exactly what will happen, e.g. "Start a 25 min timer named “Focus”". */
  summary: string;
  mutating: boolean;
  /** Ran without a confirmation because the user allowed this tool. */
  autoApproved?: boolean;
  status: StepStatus;
  result?: string;
}

export type TranscriptEntry =
  | { kind: "prompt"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "step"; id: string; step: AgentStep }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" | "warning" };

export type RunStatus = "running" | "confirming" | "done" | "error" | "cancelled";

export type AgentErrorKind = "no-key" | "auth" | "permission" | "rate-limit" | "overloaded" | "network" | "refusal" | "bad-request" | "limit" | "other";

export interface Confirmation {
  id: string;
  stepIds: string[];
}

export interface RunSnapshot {
  runId: string;
  prompt: string;
  status: RunStatus;
  entries: TranscriptEntry[];
  /** Set while the run waits for the user (status "confirming"). */
  confirmation?: Confirmation;
  toolCalls: number;
  maxToolCalls: number;
  model: string;
  error?: { message: string; kind: AgentErrorKind };
  startedAt: number;
  endedAt?: number;
}

export interface AgentSettings {
  [key: string]: unknown;
  /** Tool name -> run without asking. Only mutating tools are consulted. */
  allow: Record<string, boolean>;
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
}

export interface StartResult {
  ok: boolean;
  error?: string;
  errorKind?: AgentErrorKind;
}

export interface AgentStatus {
  hasKey: boolean;
  mock: boolean;
  model: string;
}

/** Props of the "agent.run" launcher view. */
export interface AgentViewProps {
  prompt?: string;
  /** Re-attach to a run that is already in progress (after the launcher was hidden by a tool). */
  runId?: string;
}
