/**
 * Pure planning for the Finder commands (no Electron, no side effects) so tests can check exactly
 * what would happen. index.ts executes the plans; ops.ts does the file-system work.
 */
import path from "node:path";
export { validateFileName } from "./names";

export type PathFormat = "posix" | "tilde" | "quoted" | "url";
export type TerminalApp = "Terminal" | "iTerm" | "Ghostty";
export const TERMINALS: TerminalApp[] = ["Terminal", "iTerm", "Ghostty"];

export interface Step {
  cmd: string;
  args: string[];
  cwd?: string;
}

const shellQuote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

export function formatPaths(paths: string[], format: PathFormat, home: string): string {
  const one = (p: string) => {
    if (format === "tilde") return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
    if (format === "quoted") return shellQuote(p);
    if (format === "url") return "file://" + p.split("/").map(encodeURIComponent).join("/");
    return p;
  };
  return paths.map(one).join(format === "quoted" ? " " : "\n");
}

/** Where "here" is: a selected folder, else the parent of the first selected file, else the window's folder. */
export function hereFolder(paths: string[], folder: string | null | undefined, isDir: (p: string) => boolean): string | null {
  const first = paths[0];
  if (first) return isDir(first) ? first : path.dirname(first);
  return folder ?? null;
}

/** `open` invocations; Ghostty takes the directory as a flag, the others as a document to open. */
export function terminalSteps(app: TerminalApp, dir: string): Step[] {
  if (app === "Ghostty") return [{ cmd: "/usr/bin/open", args: ["-na", "Ghostty", "--args", `--working-directory=${dir}`] }];
  return [{ cmd: "/usr/bin/open", args: ["-a", app === "iTerm" ? "iTerm" : "Terminal", dir] }];
}

/** "notes.txt" → "notes 2.txt", "notes 3.txt", … (Finder's style). */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const realExt = base === name ? "" : ext;
  for (let i = 2; i < 10_000; i++) {
    const c = `${base} ${i}${realExt}`;
    if (!taken(c)) return c;
  }
  return `${base} ${Date.now()}${realExt}`;
}

export function commonParent(paths: string[]): string {
  if (!paths.length) return "/";
  let parts = path.dirname(paths[0]!).split("/");
  for (const p of paths.slice(1)) {
    const other = path.dirname(p).split("/");
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join("/") || "/";
}

export interface CompressPlan {
  output: string;
  steps: Step[];
}

/** One item → "<name>.zip" via ditto (keeps metadata like Finder); several → "Archive.zip" via zip. */
export function compressPlan(paths: string[], taken: (candidate: string) => boolean): CompressPlan | null {
  if (!paths.length) return null;
  const parent = commonParent(paths);
  if (paths.length === 1) {
    const src = paths[0]!;
    const name = uniqueName(`${path.basename(src)}.zip`, (c) => taken(path.join(path.dirname(src), c)));
    const output = path.join(path.dirname(src), name);
    return { output, steps: [{ cmd: "/usr/bin/ditto", args: ["-c", "-k", "--sequesterRsrc", "--keepParent", src, output] }] };
  }
  const name = uniqueName("Archive.zip", (c) => taken(path.join(parent, c)));
  const output = path.join(parent, name);
  const rel = paths.map((p) => path.relative(parent, p) || ".");
  // -y stores symlinks as links; -X drops extra attributes (Finder's Archive.zip is plain too).
  return { output, steps: [{ cmd: "/usr/bin/zip", args: ["-r", "-y", "-X", "-q", output, ...rel], cwd: parent }] };
}

export interface MovePlan {
  moves: Array<{ from: string; to: string }>;
  /** Items that would overwrite something, or move into themselves. Nothing moves while non-empty. */
  conflicts: string[];
  /** Already in the destination. */
  skipped: string[];
}

export function movePlan(paths: string[], dest: string, exists: (p: string) => boolean): MovePlan {
  const plan: MovePlan = { moves: [], conflicts: [], skipped: [] };
  const target = dest.replace(/\/+$/, "") || "/";
  for (const from of paths) {
    if (path.dirname(from) === target) {
      plan.skipped.push(from);
      continue;
    }
    if (target === from || target.startsWith(from + "/")) {
      plan.conflicts.push(`${path.basename(from)} can’t be moved into itself`);
      continue;
    }
    const to = path.join(target, path.basename(from));
    if (exists(to)) plan.conflicts.push(`“${path.basename(from)}” already exists in ${path.basename(target) || "/"}`);
    else plan.moves.push({ from, to });
  }
  return plan;
}

/** Expand "~", "~/x" and relative input (relative to `base`) into an absolute path. */
export function expandPath(input: string, home: string, base: string): string {
  const t = input.trim();
  if (t === "~") return home;
  if (t.startsWith("~/")) return path.join(home, t.slice(2));
  return path.resolve(base, t);
}

export function openWithSteps(appPath: string, paths: string[]): Step[] {
  return [{ cmd: "/usr/bin/open", args: ["-a", appPath, ...paths] }];
}

export function describeSelection(paths: string[]): string {
  if (!paths.length) return "Nothing selected";
  if (paths.length === 1) return path.basename(paths[0]!);
  return `${paths.length} items`;
}
