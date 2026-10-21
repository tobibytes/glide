/** Raycast `Grid`: keyboard-navigable cells. ↑/↓ (j/k) move by row, ←/→ by cell, ⌃D/⌃U by half a page. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GridItemModel, ViewModel } from "../../../extension-api/types";
import { iconFor } from "../../../extension-api/icons";
import { ActionPanel } from "../../components/ActionPanel";
import { Icon } from "../../components/Icon";
import { useNavController, useNavHost } from "../../lib/navHost";
import { eventMatchesShortcut } from "../../lib/keys";
import { findActionOfKind, type NavCommand } from "../../lib/vim";
import { filterItems } from "./filter";
import { EmptyView, navActions, type Emit, type RunInfo, type Runner } from "./viewKit";

type GridView = Extract<ViewModel, { type: "grid" }>;

function GridCell({ item, selected, fit, aspect, assetsPath, onPick }: { item: GridItemModel; selected: boolean; fit: string; aspect: string; assetsPath: string; onPick(): void }) {
  const icon = iconFor(item.content, assetsPath);
  const isImage = icon && (icon.kind === "url" || icon.kind === "file");
  return (
    <div role="option" aria-selected={selected} className={`extensions-cell ${selected ? "extensions-cell--selected" : ""}`} onClick={onPick} title={item.tooltip ?? item.title}>
      <div className="extensions-cell__media" style={{ aspectRatio: aspect.replace("/", " / ") }}>
        {icon?.kind === "color" ? (
          <span className="extensions-cell__color" style={{ background: icon.value }} />
        ) : isImage ? (
          <Icon icon={icon} size="xl" className={`extensions-cell__img extensions-cell__img--${fit}`} />
        ) : (
          <span className="extensions-cell__glyph">{icon?.kind === "emoji" ? icon.value : "▫️"}</span>
        )}
      </div>
      {(item.title || item.subtitle) && (
        <div className="extensions-cell__text">
          {item.title && <span className="extensions-cell__title">{item.title}</span>}
          {item.subtitle && <span className="extensions-cell__subtitle">{item.subtitle}</span>}
        </div>
      )}
    </div>
  );
}

export function GridBody({ view, info, query, run, emit }: { view: GridView; info: RunInfo; query: string; run: Runner; emit: Emit }) {
  const host = useNavHost();
  const filtering = view.filtering ?? !view.searchHandler;
  const items = useMemo(() => (filtering ? filterItems(view.items.map((i) => ({ ...i, title: i.title ?? "", accessories: [] })), query) : view.items) as GridItemModel[], [view.items, filtering, query]);
  const [selId, setSelId] = useState<string | null>(null);
  const [panel, setPanel] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const cols = view.columns;
  const index = Math.max(0, selId ? items.findIndex((i) => i.id === selId) : 0);
  const selected = items[index] ?? null;
  const actions = useMemo(
    () => navActions(selected?.actions ?? (items.length ? [] : (view.emptyView?.actions ?? view.actions ?? [])), run, selected ? { quickLook: selected.quickLook, title: selected.title } : undefined),
    [selected, items.length, view.emptyView, view.actions, run],
  );

  // Raycast `selectedItemId`: select it whenever the value changes (or once the item shows up).
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const want = view.selectedItemId;
    if (!want || applied.current === want || !items.some((i) => i.id === want)) return;
    applied.current = want;
    setSelId(want);
  }, [view.selectedItemId, items]);

  const select = useCallback((i: number) => {
    const clamped = Math.max(0, Math.min(items.length - 1, i));
    setSelId(items[clamped]?.id ?? null);
  }, [items]);

  // Keep a valid selection; report it and load more near the end.
  useEffect(() => {
    if (!selected && items.length) setSelId(items[0].id);
  }, [selected, items]);
  const lastSel = useRef<string | null>(null);
  useEffect(() => {
    const id = selected?.id ?? null;
    if (id === lastSel.current) return;
    lastSel.current = id;
    if (view.selectionHandler) emit(view.selectionHandler, [id]);
  }, [selected, view.selectionHandler, emit]);
  const askedFor = useRef(-1);
  useEffect(() => {
    if (!view.pagination?.hasMore || !view.pagination.handler) return;
    if (index >= items.length - cols * 2 && askedFor.current !== items.length) {
      askedFor.current = items.length;
      emit(view.pagination.handler, []);
    }
  }, [index, items.length, cols, view.pagination, emit]);

  useEffect(() => {
    rootRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selId]);
  useEffect(() => {
    host?.setFooter({ primary: actions[0]?.title ?? null, hasActions: actions.length > 0 });
  }, [host, actions]);
  useEffect(() => () => host?.setFooter(null), [host]);

  const sectionStarts = useMemo(() => items.map((it, i) => i === 0 || it.section !== items[i - 1].section).map((s, i) => (s ? i : -1)).filter((i) => i >= 0), [items]);

  const nav = (c: NavCommand) => {
    if (c.type === "move") select(index + c.delta * cols);
    else if (c.type === "goto") select(c.index === "last" ? items.length - 1 : c.index);
    else if (c.type === "halfPage") select(index + c.dir * c.count * cols * 2);
    else {
      const starts = sectionStarts;
      const cur = starts.filter((s) => s <= index).pop() ?? 0;
      const pos = starts.indexOf(cur);
      select(starts[Math.max(0, Math.min(starts.length - 1, pos + c.dir * c.count))] ?? 0);
    }
  };

  useNavController({
    nav,
    activate: () => actions[0]?.run(),
    secondary: () => (actions.find((a) => a.shortcut === "⌘⏎") ?? actions[0])?.run(),
    toggleActions: () => setPanel((p) => !p && actions.length > 0),
    findAction: async (kind) => {
      const a = findActionOfKind(actions, kind);
      return a ? { title: a.title, run: () => a.run() } : null;
    },
    shortcut: (e) => {
      const hit = actions.find((a) => a.shortcut && a.shortcut !== "⏎" && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut));
      if (hit) void hit.run();
      return !!hit;
    },
  });

  // ←/→ move by one cell (the search field would otherwise move its caret).
  const ref = useRef({ index, select, panel });
  ref.current = { index, select, panel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || ref.current.panel) return;
      const t = e.target as HTMLElement | null;
      if (t && ((t.tagName === "INPUT" && !t.closest(".launcher__head")) || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      e.preventDefault();
      e.stopPropagation();
      ref.current.select(ref.current.index + (e.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!items.length) return <EmptyView model={view.emptyView} fallback={view.emptyText ?? "No results"} assetsPath={info.assetsPath} loading={view.isLoading} />;
  const headers = items.map((it, i) => (it.section && it.section !== items[i - 1]?.section ? it.section : null));
  const groups: Array<{ title: string | null; items: Array<{ item: GridItemModel; i: number }> }> = [];
  items.forEach((item, i) => {
    if (i === 0 || headers[i] !== null || item.section !== items[i - 1].section) groups.push({ title: headers[i], items: [] });
    groups[groups.length - 1].items.push({ item, i });
  });
  return (
    <div className="extensions-grid" ref={rootRef} role="listbox">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.title && <div className="section-header">{g.title}</div>}
          <div className={`extensions-grid__cells extensions-grid__cells--${view.inset ?? "md"}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {g.items.map(({ item, i }) => (
              <GridCell key={item.id} item={item} selected={i === index} fit={view.fit} aspect={view.aspectRatio} assetsPath={info.assetsPath} onPick={() => (i === index ? actions[0]?.run() : select(i))} />
            ))}
          </div>
        </div>
      ))}
      {panel && (
        <ActionPanel
          title={info.commandTitle}
          actions={actions}
          onRun={(a) => {
            setPanel(false);
            host?.focusSearch();
            void a.run();
          }}
          onClose={() => {
            setPanel(false);
            host?.focusSearch();
          }}
        />
      )}
    </div>
  );
}
