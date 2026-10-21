/**
 * Browser bookmarks & history search. Reads local data of Chromium browsers (JSON
 * Bookmarks + History SQLite), Firefox/Zen (places.sqlite) and Safari (only when
 * Glide already has Full Disk Access). Everything stays in memory; a background
 * refresh rebuilds the index every N minutes and swaps it in, so search never waits.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { app, clipboard, shell } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { BROWSERS, discoverProfiles, findApp, safariAccess, type Profile } from "./browsers";
import {
  buildHistoryQuery, faviconQuery, faviconsByHost, firefoxBookmarkRows, FIREFOX_BOOKMARKS_SQL, historyRowsToEntries, parseChromiumBookmarks, parseSafariBookmarks, type Entry,
} from "./data";
import { parsePlistXml } from "./plist";
import { dedupe, indexEntries, parseHistoryPrefix, searchEntries, type IndexedEntry } from "./search";
import { queryCopy, setTempRoot, sqliteBackend } from "./sqlite";

export interface BrowserSettings {
  bookmarks: boolean;
  history: boolean; // off by default: history is private
  historyDays: number;
  refreshMinutes: number;
  favicons: boolean;
  /** Bookmarks in root search (otherwise only in the "Search Bookmarks" view). */
  rootSearch: boolean;
  disabledProfiles: string[];
}

export const DEFAULTS: BrowserSettings = { bookmarks: true, history: false, historyDays: 90, refreshMinutes: 10, favicons: true, rootSearch: true, disabledProfiles: [] };
const HISTORY_LIMIT_PER_PROFILE = 5000;

export interface ProfileStatus {
  key: string;
  browserId: string;
  browserName: string;
  name: string;
  enabled: boolean;
  bookmarks: number;
  history: number;
  error?: string;
}

export interface BrowserStatus {
  settings: BrowserSettings;
  profiles: ProfileStatus[];
  safari: "ok" | "denied" | "missing";
  lastRefresh: number;
  refreshing: boolean;
  backend: string;
  totals: { bookmarks: number; history: number; favicons: number };
}

export interface BrowserRow {
  id: string;
  type: Entry["type"];
  title: string;
  url: string;
  host: string;
  folder?: string;
  visitCount?: number;
  lastVisit?: number;
  profile: string;
  browserName: string;
  profileName: string;
  icon?: string; // data: URL favicon
  appPath?: string;
}

let ctx: FeatureContext | undefined;
let index: IndexedEntry[] = [];
let favicons = new Map<string, string>();
let statuses: ProfileStatus[] = [];
let profiles: Profile[] = [];
let lastRefresh = 0;
let refreshing: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;
const appPaths = new Map<string, string>();
/** file|kind → parsed entries, reused while the file's mtime is unchanged. */
const cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

const home = () => os.homedir();

function settings(): BrowserSettings {
  const s = ctx?.settings(DEFAULTS as unknown as Record<string, unknown>) ?? {};
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);
  return {
    bookmarks: s.bookmarks !== false,
    history: s.history === true,
    historyDays: num(s.historyDays, DEFAULTS.historyDays, 1, 3650),
    refreshMinutes: num(s.refreshMinutes, DEFAULTS.refreshMinutes, 1, 1440),
    favicons: s.favicons !== false,
    rootSearch: s.rootSearch !== false,
    disabledProfiles: Array.isArray(s.disabledProfiles) ? s.disabledProfiles.filter((x): x is string => typeof x === "string") : [],
  };
}

async function cached<T>(file: string, kind: string, load: () => Promise<T>): Promise<T> {
  const st = await fs.promises.stat(file);
  const key = `${file}|${kind}`;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T;
  const value = await load();
  cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function plutilXml(file: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", file], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }, (err, out) => (err ? reject(err) : resolve(String(out)))),
  );
}

async function readBookmarks(p: Profile): Promise<Entry[]> {
  const f = p.bookmarksFile;
  if (!f) return [];
  if (p.browser.engine === "chromium") return cached(f, "bm", async () => parseChromiumBookmarks(await fs.promises.readFile(f, "utf8")));
  if (p.browser.engine === "firefox") return cached(f, "bm", async () => firefoxBookmarkRows((await queryCopy(f, [FIREFOX_BOOKMARKS_SQL]))[0] ?? []));
  return cached(f, "bm", async () => parseSafariBookmarks(parsePlistXml(await plutilXml(f))));
}

async function readHistory(p: Profile, days: number): Promise<Entry[]> {
  const f = p.historyFile;
  if (!f) return [];
  // The day boundary keeps the cache key stable for a whole day.
  const since = Math.floor((Date.now() - days * 86_400_000) / 86_400_000) * 86_400_000;
  const q = buildHistoryQuery(p.browser.engine, { limit: HISTORY_LIMIT_PER_PROFILE, sinceMs: since });
  return cached(f, `hist:${since}`, async () => historyRowsToEntries(p.browser.engine, (await queryCopy(f, [q.sql]))[0] ?? []));
}

async function readFavicons(p: Profile, hosts: Set<string>): Promise<Map<string, string>> {
  const f = p.faviconsFile;
  const sql = faviconQuery(p.browser.engine);
  if (!f || !sql || !hosts.size) return new Map();
  const key = [...hosts].sort().join(",").length; // cheap signature: re-read when the host set grows
  return cached(f, `fav:${key}`, async () => faviconsByHost((await queryCopy(f, [sql]))[0] ?? [], hosts));
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
const errText = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EPERM" || code === "EACCES") return "No access (needs Full Disk Access)";
  if (code === "ENOENT") return "Not found";
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
};

async function doRefresh(): Promise<void> {
  const s = settings();
  const h = home();
  profiles = discoverProfiles(h);
  const safari = safariAccess(h);
  for (const b of BROWSERS) {
    const appPath = findApp(h, b);
    if (appPath) appPaths.set(b.id, appPath);
  }
  const all: IndexedEntry[] = [];
  const icons = new Map<string, string>();
  const next: ProfileStatus[] = [];
  for (const p of profiles) {
    const enabled = !s.disabledProfiles.includes(p.key);
    const st: ProfileStatus = { key: p.key, browserId: p.browser.id, browserName: p.browser.name, name: p.name, enabled, bookmarks: 0, history: 0 };
    next.push(st);
    if (!enabled) continue;
    if (p.browser.engine === "safari" && safari !== "ok") {
      st.error = safari === "denied" ? "Needs Full Disk Access" : "No Safari data";
      continue;
    }
    const entries: Entry[] = [];
    const errors: string[] = [];
    if (s.bookmarks) {
      try {
        const bm = await readBookmarks(p);
        st.bookmarks = bm.length;
        entries.push(...bm);
      } catch (err) {
        errors.push(`Bookmarks: ${errText(err)}`);
      }
    }
    await yieldLoop();
    if (s.history) {
      try {
        const hi = await readHistory(p, s.historyDays);
        st.history = hi.length;
        entries.push(...hi);
      } catch (err) {
        errors.push(`History: ${errText(err)}`);
      }
      await yieldLoop();
    }
    const indexed = indexEntries(entries, p.key, p.browser.id);
    all.push(...indexed);
    if (s.favicons && indexed.length) {
      try {
        const want = new Set(indexed.map((e) => e.host).filter((x) => x && !icons.has(x)));
        for (const [k, v] of await readFavicons(p, want)) if (!icons.has(k)) icons.set(k, v);
      } catch {
        // favicons are cosmetic
      }
      await yieldLoop();
    }
    if (errors.length) st.error = errors.join(" · ");
  }
  index = dedupe(all);
  favicons = icons;
  statuses = next;
  lastRefresh = Date.now();
  ctx?.log(`indexed ${index.filter((e) => e.type === "bookmark").length} bookmarks, ${index.filter((e) => e.type === "history").length} history entries from ${next.filter((x) => x.enabled).length} profiles (${sqliteBackend()})`);
  ctx?.emit("status", status());
}

export function refresh(): Promise<void> {
  refreshing ??= doRefresh()
    .catch((err) => ctx?.log("refresh failed", err))
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void refresh(), settings().refreshMinutes * 60_000);
  timer.unref?.();
}

function status(): BrowserStatus {
  return {
    settings: settings(),
    profiles: statuses,
    safari: safariAccess(home()),
    lastRefresh,
    refreshing: !!refreshing,
    backend: sqliteBackend(),
    totals: { bookmarks: index.filter((e) => e.type === "bookmark").length, history: index.filter((e) => e.type === "history").length, favicons: favicons.size },
  };
}

const profileOf = (key: string) => profiles.find((p) => p.key === key);

function toRow(e: IndexedEntry): BrowserRow {
  const p = profileOf(e.profile);
  const icon = favicons.get(e.host);
  const appPath = appPaths.get(e.browser);
  return {
    id: `${e.type}:${e.profile}:${e.url}`,
    type: e.type,
    title: e.title,
    url: e.url,
    host: e.host,
    ...(e.folder ? { folder: e.folder } : {}),
    ...(e.visitCount !== undefined ? { visitCount: e.visitCount } : {}),
    ...(e.lastVisit !== undefined ? { lastVisit: e.lastVisit } : {}),
    profile: e.profile,
    browserName: p?.browser.name ?? e.browser,
    profileName: p && p.name !== p.browser.name ? p.name : "",
    ...(icon ? { icon } : {}),
    ...(appPath ? { appPath } : {}),
  };
}

export function search(query: string, type?: Entry["type"], limit = 50): BrowserRow[] {
  if (type === "history" && !settings().history) return [];
  return searchEntries(index, query, { limit, ...(type ? { type } : {}) }).map((r) => toRow(r.e));
}

const isOpenable = (url: string) => /^(https?|file|ftp):/i.test(url);

export function openUrl(url: string, profileKey: string | undefined, mode: "browser" | "default"): Promise<ExecuteResult> {
  if (!isOpenable(url) && mode === "default") return Promise.resolve({ ok: false, error: "Only web and file URLs can open in the default browser" });
  const p = profileKey ? profileOf(profileKey) : undefined;
  if (mode === "default" || !p) return shell.openExternal(url).then(() => ({ ok: true, hide: true }), (e: unknown) => ({ ok: false, error: errText(e) }));
  const b = p.browser;
  // -n + --profile-directory hands the URL to the running browser in the right profile.
  const args = b.profileArg ? ["-n", "-b", b.bundleId, "--args", `--profile-directory=${p.dir}`, url] : ["-b", b.bundleId, url];
  return new Promise((resolve) => execFile("/usr/bin/open", args, (err) => resolve(err ? { ok: false, error: `Could not open ${b.name}` } : { ok: true, hide: true })));
}

function rowItem(r: BrowserRow, score: number): ScoredItem {
  const where = [r.host, r.folder, `${r.browserName}${r.profileName ? ` (${r.profileName})` : ""}`].filter(Boolean).join(" · ");
  const item: SearchItem = {
    id: `browser:${r.type}:${r.url}`,
    kind: "command",
    kindLabel: r.type === "bookmark" ? "Bookmark" : "History",
    title: r.title,
    subtitle: where,
    icon: r.icon ? { kind: "url", value: r.icon } : r.appPath ? { kind: "app", value: r.appPath } : { kind: "emoji", value: r.type === "bookmark" ? "🔖" : "🕘" },
    keywords: [r.host, ...r.host.split(".")].filter(Boolean),
    feature: "browser",
    data: { action: "entry", url: r.url, profile: r.profile, browserName: r.browserName, noUsage: true },
  };
  return { item, score, matchScore: score, matchKind: "keyword", frecency: 0, ranges: [] };
}

function dynamicItems(query: string): ScoredItem[] {
  const s = settings();
  const hist = parseHistoryPrefix(query);
  if (hist !== undefined) {
    if (!s.history || !hist) return [];
    return searchEntries(index, hist, { limit: 8, type: "history" }).map((r, i) => rowItem(toRow(r.e), 300 - i));
  }
  const q = query.trim();
  if (!s.rootSearch || q.length < 2) return [];
  return searchEntries(index, q, { limit: 5, type: "bookmark" })
    .filter((r) => r.score >= 40)
    .map((r, i) => rowItem(toRow(r.e), 200 - i));
}

const cmd = (id: string, title: string, subtitle: string, icon: string, keywords: string[], view: string): SearchItem => ({
  id: `browser:${id}`,
  kind: "command",
  kindLabel: "Command",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "browser",
  data: { action: "view", view },
  acceptsArgument: true,
});

function sanitizePatch(patch: unknown): Partial<BrowserSettings> {
  const p = (patch ?? {}) as Record<string, unknown>;
  const out: Partial<BrowserSettings> = {};
  for (const k of ["bookmarks", "history", "favicons", "rootSearch"] as const) if (typeof p[k] === "boolean") out[k] = p[k] as boolean;
  if (typeof p.historyDays === "number" && p.historyDays >= 1) out.historyDays = Math.min(3650, Math.round(p.historyDays));
  if (typeof p.refreshMinutes === "number" && p.refreshMinutes >= 1) out.refreshMinutes = Math.min(1440, Math.round(p.refreshMinutes));
  if (Array.isArray(p.disabledProfiles)) out.disabledProfiles = p.disabledProfiles.filter((x): x is string => typeof x === "string");
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export const feature: FeatureModule = {
  id: "browser",
  start(c) {
    ctx = c;
    try {
      setTempRoot(app.getPath("temp"));
    } catch {
      // os.tmpdir() default is fine
    }
    // Let the launcher come up first; the first index takes a moment with many profiles.
    setTimeout(() => void refresh(), 1500).unref?.();
    schedule();
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  },
  items() {
    const out = [cmd("bookmarks", "Search Bookmarks", "Chrome, Arc, Brave, Edge, Firefox, Safari…", "🔖", ["bookmarks", "browser", "favorites", "links", "chrome", "arc", "safari", "firefox"], "browser.bookmarks")];
    out.push(cmd("history", "Search Browser History", settings().history ? "Recently visited pages" : "Off · enable in Settings → Browser", "🕘", ["history", "browser", "visited", "recent pages"], "browser.history"));
    return out;
  },
  dynamicItems,
  actions(i): ItemAction[] {
    if (i.data?.action === "view") return [{ id: "view", title: "Open", shortcut: "⏎" }, { id: "settings", title: "Browser Settings", shortcut: "⌘," }];
    const name = str(i.data?.browserName) || "Browser";
    return [
      { id: "open", title: `Open in ${name}`, shortcut: "⏎", icon: "🌐" },
      { id: "openDefault", title: "Open in Default Browser", shortcut: "⌘⏎" },
      { id: "copy", title: "Copy URL", shortcut: "⇧⌘C", icon: "📋" },
      { id: "copyMd", title: "Copy as Markdown Link", shortcut: "⇧⌘M" },
    ];
  },
  async runAction(scored, actionId) {
    const d = scored.item.data ?? {};
    const url = str(d.url);
    switch (actionId) {
      case "view":
        return { ok: true, view: { id: str(d.view), props: scored.argument ? { query: scored.argument } : {} } };
      case "settings":
        ctx?.openSettings("browser");
        return { ok: true, hide: true };
      case "open":
        return openUrl(url, str(d.profile), "browser");
      case "openDefault":
        return openUrl(url, undefined, "default");
      case "copy":
        clipboard.writeText(url);
        return { ok: true, hide: true, message: "URL copied" };
      case "copyMd":
        clipboard.writeText(`[${scored.item.title.replace(/[[\]]/g, "")}](${url})`);
        return { ok: true, hide: true, message: "Markdown link copied" };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    status: () => status(),
    search: (query: unknown, type: unknown, limit: unknown) =>
      search(str(query), type === "history" || type === "bookmark" ? type : undefined, typeof limit === "number" ? Math.min(500, Math.max(1, limit)) : 80),
    refresh: async () => {
      await refresh();
      return status();
    },
    setSettings: async (patch: unknown) => {
      const before = settings();
      ctx?.setSettings(sanitizePatch(patch) as Record<string, unknown>);
      const after = settings();
      if (before.refreshMinutes !== after.refreshMinutes) schedule();
      if (before.history !== after.history) ctx?.refreshCatalogue();
      if (before.history !== after.history || before.bookmarks !== after.bookmarks || before.historyDays !== after.historyDays || before.favicons !== after.favicons || before.disabledProfiles.join() !== after.disabledProfiles.join()) {
        if (!after.history) {
          // Drop history from memory immediately, including the parsed-file cache.
          index = index.filter((e) => e.type !== "history");
          for (const k of [...cache.keys()]) if (k.includes("|hist:")) cache.delete(k);
        }
        await refreshing; // an in-flight refresh used the old settings
        await refresh();
      }
      return status();
    },
    open: (url: unknown, profile: unknown, mode: unknown) => openUrl(str(url), str(profile) || undefined, mode === "default" ? "default" : "browser"),
    copy: (text: unknown) => {
      clipboard.writeText(str(text));
      return true;
    },
    /** User-initiated only (a button in Settings): opens Privacy & Security → Full Disk Access. */
    openFullDiskAccess: () => shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles").then(() => true),
  },
};
