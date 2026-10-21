import { Menu, nativeImage, Tray } from "electron";
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

export function createTray(windows: Windows): Tray {
  const icon = nativeImage.createFromBuffer(pixelArtPng(GLYPH, 1), { scaleFactor: 1 });
  icon.addRepresentation({ scaleFactor: 2, buffer: pixelArtPng(GLYPH, 2) });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Glide");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Glide", click: () => windows.showLauncher() },
      { label: "Settings…", click: () => windows.openSettings() },
      { type: "separator" },
      { label: "Quit Glide", role: "quit" },
    ]),
  );
  return tray;
}

/**
 * Text shown next to the Glide menu-bar icon ("" clears it). Hook for features that show a live value
 * there (src/main/features/timers shows the soonest running timer). No-op before the tray exists.
 */
export function setTrayTitle(title: string): void {
  if (tray && !tray.isDestroyed()) tray.setTitle(title, { fontType: "monospacedDigit" });
}
