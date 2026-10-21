/**
 * Directory crawler: fs.promises.opendir with bounded directory concurrency,
 * built-in exclusions, hierarchical ignore files, bundles indexed but not
 * descended. Runs unchanged in the worker thread or inline in main.
 */
import fsp from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import { IndexBuilder, type EntryStat, type FileIndexDb } from "./db";
import { Exclusions, type ExclusionConfig } from "./exclusions";
import { extendChain, IGNORE_FILES, IgnoreRules, isIgnoredByChain, parseIgnoreFile, type IgnoreChain } from "./ignore";

export interface CrawlConfig extends ExclusionConfig {
  scopes: string[];
  respectIgnoreFiles: boolean;
  concurrency?: number;
  maxEntries?: number;
  generation?: number;
}

export interface CrawlStats {
  files: number;
  dirs: number;
  symlinks: number;
  entries: number;
  errors: number;
  durationMs: number;
  aborted?: string;
}

export interface CrawlHooks {
  onProgress?(entries: number): void;
  /** Awaited every few directories; inline mode yields the event loop here. */
  pace?(): Promise<void>;
  shouldStop?(): boolean;
}

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_MAX_ENTRIES = 1_500_000;
const STAT_CHUNK = 64;

export function toEntryStat(st: Stats): EntryStat {
  return { isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, atime: st.atimeMs };
}

export function expandScope(scope: string, home: string): string {
  let p = scope.trim();
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = path.join(home, p.slice(2));
  return path.resolve(p);
}

/** Expanded scopes with duplicates and nested scopes removed. */
export function normaliseScopes(scopes: string[], home: string): string[] {
  const list = [...new Set(scopes.filter((s) => s.trim()).map((s) => expandScope(s, home)))].sort();
  return list.filter((s) => !list.some((o) => o !== s && (o === "/" || s.startsWith(`${o}/`))));
}

export async function loadIgnoreRules(dir: string, names: Iterable<string>): Promise<IgnoreRules | null> {
  const rules = [];
  for (const n of names) {
    try {
      rules.push(...parseIgnoreFile(await fsp.readFile(path.join(dir, n), "utf8")));
    } catch {
      /* unreadable ignore file: ignore it */
    }
  }
  return rules.length ? new IgnoreRules(dir, rules) : null;
}

interface Job {
  dir: string;
  id: number;
  chain: IgnoreChain | null;
}

export async function crawl(config: CrawlConfig, hooks: CrawlHooks = {}): Promise<{ db: FileIndexDb; stats: CrawlStats }> {
  const started = Date.now();
  const builder = new IndexBuilder();
  const roots = normaliseScopes(config.scopes, config.home);
  const exclusions = new Exclusions({ ...config, ruleRoots: config.ruleRoots ?? roots });
  const stats: CrawlStats = { files: 0, dirs: 0, symlinks: 0, entries: 0, errors: 0, durationMs: 0 };
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const queue: Job[] = [];
  let lastProgress = 0;
  let processed = 0;

  for (const scope of roots) {
    try {
      const st = await fsp.stat(scope);
      if (!st.isDirectory()) continue;
      const id = builder.insert(scope, -1, toEntryStat(st));
      stats.dirs++;
      queue.push({ dir: scope, id, chain: null });
    } catch {
      stats.errors++;
    }
  }

  const visit = async (job: Job): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = [];
      const handle = await fsp.opendir(job.dir, { bufferSize: 128 });
      for await (const d of handle) dirents.push(d);
    } catch {
      stats.errors++;
      return;
    }
    let chain = job.chain;
    if (config.respectIgnoreFiles) {
      const present = dirents.filter((d) => !d.isDirectory() && (IGNORE_FILES as readonly string[]).includes(d.name)).map((d) => d.name);
      if (present.length) chain = extendChain(chain, await loadIgnoreRules(job.dir, present));
    }
    const keep: Array<{ abs: string; name: string }> = [];
    for (const d of dirents) {
      const abs = job.dir === "/" ? `/${d.name}` : `${job.dir}/${d.name}`;
      const isDir = d.isDirectory();
      if (exclusions.excluded(abs, d.name, isDir)) continue;
      if (chain && isIgnoredByChain(chain, abs, isDir)) continue;
      keep.push({ abs, name: d.name });
    }
    for (let i = 0; i < keep.length; i += STAT_CHUNK) {
      const chunk = keep.slice(i, i + STAT_CHUNK);
      const sts = await Promise.all(chunk.map((k) => fsp.lstat(k.abs).catch(() => null)));
      for (let j = 0; j < chunk.length; j++) {
        const st = sts[j];
        if (!st) {
          stats.errors++;
          continue;
        }
        const { abs, name } = chunk[j];
        const id = builder.insert(name, job.id, toEntryStat(st));
        if (st.isSymbolicLink()) stats.symlinks++;
        else if (st.isDirectory()) {
          stats.dirs++;
          if (exclusions.descend(name)) queue.push({ dir: abs, id, chain });
        } else stats.files++;
      }
    }
  };

  const concurrency = Math.max(1, config.concurrency ?? DEFAULT_CONCURRENCY);
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      if (stats.aborted) {
        if (active === 0) resolve();
        return;
      }
      while (active < concurrency && queue.length) {
        // LIFO keeps the frontier (and memory) small.
        const job = queue.pop()!;
        active++;
        void visit(job)
          .catch(() => {
            stats.errors++;
          })
          .then(async () => {
            processed++;
            if (builder.count >= maxEntries) stats.aborted = `entry ceiling (${maxEntries}) reached`;
            if (hooks.shouldStop?.()) stats.aborted = "stopped";
            if (builder.count - lastProgress >= 5000) {
              lastProgress = builder.count;
              hooks.onProgress?.(builder.count);
            }
            if (hooks.pace && processed % 16 === 0) await hooks.pace();
            active--;
            pump();
          });
      }
      if (active === 0 && (queue.length === 0 || stats.aborted)) resolve();
    };
    pump();
  });

  if (hooks.pace) await hooks.pace();
  const db = builder.finish(config.generation ?? 1, Date.now());
  stats.entries = db.count;
  stats.durationMs = Date.now() - started;
  return { db, stats };
}
