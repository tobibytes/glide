/**
 * Paste Stack view: items in paste order (top = next). ⏎ pastes the next item, ⌘⏎ the selected one,
 * ⌘↑/⌘↓ reorder, ⌃X removes, ⇧⌘S starts/stops collecting (a number typed in the search field
 * sets how many copies to collect), ⌘T switches FIFO/LIFO, ⌃⇧X clears.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionPanel } from "../../components/ActionPanel";
import { Kbd } from "../../components/Kbd";
import { useListNav } from "../../hooks/useListNav";
import { glide } from "../../lib/glide";
import { eventMatchesShortcut } from "../../lib/keys";
import { useNavController, useNavHost } from "../../lib/navHost";
import { findActionOfKind } from "../../lib/vim";
import type { NavAction, NavItem, ViewProps } from "../types";
import { clipApi, type ActionResult, type ClipSummary, type StackState } from "./api";
import { ListRow, useThumbs } from "./Cells";
import { Detail } from "./Detail";

interface Row extends NavItem {
  s: ClipSummary;
  pos: number;
}

export function StackView({ query, setQuery, setPlaceholder, toast }: ViewProps) {
  const [st, setSt] = useState<StackState | null>(null);
  const [panel, setPanel] = useState<NavAction[] | null>(null);
  const host = useNavHost();

  useEffect(() => setPlaceholder("Type a number, then ⇧⌘S to collect that many copies…"), [setPlaceholder]);
  const load = useCallback(() => void clipApi.stack.get().then(setSt), []);
  useEffect(() => {
    load();
    return glide().onFeatureEvent((e) => {
      if (e.feature !== "clipboard") return;
      if (e.event === "stack" && e.payload) setSt(e.payload as StackState);
      else if (e.event === "changed") load();
    });
  }, [load]);
  useThumbs(st?.items ?? null);

  const report = useCallback(
    async (p: Promise<ActionResult | StackState>) => {
      const r = await p;
      if ("ok" in r) {
        if (!r.ok) toast(r.error ?? "Failed", "error");
        else if (r.message) toast(r.message);
      } else setSt(r);
    },
    [toast],
  );

  const limitFromQuery = () => {
    const n = Number.parseInt(query.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const toggleCollect = useCallback(async () => {
    if (st?.collecting) return report(clipApi.stack.stop());
    await report(clipApi.stack.start(limitFromQuery()));
    setQuery("");
    load();
  }, [st?.collecting, report, query, setQuery, load]);
  const toggleOrder = useCallback(async () => {
    const order = st?.order === "lifo" ? "fifo" : "lifo";
    await clipApi.setSettings({ stackOrder: order });
    load();
    toast(order === "fifo" ? "First in, first out" : "Last in, first out");
  }, [st?.order, load, toast]);
  const pasteNext = useCallback(() => void report(clipApi.stack.pasteNext()), [report]);
  const pasteThis = useCallback(
    async (s: ClipSummary) => {
      await clipApi.stack.remove(s.id);
      await report(clipApi.paste(s.id));
    },
    [report],
  );
  // Selection follows the moved item (nav.select below pins it by id).
  const pinSel = useRef<(id: string) => void>(() => {});
  const move = useCallback(
    (s: ClipSummary, dir: -1 | 1) => {
      pinSel.current(s.id);
      void report(clipApi.stack.move(s.id, dir));
    },
    [report],
  );
  const remove = useCallback((s: ClipSummary) => void report(clipApi.stack.remove(s.id)), [report]);
  const clear = useCallback(() => void report(clipApi.stack.clear()), [report]);

  const rows: Row[] = useMemo(() => (st?.items ?? []).map((s, i) => ({ id: s.id, s, pos: i + 1, section: i === 0 ? "Next" : "Then" })), [st]);
  const keys = useMemo(() => rows.map((r) => r.id), [rows]);
  const sections = useMemo(() => rows.map((r) => r.section), [rows]);
  const nav = useListNav(keys, { sections });
  const selected = nav.index >= 0 ? (rows[nav.index] ?? null) : null;
  pinSel.current = nav.select;
  useEffect(() => {
    if (nav.selectedKey) document.getElementById(`stack-${nav.selectedKey}`)?.scrollIntoView({ block: "nearest" });
  }, [nav.selectedKey]);

  const actions = useCallback(
    (r: Row): NavAction[] => [
      { id: "next", title: "Paste Next from Stack", shortcut: "⏎", run: pasteNext },
      { id: "this", title: "Paste This Item", shortcut: "⌘⏎", run: () => void pasteThis(r.s) },
      { id: "up", title: "Move Up", shortcut: "⌘↑", run: () => move(r.s, -1) },
      { id: "down", title: "Move Down", shortcut: "⌘↓", run: () => move(r.s, 1) },
      { id: "collect", title: st?.collecting ? "Stop Collecting" : "Start Collecting", shortcut: "⇧⌘S", run: () => void toggleCollect() },
      { id: "order", title: st?.order === "lifo" ? "Switch to First In, First Out" : "Switch to Last In, First Out", shortcut: "⌘T", run: () => void toggleOrder() },
      { id: "remove", title: "Remove from Stack", shortcut: "⌃X", destructive: true, run: () => remove(r.s) },
      { id: "clear", title: "Clear Paste Stack", shortcut: "⌃⇧X", destructive: true, run: clear },
    ],
    [pasteNext, pasteThis, move, toggleCollect, toggleOrder, remove, clear, st?.collecting, st?.order],
  );

  const runAction = useCallback(
    (a: NavAction) => {
      setPanel(null);
      host?.focusSearch();
      void a.run();
    },
    [host],
  );
  useEffect(() => {
    host?.setFooter({ primary: rows.length ? "Paste Next from Stack" : null, hasActions: !!selected });
  }, [host, rows.length, !!selected]);
  useEffect(() => () => host?.setFooter(null), [host]);
  useNavController({
    nav: (c) => nav.apply(c),
    activate: (m) => (m.cmd && selected ? void pasteThis(selected.s) : rows.length ? pasteNext() : undefined),
    secondary: () => selected && void pasteThis(selected.s),
    toggleActions: () => setPanel((cur) => (cur ? null : selected ? actions(selected) : null)),
    findAction: async (kind) => {
      const a = selected ? findActionOfKind(actions(selected), kind) : undefined;
      return a ? { title: a.title, run: () => runAction(a) } : null;
    },
    shortcut: (e) => {
      const hit = selected ? actions(selected).find((a) => a.shortcut && a.shortcut !== "⏎" && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut)) : undefined;
      if (hit) runAction(hit);
      return !!hit;
    },
  });

  // Shortcuts that must work with an empty stack, and ⌘↑/⌘↓ (the launcher maps those to section jumps).
  const latest = useRef({ selected, move, toggleCollect, toggleOrder, clear });
  latest.current = { selected, move, toggleCollect, toggleOrder, clear };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".actions[role=dialog]") || e.target instanceof HTMLTextAreaElement) return;
      const cur = latest.current;
      const sel = cur.selected?.s;
      let handled = true;
      if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (sel) cur.move(sel, e.key === "ArrowUp" ? -1 : 1);
      } else if (e.metaKey && e.shiftKey && !e.ctrlKey && e.code === "KeyS") void cur.toggleCollect();
      else if (e.metaKey && !e.shiftKey && !e.ctrlKey && e.code === "KeyT") void cur.toggleOrder();
      else if (e.ctrlKey && e.shiftKey && !e.metaKey && e.code === "KeyX") cur.clear();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const status = !st ? "" : st.collecting ? `Collecting${st.limit ? ` ${st.collected}/${st.limit}` : ` (${st.collected} so far)`}` : st.items.length ? "Ready" : "Idle";
  return (
    <div className="clipboard-view clipboard-stack">
      <div className="clipboard-toolbar">
        <span className="clipboard-toolbar__count">
          <span className={`clipboard-chip ${st?.collecting ? "clipboard-chip--accent" : ""}`}>{status}</span>
          {st ? `${st.items.length} ${st.items.length === 1 ? "item" : "items"}` : ""}
        </span>
        <span className="clipboard-toolbar__right">
          <span className="clipboard-chip">{st?.order === "lifo" ? "LIFO · last copied first" : "FIFO · first copied first"}</span>
          <Kbd keys="⌘T" />
        </span>
      </div>
      <div className="clipboard-split">
        {rows.length === 0 ? (
          <div className="navlist__empty clipboard-empty">{st?.collecting ? "Copy something — it lands here. Then run “Paste Next from Stack” (⏎)." : "Paste Stack is empty. ⇧⌘S starts collecting your next copies."}</div>
        ) : (
          <>
            <div className="clipboard-list" role="listbox" aria-label="Paste Stack">
              {rows.map((r, i) => (
                <div key={r.id}>
                  {r.section !== rows[i - 1]?.section && (
                    <div className="section-header" role="presentation">
                      {r.section}
                    </div>
                  )}
                  <div role="option" id={`stack-${r.id}`} aria-selected={i === nav.index} onMouseDown={(e) => e.preventDefault()} onClick={() => nav.select(r.id)}>
                    <div className="clipboard-stackrow">
                      <span className="clipboard-stackrow__pos">{r.pos}</span>
                      <ListRow s={r.s} selected={i === nav.index} marked={false} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {selected && (
              <div className="navlist__detail clipboard-detailpane">
                <Detail s={selected.s} />
              </div>
            )}
          </>
        )}
      </div>
      <div className="clipboard-hints">
        <span>
          <Kbd keys="⏎" /> paste next
        </span>
        <span>
          <Kbd keys="⌘↑ ⌘↓" /> reorder
        </span>
        <span>
          <Kbd keys="⌃X" /> remove
        </span>
        <span>
          <Kbd keys="⇧⌘S" /> {st?.collecting ? "stop" : "start"}
        </span>
      </div>
      {panel && selected && <ActionPanel title="Paste Stack" actions={panel} onRun={runAction} onClose={() => (setPanel(null), host?.focusSearch())} />}
    </div>
  );
}
