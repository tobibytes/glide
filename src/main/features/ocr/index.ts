/**
 * Screen Text & QR: region capture (screencapture -i) or a clipboard image → Vision OCR / barcode detection in the
 * helper → text on the clipboard and an "ocr.result" / "ocr.codes" view. Temp images are deleted right after use.
 */
import { BrowserWindow, clipboard, shell, systemPreferences } from "electron";
import type { ExecuteResult, ItemAction, ViewRequest } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import { hud } from "../app/hud";
import type { FeatureContext, FeatureModule } from "../types";
import { captureRegion, clipboardImage, removeQuietly } from "./capture";
import { assembleText, classifyPayload, extractLinks, isOpenable, stats, type ClassifiedPayload } from "./text";

const SCREEN_RECORDING_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
export const DEFAULTS = { autoCopy: true, languageCorrection: true, fast: false, languages: [] as string[] };
export type OcrSettings = typeof DEFAULTS;

export interface TextResult {
  kind: "text";
  source: "screen" | "clipboard" | "file";
  text: string;
  lines: number;
  words: number;
  chars: number;
  links: string[];
  copied: boolean;
  /** Set when the capture probably came out blank because Screen Recording is not granted. */
  permissionHint: boolean;
}

export interface CodesResult {
  kind: "codes";
  source: "screen" | "clipboard" | "file";
  codes: Array<ClassifiedPayload & { payload: string; symbology: string }>;
}

let ctx: FeatureContext | null = null;
let busy = false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const settings = (): OcrSettings => {
  const s = ctx?.settings(DEFAULTS) ?? DEFAULTS;
  return {
    autoCopy: s.autoCopy !== false,
    languageCorrection: s.languageCorrection !== false,
    fast: s.fast === true,
    languages: Array.isArray(s.languages) ? s.languages.filter((l): l is string => typeof l === "string" && !!l) : [],
  };
};

type ScreenAccess = "granted" | "denied" | "not-determined" | "restricted" | "unknown";
const screenAccess = (): ScreenAccess => {
  try {
    return systemPreferences.getMediaAccessStatus("screen") as ScreenAccess;
  } catch {
    return "unknown";
  }
};

const helperMissing = "Text recognition needs the Glide helper, which is not running.";

export async function recognizeFile(file: string, source: TextResult["source"]): Promise<TextResult> {
  const c = ctx;
  if (!c?.helper.available()) throw new Error(helperMissing);
  const s = settings();
  const r = await c.helper.call("ocr.recognize", { path: file, languages: s.languages, fast: s.fast, languageCorrection: s.languageCorrection });
  const text = assembleText(r.lines);
  let copied = false;
  if (text && s.autoCopy) {
    await clipboard.writeText(text);
    copied = true;
  }
  return { kind: "text", source, text, ...stats(text), links: extractLinks(text), copied, permissionHint: !text && source === "screen" && screenAccess() !== "granted" };
}

export async function scanFile(file: string, source: CodesResult["source"]): Promise<CodesResult> {
  const c = ctx;
  if (!c?.helper.available()) throw new Error(helperMissing);
  const r = await c.helper.call("ocr.barcodes", { path: file });
  return { kind: "codes", source, codes: r.codes.map((code) => ({ ...classifyPayload(code.payload), payload: code.payload, symbology: code.symbology.replace(/^VNBarcodeSymbology/, "") })) };
}

function show(view: ViewRequest, fromLauncher: boolean): ExecuteResult {
  if (fromLauncher) return { ok: true, view };
  ctx?.openView(view);
  return { ok: true };
}

const permissionView = (): ViewRequest => ({ id: "ocr.result", props: { kind: "permission", title: "Screen Text" } });

/** Region capture runs after the launcher hides; the result opens the launcher again with the view. */
async function captureFlow(mode: "text" | "codes"): Promise<void> {
  const c = ctx;
  if (!c || busy) return;
  const access = screenAccess();
  if (access === "denied" || access === "restricted") {
    c.openView(permissionView());
    return;
  }
  if (!c.helper.available()) {
    c.openView({ id: "ocr.result", props: { kind: "error", title: "Screen Text", message: helperMissing } });
    return;
  }
  busy = true;
  let file: string | null = null;
  try {
    c.hideLauncher();
    await sleep(200);
    file = await captureRegion();
    if (!file) return; // cancelled with Esc
    if (mode === "text") {
      const r = await recognizeFile(file, "screen");
      if (r.text && r.copied) hud("Copied Text to Clipboard");
      c.openView({ id: "ocr.result", props: { ...r, title: "Screen Text" } });
    } else {
      const r = await scanFile(file, "screen");
      if (!r.codes.length) {
        c.openView({ id: "ocr.result", props: { kind: "error", title: "Screen Text", message: screenAccess() === "granted" ? "No QR code or barcode found in the selected area." : "No code found. If the capture was blank, Glide needs Screen Recording permission.", permissionHint: screenAccess() !== "granted" } });
      } else c.openView({ id: "ocr.codes", props: { ...r, title: "QR & Barcodes" } });
    }
  } catch (err) {
    c.openView({ id: "ocr.result", props: { kind: "error", title: "Screen Text", message: err instanceof Error ? err.message : String(err) } });
  } finally {
    if (file) removeQuietly(file);
    busy = false;
  }
}

async function fromClipboard(mode: "text" | "codes", fromLauncher: boolean): Promise<ExecuteResult> {
  const img = await clipboardImage();
  if (!img) return { ok: false, error: "The clipboard has no image. Copy a screenshot or image first (⌃⇧⌘4 copies a screenshot)." };
  try {
    if (mode === "text") {
      const r = await recognizeFile(img.path, "clipboard");
      if (!r.text) return { ok: false, error: "No text found in the clipboard image." };
      return show({ id: "ocr.result", props: { ...r, title: "Screen Text" } }, fromLauncher);
    }
    const r = await scanFile(img.path, "clipboard");
    if (!r.codes.length) return { ok: false, error: "No QR code or barcode found in the clipboard image." };
    return show({ id: "ocr.codes", props: { ...r, title: "QR & Barcodes" } }, fromLauncher);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (img.temp) removeQuietly(img.path);
  }
}

const ITEMS: Array<{ id: string; title: string; subtitle: string; icon: string; keywords: string[] }> = [
  { id: "capture-text", title: "Capture Text", subtitle: "Select an area of the screen and copy its text (OCR)", icon: "🔍", keywords: ["ocr", "screen text", "extract text", "recognize", "screenshot text", "scan text"] },
  { id: "scan-qr", title: "Scan QR Code", subtitle: "Select a QR code or barcode on screen", icon: "🔳", keywords: ["qr", "barcode", "scan", "code"] },
  { id: "clipboard-text", title: "Capture Text from Clipboard Image", subtitle: "OCR the image on the clipboard", icon: "📋", keywords: ["ocr", "clipboard", "image", "extract text"] },
  { id: "clipboard-qr", title: "Scan QR Code from Clipboard Image", subtitle: "Read a QR code or barcode from the clipboard image", icon: "📋", keywords: ["qr", "barcode", "clipboard"] },
];

const str = (v: unknown) => (typeof v === "string" ? v : "");

export const feature: FeatureModule = {
  id: "ocr",
  start(c) {
    ctx = c;
  },
  stop() {
    ctx = null;
  },
  items(): SearchItem[] {
    return ITEMS.map((i) => ({ id: `ocr.${i.id}`, kind: "command", title: i.title, subtitle: i.subtitle, icon: { kind: "emoji", value: i.icon }, keywords: i.keywords, feature: "ocr", kindLabel: "Screen Text", data: { action: i.id } }));
  },
  actions(item): ItemAction[] {
    const a = item.data?.action;
    const primary = ITEMS.find((i) => i.id === a);
    if (!primary) return [];
    return [
      { id: String(a), title: primary.title, icon: primary.icon },
      { id: "screen-recording", title: "Open Screen Recording Settings", icon: "🔐" },
      { id: "settings", title: "Screen Text Settings…", icon: "⚙️" },
    ];
  },
  async runAction(scored, actionId) {
    switch (actionId) {
      case "capture-text":
      case "scan-qr":
        // Return now so the launcher hides; the capture waits for the user's selection.
        void captureFlow(actionId === "capture-text" ? "text" : "codes");
        return { ok: true, hide: true };
      case "clipboard-text":
      case "clipboard-qr":
        return fromClipboard(actionId === "clipboard-text" ? "text" : "codes", !!BrowserWindow.getFocusedWindow());
      case "screen-recording":
        await shell.openExternal(SCREEN_RECORDING_PANE);
        return { ok: true, hide: true };
      case "settings":
        ctx?.openSettings("ocr");
        return { ok: true, hide: true };
      default:
        return { ok: false, error: `Unknown action for ${scored.item.title}` };
    }
  },
  methods: {
    settings: () => ({ ...settings(), screenAccess: screenAccess(), helper: ctx?.helper.available() === true }),
    setSettings: (patch) => {
      const p = (patch && typeof patch === "object" ? patch : {}) as Partial<OcrSettings>;
      const clean: Partial<OcrSettings> = {};
      if (typeof p.autoCopy === "boolean") clean.autoCopy = p.autoCopy;
      if (typeof p.languageCorrection === "boolean") clean.languageCorrection = p.languageCorrection;
      if (typeof p.fast === "boolean") clean.fast = p.fast;
      if (Array.isArray(p.languages)) clean.languages = p.languages.filter((l): l is string => typeof l === "string" && /^[a-zA-Z-]{2,10}$/.test(l));
      ctx?.setSettings(clean);
      return { ...settings(), screenAccess: screenAccess(), helper: ctx?.helper.available() === true };
    },
    /** OCR an existing image file (not deleted). Used by tests and "open image" flows. */
    recognizeImage: (file) => recognizeFile(str(file), "file"),
    scanImage: (file) => scanFile(str(file), "file"),
    /** Recognize an image file and show the result view (file is left in place). */
    openImage: async (file, mode) => {
      try {
        if (mode === "codes") {
          const r = await scanFile(str(file), "file");
          ctx?.openView(r.codes.length ? { id: "ocr.codes", props: { ...r, title: "QR & Barcodes" } } : { id: "ocr.result", props: { kind: "error", title: "Screen Text", message: "No QR code or barcode found in the image." } });
          return r;
        }
        const r = await recognizeFile(str(file), "file");
        ctx?.openView({ id: "ocr.result", props: { ...r, title: "Screen Text" } });
        return r;
      } catch (err) {
        ctx?.openView({ id: "ocr.result", props: { kind: "error", title: "Screen Text", message: err instanceof Error ? err.message : String(err) } });
        return null;
      }
    },
    captureText: () => void captureFlow("text"),
    scanQr: () => void captureFlow("codes"),
    copy: async (text) => {
      if (typeof text !== "string") return false;
      await clipboard.writeText(text);
      return true;
    },
    paste: async (text): Promise<ExecuteResult> => {
      if (typeof text !== "string" || !text) return { ok: false, error: "Nothing to paste" };
      const c = ctx;
      if (!c) return { ok: false, error: "Not ready" };
      c.hideLauncher();
      await sleep(150);
      if (c.helper.available()) {
        const r = await c.helper.call("keys.paste", { text }).catch(() => ({ ok: false }));
        if (r.ok) return { ok: true, hide: true };
      }
      await clipboard.writeText(text);
      return { ok: false, error: "Could not paste — the text is on your clipboard." };
    },
    openUrl: async (url) => {
      const u = str(url);
      if (!isOpenable(u)) return false;
      await shell.openExternal(u);
      ctx?.hideLauncher();
      return true;
    },
    openScreenRecordingSettings: () => shell.openExternal(SCREEN_RECORDING_PANE),
  },
};
