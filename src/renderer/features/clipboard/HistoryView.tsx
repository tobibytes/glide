/**
 * Clipboard History: list or grid (⌘G) of entries with a detail pane, a ⌘P filter menu
 * (type + source app), multi-select (Space, ⇧↑/⇧↓, vim ⇧J/⇧K) and the full action set.
 * It drives its own selection (useListNav + useNavController, like the emoji grid) because
 * NavList is list-only and multi-select needs to move the cursor while marking.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionPanel } from "../../components/ActionPanel";
import { Kbd } from "../../components/Kbd";
import { useListNav } from "../../hooks/useListNav";
import { glide } from "../../lib/glide";
import { eventMatchesShortcut } from "../../lib/keys";
import { useNavController, useNavHost } from "../../lib/navHost";
import { findActionOfKind, useVim, type Modifiers, type NavCommand } from "../../lib/vim";
import type { NavAction, ViewProps } from "../types";
import { clipApi, FILTERS, type ActionResult, type ClipFilter, type ClipSummary, type SourceSummary } from "./api";
import { GridCell, ListRow, useThumbs } from "./Cells";
import { Detail } from "./Detail";
import { FilterMenu } from "./FilterMenu";
import { dayLabel } from "./format";
import { extendMark, gridColumns, gridMove, pruneMarks, toggleMark } from "./selection";

interface HistoryProps {
  confirmClear?: boolean;
  selectId?: string;
  mode?: "list" | "grid";
  type?: ClipFilter;
}

const LIST_ROW = 46;
const GRID_ROW = 128;
const isTextual = (s: ClipSummary) => s.type === "text" || s.type === "link" || s.type === "color";

export function HistoryView({ props, query, setQuery, setPlaceholder, push, close, toast }: ViewProps) {
  const p = props as HistoryProps;
  const host = useNavHost();
  const vim = useVim();
  const [filter, setFilter] = useState<ClipFilter>(p.type ?? "all");
  const [source, setSource] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [list, setList] = useState<ClipSummary[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(!!p.confirmClear);
  const [paused, setPaused] = useState<{ on: boolean; until: number | null }>({ on: false, until: null });
  const [mode, setMode] = useState<"list" | "grid">(p.mode ?? "list");
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<NavAction[] | null>(null);
  const [stackInfo, setStackInfo] = useState<{ n: number; collecting: boolean }>({ n: 0, collecting: false });
  const [cols, setCols] = useState(4);
  const seq = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPlaceholder("Search clipboard history (text, links, files, text in images)…"), [setPlaceholder]);

  // Remembered layout (unless the opener asked for one).
  useEffect(() => {
    if (p.mode) return;
    void clipApi.getSettings().then((r) => setMode(r.settings.viewMode));
  }, [p.mode]);

  const load = useCallback(async () => {
    const n = ++seq.current;
    const [items, stats, srcs, st] = await Promise.all([clipApi.list(query, filter, source), clipApi.stats(), clipApi.sources(), clipApi.stack.get()]);
    if (n !== seq.current) return;
    setList(items);
    setSources(srcs);
    setPaused({ on: stats.paused || !stats.enabled, until: stats.pausedUntil });
    setStackInfo({ n: st.items.length, collecting: st.collecting });
  }, [query, filter, source]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch((err) => toast(String(err), "error")), query ? 40 : 0);
    return () => clearTimeout(t);
  }, [load, query, toast]);

  useEffect(
    () =>
      glide().onFeatureEvent((e) => {
        if (e.feature !== "clipboard") return;
        if (e.event === "changed" || e.event === "stack") void load();
        if (e.event === "toast") toast((e.payload as { message?: string } | undefined)?.message ?? "");
      }),
    [load, toast],
  );

  // "Show in Clipboard History" from a search result: narrow the list to that entry.
  useEffect(() => {
    if (!p.selectId) return;
    void clipApi.get(p.selectId).then((e) => e?.text && setQuery(e.text.trim().split("\n")[0]!.slice(0, 60)));
  }, [p.selectId, setQuery]);

  const items = useMemo(() => list ?? [], [list]);
  const thumbsVersion = useThumbs(list);
  const keys = useMemo(() => items.map((s) => s.id), [items]);
  const sections = useMemo(() => (mode === "list" ? items.map((s) => (s.pinned ? "Pinned" : dayLabel(s.lastCopiedAt))) : undefined), [items, mode]);
  const halfPage = useCallback(() => {
    const h = scrollRef.current?.clientHeight ?? 400;
    return mode === "grid" ? Math.max(1, Math.floor(h / GRID_ROW / 2)) * cols : Math.max(1, Math.floor(h / LIST_ROW / 2));
  }, [mode, cols]);
  const nav = useListNav(keys, { sections, halfPage });
  const selected = nav.index >= 0 ? (items[nav.index] ?? null) : null;

  useEffect(() => setMarked((m) => pruneMarks(m, keys)), [keys]);

  // Grid columns follow the available width.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || mode !== "grid") return;
    const ro = new ResizeObserver(() => setCols(gridColumns(el.clientWidth - 12)));
    ro.observe(el);
    setCols(gridColumns(el.clientWidth - 12));
    return () => ro.disconnect();
  }, [mode, list === null]);

  useEffect(() => {
    if (nav.selectedKey) document.getElementById(`clip-${nav.selectedKey}`)?.scrollIntoView({ block: "nearest" });
  }, [nav.selectedKey, mode]);

  // --- operations -----------------------------------------------------------------------
  const run = useCallback(
    async (what: Promise<ActionResult>, closeAfter = false) => {
      const r = await what;
      if (!r.ok) toast(r.error ?? "Failed", "error");
      else if (closeAfter) close();
      else if (r.message) toast(r.message);
    },
    [toast, close],
  );
  const markedIds = useCallback(() => keys.filter((id) => marked.has(id)), [keys, marked]);

  const paste = useCallback((s: ClipSummary, opts: { plain?: boolean; keepOpen?: boolean } = {}) => void run(clipApi.paste(s.id, opts)), [run]);
  const copy = useCallback((s: ClipSummary) => void run(clipApi.copy(s.id), true), [run]);
  const togglePin = useCallback(async (s: ClipSummary) => toast((await clipApi.pin(s.id)) ? "Pinned" : "Unpinned"), [toast]);
  const remove = useCallback(
    async (s: ClipSummary) => {
      const ids = marked.size ? markedIds() : [s.id];
      await clipApi.remove(ids);
      setMarked(new Set());
      if (ids.length > 1) toast(`Deleted ${ids.length} entries`);
    },
    [marked, markedIds, toast],
  );
  const toggleMode = useCallback(() => {
    setMode((m) => {
      const next = m === "list" ? "grid" : "list";
      void clipApi.setSettings({ viewMode: next });
      return next;
    });
  }, []);
  const merge = useCallback(async () => {
    const ids = markedIds();
    const r = await clipApi.merge(ids);
    if (r.ok) setMarked(new Set());
    await run(Promise.resolve(r));
  }, [markedIds, run]);
  const addToStack = useCallback(
    async (s: ClipSummary) => {
      const ids = marked.size ? markedIds() : [s.id];
      const st = await clipApi.stack.add(ids);
      setMarked(new Set());
      toast(`Paste Stack: ${st.items.length} ${st.items.length === 1 ? "item" : "items"}`);
    },
    [marked, markedIds, toast],
  );

  const actions = useCallback(
    (s: ClipSummary): NavAction[] => {
      const a: NavAction[] = [
        { id: "paste", title: "Paste", shortcut: "⏎", run: () => paste(s) },
        { id: "copy", title: "Copy to Clipboard", shortcut: "⌘⏎", run: () => copy(s) },
        { id: "plain", title: s.type === "file" ? "Paste Paths as Text" : "Paste as Plain Text", shortcut: "⇧⌘⏎", run: () => paste(s, { plain: true }) },
        { id: "keep", title: "Paste and Keep Window Open", shortcut: "⌥⏎", run: () => paste(s, { keepOpen: true }) },
      ];
      if (isTextual(s)) a.push({ id: "edit", title: "Edit and Paste…", shortcut: "⌘E", run: () => push({ id: "clipboard.edit", props: { id: s.id } }) });
      if (s.type === "link") {
        a.push({ id: "open-link", title: "Open Link", shortcut: "⌘O", run: () => void run(clipApi.openLink(s.id)) });
        a.push({ id: "md-link", title: "Copy as Markdown Link", shortcut: "⇧⌘L", run: () => void run(clipApi.copyMarkdownLink(s.id)) });
      }
      if (s.type === "file") a.push({ id: "reveal", title: "Reveal in Finder", shortcut: "⌘O", run: () => void run(clipApi.reveal(s.id)) });
      if (s.type !== "image") a.push({ id: "snippet", title: "Save as Snippet", shortcut: "⇧⌘S", run: () => void run(clipApi.saveSnippet(s.id)) });
      if (marked.size >= 2) a.push({ id: "merge", title: `Merge ${marked.size} Selected Entries`, shortcut: "⇧⌘M", run: () => void merge() });
      a.push(
        { id: "mark", title: marked.has(s.id) ? "Deselect" : "Select (for Merge / Stack / Delete)", shortcut: "Space", run: () => setMarked((m) => toggleMark(m, s.id)) },
        { id: "stack-add", title: marked.size ? `Add ${marked.size} Selected to Paste Stack` : "Add to Paste Stack", shortcut: "⇧⌘A", run: () => void addToStack(s) },
        { id: "stack-open", title: "Open Paste Stack", shortcut: "⇧⌘V", run: () => push({ id: "clipboard.stack" }) },
        { id: "pin", title: s.pinned ? "Unpin" : "Pin", shortcut: "⌘.", run: () => void togglePin(s) },
        { id: "mode", title: mode === "list" ? "Show as Grid" : "Show as List", shortcut: "⌘G", run: toggleMode },
        { id: "filter", title: "Filter by Type or App…", shortcut: "⌘P", run: () => setMenuOpen(true) },
      );
      if (s.source?.bundleId) a.push({ id: "ignore", title: `Ignore ${s.source.name}`, run: () => void run(clipApi.ignoreApp(s.id)) });
      a.push(
        paused.on
          ? { id: "resume", title: "Resume Clipboard History", run: () => void run(clipApi.resume()).then(load) }
          : { id: "pause5", title: "Pause for 5 Minutes", shortcut: "⇧⌘P", run: () => void run(clipApi.pauseFor(5)).then(load) },
        { id: "delete", title: marked.size > 1 ? `Delete ${marked.size} Selected` : "Delete Entry", shortcut: "⌃X", destructive: true, run: () => void remove(s) },
        { id: "delete-all", title: "Clear Unpinned…", shortcut: "⌃⇧X", destructive: true, run: () => setConfirmClear(true) },
      );
      return a;
    },
    [paste, copy, push, run, marked, merge, addToStack, togglePin, mode, toggleMode, paused.on, load, remove],
  );

  const activate = useCallback(
    (s: ClipSummary, m: Modifiers) => {
      if (m.cmd && m.shift) paste(s, { plain: true });
      else if (m.cmd) copy(s);
      else if (m.alt) paste(s, { keepOpen: true });
      else paste(s);
    },
    [paste, copy],
  );

  const runAction = useCallback(
    (a: NavAction) => {
      setPanel(null);
      host?.focusSearch();
      void a.run();
    },
    [host],
  );

  const navTo = useCallback(
    (c: NavCommand) => {
      if (mode !== "grid" || c.type === "goto") return nav.apply(c);
      if (c.type === "move") {
        let i = nav.index;
        for (let k = 0; k < Math.abs(c.delta); k++) i = gridMove(i, keys.length, cols, c.delta > 0 ? "down" : "up");
        if (i >= 0) nav.select(keys[i]!);
        return;
      }
      if (c.type === "halfPage") return nav.apply(c);
      nav.apply({ type: "goto", index: c.dir > 0 ? "last" : 0 });
    },
    [mode, nav, keys, cols],
  );

  useEffect(() => {
    host?.setFooter({ primary: selected ? "Paste" : null, hasActions: !!selected });
  }, [host, !!selected]);
  useEffect(() => () => host?.setFooter(null), [host]);

  useNavController({
    nav: navTo,
    activate: (m) => selected && activate(selected, m),
    secondary: () => selected && copy(selected),
    toggleActions: () => setPanel((cur) => (cur ? null : selected ? actions(selected) : null)),
    findAction: async (kind) => {
      const a = selected ? findActionOfKind(actions(selected), kind) : undefined;
      return a ? { title: a.title, run: () => runAction(a) } : null;
    },
    shortcut: (e) => {
      if (!selected) {
        if (eventMatchesShortcut(e, "⌘P")) return (setMenuOpen(true), true);
        if (eventMatchesShortcut(e, "⌘G")) return (toggleMode(), true);
        return false;
      }
      const hit = actions(selected).find((a) => a.shortcut && !["⏎", "⌘⏎", "⇧⌘⏎", "⌥⏎", "Space"].includes(a.shortcut) && eventMatchesShortcut(e, a.shortcut));
      if (hit) runAction(hit);
      return !!hit;
    },
  });

  // Keys the launcher does not map: grid ←/→, marking, Esc-clears-marks. Capture phase so they win.
  const latest = useRef({ mode, selected, keys, nav, cols, marked, query, vim, blocked: false });
  latest.current = { mode, selected, keys, nav, cols, marked, query, vim, blocked: !!panel || menuOpen || confirmClear };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = latest.current;
      if (cur.blocked || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !t.classList.contains("launcher__input") && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const normal = cur.vim.enabled && cur.vim.mode === "normal";
      const free = normal || cur.query === "";
      const noMods = !e.metaKey && !e.ctrlKey && !e.altKey;
      const moveTo = (i: number) => i >= 0 && cur.nav.select(cur.keys[i]!);
      let handled = true;
      if (cur.mode === "grid" && noMods && !e.shiftKey && free && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        moveTo(gridMove(cur.nav.index, cur.keys.length, cur.cols, e.key === "ArrowLeft" ? "left" : "right"));
      } else if (cur.mode === "grid" && normal && noMods && (e.key === "h" || e.key === "l")) {
        moveTo(gridMove(cur.nav.index, cur.keys.length, cur.cols, e.key === "h" ? "left" : "right"));
      } else if (e.key === " " && noMods && !e.shiftKey && free && cur.selected) {
        setMarked((m) => toggleMark(m, cur.selected!.id));
      } else if (cur.selected && noMods && e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp" || (normal && (e.key === "J" || e.key === "K")))) {
        const down = e.key === "ArrowDown" || e.key === "J";
        const id = cur.selected.id;
        setMarked((m) => extendMark(m, id));
        const step = cur.mode === "grid" ? gridMove(cur.nav.index, cur.keys.length, cur.cols, down ? "down" : "up") : Math.min(cur.keys.length - 1, Math.max(0, cur.nav.index + (down ? 1 : -1)));
        const nextId = cur.keys[step];
        if (nextId) {
          cur.nav.select(nextId);
          setMarked((m) => extendMark(m, nextId));
        }
      } else if (e.key === "Escape" && noMods && cur.marked.size) {
        setMarked(new Set());
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Confirmation owns Enter/Escape (capture phase, before the launcher's Escape-to-pop).
  useEffect(() => {
    if (!confirmClear) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Enter") void clipApi.clear(true).then((n) => toast(`Deleted ${n} ${n === 1 ? "entry" : "entries"}`));
      setConfirmClear(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmClear, toast]);

  const filterLabel = FILTERS.find((f) => f.id === filter)?.label ?? "All Types";
  const sourceLabel = source ? (sources.find((s) => s.key === source)?.name ?? "App") : null;
  const emptyText = list === null ? "Loading…" : query || filter !== "all" || source ? "No matching clipboard entries" : "Nothing copied yet. Copy something and it shows up here.";
  const headers = sections?.map((sec, i) => (sec !== sections[i - 1] ? sec : null));
  const pausedText = paused.until ? `Paused until ${new Date(paused.until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Paused";

  return (
    <div className={`clipboard-view clipboard-view--${mode}`} data-thumbs={thumbsVersion}>
      <div className="clipboard-toolbar">
        <span className="clipboard-toolbar__count">
          {list ? `${list.length} ${list.length === 1 ? "entry" : "entries"}` : ""}
          {marked.size > 0 && <span className="clipboard-chip clipboard-chip--accent">{marked.size} selected</span>}
          {paused.on && <span className="clipboard-toolbar__paused">{pausedText}</span>}
          {(stackInfo.n > 0 || stackInfo.collecting) && (
            <span className="clipboard-chip" title="Paste Stack (⇧⌘V)">
              Stack {stackInfo.n}
              {stackInfo.collecting ? " · collecting" : ""}
            </span>
          )}
        </span>
        <span className="clipboard-toolbar__right">
          <button type="button" tabIndex={-1} className="clipboard-chip clipboard-chip--btn" onMouseDown={(e) => e.preventDefault()} onClick={toggleMode} title="Toggle grid (⌘G)">
            {mode === "list" ? "List" : "Grid"} <Kbd keys="⌘G" />
          </button>
          <button type="button" tabIndex={-1} className="clipboard-chip clipboard-chip--btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenuOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={menuOpen}>
            {filterLabel}
            {sourceLabel ? ` · ${sourceLabel}` : ""} ▾ <Kbd keys="⌘P" />
          </button>
        </span>
      </div>
      {menuOpen && (
        <FilterMenu
          type={filter}
          source={source}
          sources={sources}
          onPick={(n) => {
            if (n.type !== undefined) setFilter(n.type);
            if (n.source !== undefined) setSource(n.source);
            setMenuOpen(false);
            host?.focusSearch();
          }}
          onClose={() => {
            setMenuOpen(false);
            host?.focusSearch();
          }}
        />
      )}
      {confirmClear && (
        <div className="clipboard-confirm" role="alertdialog" aria-label="Delete all clipboard history">
          <span>Delete all unpinned clipboard entries? This cannot be undone.</span>
          <span className="clipboard-confirm__keys">
            <Kbd keys="⏎" /> Delete <Kbd keys="esc" /> Cancel
          </span>
        </div>
      )}
      <div className="clipboard-split">
        {items.length === 0 ? (
          <div className="navlist__empty clipboard-empty">{emptyText}</div>
        ) : (
          <>
            <div className={mode === "grid" ? "clipboard-grid" : "clipboard-list"} role="listbox" aria-multiselectable="true" ref={scrollRef} style={mode === "grid" ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}>
              {items.map((s, i) => (
                <div key={s.id} className={mode === "grid" ? "clipboard-grid__slot" : undefined}>
                  {mode === "list" && headers?.[i] && (
                    <div className="section-header" role="presentation">
                      {headers[i]}
                    </div>
                  )}
                  <div role="option" id={`clip-${s.id}`} aria-selected={i === nav.index} data-marked={marked.has(s.id) || undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => (nav.index === i ? activate(s, { cmd: false, shift: false, alt: false }) : nav.select(s.id))}>
                    {mode === "grid" ? <GridCell s={s} selected={i === nav.index} marked={marked.has(s.id)} /> : <ListRow s={s} selected={i === nav.index} marked={marked.has(s.id)} />}
                  </div>
                </div>
              ))}
            </div>
            {selected && (
              <div className="navlist__detail clipboard-detailpane">
                <Detail s={selected} />
              </div>
            )}
          </>
        )}
      </div>
      <div className="clipboard-hints">
        <span>
          <Kbd keys="Space" /> select
        </span>
        <span>
          <Kbd keys="⇧⌘M" /> merge
        </span>
        <span>
          <Kbd keys="⌘." /> pin
        </span>
        <span>
          <Kbd keys="⌘E" /> edit
        </span>
        <span>
          <Kbd keys="⌃X" /> delete
        </span>
        {mode === "grid" && (
          <span>
            <Kbd keys="← →" /> move
          </span>
        )}
      </div>
      {panel && selected && <ActionPanel title={selected.title.slice(0, 60)} actions={panel} onRun={runAction} onClose={() => (setPanel(null), host?.focusSearch())} />}
    </div>
  );
}
