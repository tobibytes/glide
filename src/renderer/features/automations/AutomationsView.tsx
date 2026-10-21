import { useCallback, useEffect, useMemo } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { glide } from "../../lib/glide";
import type { AutomationView, PendingConfirmation } from "../../../main/features/automations/model";
import { automationsCall, relTime, STATUS_ICON, useAutomations, type ExecuteResult } from "./common";
import { RunLog } from "./RunLog";

type Row = NavItem & ({ kind: "pending"; p: PendingConfirmation } | { kind: "automation"; a: AutomationView } | { kind: "create" });

export function AutomationsView({ props, query, setPlaceholder, toast }: ViewProps<{ select?: string }>) {
  const [state, now] = useAutomations();
  useEffect(() => setPlaceholder("Search automations…"), [setPlaceholder]);

  const say = useCallback((r: ExecuteResult) => toast(r.error ?? r.message ?? "", r.ok ? "info" : "error"), [toast]);
  const call = useCallback((method: string, ...args: unknown[]) => void automationsCall<ExecuteResult>(method, ...args).then(say), [say]);
  const edit = (id: string) => glide().openSettings(`automations#${encodeURIComponent(id)}`);

  const rows = useMemo((): Row[] => {
    if (!state) return [];
    const q = query.trim().toLowerCase();
    const match = (...s: string[]) => !q || s.some((x) => x.toLowerCase().includes(q));
    const out: Row[] = [];
    for (const p of state.pending) if (match(p.name, p.reason)) out.push({ id: `pending:${p.id}`, section: "Waiting for Confirmation", kind: "pending", p });
    // Requested selection first so ⌘L / notification clicks land on it.
    const sorted = [...state.automations].sort((a, b) => (a.id === props.select ? -1 : b.id === props.select ? 1 : 0));
    for (const a of sorted) if (match(a.name, a.triggerText, a.targetText)) out.push({ id: a.id, section: "Automations", kind: "automation", a });
    if (!q || "create automation new".includes(q)) out.push({ id: "create", section: "Automations", kind: "create" });
    return out;
  }, [state, query, props.select]);

  const actions = useCallback(
    (r: Row): NavAction[] => {
      if (r.kind === "create") return [{ id: "create", title: "Create Automation", shortcut: "⏎", run: () => edit("new") }];
      if (r.kind === "pending")
        return [
          { id: "run", title: "Run", shortcut: "⏎", run: () => call("answer", r.p.id, true) },
          { id: "skip", title: "Skip", shortcut: "⌘⏎", run: () => call("answer", r.p.id, false) },
        ];
      const a = r.a;
      return [
        { id: "run", title: "Run Now", shortcut: "⏎", run: () => call("runNow", a.id) },
        { id: "toggle", title: a.enabled ? "Disable" : "Enable", shortcut: "⌘⏎", run: () => call("setEnabled", a.id, !a.enabled) },
        { id: "edit", title: "Edit…", shortcut: "⌘E", run: () => edit(a.id) },
        { id: "clear", title: "Clear Run Log", shortcut: "⇧⌘⌫", run: () => call("clearLog", a.id) },
        { id: "delete", title: "Delete Automation", shortcut: "⌃X", destructive: true, run: () => call("remove", a.id) },
      ];
    },
    [call],
  );

  if (!state) return <div className="navlist__empty">Loading…</div>;
  return (
    <div className="automations-view">
      <NavList<Row>
        items={rows}
        actions={actions}
        actionsTitle="Automation"
        emptyText="No automations match."
        onActivate={(r, m) => {
          const list = actions(r);
          void (m.cmd ? (list.find((x) => x.shortcut === "⌘⏎") ?? list[0]) : list[0])?.run();
        }}
        detail={(r) => {
          if (r.kind === "create") return <div className="automations-detail"><p className="automations-detail__lead">Run a workflow or command at a time, on a schedule, or when something happens: an app launches, Wi‑Fi changes, the battery runs low, a display is connected, a file lands in a folder, or a hotkey is pressed.</p></div>;
          if (r.kind === "pending")
            return (
              <div className="automations-detail">
                <h3 className="automations-detail__title">Run “{r.p.name}”?</h3>
                <p className="automations-detail__lead">{r.p.reason}</p>
                {r.p.input && <p className="automations-detail__input mono">{r.p.input}</p>}
                <p className="automations-detail__meta">⏎ run · ⌘⏎ skip · expires {relTime(r.p.expiresAt, now)}</p>
              </div>
            );
          const a = r.a;
          return (
            <div className="automations-detail">
              <h3 className="automations-detail__title">{a.name}</h3>
              <dl className="automations-detail__facts">
                <dt>When</dt>
                <dd>{a.triggerText}</dd>
                <dt>Do</dt>
                <dd>{a.targetText}</dd>
                <dt>Status</dt>
                <dd>
                  {a.running ? "Running…" : a.enabled ? "On" : "Off"}
                  {a.askBeforeRunning ? " · asks first" : ""}
                  {a.nextRun ? ` · next ${relTime(a.nextRun, now)}` : ""}
                </dd>
              </dl>
              {a.problem && <p className="automations-problem">⚠️ {a.problem}</p>}
              <RunLog log={a.log} limit={12} />
            </div>
          );
        }}
        renderItem={(r, selected) => {
          const cls = `row ${selected ? "row--selected" : ""}`;
          if (r.kind === "create")
            return (
              <div className={cls}>
                <span className="icon icon--md">➕</span>
                <div className="row__main">
                  <span className="row__title">Create Automation</span>
                </div>
              </div>
            );
          if (r.kind === "pending")
            return (
              <div className={cls}>
                <span className="icon icon--md">❓</span>
                <div className="row__main">
                  <span className="row__title">{r.p.name}</span>
                  <span className="row__subtitle">⏎ run · ⌘⏎ skip</span>
                </div>
              </div>
            );
          const a = r.a;
          const last = a.log[0];
          return (
            <div className={`${cls} ${a.enabled ? "" : "automations-row--off"}`} data-automation={a.id}>
              <span className="icon icon--md">{a.running ? "⏳" : a.enabled ? "⚡️" : "💤"}</span>
              <div className="row__main">
                <span className="row__title">{a.name}</span>
                <span className="row__subtitle">{a.triggerText}</span>
              </div>
              <span className="row__kind automations-row__last">{last ? `${STATUS_ICON[last.status]} ${relTime(last.at, now)}` : a.enabled ? "on" : "off"}</span>
            </div>
          );
        }}
      />
    </div>
  );
}
