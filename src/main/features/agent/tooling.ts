/**
 * Tool plumbing shared by every agent tool: the definition shape (schema, validation, plain-English
 * summary, run, optional undo), safety metadata and the argument helpers.
 */
import type { WorkflowStep } from "./types";

export type { WorkflowStep } from "./types";

// A type alias (not an interface) so it is assignable to the SDK's index-signature InputSchema.
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

/** How to put back what a step changed. Lives in memory only (never persisted). */
export interface Undo {
  summary: string;
  run(): Promise<string>;
}

export interface ToolOutput {
  text: string;
  undo?: Undo;
  /** Workflow equivalent of what this call did (Save as Workflow). */
  workflow?: WorkflowStep | WorkflowStep[];
}


export interface ToolMeta {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
  /** Ask every time, even if "allow without asking" is on (kill a process, run a shortcut). */
  alwaysConfirm?: boolean;
  /** Counted by the destructive-tool rate limit. */
  destructive?: boolean;
  /** Results are clipboard/selection content (redacted in saved history). */
  sensitiveResult?: boolean;
  /** Argument keys holding clipboard-like content (redacted in saved history). */
  sensitiveArgs?: string[];
  /** Feature id this tool needs; the tool is hidden when that feature isn't installed. */
  requires?: string;
}

interface ToolDef<A, C> extends ToolMeta {
  schema: JsonSchema;
  /** Returns the parsed arguments, or an error message for Claude. */
  parse(input: Record<string, unknown>): A | string;
  describe(args: A, caps: C): string | Promise<string>;
  run(args: A, caps: C): Promise<string | ToolOutput>;
}

export interface PreparedCall {
  describe(): Promise<string>;
  run(): Promise<ToolOutput>;
}

export interface AgentToolOf<C> extends ToolMeta {
  schema: JsonSchema;
  prepare(input: unknown, caps: C): PreparedCall | { error: string };
}

/** Thrown by a tool's run() to produce an is_error tool result. */
export class ToolFailure extends Error {}

export function defineTool<C>() {
  return <A>(t: ToolDef<A, C>): AgentToolOf<C> => {
    const { parse, describe, run, ...meta } = t;
    return {
      ...meta,
      prepare(input, caps) {
        if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Tool input must be a JSON object" };
        const parsed = parse(input as Record<string, unknown>);
        if (typeof parsed === "string") return { error: parsed };
        return {
          describe: async () => describe(parsed, caps),
          run: async () => {
            const out = await run(parsed, caps);
            return typeof out === "string" ? { text: out } : out;
          },
        };
      },
    };
  };
}

// --- argument helpers ----------------------------------------------------------

const MAX_RESULT = 6000;

export function clip(text: string, max = MAX_RESULT): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} characters]` : text;
}

export function str(input: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined | { error: string } {
  const v = input[key];
  if (v === undefined || v === null || v === "") return opts.required ? { error: `"${key}" is required` } : undefined;
  if (typeof v !== "string") return { error: `"${key}" must be a string` };
  if (opts.max && v.length > opts.max) return { error: `"${key}" is too long (max ${opts.max} characters)` };
  return v;
}

/** A required string argument, or the error message. */
export function reqStr(input: Record<string, unknown>, key: string, max: number): { value: string } | { error: string } {
  const v = str(input, key, { required: true, max });
  if (isErr(v)) return v;
  if (v === undefined || !v.trim()) return { error: `"${key}" is required` };
  return { value: v };
}

export function intArg(input: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : def;
}

export const isErr = (v: unknown): v is { error: string } => typeof v === "object" && v !== null && "error" in v;
export const quote = (s: string) => `“${s.length > 80 ? `${s.slice(0, 80)}…` : s}”`;

export interface OpResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export function opText(r: OpResult, fallback: string): string {
  if (!r.ok) throw new ToolFailure(r.error || "Failed");
  return r.message || fallback;
}

/** Normalises another feature's method result (ExecuteResult, boolean or anything). */
export function asOp(r: unknown, fallback = "Done"): OpResult {
  const e = r as Partial<{ ok: boolean; message: string; error: string }> | null | undefined;
  if (!e || typeof e !== "object") return { ok: r !== false, message: fallback };
  return { ok: e.ok !== false, message: typeof e.message === "string" ? e.message : fallback, error: typeof e.error === "string" ? e.error : undefined };
}

/** The agent's own workflow action: run any catalogue item (see index.ts workflowActions). */
export const RUN_ITEM_ACTION = "runItem";

export function runItemStep(itemId: string, argument?: string, label?: string): WorkflowStep {
  return { type: "feature", params: { feature: "agent", action: RUN_ITEM_ACTION, item: itemId, argument: argument ?? "" }, ...(label ? { label } : {}) };
}

export function featureStep(feature: string, action: string, params: Record<string, string>, label?: string): WorkflowStep {
  return { type: "feature", params: { feature, action, ...params }, ...(label ? { label } : {}) };
}
