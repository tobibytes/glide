import { useEffect } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { focusCall, useFocusState } from "./common";
import { formatClock, formatDuration, type FocusRecord } from "../../../main/features/focus/machine";

type Row = NavItem & ({ kind: "current" } | { kind: "record"; rec: FocusRecord } | { kind: "start" });

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function FocusStats({ setPlaceholder, push, toast }: ViewProps) {
  const [state] = useFocusState();
  useEffect(() => setPlaceholder("Focus statistics"), [setPlaceholder]);
  if (!state) return <div className="navlist__empty">Loading…</div>;
  const { stats, session } = state;
  const max = Math.max(60_000, ...stats.last7.map((d) => d.ms));

  const rows: Row[] = [
    ...(session ? [{ id: "current", section: "Now", kind: "current" as const }] : [{ id: "start", section: "Now", kind: "start" as const }]),
    ...state.recent.map((rec): Row => ({ id: rec.id, section: "Recent Sessions", kind: "record", rec })),
  ];

  const say = (res: ExecuteResult) => toast(res.error ?? res.message ?? "", res.error ? "error" : "info");
  const actions = (r: Row): NavAction[] => {
    if (r.kind === "current")
      return [
        { id: "pause", title: session?.status === "paused" ? "Resume" : "Pause", shortcut: "⏎", run: () => void focusCall<ExecuteResult>("togglePause").then(say) },
        { id: "extend", title: "Add 5 Minutes", shortcut: "⌘⏎", run: () => void focusCall<ExecuteResult>("extend", 5).then(say) },
        { id: "stop", title: "Stop Session", shortcut: "⌃X", destructive: true, run: () => void focusCall<ExecuteResult>("stop").then(say) },
      ];
    if (r.kind === "start") return [{ id: "start", title: "Start Focus Session", shortcut: "⏎", run: () => push({ id: "focus.start" }) }];
    return [{ id: "again", title: "Focus on This Again", shortcut: "⏎", run: () => push({ id: "focus.start", props: { goal: r.rec.goal } }) }];
  };

  return (
    <div className="focus-stats">
      <div className="focus-stats__cards">
        <div className="focus-stats__card">
          <span className="focus-stats__num">{formatDuration(stats.todayMs)}</span>
          <span className="focus-stats__label">Today · {stats.sessionsToday} session{stats.sessionsToday === 1 ? "" : "s"}</span>
        </div>
        <div className="focus-stats__card">
          <span className="focus-stats__num">{formatDuration(stats.weekMs)}</span>
          <span className="focus-stats__label">This week · {stats.sessionsWeek} sessions</span>
        </div>
        <div className="focus-stats__card">
          <span className="focus-stats__num">{stats.completedWeek}</span>
          <span className="focus-stats__label">Completed this week</span>
        </div>
        <div className="focus-stats__bars" aria-label="Focus time, last 7 days">
          {stats.last7.map((d) => (
            <div key={d.day} className="focus-stats__bar" title={`${new Date(d.day).toDateString()}: ${formatDuration(d.ms)}`}>
              <span style={{ height: `${Math.round((d.ms / max) * 100)}%` }} />
              <em>{DAY[new Date(d.day).getDay()][0]}</em>
            </div>
          ))}
        </div>
      </div>
      <NavList<Row>
        items={rows}
        onActivate={(r) => void actions(r)[0]?.run()}
        actions={actions}
        renderItem={(r, selected) => {
          if (r.kind === "current" && session)
            return (
              <div className={`row ${selected ? "row--selected" : ""}`}>
                <span className="icon icon--md">{session.status === "paused" ? "⏸️" : "◷"}</span>
                <div className="row__main">
                  <span className="row__title">{session.goal || "Focus session"}</span>
                  <span className="row__subtitle">
                    {formatClock(state.remainingMs)} left of {formatDuration(session.durationMs)}
                    {session.status === "paused" ? " · paused" : ""}
                  </span>
                </div>
                <span className="row__kind">⏎ pause · ⌘⏎ +5 min · ⌃X stop</span>
              </div>
            );
          if (r.kind === "record")
            return (
              <div className={`row ${selected ? "row--selected" : ""}`}>
                <span className="icon icon--md">{r.rec.completed ? "✅" : "⏹️"}</span>
                <div className="row__main">
                  <span className="row__title">{r.rec.goal || "Focus session"}</span>
                  <span className="row__subtitle">
                    {formatDuration(r.rec.focusedMs)} of {formatDuration(r.rec.plannedMs)}
                  </span>
                </div>
                <span className="row__kind">{new Date(r.rec.startedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
              </div>
            );
          return (
            <div className={`row ${selected ? "row--selected" : ""}`}>
              <span className="icon icon--md">🎯</span>
              <div className="row__main">
                <span className="row__title">Start Focus Session</span>
                <span className="row__subtitle">No session running</span>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
