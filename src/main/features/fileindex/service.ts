/**
 * Orchestrates the private file index: load on start, first/daily crawl (worker
 * thread when bundled, inline otherwise), FSEvents-driven incremental updates
 * journalled to disk, idle compaction, queries and "opened from Glide" boosts.
 * Electron-free so it can be unit-tested.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { compact, fullBuild, type BuildResult } from "./build";
import { crawl, normaliseScopes, toEntryStat, type CrawlConfig } from "./crawler";
import type { FileIndexDb } from "./db";
import { Exclusions, protectedFolders } from "./exclusions";
import { indexPaths, META_VERSION, readJsonSync, writeAtomic, type IndexMeta } from "./files-io";
import { extendChain, IGNORE_FILES, IgnoreRules, isIgnoredByChain, parseIgnoreFile, type IgnoreChain } from "./ignore";
import { appendJournal, applyOp, readJournalSync, upsertOp, type JournalOp } from "./journal";
import { deserialize } from "./persist";
import { parseQuery, search, type FileHit, type ParsedQuery } from "./query";
import { crawlKey, type FileIndexSettings } from "./settings";
import { ScopeWatcher } from "./watch";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

export type IndexState = "idle" | "loading" | "crawling" | "ready" | "error";

export interface IndexStatus {
  state: IndexState;
  mode: "worker" | "inline";
  entries: number;
  files: number;
  dirs: number;
  generation: number;
  lastFullIndexAt: number | null;
  durationMs: number | null;
  /** entries seen so far by a running crawl */
  progress: number;
  scopes: string[];
  watching: boolean;
  journalOps: number;
  error: string | null;
  aborted: string | null;
  loadMs: number | null;
}

export interface ServiceOptions {
  dataDir: string;
  home: string;
  getSettings(): FileIndexSettings;
  /** Bundled worker script; inline crawling when missing. */
  workerPath?: string | null;
  log?(...args: unknown[]): void;
  onStatus?(status: IndexStatus): void;
  /** Disable fs.watch (tests). */
  watch?: boolean;
  fullCrawlEveryMs?: number;
  compactAfterIdleMs?: number;
}

const DAY = 86_400_000;
const COMPACT_OPS_THRESHOLD = 5000;
const OPENED_LIMIT = 2000;

export class FileIndexService {
  private db: FileIndexDb | null = null;
  private meta: IndexMeta | null = null;
  private state: IndexState = "idle";
  private progress = 0;
  private error: string | null = null;
  private loadMs: number | null = null;
  private watcher: ScopeWatcher | null = null;
  private job: Promise<unknown> = Promise.resolve();
  private busy = false;
  private crawlQueued = false;
  private crawling = false;
  private changesDuringCrawl = new Set<string>();
  private journalOps = 0;
  private opsSinceRotation: JournalOp[] | null = null;
  private journalWrite: Promise<void> = Promise.resolve();
  private compactTimer: NodeJS.Timeout | undefined;
  private dailyTimer: NodeJS.Timeout | undefined;
  private opened = new Map<string, number>();
  private openedById: Map<number, number> | null = null;
  private openedSave: NodeJS.Timeout | undefined;
  private ignoreCache = new Map<string, IgnoreRules | null>();
  private stopped = false;
  private activeWorker: Worker | null = null;
  readonly paths: ReturnType<typeof indexPaths>;

  constructor(private readonly opts: ServiceOptions) {
    this.paths = indexPaths(opts.dataDir);
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.stopped = false;
    this.loadOpened();
    this.setState("loading");
    const loaded = this.loadFromDisk();
    const settings = this.opts.getSettings();
    const stale = !this.meta || Date.now() - this.meta.lastFullIndexAt > (this.opts.fullCrawlEveryMs ?? DAY) || this.meta.configKey !== crawlKey(settings);
    if (loaded) this.setState("ready");
    this.startWatching();
    if (!loaded || stale) void this.rebuild();
    this.dailyTimer = setInterval(() => {
      if (this.meta && Date.now() - this.meta.lastFullIndexAt > (this.opts.fullCrawlEveryMs ?? DAY)) void this.rebuild();
    }, 3_600_000);
    this.dailyTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.stop();
    this.watcher = null;
    clearInterval(this.dailyTimer);
    clearTimeout(this.compactTimer);
    if (this.openedSave) {
      clearTimeout(this.openedSave);
      this.saveOpened();
    }
    this.activeWorker?.postMessage({ id: 0, type: "stop" } satisfies WorkerRequest);
    await this.journalWrite.catch(() => undefined);
    await this.activeWorker?.terminate().catch(() => undefined);
  }

  /** Re-read settings: re-crawl when crawl-relevant settings changed. */
  settingsChanged(): void {
    if (this.meta?.configKey === crawlKey(this.opts.getSettings()) && this.db) return;
    this.ignoreCache.clear();
    this.startWatching();
    void this.rebuild();
  }

  // ---------------------------------------------------------------- status

  ready(): boolean {
    return this.db !== null && (this.state === "ready" || this.state === "crawling");
  }

  /** True once the first full crawl finished (search uses the index rather than mdfind). */
  hasIndex(): boolean {
    return this.db !== null;
  }

  status(): IndexStatus {
    const m = this.meta;
    return {
      state: this.state,
      mode: this.workerAvailable() ? "worker" : "inline",
      entries: this.db?.live ?? m?.counts.entries ?? 0,
      files: m?.counts.files ?? 0,
      dirs: m?.counts.dirs ?? 0,
      generation: m?.generation ?? 0,
      lastFullIndexAt: m?.lastFullIndexAt ?? null,
      durationMs: m?.durationMs ?? null,
      progress: this.progress,
      scopes: this.scopes(),
      watching: this.watcher?.active ?? false,
      journalOps: this.journalOps,
      error: this.error,
      aborted: m?.aborted ?? null,
      loadMs: this.loadMs,
    };
  }

  private setState(s: IndexState): void {
    this.state = s;
    this.opts.onStatus?.(this.status());
  }

  private workerAvailable(): boolean {
    return !!this.opts.workerPath && fs.existsSync(this.opts.workerPath);
  }

  scopes(): string[] {
    return normaliseScopes(this.opts.getSettings().scopes, this.opts.home);
  }

  crawlConfig(): CrawlConfig {
    const s = this.opts.getSettings();
    const scopes = this.scopes();
    return {
      scopes,
      ruleRoots: scopes,
      home: this.opts.home,
      includeHidden: s.includeHidden,
      respectIgnoreFiles: s.respectIgnoreFiles,
      userPatterns: s.exclusions,
      blocked: s.allowProtectedFolders ? [] : protectedFolders(this.opts.home),
      generation: (this.meta?.generation ?? 0) + 1,
    };
  }

  // ------------------------------------------------------------------ query

  parse(text: string): ParsedQuery {
    return parseQuery(text, this.opts.home);
  }

  search(text: string, limit = 20): FileHit[] | null {
    if (!this.db) return null;
    return search(this.db, this.parse(text), { limit, opened: this.openedIds() });
  }

  private openedIds(): Map<number, number> {
    if (this.openedById) return this.openedById;
    const map = new Map<number, number>();
    if (this.db) {
      for (const [p, t] of this.opened) {
        const id = this.db.findPath(p);
        if (id >= 0) map.set(id, t);
      }
    }
    this.openedById = map;
    return map;
  }

  recordOpen(p: string): void {
    this.opened.delete(p);
    this.opened.set(p, Date.now());
    if (this.opened.size > OPENED_LIMIT) this.opened.delete(this.opened.keys().next().value!);
    this.openedById = null;
    clearTimeout(this.openedSave);
    this.openedSave = setTimeout(() => this.saveOpened(), 2000);
  }

  private loadOpened(): void {
    const raw = readJsonSync<Record<string, number>>(this.paths.opened) ?? {};
    this.opened = new Map(Object.entries(raw).filter(([, t]) => typeof t === "number").sort((a, b) => a[1] - b[1]));
  }

  private saveOpened(): void {
    this.openedSave = undefined;
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    void writeAtomic(this.paths.opened, JSON.stringify(Object.fromEntries(this.opened))).catch(() => undefined);
  }

  // ------------------------------------------------------------ persistence

  private loadFromDisk(): boolean {
    const t0 = performance.now();
    const meta = readJsonSync<IndexMeta>(this.paths.meta);
    if (!meta || meta.version !== META_VERSION || !fs.existsSync(this.paths.bin)) return false;
    try {
      const db = deserialize(fs.readFileSync(this.paths.bin));
      let ops = 0;
      for (const file of [this.paths.compacting, this.paths.journal]) {
        for (const op of readJournalSync(file)) {
          applyOp(db, op);
          ops++;
        }
      }
      this.db = db;
      this.meta = meta;
      this.journalOps = ops;
      this.openedById = null;
      this.loadMs = Math.round(performance.now() - t0);
      this.opts.log?.(`loaded ${db.live} entries in ${this.loadMs} ms (${ops} journal ops)`);
      if (ops) this.scheduleCompaction();
      return true;
    } catch (err) {
      this.opts.log?.("index load failed, rebuilding:", err);
      return false;
    }
  }

  private install(result: BuildResult): void {
    this.db = deserialize(result.bytes);
    this.meta = result.meta;
    this.openedById = null;
  }

  // -------------------------------------------------------------- crawling

  /** Resolves when no crawl/compaction is running or queued. */
  async whenIdle(): Promise<void> {
    let job: Promise<unknown>;
    do {
      job = this.job;
      await job;
    } while (job !== this.job);
  }

  /** Full re-crawl (coalesces concurrent requests). */
  rebuild(): Promise<void> {
    if (this.crawlQueued) return this.job.then(() => undefined);
    this.crawlQueued = true;
    const run = this.job.then(async () => {
      this.crawlQueued = false;
      if (this.stopped) return;
      this.crawling = true;
      this.changesDuringCrawl.clear();
      this.progress = 0;
      this.error = null;
      this.setState("crawling");
      try {
        const config = this.crawlConfig();
        const key = crawlKey(this.opts.getSettings());
        const result = this.workerAvailable()
          ? await this.inWorker({ id: 0, type: "crawl", config, dir: this.opts.dataDir, configKey: key })
          : await fullBuild(config, this.opts.dataDir, key, {
              onProgress: (n) => this.onProgress(n),
              pace: () => new Promise((r) => setImmediate(r)),
              shouldStop: () => this.stopped,
            });
        if (!result || this.stopped) return;
        this.install(result);
        this.journalOps = 0;
        this.opsSinceRotation = null;
        this.opts.log?.(`indexed ${result.meta.counts.entries} entries in ${result.meta.durationMs} ms (generation ${result.meta.generation})`);
        this.crawling = false;
        this.setState("ready");
        const missed = [...this.changesDuringCrawl];
        this.changesDuringCrawl.clear();
        if (missed.length) await this.processPaths(missed);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.opts.log?.("crawl failed:", this.error);
        this.setState(this.db ? "ready" : "error");
      } finally {
        this.crawling = false;
      }
    });
    this.job = run.catch(() => undefined);
    return run;
  }

  private onProgress(n: number): void {
    this.progress = n;
    this.opts.onStatus?.(this.status());
  }

  private inWorker(req: WorkerRequest): Promise<BuildResult | null> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.opts.workerPath!);
      this.activeWorker = worker;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.activeWorker = null;
        void worker.terminate();
        fn();
      };
      worker.on("message", (msg: WorkerResponse) => {
        if (msg.type === "progress") this.onProgress(msg.entries);
        else if (msg.type === "done") finish(() => resolve(msg.bytes && msg.meta ? { bytes: msg.bytes, meta: msg.meta } : null));
        else finish(() => reject(new Error(msg.message)));
      });
      worker.on("error", (err) => finish(() => reject(err)));
      worker.on("exit", (code) => finish(() => (this.stopped ? resolve(null) : reject(new Error(`fileindex worker exited (${code})`)))));
      worker.postMessage(req);
    });
  }

  // ------------------------------------------------------------ compaction

  private scheduleCompaction(): void {
    clearTimeout(this.compactTimer);
    const delay = this.journalOps >= COMPACT_OPS_THRESHOLD ? 0 : (this.opts.compactAfterIdleMs ?? 60_000);
    this.compactTimer = setTimeout(() => void this.compactNow(), delay);
    this.compactTimer.unref?.();
  }

  /** Rotate the journal and fold it into index.bin (in the worker when available). */
  compactNow(): Promise<void> {
    const run = this.job.then(async () => {
      if (this.stopped || this.crawling || !this.db || !this.meta) return;
      if (!this.journalOps && !this.db.needsCompaction()) return;
      await this.journalWrite;
      try {
        // Rotate: ops arriving from now on go to a fresh journal and are replayed onto the compacted index.
        if (fs.existsSync(this.paths.journal)) {
          const pending = fs.existsSync(this.paths.compacting) ? fs.readFileSync(this.paths.compacting, "utf8") : "";
          fs.writeFileSync(this.paths.compacting, pending + fs.readFileSync(this.paths.journal, "utf8"));
          fs.rmSync(this.paths.journal, { force: true });
        }
        this.opsSinceRotation = [];
        const result = this.workerAvailable() ? await this.inWorker({ id: 0, type: "compact", dir: this.opts.dataDir }) : await compact(this.opts.dataDir);
        if (!result || this.stopped) return;
        const since = this.opsSinceRotation ?? [];
        this.install(result);
        for (const op of since) applyOp(this.db!, op);
        this.journalOps = since.length;
        this.opts.log?.(`compacted index (${this.db!.live} entries, ${since.length} newer ops)`);
        this.opts.onStatus?.(this.status());
      } catch (err) {
        this.opts.log?.("compaction failed:", err);
      } finally {
        this.opsSinceRotation = null;
      }
    });
    this.job = run.catch(() => undefined);
    return run;
  }

  // -------------------------------------------------------------- watching

  private startWatching(): void {
    this.watcher?.stop();
    this.watcher = null;
    if (this.opts.watch === false) return;
    const scopes = this.scopes().filter((s) => fs.existsSync(s));
    this.watcher = new ScopeWatcher({
      scopes,
      onPaths: (paths) => void this.processPaths(paths),
      onError: (err) => {
        this.opts.log?.("watcher error, scheduling a full re-crawl:", err.message);
        this.startWatching();
        void this.rebuild();
      },
    });
    this.watcher.start();
  }

  private exclusions(): Exclusions {
    const c = this.crawlConfig();
    return new Exclusions(c);
  }

  private ignoreRulesFor(dir: string): IgnoreRules | null {
    if (this.ignoreCache.has(dir)) return this.ignoreCache.get(dir)!;
    let rules: IgnoreRules | null = null;
    const present = IGNORE_FILES.filter((n) => fs.existsSync(path.join(dir, n)));
    if (present.length) {
      // Sync read keeps the cache simple; ignore files are tiny and this only runs on change.
      const text = present.map((n) => {
        try {
          return fs.readFileSync(path.join(dir, n), "utf8");
        } catch {
          return "";
        }
      });
      rules = new IgnoreRules(dir, parseIgnoreFile(text.join("\n")));
    }
    this.ignoreCache.set(dir, rules);
    return rules;
  }

  /** Is `p` inside a scope and not excluded at any ancestor level? Returns the ignore chain for the leaf. */
  private admit(p: string, ex: Exclusions, respectIgnore: boolean): { chain: IgnoreChain | null } | null {
    const scope = this.scopes().find((s) => p === s || p.startsWith(s === "/" ? "/" : `${s}/`));
    if (!scope || p === scope) return null;
    const rel = p.slice(scope === "/" ? 1 : scope.length + 1).split("/");
    let chain: IgnoreChain | null = null;
    let cur = scope;
    for (let i = 0; i < rel.length - 1; i++) {
      if (respectIgnore) chain = extendChain(chain, this.ignoreRulesFor(cur));
      const name = rel[i];
      const next = cur === "/" ? `/${name}` : `${cur}/${name}`;
      if (ex.excluded(next, name, true) || !ex.descend(name) || (chain && isIgnoredByChain(chain, next, true))) return null;
      cur = next;
    }
    if (respectIgnore) chain = extendChain(chain, this.ignoreRulesFor(cur));
    return { chain };
  }

  /** Re-stat changed paths and turn them into journal ops. */
  async processPaths(paths: string[]): Promise<void> {
    if (this.crawling) {
      for (const p of paths) this.changesDuringCrawl.add(p);
      return;
    }
    const db = this.db;
    if (!db) return;
    const settings = this.opts.getSettings();
    const ex = this.exclusions();
    const ops: JournalOp[] = [];
    const apply = (op: JournalOp) => {
      if (applyOp(db, op)) ops.push(op);
    };
    // Parents before children; dedupe.
    for (const p of [...new Set(paths)].sort()) {
      const name = path.basename(p);
      if ((IGNORE_FILES as readonly string[]).includes(name)) this.ignoreCache.delete(path.dirname(p));
      const admitted = this.admit(p, ex, settings.respectIgnoreFiles);
      if (!admitted) continue;
      const st = await fsp.lstat(p).catch(() => null);
      if (!st) {
        if (db.findPath(p) >= 0) apply({ o: "r", p });
        continue;
      }
      const isDir = st.isDirectory();
      if (ex.excluded(p, name, isDir) || (admitted.chain && isIgnoredByChain(admitted.chain, p, isDir))) {
        if (db.findPath(p) >= 0) apply({ o: "r", p });
        continue;
      }
      const existed = db.findPath(p) >= 0;
      const s = toEntryStat(st);
      apply(upsertOp(p, isDir, s.size, s.mtime, s.atime));
      if (isDir && !existed && ex.descend(name)) {
        // New (or moved-in) folder: index its subtree.
        const sub = await crawl({ ...this.crawlConfig(), scopes: [p] });
        for (let id = 1; id < sub.db.count; id++) apply(upsertOp(sub.db.pathOf(id), sub.db.isDir(id), sub.db.size[id], sub.db.mtime[id], sub.db.atime[id]));
      }
    }
    if (!ops.length) return;
    this.openedById = null;
    this.journalOps += ops.length;
    this.opsSinceRotation?.push(...ops);
    this.journalWrite = this.journalWrite.then(() => appendJournal(this.paths.journal, ops)).catch((err) => this.opts.log?.("journal write failed:", err));
    this.scheduleCompaction();
    this.opts.onStatus?.(this.status());
    await this.journalWrite;
  }

  /** Called after Glide itself deletes/moves a file. */
  async forget(p: string): Promise<void> {
    await this.processPaths([p]);
  }
}
