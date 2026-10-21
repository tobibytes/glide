/** Glide's own status-item menu, as pure data (rendered by ../../tray.ts, rebuilt on every open). */
import type { MenuBarMenuItem } from "../../menubar";
import type { ScheduleEvent } from "../calendar/types";
import { formatClock } from "../timers/model";
import { clockTime, sep, timerRows, truncate, untilLabel, type TimerActions, type TimersInput } from "./extras/specs";

export interface RecentCommand {
  id: string;
  title: string;
  icon?: string;
}

export interface FocusInfo {
  goal: string;
  status: "running" | "paused";
  remainingMs: number;
}

export interface MainMenuInput {
  now: number;
  hotkey?: string;
  recent: RecentCommand[];
  timers?: Pick<TimersInput, "timers" | "stopwatches">;
  nextEvent?: ScheduleEvent;
  focus?: FocusInfo | null;
}

export interface MainMenuActions {
  open(): void;
  run(itemId: string): void;
  timer: TimerActions;
  join(url: string): void;
  openCalendar(iso: string): void;
  focusToggle(): void;
  focusStop(): void;
  focusShow(): void;
  settings(): void;
  menuBarSettings(): void;
  quit(): void;
}

export function buildMainMenu(input: MainMenuInput, a: MainMenuActions): MenuBarMenuItem[] {
  const menu: MenuBarMenuItem[] = [{ title: "Open Glide", ...(input.hotkey ? { shortcut: input.hotkey } : {}), onClick: a.open }];

  if (input.recent.length) {
    menu.push(sep, { title: "Recent", enabled: false });
    for (const r of input.recent.slice(0, 5)) menu.push({ title: truncate(r.title, 40), ...(r.icon ? { icon: r.icon } : {}), onClick: () => a.run(r.id) });
  }

  const timerItems = input.timers ? timerRows(input.timers, input.now, a.timer, true) : [];
  const status: MenuBarMenuItem[] = [...timerItems];
  const e = input.nextEvent;
  if (e) {
    const link = e.meeting;
    status.push({
      title: `${truncate(e.title || "Event", 32)} ${untilLabel(Date.parse(e.start), input.now)}`,
      subtitle: `${clockTime(Date.parse(e.start))}${link ? ` · Join ${link.provider}` : ""}`,
      icon: link ? "📹" : "📅",
      onClick: link ? () => a.join(link.url) : () => a.openCalendar(e.start),
    });
  }
  const f = input.focus;
  if (f) {
    status.push({
      title: `${f.goal ? `Focus: ${truncate(f.goal, 28)}` : "Focus Session"} — ${formatClock(f.remainingMs)} left`,
      subtitle: f.status === "paused" ? "Paused" : "Running",
      icon: "◷",
      submenu: [
        { title: f.status === "paused" ? "Resume" : "Pause", onClick: a.focusToggle },
        { title: "Stop Session", onClick: a.focusStop },
        sep,
        { title: "Show Focus…", onClick: a.focusShow },
      ],
    });
  }
  if (status.length) menu.push(sep, ...status);

  menu.push(
    sep,
    { title: "Settings…", shortcut: "CommandOrControl+,", onClick: a.settings },
    { title: "Menu Bar Settings…", onClick: a.menuBarSettings },
    sep,
    { title: "Quit Glide", shortcut: "CommandOrControl+Q", onClick: a.quit },
  );
  return menu;
}

/** Top `limit` usage records by decayed frecency score, resolved to catalogue items. */
export function topRecent<R extends { itemId: string }>(records: R[], score: (r: R) => number, resolve: (id: string) => RecentCommand | undefined, limit = 5): RecentCommand[] {
  const out: RecentCommand[] = [];
  for (const r of [...records].sort((x, y) => score(y) - score(x))) {
    if (out.length >= limit) break;
    const item = resolve(r.itemId);
    if (item) out.push(item);
  }
  return out;
}
