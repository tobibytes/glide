/**
 * Global hotkeys for the launcher, per-item hotkeys and feature hotkeys.
 *
 * Backends: the Swift helper ("hotkeys.set": Carbon RegisterEventHotKey, plus modifier-only/double-tap
 * shortcuts via an event tap) when it is running, else Electron's globalShortcut. While the helper is
 * starting the manager waits briefly (startupGraceMs) instead of grabbing keys twice; if the helper is
 * missing or stays down, it falls back to Electron and moves back once the helper answers again. A helper
 * restart loses its registrations, so they are re-sent whenever it becomes available again.
 *
 * Headless: the helper is never called; native registrations are recorded as "[headless] hotkey.register".
 * No electron import here so the module is unit-testable.
 */
import type { HotkeySetResult, NativeHelper } from "./native/helper";
import { parseAccelerator, type ParsedAccelerator } from "./hotkey-accelerator";

export interface ShortcutBackend {
  register(accelerator: string, handler: () => void): boolean;
  unregister(accelerator: string): void;
}

export type HotkeyBackend = "pending" | "native" | "electron";

export interface HotkeyState {
  id: string;
  accelerator: string;
  state: "pending" | "active" | "failed";
  reason?: string;
  /** Active, but an enabled macOS shortcut uses the same keys. */
  warning?: string;
}

export interface HotkeyStatus {
  backend: HotkeyBackend;
  hotkeys: HotkeyState[];
}

export interface HotkeyManagerDeps {
  helper?: NativeHelper | null;
  electron: ShortcutBackend;
  headless?: boolean;
  record?: (kind: string, detail: unknown) => void;
  log?: (...args: unknown[]) => void;
  pollMs?: number;
  startupGraceMs?: number;
  now?: () => number;
}

export interface HotkeyManager {
  /** Replace every hotkey in `group`; returns accelerators known to have failed right now. */
  sync(group: string, bindings: Array<{ accel: string; handler: () => void }>): string[];
  /** Set or clear (null) one slot; false when it is known to have failed. */
  set(slot: string, accelerator: string | null, handler: () => void): boolean;
  status(): HotkeyStatus;
  /** True when this accelerator is registered (or recorded, in headless mode). */
  isActive(accelerator: string): boolean;
  /** Resolves once pending registrations have an answer (at most ~startupGraceMs + 2 s). */
  settled(): Promise<void>;
  dispose(): void;
}

interface Entry {
  id: string;
  group: string;
  accel: string;
  parsed: ParsedAccelerator | null;
  handler: () => void;
  state: HotkeyState["state"];
  reason?: string;
  warning?: string;
  /** Failed before reaching a backend (parse error or duplicate). */
  local?: boolean;
}

const NEEDS_INPUT_MONITORING = "needs Input Monitoring";

export function createHotkeyManager(deps: HotkeyManagerDeps): HotkeyManager {
  const helper = deps.helper ?? null;
  const log = deps.log ?? ((...a: unknown[]) => console.warn("[hotkeys]", ...a));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 250;
  const grace = deps.startupGraceMs ?? 1500;
  const record = deps.record ?? ((kind: string, detail: unknown) => console.log(`[headless] ${kind} ${JSON.stringify(detail)}`));

  const entries = new Map<string, Entry>(); // insertion order = priority for duplicates
  const electronOwned = new Map<string, string>(); // id -> accelerator registered with Electron
  let headlessSent = new Map<string, string>(); // id -> canonical last recorded
  let backend: HotkeyBackend = helper ? "pending" : "electron";
  const startedAt = now();
  let downSince: number | null = null;
  let inFlight = false;
  let dirty = false;
  let disposed = false;
  let waiters: Array<() => void> = [];
  const loggedFailures = new Map<string, string>();

  const parsedOf = (accel: string) => {
    const p = parseAccelerator(accel);
    return "error" in p ? { parsed: null, error: p.error } : { parsed: p, error: null };
  };

  /** Parse errors and duplicates (`local` failures), recomputed on every change. */
  const validate = () => {
    const seen = new Set<string>();
    for (const e of entries.values()) {
      const { parsed, error } = parsedOf(e.accel);
      e.parsed = parsed;
      e.warning = undefined;
      const localError = !parsed ? (error ?? "Invalid shortcut") : seen.has(parsed.canonical) ? "used by another Glide hotkey" : null;
      if (parsed) seen.add(parsed.canonical);
      if (localError) {
        e.local = true;
        e.state = "failed";
        e.reason = localError;
      } else if (e.local) {
        e.local = false;
        e.state = "pending";
        e.reason = undefined;
      }
    }
  };

  const candidates = () => [...entries.values()].filter((e) => !e.local);

  const reportFailures = () => {
    for (const e of entries.values()) {
      if (e.state !== "failed") {
        loggedFailures.delete(e.id);
        continue;
      }
      const key = `${e.accel}|${e.reason}`;
      if (loggedFailures.get(e.id) === key) continue;
      loggedFailures.set(e.id, key);
      log(`could not register ${e.accel}: ${e.reason}`);
    }
  };

  const checkSettled = () => {
    if (backend === "pending" || inFlight || dirty) return;
    const w = waiters;
    waiters = [];
    for (const resolve of w) resolve();
  };

  // --- Electron backend ---
  const releaseElectron = (keep: (id: string, accel: string) => boolean = () => false) => {
    for (const [id, accel] of electronOwned) {
      if (keep(id, accel)) continue;
      deps.electron.unregister(accel);
      electronOwned.delete(id);
    }
  };

  const applyElectron = () => {
    const wanted = new Map<string, string>();
    for (const e of candidates()) {
      if (e.parsed?.kind === "combo") wanted.set(e.id, e.parsed.canonical);
    }
    releaseElectron((id, accel) => wanted.get(id) === accel);
    for (const e of candidates()) {
      if (e.parsed?.kind !== "combo") {
        e.state = "failed";
        e.reason = "modifier-only shortcuts need the Glide helper";
        continue;
      }
      const accel = e.parsed.canonical;
      if (electronOwned.get(e.id) === accel) {
        e.state = "active";
        continue;
      }
      let ok = false;
      try {
        ok = deps.electron.register(accel, () => entries.get(e.id)?.handler());
      } catch {
        ok = false;
      }
      if (ok) {
        electronOwned.set(e.id, accel);
        e.state = "active";
        e.reason = undefined;
      } else {
        e.state = "failed";
        e.reason = "in use by another app";
      }
    }
  };

  // --- Native backend ---
  const applyHeadless = () => {
    const next = new Map<string, string>();
    for (const e of candidates()) {
      const canonical = e.parsed!.canonical;
      next.set(e.id, canonical);
      if (headlessSent.get(e.id) !== canonical) record("hotkey.register", { id: e.id, accelerator: canonical });
      e.state = "active";
      e.reason = undefined;
    }
    for (const [id, canonical] of headlessSent) if (!next.has(id)) record("hotkey.unregister", { id, accelerator: canonical });
    headlessSent = next;
  };

  const applyNative = () => {
    if (!helper) return;
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    dirty = false;
    const sent = candidates();
    for (const e of sent) if (e.state !== "active") e.state = "pending";
    const bindings = sent.map((e) => ({ id: e.id, accelerator: e.parsed!.canonical }));
    const sentAccel = new Map(sent.map((e) => [e.id, e.accel]));
    helper
      .call("hotkeys.set", { bindings })
      .then((result) => applyResult(result, sentAccel))
      .catch((err: unknown) => {
        // Helper died mid-call: the tick re-sends once it is back (or falls back to Electron).
        for (const e of sent) if (entries.get(e.id) === e && e.state === "pending") e.reason = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        inFlight = false;
        if (dirty && !disposed && backend === "native") applyNative();
        reportFailures();
        checkSettled();
      });
  };

  const applyResult = (result: HotkeySetResult, sentAccel: Map<string, string>) => {
    const fresh = (id: string) => {
      const e = entries.get(id);
      return e && sentAccel.get(id) === e.accel ? e : undefined;
    };
    for (const id of result.registered ?? []) {
      const e = fresh(id);
      if (e) {
        e.state = "active";
        e.reason = undefined;
      }
    }
    for (const f of result.failed ?? []) {
      const e = fresh(f.id);
      if (e) {
        e.state = "failed";
        e.reason = f.reason;
      }
    }
    for (const c of result.conflicts ?? []) {
      const e = fresh(c.id);
      if (e) e.warning = c.reason;
    }
  };

  const apply = () => {
    if (disposed) return;
    validate();
    if (backend === "electron") applyElectron();
    else if (backend === "native") {
      releaseElectron();
      if (deps.headless) applyHeadless();
      else applyNative();
    } else for (const e of entries.values()) if (e.state !== "failed") e.state = "pending";
    reportFailures();
    checkSettled();
  };

  const switchTo = (next: HotkeyBackend) => {
    if (backend === next) return;
    backend = next;
    if (next !== "native") headlessSent = new Map();
    apply();
  };

  // --- Backend selection ---
  const tick = () => {
    if (disposed || !helper) return;
    const up = helper.available();
    const t = now();
    if (up) {
      const restarted = downSince !== null;
      downSince = null;
      if (backend !== "native") switchTo("native");
      else if (restarted) apply();
      return;
    }
    if (backend === "pending") {
      if (t - startedAt >= grace) switchTo("electron");
      return;
    }
    if (backend === "native") {
      downSince ??= t;
      if (t - downSince >= grace) switchTo("electron");
    } else {
      downSince ??= t;
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const offs: Array<() => void> = [];
  if (helper) {
    timer = setInterval(tick, pollMs);
    (timer as { unref?: () => void }).unref?.();
    offs.push(
      helper.on("hotkey.pressed", (data) => {
        if (backend !== "native" || deps.headless) return;
        entries.get(data?.id)?.handler();
      }),
      helper.on("hotkeys.changed", (result) => {
        if (backend !== "native" || deps.headless) return;
        applyResult(result, new Map([...entries.values()].map((e) => [e.id, e.accel])));
        reportFailures();
      }),
      helper.on("permissions.changed", () => {
        if (backend === "native" && [...entries.values()].some((e) => e.reason === NEEDS_INPUT_MONITORING)) apply();
      }),
    );
    // Fast path: a missing binary rejects immediately; a running one answers in a few ms.
    helper.call("ping").then(
      () => tick(),
      (err: unknown) => {
        if (/not installed/i.test(err instanceof Error ? err.message : String(err)) && backend === "pending") switchTo("electron");
      },
    );
  }

  const stateOf = (e: Entry): HotkeyState => ({
    id: e.id,
    accelerator: e.accel,
    state: e.state,
    ...(e.reason && e.state !== "active" ? { reason: e.reason } : {}),
    ...(e.warning ? { warning: e.warning } : {}),
  });

  return {
    sync(group, bindings) {
      for (const [id, e] of entries) if (e.group === group) entries.delete(id);
      const seen = new Set<string>();
      for (const b of bindings) {
        const accel = b.accel.trim();
        if (!accel) continue;
        const key = parsedOf(accel).parsed?.canonical ?? accel.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const id = `${group}:${key}`;
        entries.set(id, { id, group, accel, parsed: null, handler: b.handler, state: "pending" });
      }
      apply();
      return [...entries.values()].filter((e) => e.group === group && e.state === "failed").map((e) => e.accel);
    },
    set(slot, accelerator, handler) {
      const id = `feature:${slot}`;
      const accel = accelerator?.trim();
      const previous = entries.get(id);
      if (!accel) {
        if (previous) {
          entries.delete(id);
          apply();
        }
        return true;
      }
      if (previous && previous.accel === accel) {
        previous.handler = handler;
        return previous.state !== "failed";
      }
      entries.delete(id);
      entries.set(id, { id, group: "feature", accel, parsed: null, handler, state: "pending" });
      apply();
      return entries.get(id)?.state !== "failed";
    },
    status: () => ({ backend, hotkeys: [...entries.values()].map(stateOf) }),
    isActive(accelerator) {
      const canonical = parsedOf(accelerator).parsed?.canonical;
      return [...entries.values()].some((e) => e.state === "active" && e.parsed?.canonical === canonical);
    },
    settled() {
      return new Promise<void>((resolve) => {
        const t = setTimeout(resolve, grace + 2000);
        (t as { unref?: () => void }).unref?.();
        waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
        checkSettled();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      for (const off of offs) off();
      releaseElectron();
      if (backend === "native" && helper && !deps.headless && helper.available()) void helper.call("hotkeys.set", { bindings: [] }).catch(() => undefined);
      entries.clear();
      const w = waiters;
      waiters = [];
      for (const resolve of w) resolve();
    },
  };
}
