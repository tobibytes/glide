/**
 * Client for the Swift helper (src/native/GlideHelper). Protocol: src/native/PROTOCOL.md.
 * The exported types and NativeHelper interface are the contract every feature codes against.
 */
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
export type WindowAction =
  | "left-half" | "right-half" | "top-half" | "bottom-half"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | "left-third" | "center-third" | "right-third" | "left-two-thirds" | "right-two-thirds"
  | "maximize" | "almost-maximize" | "center" | "reasonable-size" | "restore"
  | "next-display" | "previous-display" | "make-larger" | "make-smaller"
  | "toggle-fullscreen" | "minimize";

export interface PermissionStatus {
  accessibility: boolean;
  inputMonitoring: boolean;
  calendar: "authorized" | "denied" | "notDetermined" | "restricted";
}

export interface FrontmostApp {
  name: string;
  bundleId: string | null;
  pid: number;
  path: string | null;
}

export interface MenuItemInfo {
  /** Titles from the menu bar down, e.g. ["File", "Export", "PDF…"] */
  path: string[];
  enabled: boolean;
  /** Display string such as "⇧⌘E" */
  shortcut?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO 8601
  end: string;
  allDay: boolean;
  location?: string;
  url?: string;
  notes?: string;
  calendar: string;
  color?: string; // #rrggbb
}

export interface KeyConfig {
  /** Typed keyword (e.g. ";sig") replaced by text anywhere. Empty array disables expansion. */
  snippets: Array<{ keyword: string; text: string }>;
  /** "capslock": Caps Lock acts as ⌃⌥⇧⌘ while held (and Escape when tapped alone). */
  hyperKey: "off" | "capslock";
}

export interface HelperRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A display in AX coordinates (origin top-left of the main display, y down). Main display first. */
export interface HelperDisplay {
  id: number;
  uuid: string | null;
  name: string;
  frame: HelperRect;
  visible: HelperRect;
  main: boolean;
}

export interface HelperRunningApp extends FrontmostApp {
  hidden: boolean;
}

/** A standard, non-minimized window of a regular app. `ref` is valid until the next layouts.capture. */
export interface HelperWindow {
  ref: number;
  pid: number;
  bundleId: string | null;
  appName: string;
  appPath: string | null;
  title: string;
  frame: HelperRect;
  /** Index into the capture's displays (largest overlap). */
  display: number;
  /** Position among this app's captured windows, front to back. */
  order: number;
  fullScreen: boolean;
}

export interface OcrLine {
  text: string;
  confidence: number;
  /** Normalised 0…1, origin top-left. */
  box: HelperRect;
}

export interface OcrBarcode {
  payload: string;
  /** Vision symbology, e.g. "VNBarcodeSymbologyQR". */
  symbology: string;
  box: HelperRect;
}

/** Methods and their params/results. */
export interface HelperMethods {
  ping: { params: void; result: { version: string } };
  "permissions.status": { params: void; result: PermissionStatus };
  "permissions.request": { params: { kind: "accessibility" | "inputMonitoring" | "calendar" }; result: PermissionStatus };
  "app.frontmost": { params: void; result: FrontmostApp | null };
  "selection.text": { params: void; result: { text: string | null } };
  "windows.apply": { params: { action: WindowAction }; result: { ok: boolean; error?: string } };
  "menus.list": { params: { pid?: number }; result: MenuItemInfo[] };
  "menus.press": { params: { pid?: number; path: string[] }; result: { ok: boolean; error?: string } };
  "keys.configure": { params: KeyConfig; result: { ok: boolean; error?: string } };
  "keys.paste": { params: { text: string }; result: { ok: boolean } };
  "calendar.events": { params: { from: string; to: string }; result: CalendarEvent[] };
  "system.spotlightShortcut": { params: void; result: { enabled: boolean } };
  "system.setSpotlightShortcut": { params: { enabled: boolean }; result: { ok: boolean; error?: string } };
  /** System color sampler loupe (hide Glide first). hex is null when cancelled with Esc or timed out. */
  "color.pick": { params: { timeoutMs?: number }; result: { hex: string | null; r?: number; g?: number; b?: number; a?: number; reason?: "cancelled" | "timeout" } };
  "layouts.displays": { params: void; result: HelperDisplay[] };
  /** Regular (Dock) apps that are running, excluding Glide. */
  "layouts.apps": { params: void; result: HelperRunningApp[] };
  /** Needs Accessibility. Hidden apps' windows are skipped unless includeHidden. */
  "layouts.capture": { params: { includeHidden?: boolean }; result: { ok: boolean; error?: string; displays?: HelperDisplay[]; windows?: HelperWindow[] } };
  /** Moves windows from the latest capture; `frame` per result is what the app accepted. */
  "layouts.move": { params: { moves: Array<{ ref: number; frame: HelperRect; raise?: boolean }> }; result: { ok: boolean; error?: string; results?: Array<{ ref: number; ok: boolean; error?: string; frame?: HelperRect }> } };
  /** NSRunningApplication.terminate() for each running app with these bundle ids (apps may still ask to save). */
  "apps.quit": { params: { bundleIds: string[] }; result: { ok: boolean; asked: string[] } };
  /** Vision text recognition on an image file. Empty languages = automatic detection. */
  "ocr.recognize": { params: { path: string; languages?: string[]; fast?: boolean; languageCorrection?: boolean }; result: { width: number; height: number; lines: OcrLine[] } };
  "ocr.barcodes": { params: { path: string }; result: { width: number; height: number; codes: OcrBarcode[] } };
}

export interface HelperEvents {
  "snippet.expanded": { keyword: string };
  "keys.tapFailed": { reason: string };
  "permissions.changed": PermissionStatus;
}

export interface NativeHelper {
  /** True once the helper process is running and answered ping. */
  available(): boolean;
  call<M extends keyof HelperMethods>(method: M, ...params: HelperMethods[M]["params"] extends void ? [] : [HelperMethods[M]["params"]]): Promise<HelperMethods[M]["result"]>;
  on<E extends keyof HelperEvents>(event: E, cb: (data: HelperEvents[E]) => void): () => void;
  dispose(): void;
}

/** Minimal view of a child process, so tests can substitute a fake. */
export interface HelperChild {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream & { setEncoding?(enc: BufferEncoding): unknown };
  readonly stderr?: (NodeJS.ReadableStream & { setEncoding?(enc: BufferEncoding): unknown }) | null;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface HelperClientOptions {
  binaryPath: string;
  spawn?: (binaryPath: string) => HelperChild;
  exists?: (binaryPath: string) => boolean;
  /** Per-call timeout (default 10 s). */
  timeoutMs?: number;
  /** Base restart delay; doubles with each restart inside the window (default 500 ms). */
  restartDelayMs?: number;
  maxRestartsPerMinute?: number;
  log?: (...args: unknown[]) => void;
}

/** Calls that legitimately wait on the user (system permission prompts). */
// OCR of a large Retina capture can take several seconds on the accurate path.
const SLOW_METHODS: ReadonlySet<string> = new Set(["permissions.request", "color.pick", "ocr.recognize", "ocr.barcodes"]);
const SLOW_TIMEOUT_MS = 120_000;

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

type Incoming = { id?: unknown; result?: unknown; error?: unknown; event?: unknown; data?: unknown };

export function createHelperClient(opts: HelperClientOptions): NativeHelper {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const restartDelayMs = opts.restartDelayMs ?? 500;
  const maxRestarts = opts.maxRestartsPerMinute ?? 5;
  const log = opts.log ?? ((...a: unknown[]) => console.log("[helper]", ...a));
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const doSpawn = opts.spawn ?? ((p: string) => spawnProcess(p, [], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as HelperChild);

  const events = new EventEmitter();
  const pending = new Map<number, Pending>();
  const restarts: number[] = [];
  let child: HelperChild | null = null;
  let ready = false;
  let disposed = false;
  let missing = false;
  let nextId = 1;
  let restartTimer: NodeJS.Timeout | undefined;
  // Replayed after a restart so snippet expansion / Hyper key survive a helper crash.
  let lastKeyConfig: KeyConfig | null = null;

  const rejectAll = (message: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      pending.delete(id);
    }
  };

  const onLine = (line: string) => {
    if (!line.trim()) return;
    let msg: Incoming;
    try {
      msg = JSON.parse(line) as Incoming;
    } catch {
      log("unparseable line from helper:", line.slice(0, 200));
      return;
    }
    if (typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? null);
    } else if (typeof msg.event === "string") {
      events.emit(msg.event, msg.data);
    }
  };

  const send = (method: string, params: unknown): Promise<unknown> => {
    if (disposed) return Promise.reject(new Error("Glide helper has been shut down"));
    if (missing) return Promise.reject(new Error(`Glide helper is not installed (expected ${opts.binaryPath}). Run "pnpm build:helper".`));
    const proc = child;
    if (!proc) return Promise.reject(new Error("Glide helper is not running (restarting)"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const ms = SLOW_METHODS.has(method) ? Math.max(timeoutMs, SLOW_TIMEOUT_MS) : timeoutMs;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Glide helper timed out on ${method}`));
      }, ms);
      pending.set(id, { method, resolve, reject, timer });
      const line = JSON.stringify(params === undefined ? { id, method } : { id, method, params }) + "\n";
      try {
        proc.stdin.write(line);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const scheduleRestart = () => {
    if (disposed || restartTimer) return;
    const now = Date.now();
    while (restarts.length && now - restarts[0]! > 60_000) restarts.shift();
    if (restarts.length >= maxRestarts) {
      const wait = 60_000 - (now - restarts[0]!);
      log(`helper crashed ${restarts.length} times in a minute; retrying in ${Math.round(wait / 1000)} s`);
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        scheduleRestart();
      }, wait);
      return;
    }
    const delay = restartDelayMs * 2 ** restarts.length;
    restarts.push(now);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      start(true);
    }, delay);
  };

  const start = (isRestart: boolean) => {
    if (disposed) return;
    if (!exists(opts.binaryPath)) {
      missing = true;
      log(`binary not found at ${opts.binaryPath}; native features are disabled`);
      return;
    }
    let proc: HelperChild;
    try {
      proc = doSpawn(opts.binaryPath);
    } catch (err) {
      log("spawn failed:", err);
      scheduleRestart();
      return;
    }
    child = proc;
    let buffer = "";
    proc.stdout.setEncoding?.("utf8");
    proc.stdout.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    });
    proc.stderr?.setEncoding?.("utf8");
    proc.stderr?.on("data", (chunk: string | Buffer) => {
      const text = String(chunk).trimEnd();
      if (text) log(text);
    });
    let exited = false;
    const onGone = (why: string) => {
      if (exited) return;
      exited = true;
      if (child === proc) child = null;
      ready = false;
      rejectAll(`Glide helper ${why}`);
      if (!disposed) {
        log(`helper ${why}; restarting`);
        scheduleRestart();
      }
    };
    proc.on("exit", (code, signal) => onGone(`exited (${signal ?? code})`));
    proc.on("error", (err) => onGone(`failed: ${err.message}`));
    // A write after the child died surfaces as an async stream error; the exit handler covers it.
    proc.stdin.on("error", () => undefined);

    void send("ping", undefined).then(
      () => {
        if (child !== proc) return;
        ready = true;
        if (isRestart && lastKeyConfig) void send("keys.configure", lastKeyConfig).catch(() => undefined);
      },
      (err: unknown) => log("helper did not answer ping:", err instanceof Error ? err.message : err),
    );
  };

  start(false);

  return {
    available: () => ready && !disposed,
    call: ((method: keyof HelperMethods, ...params: unknown[]) => {
      if (method === "keys.configure") lastKeyConfig = (params[0] as KeyConfig | undefined) ?? null;
      return send(method, params[0]);
    }) as NativeHelper["call"],
    on(event, cb) {
      const listener = (data: unknown) => cb(data as never);
      events.on(event, listener);
      return () => events.off(event, listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ready = false;
      if (restartTimer) clearTimeout(restartTimer);
      rejectAll("Glide helper has been shut down");
      const proc = child;
      child = null;
      if (!proc) return;
      // EOF lets the helper restore the Caps Lock mapping and remove its tap before exiting.
      try {
        proc.stdin.end();
      } catch {
        /* already closed */
      }
      const kill = setTimeout(() => proc.kill("SIGTERM"), 1500);
      kill.unref?.();
      proc.on("exit", () => clearTimeout(kill));
    },
  };
}

/** Development: <repo>/build/bin/glide-helper. Packaged: Contents/Resources/bin/glide-helper. */
export function helperBinaryPath(): string {
  if (process.env.GLIDE_HELPER_PATH) return process.env.GLIDE_HELPER_PATH;
  // Lazy require keeps this module importable from plain Node (tests, scripts).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  if (app?.isPackaged) return path.join(process.resourcesPath, "bin", "glide-helper");
  return path.join(app?.getAppPath?.() ?? process.cwd(), "build", "bin", "glide-helper");
}

export function createNativeHelper(): NativeHelper {
  return createHelperClient({ binaryPath: helperBinaryPath() });
}
