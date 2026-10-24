/**
 * Public API of the pure search engine (no Electron, no Node-only APIs so it
 * can run in main, in tests, and in the renderer if ever needed).
 * Implemented in ./index.ts by the engine session.
 */
import type { SearchItem, SearchResponse, UsageRecord, ScoredItem } from "@shared/types";

export interface EngineOptions {
  /** half-life for usage decay in days (default 10) */
  frecencyHalfLifeDays?: number;
  /** max items per section (default 8) */
  sectionLimit?: number;
  /** item ids the user marked as favorites */
  favorites?: Set<string>;
  /** item id -> alias (overrides item.alias) */
  aliases?: Record<string, string>;
  /** clock for tests */
  now?: () => number;
}

export interface SearchEngine {
  /** Replace the full item catalogue (called when sources refresh). */
  setItems(items: SearchItem[]): void;
  /** Replace usage data (called at startup and after recordUsage). */
  setUsage(records: UsageRecord[]): void;
  /** Update runtime options (favorites, aliases, limits). */
  configure(opts: Partial<EngineOptions>): void;
  /** Rank items for a query. Empty query returns favorites + suggestions by frecency. */
  search(query: string, extra?: { dynamicItems?: ScoredItem[] }): SearchResponse;
  /**
   * Record a launch and return the updated record (caller persists it).
   * `searchTerm` (optional, additive) is the query typed when the item was
   * launched; the engine remembers the last 3 per item and boosts the item
   * when the same term is typed again ("search terms" memory).
   */
  recordUsage(itemId: string, searchTerm?: string): UsageRecord;
  /** Current usage snapshot. */
  getUsage(): UsageRecord[];
}

export type CreateEngine = (opts?: EngineOptions) => SearchEngine;
