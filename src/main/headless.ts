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
import childProcess from "node:child_process";
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, Notification, safeStorage, shell, Tray } from "electron";

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
  "wifi.info",
]);

type LogEntry = { at: number; kind: string; detail: unknown };
const log: LogEntry[] = [];
(globalThis as { __glideHeadlessLog?: LogEntry[] }).__glideHeadlessLog = log;

/** Record a suppressed side effect (also used by src/main/hotkeys.ts for native hotkey registrations). */
export function recordHeadless(kind: string, detail: unknown): void {
  record(kind, detail);
}

function record(kind: string, detail: unknown): void {
  log.push({ at: Date.now(), kind, detail });
  if (log.length > 500) log.shift();
  console.log(`[headless] ${kind} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

/** Commands that act on the user's session (activate apps, capture the screen, play sound, change settings). */
const BLOCKED_COMMANDS = new Set(["osascript", "open", "screencapture", "afplay", "say", "shortcuts", "killall", "qlmanage", "hidutil", "shutdown", "reboot", "caffeinate", "tccutil"]);
const SCRIPT_BLOCK = /(^|[\s;&|(`])(osascript|open|screencapture|afplay|say|shortcuts|killall|qlmanage|hidutil|defaults\s+(write|delete)|networksetup\s+-set|pmset\s+(?!-g))\b/;

/** Why a command must not run headless, or null when it is safe (read-only tools, tests' own scripts). */
export function headlessBlockReason(file: string, args: readonly string[] = []): string | null {
  const base = file.split("/").pop() ?? file;
  if (BLOCKED_COMMANDS.has(base)) return base;
  if (base === "defaults" && /^(write|delete|import)$/.test(args[0] ?? "")) return `defaults ${args[0]}`;
  if (base === "networksetup" && /^-set/.test(args[0] ?? "")) return `networksetup ${args[0]}`;
  if (base === "pmset" && args[0] !== "-g") return "pmset";
  if (/^(zsh|bash|sh)$/.test(base)) {
    const script = args.find((a, i) => args[i - 1] === "-c" || args[i - 1] === "-lc") ?? "";
    const m = SCRIPT_BLOCK.exec(script);
    if (m) return `${base} -c …${m[2]}…`;
  }
  return null;
}

/** Swap blocked commands for /usr/bin/true so callers still get a real, successful child process. */
function patchChildProcess(): void {
  const cp = childProcess as unknown as Record<string, unknown>;
  const guard = (name: string) => {
    const original = cp[name] as (...a: unknown[]) => unknown;
    if (typeof original !== "function") return;
    const wrapped = function (this: unknown, file: unknown, ...rest: unknown[]) {
      const isExec = name === "exec" || name === "execSync";
      const args = !isExec && Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
      const reason = typeof file === "string" ? (isExec ? (SCRIPT_BLOCK.exec(` ${file}`)?.[2] ?? null) : headlessBlockReason(file, args)) : null;
      if (reason) {
        record("exec.blocked", { command: reason, file, args: args.slice(0, 6) });
        if (isExec) return original.call(this, "/usr/bin/true", ...rest);
        return original.call(this, "/usr/bin/true", ...(Array.isArray(rest[0]) ? [[], ...rest.slice(1)] : rest));
      }
      return original.call(this, file, ...rest);
    };
    const custom = (original as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")];
    if (custom) {
      Object.defineProperty(wrapped, Symbol.for("nodejs.util.promisify.custom"), {
        value: (file: unknown, ...rest: unknown[]) => {
          const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
          const reason = typeof file === "string" ? (name === "exec" ? (SCRIPT_BLOCK.exec(` ${file}`)?.[2] ?? null) : headlessBlockReason(file, args)) : null;
          if (reason) {
            record("exec.blocked", { command: reason, file, args: args.slice(0, 6) });
            return Promise.resolve({ stdout: "", stderr: "" });
          }
          return (custom as (...a: unknown[]) => unknown)(file, ...rest);
        },
      });
    }
    cp[name] = wrapped;
  };
  for (const name of ["execFile", "spawn", "exec", "execFileSync", "spawnSync", "execSync"]) guard(name);
}

let installed = false;

/** Patch Electron and child_process before anything else runs. No-op unless GLIDE_HEADLESS=1. */
export function installHeadless(): void {
  if (!HEADLESS || installed) return;
  installed = true;
  patchChildProcess();
  // Never outlive the test: exit when the launching process is gone (reparented to launchd) or after
  // GLIDE_HEADLESS_MAX_MS (default 20 min). Chromium swallows SIGTERM here, so runners also SIGKILL.
  const startedBy = process.ppid;
  const maxMs = Number(process.env.GLIDE_HEADLESS_MAX_MS ?? 20 * 60_000);
  const watchdog = setInterval(() => {
    if (process.ppid !== startedBy || process.ppid === 1 || process.uptime() * 1000 > maxMs) {
      record("watchdog.exit", { ppid: process.ppid, uptimeSec: Math.round(process.uptime()) });
      app.exit(0);
    }
  }, 2000);
  watchdog.unref();
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

  // Keychain: safeStorage would ask macOS for the "Glide Safe Storage" item, which shows a keychain
  // dialog on the user's screen. Use a reversible fake instead (test data only).
  const ss = safeStorage as unknown as Record<string, unknown>;
  const PREFIX = Buffer.from("glide-headless:");
  const enc = (plain: string) => Buffer.concat([PREFIX, Buffer.from(String(plain), "utf8")]);
  const dec = (buf: Buffer) => {
    if (!Buffer.isBuffer(buf) || !buf.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error("not encrypted by headless safeStorage");
    return buf.subarray(PREFIX.length).toString("utf8");
  };
  ss.isEncryptionAvailable = () => true;
  ss.encryptString = enc;
  ss.decryptString = dec;
  ss.isAsyncEncryptionAvailable = async () => true;
  ss.encryptStringAsync = async (plain: string) => enc(plain);
  ss.decryptStringAsync = async (buf: Buffer) => ({ shouldReEncrypt: false, result: dec(buf) });
  ss.getSelectedStorageBackend = () => "headless-fake";

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

// Install on import: modules that wrap execFile with promisify() at load time must see the patch,
// so src/main/index.ts imports this module before anything else.
installHeadless();
