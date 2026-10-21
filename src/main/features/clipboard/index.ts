/**
 * Clipboard History: polls the pasteboard, keeps a local, deduplicated history
 * (<dataDir>/history.json + images/), and pastes entries back. Nothing is ever sent off the machine.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { accelToDisplay } from "../../util/accel";
import { pasteFromClipboard } from "../../workflows/runtime";
import type { FeatureContext, FeatureModule } from "../types";
import {
  classifyText,
  computeStats,
  DEFAULT_CLIP_SETTINGS,
  entryTitle,
  filePathsFromUriList,
  filterEntries,
  haystack,
  isConcealed,
  isIgnoredApp,
  normalizeSettings,
  prune,
  summarize,
  touch,
  upsert,
  type ClipCandidate,
  type ClipEntry,
  type ClipFilter,
  type ClipSettings,
  type SourceApp,
} from "./model";
import { deleteImage, imagePaths, readImagePng, readSnapshot, saveImage, sha1, writeEntry } from "./pasteboard";
import { createWriter, loadHistory, type HistoryWriter } from "./persist";

const ID = "clipboard";
const POLL_MS = 400;
/** With an image on the clipboard and an unchanged signature, re-hash it only every N polls. */
const IMAGE_RECHECK_EVERY = 5;
const MAX_TEXT = 5 * 1024 * 1024;
const FILTERS: ClipFilter[] = ["all", "text", "image", "link", "color", "file"];

let ctx: FeatureContext | null = null;
let settings: ClipSettings = DEFAULT_CLIP_SETTINGS;
let entries: ClipEntry[] = [];
let writer: HistoryWriter | null = null;
let timer: NodeJS.Timeout | null = null;
let polling = false;
let tick = 0;
let lastSig: string | null = null;
let lastImageHash: string | null = null;
/** Content we just wrote ourselves; the poller must not re-capture it. */
let suppress: { key: string; until: number } | null = null;
let hotkeyOk = true;
const lowerCache = new Map<string, string>();

const dataDir = () => ctx!.dataDir();
const hay = (e: ClipEntry) => {
  let h = lowerCache.get(e.id);
  if (h === undefined) {
    h = haystack(e);
    lowerCache.set(e.id, h);
  }
  return h;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textKey = (text: string) => `t:${sha1(text)}`;

function save(changed = true) {
  writer?.schedule(() => entries);
  if (changed) ctx?.emit("changed");
}

function applyRetention(now = Date.now()) {
  const { kept, removed } = prune(entries, settings, now);
  if (!removed.length) return;
  entries = kept;
  forget(removed);
}

/** Drop caches and image files of removed entries (images may be shared by key, so check). */
function forget(removed: ClipEntry[]) {
  for (const e of removed) {
    lowerCache.delete(e.id);
    if (e.image && !entries.some((x) => x.image?.sha1 === e.image!.sha1)) deleteImage(dataDir(), e.image.sha1);
  }
}

async function frontmostApp(): Promise<SourceApp | null> {
  if (!ctx?.helper.available()) return null;
  try {
    const app = await Promise.race([ctx.helper.call("app.frontmost"), sleep(300).then(() => null)]);
    return app ? { name: app.name, bundleId: app.bundleId } : null;
  } catch {
    return null;
  }
}

async function poll() {
  if (polling || !ctx) return;
  polling = true;
  tick++;
  try {
    const snap = await readSnapshot();
    const changed = snap.sig !== lastSig;
    if (!changed && (!snap.imageType || tick % IMAGE_RECHECK_EVERY !== 0)) return;
    lastSig = snap.sig;
    // Content copied while paused/disabled is skipped for good (lastSig already advanced).
    if (!settings.enabled || settings.paused) return;
    if (isConcealed(snap.types)) return;

    let cand: Omit<ClipCandidate, "source"> | null = null;
    let png: Buffer | null = null;
    const files = snap.uriList ? filePathsFromUriList(snap.uriList) : [];
    if (files.length) {
      cand = { type: "file", key: `f:${files.join("\n")}`, files };
    } else if (snap.text && snap.text.trim() && snap.text.length <= MAX_TEXT) {
      cand = { type: classifyText(snap.text), key: textKey(snap.text), text: snap.text };
    } else if (snap.imageType) {
      png = await readImagePng(snap);
      if (!png) return;
      const hash = sha1(png);
      const sameImage = hash === lastImageHash;
      lastImageHash = hash;
      if (sameImage && !changed) return;
      cand = { type: "image", key: `i:${hash}` };
    }
    if (!cand) return;
    if (suppress && suppress.key === cand.key && Date.now() < suppress.until) return;

    const source = await frontmostApp();
    if (isIgnoredApp(source?.bundleId, settings.ignoredApps)) return;

    if (png) {
      const image = saveImage(dataDir(), png, cand.key.slice(2));
      if (!image) return;
      cand.image = image;
    }
    const r = upsert(entries, { ...cand, source }, Date.now(), () => crypto.randomUUID());
    entries = r.entries;
    applyRetention();
    save();
  } catch (err) {
    ctx?.log("poll failed:", err);
  } finally {
    polling = false;
  }
}

function startPolling() {
  if (timer) return;
  timer = setInterval(() => void poll(), POLL_MS);
  void poll();
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

function registerHotkey() {
  if (!ctx) return;
  hotkeyOk = ctx.registerHotkey("open", settings.hotkey || null, () => ctx?.openView({ id: "clipboard.history" }));
}

function applySettings(next: ClipSettings) {
  const hotkeyChanged = next.hotkey !== settings.hotkey;
  settings = next;
  if (hotkeyChanged) registerHotkey();
  if (settings.enabled) startPolling();
  else stopPolling();
  applyRetention();
  save();
  ctx?.refreshCatalogue();
}

const find = (id: unknown) => (typeof id === "string" ? entries.find((e) => e.id === id) : undefined);

/** Write an entry to the clipboard without the poller re-capturing it, and move it to the top. */
async function putOnClipboard(e: ClipEntry, plain: boolean): Promise<string | null> {
  await writeEntry(e, dataDir(), plain);
  const asText = e.type === "file" ? (plain ? e.files!.join("\n") : null) : e.type === "image" ? null : (e.text ?? "");
  suppress = { key: asText !== null && e.type === "file" ? textKey(asText) : e.key, until: Date.now() + 3000 };
  try {
    lastSig = (await readSnapshot()).sig;
  } catch {
    /* next poll will compare against the old signature; suppress covers it */
  }
  if (e.image) lastImageHash = e.image.sha1;
  entries = touch(entries, e.id, Date.now());
  save();
  return asText;
}

async function pasteEntry(e: ClipEntry, plain: boolean): Promise<ExecuteResult> {
  const text = await putOnClipboard(e, plain);
  ctx?.hideLauncher();
  await sleep(150);
  try {
    if (text !== null && ctx?.helper.available()) {
      const r = await ctx.helper.call("keys.paste", { text }).catch(() => ({ ok: false }));
      if (!r.ok) await pasteFromClipboard();
    } else {
      await pasteFromClipboard();
    }
    return { ok: true, hide: true, message: "Pasted" };
  } catch (err) {
    return { ok: true, hide: true, message: `Copied to clipboard — ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function copyEntry(e: ClipEntry): Promise<ExecuteResult> {
  await putOnClipboard(e, false);
  return { ok: true, hide: true, message: "Copied to clipboard" };
}

function setPaused(paused: boolean): ExecuteResult {
  applySettings(normalizeSettings({ ...settings, paused }));
  ctx?.setSettings({ paused });
  return { ok: true, hide: true, message: paused ? "Clipboard history paused" : "Clipboard history resumed" };
}

function clearHistory(keepPinned: boolean): number {
  const removed = entries.filter((e) => !keepPinned || !e.pinned);
  entries = keepPinned ? entries.filter((e) => e.pinned) : [];
  forget(removed);
  save();
  return removed.length;
}

function entryItem(e: ClipEntry): SearchItem {
  const icon: SearchItem["icon"] =
    e.type === "color" ? { kind: "color", value: e.text!.trim() } : { kind: "symbol", value: e.type === "link" ? "link" : "clipboard" };
  return {
    id: `clipboard.entry.${e.id}`,
    kind: "command",
    kindLabel: "Clipboard",
    title: entryTitle(e),
    subtitle: e.source?.name ? `Copied from ${e.source.name}` : "Clipboard History",
    icon,
    feature: ID,
    data: { entryId: e.id, noUsage: true },
  };
}

const A = (id: string, title: string, shortcut?: string, destructive?: boolean): ItemAction => ({ id, title, shortcut, destructive });

export const feature: FeatureModule = {
  id: ID,

  start(c) {
    ctx = c;
    settings = normalizeSettings(c.settings(DEFAULT_CLIP_SETTINGS));
    const file = path.join(c.dataDir(), "history.json");
    writer = createWriter(file);
    entries = loadHistory(file).sort((a, b) => b.lastCopiedAt - a.lastCopiedAt);
    applyRetention();
    registerHotkey();
    if (settings.enabled) startPolling();
  },

  stop() {
    stopPolling();
    writer?.flush();
    ctx?.registerHotkey("open", null, () => undefined);
  },

  items() {
    const hotkey = settings.hotkey ? accelToDisplay(settings.hotkey) : undefined;
    const base = { kind: "command" as const, kindLabel: "Clipboard", feature: ID };
    return [
      { ...base, id: "clipboard.history", title: "Clipboard History", subtitle: "Search and paste what you copied", icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "history", "paste", "copy"], hotkey },
      { ...base, id: "clipboard.clear", title: "Clear Clipboard History", icon: { kind: "symbol", value: "trash" }, keywords: ["clipboard", "delete", "erase"] },
      settings.paused
        ? { ...base, id: "clipboard.toggle-pause", title: "Resume Clipboard History", icon: { kind: "symbol", value: "play" }, keywords: ["clipboard", "unpause"] }
        : { ...base, id: "clipboard.toggle-pause", title: "Pause Clipboard History", icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "stop", "private"] },
    ];
  },

  dynamicItems(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 3 || !settings.enabled) return [];
    const out: ScoredItem[] = [];
    for (const e of entries) {
      if (e.type === "image" || e.type === "file") continue;
      if (!(e.text ?? "").toLowerCase().includes(q)) continue;
      out.push({ item: entryItem(e), score: 20 - out.length * 0.1, matchScore: 20, matchKind: "fuzzy", frecency: 0, ranges: [] });
      if (out.length >= 3) break;
    }
    return out;
  },

  actions(item) {
    if (item.id === "clipboard.history") return [A("open", "Open Clipboard History")];
    if (item.id === "clipboard.clear") return [A("clear", "Clear Clipboard History…", undefined, true)];
    if (item.id === "clipboard.toggle-pause") return [A("toggle", settings.paused ? "Resume" : "Pause")];
    if (item.data?.entryId) return [A("paste", "Paste", "⏎"), A("copy", "Copy to Clipboard", "⌘⏎"), A("plain", "Paste as Plain Text", "⇧⌘⏎"), A("open", "Show in Clipboard History")];
    return [];
  },

  async runAction(scored, actionId) {
    const item = scored.item;
    if (item.id === "clipboard.history") return { ok: true, view: { id: "clipboard.history" } };
    if (item.id === "clipboard.clear") return { ok: true, view: { id: "clipboard.history", props: { confirmClear: true } } };
    if (item.id === "clipboard.toggle-pause") return setPaused(!settings.paused);
    const e = find(item.data?.entryId);
    if (!e) return { ok: false, error: "That clipboard entry no longer exists" };
    if (actionId === "copy") return copyEntry(e);
    if (actionId === "plain") return pasteEntry(e, true);
    if (actionId === "open") return { ok: true, view: { id: "clipboard.history", props: { selectId: e.id } } };
    return pasteEntry(e, false);
  },

  methods: {
    list(opts: unknown) {
      const o = (opts ?? {}) as { query?: unknown; type?: unknown; limit?: unknown };
      const type = FILTERS.includes(o.type as ClipFilter) ? (o.type as ClipFilter) : "all";
      const limit = typeof o.limit === "number" ? o.limit : 0;
      return filterEntries(entries, typeof o.query === "string" ? o.query : "", type, limit, hay).map(summarize);
    },
    get(id: unknown) {
      return find(id) ?? null;
    },
    async paste(id: unknown, opts: unknown) {
      const e = find(id);
      if (!e) return { ok: false, error: "Entry not found" };
      return pasteEntry(e, !!(opts as { plain?: boolean } | undefined)?.plain);
    },
    async copy(id: unknown) {
      const e = find(id);
      return e ? copyEntry(e) : { ok: false, error: "Entry not found" };
    },
    pin(id: unknown) {
      const e = find(id);
      if (!e) return false;
      entries = entries.map((x) => (x === e ? { ...x, pinned: !x.pinned } : x));
      save();
      return !e.pinned;
    },
    delete(id: unknown) {
      const e = find(id);
      if (!e) return false;
      entries = entries.filter((x) => x !== e);
      forget([e]);
      save();
      return true;
    },
    clear(opts: unknown) {
      return clearHistory((opts as { keepPinned?: boolean } | undefined)?.keepPinned !== false);
    },
    getSettings() {
      return { settings, hotkeyOk };
    },
    setSettings(patch: unknown) {
      const p = (patch && typeof patch === "object" ? patch : {}) as Partial<ClipSettings>;
      const next = normalizeSettings({ ...settings, ...p });
      ctx?.setSettings(next);
      applySettings(next);
      return { settings, hotkeyOk };
    },
    stats() {
      return computeStats(entries, settings);
    },
    imageDataUrl(id: unknown, opts: unknown) {
      const e = find(id);
      if (!e?.image) return null;
      const p = imagePaths(dataDir(), e.image.sha1);
      const file = (opts as { full?: boolean } | undefined)?.full ? p.full : p.thumb;
      try {
        return `data:image/png;base64,${fs.readFileSync(fs.existsSync(file) ? file : p.full).toString("base64")}`;
      } catch {
        return null;
      }
    },
  },
};
