import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { NavAction, NavItem, ViewProps } from "../types";
import { glide } from "../../lib/glide";
import { NavList } from "../../components/NavList";
import { dayKeys, isJoinable, startsInLabel } from "../../../main/features/calendar/links";
import type { ScheduleEvent, ScheduleResult } from "../../../main/features/calendar/types";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("calendar", method, ...args);

type Row = NavItem & ({ kind: "event"; event: ScheduleEvent; day: number } | { kind: "grant" } | { kind: "settings" } | { kind: "retry" } | { kind: "empty" });

function dayTitle(day: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today.getTime()) / 86_400_000);
  const label = new Date(day).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  return diff === 0 ? `Today · ${label}` : diff === 1 ? `Tomorrow · ${label}` : label;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function timeRange(e: ScheduleEvent, day: number): string {
  if (e.allDay) return "All day";
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  const startsToday = start >= day;
  const endsToday = end <= day + 86_400_000;
  return `${startsToday ? fmtTime(e.start) : "…"} – ${endsToday ? fmtTime(e.end) : "…"}`;
}

export function Schedule({ query, setPlaceholder, close, toast }: ViewProps) {
  const [res, setRes] = useState<ScheduleResult | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => void call<ScheduleResult>("schedule").then(setRes), []);
  useEffect(() => {
    setPlaceholder("Search events…");
    load();
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [load, setPlaceholder]);

  const rows = useMemo((): Row[] => {
    if (!res) return [];
    if (res.status === "denied" || res.status === "restricted") return [{ id: "settings", kind: "settings" }, { id: "retry", kind: "retry" }];
    if (res.status === "notDetermined") return [{ id: "grant", kind: "grant" }];
    if (res.status !== "ok") return [{ id: "retry", kind: "retry" }];
    const q = query.trim().toLowerCase();
    const from = Date.parse(res.from);
    const to = Date.parse(res.to);
    const list: Row[] = [];
    for (const e of res.events) {
      if (Date.parse(e.end) <= now && !e.allDay) continue; // finished today
      if (q && !`${e.title} ${e.location ?? ""} ${e.calendar}`.toLowerCase().includes(q)) continue;
      for (const day of dayKeys(e, from, to)) list.push({ id: `${e.id}@${day}`, section: dayTitle(day), kind: "event", event: e, day });
    }
    list.sort((a, b) => (a.kind === "event" && b.kind === "event" ? a.day - b.day || Number(b.event.allDay) - Number(a.event.allDay) || Date.parse(a.event.start) - Date.parse(b.event.start) : 0));
    return list.length ? list : [{ id: "empty", kind: "empty" }];
  }, [res, query, now]);

  const finish = (r: ExecuteResult) => {
    if (r.error) toast(r.error, "error");
    else if (r.message) toast(r.message);
    if (r.hide) close();
  };

  const actions = (r: Row): NavAction[] => {
    if (r.kind === "grant") return [{ id: "grant", title: "Grant Calendar Access", shortcut: "⏎", run: () => void call<ScheduleResult>("requestAccess").then(setRes) }];
    if (r.kind === "settings") return [{ id: "settings", title: "Open Privacy Settings", shortcut: "⏎", run: () => void call("openPrivacySettings") }];
    if (r.kind === "retry") return [{ id: "retry", title: "Try Again", shortcut: "⏎", run: load }];
    if (r.kind !== "event") return [];
    const e = r.event;
    const list: NavAction[] = [];
    if (e.meeting) list.push({ id: "join", title: `Join ${e.meeting.provider} Meeting`, shortcut: "⏎", run: () => void call<ExecuteResult>("join", e.meeting?.url).then(finish) });
    list.push({ id: "open", title: "Open in Calendar", shortcut: "⌘⏎", run: () => void call<ExecuteResult>("openCalendar", e.start).then(finish) });
    if (e.meeting) list.push({ id: "copyLink", title: "Copy Meeting Link", shortcut: "⇧⌘C", run: () => void navigator.clipboard.writeText(e.meeting?.url ?? "").then(() => toast("Link copied")) });
    list.push({
      id: "copy",
      title: "Copy Event Details",
      shortcut: "⌘C",
      run: () => void navigator.clipboard.writeText([e.title, `${new Date(e.start).toLocaleString()} – ${fmtTime(e.end)}`, e.location, e.meeting?.url].filter(Boolean).join("\n")).then(() => toast("Copied")),
    });
    return list;
  };

  const message = res && res.status !== "ok" ? res.message : null;

  return (
    <div className="cal">
      {message && <div className={`cal__banner ${res?.status === "error" ? "cal__banner--error" : ""}`}>{message}</div>}
      <NavList<Row>
        items={rows}
        emptyText="Loading…"
        onActivate={(r, mods) => {
          const list = actions(r);
          const pick = mods.cmd ? (list.find((a) => a.shortcut === "⌘⏎") ?? list[0]) : list[0];
          void pick?.run();
        }}
        actions={actions}
        renderItem={(r, selected) => {
          const cls = `row ${selected ? "row--selected" : ""}`;
          if (r.kind === "grant" || r.kind === "settings" || r.kind === "retry") {
            const t = r.kind === "grant" ? ["🔓", "Grant Calendar Access", "macOS will ask once"] : r.kind === "settings" ? ["⚙️", "Open Privacy Settings", "Allow Glide under Privacy & Security → Calendars"] : ["🔄", "Try Again", res?.status === "no-helper" ? "Helper not running" : "Reload events"];
            return (
              <div className={cls}>
                <span className="icon icon--md">{t[0]}</span>
                <div className="row__main">
                  <span className="row__title">{t[1]}</span>
                  <span className="row__subtitle">{t[2]}</span>
                </div>
              </div>
            );
          }
          if (r.kind === "empty")
            return (
              <div className={cls}>
                <span className="icon icon--md">🌤️</span>
                <div className="row__main">
                  <span className="row__title">{query ? "No matching events" : "Nothing scheduled"}</span>
                  <span className="row__subtitle">Next 7 days</span>
                </div>
              </div>
            );
          const e = r.event;
          const live = isJoinable(e, now, 0);
          const soon = !live && isJoinable(e, now);
          return (
            <div className={`${cls} cal__row ${live ? "cal__row--live" : ""}`}>
              <span className="cal__dot" style={{ background: e.color ?? "var(--accent)" }} aria-hidden="true" />
              <span className="cal__time">{timeRange(e, r.day)}</span>
              <div className="row__main">
                <span className="row__title">{e.title}</span>
                {e.location && !e.meeting?.url.includes(e.location) && <span className="row__subtitle">{e.location}</span>}
              </div>
              <div className="row__right">
                {(live || soon) && <span className="cal__now">{startsInLabel(e, now)}</span>}
                {e.meeting && <span className="tag tag--accent">{e.meeting.provider}</span>}
                <span className="row__kind">{e.calendar}</span>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
