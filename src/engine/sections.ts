/**
 * Section assembly for the contract's SectionId set.
 *
 * Empty query:   favorites (favorite order) → suggestions (frecency > 1, `compareB4` order)
 * Searching:     calculator → results (mixed kinds) → files → fallbacks
 */
import type { ResultSection, ScoredItem, SearchItem } from "@shared/types";
import { foldText } from "./fuzzy";
import { compareB4, type Candidate, type Ranked } from "./rank";

export const SECTION_TITLES = {
  favorites: "Favorites",
  suggestions: "Suggestions",
  results: "Results",
  workflows: "Workflows",
  apps: "Applications",
  files: "Files",
  calculator: "Calculator",
  fallbacks: "Use with…",
} as const;

/** Kinds that never appear in Suggestions/Results (file results, only-fallback items). */
const NOT_SUGGESTED = new Set<SearchItem["kind"]>(["fallback", "calculator", "file"]);

export interface EmptyQueryInput {
  candidates: readonly Candidate[];
  favorites: ReadonlySet<string>;
  frecencyOf: (itemId: string) => number;
  sectionLimit: number;
}

const plain = (item: SearchItem, frecency: number): ScoredItem => ({
  item,
  score: frecency,
  matchScore: 0,
  matchKind: "none",
  frecency,
  ranges: [],
});

/**
 * Empty query:
 *  - `favorites`: user favorites in favorite order (Set insertion order).
 *    Not capped: it is
 *    a user-curated list.
 *  - `suggestions`: items with frecency > 1 that are not favorites and
 *    have no hotkey, ordered by `compareB4` (frecency desc → alias → kind → title), up
 *    to `sectionLimit`.
 */
export function buildEmptySections(input: EmptyQueryInput): ResultSection[] {
  const { candidates, favorites, frecencyOf, sectionLimit } = input;
  const sections: ResultSection[] = [];

  if (favorites.size) {
    const byId = new Map<string, Candidate>();
    for (const c of candidates) byId.set(c.item.id, c);
    const favs: ScoredItem[] = [];
    for (const id of favorites) {
      const c = byId.get(id);
      if (c) favs.push(plain(c.item, frecencyOf(id)));
    }
    if (favs.length) sections.push({ id: "favorites", title: SECTION_TITLES.favorites, items: favs });
  }

  const suggested: Ranked[] = [];
  for (const c of candidates) {
    if (NOT_SUGGESTED.has(c.item.kind) || favorites.has(c.item.id) || c.item.hotkey) continue;
    const frecency = frecencyOf(c.item.id);
    if (frecency <= 1) continue;
    suggested.push(rankedShell(c, frecency));
  }
  suggested.sort(compareB4);
  const items = suggested.slice(0, sectionLimit).map((r) => plain(r.candidate.item, r.frecency));
  if (items.length) sections.push({ id: "suggestions", title: SECTION_TITLES.suggestions, items });

  // GLIDE CHOICE: Glide's empty-query home lists the user's workflows, so a fresh
  // install never opens to a blank launcher.
  const shown = new Set<string>([...favorites, ...items.map((i) => i.item.id)]);
  const workflows: Ranked[] = [];
  for (const c of candidates) {
    if (c.item.kind !== "workflow" || shown.has(c.item.id)) continue;
    workflows.push(rankedShell(c, frecencyOf(c.item.id)));
  }
  workflows.sort(compareB4);
  const wfItems = workflows.slice(0, sectionLimit).map((r) => plain(r.candidate.item, r.frecency));
  if (wfItems.length) sections.push({ id: "workflows", title: SECTION_TITLES.workflows, items: wfItems });
  return sections;
}

function rankedShell(c: Candidate, frecency: number): Ranked {
  return {
    candidate: c,
    frecency,
    sortHeuristic: 0,
    ranking: {
      alias: "unmatched",
      titleMatch: "unmatched",
      title: null,
      titleScore: -Number.MAX_SAFE_INTEGER,
      subtitle: null,
      subtitleScore: -Number.MAX_SAFE_INTEGER,
      searchTerms: { kind: "unmatched" },
      keywordOnly: false,
      bypassed: true,
    },
  };
}

export interface SearchingInput {
  /** folded, trimmed query */
  foldedQuery: string;
  /** ranked results in final order (score already assigned) */
  results: ScoredItem[];
  calculator: ScoredItem[];
  files: ScoredItem[];
  fallbacks: ScoredItem[];
  sectionLimit: number;
  /** folded alias per item id (opts.aliases override item.alias) */
  aliasOf?: (itemId: string) => string;
}

/**
 * Searching order: calculator → results → files → fallbacks.
 *  - The calculator section is suppressed when any Results item's title or
 *    alias starts with the query.
 *  - `results` is capped at sectionLimit·2 (GLIDE CHOICE), `files` and
 *    `fallbacks` at sectionLimit, calculator uncapped (one or two rows).
 */
export function buildSearchSections(input: SearchingInput): ResultSection[] {
  const { foldedQuery, results, calculator, files, fallbacks, sectionLimit, aliasOf } = input;
  const sections: ResultSection[] = [];

  if (calculator.length && !suppressesCalculator(results, foldedQuery, aliasOf)) {
    sections.push({ id: "calculator", title: SECTION_TITLES.calculator, items: calculator });
  }
  if (results.length) {
    sections.push({ id: "results", title: SECTION_TITLES.results, items: results.slice(0, sectionLimit * 2) });
  }
  if (files.length) {
    sections.push({ id: "files", title: SECTION_TITLES.files, items: files.slice(0, sectionLimit) });
  }
  if (fallbacks.length) {
    sections.push({ id: "fallbacks", title: SECTION_TITLES.fallbacks, items: fallbacks.slice(0, sectionLimit) });
  }
  return sections;
}

/** Any visible result whose title or alias starts with the term hides the calculator. */
export function suppressesCalculator(
  results: readonly ScoredItem[],
  foldedQuery: string,
  aliasOf?: (itemId: string) => string,
): boolean {
  if (!foldedQuery) return false;
  for (const r of results) {
    if (foldText(r.item.title).startsWith(foldedQuery)) return true;
    const alias = aliasOf ? aliasOf(r.item.id) : r.item.alias ? foldText(r.item.alias) : "";
    if (alias && alias.startsWith(foldedQuery)) return true;
  }
  return false;
}
