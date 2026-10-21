/**
 * Built-in exclusions modelled on Raycast's utils/exclusions.rs (research/04 §2.3):
 * VCS / dependency / build-output / cache directories, ~/Library (except iCloud
 * Drive's Mobile Documents), bundle interiors, and user patterns.
 */
import os from "node:os";
import path from "node:path";
import { IgnoreRules, parseIgnoreFile } from "./ignore";

/** Directory names never descended into (nor indexed). */
const EXCLUDED_DIR_NAMES = new Set([
  ".git", ".hg", ".svn", ".jj", ".bzr",
  "node_modules", "bower_components", ".pnpm-store",
  "build", "dist", "target", "out", ".next", ".nuxt", ".turbo", ".svelte-kit", ".parcel-cache",
  ".cache", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".gradle", ".dart_tool", "DerivedData", "Pods", ".build", "zig-cache", ".Trash",
  "Caches", "CachedData",
]);

/** File names never indexed. */
const EXCLUDED_FILE_NAMES = new Set([".DS_Store", ".localized", "Icon\r", ".tsbuildinfo"]);

/** Directories indexed as a single entry whose insides are skipped (macOS bundles). */
const BUNDLE_EXTS = new Set(["app", "photoslibrary", "musiclibrary", "xcarchive", "framework", "bundle", "plugin", "kext", "appex", "xcodeproj", "xcworkspace", "playground", "rtfd", "pages", "numbers", "key", "imovielibrary", "tvlibrary", "photoboothlibrary", "fcpbundle", "logicx", "band", "saver", "prefPane", "qlgenerator", "mdimporter"]);

export const DEFAULT_USER_EXCLUSIONS = ["*.tmp", "*.temp", "**/tmp/**", "**/temp/**"];

export function isBundleName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && BUNDLE_EXTS.has(name.slice(dot + 1));
}

export interface ExclusionConfig {
  home: string;
  includeHidden: boolean;
  /** User patterns: absolute/~ paths exclude that subtree; anything else is a gitignore pattern. */
  userPatterns: string[];
  /** Expanded scope roots; user globs match paths relative to the scope containing them. */
  ruleRoots?: string[];
  /** Subtrees skipped entirely, e.g. TCC-protected folders the user has not allowed yet. */
  blocked?: string[];
}

/** Folders macOS guards with a privacy prompt; crawling them is opt-in (an explicit button in Settings). */
export function protectedFolders(home: string): string[] {
  return ["Desktop", "Documents", "Downloads", "Library/Mobile Documents"].map((p) => path.join(home, p));
}

export class Exclusions {
  private readonly library: string;
  private readonly mobileDocs: string;
  private readonly absolute: string[];
  private readonly globRules: IgnoreRules;
  private readonly roots: string[];

  constructor(readonly config: ExclusionConfig) {
    this.library = path.join(config.home, "Library");
    this.mobileDocs = path.join(this.library, "Mobile Documents");
    const abs: string[] = [];
    const globs: string[] = [];
    for (const raw of config.userPatterns) {
      const p = raw.trim();
      if (!p) continue;
      if (p.startsWith("~/") || p === "~") abs.push(path.join(config.home, p.slice(1)));
      else if (p.startsWith("/") && !p.includes("*")) abs.push(p.replace(/\/+$/, ""));
      else globs.push(p);
    }
    this.absolute = [...abs, ...(config.blocked ?? [])];
    // User globs apply relative to the scope root ("Downloads/*.dmg" under ~), like an ignore file at the root.
    this.globRules = new IgnoreRules("/", parseIgnoreFile(globs.join("\n")));
    this.roots = [...(config.ruleRoots ?? [])].sort((a, b) => b.length - a.length);
  }

  /** True when `absPath` (named `name`) must be neither indexed nor descended into. */
  excluded(absPath: string, name: string, isDir: boolean): boolean {
    if (!this.config.includeHidden && name.startsWith(".")) return true;
    if (isDir) {
      if (EXCLUDED_DIR_NAMES.has(name)) return true;
      if (absPath === this.library) return false; // the Library folder itself stays; its children are filtered below
    } else if (EXCLUDED_FILE_NAMES.has(name) || name.startsWith("._")) {
      return true;
    }
    if (absPath.startsWith(`${this.library}/`)) {
      // ~/Library is private app state; iCloud Drive lives under Mobile Documents.
      if (!(absPath === this.mobileDocs || absPath.startsWith(`${this.mobileDocs}/`))) return true;
    }
    for (const a of this.absolute) if (absPath === a || absPath.startsWith(`${a}/`)) return true;
    if (this.globRules.rules.length && this.globRules.match(this.relative(absPath), isDir) === "ignore") return true;
    return false;
  }

  private relative(absPath: string): string {
    for (const r of this.roots) {
      if (r === "/") return absPath.slice(1);
      if (absPath.startsWith(`${r}/`)) return absPath.slice(r.length + 1);
    }
    return absPath.slice(1);
  }

  /** Bundles are indexed but not descended into. */
  descend(name: string): boolean {
    return !isBundleName(name);
  }
}

export function defaultHome(): string {
  return os.homedir();
}
