import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavList } from "../../components/NavList";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { glide } from "../../lib/glide";
import type { NavAction, NavItem, ViewProps } from "../types";
import { clipApi, FILTERS, type ClipFilter, type ClipSummary } from "./api";
import { Detail } from "./Detail";
import { dayLabel, relativeTime } from "./format";

interface Row extends NavItem {
  s: ClipSummary;
}

interface HistoryProps {
  confirmClear?: boolean;
  selectId?: string;
}

export function TypeIcon({ s }: { s: ClipSummary }) {
  if (s.type === "color") return <Icon icon={{ kind: "color", value: s.preview.trim() }} />;
  if (s.type === "file" && s.files?.[0]) return <Icon icon={{ kind: "file", value: s.files[0] }} fallback="▤" />;
  const glyph = s.type === "image" ? "▣" : s.type === "link" ? "⛓" : "¶";
  return <span className={`icon icon--md icon--symbol clipboard-typeicon clipboard-typeicon--${s.type}`}>{glyph}</span>;
}

export function HistoryView({ props, query, setQuery, setPlaceholder, close, toast }: ViewProps) {
  const p = props as HistoryProps;
  const [filter, setFilter] = useState<ClipFilter>("all");
  const [list, setList] = useState<ClipSummary[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(!!p.confirmClear);
  const [selected, setSelected] = useState<Row | null>(null);
  const [paused, setPaused] = useState(false);
  const seq = useRef(0);

  useEffect(() => setPlaceholder("Search clipboard history…"), [setPlaceholder]);

  const load = useCallback(async () => {
    const n = ++seq.current;
    const [items, stats] = await Promise.all([clipApi.list(query, filter), clipApi.stats()]);
    if (n !== seq.current) return;
    setList(items);
    setPaused(stats.paused || !stats.enabled);
  }, [query, filter]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch((err) => toast(String(err), "error")), query ? 40 : 0);
    return () => clearTimeout(t);
  }, [load, query, toast]);

  useEffect(() => glide().onFeatureEvent((e) => e.feature === "clipboard" && e.event === "changed" && void load()), [load]);

  // "Show in Clipboard History" from a search result: narrow the list to that entry.
  useEffect(() => {
    if (!p.selectId) return;
    void clipApi.get(p.selectId).then((e) => e?.text && setQuery(e.text.trim().split("\n")[0]!.slice(0, 60)));
  }, [p.selectId, setQuery]);

  const rows: Row[] = useMemo(
    () => (list ?? []).map((s) => ({ id: s.id, s, section: s.pinned ? "Pinned" : dayLabel(s.lastCopiedAt) })),
    [list],
  );

  const run = useCallback(
    async (what: Promise<{ ok: boolean; error?: string; message?: string }>, closeAfter: boolean) => {
      const r = await what;
      if (!r.ok) toast(r.error ?? "Failed", "error");
      else if (closeAfter) close();
    },
    [toast, close],
  );

  const paste = useCallback((s: ClipSummary, plain = false) => void run(clipApi.paste(s.id, plain), false), [run]);
  const copy = useCallback((s: ClipSummary) => void run(clipApi.copy(s.id), true), [run]);
  const togglePin = useCallback(
    async (s: ClipSummary) => {
      const pinned = await clipApi.pin(s.id);
      toast(pinned ? "Pinned" : "Unpinned");
    },
    [toast],
  );
  const remove = useCallback(async (s: ClipSummary) => {
    await clipApi.remove(s.id);
  }, []);

  const cycleFilter = useCallback(() => setFilter((f) => FILTERS[(FILTERS.findIndex((x) => x.id === f) + 1) % FILTERS.length]!.id), []);

  const actions = useCallback(
    (r: Row): NavAction[] => [
      { id: "paste", title: "Paste", shortcut: "⏎", run: () => paste(r.s) },
      { id: "copy", title: "Copy to Clipboard", shortcut: "⌘⏎", run: () => copy(r.s) },
      { id: "plain", title: r.s.type === "file" ? "Paste Paths as Text" : "Paste as Plain Text", shortcut: "⇧⌘⏎", run: () => paste(r.s, true) },
      { id: "pin", title: r.s.pinned ? "Unpin" : "Pin", shortcut: "⇧⌘P", run: () => togglePin(r.s) },
      { id: "filter", title: "Cycle Type Filter", shortcut: "⌘P", run: () => cycleFilter() },
      { id: "delete", title: "Delete Entry", shortcut: "⌃X", destructive: true, run: () => remove(r.s) },
      { id: "delete-all", title: "Delete All…", shortcut: "⌃⇧X", destructive: true, run: () => setConfirmClear(true) },
    ],
    [paste, copy, togglePin, remove, cycleFilter],
  );

  // Shortcuts not covered by NavList's Enter handling. Skips events NavList already handled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || confirmClear) return;
      const key = e.code;
      let handled = true;
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && key === "KeyP") cycleFilter();
      else if (e.metaKey && e.shiftKey && key === "KeyP" && selected) void togglePin(selected.s);
      else if (e.ctrlKey && !e.shiftKey && !e.metaKey && key === "KeyX" && selected) void remove(selected.s);
      else if (e.ctrlKey && e.shiftKey && key === "KeyX") setConfirmClear(true);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, confirmClear, togglePin, remove, cycleFilter]);

  // Confirmation owns Enter/Escape (capture phase, before NavList and the launcher's Escape-to-pop).
  useEffect(() => {
    if (!confirmClear) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Enter") {
        void clipApi.clear(true).then((n) => toast(`Deleted ${n} ${n === 1 ? "entry" : "entries"}`));
      }
      setConfirmClear(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmClear, toast]);

  const onSelectionChange = useCallback((r: Row | null) => {
    setSelected(r);
    if (r) document.getElementById(`nav-${r.id}`)?.scrollIntoView({ block: "nearest" });
  }, []);

  const emptyText = list === null ? "Loading…" : query || filter !== "all" ? "No matching clipboard entries" : "Nothing copied yet. Copy something and it shows up here.";

  return (
    <div className="clipboard-view">
      <div className="clipboard-toolbar">
        <span className="clipboard-toolbar__count">
          {list ? `${list.length} ${list.length === 1 ? "entry" : "entries"}` : ""}
          {paused && <span className="clipboard-toolbar__paused">Paused</span>}
        </span>
        <label className="clipboard-toolbar__filter">
          <select className="select clipboard-select" tabIndex={-1} value={filter} aria-label="Filter by type" onChange={(e) => setFilter(e.target.value as ClipFilter)}>
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <Kbd keys="⌘P" />
        </label>
      </div>
      {confirmClear && (
        <div className="clipboard-confirm" role="alertdialog" aria-label="Delete all clipboard history">
          <span>Delete all unpinned clipboard entries? This cannot be undone.</span>
          <span className="clipboard-confirm__keys">
            <Kbd keys="⏎" /> Delete <Kbd keys="esc" /> Cancel
          </span>
        </div>
      )}
      <NavList<Row>
        items={rows}
        emptyText={emptyText}
        onSelectionChange={onSelectionChange}
        onActivate={(r, m) => (m.cmd && m.shift ? paste(r.s, true) : m.cmd ? copy(r.s) : paste(r.s))}
        actions={actions}
        detail={(r) => <Detail s={r.s} />}
        renderItem={(r, isSel) => (
          <div className={`row clipboard-row ${isSel ? "row--selected" : ""}`}>
            <TypeIcon s={r.s} />
            <div className="clipboard-row__main">
              <span className="row__title clipboard-row__title">{r.s.title}</span>
              <span className="clipboard-row__meta">
                {r.s.source?.name ? `${r.s.source.name} · ` : ""}
                {relativeTime(r.s.lastCopiedAt)}
                {r.s.count > 1 ? ` · ×${r.s.count}` : ""}
              </span>
            </div>
            {r.s.pinned && (
              <span className="clipboard-row__pin" aria-label="Pinned">
                ●
              </span>
            )}
          </div>
        )}
      />
    </div>
  );
}
