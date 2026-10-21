import { IndexBuilder, type FileIndexDb } from "../db";

export interface FakeEntry {
  path: string; // relative to root, "a/b/c.txt"; directories end with "/"
  mtime?: number;
  size?: number;
}

/** Build an index from relative paths under `root` (parents created implicitly). */
export function buildFake(root: string, entries: FakeEntry[], now = Date.now()): FileIndexDb {
  const b = new IndexBuilder();
  const rootId = b.insert(root, -1, { isDir: true, size: 0, mtime: now, atime: now });
  const dirs = new Map<string, number>([["", rootId]]);
  const ensureDir = (rel: string): number => {
    const existing = dirs.get(rel);
    if (existing !== undefined) return existing;
    const slash = rel.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : rel.slice(0, slash));
    const id = b.insert(rel.slice(slash + 1), parent, { isDir: true, size: 0, mtime: now - 365 * 86_400_000, atime: 0 });
    dirs.set(rel, id);
    return id;
  };
  for (const e of entries) {
    const isDir = e.path.endsWith("/");
    const rel = e.path.replace(/\/$/, "");
    const slash = rel.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : rel.slice(0, slash));
    const st = { isDir, size: e.size ?? 100, mtime: e.mtime ?? now - 365 * 86_400_000, atime: 0 };
    if (isDir) {
      if (!dirs.has(rel)) dirs.set(rel, b.insert(rel.slice(slash + 1), parent, st));
    } else b.insert(rel.slice(slash + 1), parent, st);
  }
  return b.finish(1, now);
}
