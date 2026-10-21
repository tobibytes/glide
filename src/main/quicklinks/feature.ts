/**
 * "quicklinks" feature module: Create Quicklink / import & export / bookmark import commands and the
 * renderer methods used by the Quicklinks settings page and launcher views. Registered from
 * ./register.ts (additive push onto FEATURES; the registry file is untouched).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { clipboard, dialog, net } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { Quicklink, SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../features/types";
import { search as searchBrowser } from "../features/browser";
import { bookmarksToQuicklinks, dedupeByUrl, exportQuicklinks, parseQuicklinkImport, quicklinkArguments } from "./core";
import { FaviconCache } from "./favicon";
import { resolveQuicklinkUrl, setQuicklinkHelper } from "./open";

export const QUICKLINKS_FEATURE = "quicklinks";
const DEFAULT_EMOJI = "🔗";

let ctx: FeatureContext | null = null;
let favicons: FaviconCache | null = null;

const newId = () => `ql-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function need(): FeatureContext {
  if (!ctx) throw new Error("Quicklinks are not ready yet");
  return ctx;
}

function cache(): FaviconCache {
  favicons ??= new FaviconCache(() => path.join(need().dataDir(), "favicons.json"), (u, init) => net.fetch(u, init));
  return favicons;
}

/** A favicon replaces only the default/unset icon or an earlier favicon, never an icon the user picked. */
const replaceableIcon = (q: Pick<Quicklink, "icon">) => !q.icon || (q.icon.kind === "emoji" && q.icon.value === DEFAULT_EMOJI) || (q.icon.kind === "url" && q.icon.value.startsWith("data:image/"));

function cleanQuicklink(raw: unknown): Quicklink {
  if (!isRecord(raw) || !str(raw.name).trim() || !str(raw.url).trim()) throw new Error("Name and URL are required");
  const q: Quicklink = { id: str(raw.id) || newId(), name: str(raw.name).trim(), url: str(raw.url).trim() };
  if (isRecord(raw.icon) && typeof raw.icon.kind === "string" && typeof raw.icon.value === "string") q.icon = raw.icon as unknown as Quicklink["icon"];
  if (str(raw.alias).trim()) q.alias = str(raw.alias).trim();
  if (Array.isArray(raw.keywords)) q.keywords = raw.keywords.filter((k): k is string => typeof k === "string" && !!k.trim()).map((k) => k.trim());
  if (str(raw.openWith).trim()) q.openWith = str(raw.openWith).trim();
  return q;
}

/** Save (insert or update). With fetchFavicon, a site icon is looked up for links without a custom icon. */
export async function saveQuicklink(raw: unknown, opts: { fetchFavicon?: boolean } = {}): Promise<Quicklink> {
  const c = need();
  const q = cleanQuicklink(raw);
  if (opts.fetchFavicon && replaceableIcon(q)) {
    const icon = await cache().get(q.url);
    if (icon) q.icon = { kind: "url", value: icon };
  }
  return c.store.saveQuicklink(q);
}

function addMany(list: Array<Omit<Quicklink, "id">>): { added: number; duplicates: number } {
  const c = need();
  const fresh = dedupeByUrl(list, c.getData().quicklinks);
  c.store.mutate((d) => {
    for (const q of fresh) d.quicklinks.push({ ...q, id: newId() });
  });
  return { added: fresh.length, duplicates: list.length - fresh.length };
}

export function importQuicklinksJson(json: string): { added: number; duplicates: number; skipped: number } {
  const { quicklinks, skipped } = parseQuicklinkImport(json);
  return { ...addMany(quicklinks), skipped };
}

const exportJson = () => JSON.stringify(exportQuicklinks(need().getData().quicklinks), null, 2);

async function importFile(): Promise<{ added: number; duplicates: number; skipped: number } | null> {
  const r = await dialog.showOpenDialog({ title: "Import Quicklinks", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return importQuicklinksJson(await fs.readFile(r.filePaths[0], "utf8"));
}

async function exportFile(): Promise<string | null> {
  const r = await dialog.showSaveDialog({ title: "Export Quicklinks", defaultPath: "Glide Quicklinks.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, exportJson(), "utf8");
  return r.filePath;
}

export interface BookmarkCandidate {
  title: string;
  url: string;
  folder?: string;
  browser: string;
  icon?: string;
  exists: boolean;
}

/** Bookmarks from the browser feature's index (read-only), marked when a quicklink already has the URL. */
export function bookmarkCandidates(query: string, limit = 200): BookmarkCandidate[] {
  const existing = new Set(need().getData().quicklinks.map((q) => q.url.replace(/\/+$/, "").toLowerCase()));
  return searchBrowser(query, "bookmark", limit)
    .filter((r) => /^https?:\/\//i.test(r.url))
    .map((r) => ({
      title: r.title,
      url: r.url,
      ...(r.folder ? { folder: r.folder } : {}),
      browser: r.browserName,
      ...(r.icon ? { icon: r.icon } : {}),
      exists: existing.has(r.url.replace(/\/+$/, "").toLowerCase()),
    }));
}

function importBookmarks(rows: unknown): { added: number; duplicates: number } {
  if (!Array.isArray(rows)) throw new Error("Expected a list of bookmarks");
  const clean = rows.filter(isRecord).map((r) => ({ title: str(r.title), url: str(r.url), ...(str(r.folder) ? { folder: str(r.folder) } : {}), ...(str(r.icon) ? { icon: str(r.icon) } : {}) }));
  return addMany(bookmarksToQuicklinks(clean));
}

// ---------------------------------------------------------------------------
// "Add as Quicklink" on browser bookmark rows (wired from execute.ts)
// ---------------------------------------------------------------------------

export const ADD_AS_QUICKLINK = "glide.addAsQuicklink";

const isBookmarkRow = (item: SearchItem) => item.feature === "browser" && item.data?.action === "entry" && typeof item.data.url === "string" && /^https?:\/\//i.test(item.data.url);

export function extraActionsFor(item: SearchItem): ItemAction[] {
  return isBookmarkRow(item) ? [{ id: ADD_AS_QUICKLINK, title: "Add as Quicklink", shortcut: "⌥⌘L", icon: DEFAULT_EMOJI }] : [];
}

export async function runExtraAction(item: SearchItem, actionId: string): Promise<ExecuteResult | undefined> {
  if (actionId !== ADD_AS_QUICKLINK || !isBookmarkRow(item)) return undefined;
  const url = str(item.data?.url);
  if (need().getData().quicklinks.some((q) => q.url === url)) return { ok: true, message: "Already a quicklink" };
  const icon = item.icon?.kind === "url" && item.icon.value.startsWith("data:image/") ? item.icon : undefined;
  const saved = await saveQuicklink({ name: item.title, url, ...(icon ? { icon } : {}) }, { fetchFavicon: !icon });
  return { ok: true, message: `Added quicklink “${saved.name}”` };
}

// ---------------------------------------------------------------------------

const cmd = (id: string, title: string, subtitle: string, icon: string, keywords: string[]): SearchItem => ({
  id: `quicklinks.${id}`,
  kind: "command",
  kindLabel: "Quicklinks",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: QUICKLINKS_FEATURE,
});

export const quicklinksFeature: FeatureModule = {
  id: QUICKLINKS_FEATURE,
  start(c) {
    ctx = c;
    setQuicklinkHelper(c.helper);
  },
  stop() {
    setQuicklinkHelper(null);
    ctx = null;
  },
  items: () => [
    { ...cmd("create", "Create Quicklink", "Save a URL with {argument} placeholders", "➕", ["new", "add", "link", "url", "bookmark", "quicklink"]), acceptsArgument: true },
    cmd("bookmarks", "Import Quicklinks from Bookmarks", "Pick browser bookmarks to turn into quicklinks", "🔖", ["bookmarks", "browser", "import"]),
    cmd("import", "Import Quicklinks…", "From a Glide or Raycast JSON export", "📥", ["import", "json", "raycast"]),
    cmd("export", "Export Quicklinks…", "Save all quicklinks as JSON", "📤", ["export", "json", "backup"]),
  ],
  actions(item): ItemAction[] {
    if (item.id === "quicklinks.export") return [{ id: "exportFile", title: "Export to File…", shortcut: "⏎" }, { id: "exportCopy", title: "Copy JSON", shortcut: "⌘⏎" }];
    if (item.id === "quicklinks.import") return [{ id: "importFile", title: "Import from File…", shortcut: "⏎" }, { id: "importClipboard", title: "Import JSON from Clipboard", shortcut: "⌘⏎" }];
    return [{ id: "open", title: "Open", shortcut: "⏎" }, { id: "settings", title: "Open Quicklinks Settings", shortcut: "⌘⏎" }];
  },
  async runAction(scored, actionId) {
    const c = need();
    const id = scored.item.id;
    const report = (r: { added: number; duplicates: number; skipped?: number } | null): ExecuteResult =>
      r ? { ok: true, message: `Imported ${r.added} quicklink${r.added === 1 ? "" : "s"}${r.duplicates ? ` · ${r.duplicates} already existed` : ""}${r.skipped ? ` · ${r.skipped} skipped` : ""}` } : { ok: true };
    try {
      switch (actionId) {
        case "settings":
          c.openSettings("quicklinks");
          return { ok: true, hide: true };
        case "exportFile": {
          const file = await exportFile();
          return file ? { ok: true, message: `Exported to ${path.basename(file)}` } : { ok: true };
        }
        case "exportCopy":
          await clipboard.writeText(exportJson());
          return { ok: true, message: "Quicklinks JSON copied" };
        case "importFile":
          return report(await importFile());
        case "importClipboard":
          return report(importQuicklinksJson(await clipboard.readText()));
        case "open":
          if (id === "quicklinks.create") return { ok: true, view: { id: "quicklinks.create", props: { title: "Create Quicklink", ...(scored.argument ? { url: scored.argument } : {}) } } };
          if (id === "quicklinks.bookmarks") return { ok: true, view: { id: "quicklinks.bookmarks", props: { title: "Import from Bookmarks" } } };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    list: () => need().getData().quicklinks,
    save: (q: unknown, opts: unknown) => saveQuicklink(q, { fetchFavicon: isRecord(opts) && opts.fetchFavicon === true }),
    delete: (id: unknown) => need().store.deleteQuicklink(str(id)),
    arguments: (url: unknown) => quicklinkArguments(str(url)),
    /** Preview the URL a template produces for the given argument values (clipboard/selection read live). */
    preview: async (url: unknown, values: unknown) => {
      const named = isRecord(values) ? Object.fromEntries(Object.entries(values).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
      const r = await resolveQuicklinkUrl(str(url), { arguments: named });
      return "error" in r ? { error: r.error } : { url: r.url };
    },
    favicon: (url: unknown) => cache().get(str(url)),
    importJson: (json: unknown) => importQuicklinksJson(str(json)),
    exportJson: () => exportJson(),
    importFile: () => importFile(),
    exportFile: () => exportFile(),
    bookmarks: (query: unknown, limit: unknown) => bookmarkCandidates(str(query), typeof limit === "number" ? Math.min(1000, Math.max(1, limit)) : 200),
    importBookmarks: (rows: unknown) => importBookmarks(rows),
    /** URL on the clipboard, for prefilling Create Quicklink. */
    clipboardUrl: async () => {
      const t = (await clipboard.readText().catch(() => "")).trim();
      return /^https?:\/\/\S+$/i.test(t) ? t : "";
    },
  },
};
