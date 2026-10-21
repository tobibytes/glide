/**
 * Menu-bar extras: features and extensions register status items through this module.
 * Contract shared by the menu-bar session (owner, implements it) and the extensions session (consumer).
 * Until implemented, registrations are stored but nothing is shown.
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

const specs = new Map<string, MenuBarItemSpec>();

/** Register (or replace) a status item. Implementation pending in the menu-bar session. */
export function registerMenuBarItem(spec: MenuBarItemSpec): MenuBarHandle {
  specs.set(spec.id, spec);
  return {
    update: (next) => void specs.set(spec.id, { ...next, id: spec.id }),
    remove: () => void specs.delete(spec.id),
  };
}

/** Current registrations (for the implementation and tests). */
export function menuBarItems(): MenuBarItemSpec[] {
  return [...specs.values()];
}
