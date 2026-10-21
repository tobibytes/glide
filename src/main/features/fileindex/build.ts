/**
 * Heavy operations shared by the worker thread and the inline fallback:
 * a full crawl → index.bin, and compaction (index.bin + rotated journal → index.bin).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { crawl, type CrawlConfig, type CrawlHooks } from "./crawler";
import { applyOp, readJournalSync } from "./journal";
import { indexPaths, META_VERSION, readJsonSync, writeAtomic, type IndexMeta } from "./files-io";
import { deserialize, serialize } from "./persist";

export interface BuildResult {
  bytes: Uint8Array;
  meta: IndexMeta;
}

export async function fullBuild(config: CrawlConfig, dir: string, configKey: string, hooks: CrawlHooks = {}): Promise<BuildResult> {
  const { db, stats } = await crawl(config, hooks);
  const bytes = serialize(db);
  const meta: IndexMeta = {
    version: META_VERSION,
    generation: db.generation,
    counts: { entries: db.count, files: stats.files, dirs: stats.dirs, symlinks: stats.symlinks, errors: stats.errors },
    durationMs: stats.durationMs,
    lastFullIndexAt: Date.now(),
    configKey,
    ...(stats.aborted ? { aborted: stats.aborted } : {}),
  };
  const p = indexPaths(dir);
  await fsp.mkdir(dir, { recursive: true });
  await writeAtomic(p.bin, bytes);
  await writeAtomic(p.meta, JSON.stringify(meta, null, 2));
  // The fresh crawl supersedes every pending incremental change.
  await fsp.rm(p.journal, { force: true });
  await fsp.rm(p.compacting, { force: true });
  return { bytes, meta };
}

/** Fold the rotated journal into index.bin. Main keeps appending to a fresh journal meanwhile. */
export async function compact(dir: string): Promise<BuildResult | null> {
  const p = indexPaths(dir);
  const meta = readJsonSync<IndexMeta>(p.meta);
  if (!meta || !fs.existsSync(p.bin)) return null;
  const db = deserialize(await fsp.readFile(p.bin));
  for (const op of readJournalSync(p.compacting)) applyOp(db, op);
  const bytes = serialize(db);
  const next: IndexMeta = { ...meta, counts: { ...meta.counts, entries: db.live } };
  await writeAtomic(p.bin, bytes);
  await writeAtomic(p.meta, JSON.stringify(next, null, 2));
  await fsp.rm(p.compacting, { force: true });
  return { bytes, meta: next };
}
