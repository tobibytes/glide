/**
 * Raycast's "future date" frecency (research/01-backend-ranking.md §1.3, §1.4).
 *
 * The native addon stores no score: `frecency.root_search(item_id, frecency_date REAL,
 * search_terms, opened_at)`. The score is a function of the stored date:
 *
 *   decode(date) = max(1, 2^((date − now) / halfLife))
 *   visit(date)  = now + halfLife · log2( max(1, decode(max(date, now))) + 100 )
 *
 * i.e. every launch adds +100 to the decayed score, which then halves every
 * `halfLife` (10 days by default). A never-visited item has score 1.
 *
 * The JS side (`PJi`) caches `{score, sampledAtMs}` and keeps decaying it with
 * `score · 2^(−Δms / 864e6)`, floored at 1.
 */
import type { UsageRecord } from "@shared/types";
import { foldText } from "./fuzzy";

export const DAY_SEC = 86_400;
export const DEFAULT_HALF_LIFE_DAYS = 10;
export const DEFAULT_HALF_LIFE_SEC = DEFAULT_HALF_LIFE_DAYS * DAY_SEC; // 864,000 s
/** Visit bonus: `s' = max(1, s) + 100` (constant 100.0 at 0x49d6cc). */
export const VISIT_BONUS = 100;
/** fXi = 1,468,800,000 ms = 17 days: stored search terms only count while opened within this window. */
export const SEARCH_TERM_WINDOW_MS = 17 * DAY_SEC * 1000;
/** mXi = 1: stored search terms only count while frecency > 1. */
export const SEARCH_TERM_MIN_FRECENCY = 1;
/** AYi = 3: distinct stored search terms kept per item. */
export const MAX_SEARCH_TERMS = 3;
/** Bounded launch ring kept in UsageRecord.launches. */
export const LAUNCH_RING = 10;
/** exp overflow guard from the disassembly (709.78 ≈ ln(DBL_MAX)); we clamp the exponent in log2 units. */
const MAX_LOG2 = 709.78 / Math.LN2;

/** Score from an encoded date. `frecencyDate` NaN/undefined ⇒ never visited ⇒ 1. */
export function decode(frecencyDate: number | undefined, nowSec: number, halfLifeSec = DEFAULT_HALF_LIFE_SEC): number {
  if (frecencyDate === undefined || Number.isNaN(frecencyDate)) return 1;
  const exponent = Math.min((frecencyDate - nowSec) / halfLifeSec, MAX_LOG2);
  return Math.max(1, Math.pow(2, exponent));
}

/** New encoded date after a launch at `nowSec` (NaN-safe like the native helper at 0x49d644). */
export function visit(frecencyDate: number | undefined, nowSec: number, halfLifeSec = DEFAULT_HALF_LIFE_SEC): number {
  const base = frecencyDate === undefined || Number.isNaN(frecencyDate) ? nowSec : Math.max(frecencyDate, nowSec);
  const decayed = decode(base, nowSec, halfLifeSec); // ≥ 1 since base ≥ now
  const next = decayed + VISIT_BONUS;
  return nowSec + halfLifeSec * Math.log2(next);
}

/** Encode a plain score as a date (`now + halfLife·log2(max(1, score))`, the 0x74fbd0 encoder). */
export function encode(score: number, nowSec: number, halfLifeSec = DEFAULT_HALF_LIFE_SEC): number {
  return nowSec + halfLifeSec * Math.log2(Math.max(1, score));
}

/** JS-side cache decay (`PJi.decayedScore`): `max(1, score · 2^(−Δms/halfLifeMs))`. */
export function decayScore(score: number, sampledAtMs: number, nowMs: number, halfLifeMs = DEFAULT_HALF_LIFE_SEC * 1000): number {
  const delta = nowMs - sampledAtMs;
  if (delta <= 0) return score;
  return Math.max(1, score * Math.pow(2, -delta / halfLifeMs));
}

// ---------------------------------------------------------------------------
// Mapping onto the contract's UsageRecord
// ---------------------------------------------------------------------------

/**
 * `UsageRecord` as persisted by Glide. `searchTerms` is an additive, optional
 * property (newest first, folded, ≤ MAX_SEARCH_TERMS) that survives JSON
 * persistence because main stores the record object as-is.
 */
export interface UsageRecordWithTerms extends UsageRecord {
  searchTerms?: string[];
}

/**
 * GLIDE CHOICE: the contract has no `frecencyDate` field, so the encoded date is
 * RECOMPUTED from the record by folding `visit()` over the recorded launches
 * (oldest first). Launches that fell out of the bounded ring (`count −
 * launches.length`) are approximated as having happened at the oldest recorded
 * launch timestamp (an upper bound on their true contribution: each adds +100
 * at that moment and decays from there). With an empty ring but a positive
 * count, `lastLaunchedAt` is used as that timestamp.
 */
export function frecencyDateFromRecord(record: UsageRecord, halfLifeSec = DEFAULT_HALF_LIFE_SEC): number | undefined {
  const launches = [...record.launches].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const count = Math.max(0, Math.floor(record.count));
  if (launches.length === 0 && count > 0 && Number.isFinite(record.lastLaunchedAt)) launches.push(record.lastLaunchedAt);
  if (launches.length === 0) return undefined;
  let date: number | undefined;
  const overflow = Math.max(0, count - launches.length);
  const oldestSec = launches[0] / 1000;
  for (let i = 0; i < overflow; i++) date = visit(date, oldestSec, halfLifeSec);
  for (const t of launches) date = visit(date, t / 1000, halfLifeSec);
  return date;
}

export interface FrecencyEntry {
  frecencyDate: number;
  /** decoded score at `sampledAtMs` */
  score: number;
  sampledAtMs: number;
  openedAtMs: number;
  /** newest first, folded */
  searchTerms: string[];
}

/** Per-item frecency state derived from usage records; decays on read. */
export class FrecencyCache {
  private entries = new Map<string, FrecencyEntry>();
  private halfLifeSec: number;

  constructor(halfLifeSec = DEFAULT_HALF_LIFE_SEC) {
    this.halfLifeSec = halfLifeSec;
  }

  get halfLife(): number {
    return this.halfLifeSec;
  }

  /** Rebuild from records (also used when the half-life changes). */
  load(records: UsageRecord[], nowMs: number, halfLifeSec = this.halfLifeSec): void {
    this.halfLifeSec = halfLifeSec;
    this.entries.clear();
    for (const r of records) {
      const date = frecencyDateFromRecord(r, halfLifeSec);
      if (date === undefined) continue;
      this.entries.set(r.itemId, {
        frecencyDate: date,
        score: decode(date, nowMs / 1000, halfLifeSec),
        sampledAtMs: nowMs,
        openedAtMs: r.lastLaunchedAt,
        searchTerms: normalizeTerms((r as UsageRecordWithTerms).searchTerms ?? []),
      });
    }
  }

  /** Decayed score at `nowMs`; 1 when never visited. */
  score(itemId: string, nowMs: number): number {
    const e = this.entries.get(itemId);
    if (!e) return 1;
    return decayScore(e.score, e.sampledAtMs, nowMs, this.halfLifeSec * 1000);
  }

  get(itemId: string): FrecencyEntry | undefined {
    return this.entries.get(itemId);
  }

  /** Record a visit; returns the updated record for persistence. */
  recordVisit(prev: UsageRecord | undefined, itemId: string, nowMs: number, searchTerm?: string): UsageRecordWithTerms {
    const launches = [...(prev?.launches ?? []), nowMs].slice(-LAUNCH_RING);
    const record: UsageRecordWithTerms = {
      itemId,
      launches,
      count: (prev?.count ?? 0) + 1,
      lastLaunchedAt: nowMs,
    };
    const prevTerms = this.entries.get(itemId)?.searchTerms ?? normalizeTerms((prev as UsageRecordWithTerms | undefined)?.searchTerms ?? []);
    const folded = searchTerm ? foldText(searchTerm.trim()) : "";
    const terms = normalizeTerms(folded ? [folded, ...prevTerms] : prevTerms);
    if (terms.length) record.searchTerms = terms;

    const existing = this.entries.get(itemId);
    const nowSec = nowMs / 1000;
    const date = visit(existing?.frecencyDate, nowSec, this.halfLifeSec);
    this.entries.set(itemId, {
      frecencyDate: date,
      score: decode(date, nowSec, this.halfLifeSec),
      sampledAtMs: nowMs,
      openedAtMs: nowMs,
      searchTerms: terms,
    });
    return record;
  }

  /** YYi: stored search terms only apply while frecency > 1 and opened within 17 days. */
  termsEligible(itemId: string, nowMs: number): string[] {
    const e = this.entries.get(itemId);
    if (!e || e.searchTerms.length === 0) return [];
    if (this.score(itemId, nowMs) <= SEARCH_TERM_MIN_FRECENCY) return [];
    if (nowMs - e.openedAtMs > SEARCH_TERM_WINDOW_MS) return [];
    return e.searchTerms;
  }
}

/** EYi: newest → oldest, folded, de-duplicated, at most 3. */
export function normalizeTerms(terms: string[]): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    const t = foldText(String(raw).trim());
    if (!t || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_SEARCH_TERMS) break;
  }
  return out;
}

export type SearchTermMatch = { kind: "exact" } | { kind: "prefix" } | { kind: "overbounds"; count: number } | { kind: "unmatched" };

/** pXi = 3: overbounds only when the user typed 1..3 extra chars beyond the stored term. */
export const OVERBOUNDS_MAX_EXTRA = 3;

/**
 * Y7e(term, query): 'exact' when equal, 'prefix' when the stored term is longer and
 * starts with the query, 'overbounds' when the query extends the stored term by
 * 1..3 chars (count = term length). Returns the best over all eligible terms:
 * exact > prefix > overbounds (longest count).
 */
export function matchSearchTerms(terms: readonly string[], foldedQuery: string): SearchTermMatch {
  let best: SearchTermMatch = { kind: "unmatched" };
  for (const term of terms) {
    if (term === foldedQuery) return { kind: "exact" };
    if (term.length > foldedQuery.length && term.startsWith(foldedQuery)) {
      if (best.kind !== "prefix") best = { kind: "prefix" };
      continue;
    }
    if (foldedQuery.startsWith(term)) {
      const extra = foldedQuery.length - term.length;
      if (extra >= 1 && extra <= OVERBOUNDS_MAX_EXTRA) {
        if (best.kind === "unmatched" || (best.kind === "overbounds" && best.count < term.length)) {
          best = { kind: "overbounds", count: term.length };
        }
      }
    }
  }
  return best;
}

export function searchTermRank(m: SearchTermMatch): number {
  switch (m.kind) {
    case "exact":
      return 3;
    case "prefix":
      return 2;
    case "overbounds":
      return 1;
    default:
      return 0;
  }
}
