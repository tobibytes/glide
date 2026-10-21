import { clipboard, shell } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import type { ScoredItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { exec, osascript } from "../../util/exec";
import { isJoinable, matchesJoinQuery, meetingLinkFor, startsInLabel } from "./links";
import type { ScheduleEvent, ScheduleResult } from "./types";

const REFRESH_MS = 60_000;
const DAYS = 8; // today + the next 7 days

let ctx: FeatureContext | undefined;
let cache: ScheduleEvent[] = [];
let cacheAt = 0;
let refreshing: Promise<ScheduleResult> | null = null;
let timer: NodeJS.Timeout | undefined;

function windowRange(now = new Date()): { from: Date; to: Date } {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + DAYS);
  return { from, to };
}

async function fetchSchedule(): Promise<ScheduleResult> {
  const { from, to } = windowRange();
  const base = { from: from.toISOString(), to: to.toISOString(), events: [] as ScheduleEvent[] };
  if (!ctx?.helper.available()) return { ...base, status: "no-helper", message: "Calendar access needs the Glide helper, which isn’t running. Rebuild or reinstall Glide to enable My Schedule." };
  try {
    const perms = await ctx.helper.call("permissions.status");
    if (perms.calendar !== "authorized") return { ...base, status: perms.calendar === "notDetermined" ? "notDetermined" : perms.calendar, message: "Glide needs permission to read your calendars." };
    const raw = await ctx.helper.call("calendar.events", { from: base.from, to: base.to });
    const events = raw
      .map((e): ScheduleEvent => ({ ...e, meeting: meetingLinkFor(e) }))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Number(b.allDay) - Number(a.allDay));
    cache = events;
    cacheAt = Date.now();
    return { ...base, status: "ok", events };
  } catch (err) {
    return { ...base, status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function refresh(): Promise<ScheduleResult> {
  if (!refreshing) refreshing = fetchSchedule().finally(() => (refreshing = null));
  return refreshing;
}

async function openCalendarAt(iso: string): Promise<ExecuteResult> {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid date" };
  // AppleScript's date parsing is locale-dependent; set components on `current date` instead.
  const script = `set d to current date
set year of d to ${d.getFullYear()}
set month of d to ${d.getMonth() + 1}
set day of d to ${d.getDate()}
set hours of d to ${d.getHours()}
set minutes of d to ${d.getMinutes()}
tell application "Calendar"
  activate
  switch view to day view
  view calendar at d
end tell`;
  try {
    await osascript(script, { timeoutMs: 8_000 });
  } catch {
    // Without Automation permission just bring Calendar forward.
    await exec("open", ["-a", "Calendar"], { timeoutMs: 8_000 });
  }
  return { ok: true, hide: true };
}

async function join(url: string): Promise<ExecuteResult> {
  await shell.openExternal(url);
  return { ok: true, hide: true };
}

export const feature: FeatureModule = {
  id: "calendar",
  start(c) {
    ctx = c;
    // Cheap when the helper is missing; keeps "Join …" items fresh.
    void refresh();
    timer = setInterval(() => void refresh(), REFRESH_MS);
  },
  stop() {
    clearInterval(timer);
  },
  items: () => [
    {
      id: "calendar:schedule",
      kind: "command",
      kindLabel: "Calendar",
      title: "My Schedule",
      subtitle: "Calendar",
      icon: { kind: "emoji", value: "📅" },
      keywords: ["calendar", "events", "agenda", "meetings", "today", "upcoming"],
      feature: "calendar",
      data: { action: "schedule" },
    },
  ],
  dynamicItems(query): ScoredItem[] {
    if (!matchesJoinQuery(query)) return [];
    if (Date.now() - cacheAt > REFRESH_MS) void refresh();
    const now = Date.now();
    return cache
      .filter((e) => e.meeting && isJoinable(e, now))
      .slice(0, 3)
      .map((e, i): ScoredItem => ({
        item: {
          id: `calendar:join:${e.id}`,
          kind: "command",
          kindLabel: e.meeting?.provider ?? "Meeting",
          title: `Join ${e.title}`,
          subtitle: `${startsInLabel(e, now)} · ${e.meeting?.provider}`,
          icon: { kind: "emoji", value: "📹" },
          keywords: ["join", "meet", "meeting", "call", query.trim()].filter(Boolean),
          feature: "calendar",
          data: { action: "join", url: e.meeting?.url ?? "", start: e.start, noUsage: true },
        },
        score: 1_000 - i,
        matchScore: 1_000 - i,
        matchKind: "keyword",
        frecency: 0,
        ranges: [],
      }));
  },
  actions(item) {
    if (item.data?.action === "join")
      return [
        { id: "join", title: "Join Meeting", shortcut: "⏎" },
        { id: "openCalendar", title: "Open in Calendar", shortcut: "⌘⏎" },
        { id: "copyLink", title: "Copy Meeting Link", shortcut: "⇧⌘C" },
      ];
    return [{ id: "schedule", title: "Show Schedule", shortcut: "⏎" }];
  },
  async runAction(scored, actionId) {
    const d = scored.item.data ?? {};
    if (actionId === "schedule") return { ok: true, view: { id: "calendar.schedule" } };
    if (actionId === "join" && typeof d.url === "string" && d.url) return join(d.url);
    if (actionId === "openCalendar" && typeof d.start === "string") return openCalendarAt(d.start);
    if (actionId === "copyLink" && typeof d.url === "string") {
      clipboard.writeText(d.url);
      return { ok: true, message: "Link copied" };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    schedule: () => refresh(),
    requestAccess: async () => {
      if (!ctx?.helper.available()) return refresh();
      try {
        await ctx.helper.call("permissions.request", { kind: "calendar" });
      } catch (err) {
        ctx.log("calendar permission request failed", err);
      }
      return refresh();
    },
    openPrivacySettings: async () => {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars");
      return true;
    },
    join: (url: unknown) => (typeof url === "string" && /^(https?|zoommtg):/.test(url) ? join(url) : { ok: false, error: "Invalid meeting link" }),
    openCalendar: (iso: unknown) => (typeof iso === "string" ? openCalendarAt(iso) : { ok: false, error: "Invalid date" }),
  },
};
