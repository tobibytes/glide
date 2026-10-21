/** Pure parsing of browser bookmark files and SQL builders for history/bookmark/favicon databases. */
import type { Engine } from "./browsers";
import type { PlistValue } from "./plist";

export interface Entry {
  type: "bookmark" | "history";
  title: string;
  url: string;
  /** Folder path for bookmarks ("Bookmarks Bar / Dev"). */
  folder?: string;
  visitCount?: number;
  /** unix ms */
  lastVisit?: number;
}

const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000; // 1601-01-01 → 1970-01-01
const COCOA_EPOCH_OFFSET_S = 978_307_200; // 2001-01-01 → 1970-01-01

export const webkitToMs = (us: number) => (us > 0 ? us / 1000 - WEBKIT_EPOCH_OFFSET_MS : 0);
export const msToWebkit = (ms: number) => Math.round((ms + WEBKIT_EPOCH_OFFSET_MS) * 1000);
export const cocoaToMs = (s: number) => (s + COCOA_EPOCH_OFFSET_S) * 1000;
export const msToCocoa = (ms: number) => ms / 1000 - COCOA_EPOCH_OFFSET_S;

const openable = (url: string) => /^(https?|file|ftp|chrome|about|edge|brave|arc|vivaldi):/i.test(url) && !/^javascript:/i.test(url);

interface ChromiumNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromiumNode[];
}

const ROOT_LABEL: Record<string, string> = { bookmark_bar: "Bookmarks Bar", other: "Other Bookmarks", synced: "Mobile Bookmarks" };

/** Chromium "Bookmarks" JSON (roots.bookmark_bar / other / synced, nested folders). */
export function parseChromiumBookmarks(json: string): Entry[] {
  let doc: { roots?: Record<string, ChromiumNode | unknown> };
  try {
    doc = JSON.parse(json) as typeof doc;
  } catch {
    return [];
  }
  const out: Entry[] = [];
  const walk = (n: ChromiumNode, folder: string[]) => {
    if (n.type === "url" && typeof n.url === "string" && openable(n.url)) {
      out.push({ type: "bookmark", title: (n.name ?? "").trim() || n.url, url: n.url, ...(folder.length ? { folder: folder.join(" / ") } : {}) });
    } else if (Array.isArray(n.children)) {
      for (const c of n.children) walk(c, n.type === "folder" && n.name ? [...folder, n.name] : folder);
    }
  };
  for (const [key, node] of Object.entries(doc.roots ?? {})) {
    if (!node || typeof node !== "object" || !Array.isArray((node as ChromiumNode).children)) continue;
    const label = ROOT_LABEL[key] ?? (node as ChromiumNode).name ?? key;
    for (const c of (node as ChromiumNode).children!) walk(c, [label]);
  }
  return out;
}

type Dict = { [k: string]: PlistValue };
const isDict = (v: PlistValue | undefined): v is Dict => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

/** Safari Bookmarks.plist (already converted to a value tree). Reading List items are kept under "Reading List". */
export function parseSafariBookmarks(root: PlistValue): Entry[] {
  const out: Entry[] = [];
  const walk = (n: PlistValue | undefined, folder: string[]) => {
    if (!isDict(n)) return;
    const type = n.WebBookmarkType;
    if (type === "WebBookmarkTypeLeaf") {
      const url = typeof n.URLString === "string" ? n.URLString : "";
      if (!url || !openable(url)) return;
      const uri = isDict(n.URIDictionary) ? n.URIDictionary : undefined;
      const title = typeof uri?.title === "string" && uri.title.trim() ? uri.title.trim() : url;
      out.push({ type: "bookmark", title, url, ...(folder.length ? { folder: folder.join(" / ") } : {}) });
      return;
    }
    if (type === "WebBookmarkTypeList" && Array.isArray(n.Children)) {
      const raw = typeof n.Title === "string" ? n.Title : "";
      const name = raw === "com.apple.ReadingList" ? "Reading List" : raw === "BookmarksBar" ? "Favourites" : raw === "BookmarksMenu" ? "Bookmarks Menu" : raw;
      const next = name ? [...folder, name] : folder;
      for (const c of n.Children) walk(c, next);
    }
  };
  walk(root, []);
  return out;
}

export interface Query {
  sql: string;
  /** Column → Entry mapping happens in rowsToEntries. */
  engine: Engine;
  kind: "history" | "bookmarks";
}

const int = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number.isFinite(n) ? n : min)));

/**
 * History query for a browser engine. Values are validated integers inlined into
 * the SQL so the same text runs through node:sqlite or the sqlite3 CLI.
 * Every query returns columns: url, title, visits, last (native epoch units).
 */
export function buildHistoryQuery(engine: Engine, opts: { limit: number; sinceMs?: number }): Query {
  const limit = int(opts.limit, 1, 100_000);
  const since = opts.sinceMs && opts.sinceMs > 0 ? opts.sinceMs : 0;
  if (engine === "chromium") {
    const where = since ? ` AND last_visit_time >= ${msToWebkit(since)}` : "";
    return { engine, kind: "history", sql: `SELECT url, title, visit_count AS visits, last_visit_time AS last FROM urls WHERE hidden = 0${where} ORDER BY last_visit_time DESC LIMIT ${limit}` };
  }
  if (engine === "firefox") {
    const where = since ? ` AND last_visit_date >= ${Math.round(since * 1000)}` : "";
    return { engine, kind: "history", sql: `SELECT url, title, visit_count AS visits, last_visit_date AS last FROM moz_places WHERE last_visit_date IS NOT NULL AND hidden = 0${where} ORDER BY last_visit_date DESC LIMIT ${limit}` };
  }
  const having = since ? ` HAVING last >= ${Math.floor(msToCocoa(since))}` : "";
  return {
    engine,
    kind: "history",
    sql: `SELECT i.url AS url, (SELECT v2.title FROM history_visits v2 WHERE v2.history_item = i.id AND v2.title IS NOT NULL ORDER BY v2.visit_time DESC LIMIT 1) AS title, i.visit_count AS visits, MAX(v.visit_time) AS last FROM history_items i JOIN history_visits v ON v.history_item = i.id GROUP BY i.id${having} ORDER BY last DESC LIMIT ${limit}`,
  };
}

/** Firefox bookmarks live in places.sqlite. Columns: url, title, folder. */
export const FIREFOX_BOOKMARKS_SQL =
  "SELECT p.url AS url, b.title AS title, parent.title AS folder FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id LEFT JOIN moz_bookmarks parent ON b.parent = parent.id WHERE b.type = 1 AND p.url NOT LIKE 'place:%'";

const FIREFOX_ROOT_FOLDERS: Record<string, string> = { toolbar: "Bookmarks Toolbar", menu: "Bookmarks Menu", unfiled: "Other Bookmarks", mobile: "Mobile Bookmarks" };

export type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v) || 0);

export function historyRowsToEntries(engine: Engine, rows: readonly Row[]): Entry[] {
  const toMs = engine === "chromium" ? webkitToMs : engine === "firefox" ? (us: number) => us / 1000 : cocoaToMs;
  const out: Entry[] = [];
  for (const r of rows) {
    const url = s(r.url);
    if (!url || !openable(url)) continue;
    out.push({ type: "history", url, title: s(r.title).trim() || url, visitCount: n(r.visits), lastVisit: Math.round(toMs(n(r.last))) });
  }
  return out;
}

export function firefoxBookmarkRows(rows: readonly Row[]): Entry[] {
  const out: Entry[] = [];
  for (const r of rows) {
    const url = s(r.url);
    if (!url || !openable(url)) continue;
    const f = s(r.folder);
    const folder = FIREFOX_ROOT_FOLDERS[f] ?? f;
    out.push({ type: "bookmark", url, title: s(r.title).trim() || url, ...(folder ? { folder } : {}) });
  }
  return out;
}

/** Favicon queries; columns: page_url, image (PNG/ICO blob), width. */
export function faviconQuery(engine: Engine): string | undefined {
  if (engine === "chromium")
    return "SELECT m.page_url AS page_url, b.image_data AS image, b.width AS width FROM icon_mapping m JOIN favicon_bitmaps b ON b.icon_id = m.icon_id WHERE b.width IN (16, 32) AND length(b.image_data) > 0";
  if (engine === "firefox")
    return "SELECT p.page_url AS page_url, i.data AS image, i.width AS width FROM moz_pages_w_icons p JOIN moz_icons_to_pages ip ON ip.page_id = p.id JOIN moz_icons i ON i.id = ip.icon_id WHERE i.width IN (16, 32) AND length(i.data) > 0";
  return undefined;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const mime = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0 && b[1] === 0 && b[2] === 1 ? "image/x-icon" : b[0] === 0x3c ? "image/svg+xml" : "image/png");

/** host → data URL, preferring 32px, only for the requested hosts. */
export function faviconsByHost(rows: readonly Row[], wanted: ReadonlySet<string>): Map<string, string> {
  const best = new Map<string, { w: number; url: string }>();
  for (const r of rows) {
    const host = hostOf(s(r.page_url));
    if (!host || !wanted.has(host)) continue;
    const img = r.image;
    if (!(img instanceof Uint8Array) || img.length === 0 || img.length > 64 * 1024) continue;
    const w = n(r.width);
    const cur = best.get(host);
    if (cur && cur.w >= w) continue;
    best.set(host, { w, url: `data:${mime(img)};base64,${Buffer.from(img).toString("base64")}` });
  }
  return new Map([...best].map(([h, v]) => [h, v.url]));
}
