import path from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { IPC } from "@shared/ipc";

const LAUNCHER_WIDTH = 760;
const LAUNCHER_MIN_HEIGHT = 60;
const LAUNCHER_MAX_HEIGHT = 620;
const LAUNCHER_TOP_RATIO = 0.22;
// Appearance can change the launcher width at runtime (see features/appearance).
let launcherWidth = LAUNCHER_WIDTH;
export function setLauncherWidth(width: number): void {
  if (Number.isFinite(width) && width >= 480 && width <= 1400) launcherWidth = Math.round(width);
}
const SETTINGS_SIZE = { width: 1040, height: 720, minWidth: 820, minHeight: 540 };

export interface Windows {
  /** Create the launcher window up front so the first hotkey press is instant. */
  createLauncher(): void;
  showLauncher(): void;
  hideLauncher(): void;
  toggleLauncher(): void;
  isLauncherVisible(): boolean;
  resizeLauncher(height: number): void;
  openSettings(page?: string): void;
  sendToLauncher(channel: string, ...args: unknown[]): void;
  broadcast(channel: string, ...args: unknown[]): void;
}

export interface WindowsDeps {
  getHideOnBlur(): boolean;
  onLauncherHidden?(): void;
}

const preloadPath = path.join(__dirname, "../preload/index.cjs");
const rendererFile = path.join(__dirname, "../renderer/index.html");
const devServer = process.env.GLIDE_DEV_SERVER?.replace(/\/$/, "");

export function loadRenderer(win: BrowserWindow, hash: string): Promise<void> {
  return devServer ? win.loadURL(`${devServer}/#${hash}`) : win.loadFile(rendererFile, { hash });
}

export const webPreferences: Electron.WebPreferences = {
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
};

export function createWindows(deps: WindowsDeps): Windows {
  let launcher: BrowserWindow | undefined;
  let settings: BrowserWindow | undefined;

  const positionLauncher = (win: BrowserWindow) => {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const [w] = win.getSize();
    win.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * LAUNCHER_TOP_RATIO), false);
  };

  const createLauncher = (): BrowserWindow => {
    if (launcher && !launcher.isDestroyed()) return launcher;
    const win = new BrowserWindow({
      width: launcherWidth,
      height: LAUNCHER_MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      roundedCorners: true,
      hiddenInMissionControl: true,
      // NSPanel: floats above everything and does not steal the active app's spot in the Dock/⌘-Tab.
      type: "panel",
      vibrancy: "under-window",
      visualEffectState: "active",
      webPreferences,
    });
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setMenuBarVisibility(false);
    win.on("blur", () => {
      if (deps.getHideOnBlur() && win.isVisible()) hideLauncher();
    });
    win.on("closed", () => {
      launcher = undefined;
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void loadRenderer(win, "/");
    launcher = win;
    return win;
  };

  const showLauncher = () => {
    const win = createLauncher();
    positionLauncher(win);
    // After app.hide() (see hideLauncher) win.show() alone can leave Glide inactive, so the
    // panel appears without keyboard focus and the next click elsewhere dismisses it.
    if (process.platform === "darwin") app.focus({ steal: true });
    win.show();
    win.focus();
    win.webContents.send(IPC.EVT_SHOW);
  };

  const hideLauncher = () => {
    if (!launcher || launcher.isDestroyed() || !launcher.isVisible()) return;
    launcher.hide();
    // Give focus back to the previously active app (unless our settings window is open).
    // "exists" rather than "isVisible": openSettings hides the launcher before its window is ready to show.
    if (process.platform === "darwin" && !(settings && !settings.isDestroyed())) app.hide();
    deps.onLauncherHidden?.();
  };

  const isLauncherVisible = () => !!launcher && !launcher.isDestroyed() && launcher.isVisible();

  const resizeLauncher = (height: number) => {
    if (!launcher || launcher.isDestroyed()) return;
    const h = Math.min(Math.max(Math.round(height), LAUNCHER_MIN_HEIGHT), LAUNCHER_MAX_HEIGHT);
    const [x, y] = launcher.getPosition();
    launcher.setBounds({ x, y, width: launcherWidth, height: h }, false);
  };

  const openSettings = (page?: string) => {
    const route = page ? `settings/${page.replace(/^\/?settings\/?/, "")}` : "settings";
    if (settings && !settings.isDestroyed()) {
      settings.show();
      settings.focus();
      settings.webContents.send(IPC.EVT_NAVIGATE, route);
      return;
    }
    const win = new BrowserWindow({
      ...SETTINGS_SIZE,
      show: false,
      titleBarStyle: "hiddenInset",
      title: "Glide Settings",
      backgroundColor: "#00000000",
      vibrancy: "sidebar",
      webPreferences,
    });
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      settings = undefined;
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void loadRenderer(win, `/${route}`);
    settings = win;
    hideLauncher();
  };

  return {
    createLauncher: () => void createLauncher(),
    showLauncher,
    hideLauncher,
    toggleLauncher: () => (isLauncherVisible() ? hideLauncher() : showLauncher()),
    isLauncherVisible,
    resizeLauncher,
    openSettings,
    sendToLauncher: (channel, ...args) => {
      if (launcher && !launcher.isDestroyed()) launcher.webContents.send(channel, ...args);
    },
    broadcast: (channel, ...args) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, ...args);
    },
  };
}
