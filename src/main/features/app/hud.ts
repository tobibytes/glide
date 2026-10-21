/**
 * A small transient HUD ("Copied", "Launch at Login: On") near the bottom of the active screen.
 *
 * Main-process features: `import { hud } from "../app/hud"; hud("Copied to Clipboard");`
 * Renderer: `window.glide.feature("app", "hud", "Copied to Clipboard")`.
 * Calls before the app feature starts are dropped.
 */
import { screen, type BrowserWindow } from "electron";
import { IPC, type FeatureEvent } from "@shared/ipc";
import type { FeatureContext } from "../types";

export const HUD_SIZE = { width: 260, height: 60 };
export const HUD_VISIBLE_MS = 1200;
const FADE_MS = 180;
/** Vertical position as a fraction of the work area height (low on screen, like macOS volume HUD). */
const HUD_Y_RATIO = 0.82;

let createWin: ((route: string, options: Electron.BrowserWindowConstructorOptions) => BrowserWindow) | undefined;
let win: BrowserWindow | undefined;
let ready: Promise<void> | undefined;
let hideTimer: NodeJS.Timeout | undefined;
let closeTimer: NodeJS.Timeout | undefined;

export function initHud(ctx: Pick<FeatureContext, "createWindow">): void {
  createWin = ctx.createWindow;
}

export function disposeHud(): void {
  clearTimeout(hideTimer);
  clearTimeout(closeTimer);
  if (win && !win.isDestroyed()) win.destroy();
  win = undefined;
  ready = undefined;
}

function ensureWindow(): { win: BrowserWindow; ready: Promise<void> } | undefined {
  if (win && !win.isDestroyed() && ready) return { win, ready };
  if (!createWin) return undefined;
  const w = createWin("app/hud", {
    ...HUD_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    hiddenInMissionControl: true,
    type: "panel",
  });
  w.setIgnoreMouseEvents(true);
  w.setAlwaysOnTop(true, "screen-saver");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.on("closed", () => {
    if (win === w) {
      win = undefined;
      ready = undefined;
    }
  });
  win = w;
  ready = new Promise<void>((resolve) => {
    if (!w.webContents.isLoading()) resolve();
    else w.webContents.once("did-finish-load", () => resolve());
  });
  return { win: w, ready };
}

function send(target: BrowserWindow, event: string, payload?: unknown): void {
  const e: FeatureEvent = { feature: "app", event, payload };
  if (!target.isDestroyed()) target.webContents.send(IPC.EVT_FEATURE, e);
}

/** Show `text` in the HUD for 1.2 s, then fade out. Never steals focus. */
export function hud(text: string): void {
  const h = ensureWindow();
  if (!h) return;
  const message = String(text).slice(0, 80);
  void h.ready.then(() => {
    const target = h.win;
    if (target.isDestroyed()) return;
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    target.setBounds({
      x: Math.round(workArea.x + (workArea.width - HUD_SIZE.width) / 2),
      y: Math.round(workArea.y + workArea.height * HUD_Y_RATIO - HUD_SIZE.height / 2),
      ...HUD_SIZE,
    });
    clearTimeout(hideTimer);
    clearTimeout(closeTimer);
    send(target, "hud:show", message);
    target.showInactive();
    hideTimer = setTimeout(() => {
      send(target, "hud:hide");
      closeTimer = setTimeout(() => {
        if (!target.isDestroyed()) target.hide();
      }, FADE_MS + 40);
    }, HUD_VISIBLE_MS);
  });
}
