/** Typed renderer calls into the main-process "quicklinks" and "snippets" feature modules. */
import type { Quicklink, Snippet } from "@shared/types";
import { glide } from "../../../lib/glide";

export interface ArgDef {
  name: string;
  placeholder: string;
  default?: string;
  options?: string[];
  optional: boolean;
}

export interface BookmarkCandidate {
  title: string;
  url: string;
  folder?: string;
  browser: string;
  icon?: string;
  exists: boolean;
}

export interface ImportCount {
  added: number;
  duplicates: number;
  skipped?: number;
  keywordConflicts?: number;
  unsupported?: string[];
}

export interface SnippetSettings {
  keywordPrefix: string;
  caseAdaptive: boolean;
  excludedApps: string[];
}

export interface Rendered {
  text: string;
  html?: string;
  cursorLeft: number;
}

const ql = <T>(method: string, ...args: unknown[]) => glide().feature<T>("quicklinks", method, ...args);
const sn = <T>(method: string, ...args: unknown[]) => glide().feature<T>("snippets", method, ...args);

export const quicklinksApi = {
  save: (q: Partial<Quicklink>, fetchFavicon: boolean) => ql<Quicklink>("save", q, { fetchFavicon }),
  arguments: (url: string) => ql<ArgDef[]>("arguments", url),
  preview: (url: string, values: Record<string, string>) => ql<{ url?: string; error?: string }>("preview", url, values),
  importJson: (json: string) => ql<ImportCount>("importJson", json),
  exportJson: () => ql<string>("exportJson"),
  importFile: () => ql<ImportCount | null>("importFile"),
  exportFile: () => ql<string | null>("exportFile"),
  bookmarks: (query: string, limit = 200) => ql<BookmarkCandidate[]>("bookmarks", query, limit),
  importBookmarks: (rows: BookmarkCandidate[]) => ql<ImportCount>("importBookmarks", rows),
  clipboardUrl: () => ql<string>("clipboardUrl"),
};

export const snippetsApi = {
  getSettings: () => sn<SnippetSettings>("getSettings"),
  setSettings: (patch: Partial<SnippetSettings>) => sn<SnippetSettings>("setSettings", patch),
  save: (s: Partial<Snippet>) => sn<Snippet>("save", s),
  remove: (id: string) => sn<void>("delete", id),
  preview: (text: string, html?: string) => sn<Rendered>("preview", text, html ?? ""),
  render: (id: string) => sn<Rendered | null>("render", id),
  paste: (id: string) => sn<{ ok: boolean; error?: string; message?: string }>("paste", id),
  copy: (id: string) => sn<{ ok: boolean; error?: string; message?: string }>("copy", id),
  keywordWarning: (keyword: string) => sn<string | null>("keywordWarning", keyword),
  importJson: (json: string) => sn<ImportCount>("importJson", json),
  exportJson: () => sn<string>("exportJson"),
  importFile: () => sn<ImportCount | null>("importFile"),
  exportFile: () => sn<string | null>("exportFile"),
  runningApps: () => sn<Array<{ name: string; bundleId: string }>>("runningApps"),
};

export function importSummary(r: ImportCount | null, noun: string): string {
  if (!r) return "Import cancelled";
  const parts = [`Imported ${r.added} ${noun}${r.added === 1 ? "" : "s"}`];
  if (r.duplicates) parts.push(`${r.duplicates} already existed`);
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  if (r.keywordConflicts) parts.push(`${r.keywordConflicts} keywords already in use`);
  if (r.unsupported?.length) parts.push(`kept literally: ${r.unsupported.join(" ")}`);
  return parts.join(" · ");
}
