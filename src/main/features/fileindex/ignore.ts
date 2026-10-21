/**
 * Small gitignore matcher: globs (* ? [..] **), negation (!), dir-only
 * (trailing /), anchored patterns (leading or inner /), comments and escapes.
 * Rules in deeper ignore files take precedence; within a file the last match wins.
 */

export interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
  source: string;
}

export const IGNORE_FILES = [".gitignore", ".ignore", ".rayignore", ".glideignore"] as const;

function escapeRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate a glob body (no leading "!" / trailing "/") to a regex source. */
function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const before = i === 0 || glob[i - 1] === "/";
        const after = i + 2 === glob.length || glob[i + 2] === "/";
        if (before && after) {
          if (i + 2 === glob.length) out += ".*"; // trailing /** → everything inside
          else {
            out += "(?:.*/)?"; // **/ → zero or more directories
            i += 2; // skip "*/"
            continue;
          }
          i += 1;
          continue;
        }
      }
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) {
        out += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else if (ch === "\\" && i + 1 < glob.length) {
      out += escapeRegex(glob[++i]);
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

export function parseIgnoreLine(raw: string): IgnoreRule | null {
  let line = raw.replace(/\r$/, "");
  // Trailing spaces are ignored unless escaped.
  line = line.replace(/(?<!\\)\s+$/, "");
  if (!line || line.startsWith("#")) return null;
  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith("/") && !line.endsWith("\\/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (!line) return null;
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  const body = globToRegex(line);
  // Unanchored patterns match a name at any depth; a match on a directory also covers its contents.
  const src = anchored ? `^${body}$` : `(?:^|/)${body}$`;
  return { negate, dirOnly, regex: new RegExp(src), source: raw };
}

export function parseIgnoreFile(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of text.split("\n")) {
    const r = parseIgnoreLine(line);
    if (r) rules.push(r);
  }
  return rules;
}

/** Rules from one directory's ignore files; `match` gets a path relative to that directory. */
export class IgnoreRules {
  constructor(
    readonly baseDir: string,
    readonly rules: IgnoreRule[],
  ) {}

  /** "ignore" | "include" when a rule decides, null when none matches. */
  match(relPath: string, isDir: boolean): "ignore" | "include" | null {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const r = this.rules[i];
      if (r.dirOnly && !isDir) continue;
      if (r.regex.test(relPath)) return r.negate ? "include" : "ignore";
    }
    return null;
  }
}

/** Immutable chain of ignore rule sets from a scope root down to the current directory. */
export interface IgnoreChain {
  readonly rules: IgnoreRules;
  readonly parent: IgnoreChain | null;
}

export function extendChain(chain: IgnoreChain | null, rules: IgnoreRules | null): IgnoreChain | null {
  return rules && rules.rules.length ? { rules, parent: chain } : chain;
}

/** Deepest ignore file first; the first one that decides wins. */
export function isIgnoredByChain(chain: IgnoreChain | null, absPath: string, isDir: boolean): boolean {
  for (let c = chain; c; c = c.parent) {
    const base = c.rules.baseDir.endsWith("/") ? c.rules.baseDir : `${c.rules.baseDir}/`;
    if (!absPath.startsWith(base)) continue;
    const verdict = c.rules.match(absPath.slice(base.length), isDir);
    if (verdict) return verdict === "ignore";
  }
  return false;
}
