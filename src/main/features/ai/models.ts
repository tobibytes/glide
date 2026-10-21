import type { ModelInfo } from "./types";

/** Model ids from the claude-api skill (cached 2026-09-25). Exact ids, no date suffixes. */
export const DEFAULT_MODEL = "claude-opus-5-5";

export const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", description: "Default — the current Opus" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", description: "Faster and cheaper" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", description: "Fastest, lowest cost" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", description: "Most capable — slower, premium price" },
];

export function isKnownModel(id: unknown): id is string {
  return typeof id === "string" && MODELS.some((m) => m.id === id);
}

/** Models that take `output_config.effort` (Haiku 4.5 rejects it). */
export function supportsEffort(model: string): boolean {
  return model !== "claude-haiku-4-5";
}

/** Models for which the skill recommends server-side refusal fallbacks (`fallbacks: "default"`). */
export function supportsDefaultFallback(model: string): boolean {
  return model === "claude-opus-5-5" || model === "claude-sonnet-5-5" || model === "claude-fable-5-1";
}
