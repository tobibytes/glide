import { glide } from "../../lib/glide";
import type { CodesResult, OcrSettings, TextResult } from "../../../main/features/ocr/index";

export type { CodesResult, OcrSettings, TextResult };
export type OcrSettingsState = OcrSettings & { screenAccess: string; helper: boolean };

export const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("ocr", method, ...args);

export const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));

/** Prompt for the AI view; `language` defaults to English. */
export function translatePrompt(text: string, language: string): string {
  const lang = language.trim() || "English";
  return `Translate the following text into ${lang}. Reply with only the translation, keeping line breaks.\n\n${text}`;
}

/** Props arrive as JSON from main; anything malformed becomes an error view. */
export function readResult(p: Record<string, unknown>): TextResult | { kind: "permission" } | { kind: "error"; message: string; permissionHint: boolean } {
  if (p.kind === "permission") return { kind: "permission" };
  if (p.kind === "text" && typeof p.text === "string") {
    return {
      kind: "text",
      source: p.source === "clipboard" || p.source === "file" ? p.source : "screen",
      text: p.text,
      lines: Number(p.lines) || 0,
      words: Number(p.words) || 0,
      chars: Number(p.chars) || 0,
      links: Array.isArray(p.links) ? p.links.filter((l): l is string => typeof l === "string") : [],
      copied: p.copied === true,
      permissionHint: p.permissionHint === true,
    };
  }
  return { kind: "error", message: typeof p.message === "string" ? p.message : "Something went wrong", permissionHint: p.permissionHint === true };
}
