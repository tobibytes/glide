/**
 * GLIDE_HEADLESS=1: run Glide for automated tests without touching the user's screen or session.
 *
 * - Windows render (CDP, capturePage and screenshots work) but are never shown or focused.
 * - No global shortcuts, menu-bar icon titles, notifications, native dialogs or app activation.
 * - shell.openExternal/openPath are recorded instead of opening anything.
 * - The clipboard is an in-memory fake, so tests never read or overwrite the user's clipboard.
 * - The native helper only answers read-only methods (see HEADLESS_HELPER_METHODS); anything that
 *   would move windows, post keystrokes or install the keyboard tap is refused.
 *
 * Every suppressed side effect is logged as `[headless] …` on stdout so tests can assert on it,
 * and kept in `globalThis.__glideHeadlessLog` (readable from main via the inspector).
 */
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, Notification, shell, Tray } from "electron";

export const HEADLESS = process.env.GLIDE_HEADLESS === "1";

/** Helper methods that only read state; everything else is blocked in headless mode. */
export const HEADLESS_HELPER_METHODS = new Set([
  "ping",
  "permissions.status",
  "app.frontmost",
  "ocr.recognize",
  "ocr.barcodes",
  "layouts.displays",
  "layouts.apps",
  "calendar.events",
  "system.spotlightShortcut",
]);

type LogEntry = { at: number; kind: string; detail: unknown };
const log: LogEntry[] = [];
(globalThis as { __glideHeadlessLog?: LogEntry[] }).__glideHeadlessLog = log;

function record(kind: string, detail: unknown): void {
  log.push({ at: Date.now(), kind, detail });
  if (log.length > 500) log.shift();
  console.log(`[headless] ${kind} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

/** Patch Electron before anything else runs. No-op unless GLIDE_HEADLESS=1. */
export function installHeadless(): void {
  if (!HEADLESS) return;
  record("start", { pid: process.pid });

  // Windows: track "visible" ourselves so launcher logic (toggle, hide-on-blur) still works.
  const visible = new WeakSet<BrowserWindow>();
  const proto = BrowserWindow.prototype as unknown as Record<string, unknown>;
  proto.show = function (this: BrowserWindow) {
    visible.add(this);
    this.webContents.setBackgroundThrottling(false);
    this.emit("show");
  };
  proto.showInactive = proto.show;
  proto.focus = function () {};
  proto.moveTop = function () {};
  proto.hide = function (this: BrowserWindow) {
    if (visible.delete(this)) this.emit("hide");
  };
  proto.isVisible = function (this: BrowserWindow) {
    return visible.has(this);
  };
  proto.isFocused = function (this: BrowserWindow) {
    return visible.has(this);
  };
  // Never-shown pages think they are unfocused (no caret, keystrokes ignored): emulate focus.
  app.on("web-contents-created", (_e, wc) => {
    wc.on("dom-ready", () => {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        void wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch (err) {
        record("focusEmulation.failed", String(err));
      }
    });
  });
  const appAny = app as unknown as Record<string, unknown>;
  appAny.focus = () => undefined;
  appAny.hide = () => undefined;
  appAny.show = () => undefined;

  // Global shortcuts: pretend to register so settings UIs behave, but never grab keys (e.g. ⌘Space).
  const gs = globalShortcut as unknown as Record<string, unknown>;
  const fakeShortcuts = new Set<string>();
  gs.register = (accel: string) => (record("globalShortcut.register", accel), fakeShortcuts.add(accel), true);
  gs.unregister = (accel: string) => void fakeShortcuts.delete(accel);
  gs.unregisterAll = () => fakeShortcuts.clear();
  gs.isRegistered = (accel: string) => fakeShortcuts.has(accel);

  // Notifications, tray titles and images.
  (Notification.prototype as unknown as Record<string, unknown>).show = function (this: Notification) {
    record("notification", { title: this.title, body: this.body });
  };
  const trayProto = Tray.prototype as unknown as Record<string, unknown>;
  trayProto.setTitle = (title: string) => record("tray.setTitle", title);
  trayProto.setImage = () => undefined;

  // Native dialogs: answer with GLIDE_HEADLESS_DIALOG_RESPONSE (default 0, usually "Cancel").
  const response = Number(process.env.GLIDE_HEADLESS_DIALOG_RESPONSE ?? 0);
  const d = dialog as unknown as Record<string, unknown>;
  const messageBox = async (...args: unknown[]) => {
    const opts = (args.find((a) => a && typeof a === "object" && "message" in (a as object)) ?? {}) as { message?: string; buttons?: string[] };
    record("dialog.showMessageBox", { message: opts.message, buttons: opts.buttons, response });
    return { response, checkboxChecked: false };
  };
  d.showMessageBox = messageBox;
  d.showMessageBoxSync = (...args: unknown[]) => (void messageBox(...args), response);
  d.showOpenDialog = async () => (record("dialog.showOpenDialog", ""), { canceled: true, filePaths: [] });
  d.showSaveDialog = async () => (record("dialog.showSaveDialog", ""), { canceled: true, filePath: undefined });
  d.showErrorBox = (title: string, content: string) => record("dialog.showErrorBox", { title, content });

  // Opening things.
  const sh = shell as unknown as Record<string, unknown>;
  sh.openExternal = async (url: string) => void record("shell.openExternal", url);
  sh.openPath = async (p: string) => (record("shell.openPath", p), "");
  sh.showItemInFolder = (p: string) => record("shell.showItemInFolder", p);
  sh.beep = () => record("shell.beep", "");
  sh.trashItem = async (p: string) => void record("shell.trashItem", p);

  // In-memory clipboard. Electron 44's clipboard is the async W3C-style API (read/write ClipboardItem).
  let items: Electron.ClipboardItem[] = [];
  const asText = async (v: unknown): Promise<string> => (typeof v === "string" ? v : v instanceof Blob ? v.text() : String(v ?? ""));
  const cb = clipboard as unknown as Record<string, unknown>;
  cb.read = async () => items;
  cb.write = async (next: Electron.ClipboardItem[]) => {
    items = [...next];
  };
  cb.readText = async () => {
    const item = items.find((i) => i.types.includes("text/plain"));
    return item ? asText(await item.getType("text/plain")) : "";
  };
  cb.writeText = async (text: string) => {
    items = [new ClipboardItem({ "text/plain": String(text) })];
  };
  cb.clear = async () => {
    items = [];
  };
}
