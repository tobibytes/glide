/**
 * Glide search engine — a pure TypeScript port of Raycast 2.8.2's root-search
 * ranking (research/01-backend-ranking.md). See README.md in this folder for
 * the rule → report-section mapping and the list of GLIDE CHOICE deviations.
 */
import type { ScoredItem, SearchItem, SearchResponse, UsageRecord } from "@shared/types";
import type { CreateEngine, EngineOptions, SearchEngine } from "./api";
import { DAY_SEC, DEFAULT_HALF_LIFE_DAYS, FrecencyCache } from "./frecency";
import { exactOrPrefix, foldText, prepareQuery, type PreparedQuery, type Sensitivity } from "./fuzzy";
import {
  buildCandidate,
  bypassRanking,
  compareB4,
  compareRanked,
  computeFlags,
  evaluate,
  toScoredItem,
  type Candidate,
  type Ranked,
} from "./rank";
import { buildEmptySections, buildSearchSections } from "./sections";

export type { EngineOptions, SearchEngine } from "./api";
export * from "./fuzzy";
export * from "./frecency";
export * from "./rank";
export * from "./sections";

/** Raycast's default `rootSearchSensitivity` for new installs. Not user-configurable in Glide (api.ts is frozen). */
export const DEFAULT_SENSITIVITY: Sensitivity = "high";
export const DEFAULT_SECTION_LIMIT = 8;

/** Kinds that are never ranked in Results (they have their own sections or come from dynamic providers). */
const NOT_RANKED = new Set<SearchItem["kind"]>(["fallback", "calculator"]);

const clock = (): number => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

export const createEngine: CreateEngine = (initial: EngineOptions = {}): SearchEngine => {
  let opts: EngineOptions = { sectionLimit: DEFAULT_SECTION_LIMIT, frecencyHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...initial };
  let items: SearchItem[] = [];
  let candidates: Candidate[] = [];
  let candidateById = new Map<string, Candidate>();
  let usage = new Map<string, UsageRecord>();
  const frecency = new FrecencyCache(halfLifeSec());

  function now(): number {
    return opts.now ? opts.now() : Date.now();
  }
  function halfLifeSec(): number {
    const days = opts.frecencyHalfLifeDays;
    return (days && days > 0 ? days : DEFAULT_HALF_LIFE_DAYS) * DAY_SEC;
  }
  function sectionLimit(): number {
    const n = opts.sectionLimit;
    return n && n > 0 ? Math.floor(n) : DEFAULT_SECTION_LIMIT;
  }
  function rebuildCandidates(): void {
    candidates = items.map((item) => buildCandidate(item, opts.aliases?.[item.id]));
    candidateById = new Map(candidates.map((c) => [c.item.id, c]));
  }
  function reloadFrecency(): void {
    frecency.load([...usage.values()], now(), halfLifeSec());
  }

  function evalContext(itemId: string, nowMs: number, sortHeuristic = 0) {
    return {
      sensitivity: DEFAULT_SENSITIVITY,
      frecency: frecency.score(itemId, nowMs),
      searchTerms: frecency.termsEligible(itemId, nowMs),
      sortHeuristic,
    };
  }

  /**
   * GLIDE CHOICE (Raycast does this in the frontend, which is out of scope):
   * "g electron" → if the text before the first space fully identifies an
   * `acceptsArgument` item (alias exact, title exact or title prefix), that
   * item is pinned first with `argument` = the remainder.
   */
  function extractArgument(rawQuery: string, nowMs: number): { candidate: Candidate; argument: string } | undefined {
    const space = rawQuery.search(/\s/);
    if (space <= 0) return undefined;
    const head = foldText(rawQuery.slice(0, space));
    const argument = rawQuery.slice(space + 1).trimStart();
    if (!argument) return undefined;
    // Typing a multi-word title ("two args" for "Two Args") is not head + argument.
    const whole = foldText(rawQuery.trim());
    let best: { candidate: Candidate; rank: number; frecency: number } | undefined;
    for (const c of candidates) {
      if (!c.item.acceptsArgument || NOT_RANKED.has(c.item.kind)) continue;
      let rank = 0;
      if (c.alias && c.alias === head) rank = 3;
      else {
        const t = exactOrPrefix(c.title.folded, head);
        rank = t === "exact" ? 2 : t === "prefix" ? 1 : 0;
        if (rank > 0 && c.title.folded.startsWith(whole)) rank = 0;
      }
      if (rank === 0) continue;
      const f = frecency.score(c.item.id, nowMs);
      if (!best || rank > best.rank || (rank === best.rank && f > best.frecency)) best = { candidate: c, rank, frecency: f };
    }
    return best ? { candidate: best.candidate, argument } : undefined;
  }

  function rankQuery(pq: PreparedQuery, rawQuery: string, dynamic: ScoredItem[], nowMs: number): ScoredItem[] {
    const ranked: Ranked[] = [];
    const bypass: Ranked[] = [];
    const arg = extractArgument(rawQuery, nowMs);

    for (const c of candidates) {
      if (NOT_RANKED.has(c.item.kind)) continue;
      if (arg && c === arg.candidate) continue; // pinned separately
      const r = evaluate(c, pq, evalContext(c.item.id, nowMs));
      if (r) ranked.push(r);
    }
    // Dynamic items of other kinds: ranked normally when they match, otherwise
    // appended in B4 order like Raycast's `matching: 'always'` rows. Their
    // provider score only acts as the sortHeuristic (higher first).
    for (const d of dynamic) {
      const c = buildCandidate(d.item, opts.aliases?.[d.item.id]);
      const ctx = evalContext(d.item.id, nowMs, -d.score);
      const r = evaluate(c, pq, ctx);
      if (r) ranked.push(r);
      else bypass.push(bypassRanking(c, ctx));
    }

    const flags = computeFlags(ranked, pq.folded.length);
    ranked.sort((a, b) => compareRanked(flags, a, b));
    bypass.sort(compareB4);

    const ordered: Array<{ r: Ranked; argument?: string }> = [];
    if (arg) {
      const r = evaluate(arg.candidate, prepareQuery(rawQuery.slice(0, rawQuery.search(/\s/))), evalContext(arg.candidate.item.id, nowMs));
      ordered.push({ r: r ?? bypassRanking(arg.candidate, evalContext(arg.candidate.item.id, nowMs)), argument: arg.argument });
    }
    for (const r of ranked) ordered.push({ r });
    for (const r of bypass) ordered.push({ r });

    // `score` is the ordering value the contract asks for: strictly decreasing
    // with position (the real order is lexicographic across tiers, not a sum).
    const total = ordered.length;
    return ordered.map(({ r, argument }, i) => toScoredItem(r, total - i, pq.folded.length, argument));
  }

  const engine: SearchEngine = {
    setItems(next) {
      items = next.slice();
      rebuildCandidates();
    },

    setUsage(records) {
      usage = new Map(records.map((r) => [r.itemId, r]));
      reloadFrecency();
    },

    configure(patch) {
      const prev = opts;
      opts = { ...opts, ...patch };
      if (patch.aliases !== undefined && patch.aliases !== prev.aliases) rebuildCandidates();
      if (patch.frecencyHalfLifeDays !== undefined && patch.frecencyHalfLifeDays !== prev.frecencyHalfLifeDays) reloadFrecency();
    },

    search(query, extra) {
      const started = clock();
      const nowMs = now();
      const dynamic = extra?.dynamicItems ?? [];
      const raw = (query ?? "").normalize("NFC").trimStart();
      const trimmed = raw.trim();
      const limit = sectionLimit();

      if (!trimmed) {
        const sections = buildEmptySections({
          candidates,
          favorites: opts.favorites ?? new Set<string>(),
          frecencyOf: (id) => frecency.score(id, nowMs),
          sectionLimit: limit,
        });
        return { query, sections, total: candidates.length, tookMs: clock() - started };
      }

      const pq = prepareQuery(trimmed);
      const calculator = dynamic.filter((d) => d.item.kind === "calculator");
      const files = dynamic
        .filter((d) => d.item.kind === "file")
        .sort((a, b) => b.score - a.score);
      const other = dynamic.filter((d) => d.item.kind !== "calculator" && d.item.kind !== "file");

      const results = rankQuery(pq, raw, other, nowMs);
      const fallbacks: ScoredItem[] = [];
      for (const c of candidates) {
        if (c.item.kind !== "fallback") continue;
        fallbacks.push({ item: c.item, score: 0, matchScore: 0, matchKind: "none", frecency: frecency.score(c.item.id, nowMs), ranges: [], argument: trimmed });
      }

      const sections = buildSearchSections({
        foldedQuery: pq.folded,
        results,
        calculator,
        files,
        fallbacks,
        sectionLimit: limit,
        aliasOf: (id) => candidateById.get(id)?.alias ?? "",
      });
      return { query, sections, total: candidates.length + dynamic.length, tookMs: clock() - started };
    },

    recordUsage(itemId, searchTerm) {
      const record = frecency.recordVisit(usage.get(itemId), itemId, now(), searchTerm);
      usage.set(itemId, record);
      return record;
    },

    getUsage() {
      return [...usage.values()];
    },
  };

  return engine;
};

export default createEngine;
