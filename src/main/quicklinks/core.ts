/** Quicklink logic that does not touch Electron: arguments, URL building, import/export (pure). */
import type { Quicklink } from "@shared/types";
import { argumentsOf, parseTemplate, renderTokens, type ArgumentDef, type RenderEnv } from "./placeholders";

export type { ArgumentDef } from "./placeholders";

export function quicklinkArguments(url: string): ArgumentDef[] {
  return argumentsOf(url);
}

/**
 * Values for each argument: explicit per-name values (multi-argument launcher entry) win; a plain
 * argument string (text typed after the name, or a single-argument field) fills the first argument.
 */
export function argumentValues(defs: ArgumentDef[], named: Record<string, string> | undefined, argument: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) {
    const v = named?.[d.name];
    if (v !== undefined && v !== "") out[d.name] = v;
  }
  const first = defs[0];
  if (first && out[first.name] === undefined && argument?.trim()) out[first.name] = argument.trim();
  return out;
}

/** Required arguments (no default) that are still empty. */
export function missingArguments(defs: ArgumentDef[], values: Record<string, string>): ArgumentDef[] {
  return defs.filter((d) => !d.optional && !(values[d.name] ?? "").trim());
}

/** Values outside a closed option list are rejected so a typo never opens a wrong URL. */
export function invalidOptions(defs: ArgumentDef[], values: Record<string, string>): ArgumentDef[] {
  return defs.filter((d) => d.options?.length && values[d.name] && !d.options.includes(values[d.name]!));
}

export function buildQuicklinkUrl(url: string, env: RenderEnv): string {
  return renderTokens(parseTemplate(url), env, { encode: true }).trim();
}

export function needsClipboard(url: string): boolean {
  return /\{clipboard\b/.test(url);
}
export function needsSelection(url: string): boolean {
  return /\{selection\b/.test(url);
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export interface QuicklinkExport {
  format: "glide.quicklinks";
  version: 1;
  exportedAt: string;
  quicklinks: Array<Omit<Quicklink, "id"> & { id?: string }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function exportQuicklinks(list: Quicklink[], now = new Date()): QuicklinkExport {
  return {
    format: "glide.quicklinks",
    version: 1,
    exportedAt: now.toISOString(),
    // Favicons are data URLs: keep them so an import on another Mac needs no network.
    quicklinks: list.map((q) => ({ ...q })),
  };
}

/**
 * Accepts Glide exports ({quicklinks:[…]} or a bare array) and Raycast's quicklink export
 * ([{name, link, openWith?}]). Returns new quicklinks without ids plus the number skipped.
 */
export function parseQuicklinkImport(json: string): { quicklinks: Array<Omit<Quicklink, "id">>; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The file is not valid JSON");
  }
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.quicklinks) ? raw.quicklinks : isRecord(raw) && Array.isArray(raw.items) ? raw.items : null;
  if (!list) throw new Error("No quicklinks found (expected an array or {quicklinks: [...]})");
  const out: Array<Omit<Quicklink, "id">> = [];
  let skipped = 0;
  for (const r of list) {
    if (!isRecord(r)) {
      skipped++;
      continue;
    }
    const name = s(r.name) || s(r.title);
    const url = s(r.url) || s(r.link);
    if (!name || !url) {
      skipped++;
      continue;
    }
    const q: Omit<Quicklink, "id"> = { name, url };
    const alias = s(r.alias);
    if (alias) q.alias = alias;
    if (Array.isArray(r.keywords)) q.keywords = r.keywords.filter((k): k is string => typeof k === "string");
    const openWith = s(r.openWith) || s(r.application) || (isRecord(r.openWith) ? s(r.openWith.path) || s(r.openWith.bundleId) : "");
    if (openWith) q.openWith = openWith;
    if (isRecord(r.icon) && typeof r.icon.kind === "string" && typeof r.icon.value === "string") {
      const kind = r.icon.kind;
      if (kind === "emoji" || kind === "symbol" || kind === "app" || kind === "file" || kind === "url" || kind === "color") q.icon = { kind, value: r.icon.value };
    }
    out.push(q);
  }
  return { quicklinks: out, skipped };
}

const urlKey = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

/** Drop entries whose URL already exists (or repeats within the batch). */
export function dedupeByUrl<T extends { url: string }>(incoming: T[], existing: Array<{ url: string }>): T[] {
  const seen = new Set(existing.map((e) => urlKey(e.url)));
  return incoming.filter((q) => {
    const k = urlKey(q.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface BookmarkLike {
  title: string;
  url: string;
  folder?: string;
  icon?: string;
}

/** Bookmarks → quicklinks (only http(s); javascript:/place: bookmarks are skipped). */
export function bookmarksToQuicklinks(rows: BookmarkLike[]): Array<Omit<Quicklink, "id">> {
  return rows
    .filter((r) => /^https?:\/\//i.test(r.url))
    .map((r) => ({
      name: r.title.trim() || r.url,
      url: r.url,
      ...(r.icon?.startsWith("data:image/") ? { icon: { kind: "url" as const, value: r.icon } } : {}),
      ...(r.folder ? { keywords: r.folder.split("/").map((f) => f.trim().toLowerCase()).filter(Boolean) } : {}),
    }));
}

/** Origin of a quicklink for favicon lookup; undefined for templates whose host is a placeholder or non-http. */
export function faviconOrigin(url: string): string | undefined {
  const m = /^(https?:\/\/[^/?#{}\s]+)/i.exec(url.trim());
  if (!m) return undefined;
  try {
    return new URL(m[1]!).origin;
  } catch {
    return undefined;
  }
}
