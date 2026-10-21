/**
 * Types shared by the agent's main process and renderer (type-only imports on the renderer side).
 * Nothing here references the API key.
 */

export type StepStatus = "queued" | "awaiting" | "running" | "ok" | "error" | "declined" | "skipped";

export interface StepUndo {
  /** Plain English, e.g. "Delete the note “Groceries”". */
  summary: string;
  state: "available" | "done" | "failed";
  error?: string;
}

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
  /** Set when the step changed something that Glide can put back. */
  undo?: StepUndo;
  /** Clipboard/selection content: redacted in saved history unless the user opted in. */
  sensitive?: boolean;
  /** Set when the step ran and has workflow action equivalents (in order). */
  workflow?: WorkflowStep[];
}

/** A Glide workflow action equivalent of a step (Save as Workflow). */
export interface WorkflowStep {
  /** "feature": params.feature + params.action name a feature-contributed workflow action. */
  type: "openApp" | "openUrl" | "openFile" | "setClipboard" | "runWorkflow" | "runShell" | "wait" | "notify" | "feature";
  params: Record<string, string>;
  label?: string;
}

export interface PlanItem {
  text: string;
  /** The step that carries out this item, once it exists. */
  stepId?: string;
}

export type TranscriptEntry =
  | { kind: "prompt"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "step"; id: string; step: AgentStep }
  | { kind: "plan"; id: string; title: string; items: PlanItem[] }
  | { kind: "summary"; id: string; text: string; undoable: number; saveable: boolean }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" | "warning" };

export type RunStatus = "running" | "confirming" | "done" | "error" | "cancelled";

export type AgentErrorKind = "no-key" | "auth" | "permission" | "rate-limit" | "overloaded" | "network" | "refusal" | "bad-request" | "limit" | "other";

export interface Confirmation {
  id: string;
  stepIds: string[];
}

export interface RunSnapshot {
  runId: string;
  /** The conversation this run belongs to (follow-ups share it). */
  conversationId?: string;
  prompt: string;
  status: RunStatus;
  entries: TranscriptEntry[];
  /** Set while the run waits for the user (status "confirming"). */
  confirmation?: Confirmation;
  toolCalls: number;
  maxToolCalls: number;
  model: string;
  readOnly?: boolean;
  error?: { message: string; kind: AgentErrorKind };
  startedAt: number;
  endedAt?: number;
}

export interface AgentSettings {
  [key: string]: unknown;
  /** Tool name -> run without asking. Only mutating tools are consulted. */
  allow: Record<string, boolean>;
  /** Only read-only tools are offered and run. */
  readOnly: boolean;
  /** Keep clipboard/selection text in saved conversations (off = redacted). */
  keepSensitive: boolean;
  /** ⌘⏎ in the launcher's root search sends the query to the agent. */
  launcherShortcut: boolean;
  /** Persist conversations so they can be searched and resumed. */
  saveHistory: boolean;
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
  /** Always asks, even when "allow without asking" would be on. */
  alwaysConfirm?: boolean;
  /** Rate-limited (kill a process, run a shortcut…). */
  destructive?: boolean;
  /** False when the feature it needs isn't installed. */
  available: boolean;
}

export interface StartResult {
  ok: boolean;
  conversationId?: string;
  error?: string;
  errorKind?: AgentErrorKind;
}

export interface AgentStatus {
  hasKey: boolean;
  mock: boolean;
  model: string;
  readOnly: boolean;
}

/** A conversation as the renderer sees it (API message history stays in main). */
export interface ConversationView {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  runs: RunSnapshot[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  runs: number;
  /** Last prompt, for the history list. */
  preview: string;
}

export interface UndoResult {
  ok: boolean;
  undone: number;
  failed: number;
  message: string;
}

export interface SaveWorkflowResult {
  ok: boolean;
  workflowId?: string;
  name?: string;
  actions?: number;
  error?: string;
  /** Steps that have no workflow equivalent. */
  unmapped?: string[];
}

/** Props of the "agent.run" launcher view. */
export interface AgentViewProps {
  prompt?: string;
  /** Re-attach to a run that is already in progress (after the launcher was hidden by a tool). */
  runId?: string;
  /** Resume a saved conversation. */
  conversationId?: string;
  /** Start a fresh conversation even if one is active. */
  fresh?: boolean;
}
