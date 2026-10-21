import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { parseReminderText, previewDue } from "../../../main/features/reminders/due";
import { extractListTag, pickList } from "../../../main/features/reminders/model";
import { call, errorText, splitNotes, type CreateReminderResult, type ReminderDraft, type RemindersState } from "./api";
import { AccessRowView, accessActions, accessRows, isAccessRow, type AccessRow } from "./Access";

type Row = NavItem & ({ kind: "create"; listId?: string; listTitle?: string } | AccessRow | { kind: "hint" });

/** The search field is the reminder text; the preview row shows the parsed title, due date and list. */
export function CreateView({ props, query, setQuery, setPlaceholder, close, toast }: ViewProps) {
  const [state, setState] = useState<RemindersState | null>(null);
  const [busy, setBusy] = useState(false);
  const prefilled = useRef(false);

  const load = useCallback(() => void call<RemindersState>("state").then(setState, (e: unknown) => setState({ status: "error", message: errorText(e), lists: [], reminders: [] })), []);
  useEffect(() => {
    setPlaceholder("Reminder, e.g. “Call mom tomorrow 9am #family // notes”");
    load();
  }, [load, setPlaceholder]);
  useEffect(() => {
    if (prefilled.current) return;
    prefilled.current = true;
    const d = props.draft as Partial<ReminderDraft> | undefined;
    if (d?.title) setQuery([d.title, d.phrase].filter(Boolean).join(" "));
  }, [props.draft, setQuery]);

  const now = new Date();
  const parsed = useMemo(() => {
    const { text, notes } = splitNotes(query);
    const tagged = extractListTag(text, state?.lists ?? []);
    const p = parseReminderText(tagged.text);
    return { ...p, notes, listId: tagged.listId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, state?.lists]);

  const defaultList = state?.status === "ok" ? pickList(state.lists, parsed.listId ?? (typeof props.listId === "string" ? props.listId : state.defaultListId)) : undefined;

  const rows = useMemo((): Row[] => {
    if (!state) return [];
    if (state.status !== "ok") return accessRows(state);
    if (!query.trim()) return [{ id: "hint", kind: "hint" }];
    const others = state.lists.filter((l) => l.writable && l.id !== defaultList?.id).map((l): Row => ({ id: `in:${l.id}`, kind: "create", listId: l.id, listTitle: l.title, section: "Add to Another List" }));
    return [{ id: "create", kind: "create", listId: defaultList?.id, listTitle: defaultList?.title }, ...others];
  }, [state, query, defaultList]);

  const create = async (listId?: string) => {
    if (busy) return;
    if (!parsed.title.trim()) return toast("Type a title for the reminder", "error");
    setBusy(true);
    try {
      const draft: Partial<ReminderDraft> = { title: parsed.title, due: parsed.due?.toISOString(), allDay: parsed.allDay, listId, notes: parsed.notes };
      const r = await call<CreateReminderResult>("create", draft);
      if (r.ok) {
        toast(`Reminder created: ${r.reminder?.title ?? parsed.title}`);
        close();
      } else if (r.status && r.status !== "error") {
        load();
        toast(r.error ?? "Reminders access is needed", "error");
      } else toast(r.error ?? "Could not create the reminder", "error");
    } finally {
      setBusy(false);
    }
  };

  const actions = (row: Row): NavAction[] => {
    if (isAccessRow(row)) return state ? accessActions(row, setState, load) : [];
    if (row.kind === "hint") return [];
    return [{ id: "create", title: row.listTitle ? `Create in “${row.listTitle}”` : "Create Reminder", shortcut: "⏎", run: () => void create(row.listId) }];
  };

  return (
    <div className="reminders" data-testid="reminders-create" data-status={state?.status ?? "loading"}>
      {state && state.status !== "ok" && state.message && <div className={`reminders__banner ${state.status === "error" ? "reminders__banner--error" : ""}`}>{state.message}</div>}
      <NavList<Row>
        items={rows}
        emptyText="Loading…"
        onActivate={(row) => void actions(row)[0]?.run()}
        actions={actions}
        renderItem={(row, selected) => {
          if (isAccessRow(row)) return state ? <AccessRowView row={row} selected={selected} state={state} /> : null;
          const cls = `row ${selected ? "row--selected" : ""}`;
          if (row.kind === "hint")
            return (
              <div className={cls}>
                <span className="icon icon--md">🔔</span>
                <div className="row__main">
                  <span className="row__title">Type the reminder in the search field</span>
                  <span className="row__subtitle">Dates like “tomorrow 9am”, “in 2 hours”, “next friday”; #list picks a list; “ // ” starts notes</span>
                </div>
              </div>
            );
          const primary = row.id === "create";
          return (
            <div className={cls} data-testid={primary ? "reminders-preview" : undefined}>
              <span className="icon icon--md">{primary ? "🔔" : "📋"}</span>
              <div className="row__main">
                <span className="row__title">{primary ? parsed.title || "Untitled" : `Add to ${row.listTitle}`}</span>
                <span className="row__subtitle">{[previewDue(parsed, now), parsed.notes ? `Notes: ${parsed.notes}` : ""].filter(Boolean).join(" · ")}</span>
              </div>
              <div className="row__right">{row.listTitle && <span className="row__kind">{row.listTitle}</span>}</div>
            </div>
          );
        }}
      />
    </div>
  );
}
