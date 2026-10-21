/** Paths and small atomic-write helpers for the index directory. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const META_VERSION = "glide-fileindex-1";

export interface IndexMeta {
  version: typeof META_VERSION;
  generation: number;
  counts: { entries: number; files: number; dirs: number; symlinks: number; errors: number };
  durationMs: number;
  lastFullIndexAt: number;
  /** Fingerprint of the crawl-relevant settings the index was built with. */
  configKey: string;
  aborted?: string;
}

export function indexPaths(dir: string) {
  return {
    bin: path.join(dir, "index.bin"),
    meta: path.join(dir, "index.meta.json"),
    journal: path.join(dir, "index.journal"),
    compacting: path.join(dir, "index.journal.compacting"),
    opened: path.join(dir, "opened.json"),
  };
}

export async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

export function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
