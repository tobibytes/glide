/**
 * Reads a browser's SQLite database without touching the live file: the database
 * (plus its -wal / -journal sidecars) is copied into a private temp dir, queried,
 * and the copy deleted. Uses node:sqlite when the runtime has it, else /usr/bin/sqlite3.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Row } from "./data";

interface StatementLike {
  all(): unknown[];
  setReadBigInts?(on: boolean): void;
}
interface DatabaseLike {
  prepare(sql: string): StatementLike;
  close(): void;
}
type DatabaseCtor = new (file: string, opts?: { readOnly?: boolean }) => DatabaseLike;

let ctor: DatabaseCtor | null | undefined;

function nodeSqlite(): DatabaseCtor | null {
  if (ctor !== undefined) return ctor;
  try {
    // Resolved at runtime so a runtime without node:sqlite falls back to the CLI instead of failing to load.
    const mod = process.getBuiltinModule?.("node:sqlite") as { DatabaseSync?: DatabaseCtor } | undefined;
    ctor = mod?.DatabaseSync ?? null;
  } catch {
    ctor = null;
  }
  return ctor;
}

export const sqliteBackend = (): "node:sqlite" | "sqlite3-cli" => (nodeSqlite() ? "node:sqlite" : "sqlite3-cli");

let tmpRoot = os.tmpdir();
export function setTempRoot(dir: string) {
  tmpRoot = dir;
}

/** Copies `file` (+ sidecars) to a fresh temp dir; returns the copy's path and a cleanup function. */
export async function snapshot(file: string): Promise<{ copy: string; cleanup: () => void }> {
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, "glide-browser-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const copy = path.join(dir, "db.sqlite");
    await fs.promises.copyFile(file, copy);
    for (const ext of ["-wal", "-journal"]) {
      try {
        await fs.promises.copyFile(file + ext, copy + ext);
      } catch {
        // sidecar absent
      }
    }
    return { copy, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function cliQuery(file: string, sql: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sqlite3", ["-json", file, sql], { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const text = String(stdout).trim();
        resolve(text ? (JSON.parse(text) as Row[]) : []);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Runs each query against one snapshot of `file`. Blob columns are only available through node:sqlite. */
export async function queryCopy(file: string, sqls: readonly string[]): Promise<Row[][]> {
  const { copy, cleanup } = await snapshot(file);
  try {
    const Db = nodeSqlite();
    if (!Db) {
      const out: Row[][] = [];
      for (const sql of sqls) out.push(await cliQuery(copy, sql));
      return out;
    }
    // Not read-only: the copy may carry a hot journal / WAL that SQLite must replay on open.
    const db = new Db(copy);
    try {
      return sqls.map((sql) => {
        const st = db.prepare(sql);
        // WebKit timestamps (µs since 1601) exceed Number.MAX_SAFE_INTEGER; parsers accept bigint.
        st.setReadBigInts?.(true);
        return st.all() as Row[];
      });
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
}
