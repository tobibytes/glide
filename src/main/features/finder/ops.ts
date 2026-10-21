/** File-system side of the Finder commands. Electron-free so tests run it against a temp dir. */
import fs from "node:fs";
import path from "node:path";
import { validateFileName } from "./names";
import { movePlan, uniqueName, type MovePlan } from "./paths";

export interface NewFileResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Creates an empty file; never overwrites (a taken name becomes "name 2.ext"). */
export async function createEmptyFile(folder: string, name: string): Promise<NewFileResult> {
  const invalid = validateFileName(name);
  if (invalid) return { ok: false, error: invalid };
  try {
    if (!(await fs.promises.stat(folder)).isDirectory()) return { ok: false, error: "Not a folder" };
  } catch {
    return { ok: false, error: "That folder no longer exists" };
  }
  const final = uniqueName(name.trim(), (c) => fs.existsSync(path.join(folder, c)));
  const full = path.join(folder, final);
  try {
    await fs.promises.writeFile(full, "", { flag: "wx" });
    return { ok: true, path: full };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface MoveResult {
  ok: boolean;
  moved: Array<{ from: string; to: string }>;
  error?: string;
  plan: MovePlan;
}

/** Moves without overwriting; refuses the whole batch when any item conflicts. */
export async function moveItems(paths: string[], dest: string): Promise<MoveResult> {
  try {
    if (!(await fs.promises.stat(dest)).isDirectory()) throw new Error("not a folder");
  } catch {
    return { ok: false, moved: [], error: "Destination is not a folder", plan: { moves: [], conflicts: [], skipped: [] } };
  }
  const plan = movePlan(paths, dest, (p) => fs.existsSync(p));
  if (plan.conflicts.length) return { ok: false, moved: [], error: plan.conflicts.join("; "), plan };
  const moved: Array<{ from: string; to: string }> = [];
  for (const m of plan.moves) {
    try {
      await fs.promises.rename(m.from, m.to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") return { ok: false, moved, error: errMsg(err), plan };
      // Another volume: copy then remove, like Finder's ⌘-drag.
      try {
        await fs.promises.cp(m.from, m.to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
        await fs.promises.rm(m.from, { recursive: true });
      } catch (e) {
        return { ok: false, moved, error: errMsg(e), plan };
      }
    }
    moved.push(m);
  }
  return { ok: true, moved, plan };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface FolderSuggestion {
  path: string;
  name: string;
}

/** Sub-folders of the folder part of `typed` whose names start with the last segment. */
export async function completeFolder(typedAbs: string, endsWithSlash: boolean, limit = 30): Promise<FolderSuggestion[]> {
  const dir = endsWithSlash ? typedAbs : path.dirname(typedAbs);
  const prefix = endsWithSlash ? "" : path.basename(typedAbs).toLowerCase();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".") && e.name.toLowerCase().startsWith(prefix))
    .map((e) => ({ path: path.join(dir, e.name), name: e.name }))
    .filter((s) => {
      try {
        return fs.statSync(s.path).isDirectory() && !s.path.endsWith(".app");
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

export interface AppEntry {
  name: string;
  path: string;
}

/** .app bundles in the usual folders (one level, plus Utilities). */
export async function listApps(dirs: string[]): Promise<AppEntry[]> {
  const seen = new Map<string, AppEntry>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".app")) continue;
      const name = n.slice(0, -4);
      if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), { name, path: path.join(dir, n) });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
