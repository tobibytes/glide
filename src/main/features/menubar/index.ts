/**
 * Menu-bar mode: renders every registerMenuBarItem() registration as its own status item, runs the
 * built-in extras (Timers, System Monitor, Next Meeting, Clipboard, Glide Agent; toggled in
 * Settings → Menu Bar) and supplies the content of Glide's own status-item menu.
 */
import { app } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import type { MenuBarMenuItem } from "../../menubar";
import { decode, frecencyDateFromRecord } from "@engine/frecency";
import { HEADLESS } from "../../headless";
import { activateMenuBar, clickMenuBarItem, deactivateMenuBar, menuBarState } from "../../menubar";
import { mainMenu, setMainMenuProvider, setTrayTitleHandler, trayFindItem, trayTitleState } from "../../tray";
import type { FeatureContext, FeatureModule } from "../types";
import { feature as calendarFeature } from "../calendar";
import { feature as focusFeature } from "../focus";
import type { FocusState } from "../focus/types";
import { electronTrayFactory } from "./electron-tray";
import { stripMenu } from "./core";
import { buildMainMenu, topRecent, type RecentCommand } from "./main-menu";
import { cachedSchedule, callFeature, createExtras, EXTRAS, isExtraId, refreshSchedule, timerActions, timersState, type ExtraId } from "./extras/runtime";
import { nextEvent } from "./extras/specs";

const ID = "menubar";
export type MenuBarSettings = Record<ExtraId, boolean>;
const DEFAULTS = Object.fromEntries(EXTRAS.map((e) => [e.id, e.defaultOn])) as MenuBarSettings;

export interface MenuBarSettingsState {
  extras: Array<{ id: ExtraId; title: string; description: string; icon: string; enabled: boolean }>;
}

let ctx: FeatureContext | undefined;
let extras: ReturnType<typeof createExtras> | undefined;
let enabled: MenuBarSettings = { ...DEFAULTS };
let scheduleTimer: NodeJS.Timeout | undefined;

function readSettings(): MenuBarSettings {
  const raw = ctx?.settings(DEFAULTS as unknown as Record<string, unknown>) ?? {};
  return Object.fromEntries(EXTRAS.map((e) => [e.id, typeof raw[e.id] === "boolean" ? (raw[e.id] as boolean) : e.defaultOn])) as MenuBarSettings;
}

function settingsState(): MenuBarSettingsState {
  return { extras: EXTRAS.map((e) => ({ id: e.id, title: e.title, description: e.description, icon: e.icon, enabled: enabled[e.id] })) };
}

function apply(next: MenuBarSettings): void {
  for (const e of EXTRAS) {
    if (next[e.id] === enabled[e.id] && extras) continue;
    if (next[e.id]) extras?.runtimes[e.id].start();
    else extras?.runtimes[e.id].stop();
  }
  enabled = next;
  // Re-route the timers countdown: on the Timers extra when enabled, else next to the Glide icon.
  setTrayTitleHandler((title) => {
    extras?.timersTitle(title);
    return enabled.timers;
  });
  ctx?.emit("settings", settingsState());
  ctx?.refreshCatalogue();
}

function setSettings(patch: unknown): MenuBarSettingsState {
  if (!patch || typeof patch !== "object") return settingsState();
  const clean: Partial<MenuBarSettings> = {};
  for (const [k, v] of Object.entries(patch)) if (isExtraId(k) && typeof v === "boolean") clean[k] = v;
  ctx?.setSettings(clean);
  apply({ ...enabled, ...clean });
  return settingsState();
}

// --- Glide's own menu -------------------------------------------------------------------------------

function recentCommands(): RecentCommand[] {
  if (!ctx) return [];
  const nowSec = Date.now() / 1000;
  return topRecent(
    ctx.store.getUsage(),
    (r) => decode(frecencyDateFromRecord(r), nowSec),
    (id) => {
      const item = trayFindItem(id);
      if (!item || item.data?.noUsage || item.kind === "fallback") return undefined;
      return { id: item.id, title: item.title, ...(item.icon?.kind === "emoji" ? { icon: item.icon.value } : {}) };
    },
  );
}

function buildGlideMenu() {
  const c = ctx!;
  const timers = timersState();
  const focus = callFeature<FocusState>(focusFeature, "state");
  const schedule = cachedSchedule();
  void refreshSchedule(); // fresh for the next open; this one uses the cache
  return buildMainMenu(
    {
      now: Date.now(),
      hotkey: c.getGlobalSettings().hotkey,
      recent: recentCommands(),
      ...(timers ? { timers } : {}),
      ...(schedule?.status === "ok" ? { nextEvent: nextEvent(schedule.events, Date.now()) } : {}),
      focus: focus?.session ? { goal: focus.session.goal, status: focus.session.status, remainingMs: focus.remainingMs } : null,
    },
    {
      open: c.showLauncher,
      run: (id) => void c.executeItem(id),
      timer: timerActions(c),
      join: (url) => void callFeature(calendarFeature, "join", url),
      openCalendar: () => c.openView({ id: "calendar.schedule" }),
      focusToggle: () => void callFeature(focusFeature, "togglePause"),
      focusStop: () => void callFeature(focusFeature, "stop"),
      focusShow: () => c.openView({ id: "focus.stats" }),
      settings: () => c.openSettings(),
      menuBarSettings: () => c.openSettings(ID),
      quit: () => app.quit(),
    },
  );
}

// --- launcher items -----------------------------------------------------------------------------------

function items(): SearchItem[] {
  const base = (id: string, title: string, subtitle: string, icon: string, keywords: string[], data: Record<string, unknown>): SearchItem => ({
    id: `menubar:${id}`,
    kind: "command",
    kindLabel: "Menu Bar",
    title,
    subtitle,
    icon: { kind: "emoji", value: icon },
    keywords: ["menu bar", "menubar", "status", ...keywords],
    feature: ID,
    data,
  });
  return [
    base("settings", "Menu Bar Settings", "Choose which extras appear in the menu bar", "🧭", ["extras", "tray"], { action: "settings" }),
    ...EXTRAS.map((e) =>
      base(`toggle:${e.id}`, `${enabled[e.id] ? "Hide" : "Show"} ${e.title} in Menu Bar`, e.description, e.icon, [e.title.toLowerCase(), "toggle"], { action: "toggle", extra: e.id }),
    ),
  ];
}

const isPath = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0);

function clickPath(menu: MenuBarMenuItem[], path: number[]): boolean {
  let items: MenuBarMenuItem[] | undefined = menu;
  let item: MenuBarMenuItem | undefined;
  for (const i of path) {
    item = items?.[i];
    items = item?.submenu;
  }
  if (!item?.onClick) return false;
  item.onClick();
  return true;
}

export const feature: FeatureModule = {
  id: ID,
  start(c) {
    ctx = c;
    // Headless: never create status items; keep state for tests (`menubar.state`).
    activateMenuBar(HEADLESS ? null : electronTrayFactory);
    extras = createExtras(c);
    enabled = Object.fromEntries(EXTRAS.map((e) => [e.id, false])) as MenuBarSettings;
    apply(readSettings());
    setMainMenuProvider(buildGlideMenu);
    void refreshSchedule();
    scheduleTimer = setInterval(() => void refreshSchedule(), 5 * 60_000);
  },
  stop() {
    clearInterval(scheduleTimer);
    for (const e of EXTRAS) extras?.runtimes[e.id].stop();
    setMainMenuProvider(undefined);
    setTrayTitleHandler(undefined);
    deactivateMenuBar();
  },
  items,
  actions(item): ItemAction[] {
    if (item.data?.action === "toggle") return [{ id: "toggle", title: "Toggle", shortcut: "⏎" }, { id: "settings", title: "Menu Bar Settings", shortcut: "⌘⏎" }];
    return [{ id: "settings", title: "Open Menu Bar Settings", shortcut: "⏎" }];
  },
  async runAction(scored, actionId): Promise<ExecuteResult> {
    if (actionId === "settings") return { ok: true, navigate: `settings/${ID}` };
    const extra = scored.item.data?.extra;
    if (actionId === "toggle" && isExtraId(extra)) {
      const on = !enabled[extra];
      setSettings({ [extra]: on });
      return { ok: true, message: `${EXTRAS.find((e) => e.id === extra)?.title} ${on ? "shown in" : "removed from"} the menu bar` };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    getSettings: () => settingsState(),
    setSettings: (patch) => setSettings(patch),
    // Test hooks, only in headless runs.
    ...(HEADLESS
      ? {
          state: () => ({ items: menuBarState(), glide: { ...trayTitleState(), menu: stripMenu(mainMenu()) } }),
          click: (id: unknown, path: unknown) =>
            typeof id === "string" && isPath(path) ? (id === "glide" ? clickPath(mainMenu(), path) : clickMenuBarItem(id, path)) : false,
        }
      : {}),
  },
};
