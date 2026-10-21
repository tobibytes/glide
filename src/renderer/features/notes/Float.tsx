import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { glide } from "../../lib/glide";
import { useTheme } from "../../hooks/useTheme";
import { Kbd } from "../../components/Kbd";
import type { Note, NoteSummary, NotesState } from "../../../main/features/notes/model";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("notes", method, ...args);
const SAVE_MS = 400;

function relative(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function FloatingNotes() {
  const [theme, setTheme] = useState<"system" | "dark" | "light">();
  useTheme(theme);
  const [note, setNote] = useState<Note | null>(null);
  const [body, setBody] = useState("");
  const [list, setList] = useState<NotesState>({ notes: [], currentId: null });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ note, body });
  latest.current = { note, body };

  useEffect(() => {
    document.body.classList.add("notes-float-body");
    document.title = "Floating Notes";
    void glide().getData().then((d) => setTheme(d.settings.theme));
    return () => document.body.classList.remove("notes-float-body");
  }, []);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const { note: n, body: b } = latest.current;
    if (n && dirty.current) {
      dirty.current = false;
      await call("save", n.id, b);
    }
  }, []);

  const load = useCallback((n: Note | null) => {
    setNote(n);
    setBody(n?.body ?? "");
    dirty.current = false;
    setConfirmDelete(false);
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  useEffect(() => {
    void call<Note>("current").then(load);
    void call<NotesState>("state").then(setList);
    const off = glide().onFeatureEvent((e) => {
      if (e.feature !== "notes") return;
      if (e.event === "focus") requestAnimationFrame(() => taRef.current?.focus());
      if (e.event !== "changed") return;
      const st = e.payload as NotesState & { source?: string };
      setList(st);
      const cur = latest.current.note;
      // Another surface switched or deleted the note: follow it (our own saves are ignored).
      if (st.source !== "save" && st.currentId && st.currentId !== cur?.id) {
        void flush().then(() => call<Note | null>("get", st.currentId).then(load));
      } else if (!st.currentId && cur) load(null);
    });
    const onUnload = () => void flush();
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("blur", onUnload);
    return () => {
      off();
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("blur", onUnload);
    };
  }, [flush, load]);

  const onChange = (value: string) => {
    setBody(value);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_MS);
  };

  const switchTo = async (fn: () => Promise<Note>) => {
    await flush();
    load(await fn());
  };

  const remove = async () => {
    if (!note) return;
    clearTimeout(timer.current);
    dirty.current = false;
    await call("remove", note.id);
    load(await call<Note>("current"));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (confirmDelete) {
      e.preventDefault();
      if (e.key === "Enter" || e.key.toLowerCase() === "y") void remove();
      else if (e.key === "Escape" || e.key.toLowerCase() === "n") setConfirmDelete(false);
      return;
    }
    const mod = e.metaKey && !e.ctrlKey && !e.altKey;
    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      void switchTo(() => call<Note>("create"));
    } else if (mod && (e.key === "[" || e.key === "]")) {
      e.preventDefault();
      void switchTo(() => call<Note>("cycle", e.key === "]" ? 1 : -1));
    } else if (mod && e.key === "Backspace") {
      e.preventDefault();
      setConfirmDelete(true);
    } else if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      void flush();
      setSwitcher(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      void flush().then(() => call("hide"));
    }
  };

  const index = list.notes.findIndex((n) => n.id === note?.id);
  const words = useMemo(() => (body.trim() ? body.trim().split(/\s+/).length : 0), [body]);

  return (
    <div className="notes-float" onKeyDown={onKey}>
      <div className="notes-float__bar">
        <span className="notes-float__title">{list.notes.find((n) => n.id === note?.id)?.title ?? "Floating Notes"}</span>
        <span className="notes-float__count">{list.notes.length ? `${index + 1} / ${list.notes.length}` : ""}</span>
        <button type="button" className="notes-float__btn" title="New note (⌘N)" aria-label="New note" onClick={() => void switchTo(() => call<Note>("create"))}>
          +
        </button>
        <button type="button" className="notes-float__btn" title="Switch note (⌘K)" aria-label="Switch note" onClick={() => setSwitcher(true)}>
          ⌘K
        </button>
      </div>
      <textarea
        ref={taRef}
        className="notes-float__text"
        value={body}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"Start typing…\n\n⌘N new note · ⌘[ ⌘] switch · ⌘K find · ⌘⌫ delete · ⎋ hide"}
        spellCheck
        disabled={!note}
        aria-label="Note text"
      />
      {confirmDelete ? (
        <div className="notes-float__confirm" role="alertdialog" aria-label="Delete note">
          Delete this note?
          <span>
            <Kbd keys="⏎" /> delete · <Kbd keys="⎋" /> cancel
          </span>
        </div>
      ) : (
        <div className="notes-float__foot">
          <span>
            {words} word{words === 1 ? "" : "s"} · {body.length} chars
          </span>
          <span>{note ? relative(note.updatedAt) : ""}</span>
        </div>
      )}
      {switcher && (
        <Switcher
          currentId={note?.id ?? null}
          onPick={(id) => {
            setSwitcher(false);
            void switchTo(() => call<Note>("select", id));
          }}
          onClose={() => {
            setSwitcher(false);
            requestAnimationFrame(() => taRef.current?.focus());
          }}
        />
      )}
    </div>
  );
}

function Switcher({ currentId, onPick, onClose }: { currentId: string | null; onPick(id: string): void; onClose(): void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<NoteSummary[]>([]);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void call<NoteSummary[]>("search", q).then((r) => {
      if (!alive) return;
      setItems(r);
      setSel(q ? 0 : Math.max(0, r.findIndex((n) => n.id === currentId)));
    });
    return () => {
      alive = false;
    };
  }, [q, currentId]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const down = e.key === "ArrowDown" || (e.ctrlKey && (e.key === "j" || e.key === "n"));
    const up = e.key === "ArrowUp" || (e.ctrlKey && (e.key === "k" || e.key === "p"));
    if (down || up) {
      e.preventDefault();
      setSel((s) => Math.min(items.length - 1, Math.max(0, s + (down ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[sel]) onPick(items[sel].id);
    } else if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="notes-switch" onKeyDown={onKey}>
      <input className="notes-switch__input" autoFocus placeholder="Find a note…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a note" />
      <div className="notes-switch__list" role="listbox" ref={listRef}>
        {items.length === 0 && <div className="notes-switch__empty">No notes match</div>}
        {items.map((n, i) => (
          <div key={n.id} role="option" aria-selected={i === sel} className={`notes-switch__row ${i === sel ? "notes-switch__row--sel" : ""}`} onMouseMove={() => setSel(i)} onClick={() => onPick(n.id)}>
            <span className="notes-switch__title">{n.title}</span>
            <span className="notes-switch__time">{relative(n.updatedAt)}</span>
          </div>
        ))}
      </div>
      <div className="notes-switch__keys">
        <Kbd keys="↑↓" /> <Kbd keys="⌃J ⌃K" /> select · <Kbd keys="⏎" /> open · <Kbd keys="⎋" /> close
      </div>
    </div>
  );
}
