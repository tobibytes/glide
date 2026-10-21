/** Pure 2-D navigation over a sectioned grid (sections wrap into rows of `columns`). */
export interface GridSection<T> {
  id: string;
  title: string;
  items: T[];
}

export interface GridRow<T> {
  section: string;
  title: string;
  /** first row of its section (render the header above it) */
  first: boolean;
  items: T[];
}

export interface Pos {
  row: number;
  col: number;
}

export function layoutRows<T>(sections: GridSection<T>[], columns: number): GridRow<T>[] {
  const rows: GridRow<T>[] = [];
  for (const s of sections) {
    for (let i = 0; i < s.items.length; i += columns) rows.push({ section: s.id, title: s.title, first: i === 0, items: s.items.slice(i, i + columns) });
  }
  return rows;
}

export type Move = "left" | "right" | "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "nextSection" | "prevSection";

export function clampPos<T>(rows: GridRow<T>[], p: Pos): Pos {
  if (!rows.length) return { row: 0, col: 0 };
  const row = Math.min(rows.length - 1, Math.max(0, p.row));
  return { row, col: Math.min(rows[row].items.length - 1, Math.max(0, p.col)) };
}

export function move<T>(rows: GridRow<T>[], p: Pos, m: Move, page = 5): Pos {
  if (!rows.length) return { row: 0, col: 0 };
  const cur = clampPos(rows, p);
  switch (m) {
    case "left":
      if (cur.col > 0) return { row: cur.row, col: cur.col - 1 };
      return cur.row > 0 ? { row: cur.row - 1, col: rows[cur.row - 1].items.length - 1 } : cur;
    case "right":
      if (cur.col < rows[cur.row].items.length - 1) return { row: cur.row, col: cur.col + 1 };
      return cur.row < rows.length - 1 ? { row: cur.row + 1, col: 0 } : cur;
    case "up":
      return clampPos(rows, { row: cur.row - 1, col: cur.col });
    case "down":
      return clampPos(rows, { row: cur.row + 1, col: cur.col });
    case "pageUp":
      return clampPos(rows, { row: cur.row - page, col: cur.col });
    case "pageDown":
      return clampPos(rows, { row: cur.row + page, col: cur.col });
    case "home":
      return { row: 0, col: 0 };
    case "end": {
      const last = rows.length - 1;
      return { row: last, col: rows[last].items.length - 1 };
    }
    case "nextSection": {
      const idx = rows.findIndex((r, i) => i > cur.row && r.first);
      return idx >= 0 ? { row: idx, col: 0 } : cur;
    }
    case "prevSection": {
      // Start of the current section, or of the previous one when already there.
      let start = cur.row;
      while (start > 0 && !rows[start].first) start--;
      if (start < cur.row || cur.col > 0) return { row: start, col: 0 };
      let prev = start - 1;
      while (prev > 0 && !rows[prev].first) prev--;
      return prev >= 0 ? { row: prev, col: 0 } : cur;
    }
  }
}

/** Map a key event to a grid move. Ctrl+H/J/K/L always; bare h/j/k/l only in vim normal mode. */
export function keyToMove(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, normalMode: boolean): Move | null {
  const { key } = e;
  if (e.metaKey) {
    if (key === "ArrowDown") return "nextSection";
    if (key === "ArrowUp") return "prevSection";
    return null;
  }
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowUp") return e.altKey ? "pageUp" : "up";
  if (key === "ArrowDown") return e.altKey ? "pageDown" : "down";
  if (key === "PageUp") return "pageUp";
  if (key === "PageDown") return "pageDown";
  const vim: Record<string, Move> = { h: "left", j: "down", k: "up", l: "right" };
  if (e.ctrlKey) {
    if (vim[key]) return vim[key];
    if (key === "n") return "down";
    if (key === "p") return "up";
    if (key === "d") return "pageDown";
    if (key === "u") return "pageUp";
    return null;
  }
  if (normalMode && !e.altKey) {
    if (vim[key]) return vim[key];
    if (key === "G") return "end";
    if (key === "}") return "nextSection";
    if (key === "{") return "prevSection";
  }
  return null;
}
