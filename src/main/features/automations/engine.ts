/**
 * The automation engine: owns the list, schedules time/interval triggers on tick(), matches events
 * from the sources, enforces the per-automation rate limit, asks for confirmation, runs and logs.
 * Everything with side effects (clock, runner, confirmation UI, disk) is injected so tests can fake it.
 */
import { describeEvent, describeTrigger, LOG_LIMIT, matchEvent, newId, RATE_LIMIT_MS, validateAutomation, type Automation, type RunRecord, type TriggerEvent } from "./model";
import { dueDecision, nextFire } from "./schedule";

export interface RunOutcome {
  ok: boolean;
  message: string;
}

export interface EngineDeps {
  now(): number;
  run(a: Automation, input: string): Promise<RunOutcome>;
  /** Resolve true to run, false to skip ("ask before running"). */
  confirm(a: Automation, input: string, reason: string): Promise<boolean>;
  persist(list: Automation[]): void;
  /** Called after any change (list edit, run start/finish). */
  changed?(list: Automation[]): void;
  home?: string;
  rateLimitMs?: number;
  /** How late a scheduled run may still fire (default 2 min). */
  lateGraceMs?: number;
}

export type FireResult = RunRecord | "disabled" | "rate-limited" | "busy" | "missing";

export class AutomationEngine {
  private list: Automation[];
  private nextAt = new Map<string, number>();
  private lastTriggerAt = new Map<string, number>();
  private running = new Set<string>();
  private readonly rateLimitMs: number;
  private readonly graceMs: number;

  constructor(
    private readonly deps: EngineDeps,
    initial: Automation[] = [],
  ) {
    this.list = initial;
    this.rateLimitMs = deps.rateLimitMs ?? RATE_LIMIT_MS;
    this.graceMs = deps.lateGraceMs ?? 120_000;
  }

  all(): Automation[] {
    return this.list;
  }

  get(id: string): Automation | undefined {
    return this.list.find((a) => a.id === id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Next scheduled fire time (time/interval triggers of enabled automations), else null. */
  nextRun(id: string): number | null {
    const a = this.get(id);
    if (!a?.enabled) return null;
    return this.scheduleFor(a);
  }

  /** Create or replace (keeps the existing log and createdAt). Returns the validation error, if any. */
  upsert(raw: unknown): { ok: true; automation: Automation } | { ok: false; error: string } {
    const now = this.deps.now();
    const res = validateAutomation(raw, now);
    if (!res.ok) return res;
    const prev = this.get(res.automation.id);
    const automation: Automation = { ...res.automation, createdAt: prev?.createdAt ?? now, updatedAt: now, log: prev?.log ?? [] };
    this.list = prev ? this.list.map((a) => (a.id === automation.id ? automation : a)) : [...this.list, automation];
    // A trigger edit or re-enable restarts the schedule from now.
    if (!prev || JSON.stringify(prev.trigger) !== JSON.stringify(automation.trigger) || prev.enabled !== automation.enabled) this.nextAt.delete(automation.id);
    this.commit();
    return { ok: true, automation };
  }

  remove(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((a) => a.id !== id);
    this.nextAt.delete(id);
    this.lastTriggerAt.delete(id);
    if (this.list.length !== before) this.commit();
    return this.list.length !== before;
  }

  setEnabled(id: string, enabled: boolean): Automation | undefined {
    const a = this.get(id);
    if (!a) return undefined;
    if (a.enabled === enabled) return a;
    const next = { ...a, enabled, updatedAt: this.deps.now() };
    this.list = this.list.map((x) => (x.id === id ? next : x));
    this.nextAt.delete(id);
    this.commit();
    return next;
  }

  clearLog(id: string): void {
    this.list = this.list.map((a) => (a.id === id ? { ...a, log: [] } : a));
    this.commit();
  }

  /** Check time/interval schedules; call every second or two. Resolves when the runs it started finish. */
  async tick(): Promise<FireResult[]> {
    const now = this.deps.now();
    const fires: Promise<FireResult>[] = [];
    for (const a of this.list) {
      if (!a.enabled) continue;
      const at = this.scheduleFor(a);
      if (at === null) continue;
      const decision = dueDecision(at, now, this.graceMs);
      if (decision === "wait") continue;
      // Reschedule from now so a late tick never double-fires the same slot.
      this.nextAt.set(a.id, nextFire(a.trigger, now) ?? Number.POSITIVE_INFINITY);
      if (decision === "fire") fires.push(this.fire(a.id, "", describeTrigger(a.trigger)));
    }
    return Promise.all(fires);
  }

  /** Feed an event from a source; fires every matching enabled automation. */
  async handleEvent(event: TriggerEvent): Promise<FireResult[]> {
    const fires: Promise<FireResult>[] = [];
    for (const a of this.list) {
      if (!a.enabled) continue;
      const input = matchEvent(a.trigger, event, a.id, this.deps.home ?? "");
      if (input === null) continue;
      fires.push(this.fire(a.id, input, `${describeTrigger(a.trigger)} · ${describeEvent(event)}`));
    }
    return Promise.all(fires);
  }

  /** Run Now from the UI: ignores enabled/ask/rate limit, but never overlaps a run in progress. */
  runNow(id: string, input = ""): Promise<FireResult> {
    return this.fire(id, input, "Run Now", true);
  }

  async fire(id: string, input: string, reason: string, manual = false): Promise<FireResult> {
    const a = this.get(id);
    if (!a) return "missing";
    if (this.running.has(id)) return "busy";
    const now = this.deps.now();
    if (!manual) {
      if (!a.enabled) return "disabled";
      const last = this.lastTriggerAt.get(id);
      if (last !== undefined && now - last < this.rateLimitMs) return "rate-limited";
    }
    this.lastTriggerAt.set(id, now);
    this.running.add(id);
    this.deps.changed?.(this.list);
    try {
      if (!manual && a.askBeforeRunning) {
        let yes = false;
        try {
          yes = await this.deps.confirm(a, input, reason);
        } catch {
          yes = false;
        }
        if (!yes) return this.record(id, { at: now, trigger: reason, status: "skipped", message: "Skipped — not confirmed", input, durationMs: this.deps.now() - now });
      }
      const started = this.deps.now();
      let outcome: RunOutcome;
      try {
        outcome = await this.deps.run(a, input);
      } catch (err) {
        outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      return this.record(id, { at: started, trigger: reason, status: outcome.ok ? "ok" : "error", message: outcome.message, input, durationMs: this.deps.now() - started, manual: manual || undefined });
    } finally {
      this.running.delete(id);
      this.deps.changed?.(this.list);
    }
  }

  private scheduleFor(a: Automation): number | null {
    const cached = this.nextAt.get(a.id);
    if (cached !== undefined) return cached;
    const at = nextFire(a.trigger, this.deps.now());
    if (at !== null) this.nextAt.set(a.id, at);
    return at;
  }

  private record(id: string, rec: Omit<RunRecord, "id">): RunRecord {
    const full: RunRecord = { id: newId("r", rec.at), ...rec, input: rec.input || undefined };
    this.list = this.list.map((a) => (a.id === id ? { ...a, log: [full, ...a.log].slice(0, LOG_LIMIT) } : a));
    this.commit();
    return full;
  }

  private commit() {
    this.deps.persist(this.list);
    this.deps.changed?.(this.list);
  }
}
