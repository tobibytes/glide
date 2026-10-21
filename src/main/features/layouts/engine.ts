/** Save / restore orchestration over the helper. Dependencies are injected so tests can fake the helper. */
import type { NativeHelper } from "../../native/helper";
import { layoutApps, layoutFromCapture, type AppRef, type Layout, type LiveWindow, type SavedDisplay } from "./model";
import { missingApps, planRestore, type PlannedMove } from "./match";

export const NEEDS_ACCESSIBILITY = "Window layouts need Accessibility permission. Open System Settings → Privacy & Security → Accessibility and enable Glide.";

export interface EngineDeps {
  helper: Pick<NativeHelper, "available" | "call">;
  /** Launch (or reopen) an app; resolves when the launch request was made. */
  launch(app: AppRef): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RestoreReport {
  ok: boolean;
  error?: string;
  moved: number;
  total: number;
  launched: string[];
  unmatched: Array<{ appName: string; title: string }>;
  failed: Array<{ appName: string; title: string; error: string }>;
}

async function capture(deps: EngineDeps): Promise<{ windows: LiveWindow[]; displays: SavedDisplay[] }> {
  if (!deps.helper.available()) throw new Error("Window layouts need the Glide helper, which is not running.");
  const r = await deps.helper.call("layouts.capture", {});
  if (!r.ok) throw new Error(r.error === "Accessibility permission required" ? NEEDS_ACCESSIBILITY : (r.error ?? "Could not read windows"));
  return { windows: r.windows ?? [], displays: r.displays ?? [] };
}

export async function captureLayout(deps: EngineDeps, name: string, id?: string): Promise<Layout> {
  const { windows, displays } = await capture(deps);
  const layout = layoutFromCapture(name, displays, windows, deps.now(), id);
  if (!layout.windows.length) throw new Error("No windows to save — open some app windows first.");
  return layout;
}

const countByApp = (ws: Array<{ bundleId: string | null }>) => {
  const m = new Map<string, number>();
  for (const w of ws) if (w.bundleId) m.set(w.bundleId, (m.get(w.bundleId) ?? 0) + 1);
  return m;
};

export interface RestoreOptions {
  relaunch: boolean;
  /** Max wait for relaunched apps' windows. */
  launchTimeoutMs: number;
  /** Extra apps launched by a workspace whose windows should exist before moving. */
  alsoWaitFor?: string[];
}

export async function restoreLayout(deps: EngineDeps, layout: Layout, opts: RestoreOptions): Promise<RestoreReport> {
  const report: RestoreReport = { ok: true, moved: 0, total: layout.windows.length, launched: [], unmatched: [], failed: [] };
  let live: { windows: LiveWindow[]; displays: SavedDisplay[] };
  try {
    live = await capture(deps);
  } catch (err) {
    return { ...report, ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const waitFor = new Set(opts.alsoWaitFor ?? []);
  if (opts.relaunch) {
    const running = await deps.helper.call("layouts.apps").catch(() => []);
    const missing = missingApps(layout.windows, live.windows, running.map((a) => a.bundleId ?? ""));
    const apps = layoutApps(layout).filter((a) => missing.includes(a.bundleId));
    for (const app of apps) {
      try {
        await deps.launch(app);
        report.launched.push(app.name);
        waitFor.add(app.bundleId);
      } catch (err) {
        report.failed.push({ appName: app.name, title: "", error: `Could not launch: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  if (waitFor.size) {
    const wanted = countByApp(layout.windows.filter((w) => waitFor.has(w.bundleId)));
    for (const id of waitFor) if (!wanted.has(id)) wanted.set(id, 1);
    const deadline = deps.now() + opts.launchTimeoutMs;
    for (;;) {
      const have = countByApp(live.windows);
      if ([...wanted].every(([id, n]) => (have.get(id) ?? 0) >= n) || deps.now() >= deadline) break;
      await deps.sleep(400);
      live = await capture(deps).catch(() => live);
    }
    // Freshly launched windows keep animating into place for a moment.
    await deps.sleep(300);
    live = await capture(deps).catch(() => live);
  }

  const { moves, unmatched } = planRestore(layout, live.windows, live.displays);
  report.unmatched = unmatched.map((w) => ({ appName: w.appName, title: w.title }));
  const results = await applyMoves(deps, moves);
  // Windows crossing displays sometimes land clamped on the first try; retry those once.
  const retry = moves.filter((m) => {
    const r = results.get(m.ref);
    return r?.ok && r.frame && !close(r.frame, m.frame);
  });
  if (retry.length) {
    await deps.sleep(150);
    for (const [ref, r] of await applyMoves(deps, retry)) results.set(ref, r);
  }
  for (const m of moves) {
    const r = results.get(m.ref);
    if (r?.ok) report.moved++;
    else report.failed.push({ appName: m.saved.appName, title: m.saved.title, error: r?.error ?? "Not moved" });
  }
  return report;
}

const close = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

async function applyMoves(deps: EngineDeps, moves: PlannedMove[]) {
  const out = new Map<number, { ok: boolean; error?: string; frame?: { x: number; y: number; width: number; height: number } }>();
  if (!moves.length) return out;
  const r = await deps.helper.call("layouts.move", { moves: moves.map((m) => ({ ref: m.ref, frame: m.frame })) });
  if (!r.ok) {
    for (const m of moves) out.set(m.ref, { ok: false, error: r.error ?? "Move failed" });
    return out;
  }
  for (const res of r.results ?? []) out.set(res.ref, res);
  return out;
}

export function summarize(name: string, r: RestoreReport): string {
  if (!r.ok) return r.error ?? "Could not restore the layout";
  const parts = [`Restored ${name}: ${r.moved}/${r.total} windows`];
  if (r.launched.length) parts.push(`launched ${r.launched.join(", ")}`);
  if (r.unmatched.length) parts.push(`${r.unmatched.length} not open`);
  return parts.join(" · ");
}
