/**
 * In-memory file index: columnar entry arrays + an inverted index from name
 * tokens to entry ids. The "frozen" part is a sorted token array with
 * postings in one Int32Array (fast prefix lookup by binary search); changes
 * since the last compaction live in a small delta map and deletions are
 * tombstones (an LSM-style split).
 */
import { nameTokens } from "./tokenize";

export const FLAG_DIR = 1;
export const FLAG_DELETED = 2;

export interface EntryStat {
  isDir: boolean;
  size: number;
  mtime: number;
  atime: number;
}

const INITIAL = 1024;

function grow<T extends Float64Array | Int32Array | Uint8Array>(arr: T, need: number): T {
  if (need <= arr.length) return arr;
  let n = Math.max(arr.length * 2, INITIAL);
  while (n < need) n *= 2;
  const Ctor = arr.constructor as new (n: number) => T;
  const next = new Ctor(n);
  next.set(arr);
  return next;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/", p.length - 2);
  return i >= 0 ? p.slice(i + 1).replace(/\/$/, "") : p;
}

export class FileIndexDb {
  count = 0;
  live = 0;
  names: string[] = [];
  parent: Int32Array = new Int32Array(INITIAL);
  flags: Uint8Array = new Uint8Array(INITIAL);
  size: Float64Array = new Float64Array(INITIAL);
  mtime: Float64Array = new Float64Array(INITIAL);
  atime: Float64Array = new Float64Array(INITIAL);
  roots: number[] = [];

  /** Frozen token dictionary (sorted) and postings. */
  tokens: string[] = [];
  postOff: Uint32Array = new Uint32Array(1);
  postData: Int32Array = new Int32Array(0);
  /** Tokens of entries added since the last freeze. */
  delta = new Map<string, number[]>();
  deltaEntries = 0;
  deletedSinceFreeze = 0;

  generation = 0;
  builtAt = 0;

  private children: Map<number, Map<string, number>> | null = null;
  private rootByPath = new Map<string, number>();

  // ---------------------------------------------------------------- entries

  isDir(id: number): boolean {
    return (this.flags[id] & FLAG_DIR) !== 0;
  }
  isDeleted(id: number): boolean {
    return (this.flags[id] & FLAG_DELETED) !== 0;
  }
  /** Display name: the basename (roots store their absolute path as name). */
  nameOf(id: number): string {
    return this.parent[id] < 0 ? basename(this.names[id]) : this.names[id];
  }

  pathOf(id: number): string {
    const parts: string[] = [];
    let cur = id;
    while (cur >= 0) {
      parts.push(this.names[cur]);
      cur = this.parent[cur];
    }
    parts.reverse();
    const root = parts[0];
    if (parts.length === 1) return root;
    return `${root === "/" ? "" : root}/${parts.slice(1).join("/")}`;
  }

  depthOf(id: number): number {
    let d = 0;
    for (let cur = this.parent[id]; cur >= 0; cur = this.parent[cur]) d++;
    return d;
  }

  /** Raw insert used by builders/loaders; does not touch postings. */
  protected push(name: string, parent: number, st: EntryStat): number {
    const id = this.count++;
    this.parent = grow(this.parent, this.count);
    this.flags = grow(this.flags, this.count);
    this.size = grow(this.size, this.count);
    this.mtime = grow(this.mtime, this.count);
    this.atime = grow(this.atime, this.count);
    this.names[id] = name;
    this.parent[id] = parent;
    this.flags[id] = st.isDir ? FLAG_DIR : 0;
    this.size[id] = st.size;
    this.mtime[id] = st.mtime;
    this.atime[id] = st.atime;
    this.live++;
    if (parent < 0) {
      this.roots.push(id);
      this.rootByPath.set(name, id);
    }
    if (this.children && parent >= 0) this.childMap(parent).set(name, id);
    return id;
  }

  /** Add an entry after the index is frozen (goes to the delta postings). */
  add(name: string, parent: number, st: EntryStat): number {
    const id = this.push(name, parent, st);
    addTokens(this.delta, this.nameOf(id), id);
    this.deltaEntries++;
    return id;
  }

  updateStat(id: number, st: EntryStat): void {
    this.size[id] = st.size;
    this.mtime[id] = st.mtime;
    this.atime[id] = st.atime;
  }

  /** Tombstone an entry and everything below it. Returns the number removed. */
  remove(id: number): number {
    if (this.isDeleted(id)) return 0;
    let removed = 0;
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (this.isDeleted(cur)) continue;
      this.flags[cur] |= FLAG_DELETED;
      this.live--;
      removed++;
      const kids = this.childMap(cur);
      for (const k of kids.values()) stack.push(k);
    }
    const p = this.parent[id];
    if (p >= 0) {
      const siblings = this.childMap(p);
      if (siblings.get(this.names[id]) === id) siblings.delete(this.names[id]);
    } else {
      this.rootByPath.delete(this.names[id]);
      this.roots = this.roots.filter((r) => r !== id);
    }
    this.deletedSinceFreeze += removed;
    return removed;
  }

  private childMap(id: number): Map<string, number> {
    if (!this.children) this.buildChildren();
    let m = this.children!.get(id);
    if (!m) {
      m = new Map();
      this.children!.set(id, m);
    }
    return m;
  }

  /** Lazily built: only incremental updates need name → child lookups. */
  private buildChildren(): void {
    const children = new Map<number, Map<string, number>>();
    for (let id = 0; id < this.count; id++) {
      const p = this.parent[id];
      if (p < 0 || this.flags[id] & FLAG_DELETED) continue;
      let m = children.get(p);
      if (!m) children.set(p, (m = new Map()));
      m.set(this.names[id], id);
    }
    this.children = children;
  }

  childrenOf(id: number): number[] {
    return [...this.childMap(id).values()];
  }

  /** Entry id for an absolute path, or -1. */
  findPath(abs: string): number {
    const clean = abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
    const direct = this.rootByPath.get(clean);
    if (direct !== undefined) return direct;
    let best = -1;
    let bestLen = -1;
    for (const [rootPath, id] of this.rootByPath) {
      const prefix = rootPath === "/" ? "/" : `${rootPath}/`;
      if (clean.startsWith(prefix) && rootPath.length > bestLen) {
        best = id;
        bestLen = rootPath.length;
      }
    }
    if (best < 0) return -1;
    const rootPath = this.names[best];
    const rest = clean.slice(rootPath === "/" ? 1 : rootPath.length + 1);
    let cur = best;
    for (const seg of rest.split("/")) {
      if (!seg) continue;
      const next = this.childMap(cur).get(seg);
      if (next === undefined) return -1;
      cur = next;
    }
    return cur;
  }

  addRoot(abs: string, st: EntryStat): number {
    const existing = this.rootByPath.get(abs);
    if (existing !== undefined) return existing;
    return this.add(abs, -1, st);
  }

  // ---------------------------------------------------------------- postings

  /** Visit ids of every token starting with `prefix` (frozen + delta). */
  forEachPrefix(prefix: string, visit: (id: number) => void): number {
    let tokensSeen = 0;
    const toks = this.tokens;
    let lo = 0;
    let hi = toks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (toks[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const off = this.postOff;
    const data = this.postData;
    for (let t = lo; t < toks.length && toks[t].startsWith(prefix); t++) {
      tokensSeen++;
      for (let i = off[t], end = off[t + 1]; i < end; i++) visit(data[i]);
    }
    if (this.delta.size) {
      for (const [tok, ids] of this.delta) {
        if (!tok.startsWith(prefix)) continue;
        tokensSeen++;
        for (const id of ids) visit(id);
      }
    }
    return tokensSeen;
  }

  /** Fallback for mid-word queries ("port" → "report"): tokens containing `needle`. */
  forEachSubstring(needle: string, visit: (id: number) => void, maxTokens = 2000): number {
    let seen = 0;
    const toks = this.tokens;
    const off = this.postOff;
    const data = this.postData;
    for (let t = 0; t < toks.length && seen < maxTokens; t++) {
      if (toks[t].indexOf(needle) < 0) continue;
      seen++;
      for (let i = off[t], end = off[t + 1]; i < end; i++) visit(data[i]);
    }
    for (const [tok, ids] of this.delta) {
      if (tok.indexOf(needle) < 0) continue;
      seen++;
      for (const id of ids) visit(id);
    }
    return seen;
  }

  /**
   * Last-resort typo tolerance ("tst" → "test"): tokens that start with the
   * needle's first char and contain the rest as an ordered subsequence.
   */
  forEachSubsequence(needle: string, visit: (id: number) => void, maxTokens = 2000): number {
    const first = needle[0];
    const isSub = (tok: string) => {
      if (tok[0] !== first || tok.length < needle.length) return false;
      let pos = 1;
      for (let i = 1; i < needle.length; i++) {
        pos = tok.indexOf(needle[i], pos);
        if (pos < 0) return false;
        pos++;
      }
      return true;
    };
    let seen = 0;
    const toks = this.tokens;
    let lo = 0;
    let hi = toks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (toks[mid] < first) lo = mid + 1;
      else hi = mid;
    }
    for (let t = lo; t < toks.length && toks[t][0] === first && seen < maxTokens; t++) {
      if (!isSub(toks[t])) continue;
      seen++;
      for (let i = this.postOff[t], end = this.postOff[t + 1]; i < end; i++) visit(this.postData[i]);
    }
    for (const [tok, ids] of this.delta) {
      if (!isSub(tok)) continue;
      seen++;
      for (const id of ids) visit(id);
    }
    return seen;
  }

  /** Rebuild the frozen token index from all live names (ids unchanged). */
  freezeTokens(): void {
    const map = new Map<string, number[]>();
    for (let id = 0; id < this.count; id++) {
      if (this.flags[id] & FLAG_DELETED) continue;
      addTokens(map, this.nameOf(id), id);
    }
    this.installTokens(map);
  }

  protected installTokens(map: Map<string, number[]>): void {
    const tokens = [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let total = 0;
    for (const t of tokens) total += map.get(t)!.length;
    const off = new Uint32Array(tokens.length + 1);
    const data = new Int32Array(total);
    let pos = 0;
    for (let i = 0; i < tokens.length; i++) {
      off[i] = pos;
      const ids = map.get(tokens[i])!;
      data.set(ids, pos);
      pos += ids.length;
    }
    off[tokens.length] = pos;
    this.tokens = tokens;
    this.postOff = off;
    this.postData = data;
    this.delta.clear();
    this.deltaEntries = 0;
  }

  /** A new, densely numbered index without tombstones (used before persisting). */
  compacted(): FileIndexDb {
    const out = new FileIndexDb();
    const remap = new Int32Array(this.count).fill(-1);
    // Parents always precede children (ids are assigned top-down), so one pass suffices.
    for (let id = 0; id < this.count; id++) {
      if (this.flags[id] & FLAG_DELETED) continue;
      const p = this.parent[id];
      if (p >= 0 && remap[p] < 0) continue; // orphan
      remap[id] = out.push(this.names[id], p >= 0 ? remap[p] : -1, {
        isDir: (this.flags[id] & FLAG_DIR) !== 0,
        size: this.size[id],
        mtime: this.mtime[id],
        atime: this.atime[id],
      });
    }
    out.freezeTokens();
    out.generation = this.generation;
    out.builtAt = this.builtAt;
    return out;
  }

  needsCompaction(): boolean {
    return this.deltaEntries > 0 || this.deletedSinceFreeze > 0;
  }

  /** Used by the loader: install columns directly. */
  static fromColumns(cols: {
    names: string[];
    parent: Int32Array;
    flags: Uint8Array;
    size: Float64Array;
    mtime: Float64Array;
    atime: Float64Array;
    tokens: string[];
    postOff: Uint32Array;
    postData: Int32Array;
    generation: number;
    builtAt: number;
  }): FileIndexDb {
    const db = new FileIndexDb();
    const n = cols.names.length;
    db.count = n;
    db.names = cols.names;
    db.parent = cols.parent;
    db.flags = cols.flags;
    db.size = cols.size;
    db.mtime = cols.mtime;
    db.atime = cols.atime;
    db.tokens = cols.tokens;
    db.postOff = cols.postOff;
    db.postData = cols.postData;
    db.generation = cols.generation;
    db.builtAt = cols.builtAt;
    let live = 0;
    for (let id = 0; id < n; id++) {
      if (cols.flags[id] & FLAG_DELETED) continue;
      live++;
      if (cols.parent[id] < 0) {
        db.roots.push(id);
        db.rootByPath.set(cols.names[id], id);
      }
    }
    db.live = live;
    return db;
  }
}

function addTokens(map: Map<string, number[]>, name: string, id: number): void {
  for (const t of nameTokens(name)) {
    const list = map.get(t);
    if (list) list.push(id);
    else map.set(t, [id]);
  }
}

/** Builds an index top-down during a crawl (tokenising as it goes); call finish() at the end. */
export class IndexBuilder extends FileIndexDb {
  private pending = new Map<string, number[]>();

  insert(name: string, parent: number, st: EntryStat): number {
    const id = this.push(name, parent, st);
    addTokens(this.pending, this.nameOf(id), id);
    return id;
  }

  finish(generation: number, builtAt: number): FileIndexDb {
    this.installTokens(this.pending);
    this.pending = new Map();
    this.generation = generation;
    this.builtAt = builtAt;
    return this;
  }
}
