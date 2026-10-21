import { createMenuBarManager, type MenuBarItemState, type TrayFactory } from "./features/menubar/core";

/**
 * Menu-bar extras: features and extensions register status items through this module.
 * Contract shared by the menu-bar session (owner, implements it) and the extensions session (consumer).
 * Each registration becomes its own macOS status item (an Electron Tray) once the menu-bar feature
 * activates rendering after app ready; until then (and always in headless mode) only state is kept.
 * Updates are diffed (title / icon / tooltip / menu separately) and throttled to ≤ 4 renders/s per item.
 */
export interface MenuBarMenuItem {
  title?: string;
  subtitle?: string;
  /** Emoji, or an absolute PNG path (template image when it ends in "Template.png"). */
  icon?: string;
  /** Electron accelerator shown next to the item, e.g. "CommandOrControl+R". */
  shortcut?: string;
  enabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuBarMenuItem[];
  onClick?: () => void;
}

export interface MenuBarItemSpec {
  /** Stable id, e.g. "timers" or "ext:<extension>/<command>". */
  id: string;
  /** Text shown in the menu bar (keep short); icon-only when empty. */
  title?: string;
  icon?: string;
  tooltip?: string;
  menu: MenuBarMenuItem[];
}

export interface MenuBarHandle {
  update(spec: Omit<MenuBarItemSpec, "id">): void;
  remove(): void;
}

const manager = createMenuBarManager({ onError: (err) => console.warn("[menubar] render failed:", err) });

/** Register (or replace) a status item. Safe to call any time, even before app ready. */
export function registerMenuBarItem(spec: MenuBarItemSpec): MenuBarHandle {
  return manager.register(spec);
}

/** Current registrations (for the implementation and tests). */
export function menuBarItems(): MenuBarItemSpec[] {
  return manager.items();
}

/** Start rendering registrations (null factory = state only, used in headless mode). */
export function activateMenuBar(factory: TrayFactory | null): void {
  manager.activate(factory);
}

export function deactivateMenuBar(): void {
  manager.deactivate();
}

/** Function-free snapshot of every registration (headless tests, debug). */
export function menuBarState(): MenuBarItemState[] {
  manager.flush();
  return manager.state();
}

/** Run the click handler of the item at `path` in registration `id`'s menu. */
export function clickMenuBarItem(id: string, path: number[]): boolean {
  return manager.click(id, path);
}

export type { MenuBarItemState, TrayFactory };
