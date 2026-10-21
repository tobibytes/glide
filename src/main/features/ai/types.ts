/**
 * Types shared by the AI feature's main process and renderer (type-only imports on the renderer side).
 * Nothing here may reference the API key.
 */

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** unix ms */
  at?: number;
  /** model that produced an assistant message */
  model?: string;
}

export interface Chat {
  id: string;
  title: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

export type Effort = "low" | "medium" | "high";

export interface AiCommandDef {
  id: string;
  name: string;
  /** emoji */
  icon: string;
  /** Uses {selection} and optionally {argument}. */
  prompt: string;
  /** Model id override; empty = the default model. */
  model?: string;
  /** Asks for an argument in the launcher (Tab), e.g. a target language. */
  acceptsArgument?: boolean;
  argumentPlaceholder?: string;
  /** Result is meant to replace the selected text (offer "Replace Selection"). */
  replaces?: boolean;
  builtin?: boolean;
}

export interface AiSettings {
  [key: string]: unknown;
  model: string;
  effort: Effort;
  customCommands: AiCommandDef[];
}

export interface ModelInfo {
  id: string;
  label: string;
  description: string;
}

export interface AskRequest {
  requestId: string;
  messages: ChatMessage[];
  system?: string;
  model?: string;
}

export interface AskStart {
  ok: boolean;
  error?: string;
  errorKind?: AiErrorKind;
}

export type AiErrorKind = "no-key" | "auth" | "permission" | "rate-limit" | "overloaded" | "network" | "refusal" | "bad-request" | "other";

export interface DeltaEvent {
  requestId: string;
  text: string;
}

export interface DoneEvent {
  requestId: string;
  text: string;
  model: string;
  stopReason: string | null;
  cancelled?: boolean;
}

export interface ErrorEvent {
  requestId: string;
  message: string;
  kind: AiErrorKind;
}

export interface KeyStatus {
  hasKey: boolean;
  /** false when the OS keychain-backed encryption is unavailable (key cannot be stored). */
  encryptionAvailable: boolean;
}

export interface TestResult {
  ok: boolean;
  message: string;
  kind?: AiErrorKind;
}

/** Props accepted by the "ai.chat" launcher view. */
export interface QuickAiProps {
  prompt?: string;
  /** Title shown above the answer (AI command name). */
  title?: string;
  model?: string;
  /** Offer "Replace Selection" (⏎ with an empty field). */
  replaces?: boolean;
  /** Shown as a note, e.g. "No selection found — used clipboard text". */
  notice?: string;
}
