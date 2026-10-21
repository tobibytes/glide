/** Snippet rendering: placeholders, nested snippets, rich text and the {cursor} position (pure). */
import type { Snippet } from "@shared/types";
import { parseTemplate, renderTokens, type RenderEnv } from "../quicklinks/placeholders";

/** Private-use char: never typed by people, survives rendering, removed before output. */
const CURSOR = "";

export interface RenderedSnippet {
  text: string;
  /** HTML body for rich-text snippets (pasted alongside the plain text). */
  html?: string;
  /** Number of ← presses after pasting to land where {cursor} was (0 = leave the caret at the end). */
  cursorLeft: number;
}

/** Find a snippet by name (case-insensitive) or keyword, for {snippet name="…"}. */
export function snippetLookup(snippets: Snippet[]): (name: string) => string | undefined {
  return (name) => {
    const n = name.trim().toLowerCase();
    const hit = snippets.find((s) => s.name.trim().toLowerCase() === n) ?? snippets.find((s) => s.keyword?.trim().toLowerCase() === n);
    return hit?.text;
  };
}

const graphemes = (() => {
  const seg = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  return (s: string): number => (seg ? [...seg.segment(s)].length : [...s].length);
})();

/**
 * ← presses that move the caret from the end of `textAfterCursor` back to its start.
 * One press per grapheme (emoji with modifiers, flags and é are one step); "\r\n" is one step.
 */
export function cursorLeftCount(textAfterCursor: string): number {
  return graphemes(textAfterCursor.replace(/\r\n/g, "\n"));
}

/** Split rendered text at the first cursor marker; later markers are dropped. */
export function placeCursor(rendered: string): { text: string; cursorLeft: number } {
  const i = rendered.indexOf(CURSOR);
  if (i < 0) return { text: rendered, cursorLeft: 0 };
  const before = rendered.slice(0, i);
  const after = rendered.slice(i + 1).split(CURSOR).join("");
  return { text: before + after, cursorLeft: cursorLeftCount(after) };
}

export function renderSnippet(snippet: Pick<Snippet, "text" | "html">, env: RenderEnv): RenderedSnippet {
  const { text, cursorLeft } = placeCursor(renderTokens(parseTemplate(snippet.text), env, { cursorMarker: CURSOR }));
  if (!snippet.html?.trim()) return { text, cursorLeft };
  const html = renderTokens(parseTemplate(snippet.html), env, { html: true, cursorMarker: "" });
  return { text, html, cursorLeft };
}

// ---------------------------------------------------------------------------
// HTML helpers (rich-text snippets)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain-text rendition of a small HTML fragment (for the text fallback and previews). */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove scripts, event handlers and javascript: URLs before showing or pasting user HTML. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed)[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*("|')?/gi, '$1="#"');
}
