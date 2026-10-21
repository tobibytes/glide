/** Snippet library import (Raycast's export JSON and Glide's own) and export (pure). */
import type { Snippet } from "@shared/types";
import { PLACEHOLDER_NAMES } from "../quicklinks/placeholders";

export interface SnippetExport {
  format: "glide.snippets";
  version: 1;
  exportedAt: string;
  snippets: Array<Omit<Snippet, "id"> & { id?: string }>;
}

export interface SnippetImportResult {
  snippets: Array<Omit<Snippet, "id">>;
  skipped: number;
  /** Raycast placeholders Glide leaves as literal text, e.g. "{browser-tab}" (deduplicated). */
  unsupported: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown) => (typeof v === "string" ? v : "");
const KNOWN = new Set<string>(PLACEHOLDER_NAMES);

export function exportSnippets(list: Snippet[], now = new Date()): SnippetExport {
  return { format: "glide.snippets", version: 1, exportedAt: now.toISOString(), snippets: list.map((x) => ({ ...x })) };
}

/** Raycast's export is a bare array of `{name, text, keyword?}`; Glide's wraps it in `{snippets: […]}`. */
export function parseSnippetImport(json: string): SnippetImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The file is not valid JSON");
  }
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.snippets) ? raw.snippets : null;
  if (!list) throw new Error("No snippets found (expected Raycast's snippet export: an array of {name, text, keyword})");
  const out: Array<Omit<Snippet, "id">> = [];
  const unsupported = new Set<string>();
  let skipped = 0;
  for (const r of list) {
    if (!isRecord(r)) {
      skipped++;
      continue;
    }
    const name = s(r.name).trim() || s(r.title).trim();
    const text = s(r.text) || s(r.content);
    if (!name || !text) {
      skipped++;
      continue;
    }
    for (const m of text.matchAll(/\{([a-z][a-z-]*)\b[^{}\n]*\}/g)) if (!KNOWN.has(m[1]!)) unsupported.add(`{${m[1]}}`);
    const sn: Omit<Snippet, "id"> = { name, text };
    const keyword = s(r.keyword).trim();
    if (keyword) sn.keyword = keyword;
    const alias = s(r.alias).trim();
    if (alias) sn.alias = alias;
    const html = s(r.html);
    if (html.trim()) sn.html = html;
    if (Array.isArray(r.excludedApps)) sn.excludedApps = r.excludedApps.filter((x): x is string => typeof x === "string");
    out.push(sn);
  }
  return { snippets: out, skipped, unsupported: [...unsupported] };
}

/**
 * Merge imported snippets: same name + same text is a duplicate (skipped); a keyword already used
 * by another snippet is dropped from the import (the snippet still imports, searchable by name).
 */
export function mergeImported(incoming: Array<Omit<Snippet, "id">>, existing: Snippet[]): { add: Array<Omit<Snippet, "id">>; duplicates: number; keywordConflicts: number } {
  const keyOf = (x: { name: string; text: string }) => `${x.name.trim().toLowerCase()}\n${x.text}`;
  const seen = new Set(existing.map(keyOf));
  const keywords = new Set(existing.map((e) => e.keyword?.trim()).filter((k): k is string => !!k));
  const add: Array<Omit<Snippet, "id">> = [];
  let duplicates = 0;
  let keywordConflicts = 0;
  for (const sn of incoming) {
    const k = keyOf(sn);
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    const next = { ...sn };
    if (next.keyword && keywords.has(next.keyword)) {
      delete next.keyword;
      keywordConflicts++;
    } else if (next.keyword) keywords.add(next.keyword);
    add.push(next);
  }
  return { add, duplicates, keywordConflicts };
}
