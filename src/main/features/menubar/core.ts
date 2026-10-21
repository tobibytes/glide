/**
 * Menu-bar item manager (pure, no Electron): keeps every registered spec, renders each one through a
 * TrayFactory, diffs updates field by field, and throttles re-renders per item. Click handlers are
 * dispatched by menu path from the *latest* spec, so a closure-only change never rebuilds the menu.
 */
import type { MenuBarHandle, MenuBarItemSpec, MenuBarMenuItem } from "../../menubar";

/** What a rendered status item can do. The Electron adapter lives in ./electron-tray.ts. */
export interface TrayHandle {
  setTitle(title: string): void;
  setIcon(icon: string | undefined): void;
  setTooltip(tooltip: string): void;
  /** Items arrive with stable onClick wrappers. */
  setMenu(menu: MenuBarMenuItem[]): void;
  destroy(): void;
}
export type TrayFactory = (id: string) => TrayHandle;

/** A menu item without functions, as exposed to tests and the headless debug method. */
export interface MenuItemState {
  title?: string;
  subtitle?: string;
  icon?: string;
  shortcut?: string;
  enabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  clickable?: boolean;
  submenu?: MenuItemState[];
}

export interface MenuBarItemState {
  id: string;
  title: string;
  icon?: string;
  tooltip?: string;
  menu: MenuItemState[];
  /** true when a real status item exists (never in headless mode). */
  rendered: boolean;
  /** How often each part was pushed to the tray (diffing keeps these low). */
  renders: { title: number; icon: number; tooltip: number; menu: number };
}

export interface MenuBarManager {
  register(spec: MenuBarItemSpec): MenuBarHandle;
  items(): MenuBarItemSpec[];
  /** Start rendering through `factory` (null = keep state only, e.g. headless). */
  activate(factory: TrayFactory | null): void;
  /** Destroy every rendered item (specs are kept). */
  deactivate(): void;
  state(): MenuBarItemState[];
  /** Invoke the click handler at `path` (indices into menu / submenus). */
  click(id: string, path: number[]): boolean;
  /** Apply pending throttled updates now. */
  flush(): void;
}

interface Entry {
  spec: MenuBarItemSpec;
  tray?: TrayHandle;
  applied: { title?: string; icon?: string; tooltip?: string; menuKey?: string };
  handlers: Map<string, () => void>;
  lastApply: number;
  timer?: ReturnType<typeof setTimeout>;
  renders: MenuBarItemState["renders"];
}

export const DEFAULT_THROTTLE_MS = 250; // ≤ 4 renders per second per item

export function stripMenu(items: MenuBarMenuItem[]): MenuItemState[] {
  return items.map((m) => {
    const out: MenuItemState = {};
    if (m.separator) return { separator: true };
    if (m.title !== undefined) out.title = m.title;
    if (m.subtitle !== undefined) out.subtitle = m.subtitle;
    if (m.icon !== undefined) out.icon = m.icon;
    if (m.shortcut !== undefined) out.shortcut = m.shortcut;
    if (m.enabled !== undefined) out.enabled = m.enabled;
    if (m.checked !== undefined) out.checked = m.checked;
    if (m.onClick) out.clickable = true;
    if (m.submenu) out.submenu = stripMenu(m.submenu);
    return out;
  });
}

/** Structural key of a menu: equal keys mean the native menu does not need rebuilding. */
export const menuKey = (items: MenuBarMenuItem[]): string => JSON.stringify(stripMenu(items));

function collectHandlers(items: MenuBarMenuItem[], prefix: string, out: Map<string, () => void>): void {
  items.forEach((m, i) => {
    const p = prefix ? `${prefix}.${i}` : String(i);
    if (m.onClick) out.set(p, m.onClick);
    if (m.submenu) collectHandlers(m.submenu, p, out);
  });
}

function wrapMenu(items: MenuBarMenuItem[], prefix: string, handlers: Map<string, () => void>): MenuBarMenuItem[] {
  return items.map((m, i) => {
    const p = prefix ? `${prefix}.${i}` : String(i);
    const { onClick, submenu, ...rest } = m;
    const out: MenuBarMenuItem = { ...rest };
    if (onClick) out.onClick = () => handlers.get(p)?.();
    if (submenu) out.submenu = wrapMenu(submenu, p, handlers);
    return out;
  });
}

export function createMenuBarManager(opts: { throttleMs?: number; now?: () => number; onError?: (err: unknown) => void } = {}): MenuBarManager {
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let factory: TrayFactory | null = null;
  let active = false;

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const apply = (e: Entry) => {
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    e.lastApply = now();
    if (!active) return;
    if (factory && !e.tray) guard(() => (e.tray = factory!(e.spec.id)));
    const t = e.tray;
    const title = e.spec.title ?? "";
    if (title !== (e.applied.title ?? "")) {
      e.applied.title = title;
      e.renders.title++;
      if (t) guard(() => t.setTitle(title));
    }
    if (e.spec.icon !== e.applied.icon || e.renders.icon === 0) {
      e.applied.icon = e.spec.icon;
      e.renders.icon++;
      if (t) guard(() => t.setIcon(e.spec.icon));
    }
    const tooltip = e.spec.tooltip ?? "";
    if (tooltip !== (e.applied.tooltip ?? "")) {
      e.applied.tooltip = tooltip;
      e.renders.tooltip++;
      if (t) guard(() => t.setTooltip(tooltip));
    }
    const key = menuKey(e.spec.menu);
    if (key !== e.applied.menuKey) {
      e.applied.menuKey = key;
      e.renders.menu++;
      if (t) guard(() => t.setMenu(wrapMenu(e.spec.menu, "", e.handlers)));
    }
  };

  const schedule = (e: Entry) => {
    if (e.timer) return; // a trailing render is already queued; it will pick up the latest spec
    const wait = e.lastApply + throttleMs - now();
    if (wait <= 0) apply(e);
    else e.timer = setTimeout(() => apply(e), wait);
  };

  const setSpec = (e: Entry, spec: MenuBarItemSpec) => {
    e.spec = spec;
    e.handlers.clear();
    collectHandlers(spec.menu, "", e.handlers);
  };

  const destroy = (e: Entry) => {
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    if (e.tray) guard(() => e.tray!.destroy());
    e.tray = undefined;
    e.applied = {};
    e.renders = { title: 0, icon: 0, tooltip: 0, menu: 0 };
  };

  return {
    register(spec) {
      const id = spec.id;
      let e = entries.get(id);
      if (!e) {
        e = { spec, applied: {}, handlers: new Map(), lastApply: Number.NEGATIVE_INFINITY, renders: { title: 0, icon: 0, tooltip: 0, menu: 0 } };
        entries.set(id, e);
      }
      setSpec(e, { ...spec, menu: spec.menu ?? [] });
      schedule(e);
      const mine = e;
      return {
        update(next) {
          // A removed (or replaced-then-removed) registration stays removed.
          if (entries.get(id) !== mine) return;
          setSpec(mine, { ...next, menu: next.menu ?? [], id });
          schedule(mine);
        },
        remove() {
          if (entries.get(id) !== mine) return;
          destroy(mine);
          entries.delete(id);
        },
      };
    },
    items: () => [...entries.values()].map((e) => e.spec),
    activate(f) {
      factory = f;
      active = true;
      for (const e of entries.values()) apply(e);
    },
    deactivate() {
      active = false;
      for (const e of entries.values()) destroy(e);
    },
    state: () =>
      [...entries.values()].map((e) => ({
        id: e.spec.id,
        title: e.spec.title ?? "",
        ...(e.spec.icon ? { icon: e.spec.icon } : {}),
        ...(e.spec.tooltip ? { tooltip: e.spec.tooltip } : {}),
        menu: stripMenu(e.spec.menu),
        rendered: !!e.tray,
        renders: { ...e.renders },
      })),
    click(id, path) {
      const fn = entries.get(id)?.handlers.get(path.join("."));
      if (!fn) return false;
      fn();
      return true;
    },
    flush() {
      for (const e of entries.values()) if (e.timer) apply(e);
    },
  };
}
