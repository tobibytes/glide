/**
 * Settings Sync & Backup through a folder the user picks (iCloud Drive, Dropbox, a USB stick):
 * no network APIs. Each Mac writes <folder>/Glide Sync/<machine>.json; "Sync Now" merges every
 * machine's file per item by last-modified (./merge.ts) and applies the result through the store.
 * Rolling local backups (last 10) live in this feature's data dir and can be restored with a preview.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialog, shell } from "electron";
import type { ItemAction } from "@shared/ipc";
import type { SearchItem, UserData } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import {
  findConflicts,
  flatten,
  machineSlug,
  mergeSnapshots,
  parseSyncFile,
  previewChanges,
  SYNC_FORMAT_VERSION,
  trackLocal,
  unflatten,
  valuesOf,
  type ChangePreview,
  type Conflict,
  type Snapshot,
  type SyncFile,
} from "./merge";

export interface SyncSettings {
  folder: string;
  auto: boolean;
  intervalMinutes: number;
  machine: string;
}

export interface BackupInfo {
  id: string;
  createdAt: number;
  reason: string;
  items: number;
}

export interface SyncStatus {
  settings: SyncSettings;
  syncDir: string | null;
  lastSyncAt: number;
  lastResult: string;
  lastError: string;
  machines: Array<{ machine: string; exportedAt: number; items: number; self: boolean }>;
  conflicts: Conflict[];
  backups: BackupInfo[];
}

interface State {
  manifest: Snapshot;
  lastSyncAt: number;
  lastResult: string;
  lastError: string;
  conflicts: Conflict[];
}

const MAX_BACKUPS = 10;
const MAX_CONFLICTS = 100;
const SYNC_DIR = "Glide Sync";

let ctx: FeatureContext | undefined;
let state: State = { manifest: {}, lastSyncAt: 0, lastResult: "", lastError: "", conflicts: [] };
let timer: NodeJS.Timeout | undefined;
let running: Promise<SyncResult> | undefined;
let applying = false;

const need = () => {
  if (!ctx) throw new Error("Sync is not ready");
  return ctx;
};

function settings(): SyncSettings {
  const s: Record<string, unknown> = ctx?.settings<Record<string, unknown>>({ folder: "", auto: false, intervalMinutes: 15, machine: "" }) ?? {};
  const n = Number(s.intervalMinutes);
  return {
    folder: typeof s.folder === "string" ? s.folder : "",
    auto: s.auto === true,
    intervalMinutes: Number.isFinite(n) ? Math.min(1440, Math.max(1, Math.round(n))) : 15,
    machine: machineSlug(typeof s.machine === "string" && s.machine.trim() ? s.machine : os.hostname()),
  };
}

const statePath = () => path.join(need().dataDir(), "state.json");
const backupDir = () => {
  const dir = path.join(need().dataDir(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const syncDir = (folder = settings().folder) => (folder ? path.join(folder, SYNC_DIR) : null);

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function loadState(): void {
  const raw = readJson(statePath()) as Partial<State> | undefined;
  if (raw && typeof raw === "object")
    state = {
      manifest: raw.manifest && typeof raw.manifest === "object" ? raw.manifest : {},
      lastSyncAt: typeof raw.lastSyncAt === "number" ? raw.lastSyncAt : 0,
      lastResult: typeof raw.lastResult === "string" ? raw.lastResult : "",
      lastError: typeof raw.lastError === "string" ? raw.lastError : "",
      conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
    };
}

function saveState(): void {
  try {
    writeJsonAtomic(statePath(), state);
  } catch (err) {
    ctx?.log("could not save sync state", err);
  }
}

/** Stamp local edits as they happen, so "last modified" is the edit time rather than the sync time. */
function track(now = Date.now()): void {
  if (!ctx) return;
  state.manifest = trackLocal(state.manifest, flatten(ctx.getData()), now, settings().machine);
  saveState();
}

/** Replace the syncable parts of UserData through the store (one mutation, one change event). */
function applyValues(values: Record<string, unknown>): void {
  const c = need();
  const next = unflatten(c.getData(), values);
  applying = true;
  try {
    c.store.mutate((d: UserData) => {
      d.settings = next.settings;
      d.workflows = next.workflows;
      d.quicklinks = next.quicklinks;
      d.snippets = next.snippets;
      d.favorites = next.favorites;
      d.aliases = next.aliases;
      d.hotkeys = next.hotkeys;
    });
  } finally {
    applying = false;
  }
}

// --- backups --------------------------------------------------------------------

function listBackups(): BackupInfo[] {
  const out: BackupInfo[] = [];
  for (const f of fs.readdirSync(backupDir())) {
    if (!f.endsWith(".json")) continue;
    const raw = readJson(path.join(backupDir(), f)) as { createdAt?: number; reason?: string; values?: Record<string, unknown> } | undefined;
    if (!raw?.values) continue;
    out.push({ id: f.replace(/\.json$/, ""), createdAt: raw.createdAt ?? 0, reason: raw.reason ?? "", items: Object.keys(raw.values).length });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

function makeBackup(reason: string): BackupInfo {
  const now = Date.now();
  const values = flatten(need().getData());
  const id = `backup-${new Date(now).toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  writeJsonAtomic(path.join(backupDir(), `${id}.json`), { app: "glide", kind: "backup", version: SYNC_FORMAT_VERSION, createdAt: now, reason, values });
  for (const old of listBackups().slice(MAX_BACKUPS)) fs.rmSync(path.join(backupDir(), `${old.id}.json`), { force: true });
  return { id, createdAt: now, reason, items: Object.keys(values).length };
}

function backupValues(id: unknown): Record<string, unknown> {
  if (typeof id !== "string" || !/^[\w.-]+$/.test(id)) throw new Error("Invalid backup id");
  const raw = readJson(path.join(backupDir(), `${id}.json`)) as { values?: Record<string, unknown> } | undefined;
  if (!raw?.values || typeof raw.values !== "object") throw new Error("Backup not found or unreadable");
  return raw.values;
}

// --- sync -------------------------------------------------------------------------

export interface SyncResult {
  ok: boolean;
  message: string;
  applied?: ChangePreview;
  conflicts?: number;
}

function readSyncFiles(dir: string): SyncFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: SyncFile[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const parsed = parseSyncFile(readJson(path.join(dir, f)));
    if (parsed) out.push(parsed);
  }
  return out;
}

function writeOwnFile(dir: string, entries: Snapshot): string {
  fs.mkdirSync(dir, { recursive: true });
  const machine = settings().machine;
  const file = path.join(dir, `${machine}.json`);
  const body: SyncFile = { app: "glide", version: SYNC_FORMAT_VERSION, machine, exportedAt: Date.now(), entries };
  writeJsonAtomic(file, body);
  return file;
}

function exportNow(): SyncResult {
  const dir = syncDir();
  if (!dir) return { ok: false, message: "Choose a sync folder first" };
  track();
  const file = writeOwnFile(dir, state.manifest);
  return { ok: true, message: `Exported ${Object.keys(valuesOf(state.manifest)).length} items to ${file}` };
}

async function syncNow(): Promise<SyncResult> {
  if (running) return running;
  running = (async (): Promise<SyncResult> => {
    const dir = syncDir();
    if (!dir) return { ok: false, message: "Choose a sync folder first" };
    if (!fs.existsSync(settings().folder)) return fail(`Sync folder is missing: ${settings().folder}`);
    try {
      const now = Date.now();
      const me = settings().machine;
      track(now);
      const local = state.manifest;
      const others = readSyncFiles(dir)
        .filter((f) => f.machine !== me)
        .map((f) => ({ machine: f.machine, entries: f.entries }));
      const merged = mergeSnapshots([local, ...others.map((o) => o.entries)]);
      const conflicts = findConflicts(local, others, state.lastSyncAt, merged, now);
      const target = valuesOf(merged);
      const preview = previewChanges(need().getData(), target);
      const changes = preview.added.length + preview.removed.length + preview.changed.length;
      if (changes) {
        makeBackup("Before sync");
        applyValues(target);
      }
      // Local now equals the merge, so adopt the merged stamps (no spurious "local edit" next time).
      state.manifest = trackLocal(merged, flatten(need().getData()), now, me);
      writeOwnFile(dir, state.manifest);
      state.lastSyncAt = now;
      state.lastError = "";
      state.conflicts = [...conflicts, ...state.conflicts].slice(0, MAX_CONFLICTS);
      state.lastResult = changes ? `Applied ${changes} change${changes === 1 ? "" : "s"} from ${others.length} other Mac${others.length === 1 ? "" : "s"}` : `Up to date (${others.length} other Mac${others.length === 1 ? "" : "s"})`;
      saveState();
      ctx?.emit("status");
      return { ok: true, message: state.lastResult, applied: preview, conflicts: conflicts.length };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  })().finally(() => {
    running = undefined;
  });
  return running;
}

function fail(message: string): SyncResult {
  state.lastError = message;
  saveState();
  ctx?.emit("status");
  return { ok: false, message };
}

function schedule(): void {
  clearInterval(timer);
  timer = undefined;
  const s = settings();
  if (!s.auto || !s.folder) return;
  // Check every minute; sync when the interval has elapsed (survives sleep better than one long timer).
  timer = setInterval(() => {
    if (Date.now() - state.lastSyncAt >= settings().intervalMinutes * 60_000) void syncNow();
  }, 60_000);
  timer.unref?.();
}

function status(): SyncStatus {
  const s = settings();
  const dir = syncDir();
  return {
    settings: s,
    syncDir: dir,
    lastSyncAt: state.lastSyncAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    machines: dir ? readSyncFiles(dir).map((f) => ({ machine: f.machine, exportedAt: f.exportedAt, items: Object.keys(valuesOf(f.entries)).length, self: f.machine === s.machine })) : [],
    conflicts: state.conflicts,
    backups: listBackups(),
  };
}

function setSyncSettings(patch: unknown): SyncStatus {
  const p = (typeof patch === "object" && patch !== null ? patch : {}) as Partial<SyncSettings>;
  const clean: Record<string, unknown> = {};
  if (typeof p.folder === "string") clean.folder = p.folder.trim() ? path.resolve(p.folder.trim().replace(/^~(?=\/|$)/, os.homedir())) : "";
  if (typeof p.auto === "boolean") clean.auto = p.auto;
  if (typeof p.intervalMinutes === "number") clean.intervalMinutes = p.intervalMinutes;
  if (typeof p.machine === "string") clean.machine = p.machine;
  need().setSettings(clean);
  schedule();
  return status();
}

async function chooseFolder(): Promise<SyncStatus> {
  const res = await dialog.showOpenDialog({ title: "Choose a folder to sync Glide through", message: "Pick a folder in iCloud Drive, Dropbox or any synced location", properties: ["openDirectory", "createDirectory"] });
  if (!res.canceled && res.filePaths[0]) return setSyncSettings({ folder: res.filePaths[0] });
  return status();
}

async function chooseImportFile(): Promise<{ file: string; preview: ChangePreview } | null> {
  const res = await dialog.showOpenDialog({ title: "Import Glide data", defaultPath: syncDir() ?? undefined, properties: ["openFile"], filters: [{ name: "Glide sync or backup", extensions: ["json"] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  return { file: res.filePaths[0], preview: previewChanges(need().getData(), importValues(res.filePaths[0])) };
}

/** A sync file (<machine>.json) or a backup file. */
function importValues(file: unknown): Record<string, unknown> {
  if (typeof file !== "string") throw new Error("Invalid file");
  const raw = readJson(file) as { kind?: string; values?: Record<string, unknown> } | undefined;
  if (raw?.kind === "backup" && raw.values && typeof raw.values === "object") return raw.values;
  const parsed = parseSyncFile(raw);
  if (!parsed) throw new Error("Not a Glide sync or backup file");
  return valuesOf(parsed.entries);
}

function restoreValues(values: Record<string, unknown>, reason: string): SyncResult {
  const preview = previewChanges(need().getData(), values);
  makeBackup(reason);
  applyValues(values);
  track(); // restored items count as fresh local edits, so the next sync spreads them
  ctx?.emit("status");
  const n = preview.added.length + preview.removed.length + preview.changed.length;
  return { ok: true, message: `Restored (${n} change${n === 1 ? "" : "s"})`, applied: preview };
}

const item = (id: string, title: string, subtitle: string, icon: string, keywords: string[]): SearchItem => ({
  id: `sync:${id}`,
  kind: "command",
  kindLabel: "Sync",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "sync",
  data: { action: id },
});

export const feature: FeatureModule = {
  id: "sync",
  start(c) {
    ctx = c;
    loadState();
    track();
    let debounce: NodeJS.Timeout | undefined;
    c.store.on("change", () => {
      if (applying) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => track(), 500);
    });
    schedule();
  },
  stop() {
    clearInterval(timer);
  },
  items: () => {
    const s = settings();
    return [
      item("now", "Sync Settings Now", s.folder ? `via ${path.basename(s.folder)}` : "Choose a sync folder first", "🔄", ["sync", "settings sync", "icloud", "dropbox", "merge"]),
      item("backup", "Back Up Glide Data", "Local backup (keeps the last 10)", "💾", ["backup", "snapshot", "export"]),
      item("settings", "Sync & Backup Settings", "Folder, auto sync, restore", "☁️", ["sync", "backup", "restore", "import", "export"]),
    ];
  },
  actions(i): ItemAction[] {
    if (i.data?.action === "now") return [{ id: "now", title: "Sync Now", shortcut: "⏎" }, { id: "settings", title: "Open Sync Settings", shortcut: "⌘⏎" }];
    if (i.data?.action === "backup") return [{ id: "backup", title: "Back Up Now", shortcut: "⏎" }, { id: "settings", title: "Restore from Backup…", shortcut: "⌘⏎" }];
    if (i.data?.action === "settings") return [{ id: "settings", title: "Open Sync Settings", shortcut: "⏎" }];
    return [];
  },
  async runAction(_scored, actionId) {
    if (actionId === "settings") return { ok: true, navigate: "sync" };
    if (actionId === "backup") {
      const b = makeBackup("Manual");
      return { ok: true, message: `Backed up ${b.items} items` };
    }
    if (actionId === "now") {
      if (!settings().folder) return { ok: true, navigate: "sync" };
      const r = await syncNow();
      return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    status: () => status(),
    setSettings: (patch) => setSyncSettings(patch),
    chooseFolder: () => chooseFolder(),
    revealFolder: () => {
      const dir = syncDir();
      if (dir && fs.existsSync(dir)) void shell.openPath(dir);
      return !!dir;
    },
    syncNow: () => syncNow(),
    exportNow: () => exportNow(),
    backupNow: () => makeBackup("Manual"),
    previewBackup: (id) => previewChanges(need().getData(), backupValues(id)),
    restoreBackup: (id) => restoreValues(backupValues(id), "Before restore"),
    chooseImport: () => chooseImportFile(),
    previewImport: (file) => previewChanges(need().getData(), importValues(file)),
    importFile: (file) => restoreValues(importValues(file), "Before import"),
    clearConflicts: () => {
      state.conflicts = [];
      saveState();
      return status();
    },
  },
};
