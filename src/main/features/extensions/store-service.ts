/**
 * Store logic: merge the bundled index with the remote one, and install / update / uninstall packages.
 * Electron-free (everything host-specific comes in through StoreDeps) so it runs under vitest.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ItemIcon } from "@shared/types";
import { iconFor } from "../../../extension-api/icons";
import type { ExtensionManifest } from "./manifest";
import type { InstallSource } from "./registry";
import { downloadPackage, fetchImageDataUrl, fetchStoreIndex, type Fetcher } from "./store-client";
import type { StoreInstallResult, StoreItem, StoreState } from "./store-contract";
import { compareVersions, StoreIndexError, validateIndex, type StoreIndexEntry } from "./store-schema";
import { extractTgz } from "./store-tar";

export interface StoreInstalled {
  name: string;
  manifest?: ExtensionManifest;
  source?: InstallSource;
}

/** The subset of ExtensionRegistry the store uses. */
export interface StoreRegistry {
  list(): StoreInstalled[];
  get(name: string): StoreInstalled | undefined;
  installFromFolder(dir: string, source: InstallSource): StoreInstalled;
  uninstall(name: string): void;
  invalidate(): void;
}

export interface StoreDeps {
  registry(): StoreRegistry;
  readManifest(dir: string): { manifest?: ExtensionManifest; errors?: string[] };
  dataDir(): string;
  /** extensions-examples/ of this build. */
  examplesDir(): string | undefined;
  /** store/index.json shipped with this build. */
  localIndexPath(): string | undefined;
  indexUrl(): string;
  /** True when the remote index may be fetched for this URL (headless runs never hit the public default). */
  mayFetch(url: string): string | null;
  appVersion(): string;
  changed(): void;
  beforeUninstall(name: string): void;
  log(...args: unknown[]): void;
  fetcher?: Fetcher;
  /** Cache freshness when the store is opened without Refresh. */
  maxCacheAgeMs?: number;
}

interface CacheFile {
  url: string;
  fetchedAt: number;
  index: unknown;
}

interface StateFile {
  installs: Record<string, { id: string; version: string; via: "bundled" | "download"; sha256?: string; installedAt: number }>;
}

interface Merged {
  entry: StoreIndexEntry;
  origin: "bundled" | "remote";
  bundledDir?: string;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const FALLBACK_ICON: ItemIcon = { kind: "emoji", value: "🧩" };

export class StoreService {
  private cache: CacheFile | null | undefined;
  private busy = new Set<string>();
  private images = new Map<string, string>();
  private lastWarnings: string[] = [];

  constructor(private readonly deps: StoreDeps) {}

  private get cacheFile() {
    return path.join(this.deps.dataDir(), "store-cache.json");
  }
  private get stateFile() {
    return path.join(this.deps.dataDir(), "store-state.json");
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeJson(file: string, value: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  private state(): StateFile {
    const s = this.readJson<StateFile>(this.stateFile);
    return s && typeof s === "object" && s.installs && typeof s.installs === "object" ? s : { installs: {} };
  }

  private loadCache(url: string): CacheFile | null {
    if (this.cache === undefined) this.cache = this.readJson<CacheFile>(this.cacheFile);
    return this.cache && this.cache.url === url ? this.cache : null;
  }

  // --- index ---------------------------------------------------------------------------------

  /** Bundled entries: store/index.json entries with a bundled source, or (packaged builds without it) the examples' manifests. */
  private bundledEntries(): Merged[] {
    const exDir = this.deps.examplesDir();
    const out: Merged[] = [];
    const localPath = this.deps.localIndexPath();
    const local = localPath ? this.readJson<unknown>(localPath) : null;
    if (local) {
      try {
        for (const e of validateIndex(local).index.extensions) {
          const dir = e.source && exDir ? path.join(exDir, e.source.path) : undefined;
          if (e.source) out.push({ entry: e, origin: "bundled", bundledDir: dir && fs.existsSync(path.join(dir, "package.json")) ? dir : undefined });
        }
        return out;
      } catch (err) {
        this.deps.log("[store] bundled index invalid:", errMsg(err));
      }
    }
    if (!exDir) return out;
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(exDir).filter((d) => !d.startsWith(".")).sort();
    } catch {
      return out;
    }
    for (const d of dirs) {
      const dir = path.join(exDir, d);
      const m = this.deps.readManifest(dir).manifest;
      if (!m) continue;
      out.push({
        origin: "bundled",
        bundledDir: dir,
        entry: {
          id: m.name.toLowerCase(),
          name: m.name,
          title: m.title,
          description: m.description,
          author: m.author ?? "Glide",
          version: m.version,
          categories: [],
          icon: m.icon && !m.icon.includes(".") ? m.icon : undefined,
          commands: m.commands.map((c) => ({ name: c.name, title: c.title, description: c.description, mode: c.mode })),
          kind: m.runtime ?? "glide",
          minGlideVersion: "0.0.0",
          source: { bundled: true, path: d },
          screenshots: [],
          changelog: [],
        },
      });
    }
    return out;
  }

  /** Remote entries from cache or network. Network only when `refresh` or the cache is missing/stale. */
  private async remoteEntries(refresh: boolean): Promise<{ entries: StoreIndexEntry[]; fetchedAt?: number; fromCache: boolean; error?: string }> {
    const url = this.deps.indexUrl();
    const cached = this.loadCache(url);
    const fresh = cached && Date.now() - cached.fetchedAt < (this.deps.maxCacheAgeMs ?? 60 * 60 * 1000);
    const fromCache = () => {
      if (!cached) return [];
      try {
        return validateIndex(cached.index).index.extensions;
      } catch {
        return [];
      }
    };
    if (!refresh && fresh) return { entries: fromCache(), fetchedAt: cached.fetchedAt, fromCache: true };
    const blocked = this.deps.mayFetch(url);
    if (blocked) return { entries: fromCache(), fetchedAt: cached?.fetchedAt, fromCache: !!cached, error: blocked };
    try {
      const { index, errors } = await fetchStoreIndex(url, { fetcher: this.deps.fetcher });
      this.lastWarnings = errors;
      this.cache = { url, fetchedAt: Date.now(), index };
      this.writeJson(this.cacheFile, this.cache);
      this.images.clear();
      return { entries: index.extensions, fetchedAt: this.cache.fetchedAt, fromCache: false };
    } catch (err) {
      return { entries: fromCache(), fetchedAt: cached?.fetchedAt, fromCache: !!cached, error: errMsg(err) };
    }
  }

  private merged: Merged[] = [];

  async list(refresh = false): Promise<StoreState> {
    const bundled = this.bundledEntries();
    const remote = await this.remoteEntries(refresh);
    const byId = new Map<string, Merged>();
    for (const b of bundled) byId.set(b.entry.id, b);
    for (const e of remote.entries) {
      const local = byId.get(e.id);
      if (local && local.entry.name !== e.name) continue; // an id must not move to another package
      const bundledDir = e.source ? (local?.bundledDir ?? (this.deps.examplesDir() ? path.join(this.deps.examplesDir()!, e.source.path) : undefined)) : local?.bundledDir;
      byId.set(e.id, { entry: e, origin: local || e.source ? "bundled" : "remote", bundledDir: bundledDir && fs.existsSync(path.join(bundledDir, "package.json")) ? bundledDir : undefined });
    }
    this.merged = [...byId.values()];
    const items = this.merged.map((m) => this.item(m)).sort((a, b) => a.title.localeCompare(b.title));
    const categories = [...new Set(items.flatMap((i) => i.categories))].sort((a, b) => a.localeCompare(b));
    return { items, categories, indexUrl: this.deps.indexUrl(), fetchedAt: remote.fetchedAt, fromCache: remote.fromCache, error: remote.error, warnings: this.lastWarnings };
  }

  private bundledVersion(dir: string | undefined): string | undefined {
    return dir ? this.deps.readManifest(dir).manifest?.version : undefined;
  }

  /** bundled copy when it is the advertised version (or there is no download), else the download. */
  private via(m: Merged): StoreItem["via"] {
    const bv = this.bundledVersion(m.bundledDir);
    if (bv && (!m.entry.download || bv === m.entry.version)) return "bundled";
    return m.entry.download ? "download" : null;
  }

  private item(m: Merged): StoreItem {
    const e = m.entry;
    const ext = this.deps.registry().get(e.name);
    const st = this.state().installs[e.name];
    const via = this.via(m);
    const installedVersion = ext?.manifest?.version;
    const compatible = compareVersions(this.deps.appVersion(), e.minGlideVersion) >= 0;
    const unavailable = !compatible ? `Requires Glide ${e.minGlideVersion} or later` : !via ? "Not available in this build (bundled files missing)" : undefined;
    const effectiveVersion = via === "bundled" ? (this.bundledVersion(m.bundledDir) ?? e.version) : e.version;
    return {
      id: e.id,
      name: e.name,
      title: e.title,
      description: e.description,
      author: e.author,
      version: effectiveVersion,
      categories: e.categories,
      icon: iconFor(e.icon) ?? FALLBACK_ICON,
      commands: e.commands,
      kind: e.kind,
      minGlideVersion: e.minGlideVersion,
      screenshots: e.screenshots,
      changelog: e.changelog,
      homepage: e.homepage,
      license: e.license,
      origin: m.origin,
      via,
      size: via === "download" ? e.download?.size : undefined,
      unavailable,
      installed: !!ext,
      installedVersion,
      installedFromStore: !!ext && ext.source?.kind === "store" && !!st,
      updateAvailable: !!ext && !!installedVersion && !unavailable && compareVersions(effectiveVersion, installedVersion) > 0,
    };
  }

  private async find(id: string): Promise<Merged> {
    let m = this.merged.find((x) => x.entry.id === id);
    if (!m) {
      await this.list(false);
      m = this.merged.find((x) => x.entry.id === id);
    }
    if (!m) throw new StoreIndexError(`${id} is not in the store`);
    return m;
  }

  // --- install / update / uninstall -----------------------------------------------------------------

  async install(id: string, confirmed: boolean, mode: "install" | "update" = "install"): Promise<StoreInstallResult> {
    if (confirmed !== true) throw new StoreIndexError("Installing runs third-party code and must be confirmed first");
    if (this.busy.has(id)) throw new StoreIndexError(`${id} is already being installed`);
    this.busy.add(id);
    try {
      const m = await this.find(id);
      const item = this.item(m);
      if (item.unavailable) throw new StoreIndexError(`${item.title}: ${item.unavailable}`);
      if (mode === "update" && !item.installed) throw new StoreIndexError(`${item.title} is not installed`);
      if (mode === "update" && !item.updateAvailable) throw new StoreIndexError(`${item.title} is up to date`);
      const reg = this.deps.registry();
      const source: InstallSource = { kind: "store", name: m.entry.name };
      let record: StateFile["installs"][string];
      if (item.via === "bundled" && m.bundledDir) {
        this.checkPackage(m.bundledDir, m.entry, false);
        reg.installFromFolder(m.bundledDir, source);
        record = { id, version: item.version, via: "bundled", installedAt: Date.now() };
      } else if (m.entry.download) {
        const buf = await downloadPackage(m.entry.download, this.deps.indexUrl(), { fetcher: this.deps.fetcher });
        const tmp = path.join(this.deps.dataDir(), "store-tmp", `${m.entry.name}-${crypto.randomBytes(6).toString("hex")}`);
        try {
          extractTgz(buf, tmp);
          this.checkPackage(tmp, m.entry, true);
          reg.installFromFolder(tmp, source);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
        record = { id, version: m.entry.version, via: "download", sha256: m.entry.download.sha256, installedAt: Date.now() };
      } else throw new StoreIndexError(`${item.title} cannot be installed`);
      const s = this.state();
      s.installs[m.entry.name] = record;
      this.writeJson(this.stateFile, s);
      reg.invalidate();
      this.deps.changed();
      this.deps.log(`[store] ${mode === "update" ? "updated" : "installed"} ${m.entry.name}@${record.version} via ${record.via}`);
      const ext = reg.get(m.entry.name);
      return { name: m.entry.name, title: ext?.manifest?.title ?? item.title, version: record.version, firstCommand: ext?.manifest?.commands[0]?.title };
    } finally {
      this.busy.delete(id);
    }
  }

  /** The package must be the extension the index advertises (name, version for downloads, runtime kind). */
  private checkPackage(dir: string, e: StoreIndexEntry, strictVersion: boolean) {
    const { manifest, errors } = this.deps.readManifest(dir);
    if (!manifest) throw new StoreIndexError(`The package is not a valid extension:\n${(errors ?? []).join("\n")}`);
    if (manifest.name !== e.name) throw new StoreIndexError(`The package is "${manifest.name}" but the store lists "${e.name}"; not installed`);
    if (strictVersion && manifest.version !== e.version) throw new StoreIndexError(`The package is version ${manifest.version} but the store lists ${e.version}; not installed`);
    if ((manifest.runtime ?? "glide") !== e.kind) throw new StoreIndexError(`The package is a ${manifest.runtime ?? "glide"} extension but the store lists ${e.kind}; not installed`);
  }

  uninstall(id: string): void {
    const m = this.merged.find((x) => x.entry.id === id);
    const name = m?.entry.name ?? id;
    const reg = this.deps.registry();
    if (!reg.get(name)) throw new StoreIndexError(`${name} is not installed`);
    this.deps.beforeUninstall(name);
    reg.uninstall(name);
    const s = this.state();
    delete s.installs[name];
    this.writeJson(this.stateFile, s);
    this.deps.changed();
    this.deps.log(`[store] uninstalled ${name}`);
  }

  /** A listed screenshot as a data: URL (only URLs the current index lists). */
  async screenshot(id: string, url: string): Promise<string> {
    const m = this.merged.find((x) => x.entry.id === id);
    if (!m || !m.entry.screenshots.includes(url)) throw new StoreIndexError("Unknown screenshot");
    const hit = this.images.get(url);
    if (hit) return hit;
    const data = await fetchImageDataUrl(url, this.deps.indexUrl(), { fetcher: this.deps.fetcher });
    this.images.set(url, data);
    return data;
  }
}
