/**
 * Incremental changes between compactions, one JSON op per line in
 * index.journal (append-only; replayed on load, truncated by compaction).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FileIndexDb } from "./db";

export type JournalOp =
  | { o: "u"; p: string; d: 0 | 1; s: number; m: number; a: number } // upsert
  | { o: "r"; p: string }; // remove (with descendants)

export function upsertOp(p: string, isDir: boolean, size: number, mtime: number, atime: number): JournalOp {
  return { o: "u", p, d: isDir ? 1 : 0, s: size, m: mtime, a: atime };
}

/** Apply one op; returns false when it could not be placed (e.g. parent not indexed). */
export function applyOp(db: FileIndexDb, op: JournalOp): boolean {
  const id = db.findPath(op.p);
  if (op.o === "r") {
    if (id < 0) return false;
    db.remove(id);
    return true;
  }
  const st = { isDir: op.d === 1, size: op.s, mtime: op.m, atime: op.a };
  if (id >= 0) {
    if (db.isDir(id) === st.isDir) {
      db.updateStat(id, st);
      return true;
    }
    db.remove(id);
  }
  const parent = db.findPath(path.dirname(op.p));
  if (parent < 0) return false;
  db.add(path.basename(op.p), parent, st);
  return true;
}

export function parseJournal(text: string): JournalOp[] {
  const ops: JournalOp[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const op = JSON.parse(line) as JournalOp;
      if (op && typeof op.p === "string" && (op.o === "u" || op.o === "r")) ops.push(op);
    } catch {
      break; // torn final write: everything after it is unreliable
    }
  }
  return ops;
}

export function readJournalSync(file: string): JournalOp[] {
  try {
    return parseJournal(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export async function appendJournal(file: string, ops: JournalOp[]): Promise<void> {
  if (!ops.length) return;
  await fsp.appendFile(file, ops.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
}
