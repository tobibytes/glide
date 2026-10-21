/**
 * fs.watch(scope, {recursive: true}) — FSEvents on macOS — with a 500 ms
 * debounce (capped so a constant trickle still flushes).
 */
import fs from "node:fs";
import path from "node:path";

export interface WatcherOptions {
  scopes: string[];
  onPaths(paths: string[]): void;
  onError(err: Error): void;
  debounceMs?: number;
  maxWaitMs?: number;
}

export class ScopeWatcher {
  private watchers: fs.FSWatcher[] = [];
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private firstPendingAt = 0;

  constructor(private readonly opts: WatcherOptions) {}

  get active(): boolean {
    return this.watchers.length > 0;
  }

  start(): void {
    this.stop();
    for (const scope of this.opts.scopes) {
      try {
        const w = fs.watch(scope, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename === null) {
            this.opts.onError(new Error(`watcher for ${scope} dropped events`));
            return;
          }
          this.queue(path.join(scope, filename.toString()));
        });
        w.on("error", (err) => this.opts.onError(err instanceof Error ? err : new Error(String(err))));
        this.watchers.push(w);
      } catch (err) {
        this.opts.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  private queue(p: string): void {
    if (!this.pending.size) this.firstPendingAt = Date.now();
    this.pending.add(p);
    clearTimeout(this.timer);
    const debounce = this.opts.debounceMs ?? 500;
    const waited = Date.now() - this.firstPendingAt;
    const delay = waited >= (this.opts.maxWaitMs ?? 3000) ? 0 : debounce;
    this.timer = setTimeout(() => this.flush(), delay);
  }

  private flush(): void {
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length) this.opts.onPaths(paths);
  }
}
