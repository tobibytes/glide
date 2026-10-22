/**
 * Clipboard History: polls the pasteboard, keeps a local, deduplicated history
 * (<dataDir>/history.json + images/), and pastes entries back. Also owns the Paste Stack
 * (<dataDir>/stack.json) and optional OCR of copied images (text stays local, used for search).
 * Nothing is ever sent off the machine.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clipboard, ClipboardItem, shell } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { HEADLESS } from "../../headless";
import { accelToDisplay } from "../../util/accel";
import { pasteFromClipboard } from "../../workflows/runtime";
import type { FeatureContext, FeatureModule } from "../types";
import {
  CLIP_FILTERS,
  classifyText,
  computeStats,
  DEFAULT_CLIP_SETTINGS,
  entryText,
  entryTitle,
  filePathsFromUriList,
  filterEntries,
  haystack,
  isConcealed,
  isIgnoredApp,
  isPaused,
  linkHref,
  markdownLink,
  mergeTexts,
  normalizeSettings,
  prune,
  sourceApps,
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
import { createWriter, loadHistory, writeAtomic, type HistoryWriter } from "./persist";
import { addToStack, clearStack, EMPTY_STACK, interceptsPaste, moveInStack, normalizeStack, pushStack, removeFromStack, restoreHead, setStackOrder, startStack, stopStack, takeNext, type PasteStack } from "./stack";
import { attachStackPaste, stackReplyParams, type StackNext } from "./stackNative";
import { setPasteStackIntercept } from "../keyboard/pasteStack";

const ID = "clipboard";
const POLL_MS = 400;
/** With an image on the clipboard and an unchanged signature, re-hash it only every N polls. */
const IMAGE_RECHECK_EVERY = 5;
const MAX_TEXT = 5 * 1024 * 1024;
const OCR_TIMEOUT_MS = 30_000;

let ctx: FeatureContext | null = null;
let settings: ClipSettings = DEFAULT_CLIP_SETTINGS;
let entries: ClipEntry[] = [];
let stack: PasteStack = EMPTY_STACK;
let writer: HistoryWriter | null = null;
let timer: NodeJS.Timeout | null = null;
let pauseTimer: NodeJS.Timeout | null = null;
let polling = false;
let tick = 0;
let lastSig: string | null = null;
let lastImageHash: string | null = null;
/** Content we just wrote ourselves; the poller must not re-capture it. */
let suppress: { key: string; until: number } | null = null;
let hotkeyOk = true;
let stackHotkeyOk = true;
/** Headless tests only: source app reported for the next capture (the real frontmost app is the test runner). */
let debugSource: SourceApp | null = null;
const lowerCache = new Map<string, string>();
const ocrQueue: string[] = [];
const ocrTried = new Set<string>();
let ocrBusy = false;

const dataDir = () => ctx!.dataDir();
const stackFile = () => path.join(dataDir(), "stack.json");
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
const headlessLog = (kind: string, detail: unknown) => console.log(`[headless] ${kind} ${JSON.stringify(detail)}`);

function save(changed = true) {
  writer?.schedule(() => entries);
  if (changed) ctx?.emit("changed");
}

function saveStack() {
  try {
    writeAtomic(stackFile(), JSON.stringify(stack));
  } catch (err) {
    ctx?.log("could not save paste stack:", err);
  }
  ctx?.emit("stack", stackState());
  ctx?.refreshCatalogue();
  setPasteStackIntercept(interceptsPaste(stack));
}

function applyRetention(now = Date.now()) {
  const { kept, removed } = prune(entries, settings, now);
  if (!removed.length) return;
  entries = kept;
  forget(removed);
}

/** Drop caches, stack references and image files of removed entries (images may be shared by key, so check). */
function forget(removed: ClipEntry[]) {
  let stackChanged = false;
  for (const e of removed) {
    lowerCache.delete(e.id);
    if (stack.items.includes(e.id)) {
      stack = removeFromStack(stack, e.id);
      stackChanged = true;
    }
    if (e.image && !entries.some((x) => x.image?.sha1 === e.image!.sha1)) deleteImage(dataDir(), e.image.sha1);
  }
  if (stackChanged) saveStack();
}

async function frontmostApp(): Promise<SourceApp | null> {
  if (HEADLESS && debugSource) {
    const s = debugSource;
    debugSource = null;
    return s;
  }
  if (!ctx?.helper.available()) return null;
  try {
    const app = await Promise.race([ctx.helper.call("app.frontmost"), sleep(300).then(() => null)]);
    return app ? { name: app.name, bundleId: app.bundleId } : null;
  } catch {
    return null;
  }
}

// --- OCR enrichment (optional; silently skipped without the helper) --------------------------

function queueOcr(id: string) {
  if (!settings.ocrImages || ocrTried.has(id) || ocrQueue.includes(id)) return;
  ocrQueue.push(id);
  void drainOcr();
}

async function drainOcr() {
  if (ocrBusy || !ctx) return;
  ocrBusy = true;
  try {
    while (ocrQueue.length) {
      const id = ocrQueue.shift()!;
      ocrTried.add(id);
      const e = entries.find((x) => x.id === id);
      if (!e?.image || e.ocrText !== undefined || !settings.ocrImages || !ctx.helper.available()) continue;
      const file = imagePaths(dataDir(), e.image.sha1).full;
      try {
        const r = await Promise.race([ctx.helper.call("ocr.recognize", { path: file }), sleep(OCR_TIMEOUT_MS).then(() => null)]);
        if (!r) continue;
        const text = r.lines.map((l) => l.text).join("\n").trim();
        entries = entries.map((x) => (x.id === id ? { ...x, ocrText: text } : x));
        lowerCache.delete(id);
        save();
      } catch {
        /* helper missing/refused: OCR is only an enrichment */
      }
    }
  } finally {
    ocrBusy = false;
  }
}

// --- Polling -------------------------------------------------------------------------------

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
    if (!settings.enabled || isPaused(settings, Date.now())) return;
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
    if (stack.collecting) {
      stack = pushStack(stack, r.entry.id);
      saveStack();
      if (!stack.collecting) notify(`Paste Stack ready: ${stack.items.length} ${stack.items.length === 1 ? "item" : "items"}`);
    }
    if (r.entry.type === "image") queueOcr(r.entry.id);
  } catch (err) {
    ctx?.log("poll failed:", err);
  } finally {
    polling = false;
  }
}

function notify(message: string) {
  ctx?.emit("toast", { message });
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

function registerHotkeys() {
  if (!ctx) return;
  hotkeyOk = ctx.registerHotkey("open", settings.hotkey || null, () => ctx?.openView({ id: "clipboard.history" }));
  stackHotkeyOk = ctx.registerHotkey("stack-next", settings.stackHotkey || null, () => void pasteNextFromStack());
}

/** Re-arm the timer that ends a timed pause. */
function schedulePauseEnd() {
  if (pauseTimer) clearTimeout(pauseTimer);
  pauseTimer = null;
  const left = settings.pausedUntil - Date.now();
  if (settings.pausedUntil <= 0) return;
  if (left <= 0) {
    settings = { ...settings, pausedUntil: 0 };
    ctx?.setSettings({ pausedUntil: 0 });
    return;
  }
  pauseTimer = setTimeout(() => {
    pauseTimer = null;
    settings = { ...settings, pausedUntil: 0 };
    ctx?.setSettings({ pausedUntil: 0 });
    ctx?.emit("changed");
    ctx?.refreshCatalogue();
  }, Math.min(left, 2 ** 31 - 1));
}

function applySettings(next: ClipSettings) {
  const hotkeysChanged = next.hotkey !== settings.hotkey || next.stackHotkey !== settings.stackHotkey;
  const orderChanged = next.stackOrder !== stack.order;
  settings = next;
  if (hotkeysChanged) registerHotkeys();
  if (orderChanged) {
    stack = setStackOrder(stack, settings.stackOrder);
    saveStack();
  }
  schedulePauseEnd();
  if (settings.enabled) startPolling();
  else stopPolling();
  applyRetention();
  save();
  ctx?.refreshCatalogue();
}

function patchSettings(p: Partial<ClipSettings>) {
  const next = normalizeSettings({ ...settings, ...p });
  ctx?.setSettings(next);
  applySettings(next);
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

/** Put arbitrary text on the clipboard (not recorded again by the poller). */
async function putText(text: string) {
  await clipboard.writeText(text);
  suppress = { key: textKey(text), until: Date.now() + 3000 };
  try {
    lastSig = (await readSnapshot()).sig;
  } catch {
    /* see putOnClipboard */
  }
}

/** ⌘V into the frontmost app. In headless mode this is only logged (never posts keystrokes). */
async function sendPaste(text: string | null): Promise<void> {
  if (HEADLESS) {
    headlessLog("clipboard.paste", { text: text === null ? null : text.slice(0, 200) });
    return;
  }
  if (text !== null && ctx?.helper.available()) {
    const r = await ctx.helper.call("keys.paste", { text }).catch(() => ({ ok: false }));
    if (r.ok) return;
  }
  await pasteFromClipboard();
}

async function pasteEntry(e: ClipEntry, plain: boolean, keepOpen = false): Promise<ExecuteResult> {
  const text = await putOnClipboard(e, plain);
  ctx?.hideLauncher();
  await sleep(150);
  try {
    await sendPaste(text);
    if (keepOpen) {
      await sleep(250);
      ctx?.showLauncher();
    }
    return { ok: true, hide: !keepOpen, message: "Pasted" };
  } catch (err) {
    return { ok: true, hide: true, message: `Copied to clipboard — ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function copyEntry(e: ClipEntry): Promise<ExecuteResult> {
  await putOnClipboard(e, false);
  return { ok: true, hide: true, message: "Copied to clipboard" };
}

/** Add text produced inside Glide (edited / merged entry) to the history and return the entry. */
function recordText(text: string): ClipEntry {
  const r = upsert(entries, { type: classifyText(text), key: textKey(text), text, source: { name: "Glide", bundleId: null } }, Date.now(), () => crypto.randomUUID());
  entries = r.entries;
  lowerCache.delete(r.entry.id);
  applyRetention();
  save();
  return r.entry;
}

function setPaused(paused: boolean): ExecuteResult {
  patchSettings({ paused, pausedUntil: 0 });
  return { ok: true, hide: true, message: paused ? "Clipboard history paused" : "Clipboard history resumed" };
}

function pauseFor(minutes: number): ExecuteResult {
  const until = Date.now() + Math.max(1, minutes) * 60_000;
  patchSettings({ paused: false, pausedUntil: until });
  return { ok: true, hide: true, message: `Clipboard history paused for ${minutes} minutes` };
}

function clearHistory(keepPinned: boolean): number {
  const removed = entries.filter((e) => !keepPinned || !e.pinned);
  entries = keepPinned ? entries.filter((e) => e.pinned) : [];
  forget(removed);
  save();
  return removed.length;
}

// --- Paste Stack ----------------------------------------------------------------------------

function stackState() {
  return {
    collecting: stack.collecting,
    limit: stack.limit,
    collected: stack.collected,
    order: stack.order,
    items: stack.items.map(find).filter((e): e is ClipEntry => !!e).map(summarize),
  };
}

async function pasteNextFromStack(): Promise<ExecuteResult> {
  const r = takeNext(stack, (id) => !!find(id));
  stack = r.stack;
  if (!r.id) {
    saveStack();
    return { ok: false, error: stack.collecting ? "Paste Stack is empty — copy something first" : "Paste Stack is empty" };
  }
  const e = find(r.id)!;
  saveStack();
  const res = await pasteEntry(e, false);
  const left = stack.items.length;
  return { ...res, message: left ? `Pasted — ${left} left in Paste Stack` : "Pasted the last Paste Stack item" };
}

/** ⌘V with a non-empty stack (keyboard tap → stack.next): take the next item for the helper to paste. */
async function nextForNativePaste(): Promise<StackNext> {
  const r = takeNext(stack, (id) => !!find(id));
  stack = r.stack;
  const e = r.id ? find(r.id) : undefined;
  if (!e) {
    saveStack();
    return { reply: { empty: true }, active: false };
  }
  saveStack();
  const undo = () => {
    stack = restoreHead(stack, e.id);
    saveStack();
  };
  const active = interceptsPaste(stack);
  if (e.type === "image" || e.type === "file") {
    // The helper only pastes text: put the entry on the clipboard and let the original ⌘V through.
    await putOnClipboard(e, false);
    return { reply: { passthrough: true }, active, undo };
  }
  entries = touch(entries, e.id, Date.now());
  save();
  return { reply: { text: e.text ?? "" }, active, undo };
}

let offStackPaste: (() => void) | null = null;

function startPasteStack(limit: number): ExecuteResult {
  stack = startStack(settings.stackOrder, limit);
  saveStack();
  return { ok: true, hide: true, message: limit > 0 ? `Paste Stack: copy ${limit} items` : "Paste Stack started — copy items, then Paste Next from Stack" };
}

// --- Catalogue ------------------------------------------------------------------------------

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

function mergeEntries(ids: string[], separator: string): ClipEntry | null {
  const picked = ids.map(find).filter((e): e is ClipEntry => !!e);
  // Copy order (oldest first) reads naturally whatever order the rows were marked in.
  picked.sort((a, b) => a.lastCopiedAt - b.lastCopiedAt);
  const text = mergeTexts(picked, separator);
  return text === null ? null : recordText(text);
}

export const feature: FeatureModule = {
  id: ID,

  start(c) {
    ctx = c;
    settings = normalizeSettings(c.settings(DEFAULT_CLIP_SETTINGS));
    const file = path.join(c.dataDir(), "history.json");
    writer = createWriter(file);
    entries = loadHistory(file).sort((a, b) => b.lastCopiedAt - a.lastCopiedAt);
    try {
      stack = normalizeStack(JSON.parse(fs.readFileSync(stackFile(), "utf8")));
    } catch {
      stack = { ...EMPTY_STACK, order: settings.stackOrder };
    }
    applyRetention();
    registerHotkeys();
    schedulePauseEnd();
    setPasteStackIntercept(interceptsPaste(stack));
    offStackPaste = attachStackPaste(c.helper, nextForNativePaste, (...a) => c.log(...a));
    if (settings.enabled) startPolling();
    // Backfill OCR for images captured before OCR existed (or while the helper was missing).
    setTimeout(() => {
      for (const e of entries.filter((x) => x.type === "image" && x.ocrText === undefined).slice(0, 50)) queueOcr(e.id);
    }, 5000).unref?.();
  },

  stop() {
    stopPolling();
    if (pauseTimer) clearTimeout(pauseTimer);
    writer?.flush();
    ctx?.registerHotkey("open", null, () => undefined);
    ctx?.registerHotkey("stack-next", null, () => undefined);
    offStackPaste?.();
    offStackPaste = null;
    setPasteStackIntercept(false);
  },

  items() {
    const hotkey = settings.hotkey ? accelToDisplay(settings.hotkey) : undefined;
    const stackHotkey = settings.stackHotkey ? accelToDisplay(settings.stackHotkey) : undefined;
    const base = { kind: "command" as const, kindLabel: "Clipboard", feature: ID };
    const paused = isPaused(settings, Date.now());
    const n = stack.items.length;
    const items: SearchItem[] = [
      { ...base, id: "clipboard.history", title: "Clipboard History", subtitle: "Search and paste what you copied", icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "history", "paste", "copy"], hotkey },
      { ...base, id: "clipboard.clear", title: "Clear Clipboard History", icon: { kind: "symbol", value: "trash" }, keywords: ["clipboard", "delete", "erase"] },
      paused
        ? { ...base, id: "clipboard.toggle-pause", title: "Resume Clipboard History", icon: { kind: "symbol", value: "play" }, keywords: ["clipboard", "unpause"] }
        : { ...base, id: "clipboard.toggle-pause", title: "Pause Clipboard History", icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "stop", "private"] },
      { ...base, id: "clipboard.paste-stack", title: "Paste Stack", subtitle: n ? `${n} waiting${stack.collecting ? " · collecting" : ""}` : stack.collecting ? "Collecting copies" : "Collect copies, paste them in order", icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "stack", "queue", "multi"] },
      stack.collecting
        ? { ...base, id: "clipboard.stack-toggle", title: "Stop Paste Stack", subtitle: `${n} collected`, icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "stack"] }
        : { ...base, id: "clipboard.stack-toggle", title: "Start Paste Stack", subtitle: "Collect the next copies (type a number for N)", icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "stack", "collect"], acceptsArgument: true },
      { ...base, id: "clipboard.stack-next", title: "Paste Next from Stack", subtitle: n ? `${n} left` : "Paste Stack is empty", icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "stack", "paste"], hotkey: stackHotkey },
    ];
    if (!paused) items.push({ ...base, id: "clipboard.pause-5", title: "Pause Clipboard History for 5 Minutes", icon: { kind: "symbol", value: "clipboard" }, keywords: ["clipboard", "private", "incognito", "temporarily"] });
    return items;
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
    switch (item.id) {
      case "clipboard.history":
        return [A("open", "Open Clipboard History")];
      case "clipboard.clear":
        return [A("clear", "Clear Clipboard History…", undefined, true)];
      case "clipboard.toggle-pause":
        return [A("toggle", isPaused(settings, Date.now()) ? "Resume" : "Pause"), A("pause-5", "Pause for 5 Minutes")];
      case "clipboard.pause-5":
        return [A("pause-5", "Pause for 5 Minutes")];
      case "clipboard.paste-stack":
        return [A("open", "Open Paste Stack")];
      case "clipboard.stack-toggle":
        return [A("toggle", stack.collecting ? "Stop Paste Stack" : "Start Paste Stack"), A("open", "Open Paste Stack", "⌘⏎")];
      case "clipboard.stack-next":
        return [A("paste", "Paste Next from Stack"), A("open", "Open Paste Stack", "⌘⏎")];
    }
    if (item.data?.entryId) return [A("paste", "Paste", "⏎"), A("copy", "Copy to Clipboard", "⌘⏎"), A("plain", "Paste as Plain Text", "⇧⌘⏎"), A("open", "Show in Clipboard History")];
    return [];
  },

  async runAction(scored, actionId) {
    const item = scored.item;
    switch (item.id) {
      case "clipboard.history":
        return { ok: true, view: { id: "clipboard.history" } };
      case "clipboard.clear":
        return { ok: true, view: { id: "clipboard.history", props: { confirmClear: true } } };
      case "clipboard.toggle-pause":
        return actionId === "pause-5" ? pauseFor(5) : setPaused(!isPaused(settings, Date.now()));
      case "clipboard.pause-5":
        return pauseFor(5);
      case "clipboard.paste-stack":
        return { ok: true, view: { id: "clipboard.stack" } };
      case "clipboard.stack-toggle":
        if (actionId === "open") return { ok: true, view: { id: "clipboard.stack" } };
        if (stack.collecting) {
          stack = stopStack(stack);
          saveStack();
          return { ok: true, view: { id: "clipboard.stack" } };
        }
        return startPasteStack(Number.parseInt(scored.argument ?? "", 10) || 0);
      case "clipboard.stack-next":
        return actionId === "open" ? { ok: true, view: { id: "clipboard.stack" } } : pasteNextFromStack();
    }
    const e = find(item.data?.entryId);
    if (!e) return { ok: false, error: "That clipboard entry no longer exists" };
    if (actionId === "copy") return copyEntry(e);
    if (actionId === "plain") return pasteEntry(e, true);
    if (actionId === "open") return { ok: true, view: { id: "clipboard.history", props: { selectId: e.id } } };
    return pasteEntry(e, false);
  },

  methods: {
    list(opts: unknown) {
      const o = (opts ?? {}) as { query?: unknown; type?: unknown; limit?: unknown; source?: unknown };
      const type = CLIP_FILTERS.includes(o.type as ClipFilter) ? (o.type as ClipFilter) : "all";
      const limit = typeof o.limit === "number" ? o.limit : 0;
      const source = typeof o.source === "string" && o.source ? o.source : null;
      return filterEntries(entries, typeof o.query === "string" ? o.query : "", type, limit, hay, source).map(summarize);
    },
    sources() {
      return sourceApps(entries);
    },
    get(id: unknown) {
      return find(id) ?? null;
    },
    async paste(id: unknown, opts: unknown) {
      const e = find(id);
      if (!e) return { ok: false, error: "Entry not found" };
      const o = (opts ?? {}) as { plain?: boolean; keepOpen?: boolean };
      return pasteEntry(e, !!o.plain, !!o.keepOpen);
    },
    /** Paste text edited in Glide; it is added to the history first. */
    async pasteText(text: unknown, opts: unknown) {
      if (typeof text !== "string" || !text) return { ok: false, error: "Nothing to paste" };
      return pasteEntry(recordText(text), false, !!(opts as { keepOpen?: boolean } | undefined)?.keepOpen);
    },
    async copy(id: unknown) {
      const e = find(id);
      return e ? copyEntry(e) : { ok: false, error: "Entry not found" };
    },
    async copyMarkdownLink(id: unknown) {
      const e = find(id);
      if (e?.type !== "link" || !e.text) return { ok: false, error: "Not a link" };
      const md = markdownLink(e.text);
      await putText(md);
      return { ok: true, hide: false, message: "Copied Markdown link", text: md };
    },
    /** Replace a text entry's content (Edit). A clash with another entry's content merges into this one. */
    update(id: unknown, text: unknown) {
      const e = find(id);
      if (!e || typeof text !== "string" || !text || e.type === "image" || e.type === "file") return null;
      const key = textKey(text);
      const clash = entries.find((x) => x.key === key && x.id !== e.id);
      const next: ClipEntry = { ...e, text, key, type: classifyText(text), pinned: e.pinned || !!clash?.pinned, count: e.count + (clash?.count ?? 0) };
      entries = entries.filter((x) => x !== clash).map((x) => (x === e ? next : x));
      if (clash) forget([clash]);
      lowerCache.delete(e.id);
      save();
      return summarize(next);
    },
    async merge(ids: unknown, opts: unknown) {
      const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
      if (list.length < 2) return { ok: false, error: "Select at least two entries to merge" };
      const o = (opts ?? {}) as { separator?: unknown; paste?: boolean };
      const merged = mergeEntries(list, typeof o.separator === "string" ? o.separator : "\n");
      if (!merged) return { ok: false, error: "Nothing to merge (images cannot be merged)" };
      if (o.paste) return pasteEntry(merged, false);
      await putOnClipboard(merged, false);
      return { ok: true, hide: false, message: `Merged ${list.length} entries and copied`, id: merged.id };
    },
    saveSnippet(id: unknown, name: unknown) {
      const e = find(id);
      const text = e ? entryText(e) : null;
      if (!e || !text || !ctx) return { ok: false, error: "Only text entries can be saved as snippets" };
      const title = typeof name === "string" && name.trim() ? name.trim() : entryTitle(e).slice(0, 60);
      ctx.store.saveSnippet({ id: crypto.randomUUID(), name: title, text });
      ctx.refreshCatalogue();
      return { ok: true, message: `Saved snippet “${title}”` };
    },
    async openLink(id: unknown) {
      const e = find(id);
      if (e?.type !== "link" || !e.text) return { ok: false, error: "Not a link" };
      await shell.openExternal(linkHref(e.text));
      return { ok: true, hide: true };
    },
    reveal(id: unknown) {
      const e = find(id);
      const f = e?.files?.[0];
      if (!f) return { ok: false, error: "Not a file" };
      shell.showItemInFolder(f);
      return { ok: true, hide: true };
    },
    ignoreApp(id: unknown) {
      const e = find(id);
      const b = e?.source?.bundleId;
      if (!b) return { ok: false, error: "The source app of this entry is unknown" };
      if (!settings.ignoredApps.includes(b)) patchSettings({ ignoredApps: [...settings.ignoredApps, b] });
      return { ok: true, message: `Ignoring copies from ${e.source!.name}` };
    },
    pin(id: unknown) {
      const e = find(id);
      if (!e) return false;
      entries = entries.map((x) => (x === e ? { ...x, pinned: !x.pinned } : x));
      save();
      return !e.pinned;
    },
    delete(id: unknown) {
      const ids = Array.isArray(id) ? id : [id];
      const removed = ids.map(find).filter((e): e is ClipEntry => !!e);
      if (!removed.length) return false;
      entries = entries.filter((x) => !removed.includes(x));
      forget(removed);
      save();
      return true;
    },
    clear(opts: unknown) {
      return clearHistory((opts as { keepPinned?: boolean } | undefined)?.keepPinned !== false);
    },
    pauseFor(minutes: unknown) {
      return pauseFor(typeof minutes === "number" && minutes > 0 ? minutes : 5);
    },
    resume() {
      return setPaused(false);
    },
    getSettings() {
      return { settings, hotkeyOk, stackHotkeyOk };
    },
    setSettings(patch: unknown) {
      patchSettings((patch && typeof patch === "object" ? patch : {}) as Partial<ClipSettings>);
      return { settings, hotkeyOk, stackHotkeyOk };
    },
    stats() {
      return computeStats(entries, settings);
    },
    imageDataUrl(id: unknown, opts: unknown) {
      const e = find(id);
      if (!e?.image) return null;
      const p = imagePaths(dataDir(), e.image.sha1);
      const full = (opts as { full?: boolean } | undefined)?.full;
      try {
        // Entries from before thumbnails existed get one on first view.
        if (!full && !fs.existsSync(p.thumb) && fs.existsSync(p.full)) saveImage(dataDir(), fs.readFileSync(p.full), e.image.sha1);
        const file = full ? p.full : p.thumb;
        return `data:image/png;base64,${fs.readFileSync(fs.existsSync(file) ? file : p.full).toString("base64")}`;
      } catch {
        return null;
      }
    },
    /** Thumbnails for many entries in one round trip (grid view). */
    thumbs(ids: unknown) {
      const out: Record<string, string> = {};
      if (!Array.isArray(ids)) return out;
      for (const id of ids.slice(0, 200)) {
        const url = feature.methods!.imageDataUrl!(id, {}) as string | null;
        if (url && typeof id === "string") out[id] = url;
      }
      return out;
    },

    // Paste Stack
    stackGet() {
      return stackState();
    },
    stackStart(limit: unknown) {
      return startPasteStack(typeof limit === "number" ? limit : 0);
    },
    stackStop() {
      stack = stopStack(stack);
      saveStack();
      return stackState();
    },
    stackAdd(ids: unknown) {
      for (const id of Array.isArray(ids) ? ids : [ids]) if (find(id)) stack = addToStack(stack, id as string);
      saveStack();
      return stackState();
    },
    stackRemove(id: unknown) {
      if (typeof id === "string") stack = removeFromStack(stack, id);
      saveStack();
      return stackState();
    },
    stackMove(id: unknown, dir: unknown) {
      if (typeof id === "string" && (dir === 1 || dir === -1)) stack = moveInStack(stack, id, dir);
      saveStack();
      return stackState();
    },
    stackClear() {
      stack = clearStack(stack);
      saveStack();
      return stackState();
    },
    stackPasteNext() {
      return pasteNextFromStack();
    },
    /** Headless tests only: what the ⌘V path would answer the helper (consumes the item like a real ⌘V). */
    async debugStackNext(reqId: unknown) {
      if (!HEADLESS) return { ok: false, error: "Only available with GLIDE_HEADLESS=1" };
      const next = await nextForNativePaste();
      return { ok: true, params: stackReplyParams(typeof reqId === "number" ? reqId : 0, next), stack: stackState() };
    },

    /** Headless tests only: put content on the (fake, in-memory) clipboard as if another app copied it. */
    async debugSetClipboard(payload: unknown) {
      if (!HEADLESS) return { ok: false, error: "Only available with GLIDE_HEADLESS=1" };
      const p = (payload ?? {}) as { text?: string; pngBase64?: string; files?: string[]; source?: SourceApp; extraTypes?: string[] };
      debugSource = p.source ?? null;
      const data: Record<string, string | Blob> = {};
      if (p.files?.length) data["text/uri-list"] = p.files.map((f) => `file://${f.split("/").map(encodeURIComponent).join("/")}`).join("\r\n");
      if (p.text !== undefined) data["text/plain"] = p.text;
      if (p.pngBase64) data["image/png"] = new Blob([new Uint8Array(Buffer.from(p.pngBase64, "base64"))], { type: "image/png" });
      for (const t of p.extraTypes ?? []) data[t] = "1";
      await clipboard.write([new ClipboardItem(data)]);
      return { ok: true };
    },
    /** Headless tests only: what is on the fake clipboard now. */
    async debugReadClipboard() {
      if (!HEADLESS) return null;
      const snap = await readSnapshot();
      return { types: snap.types, text: snap.text };
    },
  },
};
