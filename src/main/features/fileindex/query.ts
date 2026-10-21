/**
 * Query execution. Candidates = entries whose name tokens prefix-match every
 * query token (a token may instead match an ancestor folder name, at lower
 * weight). A cheap pre-score picks the best few hundred, which are then scored
 * with the engine's fuzzyMatch plus recency / depth / exact-name boosts.
 */
import path from "node:path";
import type { MatchRange } from "@shared/types";
import { foldText, fuzzyMatch } from "@engine/fuzzy";
import type { FileIndexDb } from "./db";
import { classify, FILTER_KINDS, matchesKind, type FileKind, type FilterKind } from "./kinds";
import { queryTokens } from "./tokenize";

export interface ParsedQuery {
  raw: string;
  /** Free text without filters (quotes removed). */
  text: string;
  tokens: string[];
  phrases: string[];
  kinds: FilterKind[];
  inPaths: string[];
}

export interface SearchOptions {
  limit?: number;
  now?: number;
  /** entry id → last time it was opened from Glide (ms) */
  opened?: Map<number, number>;
}

export interface FileHit {
  id: number;
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  kind: FileKind;
  score: number;
  ranges: MatchRange[];
  openedAt?: number;
}

const MAX_TOKENS = 8;
const PRESELECT = 300;
const DAY = 86_400_000;
const RECENT_WINDOW = 7 * DAY;

export function parseQuery(raw: string, home: string): ParsedQuery {
  const kinds: FilterKind[] = [];
  const inPaths: string[] = [];
  const phrases: string[] = [];
  let rest = raw.replace(/(?:^|\s)kind:(\S+)/gi, (_m, v: string) => {
    for (const k of v.toLowerCase().split(/[|,]/)) {
      const norm = k === "folders" || k === "dir" || k === "directory" ? "folder" : k === "images" ? "image" : k === "apps" ? "app" : k === "docs" || k === "document" ? "doc" : k;
      if ((FILTER_KINDS as readonly string[]).includes(norm) && !kinds.includes(norm as FilterKind)) kinds.push(norm as FilterKind);
    }
    return " ";
  });
  rest = rest.replace(/(?:^|\s)in:(?:"([^"]+)"|(\S+))/gi, (_m, q: string | undefined, v: string | undefined) => {
    let p = (q ?? v ?? "").trim();
    if (p === "~") p = home;
    else if (p.startsWith("~/")) p = path.join(home, p.slice(2));
    if (p) inPaths.push(p.length > 1 ? p.replace(/\/+$/, "") : p);
    return " ";
  });
  rest = rest.replace(/"([^"]*)"?/g, (_m, phrase: string) => {
    const f = foldText(phrase.trim());
    if (f) phrases.push(f);
    return ` ${phrase} `;
  });
  const text = rest.replace(/\s+/g, " ").trim();
  return { raw, text, tokens: queryTokens(text).slice(0, MAX_TOKENS), phrases, kinds, inPaths };
}

function popcount(n: number): number {
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

function recencyBoost(db: FileIndexDb, id: number, now: number, opened?: Map<number, number>): number {
  let boost = 0;
  const o = opened?.get(id);
  if (o !== undefined && now - o < RECENT_WINDOW) boost += 60 * (1 - (now - o) / RECENT_WINDOW);
  const m = db.mtime[id];
  if (now - m < RECENT_WINDOW) boost += 40 * (1 - Math.max(0, now - m) / RECENT_WINDOW);
  const a = db.atime[id];
  if (a > m && now - a < RECENT_WINDOW) boost += 10 * (1 - (now - a) / RECENT_WINDOW); // weak proxy for "last used"
  return boost;
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

interface Candidate {
  id: number;
  cheap: number;
  nameMask: number;
  depth: number;
}

export function search(db: FileIndexDb, q: ParsedQuery, opts: SearchOptions = {}): FileHit[] {
  const limit = opts.limit ?? 20;
  const now = opts.now ?? Date.now();
  const opened = opts.opened;
  const n = db.count;

  // Resolve in: filters to entry ids where possible (cheap ancestor checks).
  const inIds: number[] = [];
  const inStrings: string[] = [];
  for (const p of q.inPaths) {
    const id = db.findPath(p);
    if (id >= 0) inIds.push(id);
    else inStrings.push(p);
  }
  const passesFilters = (id: number): boolean => {
    if (q.kinds.length) {
      const kind = classify(db.nameOf(id), db.isDir(id));
      if (!q.kinds.some((k) => matchesKind(kind, k))) return false;
    }
    if (inIds.length || inStrings.length) {
      let ok = false;
      if (inIds.length) {
        for (let cur = db.parent[id]; cur >= 0 && !ok; cur = db.parent[cur]) if (inIds.includes(cur)) ok = true;
      }
      if (!ok && inStrings.length) {
        const p = db.pathOf(id);
        ok = inStrings.some((s) => p.startsWith(`${s}/`));
      }
      if (!ok) return false;
    }
    if (q.phrases.length) {
      const folded = foldText(db.nameOf(id));
      if (!q.phrases.every((ph) => folded.includes(ph))) return false;
    }
    return true;
  };

  const candidates: Candidate[] = [];
  const keep = (c: Candidate) => {
    candidates.push(c);
    if (candidates.length > PRESELECT * 3) {
      candidates.sort((a, b) => b.cheap - a.cheap);
      candidates.length = PRESELECT;
    }
  };

  const tokens = q.tokens;
  if (!tokens.length) {
    // Filters only (or nothing): most recent first.
    if (!q.kinds.length && !q.inPaths.length && !q.phrases.length) {
      for (let id = 0; id < n; id++) {
        if (db.isDeleted(id) || db.isDir(id) || db.parent[id] < 0) continue;
        keep({ id, cheap: Math.max(db.mtime[id], opened?.get(id) ?? 0), nameMask: 0, depth: 0 });
      }
    } else {
      for (let id = 0; id < n; id++) {
        if (db.isDeleted(id) || db.parent[id] < 0 || !passesFilters(id)) continue;
        keep({ id, cheap: Math.max(db.mtime[id], opened?.get(id) ?? 0), nameMask: 0, depth: 0 });
      }
    }
    candidates.sort((a, b) => b.cheap - a.cheap);
    return candidates.slice(0, limit).map((c) => hit(db, c.id, c.cheap, [], opened));
  }

  // Mark, per entry, which query tokens its name matches (bit i = token i).
  const bits = new Uint8Array(n);
  const touched: number[] = [];
  for (let t = 0; t < tokens.length; t++) {
    const bit = 1 << t;
    const visit = (id: number) => {
      if (bits[id] === 0) touched.push(id);
      bits[id] |= bit;
    };
    let seen = db.forEachPrefix(tokens[t], visit);
    if (seen === 0 && tokens[t].length >= 2) seen = db.forEachSubstring(tokens[t], visit);
    if (seen === 0 && tokens[t].length >= 3) seen = db.forEachSubsequence(tokens[t], visit);
    if (seen === 0) return [];
  }

  const full = (1 << tokens.length) - 1;
  for (const id of touched) {
    if (db.isDeleted(id) || db.parent[id] < 0) continue;
    const nameMask = bits[id];
    let mask = nameMask;
    let depth = 0;
    for (let cur = db.parent[id]; cur >= 0; cur = db.parent[cur]) {
      mask |= bits[cur];
      depth++;
    }
    if (mask !== full) continue;
    if (!passesFilters(id)) continue;
    const name = db.names[id];
    const cheap = popcount(nameMask) * 100 + recencyBoost(db, id, now, opened) - depth * 3 - name.length * 0.3;
    keep({ id, cheap, nameMask, depth });
  }
  candidates.sort((a, b) => b.cheap - a.cheap);
  if (candidates.length > PRESELECT) candidates.length = PRESELECT;

  const fullText = tokens.join(" ");
  const foldedQuery = foldText(q.text.replace(/\s+/g, ""));
  const scored: Array<{ c: Candidate; score: number; ranges: MatchRange[] }> = [];
  for (const c of candidates) {
    const name = db.nameOf(c.id);
    let text = 0;
    let ranges: MatchRange[] = [];
    const nameTokens = tokens.filter((_, i) => c.nameMask & (1 << i));
    const fz = nameTokens.length === tokens.length ? fuzzyMatch(name, fullText) : null;
    if (fz) {
      text = fz.exact ? 400 : (fz.score / Math.max(1, 2 * fullText.length)) * 100;
      ranges = fz.ranges;
    } else {
      for (const tok of nameTokens) {
        const r = fuzzyMatch(name, tok);
        if (!r) continue;
        text += (r.score / Math.max(1, 2 * tok.length)) * (100 / tokens.length);
        ranges.push(...r.ranges);
      }
      ranges.sort((a, b) => a.start - b.start);
    }
    const pathOnly = tokens.length - nameTokens.length;
    const foldedStem = foldText(stem(name)).replace(/[\s\-_.]+/g, "");
    const exactName = foldedStem === foldedQuery || foldText(name) === foldText(q.text);
    const score =
      text +
      (exactName ? 300 : 0) +
      (fz?.prefix ? 25 : 0) -
      pathOnly * 40 +
      recencyBoost(db, c.id, now, opened) -
      c.depth * 3 -
      name.length * 0.1;
    scored.push({ c, score, ranges });
  }
  scored.sort((a, b) => b.score - a.score || a.c.depth - b.c.depth);
  return scored.slice(0, limit).map((s) => hit(db, s.c.id, s.score, s.ranges, opened));
}

function hit(db: FileIndexDb, id: number, score: number, ranges: MatchRange[], opened?: Map<number, number>): FileHit {
  const name = db.nameOf(id);
  const isDir = db.isDir(id);
  return {
    id,
    path: db.pathOf(id),
    name,
    isDir,
    size: db.size[id],
    mtime: db.mtime[id],
    kind: classify(name, isDir),
    score,
    ranges,
    openedAt: opened?.get(id),
  };
}
