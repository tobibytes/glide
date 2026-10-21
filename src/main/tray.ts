/**
 * Glide's own status item. Its menu is built fresh every time it opens (src/main/features/menubar
 * provides the content: recents, timers, next event, focus), so nothing ticks while it is closed.
 */
import { app, Menu, nativeImage, Tray } from "electron";
import type { SearchItem } from "@shared/types";
import type { MenuBarMenuItem } from "./menubar";
import { toMenuTemplate } from "./features/menubar/template";
import { pixelArtPng } from "./util/png";
import type { Windows } from "./window";

// 16x16 template glyph (a "G"), drawn in code so no asset needs bundling.
const GLYPH = [
  "................",
  ".....######.....",
  "....########....",
  "...###....###...",
  "...##......##...",
  "...##...........",
  "...##...........",
  "...##...#####...",
  "...##...#####...",
  "...##......##...",
  "...##......##...",
  "...###....###...",
  "....########....",
  ".....######.....",
  "................",
  "................",
];

let tray: Tray | undefined; // kept alive for the app's lifetime
let windowsRef: Windows | undefined;
let menuProvider: (() => MenuBarMenuItem[]) | undefined;
let findItem: ((id: string) => SearchItem | undefined) | undefined;
let legacyTitle = "";
let titleHandler: ((title: string) => boolean) | undefined;

/** Wiring from src/main/index.ts (works headless too: the menu model is used by tests). */
export function configureTray(deps: { findItem(id: string): SearchItem | undefined }): void {
  findItem = deps.findItem;
}

export function trayFindItem(id: string): SearchItem | undefined {
  return findItem?.(id);
}

/** The menu-bar feature supplies the menu content; without it a basic menu is shown. */
export function setMainMenuProvider(provider: (() => MenuBarMenuItem[]) | undefined): void {
  menuProvider = provider;
}

function basicMenu(): MenuBarMenuItem[] {
  return [
    { title: "Open Glide", onClick: () => windowsRef?.showLauncher() },
    { title: "Settings…", onClick: () => windowsRef?.openSettings() },
    { separator: true },
    { title: "Quit Glide", shortcut: "CommandOrControl+Q", onClick: () => app.quit() },
  ];
}

/** The menu shown when the Glide icon is clicked, as data. */
export function mainMenu(): MenuBarMenuItem[] {
  try {
    return menuProvider?.() ?? basicMenu();
  } catch (err) {
    console.warn("[tray] menu provider failed:", err);
    return basicMenu();
  }
}

export function createTray(windows: Windows): Tray {
  windowsRef = windows;
  const icon = nativeImage.createFromBuffer(pixelArtPng(GLYPH, 1), { scaleFactor: 1 });
  icon.addRepresentation({ scaleFactor: 2, buffer: pixelArtPng(GLYPH, 2) });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Glide");
  // No setContextMenu: the menu is rebuilt on each open so recents/timers/events are current.
  const open = () => tray?.popUpContextMenu(Menu.buildFromTemplate(toMenuTemplate(mainMenu())));
  tray.on("click", open);
  tray.on("right-click", open);
  applyTitle();
  return tray;
}

let glideTitle = "";
function applyTitle(): void {
  const handled = titleHandler?.(legacyTitle) ?? false;
  glideTitle = handled ? "" : legacyTitle;
  if (tray && !tray.isDestroyed()) tray.setTitle(glideTitle, { fontType: "monospacedDigit" });
}

/**
 * Compatibility shim: text a feature wants in the menu bar ("" clears it). The timers feature calls
 * this with its countdown; the menu-bar feature routes it to the "timers" extra when that is enabled,
 * otherwise it shows next to the Glide icon as before.
 */
export function setTrayTitle(title: string): void {
  legacyTitle = title;
  applyTitle();
}

/** Install the router for setTrayTitle; return true from it to keep the Glide icon's title empty. */
export function setTrayTitleHandler(handler: ((title: string) => boolean) | undefined): void {
  titleHandler = handler;
  applyTitle();
}

/** Current shim state: what features asked for, and what the Glide icon shows. */
export function trayTitleState(): { requested: string; glideTitle: string } {
  return { requested: legacyTitle, glideTitle };
}
