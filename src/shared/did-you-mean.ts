/**
 * "Did you mean …" for typo'd queries. Cheap: only runs when the query has no strong match (nothing,
 * or only loose fuzzy/keyword hits), and only tries single-character deletions and adjacent
 * transpositions (≤ 2·L engine searches); a variant must produce a strong (prefix-like) match,
 * e.g. "sfaari" → "safari", "saffari" → "safari".
 */
import type { ScoredItem, SearchResponse } from "./types";

export interface Suggestion {
  /** the corrected query */
  query: string;
  items: ScoredItem[];
}

const MIN_LEN = 3;
const MAX_LEN = 32;
const MAX_ITEMS = 3;
const IGNORED_SECTIONS = new Set(["fallbacks"]);
const WEAK = new Set(["fuzzy", "keyword", "none"]);

/** True when the response has no result that matches the query better than loosely. */
export function isWeak(res: SearchResponse): boolean {
  const top = realResults(res).find((i) => i.item.kind !== "calculator" && i.item.kind !== "file");
  return !top || WEAK.has(top.matchKind);
}

/** Real (non-fallback) results of a response, in order. */
export function realResults(res: SearchResponse): ScoredItem[] {
  return res.sections.filter((s) => !IGNORED_SECTIONS.has(s.id)).flatMap((s) => s.items.filter((i) => i.item.kind !== "fallback"));
}

export function typoVariants(query: string): string[] {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < q.length; i++) {
    const del = q.slice(0, i) + q.slice(i + 1);
    if (del.trim().length >= MIN_LEN - 1) out.add(del);
    if (i < q.length - 1 && q[i] !== q[i + 1]) out.add(q.slice(0, i) + q[i + 1] + q[i] + q.slice(i + 2));
  }
  out.delete(q);
  return [...out];
}

export function didYouMean(query: string, search: (q: string) => SearchResponse): Suggestion | null {
  const q = query.trim();
  if (q.length < MIN_LEN || q.length > MAX_LEN || /^[\d\s.+\-*/()=%^]+$/.test(q)) return null;
  if (!isWeak(search(q))) return null;
  let best: { query: string; items: ScoredItem[]; score: number } | null = null;
  for (const v of typoVariants(q)) {
    const items = realResults(search(v)).filter((i) => !WEAK.has(i.matchKind));
    if (!items.length) continue;
    const score = items[0].matchScore;
    if (!best || score > best.score) best = { query: v, items: items.slice(0, MAX_ITEMS), score };
  }
  return best ? { query: best.query, items: best.items } : null;
}
