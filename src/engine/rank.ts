/**
 * Per-candidate match evaluation, title boosting (whole-word floor), and the
 * tiered comparators `compareB4` / `compareRanked`, for Glide's item kinds.
 */
import type { ItemKind, MatchKind, MatchRange, ScoredItem, SearchItem } from "@shared/types";
import {
  EXACT_SCORE,
  UNMATCHED_SCORE,
  containsWholeWord,
  exactOrPrefix,
  foldText,
  fuzzyMatch,
  passesSensitivity,
  prepareText,
  wholeWordApplies,
  wholeWordFloor,
  type FuzzyResult,
  type PreparedQuery,
  type PreparedText,
  type Sensitivity,
} from "./fuzzy";
import { matchSearchTerms, searchTermRank, type SearchTermMatch } from "./frecency";

// ---------------------------------------------------------------------------
// Candidates (precomputed once per setItems)
// ---------------------------------------------------------------------------

/**
 * Kind priority: app 5, workflow 5 (treated like an app, it is the user's own
 * command), system 4, command 4, quicklink 3, snippet 3, setting 1, file 1,
 * calculator 0 (never ranked), fallback last.
 */
export const KIND_PRIORITY: Record<ItemKind, number> = {
  app: 5,
  workflow: 5,
  system: 4,
  command: 4, // feature and extension commands
  quicklink: 3,
  snippet: 3,
  setting: 1,
  file: 1,
  calculator: 0,
  fallback: -1,
};

export interface Candidate {
  item: SearchItem;
  title: PreparedText;
  /** Only when the subtitle exists and differs from the title. */
  subtitle?: PreparedText;
  /** definition keywords + synthesized "title subtitle" / "subtitle title". */
  keywords: PreparedText[];
  /** folded alias (opts.aliases override item.alias) */
  alias: string;
  priority: number;
}

export function buildCandidate(item: SearchItem, aliasOverride?: string): Candidate {
  const title = prepareText(item.title ?? "");
  const subtitleRaw = item.subtitle?.trim() ?? "";
  const subtitle = subtitleRaw && foldText(subtitleRaw) !== title.folded ? prepareText(subtitleRaw) : undefined;
  const keywords: PreparedText[] = [];
  for (const k of item.keywords ?? []) if (k && k.trim()) keywords.push(prepareText(k.trim()));
  if (subtitle) {
    keywords.push(prepareText(`${item.title} ${subtitleRaw}`));
    keywords.push(prepareText(`${subtitleRaw} ${item.title}`));
  }
  const alias = foldText((aliasOverride ?? item.alias ?? "").trim());
  return { item, title, subtitle, keywords, alias, priority: KIND_PRIORITY[item.kind] ?? 0 };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type AliasMatch = "exact" | "prefix" | "unmatched";

export interface Ranking {
  alias: AliasMatch;
  /** exact | prefix (startsWith) | unmatched */
  titleMatch: AliasMatch;
  title: FuzzyResult | null;
  /** title score with the whole-word floor applied */
  titleScore: number;
  subtitle: FuzzyResult | null;
  subtitleScore: number;
  searchTerms: SearchTermMatch;
  /** title/subtitle failed the gate but a keyword passed */
  keywordOnly: boolean;
  /** true when the candidate bypassed matching (dynamic "always" items) */
  bypassed: boolean;
}

export interface Ranked {
  candidate: Candidate;
  ranking: Ranking;
  frecency: number;
  /** provider-supplied secondary order (lower first), e.g. dynamic item score negated */
  sortHeuristic: number;
}

export interface EvalContext {
  sensitivity: Sensitivity;
  /** decoded frecency for the item (1 when never used) */
  frecency: number;
  /** eligible stored search terms (already gated by frecency>1 and the 17-day window) */
  searchTerms: readonly string[];
  sortHeuristic?: number;
}

const scoreOf = (m: FuzzyResult | null): number => (m === null ? UNMATCHED_SCORE : m.score);

const gate = (m: FuzzyResult | null, len: number, s: Sensitivity): boolean =>
  m !== null && passesSensitivity(m.score, len, m.skipped, s);

/**
 * Evaluate one candidate against the prepared query.
 * Returns null when the candidate is not eligible (`isMatching === false`).
 */
export function evaluate(c: Candidate, q: PreparedQuery, ctx: EvalContext): Ranked | null {
  const len = q.folded.length;
  const alias: AliasMatch = c.alias ? exactOrPrefix(c.alias, q.folded) : "unmatched";

  const title = fuzzyMatch(c.title, q);
  const titleMatch: AliasMatch = title?.exact ? "exact" : exactOrPrefix(c.title.folded, q.folded) === "prefix" ? "prefix" : "unmatched";
  let titleScore = scoreOf(title);
  if (title && !title.exact && wholeWordApplies(q.folded) && containsWholeWord(c.title, q.folded)) {
    titleScore = Math.max(titleScore, wholeWordFloor(len));
  }

  const subtitle = c.subtitle ? fuzzyMatch(c.subtitle, q) : null;
  const subtitleScore = scoreOf(subtitle);

  const searchTerms = ctx.searchTerms.length ? matchSearchTerms(ctx.searchTerms, q.folded) : { kind: "unmatched" as const };

  const titleOk = titleMatch !== "unmatched" || gate(title, len, ctx.sensitivity);
  const subtitleOk = gate(subtitle, len, ctx.sensitivity);
  let keywordOnly = false;
  let matching = titleOk || subtitleOk;
  if (!matching) {
    for (const k of c.keywords) {
      if (gate(fuzzyMatch(k, q), len, ctx.sensitivity)) {
        matching = true;
        keywordOnly = true;
        break;
      }
    }
  }
  // GLIDE CHOICE: an alias exact/prefix hit makes the item eligible, so the
  // engine surfaces alias hits itself. Ordering is unchanged (T1 / T8).
  if (!matching && alias !== "unmatched") matching = true;
  if (!matching) return null;

  return {
    candidate: c,
    ranking: { alias, titleMatch, title, titleScore, subtitle, subtitleScore, searchTerms, keywordOnly, bypassed: false },
    frecency: ctx.frecency,
    sortHeuristic: ctx.sortHeuristic ?? 0,
  };
}

/** Ranking for items that bypass matching (`matching: 'always'`). */
export function bypassRanking(c: Candidate, ctx: EvalContext): Ranked {
  return {
    candidate: c,
    ranking: {
      alias: "unmatched",
      titleMatch: "unmatched",
      title: null,
      titleScore: UNMATCHED_SCORE,
      subtitle: null,
      subtitleScore: UNMATCHED_SCORE,
      searchTerms: { kind: "unmatched" },
      keywordOnly: false,
      bypassed: true,
    },
    frecency: ctx.frecency,
    sortHeuristic: ctx.sortHeuristic ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const compareTitles = (a: string, b: string): number => collator.compare(a, b);

/**
 * Empty-query order and final tiebreak.
 *  1. frecency desc  2. has alias first  3. kind priority desc
 *  4. sortHeuristic asc  5. title collation
 */
export function compareB4(a: Ranked, b: Ranked): number {
  if (a.frecency !== b.frecency) return b.frecency - a.frecency;
  const aa = a.candidate.alias ? 1 : 0;
  const ba = b.candidate.alias ? 1 : 0;
  if (aa !== ba) return ba - aa;
  if (a.candidate.priority !== b.candidate.priority) return b.candidate.priority - a.candidate.priority;
  if (a.sortHeuristic !== b.sortHeuristic) return a.sortHeuristic - b.sortHeuristic;
  return compareTitles(a.candidate.item.title, b.candidate.item.title);
}

export interface ListFlags {
  /** any candidate has an exact title match (only tracked for queries ≥3 chars) */
  hasExactTitle: boolean;
  /** any candidate has an exact stored search term */
  hasExactSearchTerm: boolean;
}

const isExactTerm = (r: Ranking): boolean => r.searchTerms.kind === "exact";
const isPrefixTerm = (r: Ranking): boolean => r.searchTerms.kind === "prefix";
const overCount = (r: Ranking): number => (r.searchTerms.kind === "overbounds" ? r.searchTerms.count : 0);

function compareSearchTermRank(a: Ranking, b: Ranking): number {
  const ra = searchTermRank(a.searchTerms);
  const rb = searchTermRank(b.searchTerms);
  if (ra !== rb) return rb - ra;
  if (a.searchTerms.kind === "overbounds" && b.searchTerms.kind === "overbounds") return b.searchTerms.count - a.searchTerms.count;
  return 0;
}

/**
 * The non-empty-query order.
 * Returns < 0 when `a` ranks first. Tiers T1–T16; Glide has no
 * boosted built-in commands (T3) nor contacts (T4), so those tiers are omitted.
 */
export function compareRanked(flags: ListFlags, a: Ranked, b: Ranked): number {
  const ra = a.ranking;
  const rb = b.ranking;

  // T1 alias exact wins outright
  if (rb.alias === "exact" && ra.alias !== "exact") return 1;
  if (ra.alias === "exact" && rb.alias !== "exact") return -1;
  if (ra.alias === "exact" && rb.alias === "exact") {
    if (a.frecency !== b.frecency) return b.frecency - a.frecency;
  }

  // T2 only when the list has both an exact title and an exact stored term
  if (flags.hasExactTitle && flags.hasExactSearchTerm) {
    const ea = isExactTerm(ra);
    const eb = isExactTerm(rb);
    if (ea !== eb) return ea ? -1 : 1;
    if (ea && eb && a.frecency !== b.frecency) return b.frecency - a.frecency;
  }

  // T5 exact title
  if (flags.hasExactTitle) {
    const ea = ra.titleMatch === "exact";
    const eb = rb.titleMatch === "exact";
    if (ea && eb) {
      const st = compareSearchTermRank(ra, rb);
      if (st !== 0) return st;
      if (a.frecency !== b.frecency) return b.frecency - a.frecency;
      return compareB4(a, b);
    }
    if (ea !== eb) return ea ? -1 : 1;
  }

  // T6 stored search term exact
  {
    const ea = isExactTerm(ra);
    const eb = isExactTerm(rb);
    if (ea && eb) {
      if (a.frecency !== b.frecency) return b.frecency - a.frecency;
      return compareB4(a, b);
    }
    if (ea !== eb) return ea ? -1 : 1;
  }

  // T7 subtitle exact
  {
    const ea = ra.subtitle?.exact === true;
    const eb = rb.subtitle?.exact === true;
    if (ea && eb) {
      if (a.frecency !== b.frecency) return b.frecency - a.frecency;
      if (ra.titleScore !== rb.titleScore) return rb.titleScore - ra.titleScore;
      return compareB4(a, b);
    }
    if (ea !== eb) return ea ? -1 : 1;
  }

  // T8 alias prefix
  {
    const pa = ra.alias === "prefix";
    const pb = rb.alias === "prefix";
    if (pa !== pb) return pa ? -1 : 1;
  }

  // T9 / T10 stored search term prefix & overbounds
  {
    const pa = isPrefixTerm(ra);
    const pb = isPrefixTerm(rb);
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb && a.frecency !== b.frecency) return b.frecency - a.frecency;
    const oa = overCount(ra);
    const ob = overCount(rb);
    if (oa > 0 && ob > 0) {
      if ((oa >= 3 || ob >= 3) && oa !== ob) return ob - oa;
    } else if (oa >= 3) return -1;
    else if (ob >= 3) return 1;
  }

  // T11 max(title, subtitle) desc
  const ma = Math.max(ra.titleScore, ra.subtitleScore);
  const mb = Math.max(rb.titleScore, rb.subtitleScore);
  if (ma !== mb) return mb - ma;

  // T12 frecency desc
  if (a.frecency !== b.frecency) return b.frecency - a.frecency;

  // T13 title score desc
  if (ra.titleScore !== rb.titleScore) return rb.titleScore - ra.titleScore;

  // T14 kind priority desc
  if (a.candidate.priority !== b.candidate.priority) return b.candidate.priority - a.candidate.priority;

  // T15 sortHeuristic asc
  if (a.sortHeuristic !== b.sortHeuristic) return a.sortHeuristic - b.sortHeuristic;

  // T16 title collation
  return compareTitles(a.candidate.item.title, b.candidate.item.title);
}

export function computeFlags(list: readonly Ranked[], queryLen: number): ListFlags {
  let hasExactTitle = false;
  let hasExactSearchTerm = false;
  for (const r of list) {
    if (queryLen >= 3 && r.ranking.titleMatch === "exact") hasExactTitle = true;
    if (r.ranking.searchTerms.kind === "exact") hasExactSearchTerm = true;
  }
  return { hasExactTitle, hasExactSearchTerm };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Derive the contract's MatchKind from a ranking (presentation only; never used for ordering). */
export function matchKindOf(r: Ranking, titleLen: number): MatchKind {
  if (r.alias === "exact") return "alias";
  if (r.titleMatch === "exact") return "exact";
  if (r.titleMatch === "prefix") return "prefix";
  if (r.bypassed) return "none";
  if (r.keywordOnly) return "keyword";
  const t = r.title;
  if (!t || t.ranges.length === 0) return r.subtitle ? "fuzzy" : "none";
  if (t.ranges.length === 1 && t.ranges[0].start > 0 && titleLen > 0) {
    // one contiguous run starting at a word boundary
    return "word-prefix";
  }
  const matched = t.ranges.reduce((n, g) => n + (g.end - g.start), 0);
  if (t.ranges.length === matched && matched > 1) return "acronym";
  return "fuzzy";
}

/**
 * Build the contract's ScoredItem. `score` is the caller-assigned ordering
 * value (see index.ts); `queryLen` lets prefix matches highlight the typed
 * prefix (folding is index-preserving, so folded length == title units).
 */
export function toScoredItem(r: Ranked, score: number, queryLen: number, argument?: string): ScoredItem {
  const { ranking } = r;
  const titleLen = r.candidate.item.title.length;
  const ranges: MatchRange[] =
    ranking.titleMatch === "exact"
      ? [{ start: 0, end: titleLen }]
      : ranking.titleMatch === "prefix"
        ? [{ start: 0, end: Math.min(titleLen, queryLen) }]
        : (ranking.title?.ranges ?? []);
  const matchScore = ranking.titleMatch === "exact" ? EXACT_SCORE : Math.max(ranking.titleScore, ranking.subtitleScore);
  const out: ScoredItem = {
    item: r.candidate.item,
    score,
    matchScore: matchScore <= UNMATCHED_SCORE ? 0 : matchScore,
    matchKind: matchKindOf(ranking, titleLen),
    frecency: r.frecency,
    ranges: ranges.filter((g) => g.end > g.start),
  };
  if (argument !== undefined) out.argument = argument;
  return out;
}
