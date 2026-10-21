/**
 * Background refresh of Raycast commands with an `interval` (no-view and menu-bar commands).
 * Each enabled command runs every `intervalMs`; a run that is still going when the next one is due
 * is not started twice. Timers are injected so the scheduler is testable with fake clocks.
 */

export interface BackgroundEntry {
  /** "<extension>/<command>" */
  key: string;
  intervalMs: number;
}

export interface SchedulerDeps {
  run(key: string): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log?(...args: unknown[]): void;
}

interface Slot {
  intervalMs: number;
  timer: unknown;
  running: boolean;
}

export const backgroundKey = (ext: string, command: string) => `${ext}/${command}`;

export class BackgroundScheduler {
  private readonly slots = new Map<string, Slot>();
  /** Completed runs per key (diagnostics / tests). */
  readonly runs = new Map<string, number>();

  constructor(private readonly deps: SchedulerDeps) {}

  /** Make the scheduled set equal to `entries` (new ones start, removed ones stop, changed periods restart). */
  sync(entries: BackgroundEntry[]) {
    const wanted = new Map(entries.map((e) => [e.key, e.intervalMs]));
    for (const [key, slot] of Array.from(this.slots)) {
      if (wanted.get(key) !== slot.intervalMs) this.stop(key);
    }
    for (const [key, ms] of wanted) if (!this.slots.has(key) && ms > 0) this.start(key, ms);
  }

  scheduled(): string[] {
    return Array.from(this.slots.keys()).sort();
  }

  stop(key: string) {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.deps.clearTimer(slot.timer);
    this.slots.delete(key);
  }

  stopAll() {
    for (const key of Array.from(this.slots.keys())) this.stop(key);
  }

  private start(key: string, intervalMs: number) {
    const slot: Slot = { intervalMs, timer: null, running: false };
    this.slots.set(key, slot);
    this.arm(key, slot);
  }

  private arm(key: string, slot: Slot) {
    slot.timer = this.deps.setTimer(() => void this.fire(key, slot), slot.intervalMs);
  }

  private async fire(key: string, slot: Slot) {
    if (this.slots.get(key) !== slot) return;
    if (!slot.running) {
      slot.running = true;
      try {
        await this.deps.run(key);
        this.runs.set(key, (this.runs.get(key) ?? 0) + 1);
      } catch (err) {
        this.deps.log?.(`background run of ${key} failed:`, err instanceof Error ? err.message : String(err));
      } finally {
        slot.running = false;
      }
    }
    if (this.slots.get(key) === slot) this.arm(key, slot);
  }
}
