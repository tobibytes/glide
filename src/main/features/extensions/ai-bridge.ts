/**
 * Raycast AI.ask / useAI → Glide's AI feature. Reads the AI feature's encrypted API key through its
 * KeyStore (main process only; the key never reaches the extension process) and streams the answer
 * with its client. Tests inject a fake asker instead of calling the API.
 */
import { KeyStore, type Cipher } from "../ai/keystore";
import { isAbort, streamAnswer, describeError } from "../ai/client";
import { DEFAULT_MODEL, isKnownModel } from "../ai/models";
import type { Effort } from "../ai/types";

export interface AiAskRequest {
  prompt: string;
  /** Raycast AI.Model name (e.g. "Anthropic_Claude_Sonnet") or a Claude model id. */
  model?: string | null;
  creativity?: string | null;
  signal: AbortSignal;
  onText(delta: string): void;
}

export interface AiAsker {
  /** environment.canAccess(AI) */
  available(): boolean;
  ask(req: AiAskRequest): Promise<string>;
}

/** Raycast model names → Claude models Glide can use; anything else uses the AI feature's model. */
export function mapModel(name: string | null | undefined, fallback: string): string {
  if (name && isKnownModel(name)) return name;
  const n = (name ?? "").toLowerCase();
  if (n.includes("haiku")) return "claude-haiku-4-5";
  if (n.includes("sonnet")) return "claude-sonnet-5-5";
  if (n.includes("opus")) return "claude-opus-5-5";
  return isKnownModel(fallback) ? fallback : DEFAULT_MODEL;
}

/**
 * Extensions get no Glide system prompt beyond the AI client's; Raycast's "creativity" has no direct
 * Claude parameter here, so it only nudges the instructions.
 */
function creativityNote(c: string | null | undefined): string | undefined {
  if (c === "none" || c === "low") return "Answer precisely and deterministically; do not embellish.";
  if (c === "high" || c === "maximum") return "Be creative and original.";
  return undefined;
}

export function createAiAsker(opts: { aiDataDir: () => string; cipher: Cipher; settings: () => { model?: unknown; effort?: unknown } }): AiAsker {
  const keys = new KeyStore(opts.aiDataDir, opts.cipher);
  return {
    available: () => keys.status().hasKey,
    async ask(req) {
      const apiKey = keys.read();
      if (!apiKey) throw new Error("Glide AI is not set up: add an Anthropic API key in Settings → AI");
      const s = opts.settings();
      const effort: Effort = s.effort === "low" || s.effort === "high" ? s.effort : "medium";
      try {
        const out = await streamAnswer(
          { apiKey, model: mapModel(req.model, typeof s.model === "string" ? s.model : DEFAULT_MODEL), effort, system: creativityNote(req.creativity), messages: [{ role: "user", content: req.prompt }], signal: req.signal },
          { onText: req.onText },
        );
        return out.text;
      } catch (err) {
        if (isAbort(err)) throw new Error("Aborted");
        throw new Error(describeError(err).message);
      }
    },
  };
}

/** Deterministic stand-in used by headless tests (GLIDE_EXT_FAKE_AI=1): never touches the network. */
export function createFakeAsker(): AiAsker {
  return {
    available: () => true,
    async ask(req) {
      const answer = `Fake AI answer to: ${req.prompt}`;
      const parts = answer.match(/.{1,8}/g) ?? [answer];
      for (const p of parts) {
        if (req.signal.aborted) throw new Error("Aborted");
        req.onText(p);
        await new Promise((r) => setTimeout(r, 5));
      }
      return answer;
    },
  };
}
