/**
 * Raycast MenuBarExtra (serialised as a "menubar" view model) → a status item spec for
 * src/main/menubar.ts. Pure: clicks are routed through `invoke(handler)`.
 */
import type { MenuBarItemSpec, MenuBarMenuItem } from "../../menubar";
import type { MenuBarEntryModel, ViewModel } from "../../../extension-api/types";

type MenuBarView = Extract<ViewModel, { type: "menubar" }>;

export const menuBarId = (ext: string, command: string) => `ext:${ext}/${command}`;

/** Status items take emoji or absolute PNG paths; other icon sources (URLs, colours) are dropped. */
export function menuIcon(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (/^file:\/\//i.test(src)) {
    const p = decodeURI(src.slice(7));
    return /\.png$/i.test(p) && p.startsWith("/") ? p : undefined;
  }
  if (/^(https?:|data:|#)/i.test(src) || src.includes("/")) return undefined;
  return src;
}

/** "⌘⇧R" → "CommandOrControl+Shift+R" (Electron accelerator). */
export function toAccelerator(display: string | undefined): string | undefined {
  if (!display) return undefined;
  const mods: string[] = [];
  let rest = display;
  const table: Array<[string, string]> = [
    ["⌃", "Control"],
    ["⌥", "Alt"],
    ["⇧", "Shift"],
    ["⌘", "CommandOrControl"],
  ];
  for (;;) {
    const hit = table.find(([g]) => rest.startsWith(g));
    if (!hit) break;
    mods.push(hit[1]);
    rest = rest.slice(hit[0].length);
  }
  const keys: Record<string, string> = { "⏎": "Return", "⌫": "Backspace", "⌦": "Delete", "⇥": "Tab", "⎋": "Escape", "↑": "Up", "↓": "Down", "←": "Left", "→": "Right", Space: "Space" };
  const key = keys[rest] ?? (rest.length === 1 ? rest.toUpperCase() : "");
  return key ? [...mods, key].join("+") : undefined;
}

function entries(list: MenuBarEntryModel[], invoke: (handler: string) => void): MenuBarMenuItem[] {
  const out: MenuBarMenuItem[] = [];
  for (const e of list) {
    if (e.kind === "separator") {
      if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
      continue;
    }
    if (e.kind === "section") {
      const children = entries(e.children ?? [], invoke);
      if (!children.length && !e.title) continue;
      if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
      if (e.title) out.push({ title: e.title, enabled: false });
      out.push(...children, { separator: true });
      continue;
    }
    const item: MenuBarMenuItem = {};
    if (e.title !== undefined) item.title = e.title;
    if (e.subtitle) item.subtitle = e.subtitle;
    const icon = menuIcon(e.icon);
    if (icon) item.icon = icon;
    if (e.kind === "submenu") item.submenu = entries(e.children ?? [], invoke);
    else {
      const accel = toAccelerator(e.shortcut);
      if (accel) item.shortcut = accel;
      const handler = e.handler;
      if (handler) item.onClick = () => invoke(handler);
      else item.enabled = false;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

export function menuBarSpec(view: MenuBarView, invoke: (handler: string) => void, fallbackTitle: string): Omit<MenuBarItemSpec, "id"> {
  const menu = entries(view.items, invoke);
  if (view.isLoading && !menu.length) menu.push({ title: "Loading…", enabled: false });
  const icon = menuIcon(view.icon);
  const spec: Omit<MenuBarItemSpec, "id"> = { menu };
  // A status item needs something visible: the command title when there is neither title nor icon.
  if (view.title) spec.title = view.title;
  else if (!icon) spec.title = fallbackTitle;
  if (icon) spec.icon = icon;
  if (view.tooltip) spec.tooltip = view.tooltip;
  return spec;
}

/** What a menu-bar command shows when it crashed or rendered something other than a MenuBarExtra. */
export function menuBarErrorSpec(commandTitle: string, message: string): Omit<MenuBarItemSpec, "id"> {
  return { title: "⚠️", tooltip: `${commandTitle} failed`, menu: [{ title: `${commandTitle} failed`, enabled: false }, { title: message.slice(0, 120), enabled: false }] };
}
