/**
 * Programmatic search over the launcher's catalogue (FeatureContext.search / findItem).
 * Pure: the host injects `run` (the exact code path behind IPC.SEARCH_QUERY: catalogue +
 * calculator + files + feature dynamic items, ranked by the engine with frecency) and `find`
 * (catalogue lookup by id). Results come back in launcher order (section by section).
 */
import type { ItemKind, ScoredItem, SearchItem, SearchResponse, SectionId } from "./types";
import type { Suggestion } from "./did-you-mean";

export interface SearchOptions {
  /** Max results (default 20). */
  limit?: number;
  /** Only these kinds. */
  kinds?: ItemKind[];
  /** Only items owned by this feature id. */
  feature?: string;
  /** Include "Use with…" fallback rows (default false: they match every query). */
  includeFallbacks?: boolean;
  /** Only these sections. */
  sections?: SectionId[];
}

export interface RunOptions {
  /** Raise the per-section cap for this search (never below the user's Settings.sectionLimit). */
  sectionLimit?: number;
}

export interface SearchProvider {
  run(query: string, opts?: RunOptions): Promise<SearchResponse>;
  find(id: string): SearchItem | undefined;
  /** "Did you mean" for a query without results (engine only, no dynamic sources). */
  suggest?(query: string): Suggestion | null;
}

export interface SearchApi {
  search(query: string, opts?: SearchOptions): Promise<ScoredItem[]>;
  sections(query: string, opts?: RunOptions): Promise<SearchResponse>;
  suggest(query: string): Suggestion | null;
  /** Catalogue item by id; also resolves dynamic items (calculator, files, conversions) returned by a recent search. */
  findItem(id: string): SearchItem | undefined;
}

const DEFAULT_LIMIT = 20;
const RECENT_DYNAMIC_MAX = 200;

export function flattenResponse(res: SearchResponse, opts: SearchOptions = {}): ScoredItem[] {
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
  const sections = opts.sections?.length ? new Set(opts.sections) : null;
  const seen = new Set<string>();
  const out: ScoredItem[] = [];
  for (const section of res.sections) {
    if (sections && !sections.has(section.id)) continue;
    if (section.id === "fallbacks" && !opts.includeFallbacks && !sections) continue;
    for (const s of section.items) {
      if (seen.has(s.item.id)) continue; // favorites can repeat an item from results
      if (kinds && !kinds.has(s.item.kind)) continue;
      if (opts.feature && s.item.feature !== opts.feature) continue;
      if (!opts.includeFallbacks && s.item.kind === "fallback") continue;
      seen.add(s.item.id);
      out.push(s);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function createSearchApi(provider: () => SearchProvider | null): SearchApi {
  // Dynamic items only exist in search responses; keep recent ones so findItem(id) can resolve them.
  const recent = new Map<string, SearchItem>();
  const remember = (res: SearchResponse) => {
    for (const s of res.sections)
      for (const it of s.items) {
        recent.delete(it.item.id);
        recent.set(it.item.id, it.item);
      }
    while (recent.size > RECENT_DYNAMIC_MAX) recent.delete(recent.keys().next().value as string);
  };
  const sections = async (query: string, opts?: RunOptions): Promise<SearchResponse> => {
    const p = provider();
    if (!p) return { query, sections: [], total: 0, tookMs: 0 };
    const res = await p.run(query, opts);
    remember(res);
    return res;
  };
  return {
    sections,
    search: async (query, opts) => flattenResponse(await sections(query, { sectionLimit: opts?.limit }), opts),
    findItem: (id) => provider()?.find(id) ?? recent.get(id),
    suggest: (query) => provider()?.suggest?.(query) ?? null,
  };
}
