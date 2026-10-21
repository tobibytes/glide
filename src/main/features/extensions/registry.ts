/**
 * Installed extensions on disk: <base>/installed/<name>, plus state.json (enabled + install source),
 * preferences/<name>.json and storage/<name>.json. No Electron imports, so it is unit-testable.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { validateManifest, isValidName, type ExtensionManifest } from "./manifest";
import { isRaycastPackage, RAYCAST_BUILD_DIR, translateRaycastManifest } from "./raycast-manifest";

const run = promisify(execFile);

export type InstallSource = { kind: "folder"; path: string } | { kind: "git"; url: string } | { kind: "store"; name: string; repo?: string } | { kind: "raycast-folder"; path: string };

/** Builds a Raycast extension's commands from `srcDir` into `outDir`; returns error messages. */
export type RaycastBuilder = (srcDir: string, outDir: string, manifest: ExtensionManifest) => Promise<string[]>;

export interface InstalledExtension {
  name: string;
  dir: string;
  enabled: boolean;
  source?: InstallSource;
  installedAt?: number;
  manifest?: ExtensionManifest;
  /** Set when package.json is missing or invalid. */
  errors?: string[];
}

interface StateFile {
  extensions: Record<string, { enabled: boolean; source?: InstallSource; installedAt?: number }>;
}

export class ExtensionError extends Error {}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function readManifest(dir: string): { manifest?: ExtensionManifest; errors?: string[] } {
  const pkgPath = path.join(dir, "package.json");
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    return { errors: [`Cannot read package.json: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const exists = (rel: string) => fs.existsSync(path.join(dir, rel));
  const res = isRaycastPackage(pkg) ? translateRaycastManifest(pkg, exists) : validateManifest(pkg, exists);
  return res.ok ? { manifest: res.manifest } : { errors: res.errors };
}

/** True when `dir` holds a Raycast-style extension (package.json with top-level commands). */
export function isRaycastFolder(dir: string): boolean {
  try {
    return isRaycastPackage(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")));
  } catch {
    return false;
  }
}

const GIT_URL = /^(https:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)[^\s]+$/;

export function isValidGitUrl(url: string): boolean {
  return GIT_URL.test(url.trim()) && !url.trim().startsWith("-");
}

export class ExtensionRegistry {
  readonly installedDir: string;
  private cache: InstalledExtension[] | null = null;

  constructor(
    private readonly base: string,
    private readonly raycastBuilder?: RaycastBuilder,
  ) {
    this.installedDir = path.join(base, "installed");
  }

  private get stateFile() {
    return path.join(this.base, "state.json");
  }

  private state(): StateFile {
    const s = readJson<StateFile>(this.stateFile, { extensions: {} });
    return s && typeof s === "object" && s.extensions ? s : { extensions: {} };
  }

  private saveState(s: StateFile) {
    writeJson(this.stateFile, s);
    this.cache = null;
  }

  invalidate() {
    this.cache = null;
  }

  list(): InstalledExtension[] {
    if (this.cache) return this.cache;
    const state = this.state();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.installedDir).filter((n) => !n.startsWith(".") && isValidName(n));
    } catch {
      names = [];
    }
    this.cache = names.sort().map((name) => {
      const dir = path.join(this.installedDir, name);
      const st = state.extensions[name];
      return { name, dir, enabled: st?.enabled ?? true, source: st?.source, installedAt: st?.installedAt, ...readManifest(dir) };
    });
    return this.cache;
  }

  get(name: string): InstalledExtension | undefined {
    return this.list().find((e) => e.name === name);
  }

  setEnabled(name: string, enabled: boolean) {
    if (!this.get(name)) throw new ExtensionError(`${name} is not installed`);
    const s = this.state();
    s.extensions[name] = { ...(s.extensions[name] ?? {}), enabled };
    this.saveState(s);
  }

  /** Copy a folder into installed/<name> (validated first; replaces an existing install of the same name). */
  installFromFolder(srcDir: string, source: InstallSource, opts: { keepGit?: boolean } = {}): InstalledExtension {
    const src = path.resolve(srcDir);
    if (!fs.existsSync(path.join(src, "package.json"))) throw new ExtensionError(`${src} has no package.json`);
    const { manifest, errors } = readManifest(src);
    if (!manifest) throw new ExtensionError(`Invalid extension:\n${(errors ?? []).join("\n")}`);
    fs.mkdirSync(this.installedDir, { recursive: true });
    const target = path.join(this.installedDir, manifest.name);
    if (path.resolve(target) === src) return this.record(manifest.name, source);
    const tmp = path.join(this.installedDir, `.tmp-${manifest.name}-${Date.now()}`);
    try {
      fs.cpSync(src, tmp, {
        recursive: true,
        dereference: false,
        filter: (p) => opts.keepGit || path.basename(p) !== ".git",
      });
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(tmp, target);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return this.record(manifest.name, source);
  }

  /**
   * Import a Raycast extension folder: translate its manifest, bundle each command into
   * <installed>/<name>/.glide-build, and copy only package.json, assets/ and the bundles
   * (dependencies are bundled, so node_modules is not copied).
   */
  async installRaycastFolder(srcDir: string): Promise<InstalledExtension> {
    if (!this.raycastBuilder) throw new ExtensionError("Importing Raycast extensions is not available");
    const src = path.resolve(srcDir);
    let pkg: unknown;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
    } catch (err) {
      throw new ExtensionError(`Cannot read package.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isRaycastPackage(pkg)) throw new ExtensionError(`${src} is not a Raycast extension (package.json needs a top-level "commands" array)`);
    const pre = translateRaycastManifest(pkg, () => true);
    if (!pre.ok) throw new ExtensionError(`Invalid Raycast extension:\n${pre.errors.join("\n")}`);
    const name = pre.manifest.name;
    fs.mkdirSync(this.installedDir, { recursive: true });
    const tmp = path.join(this.installedDir, `.tmp-${name}-${Date.now()}`);
    try {
      fs.mkdirSync(tmp, { recursive: true });
      fs.copyFileSync(path.join(src, "package.json"), path.join(tmp, "package.json"));
      for (const extra of ["assets", "README.md", "CHANGELOG.md", "LICENSE"]) {
        const from = path.join(src, extra);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, extra), { recursive: true, dereference: true });
      }
      const errors = await this.raycastBuilder(src, path.join(tmp, RAYCAST_BUILD_DIR), pre.manifest);
      if (errors.length) throw new ExtensionError(`Could not build ${pre.manifest.title}:\n${errors.join("\n")}`);
      const check = readManifest(tmp);
      if (!check.manifest) throw new ExtensionError(`Invalid extension after build:\n${(check.errors ?? []).join("\n")}`);
      const target = path.join(this.installedDir, name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(tmp, target);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return this.record(name, { kind: "raycast-folder", path: src });
  }

  private record(name: string, source: InstallSource): InstalledExtension {
    const s = this.state();
    s.extensions[name] = { enabled: s.extensions[name]?.enabled ?? true, source, installedAt: Date.now() };
    this.saveState(s);
    const ext = this.get(name);
    if (!ext) throw new ExtensionError(`Install of ${name} failed`);
    return ext;
  }

  async installFromGit(url: string, source?: InstallSource): Promise<InstalledExtension> {
    const clean = url.trim();
    if (!isValidGitUrl(clean)) throw new ExtensionError("Enter an https://, ssh:// or git@host:path repository URL");
    const git = await ensureGit();
    fs.mkdirSync(this.installedDir, { recursive: true });
    const tmp = path.join(this.installedDir, `.clone-${Date.now()}`);
    try {
      await run(git, ["clone", "--depth", "1", "--", clean, tmp], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      return this.installFromFolder(tmp, source ?? { kind: "git", url: clean }, { keepGit: true });
    } catch (err) {
      if (err instanceof ExtensionError) throw err;
      const e = err as { stderr?: string; message?: string };
      throw new ExtensionError(`git clone failed: ${(e.stderr || e.message || String(err)).trim()}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** git pull for git installs; re-copy for folder/store installs (`bundledDir` resolves store names). */
  async update(name: string, bundledDir?: (name: string) => string | undefined): Promise<InstalledExtension> {
    const ext = this.get(name);
    if (!ext) throw new ExtensionError(`${name} is not installed`);
    if (fs.existsSync(path.join(ext.dir, ".git"))) {
      const git = await ensureGit();
      try {
        await run(git, ["-C", ext.dir, "pull", "--ff-only"], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new ExtensionError(`git pull failed: ${(e.stderr || e.message || String(err)).trim()}`);
      }
      this.invalidate();
      return this.get(name) ?? ext;
    }
    const src = ext.source;
    if (src?.kind === "raycast-folder" && fs.existsSync(src.path)) return this.installRaycastFolder(src.path);
    if (src?.kind === "folder" && fs.existsSync(src.path)) return this.installFromFolder(src.path, src);
    if (src?.kind === "store") {
      const dir = bundledDir?.(src.name);
      if (dir) return this.installFromFolder(dir, src);
      if (src.repo) return this.installFromGit(src.repo, src);
    }
    throw new ExtensionError(`${name} has no update source (install it again from a folder or git URL)`);
  }

  uninstall(name: string) {
    if (!isValidName(name)) throw new ExtensionError("Invalid name");
    fs.rmSync(path.join(this.installedDir, name), { recursive: true, force: true });
    fs.rmSync(this.prefsFile(name), { force: true });
    const s = this.state();
    delete s.extensions[name];
    this.saveState(s);
  }

  // --- preferences (0600: may hold API tokens) ---------------------------------
  private prefsFile(name: string) {
    return path.join(this.base, "preferences", `${name}.json`);
  }

  getPreferences(name: string): Record<string, unknown> {
    return readJson<Record<string, unknown>>(this.prefsFile(name), {});
  }

  setPreferences(name: string, values: Record<string, unknown>) {
    if (!isValidName(name)) throw new ExtensionError("Invalid name");
    writeJson(this.prefsFile(name), values, 0o600);
  }

  // --- LocalStorage ---------------------------------------------------------
  private storageFile(name: string) {
    return path.join(this.base, "storage", `${name}.json`);
  }

  storageAll(name: string): Record<string, unknown> {
    return readJson<Record<string, unknown>>(this.storageFile(name), {});
  }

  storageWrite(name: string, mutate: (data: Record<string, unknown>) => void) {
    const data = this.storageAll(name);
    mutate(data);
    writeJson(this.storageFile(name), data, 0o600);
  }

  supportDir(name: string): string {
    const dir = path.join(this.base, "support", name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

let gitChecked: Promise<string> | null = null;

/**
 * Resolve a git binary. /usr/bin/git is a stub that pops an installer dialog when the Command Line
 * Tools are missing, so prefer Homebrew's git and only use the stub when xcode-select reports the tools.
 */
function ensureGit(): Promise<string> {
  gitChecked ??= (async () => {
    const candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git"].filter((p) => fs.existsSync(p));
    if (process.platform !== "darwin") candidates.push("git");
    else {
      try {
        await run("xcode-select", ["-p"], { timeout: 5000 });
        candidates.push("/usr/bin/git");
      } catch {
        /* no Command Line Tools */
      }
    }
    for (const bin of candidates) {
      try {
        await run(bin, ["--version"], { timeout: 5000 });
        return bin;
      } catch {
        /* try next */
      }
    }
    gitChecked = null;
    throw new ExtensionError("Installing from a URL requires git. Install the Xcode Command Line Tools (xcode-select --install) or Homebrew git, then try again.");
  })();
  return gitChecked;
}
