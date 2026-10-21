/** In-memory bookmark/history index and matcher (pure; no I/O). */
import { hostOf, type Entry } from "./data";

export interface IndexedEntry extends Entry {
  /** Profile key ("chrome:Profile 5"). */
  profile: string;
  browser: string;
  host: string;
  /** lowercased title */
  t: string;
  /** lowercased url without scheme / www */
  u: string;
}

export const stripUrl = (url: string) => url.toLowerCase().replace(/^[a-z]+:\/\/(www\.)?/, "");

export function indexEntries(entries: readonly Entry[], profile: string, browser: string): IndexedEntry[] {
  return entries.map((e) => ({ ...e, profile, browser, host: hostOf(e.url), t: e.title.toLowerCase(), u: stripUrl(e.url) }));
}

/** Same URL bookmarked twice (or visited in two profiles) shows once: first bookmark wins, history keeps the most visits. */
export function dedupe(list: readonly IndexedEntry[]): IndexedEntry[] {
  const byUrl = new Map<string, IndexedEntry>();
  for (const e of list) {
    const key = `${e.type}|${e.u.replace(/\/$/, "")}`;
    const cur = byUrl.get(key);
    if (!cur) byUrl.set(key, e);
    else if (e.type === "history") {
      const visits = (cur.visitCount ?? 0) + (e.visitCount ?? 0);
      const newer = (e.lastVisit ?? 0) > (cur.lastVisit ?? 0) ? e : cur;
      byUrl.set(key, { ...newer, visitCount: visits });
    }
  }
  return [...byUrl.values()];
}

const wordStart = (hay: string, needle: string) => {
  let i = hay.indexOf(needle);
  while (i >= 0) {
    if (i === 0 || !/[a-z0-9]/.test(hay[i - 1]!)) return true;
    i = hay.indexOf(needle, i + 1);
  }
  return false;
};

/** Score one entry; 0 means no match. Every query token must appear in the title or URL. */
export function scoreEntry(e: IndexedEntry, tokens: readonly string[], now = Date.now()): number {
  if (!tokens.length) return 0;
  let score = 0;
  for (const tok of tokens) {
    const inTitle = e.t.indexOf(tok);
    const inUrl = e.u.indexOf(tok);
    if (inTitle < 0 && inUrl < 0) return 0;
    if (inTitle === 0) score += 40;
    else if (inTitle > 0 && wordStart(e.t, tok)) score += 28;
    else if (inTitle > 0) score += 14;
    if (e.host.startsWith(tok)) score += 30;
    else if (inUrl >= 0 && inUrl < e.host.length) score += 18;
    else if (inUrl >= 0) score += 6;
  }
  if (e.type === "bookmark") score += 15;
  if (e.visitCount) score += Math.min(25, Math.log2(1 + e.visitCount) * 3);
  if (e.lastVisit) {
    const days = (now - e.lastVisit) / 86_400_000;
    score += days < 1 ? 12 : days < 7 ? 8 : days < 30 ? 4 : 0;
  }
  // Short titles that match fully read as exact hits.
  if (tokens.length === 1 && e.t === tokens[0]) score += 30;
  return score;
}

export const tokenize = (q: string) => q.toLowerCase().trim().split(/\s+/).filter(Boolean);

export function searchEntries(list: readonly IndexedEntry[], query: string, opts: { limit: number; type?: Entry["type"]; now?: number }): Array<{ e: IndexedEntry; score: number }> {
  const tokens = tokenize(query);
  const out: Array<{ e: IndexedEntry; score: number }> = [];
  if (!tokens.length) {
    // Empty query: recent history first, bookmarks in file order.
    const pool = opts.type ? list.filter((e) => e.type === opts.type) : list;
    const sorted = opts.type === "history" ? [...pool].sort((a, b) => (b.lastVisit ?? 0) - (a.lastVisit ?? 0)) : pool;
    return sorted.slice(0, opts.limit).map((e) => ({ e, score: 0 }));
  }
  for (const e of list) {
    if (opts.type && e.type !== opts.type) continue;
    const score = scoreEntry(e, tokens, opts.now);
    if (score > 0) out.push({ e, score });
  }
  out.sort((a, b) => b.score - a.score || a.e.t.length - b.e.t.length);
  return out.slice(0, opts.limit);
}

/** Root-search prefixes that switch to history: "history foo", "hist foo". */
export function parseHistoryPrefix(q: string): string | undefined {
  const m = /^\s*(?:history|hist)\s+(.*)$/i.exec(q);
  return m ? m[1]!.trim() : undefined;
}
