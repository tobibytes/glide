/** Electron-backed TrayFactory for the menu-bar manager (never used in headless mode). */
import { Menu, nativeImage, Tray, type NativeImage } from "electron";
import type { TrayFactory } from "./core";
import { isImagePath, statusText, toMenuTemplate } from "./template";

function loadImage(path: string, size = 18): NativeImage | undefined {
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return undefined;
  const sized = img.getSize().height > size ? img.resize({ height: size }) : img;
  if (/Template\.png$/.test(path)) sized.setTemplateImage(true);
  return sized;
}

export const electronTrayFactory: TrayFactory = () => {
  const tray = new Tray(nativeImage.createEmpty());
  let title = "";
  let icon: string | undefined;
  const render = () => {
    if (tray.isDestroyed()) return;
    tray.setImage((isImagePath(icon) && loadImage(icon)) || nativeImage.createEmpty());
    tray.setTitle(statusText(title, icon), { fontType: "monospacedDigit" });
  };
  return {
    setTitle(t) {
      title = t;
      render();
    },
    setIcon(i) {
      icon = i;
      render();
    },
    setTooltip(t) {
      if (!tray.isDestroyed()) tray.setToolTip(t);
    },
    setMenu(menu) {
      if (!tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(toMenuTemplate(menu, (p) => loadImage(p, 16))));
    },
    destroy() {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
};
