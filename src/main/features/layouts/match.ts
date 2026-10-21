/** Pure restore planning: pair saved windows with live ones and map frames across display changes. */
import type { LiveWindow, Rect, SavedDisplay, SavedWindow } from "./model";

export type MatchHow = "title" | "similar" | "order";

export interface PlannedMove {
  ref: number;
  frame: Rect;
  saved: SavedWindow;
  how: MatchHow;
}

const EDITED = /\s*[—–-]\s*(edited|modified)\s*$/i;

/** Lowercase, drop "— Edited" suffixes and unsaved-change bullets, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .replace(EDITED, "")
    .replace(/^[●•*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const tokens = (s: string) => new Set(s.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));

/** 0…1. Equal normalized titles = 1; containment = 0.8; otherwise token Jaccard. */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if ((x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y))) return 0.8;
  const tx = tokens(x);
  const ty = tokens(y);
  if (!tx.size || !ty.size) return 0;
  let common = 0;
  for (const t of tx) if (ty.has(t)) common++;
  return common / (tx.size + ty.size - common);
}

export const SIMILAR_THRESHOLD = 0.5;

function groupBy<T>(items: T[], key: (t: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    const list = m.get(k) ?? [];
    list.push(it);
    m.set(k, list);
  }
  return m;
}

/**
 * Per app: exact (normalized) title first, then the most similar title above SIMILAR_THRESHOLD,
 * then whatever is left pairs up by front-to-back order. Full-screen live windows are never moved.
 */
export function matchWindows(saved: SavedWindow[], live: LiveWindow[]): { pairs: Array<{ saved: SavedWindow; live: LiveWindow; how: MatchHow }>; unmatched: SavedWindow[] } {
  const pairs: Array<{ saved: SavedWindow; live: LiveWindow; how: MatchHow }> = [];
  const unmatched: SavedWindow[] = [];
  const liveByApp = groupBy(live.filter((w) => !w.fullScreen), (w) => w.bundleId);
  for (const [bundleId, savedList] of groupBy(saved, (w) => w.bundleId)) {
    const s = [...savedList].sort((a, b) => a.order - b.order);
    const l = [...(liveByApp.get(bundleId) ?? [])].sort((a, b) => a.order - b.order);
    const usedS = new Set<number>();
    const usedL = new Set<number>();
    const take = (i: number, j: number, how: MatchHow) => {
      usedS.add(i);
      usedL.add(j);
      pairs.push({ saved: s[i]!, live: l[j]!, how });
    };
    s.forEach((sw, i) => {
      const t = normalizeTitle(sw.title);
      if (!t) return;
      const j = l.findIndex((lw, j2) => !usedL.has(j2) && normalizeTitle(lw.title) === t);
      if (j >= 0) take(i, j, "title");
    });
    const candidates: Array<{ i: number; j: number; score: number }> = [];
    s.forEach((sw, i) => {
      if (usedS.has(i)) return;
      l.forEach((lw, j) => {
        if (usedL.has(j)) return;
        const score = titleSimilarity(sw.title, lw.title);
        if (score >= SIMILAR_THRESHOLD) candidates.push({ i, j, score });
      });
    });
    candidates.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
    for (const c of candidates) if (!usedS.has(c.i) && !usedL.has(c.j)) take(c.i, c.j, "similar");
    const restL = l.map((_, j) => j).filter((j) => !usedL.has(j));
    s.forEach((sw, i) => {
      if (usedS.has(i)) return;
      const j = restL.shift();
      if (j === undefined) unmatched.push(sw);
      else take(i, j, "order");
    });
  }
  return { pairs, unmatched };
}

const sameSize = (a: Rect, b: Rect) => Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
const sameRect = (a: Rect, b: Rect) => sameSize(a, b) && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

/** The live display that best corresponds to a saved one: UUID, then id+size, then same size, then main. */
export function findDisplay(saved: SavedDisplay | undefined, live: SavedDisplay[]): SavedDisplay | undefined {
  if (!live.length) return undefined;
  const main = live.find((d) => d.main) ?? live[0];
  if (!saved) return main;
  return (
    (saved.uuid ? live.find((d) => d.uuid === saved.uuid) : undefined) ??
    live.find((d) => d.id === saved.id && sameSize(d.frame, saved.frame)) ??
    live.find((d) => sameRect(d.frame, saved.frame)) ??
    live.find((d) => sameSize(d.frame, saved.frame)) ??
    (saved.main ? main : undefined) ??
    main
  );
}

function clampInto(r: Rect, area: Rect): Rect {
  const width = Math.min(r.width, area.width);
  const height = Math.min(r.height, area.height);
  const x = Math.min(Math.max(r.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(r.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * Where a saved frame should go now. Same display at the same place → unchanged.
 * Otherwise the frame keeps its position/size relative to the visible area and is scaled onto the target display.
 */
export function mapFrame(frame: Rect, savedDisplay: SavedDisplay | undefined, live: SavedDisplay[]): Rect {
  const target = findDisplay(savedDisplay, live);
  if (!target) return frame;
  if (savedDisplay && sameRect(target.frame, savedDisplay.frame)) {
    // Same geometry: keep it exact unless the visible area shrank (Dock moved) and the window no longer fits.
    const v = target.visible;
    const fits = frame.x >= target.frame.x && frame.y >= target.frame.y && frame.x + frame.width <= target.frame.x + target.frame.width && frame.y + frame.height <= target.frame.y + target.frame.height;
    return fits ? frame : clampInto(frame, v);
  }
  const from = savedDisplay?.visible ?? target.visible;
  const to = target.visible;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const scaled: Rect = {
    x: to.x + (frame.x - from.x) * sx,
    y: to.y + (frame.y - from.y) * sy,
    width: frame.width * sx,
    height: frame.height * sy,
  };
  return clampInto(scaled, to);
}

export function planRestore(saved: { windows: SavedWindow[]; displays: SavedDisplay[] }, live: LiveWindow[], liveDisplays: SavedDisplay[]): { moves: PlannedMove[]; unmatched: SavedWindow[] } {
  const { pairs, unmatched } = matchWindows(saved.windows, live);
  const moves = pairs.map(({ saved: sw, live: lw, how }) => ({ ref: lw.ref, frame: mapFrame(sw.frame, saved.displays[sw.display], liveDisplays), saved: sw, how }));
  return { moves, unmatched };
}

/** Saved apps (bundle ids) that have no live window right now. */
export function missingApps(saved: SavedWindow[], live: LiveWindow[], runningBundleIds: Iterable<string>): string[] {
  const running = new Set(runningBundleIds);
  const withWindows = new Set(live.map((w) => w.bundleId));
  const out: string[] = [];
  for (const w of saved) if (!out.includes(w.bundleId) && (!running.has(w.bundleId) || !withWindows.has(w.bundleId))) out.push(w.bundleId);
  return out;
}
