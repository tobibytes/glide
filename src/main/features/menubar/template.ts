/** MenuBarMenuItem -> Electron menu template (pure; images are resolved by the caller). */
import type { MenuItemConstructorOptions, NativeImage } from "electron";
import type { MenuBarMenuItem } from "../../menubar";

/** Emoji/text icons are drawn inline in the label; PNG paths become menu images. */
export const isImagePath = (icon: string | undefined): icon is string => !!icon && icon.startsWith("/") && /\.png$/i.test(icon);

/** Electron rejects some accelerators; menus only display them, so drop anything malformed. */
export function displayAccelerator(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined;
  const parts = shortcut.split("+").map((p) => p.trim());
  return parts.every(Boolean) && parts.length <= 5 ? parts.join("+") : undefined;
}

export function toMenuTemplate(items: MenuBarMenuItem[], image?: (path: string) => NativeImage | undefined): MenuItemConstructorOptions[] {
  return items.map((m): MenuItemConstructorOptions => {
    if (m.separator) return { type: "separator" };
    const textIcon = m.icon && !isImagePath(m.icon) ? `${m.icon}  ` : "";
    const opt: MenuItemConstructorOptions = { label: `${textIcon}${m.title ?? ""}` };
    if (m.subtitle) opt.sublabel = m.subtitle;
    if (isImagePath(m.icon) && image) {
      const img = image(m.icon);
      if (img) opt.icon = img;
    }
    const accel = displayAccelerator(m.shortcut);
    if (accel) {
      opt.accelerator = accel;
      opt.registerAccelerator = false; // shown only; status menus never own global keys
    }
    if (m.enabled === false) opt.enabled = false;
    if (m.checked !== undefined) {
      opt.type = "checkbox";
      opt.checked = m.checked;
    }
    if (m.submenu) opt.submenu = toMenuTemplate(m.submenu, image);
    const click = m.onClick;
    if (click) opt.click = () => click();
    return opt;
  });
}

/** Text shown in the menu bar for an item: emoji icon + title, or a dot when both are empty. */
export function statusText(title: string, icon: string | undefined): string {
  const lead = icon && !isImagePath(icon) ? icon : "";
  const text = [lead, title].filter(Boolean).join(" ");
  return text || (isImagePath(icon) ? "" : "•");
}
