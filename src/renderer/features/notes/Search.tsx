import { useCallback, useEffect, useRef, useState } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { glide } from "../../lib/glide";
import { NavList } from "../../components/NavList";
import type { Note, NoteSummary } from "../../../main/features/notes/model";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("notes", method, ...args);

type Row = NavItem & ({ kind: "note"; note: NoteSummary } | { kind: "create"; text: string });

function when(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function NotesSearch({ query, setPlaceholder, close, toast }: ViewProps) {
  const [results, setResults] = useState<NoteSummary[]>([]);
  const [preview, setPreview] = useState<Note | null>(null);
  const armed = useRef<{ id: string; at: number } | null>(null);

  useEffect(() => setPlaceholder("Search notes…"), [setPlaceholder]);

  const refresh = useCallback(() => void call<NoteSummary[]>("search", query).then(setResults), [query]);
  useEffect(() => {
    refresh();
    return glide().onFeatureEvent((e) => {
      if (e.feature === "notes" && e.event === "changed") refresh();
    });
  }, [refresh]);

  const rows: Row[] = [
    ...results.map((n): Row => ({ id: n.id, section: "Notes", kind: "note", note: n })),
    ...(query.trim() ? [{ id: "__create", section: "Create", kind: "create" as const, text: query.trim() }] : []),
  ];

  const open = (r: Row) => {
    if (r.kind === "create") {
      void call<Note>("create").then(async (n) => {
        await call("save", n.id, r.text);
        await call("open", n.id);
        close();
      });
      return;
    }
    void call("open", r.id).then(() => close());
  };

  const remove = (r: Row) => {
    if (r.kind !== "note") return;
    const now = Date.now();
    if (armed.current?.id === r.id && now - armed.current.at < 2500) {
      armed.current = null;
      void call("remove", r.id).then(() => toast("Note deleted"));
    } else {
      armed.current = { id: r.id, at: now };
      toast("Press ⌃X again to delete this note");
    }
  };

  const actions = (r: Row): NavAction[] =>
    r.kind === "create"
      ? [{ id: "create", title: "Create Note", shortcut: "⏎", run: () => open(r) }]
      : [
          { id: "open", title: "Open in Floating Notes", shortcut: "⏎", run: () => open(r) },
          {
            id: "copy",
            title: "Copy Note Text",
            shortcut: "⌘⏎",
            run: async () => {
              const n = await call<Note | null>("get", r.id);
              if (n) await navigator.clipboard.writeText(n.body);
              toast("Copied");
            },
          },
          { id: "delete", title: "Delete Note", shortcut: "⌃X", destructive: true, run: () => remove(r) },
        ];

  return (
    <NavList<Row>
      items={rows}
      emptyText="No notes yet — type something and press ⏎ to create one"
      onActivate={(r, mods) => {
        if (mods.cmd && r.kind === "note") void actions(r)[1].run();
        else open(r);
      }}
      actions={actions}
      onSelectionChange={(r) => {
        if (r?.kind === "note") void call<Note | null>("get", r.id).then(setPreview);
        else setPreview(null);
      }}
      detail={(r) =>
        r.kind === "note" ? (
          <div className="notes-detail">
            <pre className="notes-detail__body">{preview?.id === r.id ? preview.body : r.note.preview}</pre>
            <div className="notes-detail__meta faint">
              Edited {when(r.note.updatedAt)} · {r.note.chars} chars
            </div>
          </div>
        ) : (
          <div className="notes-detail faint">Creates a new note with “{r.text}” and opens it.</div>
        )
      }
      renderItem={(r, selected) => (
        <div className={`row ${selected ? "row--selected" : ""}`}>
          <span className="icon icon--md">{r.kind === "create" ? "📝" : "🗒️"}</span>
          <div className="row__main">
            <span className="row__title">{r.kind === "create" ? `Create Note “${r.text}”` : r.note.title}</span>
            {r.kind === "note" && <span className="row__subtitle">{r.note.preview}</span>}
          </div>
          <div className="row__right">{r.kind === "note" && <span className="row__kind">{when(r.note.updatedAt)}</span>}</div>
        </div>
      )}
    />
  );
}
