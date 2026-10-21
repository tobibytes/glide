import { useCallback, useEffect, useMemo, useState } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { buildRows, type ReminderRow } from "../../../main/features/reminders/model";
import { describeDue } from "../../../main/features/reminders/format";
import { call, errorText, type RemindersState } from "./api";
import { AccessRowView, accessActions, accessRows, isAccessRow, type AccessRow } from "./Access";

type Row = NavItem & ({ kind: "reminder"; r: ReminderRow } | AccessRow | { kind: "empty" });

export function RemindersView({ query, setPlaceholder, push, toast }: ViewProps) {
  const [state, setState] = useState<RemindersState | null>(null);
  const [listFilter, setListFilter] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(() => void call<RemindersState>("state").then(setState, (e: unknown) => setState({ status: "error", message: errorText(e), lists: [], reminders: [] })), []);
  useEffect(() => {
    setPlaceholder("Search reminders…");
    load();
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [load, setPlaceholder]);

  const rows = useMemo((): Row[] => {
    if (!state) return [];
    if (state.status !== "ok") return accessRows(state);
    const list = buildRows(listFilter ? state.reminders.filter((r) => r.listId === listFilter) : state.reminders, now, query).map((r): Row => ({ id: r.id, section: r.section, kind: "reminder", r }));
    return list.length ? list : [{ id: "empty", kind: "empty" }];
  }, [state, listFilter, now, query]);

  const newReminder = useCallback(() => push({ id: "reminders.create", props: listFilter ? { listId: listFilter } : {} }), [push, listFilter]);

  const toggle = useCallback(
    async (r: ReminderRow) => {
      const res = await call<{ ok: boolean; error?: string }>("complete", r.id, !r.completed);
      if (!res.ok) return toast(res.error ?? "Could not update the reminder", "error");
      toast(r.completed ? "Marked as not completed" : `Completed “${r.title}”`);
      // Optimistic: flip locally so the row moves at once, then refresh from EventKit.
      setState((s) => (s ? { ...s, reminders: s.reminders.map((x) => (x.id === r.id ? { ...x, completed: !r.completed, completionDate: new Date().toISOString() } : x)) } : s));
      load();
    },
    [load, toast],
  );

  const listActions = (): NavAction[] =>
    state?.status === "ok"
      ? [
          { id: "all", title: `Show All Lists${listFilter ? "" : " ✓"}`, run: () => setListFilter(null) },
          ...state.lists.map((l, i) => ({ id: `list:${l.id}`, title: `Show “${l.title}”${listFilter === l.id ? " ✓" : ""}`, ...(i < 9 ? { shortcut: `⌘${i + 1}` } : {}), run: () => setListFilter(l.id) })),
        ]
      : [];

  const actions = (row: Row): NavAction[] => {
    if (isAccessRow(row)) return state ? accessActions(row, setState, load) : [];
    const common: NavAction[] = [
      { id: "new", title: "New Reminder", shortcut: "⌘N", run: newReminder },
      { id: "reload", title: "Reload", shortcut: "⌘R", run: load },
      { id: "openApp", title: "Open Reminders App", shortcut: "⌘O", run: () => void call("openApp") },
      ...listActions(),
    ];
    if (row.kind !== "reminder") return common;
    const r = row.r;
    return [
      { id: "toggle", title: r.completed ? "Mark as Not Completed" : "Complete", shortcut: "⏎", run: () => void toggle(r) },
      ...common,
      { id: "copy", title: "Copy Title", shortcut: "⌘C", run: () => void navigator.clipboard.writeText(r.title).then(() => toast("Copied")) },
    ];
  };

  const title = state?.status === "ok" && listFilter ? state.lists.find((l) => l.id === listFilter)?.title : null;
  const message = state && state.status !== "ok" ? state.message : null;

  return (
    <div className="reminders" data-testid="reminders-view" data-status={state?.status ?? "loading"}>
      {message && <div className={`reminders__banner ${state?.status === "error" ? "reminders__banner--error" : ""}`}>{message}</div>}
      {title && <div className="reminders__filter">List: {title} · ⌘K to change</div>}
      <NavList<Row>
        items={rows}
        emptyText="Loading…"
        actionsTitle="Reminders"
        onActivate={(row) => void actions(row)[0]?.run()}
        actions={actions}
        renderItem={(row, selected) => {
          if (isAccessRow(row)) return state ? <AccessRowView row={row} selected={selected} state={state} /> : null;
          const cls = `row ${selected ? "row--selected" : ""}`;
          if (row.kind === "empty")
            return (
              <div className={cls}>
                <span className="icon icon--md">🎉</span>
                <div className="row__main">
                  <span className="row__title">{query ? "No matching reminders" : "All done"}</span>
                  <span className="row__subtitle">⌘N to add a reminder</span>
                </div>
              </div>
            );
          const r = row.r;
          const due = r.due ? describeDue(new Date(r.due), !!r.dueAllDay, now) : null;
          return (
            <div className={`${cls} reminders__row ${r.completed ? "reminders__row--done" : ""}`}>
              <span className="reminders__check" style={{ borderColor: r.color ?? "var(--accent)", background: r.completed ? (r.color ?? "var(--accent)") : "transparent" }} aria-hidden="true">
                {r.completed ? "✓" : ""}
              </span>
              <div className="row__main">
                <span className="row__title">
                  {r.priority > 0 && <span className="reminders__prio">{r.priority <= 4 ? "!!!" : r.priority === 5 ? "!!" : "!"} </span>}
                  {r.title}
                </span>
                {r.notes && <span className="row__subtitle">{r.notes.split("\n")[0]}</span>}
              </div>
              <div className="row__right">
                {due && <span className={`reminders__due ${row.section === "Overdue" ? "reminders__due--overdue" : ""}`}>{due}</span>}
                <span className="row__kind">{r.listTitle}</span>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
