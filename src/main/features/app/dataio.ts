/** Export / import / reset of data.json. Pure helpers are separated from the Electron dialogs in index.ts. */
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SETTINGS, type Quicklink, type Settings, type Snippet, type UserData, type Workflow } from "@shared/types";
import { seedQuicklinks, seedSnippets, seedWorkflows } from "../../seed";
import type { Store } from "../../store";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strMap = (v: unknown): Record<string, string> =>
  isRecord(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
const records = <T>(v: unknown, required: string[]): T[] =>
  Array.isArray(v) ? (v.filter((x) => isRecord(x) && required.every((k) => typeof x[k] === "string")) as T[]) : [];

export interface ExportFile {
  app: "Glide";
  version: string;
  exportedAt: string;
  data: UserData;
}

export function buildExport(data: UserData, version: string, now = new Date()): ExportFile {
  return { app: "Glide", version, exportedAt: now.toISOString(), data };
}

/** Accepts an export file or a raw data.json. Throws a user-readable error when it is neither. */
export function parseImport(raw: unknown): UserData {
  const body = isRecord(raw) && raw.app === "Glide" && isRecord(raw.data) ? raw.data : raw;
  if (!isRecord(body) || !isRecord(body.settings)) throw new Error("This file is not a Glide settings export (no \"settings\" object).");
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(body.settings)) {
    const key = k as keyof Settings;
    if (key in DEFAULT_SETTINGS && typeof v === typeof DEFAULT_SETTINGS[key] && Array.isArray(v) === Array.isArray(DEFAULT_SETTINGS[key])) {
      (settings as unknown as Record<string, unknown>)[key] = v;
    }
  }
  return {
    settings,
    workflows: records<Workflow>(body.workflows, ["id", "name"]),
    quicklinks: records<Quicklink>(body.quicklinks, ["id", "name", "url"]),
    snippets: records<Snippet>(body.snippets, ["id", "name", "text"]),
    favorites: Array.isArray(body.favorites) ? body.favorites.filter((f): f is string => typeof f === "string") : [],
    aliases: strMap(body.aliases),
    hotkeys: strMap(body.hotkeys),
  };
}

export function freshData(now = Date.now()): UserData {
  return {
    settings: { ...DEFAULT_SETTINGS, features: {} },
    workflows: seedWorkflows(now),
    quicklinks: seedQuicklinks(),
    snippets: seedSnippets(),
    favorites: [],
    aliases: {},
    hotkeys: {},
  };
}

export function replaceData(store: Store, next: UserData): void {
  store.mutate((d) => {
    Object.assign(d, next);
  });
}

/** Writes a timestamped copy of the current data to <userData>/backups/ and returns its path. */
export async function backupData(userDataDir: string, data: UserData, reason: string): Promise<string> {
  const dir = path.join(userDataDir, "backups");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `data-${reason}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  return file;
}
