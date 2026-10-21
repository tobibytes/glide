import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { ViewProps } from "../types";
import type { NavAction } from "../types";
import { glide } from "../../lib/glide";
import { useNavController, useNavHost } from "../../lib/navHost";
import { useVim, type NavCommand } from "../../lib/vim";
import { eventMatchesShortcut } from "../../lib/keys";
import { ActionPanel } from "../../components/ActionPanel";
import { Kbd } from "../../components/Kbd";
import { CATEGORIES, SKIN_TONES, allEmoji, findEmoji, searchEmoji, withTone, type Emoji } from "./model";
import { keyToMove, layoutRows, move, type GridSection, type Move, type Pos } from "./grid";

const COLUMNS = 8;
const ROW_HEIGHT = 52;

interface PickerState {
  recent: string[];
  frequent: string[];
  skinTone: number;
}

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("emoji", method, ...args);

export function EmojiPicker({ props, query, setQuery, setPlaceholder, toast, close }: ViewProps<{ query?: string }>) {
  const host = useNavHost();
  const vim = useVim();
  const [state, setState] = useState<PickerState>({ recent: [], frequent: [], skinTone: 0 });
  const [pos, setPos] = useState<Pos>({ row: 0, col: 0 });
  const [panel, setPanel] = useState<NavAction[] | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPlaceholder("Search emoji & symbols…");
    if (typeof props.query === "string" && props.query) setQuery(props.query);
    void call<PickerState>("state").then(setState).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sections = useMemo((): GridSection<Emoji>[] => {
    const q = query.trim();
    if (q) return [{ id: "results", title: "Results", items: searchEmoji(q) }];
    const pick = (chars: string[]) => chars.map((c) => findEmoji(c)).filter((e): e is Emoji => !!e);
    const list: GridSection<Emoji>[] = [];
    const recent = pick(state.recent);
    const frequent = pick(state.frequent);
    if (recent.length) list.push({ id: "recent", title: "Recently Used", items: recent });
    if (frequent.length) list.push({ id: "frequent", title: "Frequently Used", items: frequent });
    const all = allEmoji();
    CATEGORIES.forEach((c, i) => list.push({ id: c.id, title: c.title, items: all.filter((e) => e.category === i) }));
    return list;
  }, [query, state.recent, state.frequent]);

  const rows = useMemo(() => layoutRows(sections, COLUMNS), [sections]);

  // New query → back to the first cell.
  useEffect(() => setPos({ row: 0, col: 0 }), [query]);

  const safe = rows.length ? { row: Math.min(pos.row, rows.length - 1), col: Math.min(pos.col, rows[Math.min(pos.row, rows.length - 1)].items.length - 1) } : null;
  const selected = safe ? rows[safe.row].items[safe.col] : null;

  useEffect(() => {
    gridRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [safe?.row, safe?.col]);

  const shown = (e: Emoji) => withTone(e, state.skinTone);

  const finish = useCallback(
    (res: ExecuteResult) => {
      if (res.error) toast(res.error, "error");
      else if (res.message) toast(res.message);
      if (res.hide) close();
    },
    [toast, close],
  );

  const paste = useCallback((e: Emoji) => void call<ExecuteResult>("paste", e.char).then(finish), [finish]);
  const copy = useCallback((e: Emoji) => void call<ExecuteResult>("copy", e.char).then(finish), [finish]);
  const cycleTone = useCallback(() => {
    const next = (state.skinTone + 1) % SKIN_TONES.length;
    setState((s) => ({ ...s, skinTone: next }));
    void call<number>("setSkinTone", next);
    toast(`Skin tone: ${SKIN_TONES[next].label}`);
  }, [state.skinTone, toast]);

  const actions = useCallback(
    (e: Emoji): NavAction[] => [
      { id: "paste", title: "Paste Emoji", shortcut: "⏎", run: () => paste(e) },
      { id: "copy", title: "Copy Emoji", shortcut: "⌘⏎", run: () => copy(e) },
      {
        id: "copyName",
        title: "Copy Name",
        shortcut: "⇧⌘C",
        run: () => {
          void navigator.clipboard.writeText(e.name).then(() => toast("Name copied"));
        },
      },
      { id: "tone", title: `Change Skin Tone (${SKIN_TONES[state.skinTone].label})`, shortcut: "⌘T", run: cycleTone },
    ],
    [paste, copy, cycleTone, state.skinTone, toast],
  );

  const doMove = useCallback((m: Move, page = 5) => setPos((p) => move(rows, p, m, page)), [rows]);
  const halfPage = () => Math.max(1, Math.floor((gridRef.current?.clientHeight ?? 300) / ROW_HEIGHT / 2));

  const navTo = (c: NavCommand) => {
    if (c.type === "move") {
      const n = Math.abs(c.delta);
      for (let i = 0; i < n; i++) doMove(c.delta > 0 ? "down" : "up");
    } else if (c.type === "goto") doMove(c.index === "last" ? "end" : "home");
    else if (c.type === "halfPage") for (let i = 0; i < c.count; i++) doMove(c.dir > 0 ? "pageDown" : "pageUp", halfPage());
    else if (c.type === "section") for (let i = 0; i < c.count; i++) doMove(c.dir > 0 ? "nextSection" : "prevSection");
  };

  useEffect(() => {
    host?.setFooter({ primary: selected ? "Paste Emoji" : null, hasActions: !!selected });
  }, [host, !!selected]);
  useEffect(() => () => host?.setFooter(null), [host]);

  useNavController({
    nav: navTo,
    activate: () => selected && paste(selected),
    secondary: () => selected && copy(selected),
    toggleActions: () => setPanel((p) => (p ? null : selected ? actions(selected) : null)),
    findAction: async (kind) => {
      if (!selected || kind === "delete") return null;
      return kind === "copy" ? { title: "Copy Emoji", run: () => copy(selected) } : { title: "Paste Emoji", run: () => paste(selected) };
    },
    shortcut: (e) => {
      if (!selected) return false;
      const hit = actions(selected).find((a) => a.shortcut && a.shortcut !== "⏎" && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut));
      if (hit) void hit.run();
      return !!hit;
    },
  });

  // Left/right (and h/l in NORMAL mode) are grid-only keys the launcher does not map; capture them first.
  // Without a launcher host (standalone), handle every grid key here.
  const latest = useRef({ doMove, selected, paste, copy, panel, vim, host, actions });
  latest.current = { doMove, selected, paste, copy, panel, vim, host, actions };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = latest.current;
      if (cur.panel) return;
      const normal = cur.vim.enabled && cur.vim.mode === "normal";
      const m = keyToMove(e, normal);
      const horizontal = m === "left" || m === "right";
      if (m && (horizontal || !cur.host)) {
        e.preventDefault();
        e.stopPropagation();
        cur.doMove(m, 5);
        return;
      }
      if (!cur.host && e.key === "Enter" && cur.selected) {
        e.preventDefault();
        if (e.metaKey) cur.copy(cur.selected);
        else cur.paste(cur.selected);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="emoji">
      <div className="emoji__grid" ref={gridRef} role="grid" aria-label="Emoji">
        {rows.length === 0 && <div className="navlist__empty">No emoji match “{query}”</div>}
        {rows.map((r, ri) => (
          <div key={`${r.section}:${ri}`}>
            {r.first && (
              <div className="section-header" role="presentation">
                {r.title}
              </div>
            )}
            <div className="emoji__row" role="row">
              {r.items.map((e, ci) => {
                const sel = safe?.row === ri && safe?.col === ci;
                return (
                  <button
                    type="button"
                    key={e.char}
                    role="gridcell"
                    tabIndex={-1}
                    aria-selected={sel}
                    aria-label={e.name}
                    title={e.name}
                    className={`emoji__cell ${sel ? "emoji__cell--selected" : ""}`}
                    onMouseMove={() => !sel && setPos({ row: ri, col: ci })}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => paste(e)}
                  >
                    {shown(e)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="emoji__detail">
        {selected ? (
          <>
            <span className="emoji__big">{shown(selected)}</span>
            <div className="emoji__meta">
              <div className="emoji__name">{selected.name}</div>
              <div className="emoji__kw faint">{selected.keywords.slice(0, 6).join(", ")}</div>
            </div>
          </>
        ) : (
          <span className="faint">Nothing selected</span>
        )}
        <div className="emoji__keys faint">
          <span>
            <Kbd keys="⏎" /> paste
          </span>
          <span>
            <Kbd keys="⌘⏎" /> copy
          </span>
          <span>
            <Kbd keys="⌘T" /> tone {SKIN_TONES[state.skinTone].swatch}
          </span>
          <span>
            <Kbd keys="← ↑ ↓ →" /> {vim.enabled ? <Kbd keys="h j k l" /> : <Kbd keys="⌃H ⌃J ⌃K ⌃L" />} move
          </span>
        </div>
      </div>
      {panel && selected && (
        <ActionPanel
          title={selected.name}
          actions={panel}
          onRun={(a) => {
            setPanel(null);
            host?.focusSearch();
            void a.run();
          }}
          onClose={() => {
            setPanel(null);
            host?.focusSearch();
          }}
        />
      )}
    </div>
  );
}
