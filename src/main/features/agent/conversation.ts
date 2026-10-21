/**
 * The API message history of a conversation: appending a follow-up prompt, repairing the tail after
 * a cancelled/failed run, trimming old turns and redacting clipboard/selection content for disk.
 */
import type { MessageParam } from "./client";
import { REDACTED, type SensitivityInfo } from "./safety";

export const MAX_HISTORY_MESSAGES = 60;

type Block = Exclude<MessageParam["content"], string>[number];

const blocks = (m: MessageParam): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);

/** Adds the user's next request. Consecutive user messages are merged so roles keep alternating. */
export function appendPrompt(history: MessageParam[], prompt: string): MessageParam[] {
  const out = [...history];
  const last = out[out.length - 1];
  if (last && last.role === "user") out[out.length - 1] = { role: "user", content: [...blocks(last), { type: "text", text: prompt }] };
  else out.push({ role: "user", content: prompt });
  return out;
}

/**
 * Makes a history safe to continue: an assistant turn whose tool calls never got results (the run
 * was stopped) gets "not run" results, so the next request is valid.
 */
export function repairTail(history: MessageParam[]): MessageParam[] {
  const out = [...history];
  const last = out[out.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return out;
  const uses = last.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
  if (!uses.length) return out;
  out.push({ role: "user", content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: "Not run: the request was stopped.", is_error: true })) });
  return out;
}

const isPlainPrompt = (m: MessageParam) => m.role === "user" && (typeof m.content === "string" || m.content.every((b) => b.type === "text"));

/** Keeps the newest messages, cutting only at the start of a user request (never inside a tool exchange). */
export function trimHistory(history: MessageParam[], max = MAX_HISTORY_MESSAGES): MessageParam[] {
  if (history.length <= max) return history;
  for (let i = history.length - max; i < history.length; i++) if (isPlainPrompt(history[i]!)) return history.slice(i);
  // One enormous request: keep it whole rather than corrupt it.
  for (let i = history.length - 1; i >= 0; i--) if (isPlainPrompt(history[i]!)) return history.slice(i);
  return history;
}

/**
 * For disk: drop thinking blocks (only the latest turn's are ever replayed) and replace the
 * results/arguments of clipboard and selection tools.
 */
export function redactMessages(history: MessageParam[], info: SensitivityInfo, keepSensitive: boolean): MessageParam[] {
  const toolOf = new Map<string, string>();
  const out: MessageParam[] = [];
  for (const m of history) {
    if (typeof m.content === "string") {
      out.push({ ...m });
      continue;
    }
    const content: Block[] = [];
    for (const b of m.content) {
      if (b.type === "thinking" || b.type === "redacted_thinking") continue;
      if (b.type === "tool_use") {
        toolOf.set(b.id, b.name);
        const keys = keepSensitive ? undefined : info.sensitiveArgs.get(b.name);
        if (keys && b.input && typeof b.input === "object") {
          const input = { ...(b.input as Record<string, unknown>) };
          for (const k of keys) if (typeof input[k] === "string") input[k] = REDACTED;
          content.push({ ...b, input });
        } else content.push({ ...b });
        continue;
      }
      if (b.type === "tool_result" && !keepSensitive && info.sensitiveResult.has(toolOf.get(b.tool_use_id) ?? "") && !b.is_error) {
        content.push({ ...b, content: REDACTED });
        continue;
      }
      content.push({ ...b });
    }
    // An assistant turn that only had thinking would be empty; keep the role alternation valid.
    out.push({ ...m, content: content.length ? content : [{ type: "text", text: "…" }] } as MessageParam);
  }
  return out;
}

export function titleFor(prompt: string): string {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length > 70 ? `${t.slice(0, 69)}…` : t || "Untitled";
}
