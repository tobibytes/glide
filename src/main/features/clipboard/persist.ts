/** history.json persistence: atomic (tmp + rename) and debounced. Clipboard data never leaves this file. */
import fs from "node:fs";
import path from "node:path";
import type { ClipEntry } from "./model";

interface FileShape {
  version: 1;
  entries: ClipEntry[];
}

const isEntry = (v: unknown): v is ClipEntry => {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<ClipEntry>;
  return typeof e.id === "string" && typeof e.key === "string" && typeof e.type === "string" && typeof e.lastCopiedAt === "number";
};

export function loadHistory(file: string): ClipEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<FileShape>;
    return Array.isArray(raw.entries) ? raw.entries.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // 0600: the history can contain anything the user copied.
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface HistoryWriter {
  schedule(entries: () => ClipEntry[]): void;
  flush(): void;
}

export function createWriter(file: string, delayMs = 600): HistoryWriter {
  let timer: NodeJS.Timeout | null = null;
  let pending: (() => ClipEntry[]) | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const get = pending;
    pending = null;
    try {
      const shape: FileShape = { version: 1, entries: get() };
      writeAtomic(file, JSON.stringify(shape));
    } catch (err) {
      console.warn("[clipboard] could not save history:", err);
    }
  };
  return {
    schedule(entries) {
      pending = entries;
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}
