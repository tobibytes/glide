import { useCallback, useEffect, useMemo } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import {
  formatClock, formatDuration, formatStopwatch, lapSplits, parseDurationAndName, stopwatchElapsed, timerEndsAt, timerLabel, timerRemaining,
  type Preset, type Stopwatch, type Timer,
} from "../../../main/features/timers/model";
import { timersCall, useTimers, type ExecuteResult } from "./common";

type Row = NavItem &
  (
    | { kind: "new"; ms: number; name: string }
    | { kind: "timer"; t: Timer }
    | { kind: "stopwatch"; s: Stopwatch }
    | { kind: "preset"; p: Preset }
    | { kind: "newStopwatch"; name: string }
  );

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function TimersView({ props, query, setQuery, setPlaceholder, toast }: ViewProps<{ query?: string; select?: string }>) {
  const [state, now] = useTimers();
  useEffect(() => setPlaceholder("Type a duration (25m, 1h30m tea, 5:00) or search timers…"), [setPlaceholder]);
  useEffect(() => {
    if (props.query) setQuery(props.query);
  }, [props.query, setQuery]);

  const say = useCallback((r: ExecuteResult) => toast(r.error ?? r.message ?? "", r.ok ? "info" : "error"), [toast]);
  const call = useCallback((method: string, ...args: unknown[]) => void timersCall<ExecuteResult>(method, ...args).then(say), [say]);

  const parsed = useMemo(() => parseDurationAndName(query), [query]);
  const rows = useMemo((): Row[] => {
    if (!state) return [];
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || !!parsed || s.toLowerCase().includes(q);
    const out: Row[] = [];
    if (parsed) out.push({ id: "new", section: "Start", kind: "new", ms: parsed.ms, name: parsed.name });
    for (const t of state.timers) if (match(timerLabel(t))) out.push({ id: t.id, section: "Running Timers", kind: "timer", t });
    for (const s of state.stopwatches) if (match(s.name || "stopwatch")) out.push({ id: s.id, section: "Stopwatches", kind: "stopwatch", s });
    if (!parsed) {
      if (!q || "stopwatch".includes(q) || "new stopwatch".includes(q)) out.push({ id: "new-sw", section: "Stopwatches", kind: "newStopwatch", name: "" });
      else out.push({ id: "new-sw", section: "Stopwatches", kind: "newStopwatch", name: query.trim() });
    }
    for (const p of state.presets) if (!parsed && match(p.name)) out.push({ id: `preset-${p.id}`, section: "Presets", kind: "preset", p });
    return out;
  }, [state, query, parsed]);

  const actions = useCallback(
    (r: Row): NavAction[] => {
      switch (r.kind) {
        case "new":
          return [
            { id: "start", title: "Start Timer", shortcut: "⏎", run: () => (call("start", r.ms, r.name), setQuery("")) },
            { id: "preset", title: "Save as Preset", shortcut: "⌘⏎", run: () => call("savePreset", r.name, r.ms) },
          ];
        case "timer":
          return [
            { id: "toggle", title: r.t.pausedAt === null ? "Pause" : "Resume", shortcut: "⏎", run: () => call("toggle", r.t.id) },
            { id: "plus1", title: "Add 1 Minute", shortcut: "⌘⏎", run: () => call("add", r.t.id, 60_000) },
            { id: "plus5", title: "Add 5 Minutes", shortcut: "⌘5", run: () => call("add", r.t.id, 300_000) },
            { id: "restart", title: "Restart", shortcut: "⌘R", run: () => call("restart", r.t.id) },
            { id: "save", title: "Save as Preset", shortcut: "⌘S", run: () => call("savePreset", r.t.name, r.t.durationMs) },
            { id: "stop", title: "Stop Timer", shortcut: "⌃X", destructive: true, run: () => call("stop", r.t.id) },
          ];
        case "stopwatch":
          return [
            { id: "lap", title: "Lap", shortcut: "⏎", run: () => call("lap", r.s.id) },
            { id: "toggle", title: r.s.pausedAt === null ? "Pause" : "Resume", shortcut: "⌘⏎", run: () => call("stopwatchToggle", r.s.id) },
            { id: "reset", title: "Reset", shortcut: "⌘R", run: () => call("stopwatchReset", r.s.id) },
            {
              id: "copy",
              title: "Copy Laps",
              shortcut: "⇧⌘C",
              run: () => {
                const lines = lapSplits(r.s).map((ms, i) => `Lap ${i + 1}\t${formatStopwatch(ms)}\t${formatStopwatch(r.s.laps[i]!)}`);
                void navigator.clipboard.writeText([...lines, `Total\t${formatStopwatch(stopwatchElapsed(r.s, Date.now()))}`].join("\n")).then(() => toast("Laps copied"));
              },
            },
            { id: "remove", title: "Remove Stopwatch", shortcut: "⌃X", destructive: true, run: () => call("stopwatchRemove", r.s.id) },
          ];
        case "newStopwatch":
          return [{ id: "sw", title: "Start Stopwatch", shortcut: "⏎", run: () => (call("stopwatchStart", r.name), setQuery("")) }];
        case "preset":
          return [
            { id: "start", title: `Start ${formatDuration(r.p.durationMs)} Timer`, shortcut: "⏎", run: () => call("startPreset", r.p.id) },
            { id: "delete", title: "Delete Preset", shortcut: "⌃X", destructive: true, run: () => call("deletePreset", r.p.id) },
            { id: "reset", title: "Restore Default Presets", run: () => call("resetPresets") },
          ];
      }
    },
    [call, setQuery, toast],
  );

  const detail = (r: Row) => {
    if (r.kind !== "stopwatch" || !r.s.laps.length) return null;
    const splits = lapSplits(r.s);
    const best = Math.min(...splits);
    const worst = Math.max(...splits);
    return (
      <div className="timers-laps">
        <div className="timers-laps__total mono">{formatStopwatch(stopwatchElapsed(r.s, now))}</div>
        <ol className="timers-laps__list">
          {splits
            .map((ms, i) => (
              <li key={i} className={splits.length > 1 && ms === best ? "is-best" : splits.length > 1 && ms === worst ? "is-worst" : ""}>
                <span>Lap {i + 1}</span>
                <span className="mono">{formatStopwatch(ms)}</span>
                <span className="mono faint">{formatStopwatch(r.s.laps[i]!)}</span>
              </li>
            ))
            .reverse()}
        </ol>
      </div>
    );
  };
  const hasLaps = rows.some((r) => r.kind === "stopwatch" && r.s.laps.length > 0);

  if (!state) return <div className="navlist__empty">Loading…</div>;
  return (
    <div className="timers-view">
      <NavList<Row>
        items={rows}
        actions={actions}
        detail={hasLaps ? detail : undefined}
        emptyText="No timers match. Type a duration like 25m to start one."
        onActivate={(r, m) => {
          const a = actions(r);
          void (m.cmd ? (a.find((x) => x.shortcut === "⌘⏎") ?? a[0]) : a[0])?.run();
        }}
        renderItem={(r, selected) => {
          const cls = `row timers-row ${selected ? "row--selected" : ""}`;
          if (r.kind === "new")
            return (
              <div className={cls}>
                <span className="icon icon--md">▶️</span>
                <div className="row__main">
                  <span className="row__title">Start {formatDuration(r.ms)} Timer{r.name ? ` “${r.name}”` : ""}</span>
                  <span className="row__subtitle">Ends around {time(Date.now() + r.ms)}</span>
                </div>
                <span className="row__kind">⏎ start · ⌘⏎ save preset</span>
              </div>
            );
          if (r.kind === "timer") {
            const left = timerRemaining(r.t, now);
            const pct = Math.min(100, Math.max(0, 100 - (left / r.t.durationMs) * 100));
            return (
              <div className={cls}>
                <span className="icon icon--md">{r.t.pausedAt === null ? "⏱️" : "⏸️"}</span>
                <div className="row__main">
                  <span className="row__title">{timerLabel(r.t)}</span>
                  <span className="row__subtitle">{r.t.pausedAt === null ? `Ends ${time(timerEndsAt(r.t))}` : "Paused"} · {formatDuration(r.t.durationMs)}</span>
                </div>
                <span className="timers-progress" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="timers-clock mono">{formatClock(left)}</span>
              </div>
            );
          }
          if (r.kind === "stopwatch")
            return (
              <div className={cls}>
                <span className="icon icon--md">{r.s.pausedAt === null ? "⏱️" : "⏸️"}</span>
                <div className="row__main">
                  <span className="row__title">{r.s.name || "Stopwatch"}</span>
                  <span className="row__subtitle">
                    {r.s.laps.length} lap{r.s.laps.length === 1 ? "" : "s"} · ⏎ lap · ⌘⏎ {r.s.pausedAt === null ? "pause" : "resume"}
                  </span>
                </div>
                <span className="timers-clock mono">{formatStopwatch(stopwatchElapsed(r.s, now))}</span>
              </div>
            );
          if (r.kind === "newStopwatch")
            return (
              <div className={cls}>
                <span className="icon icon--md">➕</span>
                <div className="row__main">
                  <span className="row__title">Start Stopwatch{r.name ? ` “${r.name}”` : ""}</span>
                </div>
              </div>
            );
          return (
            <div className={cls}>
              <span className="icon icon--md">⏲️</span>
              <div className="row__main">
                <span className="row__title">{r.p.name}</span>
                <span className="row__subtitle">{formatDuration(r.p.durationMs)}</span>
              </div>
              {selected && <span className="row__kind">⏎ start · ⌃X delete</span>}
            </div>
          );
        }}
      />
    </div>
  );
}
