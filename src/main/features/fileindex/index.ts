/**
 * "fileindex" feature: a private file-name index modelled on Raycast's
 * minidex (research/04). Root search reaches it through src/main/sources/files.ts;
 * the "Search Files" view, settings page and actions talk to it via `methods`.
 */
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clipboard, dialog, shell } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { setActiveFileIndex } from "./api";
import { displayFolder, readPreview } from "./preview";
import { FileIndexService, type IndexStatus } from "./service";
import { DEFAULT_FILEINDEX_SETTINGS, normaliseSettings, type FileIndexSettings } from "./settings";
import { Spotlight } from "./spotlight";
import type { AppDTO, FileHitDTO, SearchResultDTO } from "./types";
import { classify, KIND_LABELS } from "./kinds";
import type { FileHit } from "./query";

const ID = "fileindex";
const VIEW_SEARCH = `${ID}.search`;
const VIEW_STATUS = `${ID}.status`;
const VIEW_OPEN_WITH = `${ID}.openWith`;

let ctx: FeatureContext | null = null;
let service: FileIndexService | null = null;
const contentSpotlight = new Spotlight();
const fallbackSpotlight = new Spotlight();

const settings = (): FileIndexSettings => normaliseSettings(ctx ? ctx.settings(DEFAULT_FILEINDEX_SETTINGS) : DEFAULT_FILEINDEX_SETTINGS);

// -------------------------------------------------------------------- items

const A = (id: string, title: string, shortcut?: string, extra: Partial<ItemAction> = {}): ItemAction => ({ id, title, shortcut, ...extra });

export const FILE_ACTIONS: ItemAction[] = [
  A("open", "Open", "⏎"),
  A("reveal", "Show in Finder", "⌘⏎"),
  A("openWith", "Open With…", "⌘O"),
  A("copyPath", "Copy Path", "⇧⌘C"),
  A("copyFile", "Copy File", "⇧⌘."),
  A("quickLook", "Quick Look", "⌘Y"),
  A("trash", "Move to Trash", "⌃X", { destructive: true }),
];

function commandItems(): SearchItem[] {
  const base = { kind: "command" as const, feature: ID, kindLabel: "File Search" };
  return [
    { ...base, id: `${ID}:search`, title: "Search Files", subtitle: "Private file index", icon: { kind: "symbol", value: "magnifyingglass" }, keywords: ["find", "files", "folders", "documents", "finder"] },
    { ...base, id: `${ID}:reindex`, title: "Reindex Files", subtitle: "Re-crawl File Search scopes", icon: { kind: "symbol", value: "folder" }, keywords: ["rebuild", "index", "files"] },
    { ...base, id: `${ID}:status`, title: "File Index Status", subtitle: "Entries, last index time, scopes", icon: { kind: "symbol", value: "doc" }, keywords: ["index", "files", "status"] },
  ];
}

export function fileSearchItem(p: string, ranges: FileHit["ranges"] = []): SearchItem {
  return {
    id: `file:${p}`,
    kind: "file",
    title: path.basename(p) || p,
    subtitle: displayFolder(p),
    icon: { kind: "file", value: p },
    path: p,
    source: "files",
    feature: ID,
    data: { ranges },
  };
}

// ------------------------------------------------------------------ actions

const ok = (message?: string, hide = true): ExecuteResult => ({ ok: true, hide, message });
const fail = (error: string): ExecuteResult => ({ ok: false, error });

function osascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => execFile("osascript", ["-e", script], { timeout: 5000 }, (err) => (err ? reject(err) : resolve())));
}

const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export async function runFileAction(p: string, actionId: string, extra?: { appPath?: string }): Promise<ExecuteResult> {
  if (!p) return fail("Item has no path");
  switch (actionId) {
    case "open": {
      const err = await shell.openPath(p);
      if (err) return fail(err);
      service?.recordOpen(p);
      return ok();
    }
    case "reveal":
      shell.showItemInFolder(p);
      service?.recordOpen(p);
      return ok();
    case "openWith":
      if (extra?.appPath) {
        await new Promise<void>((resolve, reject) => execFile("open", ["-a", extra.appPath!, p], (err) => (err ? reject(err) : resolve())));
        service?.recordOpen(p);
        return ok();
      }
      return { ok: true, view: { id: VIEW_OPEN_WITH, props: { path: p } } };
    case "copyPath":
      clipboard.writeText(p);
      return ok("Path copied");
    case "copyFile":
      // A Finder-pasteable file reference (NSFilenamesPboardType) via AppleScript.
      await osascript(`set the clipboard to (POSIX file ${appleScriptString(p)})`);
      return ok("File copied");
    case "quickLook": {
      const child = spawn("qlmanage", ["-p", p], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
      return ok(undefined, true);
    }
    case "trash": {
      ctx?.hideLauncher();
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Cancel", "Move to Trash"],
        defaultId: 1,
        cancelId: 0,
        message: `Move “${path.basename(p)}” to the Trash?`,
        detail: p,
      });
      if (response !== 1) return ok(undefined, true);
      await shell.trashItem(p);
      await service?.forget(p);
      return ok("Moved to Trash");
    }
  }
  return fail(`Unknown action ${actionId}`);
}

// ------------------------------------------------------------------ methods

function toDTO(h: { path: string; name: string; isDir: boolean; size: number; mtime: number; kind: FileHitDTO["kind"]; ranges: FileHitDTO["ranges"] }): FileHitDTO {
  return { path: h.path, name: h.name, folder: displayFolder(h.path), isDir: h.isDir, size: h.size, mtime: h.mtime, kind: h.kind, kindLabel: KIND_LABELS[h.kind], ranges: h.ranges };
}

async function pathsToDTO(paths: string[]): Promise<FileHitDTO[]> {
  return Promise.all(
    paths.map(async (p) => {
      const st = await fsp.stat(p).catch(() => null);
      const isDir = st?.isDirectory() ?? false;
      return toDTO({ path: p, name: path.basename(p), isDir, size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0, kind: classify(path.basename(p), isDir), ranges: [] });
    }),
  );
}

export async function searchFiles(query: string, limit = 20): Promise<SearchResultDTO> {
  const t0 = performance.now();
  const q = query.trim();
  const content = /^content:\s*/i.exec(q);
  if (content) {
    const text = q.slice(content[0].length).trim();
    if (!text) return { source: "content", hits: [], tookMs: 0 };
    const paths = await contentSpotlight.run({ mode: "content", text, scopes: service?.scopes(), limit, timeoutMs: 2500 });
    return { source: "content", hits: await pathsToDTO(paths), tookMs: performance.now() - t0 };
  }
  const hits = service?.search(q, limit);
  if (hits) return { source: "index", hits: hits.map(toDTO), tookMs: performance.now() - t0 };
  // First crawl still running: Spotlight stands in.
  const parsed = service?.parse(q);
  const text = parsed?.text ?? q;
  if (text.length < 2) return { source: "spotlight", hits: [], tookMs: 0 };
  const paths = await fallbackSpotlight.run({ mode: "name", text, scopes: service?.scopes(), limit, timeoutMs: 1500 });
  return { source: "spotlight", hits: await pathsToDTO(paths), tookMs: performance.now() - t0 };
}

async function listApps(): Promise<AppDTO[]> {
  const dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities", path.join(os.homedir(), "Applications")];
  const seen = new Set<string>();
  const out: AppDTO[] = [];
  for (const d of dirs) {
    const names = await fsp.readdir(d).catch(() => [] as string[]);
    for (const n of names) {
      if (!n.endsWith(".app") || seen.has(n)) continue;
      seen.add(n);
      out.push({ name: n.slice(0, -4), path: path.join(d, n) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

let statusTimer: NodeJS.Timeout | undefined;
function emitStatus(): void {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = undefined;
    if (service) ctx?.emit("status", service.status());
  }, 250);
}

// ------------------------------------------------------------------ feature

export const feature: FeatureModule = {
  id: ID,

  async start(c) {
    ctx = c;
    service = new FileIndexService({
      dataDir: c.dataDir(),
      home: os.homedir(),
      getSettings: settings,
      workerPath: path.join(__dirname, "fileindex-worker.cjs"),
      log: (...a) => c.log(...a),
      onStatus: emitStatus,
    });
    setActiveFileIndex({ service, settings });
    // Loading is synchronous and fast; the crawl and watcher run in the background.
    await service.start();
  },

  async stop() {
    setActiveFileIndex(null);
    contentSpotlight.cancel();
    fallbackSpotlight.cancel();
    await service?.stop();
    service = null;
  },

  items: commandItems,

  actions(item) {
    if (item.kind === "file") return FILE_ACTIONS.map((a) => ({ ...a }));
    if (item.id === `${ID}:reindex`) return [A("run", "Reindex Files", "⏎")];
    return [A("open", "Open", "⏎")];
  },

  async runAction(scored: ScoredItem, actionId: string): Promise<ExecuteResult> {
    const item = scored.item;
    if (item.kind === "file") return runFileAction(item.path ?? "", actionId);
    switch (item.id) {
      case `${ID}:search`:
        return { ok: true, view: { id: VIEW_SEARCH } };
      case `${ID}:status`:
        return { ok: true, view: { id: VIEW_STATUS } };
      case `${ID}:reindex`:
        void service?.rebuild();
        return { ok: true, hide: false, message: "Reindexing files in the background…" };
    }
    return fail("Unknown command");
  },

  methods: {
    search: (query: unknown, limit: unknown) => searchFiles(str(query), typeof limit === "number" ? Math.min(200, Math.max(1, limit)) : 20),
    readPreview: (p: unknown) => readPreview(str(p)),
    action: (p: unknown, actionId: unknown, appPath: unknown) => runFileAction(str(p), str(actionId), typeof appPath === "string" ? { appPath } : undefined),
    listApps: () => listApps(),
    status: (): IndexStatus | null => service?.status() ?? null,
    rebuild: () => {
      void service?.rebuild();
      return service?.status() ?? null;
    },
    getSettings: () => settings(),
    setSettings: (patch: unknown) => {
      if (!ctx || typeof patch !== "object" || patch === null) return settings();
      const merged = normaliseSettings({ ...settings(), ...(patch as Record<string, unknown>) });
      ctx.setSettings(merged);
      service?.settingsChanged();
      return settings();
    },
    recordOpen: (p: unknown) => service?.recordOpen(str(p)),
  },
};
