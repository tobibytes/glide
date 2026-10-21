/** Pure note-list operations for Floating Notes. */
export interface Note {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface NotesFile {
  notes: Note[];
  currentId: string | null;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  chars: number;
}

export interface NotesState {
  notes: NoteSummary[];
  currentId: string | null;
}

export const EMPTY_FILE: NotesFile = { notes: [], currentId: null };

export function titleOf(body: string): string {
  const line = body.split("\n").map((l) => l.replace(/^#+\s*/, "").replace(/^[-*]\s+(\[[ x]\]\s+)?/, "").trim()).find(Boolean);
  return line ? (line.length > 60 ? `${line.slice(0, 60)}…` : line) : "Untitled Note";
}

export function summarize(n: Note): NoteSummary {
  const rest = n.body.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
  return { id: n.id, title: titleOf(n.body), preview: rest.slice(0, 120), updatedAt: n.updatedAt, chars: n.body.length };
}

export function newNote(now: number, body = ""): Note {
  return { id: `note-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, body, createdAt: now, updatedAt: now };
}

/** Notes are kept most-recently-created first, like a stack of sticky notes. */
export function addNote(file: NotesFile, note: Note): NotesFile {
  return { ...file, notes: [note, ...file.notes], currentId: note.id };
}

export function updateNote(file: NotesFile, id: string, body: string, now: number): NotesFile {
  return { ...file, notes: file.notes.map((n) => (n.id === id && n.body !== body ? { ...n, body, updatedAt: now } : n)) };
}

/** Remove a note; the current note moves to its neighbour (next, else previous). */
export function deleteNote(file: NotesFile, id: string): NotesFile {
  const idx = file.notes.findIndex((n) => n.id === id);
  if (idx < 0) return file;
  const notes = file.notes.filter((n) => n.id !== id);
  let currentId = file.currentId;
  if (currentId === id || !notes.some((n) => n.id === currentId)) currentId = notes[Math.min(idx, notes.length - 1)]?.id ?? null;
  return { ...file, notes, currentId };
}

/** Step through notes in list order, wrapping around. */
export function cycle(file: NotesFile, delta: number): string | null {
  if (!file.notes.length) return null;
  const idx = Math.max(0, file.notes.findIndex((n) => n.id === file.currentId));
  const next = (((idx + delta) % file.notes.length) + file.notes.length) % file.notes.length;
  return file.notes[next].id;
}

export function searchNotes(notes: Note[], query: string): Note[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!tokens.length) return sorted;
  const scored = sorted.flatMap((n) => {
    const title = titleOf(n.body).toLowerCase();
    const body = n.body.toLowerCase();
    if (!tokens.every((t) => body.includes(t))) return [];
    const score = tokens.reduce((s, t) => s + (title.startsWith(t) ? 3 : title.includes(t) ? 2 : 1), 0);
    return [{ n, score }];
  });
  return scored.sort((a, b) => b.score - a.score || b.n.updatedAt - a.n.updatedAt).map((x) => x.n);
}

export function sanitize(raw: unknown): NotesFile {
  if (!raw || typeof raw !== "object") return { ...EMPTY_FILE };
  const r = raw as Record<string, unknown>;
  const notes = Array.isArray(r.notes)
    ? r.notes.flatMap((n): Note[] => {
        if (!n || typeof n !== "object") return [];
        const o = n as Record<string, unknown>;
        if (typeof o.id !== "string" || typeof o.body !== "string") return [];
        return [{ id: o.id, body: o.body, createdAt: Number(o.createdAt) || 0, updatedAt: Number(o.updatedAt) || 0 }];
      })
    : [];
  const b = r.bounds as Record<string, unknown> | undefined;
  const bounds = b && ["x", "y", "width", "height"].every((k) => typeof b[k] === "number") ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } : undefined;
  const currentId = typeof r.currentId === "string" && notes.some((n) => n.id === r.currentId) ? r.currentId : (notes[0]?.id ?? null);
  return { notes, currentId, bounds };
}
