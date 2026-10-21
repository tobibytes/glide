/**
 * Settings sync model (pure, unit-tested). UserData is flattened into keyed items
 * ("workflow.<id>", "settings.vimMode", "feature.clipboard", …). Each machine keeps a manifest
 * stamping every item with the time it last changed locally (UserData has no per-item clock, so
 * the stamps live in the sync feature's own state; the schema is untouched). Deletions become
 * tombstones. Merging picks, per key, the entry with the newest stamp; ties are broken by machine
 * name and then by the serialized value, so every machine computes the same result in any order.
 */
import { DEFAULT_SETTINGS, type Quicklink, type Settings, type Snippet, type UserData, type Workflow } from "@shared/types";

export const SYNC_FORMAT_VERSION = 1;

export interface Entry {
  /** The item's value (null for a tombstone). */
  v: unknown;
  /** Last local change, unix ms. */
  t: number;
  /** Machine that made the change. */
  m: string;
  /** Tombstone: the item was deleted. */
  d?: true;
}

export type Snapshot = Record<string, Entry>;

export interface SyncFile {
  app: "glide";
  version: number;
  machine: string;
  exportedAt: number;
  entries: Snapshot;
}

export interface Conflict {
  key: string;
  label: string;
  at: number;
  winner: { machine: string; t: number; deleted: boolean };
  loser: { machine: string; t: number; deleted: boolean };
}

/** Settings that make sense on another Mac (launchAtLogin is per-machine; features are synced per bag). */
export const SYNCED_SETTINGS = (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>).filter((k) => k !== "features" && k !== "launchAtLogin");

/** Feature bags never synced: the sync feature's own (folder paths are per-machine). */
export const LOCAL_FEATURES = new Set(["sync"]);

const SECRET_RE = /(api[-_]?key|secret|token|password|passphrase|credential|private[-_]?key)/i;

const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with sorted object keys, so equal values serialize identically. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isRecord(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export function stripSecrets(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) if (!SECRET_RE.test(k)) out[k] = isRecord(v) ? stripSecrets(v) : v;
  return out;
}

function secretsOf(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) if (SECRET_RE.test(k)) out[k] = v;
  return out;
}

/** UserData → { key: value } for everything that syncs. */
export function flatten(data: UserData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SYNCED_SETTINGS) out[`settings.${k}`] = data.settings[k];
  for (const [id, bag] of Object.entries(data.settings.features ?? {})) if (!LOCAL_FEATURES.has(id) && isRecord(bag)) out[`feature.${id}`] = stripSecrets(bag);
  for (const w of data.workflows) out[`workflow.${w.id}`] = w;
  for (const q of data.quicklinks) out[`quicklink.${q.id}`] = q;
  for (const s of data.snippets) out[`snippet.${s.id}`] = s;
  for (const f of data.favorites) out[`favorite.${f}`] = true;
  for (const [id, a] of Object.entries(data.aliases)) out[`alias.${id}`] = a;
  for (const [id, h] of Object.entries(data.hotkeys)) out[`hotkey.${id}`] = h;
  return out;
}

const splitKey = (key: string): [string, string] => {
  const i = key.indexOf(".");
  return [key.slice(0, i), key.slice(i + 1)];
};

/** Keep base order for items that stay, append new ones in key order (deterministic). */
function collection<T extends { id: string }>(base: T[], values: Record<string, unknown>, kind: string, valid: (v: unknown) => v is T): T[] {
  const wanted = new Map<string, T>();
  for (const [key, v] of Object.entries(values)) {
    const [k, id] = splitKey(key);
    if (k === kind && valid(v) && v.id === id) wanted.set(id, v);
  }
  const kept = base.filter((x) => wanted.has(x.id)).map((x) => wanted.get(x.id)!);
  const added = [...wanted.keys()].filter((id) => !base.some((x) => x.id === id)).sort().map((id) => wanted.get(id)!);
  return [...kept, ...added];
}

const isWorkflow = (v: unknown): v is Workflow => isRecord(v) && typeof v.id === "string" && typeof v.name === "string" && Array.isArray(v.actions);
const isQuicklink = (v: unknown): v is Quicklink => isRecord(v) && typeof v.id === "string" && typeof v.name === "string" && typeof v.url === "string";
const isSnippet = (v: unknown): v is Snippet => isRecord(v) && typeof v.id === "string" && typeof v.name === "string" && typeof v.text === "string";

/**
 * Apply flattened values onto `base`. Collections (workflows, quicklinks, snippets, favorites,
 * aliases, hotkeys) become exactly what `values` lists; settings and feature bags missing from
 * `values` keep their base value; local-only settings, secrets and LOCAL_FEATURES are preserved.
 */
export function unflatten(base: UserData, values: Record<string, unknown>): UserData {
  const settings: Settings = { ...base.settings, features: { ...base.settings.features } };
  for (const k of SYNCED_SETTINGS) {
    const v = values[`settings.${k}`];
    if (v !== undefined && typeof v === typeof DEFAULT_SETTINGS[k] && Array.isArray(v) === Array.isArray(DEFAULT_SETTINGS[k])) (settings as unknown as Record<string, unknown>)[k] = v;
  }
  for (const [key, v] of Object.entries(values)) {
    const [kind, id] = splitKey(key);
    if (kind !== "feature" || LOCAL_FEATURES.has(id) || !isRecord(v)) continue;
    settings.features[id] = { ...stripSecrets(v), ...secretsOf(base.settings.features[id] ?? {}) };
  }
  const strings = (kind: string) => {
    const out: Record<string, string> = {};
    for (const key of Object.keys(values).sort()) {
      const [k, id] = splitKey(key);
      if (k === kind && typeof values[key] === "string") out[id] = values[key] as string;
    }
    return out;
  };
  const favs = Object.keys(values)
    .filter((k) => k.startsWith("favorite.") && values[k] === true)
    .map((k) => splitKey(k)[1]);
  return {
    settings,
    workflows: collection(base.workflows, values, "workflow", isWorkflow),
    quicklinks: collection(base.quicklinks, values, "quicklink", isQuicklink),
    snippets: collection(base.snippets, values, "snippet", isSnippet),
    favorites: [...base.favorites.filter((f) => favs.includes(f)), ...favs.filter((f) => !base.favorites.includes(f)).sort()],
    aliases: strings("alias"),
    hotkeys: strings("hotkey"),
  };
}

/** Live values from a snapshot (tombstones dropped). */
export function valuesOf(s: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(s)) if (!e.d) out[k] = e.v;
  return out;
}

/** Re-stamp the manifest from the current values: unchanged items keep their stamp, changes get `now`, removals become tombstones. */
export function trackLocal(prev: Snapshot, values: Record<string, unknown>, now: number, machine: string): Snapshot {
  const next: Snapshot = {};
  for (const [k, v] of Object.entries(values)) {
    const p = prev[k];
    next[k] = p && !p.d && same(p.v, v) ? p : { v, t: now, m: machine };
  }
  for (const [k, p] of Object.entries(prev)) {
    if (k in values) continue;
    if (p.d) {
      if (now - p.t < TOMBSTONE_TTL_MS) next[k] = p;
    } else next[k] = { v: null, t: now, m: machine, d: true };
  }
  return next;
}

/** Total order on entries: newer wins; ties by machine name, then tombstone, then value. */
export function compareEntries(a: Entry, b: Entry): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.m !== b.m) return a.m < b.m ? -1 : 1;
  if (!!a.d !== !!b.d) return a.d ? 1 : -1;
  const sa = stableStringify(a.v);
  const sb = stableStringify(b.v);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

export function mergeSnapshots(snapshots: Snapshot[]): Snapshot {
  const out: Snapshot = {};
  for (const s of snapshots)
    for (const [k, e] of Object.entries(s)) {
      if (!isValidEntry(e)) continue;
      const cur = out[k];
      if (!cur || compareEntries(e, cur) > 0) out[k] = e;
    }
  return out;
}

export function isValidEntry(e: unknown): e is Entry {
  return isRecord(e) && typeof e.t === "number" && Number.isFinite(e.t) && typeof e.m === "string" && "v" in e;
}

/** Keys both this machine and another changed since the last sync, with different results. */
export function findConflicts(local: Snapshot, others: Array<{ machine: string; entries: Snapshot }>, since: number, merged: Snapshot, now: number): Conflict[] {
  const out: Conflict[] = [];
  for (const o of others)
    for (const [k, theirs] of Object.entries(o.entries)) {
      const mine = local[k];
      if (!mine || !isValidEntry(theirs) || mine.t <= since || theirs.t <= since || mine.m === theirs.m) continue;
      if (!!mine.d === !!theirs.d && same(mine.v, theirs.v)) continue;
      const winner = merged[k] ?? mine;
      const loser = compareEntries(winner, mine) === 0 ? theirs : mine;
      out.push({
        key: k,
        label: describeKey(k, (winner.d ? loser.v : winner.v) ?? mine.v),
        at: now,
        winner: { machine: winner.m, t: winner.t, deleted: !!winner.d },
        loser: { machine: loser.m, t: loser.t, deleted: !!loser.d },
      });
    }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function describeKey(key: string, v: unknown): string {
  const [kind, id] = splitKey(key);
  const name = isRecord(v) && typeof v.name === "string" ? v.name : id;
  switch (kind) {
    case "settings":
      return `Setting: ${id}`;
    case "feature":
      return `${id.charAt(0).toUpperCase()}${id.slice(1)} settings`;
    case "workflow":
      return `Workflow “${name}”`;
    case "quicklink":
      return `Quicklink “${name}”`;
    case "snippet":
      return `Snippet “${name}”`;
    case "favorite":
      return `Favorite ${id}`;
    case "alias":
      return `Alias “${typeof v === "string" ? v : ""}” for ${id}`;
    case "hotkey":
      return `Hotkey ${typeof v === "string" ? v : ""} for ${id}`;
    default:
      return key;
  }
}

export interface ChangePreview {
  added: Array<{ key: string; label: string }>;
  removed: Array<{ key: string; label: string }>;
  changed: Array<{ key: string; label: string }>;
}

/** What applying `target` (collections exact, settings/features overlaid) would do to `current`. */
export function previewChanges(current: UserData, target: Record<string, unknown>): ChangePreview {
  const before = flatten(current);
  const after = flatten(unflatten(current, target));
  const out: ChangePreview = { added: [], removed: [], changed: [] };
  for (const k of Object.keys(after).sort()) {
    if (!(k in before)) out.added.push({ key: k, label: describeKey(k, after[k]) });
    else if (!same(before[k], after[k])) out.changed.push({ key: k, label: describeKey(k, after[k]) });
  }
  for (const k of Object.keys(before).sort()) if (!(k in after)) out.removed.push({ key: k, label: describeKey(k, before[k]) });
  return out;
}

export function parseSyncFile(raw: unknown): SyncFile | null {
  if (!isRecord(raw) || raw.app !== "glide" || typeof raw.version !== "number" || raw.version > SYNC_FORMAT_VERSION) return null;
  if (typeof raw.machine !== "string" || !isRecord(raw.entries)) return null;
  const entries: Snapshot = {};
  for (const [k, e] of Object.entries(raw.entries)) if (isValidEntry(e) && k.includes(".")) entries[k] = e;
  return { app: "glide", version: raw.version, machine: raw.machine, exportedAt: typeof raw.exportedAt === "number" ? raw.exportedAt : 0, entries };
}

/** File-name-safe machine name. */
export function machineSlug(name: string): string {
  return name.replace(/\.local$/i, "").replace(/[^A-Za-z0-9 _-]+/g, "-").replace(/^[\s-]+|[\s-]+$/g, "").slice(0, 60) || "Mac";
}
