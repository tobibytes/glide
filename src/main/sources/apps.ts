import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { SearchItem } from "@shared/types";
import { exec, expandHome } from "../util/exec";

export const APP_SOURCE_ID = "apps";
const RESCAN_INTERVAL_MS = 10 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 3000;
const MAX_DEPTH = 2;
const PLIST_CONCURRENCY = 8;
// Always present even when the user removes the system directories.
const EXTRA_APPS = ["/System/Library/CoreServices/Finder.app", "/System/Applications/System Settings.app"];

export interface AppSource {
  items(): SearchItem[];
  rescan(): Promise<void>;
  onChange(cb: () => void): () => void;
  dispose(): void;
}

interface BundleInfo {
  CFBundleName?: string;
  CFBundleDisplayName?: string;
  CFBundleIdentifier?: string;
}

async function findBundles(dir: string, depth: number, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith(".app")) out.push(full);
    else if (entry.isDirectory() && depth < MAX_DEPTH) await findBundles(full, depth + 1, out);
  }
}

async function readBundleInfo(appPath: string): Promise<BundleInfo> {
  const plist = path.join(appPath, "Contents", "Info.plist");
  try {
    const res = await exec("plutil", ["-convert", "json", "-o", "-", plist], { timeoutMs: 4000 });
    if (res.code !== 0) return {};
    const parsed: unknown = JSON.parse(res.stdout);
    if (typeof parsed !== "object" || parsed === null) return {};
    const rec = parsed as Record<string, unknown>;
    const str = (k: string) => (typeof rec[k] === "string" ? (rec[k] as string) : undefined);
    return { CFBundleName: str("CFBundleName"), CFBundleDisplayName: str("CFBundleDisplayName"), CFBundleIdentifier: str("CFBundleIdentifier") };
  } catch {
    return {};
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toItem(appPath: string, info: BundleInfo): SearchItem {
  // Finder shows the bundle's file name, so that is the title users expect;
  // plist names and the bundle id's last segment become lower-weight keywords.
  const title = path.basename(appPath, ".app");
  const keywords = new Set<string>();
  for (const k of [info.CFBundleDisplayName, info.CFBundleName]) if (k && k !== title) keywords.add(k);
  const idTail = info.CFBundleIdentifier?.split(".").pop();
  if (idTail && idTail.toLowerCase() !== title.toLowerCase()) keywords.add(idTail);
  return {
    id: `app:${appPath}`,
    kind: "app",
    title,
    icon: { kind: "app", value: appPath },
    keywords: [...keywords],
    path: appPath,
    source: APP_SOURCE_ID,
  };
}

export function createAppSource(getDirectories: () => string[]): AppSource {
  let items: SearchItem[] = [];
  const listeners = new Set<() => void>();
  const watchers: fs.FSWatcher[] = [];
  let scanning: Promise<void> | undefined;
  let watchTimer: NodeJS.Timeout | undefined;

  const scan = async (): Promise<void> => {
    const dirs = getDirectories().map(expandHome);
    const found: string[] = [];
    for (const dir of dirs) await findBundles(dir, 0, found);
    for (const extra of EXTRA_APPS) if (fs.existsSync(extra)) found.push(extra);
    const unique = [...new Set(found)];
    const infos = await mapLimit(unique, PLIST_CONCURRENCY, readBundleInfo);
    const seenBundleIds = new Set<string>();
    const next: SearchItem[] = [];
    unique.forEach((appPath, i) => {
      const info = infos[i] ?? {};
      if (info.CFBundleIdentifier) {
        if (seenBundleIds.has(info.CFBundleIdentifier)) return;
        seenBundleIds.add(info.CFBundleIdentifier);
      }
      next.push(toItem(appPath, info));
    });
    next.sort((a, b) => a.title.localeCompare(b.title));
    items = next;
    listeners.forEach((cb) => cb());
  };

  const rescan = (): Promise<void> => {
    if (!scanning) scanning = scan().finally(() => (scanning = undefined));
    return scanning;
  };

  const setupWatchers = () => {
    watchers.splice(0).forEach((w) => w.close());
    for (const dir of getDirectories().map(expandHome)) {
      try {
        const w = fs.watch(dir, { persistent: false }, () => {
          if (watchTimer) clearTimeout(watchTimer);
          watchTimer = setTimeout(() => void rescan(), WATCH_DEBOUNCE_MS);
        });
        w.on("error", () => undefined);
        watchers.push(w);
      } catch {
        // directory missing or not watchable; the periodic rescan still covers it
      }
    }
  };

  const timer = setInterval(() => void rescan(), RESCAN_INTERVAL_MS);
  setupWatchers();

  return {
    items: () => items,
    rescan: () => {
      setupWatchers();
      return rescan();
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: () => {
      clearInterval(timer);
      if (watchTimer) clearTimeout(watchTimer);
      watchers.forEach((w) => w.close());
    },
  };
}
