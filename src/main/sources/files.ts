/**
 * Root-search file source. Uses the private file index (src/main/features/fileindex)
 * once it is loaded; while the first crawl runs, Spotlight (`mdfind -name`) stands in.
 * `content:<text>` queries go to Spotlight's content index. `~/…` and `/…` browse a folder.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScoredItem, SearchItem } from "@shared/types";
import { expandHome } from "../util/exec";
import { activeFileIndex, activeFileIndexSettings } from "../features/fileindex/api";
import { Spotlight } from "../features/fileindex/spotlight";

export const FILE_SOURCE_ID = "files";
const MDFIND_LIMIT = 15;
const MDFIND_TIMEOUT_MS = 600;
const INDEX_LIMIT = 15;
const BROWSE_LIMIT = 20;
const MIN_QUERY_SPOTLIGHT = 3;
const MIN_QUERY_INDEX = 2;
// Dynamic items sit below strong title matches but above weak fuzzy ones.
const FILE_SCORE = 25;

export interface FileSource {
  search(query: string): Promise<ScoredItem[]>;
  cancel(): void;
}

function fileItem(filePath: string): SearchItem {
  const dir = path.dirname(filePath);
  const home = os.homedir();
  return {
    id: `file:${filePath}`,
    kind: "file",
    title: path.basename(filePath) || filePath,
    subtitle: dir === home ? "~" : dir.replace(home, "~"),
    icon: { kind: "file", value: filePath },
    path: filePath,
    source: FILE_SOURCE_ID,
    // Routed to the fileindex feature for actions (Open With, Quick Look, Trash…) and open-recency boosts.
    feature: activeFileIndex() ? "fileindex" : undefined,
  };
}

function scored(item: SearchItem, index: number, ranges: ScoredItem["ranges"] = []): ScoredItem {
  return { item, score: FILE_SCORE - index * 0.1, matchScore: FILE_SCORE, matchKind: "fuzzy", frecency: 0, ranges };
}

/** `~/Doc` or `/Users/x/D` → list matching entries of the parent directory. */
async function browsePath(query: string): Promise<ScoredItem[]> {
  const expanded = expandHome(query);
  const endsWithSep = expanded.endsWith("/");
  const dir = endsWithSep ? expanded : path.dirname(expanded);
  const prefix = endsWithSep ? "" : path.basename(expanded).toLowerCase();
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => (prefix ? n.toLowerCase().startsWith(prefix) : !n.startsWith(".")))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, BROWSE_LIMIT)
    .map((n, i) => scored(fileItem(path.join(dir, n)), i));
}

export function createFileSource(): FileSource {
  const spotlight = new Spotlight();
  const cancel = () => spotlight.cancel();

  return {
    async search(query) {
      const q = query.trim();
      if (q.startsWith("~") || q.startsWith("/")) return browsePath(q);
      const index = activeFileIndex();
      const prefs = activeFileIndexSettings();
      if (prefs && !prefs.showInRootSearch) {
        cancel();
        return [];
      }
      const content = /^content:\s*/i.exec(q);
      if (content) {
        const text = q.slice(content[0].length).trim();
        if (text.length < MIN_QUERY_SPOTLIGHT) return [];
        const paths = await spotlight.run({ mode: "content", text, scopes: index?.scopes(), limit: MDFIND_LIMIT, timeoutMs: 1500 });
        return paths.map((p, i) => scored(fileItem(p), i));
      }
      if (index?.hasIndex()) {
        cancel();
        if (q.length < MIN_QUERY_INDEX) return [];
        const hits = index.search(q, INDEX_LIMIT) ?? [];
        return hits.map((h, i) => scored(fileItem(h.path), i, h.ranges));
      }
      if (q.length < MIN_QUERY_SPOTLIGHT) {
        cancel();
        return [];
      }
      const paths = await spotlight.run({ mode: "name", text: q, limit: MDFIND_LIMIT, timeoutMs: MDFIND_TIMEOUT_MS });
      return paths.map((p, i) => scored(fileItem(p), i));
    },
    cancel,
  };
}
