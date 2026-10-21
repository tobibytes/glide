/**
 * Which keywords the keyboard tap watches and what each one types (pure).
 *
 * - keyword prefix: with prefix ";" the snippet keyword "sig" expands only after ";sig", so typing
 *   "design" no longer turns into "de" + signature.
 * - case-adaptive: "Sig" → capitalised expansion, "SIG" → upper-case expansion.
 * - per-app exclusions: snippets excluded for the frontmost app are left out of the list.
 * - placeholders are rendered when the list is built; the snippets feature rebuilds it after every
 *   expansion and on a short timer while dynamic snippets exist (see CONTRACT-REQUESTS.md for the
 *   helper change that would render at expansion time and place the {cursor}).
 */
import type { Snippet } from "@shared/types";
import type { RenderEnv } from "../quicklinks/placeholders";
import { isDynamic } from "../quicklinks/placeholders";
import { htmlToText, renderSnippet, snippetLookup } from "./render";

export interface SnippetSettings extends Record<string, unknown> {
  /** Characters every keyword must be typed with, e.g. ";" or "!". "" = none. */
  keywordPrefix: string;
  /** "Sig"/"SIG" expand with matching capitalisation. */
  caseAdaptive: boolean;
  /** Bundle ids where no snippet expands (in addition to per-snippet exclusions). */
  excludedApps: string[];
}

export const SNIPPET_DEFAULTS: SnippetSettings = { keywordPrefix: "", caseAdaptive: false, excludedApps: [] };

export function sanitizeSnippetSettings(raw: Record<string, unknown> | undefined): SnippetSettings {
  const r = raw ?? {};
  const prefix = typeof r.keywordPrefix === "string" ? r.keywordPrefix.replace(/\s/g, "").slice(0, 4) : "";
  return {
    keywordPrefix: prefix,
    caseAdaptive: r.caseAdaptive === true,
    excludedApps: Array.isArray(r.excludedApps) ? r.excludedApps.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [],
  };
}

/** The keyword as it must be typed. A keyword that already starts with the prefix is left alone. */
export function effectiveKeyword(keyword: string, prefix: string): string {
  const k = keyword.trim();
  if (!k || !prefix) return k;
  return k.startsWith(prefix) ? k : prefix + k;
}

const hasLetters = (s: string) => /\p{L}/u.test(s);
const capitalize = (s: string) => s.replace(/\p{L}/u, (c) => c.toUpperCase());

/** Capitalise the first letter of the text (skipping leading punctuation/space). */
export function capitalizeText(text: string): string {
  return capitalize(text);
}

export interface CaseVariant {
  keyword: string;
  text: string;
}

/** Keyword variants for case-adaptive expansion: as-is, Capitalised and UPPER (only distinct ones). */
export function caseVariants(keyword: string, text: string): CaseVariant[] {
  const out: CaseVariant[] = [{ keyword, text }];
  if (!hasLetters(keyword)) return out;
  const lower = keyword.toLowerCase();
  if (keyword !== lower) return out; // the user typed a deliberate mixed-case keyword: keep it exact
  const cap = capitalize(keyword);
  const upper = keyword.toUpperCase();
  if (cap !== keyword) out.push({ keyword: cap, text: capitalize(text) });
  if (upper !== keyword && upper !== cap) out.push({ keyword: upper, text: text.toUpperCase() });
  return out;
}

/** Whether a snippet expands in the app with this bundle id. */
export function expandsIn(snippet: Pick<Snippet, "excludedApps">, settings: SnippetSettings, bundleId: string | null | undefined): boolean {
  if (!bundleId) return true;
  const b = bundleId.toLowerCase();
  if (settings.excludedApps.some((x) => x.toLowerCase() === b)) return false;
  return !(snippet.excludedApps ?? []).some((x) => x.toLowerCase() === b);
}

/**
 * Warn about keywords that fire inside ordinary words: letters-only and no prefix ("sig" in "design").
 * Returns a human-readable warning or null.
 */
export function keywordWarning(keyword: string, prefix: string): string | null {
  const k = effectiveKeyword(keyword, prefix);
  if (!k) return null;
  if (/^[\p{L}\p{N}]+$/u.test(k)) return `“${k}” is plain letters, so it also expands when those letters appear inside a longer word. Add a prefix such as “;” here or in Snippet settings.`;
  return null;
}

export interface ExpansionEntry {
  keyword: string;
  text: string;
  snippetId: string;
}

export interface ExpansionInput {
  snippets: Snippet[];
  settings: SnippetSettings;
  env: RenderEnv;
  /** Bundle id of the app keystrokes go to (null = unknown: nothing is excluded). */
  frontmostBundleId?: string | null;
}

/** Entries for the keyboard tap, longest keyword first; duplicate keywords keep the first snippet. */
export function buildExpansionList(input: ExpansionInput): ExpansionEntry[] {
  const { snippets, settings, env } = input;
  const lookup = snippetLookup(snippets);
  const fullEnv: RenderEnv = { ...env, snippet: env.snippet ?? lookup };
  const seen = new Set<string>();
  const out: ExpansionEntry[] = [];
  for (const s of snippets) {
    const raw = s.keyword?.trim();
    if (!raw || (!s.text && !s.html)) continue;
    if (!expandsIn(s, settings, input.frontmostBundleId)) continue;
    const keyword = effectiveKeyword(raw, settings.keywordPrefix);
    const body = s.text || htmlToText(s.html ?? "");
    const { text } = renderSnippet({ text: body }, fullEnv);
    if (!text) continue;
    const variants = settings.caseAdaptive ? caseVariants(keyword, text) : [{ keyword, text }];
    for (const v of variants) {
      if (seen.has(v.keyword)) continue;
      seen.add(v.keyword);
      out.push({ ...v, snippetId: s.id });
    }
  }
  return out.sort((a, b) => b.keyword.length - a.keyword.length);
}

/** True when the expansion list must be rebuilt over time (dates, clipboard, uuid…). */
export function needsRefresh(snippets: Snippet[]): boolean {
  return snippets.some((s) => !!s.keyword?.trim() && isDynamic(s.text || s.html || ""));
}

/** True when any snippet (or the global setting) excludes apps, so the frontmost app must be tracked. */
export function needsFrontmost(snippets: Snippet[], settings: SnippetSettings): boolean {
  return settings.excludedApps.length > 0 || snippets.some((s) => !!s.keyword?.trim() && (s.excludedApps?.length ?? 0) > 0);
}

/**
 * Full expansion plan for one typed keyword (used once the helper asks main at expansion time):
 * how many characters to delete, what to paste and how many ← presses place the caret at {cursor}.
 */
export function expansionPlan(typedKeyword: string, snippet: Snippet, snippets: Snippet[], settings: SnippetSettings, env: RenderEnv): { deleteCount: number; text: string; html?: string; cursorLeft: number } {
  const rendered = renderSnippet(snippet, { ...env, snippet: env.snippet ?? snippetLookup(snippets) });
  let text = rendered.text;
  if (settings.caseAdaptive && typedKeyword !== typedKeyword.toLowerCase()) {
    text = typedKeyword === typedKeyword.toUpperCase() && typedKeyword.length > 1 ? text.toUpperCase() : capitalize(text);
  }
  return { deleteCount: [...typedKeyword].length, text, ...(rendered.html ? { html: rendered.html } : {}), cursorLeft: rendered.cursorLeft };
}
