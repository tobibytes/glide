import { useEffect, useMemo } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { focusCall, parseDurationPrefix, useFocusState } from "./common";
import { formatClock } from "../../../main/features/focus/machine";

type Row = NavItem & ({ kind: "duration"; minutes: number; label: string } | { kind: "blocklist" } | { kind: "stop" } | { kind: "pause" });

const PRESETS = [25, 50, 90];

export function FocusStart({ props, query, setQuery, setPlaceholder, push, close, toast }: ViewProps<{ goal?: string }>) {
  const [state] = useFocusState();

  useEffect(() => {
    setPlaceholder("What do you want to focus on? (e.g. “45m write report”)");
    if (typeof props.goal === "string" && props.goal) setQuery(props.goal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = parseDurationPrefix(query);
  const goal = parsed ? parsed.goal : query.trim();
  const session = state?.session ?? null;
  const settings = state?.settings;

  const rows = useMemo((): Row[] => {
    const list: Row[] = [];
    if (session) {
      list.push({ id: "pause", section: "Current Session", kind: "pause" }, { id: "stop", section: "Current Session", kind: "stop" });
    }
    const durations = new Set<number>();
    if (parsed) durations.add(parsed.minutes);
    if (settings) durations.add(settings.defaultMinutes);
    PRESETS.forEach((p) => durations.add(p));
    for (const m of durations) list.push({ id: `d${m}`, section: session ? "Start a New Session" : "Start Focusing", kind: "duration", minutes: m, label: m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes` });
    list.push({ id: "blocklist", section: "Block List", kind: "blocklist" });
    return list;
  }, [parsed?.minutes, settings?.defaultMinutes, session !== null]);

  const finish = (res: ExecuteResult) => {
    if (res.error) toast(res.error, "error");
    else if (res.message) toast(res.message);
    if (res.hide) close();
  };

  const activate = (r: Row) => {
    if (r.kind === "duration") void focusCall<ExecuteResult>("start", goal, r.minutes).then(finish);
    else if (r.kind === "blocklist") push({ id: "focus.blocklist" });
    else if (r.kind === "stop") void focusCall<ExecuteResult>("stop").then(finish);
    else if (r.kind === "pause") void focusCall<ExecuteResult>("togglePause").then((res) => toast(res.message ?? res.error ?? ""));
  };

  const actions = (r: Row): NavAction[] => {
    const base: NavAction[] = [];
    if (r.kind === "duration") base.push({ id: "start", title: `Start ${r.label}`, shortcut: "⏎", run: () => activate(r) });
    if (r.kind === "blocklist") base.push({ id: "edit", title: "Edit Block List", shortcut: "⏎", run: () => activate(r) });
    if (r.kind === "stop") base.push({ id: "stop", title: "Stop Session", shortcut: "⏎", destructive: true, run: () => activate(r) });
    if (r.kind === "pause") base.push({ id: "pause", title: session?.status === "paused" ? "Resume" : "Pause", shortcut: "⏎", run: () => activate(r) });
    base.push({ id: "blocklist", title: "Edit Block List…", shortcut: "⌘B", run: () => push({ id: "focus.blocklist" }) });
    base.push({ id: "stats", title: "Focus Statistics", shortcut: "⌘S", run: () => push({ id: "focus.stats" }) });
    return base;
  };

  const blockedSummary = settings ? [...settings.blockedApps.map((a) => a.name), ...settings.blockedSites] : [];

  return (
    <NavList<Row>
      items={rows}
      onActivate={activate}
      actions={actions}
      renderItem={(r, selected) => {
        let icon = "🎯";
        let title = "";
        let subtitle = "";
        if (r.kind === "duration") {
          title = `Focus for ${r.label}`;
          subtitle = goal ? `on “${goal}”` : "Type a goal in the search field";
        } else if (r.kind === "blocklist") {
          icon = "🚫";
          title = "Edit Block List…";
          subtitle = blockedSummary.length ? blockedSummary.slice(0, 5).join(", ") + (blockedSummary.length > 5 ? ` +${blockedSummary.length - 5}` : "") : "Nothing blocked";
        } else if (r.kind === "stop") {
          icon = "⏹️";
          title = "Stop Current Session";
          subtitle = session ? `${session.goal || "Focus"} · ${formatClock(state?.remainingMs ?? 0)} left` : "";
        } else {
          icon = session?.status === "paused" ? "▶️" : "⏸️";
          title = session?.status === "paused" ? "Resume Session" : "Pause Session";
          subtitle = session ? `${formatClock(state?.remainingMs ?? 0)} left` : "";
        }
        return (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            <span className="icon icon--md">{icon}</span>
            <div className="row__main">
              <span className="row__title">{title}</span>
              <span className="row__subtitle">{subtitle}</span>
            </div>
            {r.kind === "duration" && settings?.defaultMinutes === r.minutes && <span className="row__kind">Default</span>}
          </div>
        );
      }}
    />
  );
}
