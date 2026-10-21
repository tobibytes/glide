import { useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "./Kbd";
import { pointerReallyMoved } from "../lib/pointer";
import { eventMatchesShortcut } from "../lib/keys";
import { toVimKey, useVim, vimPanelKey } from "../lib/vim";

export interface PanelAction {
  id: string;
  title: string;
  shortcut?: string;
  icon?: string;
  destructive?: boolean;
}

interface Props<A extends PanelAction> {
  title: string;
  actions: A[];
  onRun: (action: A) => void;
  onClose: () => void;
}

/**
 * ⌘K popover: filterable list of actions. ⏎ runs, ⎋ closes.
 * Opened in vim NORMAL mode it starts in navigation (j/k/l/h; / or i to filter).
 */
export function ActionPanel<A extends PanelAction>({ title, actions, onRun, onClose }: Props<A>) {
  const vim = useVim();
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const [navMode, setNavMode] = useState(vim.enabled && vim.mode === "normal");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? actions.filter((a) => a.title.toLowerCase().includes(f)) : actions;
  }, [actions, filter]);
  const sel = Math.min(index, Math.max(0, visible.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const move = (d: number) => setIndex(Math.min(visible.length - 1, Math.max(0, sel + d)));

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (navMode) {
      const c = vimPanelKey(toVimKey(e));
      if (c) {
        e.preventDefault();
        if (c.type === "move") move(c.delta);
        else if (c.type === "run") visible[sel] && onRun(visible[sel]);
        else if (c.type === "close") onClose();
        else setNavMode(false);
        return;
      }
    } else if (e.key === "Escape" || (e.key.toLowerCase() === "k" && e.metaKey)) {
      e.preventDefault();
      // Esc while filtering in a NORMAL-mode panel returns to navigation first.
      if (vim.enabled && vim.mode === "normal" && e.key === "Escape") setNavMode(true);
      else onClose();
      return;
    } else if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "j" || e.key === "n"))) {
      e.preventDefault();
      return move(1);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "k" || e.key === "p"))) {
      e.preventDefault();
      return move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (visible[sel]) onRun(visible[sel]);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const hit = actions.find((a) => a.shortcut && a.shortcut !== "⏎" && eventMatchesShortcut(e, a.shortcut));
      if (hit) {
        e.preventDefault();
        onRun(hit);
        return;
      }
    }
    if (navMode && e.key.length === 1) e.preventDefault();
  };

  return (
    <div className="actions" role="dialog" aria-label="Actions" onKeyDown={onKeyDown}>
      <div className="actions__head" title={title}>
        {title}
      </div>
      <div className="actions__list" role="listbox" aria-label="Actions" ref={listRef}>
        {visible.length === 0 && <div className="actions__empty">No matching actions</div>}
        {visible.map((a, i) => (
          <div
            key={a.id}
            id={`action-${i}`}
            role="option"
            aria-selected={i === sel}
            className={`action ${i === sel ? "action--selected" : ""} ${a.destructive ? "action--destructive" : ""}`}
            onMouseMove={(e) => pointerReallyMoved(e) && setIndex(i)}
            onClick={() => onRun(a)}
          >
            <span className="action__icon">{a.icon ?? (i === 0 ? "↩" : "·")}</span>
            <span className="action__title">{a.title}</span>
            {a.shortcut && (
              <span className="action__shortcut">
                <Kbd keys={a.shortcut} />
              </span>
            )}
          </div>
        ))}
      </div>
      <input
        ref={inputRef}
        className={`actions__filter ${navMode ? "actions__filter--nav" : ""}`}
        placeholder={navMode ? "j/k move · l run · h close · / filter" : "Filter actions…"}
        value={filter}
        readOnly={navMode}
        onChange={(e) => {
          setFilter(e.target.value);
          setIndex(0);
        }}
        aria-label="Filter actions"
      />
    </div>
  );
}
