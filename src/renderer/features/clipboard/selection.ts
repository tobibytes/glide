/** Pure helpers for the history grid and multi-select (unit-tested). */

/** Index after moving in a grid of `cols` columns; vertical moves keep the column and clamp at the ends. */
export function gridMove(index: number, length: number, cols: number, dir: "left" | "right" | "up" | "down"): number {
  if (length <= 0) return -1;
  const c = Math.max(1, cols);
  const i = Math.min(length - 1, Math.max(0, index));
  switch (dir) {
    case "left":
      return Math.max(0, i - 1);
    case "right":
      return Math.min(length - 1, i + 1);
    case "up":
      return i - c >= 0 ? i - c : i;
    case "down":
      // Last partial row: moving down from above it lands on its last cell.
      if (i + c < length) return i + c;
      return Math.floor(i / c) < Math.floor((length - 1) / c) ? length - 1 : i;
  }
}

/** Columns that fit `width` px with cells of at least `minCell` px. */
export function gridColumns(width: number, minCell = 116): number {
  return Math.max(1, Math.floor(width / minCell));
}

export function toggleMark(marked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(marked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** ⇧J / ⇧K: mark the current row (never unmark, so a sweep extends the selection). */
export function extendMark(marked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(marked);
  next.add(id);
  return next;
}

/** Keep only marks that are still visible. Returns the same set when nothing changed. */
export function pruneMarks(marked: Set<string>, ids: readonly string[]): Set<string> {
  if (!marked.size) return marked;
  const live = new Set(ids);
  const next = new Set([...marked].filter((id) => live.has(id)));
  return next.size === marked.size ? marked : next;
}
