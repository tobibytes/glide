/**
 * Keyboard-navigable list used by the launcher and every feature view.
 *
 * Inside the launcher the search field owns the keyboard: the launcher maps keys
 * through lib/vim.ts and forwards commands to the NavList via NavHostContext, so
 * every view gets the same ↑/↓, ⌃J/⌃K, ⌃D/⌃U, ⌘K, ⏎/⌘⏎ and, in vim NORMAL mode,
 * j/k/gg/G/{ }/l/o/O/x/y/p/. bindings. Outside the launcher (a settings page or a
 * feature window) it listens on window keydown with the INSERT-mode bindings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavAction, NavItem, NavListProps } from "../features/types";
import { useListNav, halfPageOf } from "../hooks/useListNav";
import { useNavController, useNavHost, type NavController } from "../lib/navHost";
import { findActionOfKind, INITIAL_VIM_STATE, toVimKey, vimKey, type Modifiers, type NavCommand } from "../lib/vim";
import { eventMatchesShortcut } from "../lib/keys";
import { ActionPanel } from "./ActionPanel";
import { pointerReallyMoved } from "../lib/pointer";

export interface NavListExtraProps {
  /** Title shown at the top of the ⌘K panel (default: "Actions"). */
  actionsTitle?: string;
  /** Extra class on the root element. */
  className?: string;
}

const NO_MODS: Modifiers = { cmd: false, shift: false, alt: false };

export function NavList<T extends NavItem>(props: NavListProps<T> & NavListExtraProps) {
  const { items, renderItem, onActivate, detail, onSelectionChange, emptyText, actions, preserveSelection, actionsTitle, className } = props;
  const host = useNavHost();
  const listRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<NavAction[] | null>(null);

  const keys = useMemo(() => items.map((i) => i.id), [items]);
  const sections = useMemo(() => items.map((i) => i.section), [items]);
  const halfPage = useCallback(() => halfPageOf(listRef.current), []);
  const nav = useListNav(keys, { sections, preserve: preserveSelection !== false, halfPage });
  const selected = nav.index >= 0 ? items[nav.index] : null;

  // Notify the owner only when the selected item actually changes.
  const selRef = useRef(onSelectionChange);
  selRef.current = onSelectionChange;
  useEffect(() => {
    selRef.current?.(selected ?? null);
  }, [selected]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [nav.selectedKey]);

  const actionsOf = useCallback((item: T | null): NavAction[] => (item && actions ? actions(item) : []), [actions]);

  useEffect(() => {
    if (!host) return;
    const list = actionsOf(selected);
    host.setFooter({ primary: selected ? (list[0]?.title ?? "Open") : null, hasActions: list.length > 0 });
  }, [host, selected, actionsOf]);
  useEffect(() => () => host?.setFooter(null), [host]);

  const run = useCallback(
    (a: NavAction) => {
      setPanel(null);
      host?.focusSearch();
      void a.run();
    },
    [host],
  );

  const controller: NavController = {
    nav: (c: NavCommand) => nav.apply(c),
    activate: (mods) => {
      if (selected) onActivate(selected, mods);
    },
    secondary: () => {
      if (!selected) return;
      const sec = actionsOf(selected).find((a) => a.shortcut === "⌘⏎");
      if (sec) run(sec);
      else onActivate(selected, { ...NO_MODS, cmd: true });
    },
    toggleActions: () => {
      if (panel) {
        setPanel(null);
        host?.focusSearch();
        return;
      }
      const list = actionsOf(selected);
      if (list.length) setPanel(list);
    },
    findAction: async (kind) => {
      const a = findActionOfKind(actionsOf(selected), kind);
      return a ? { title: a.title, run: () => run(a) } : null;
    },
    shortcut: (e) => {
      const hit = actionsOf(selected).find((a) => a.shortcut && a.shortcut !== "⏎" && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut));
      if (hit) run(hit);
      return !!hit;
    },
  };
  useNavController(controller, !!host);

  // Standalone (no launcher host): own the keyboard with INSERT-mode bindings.
  const ctlRef = useRef(controller);
  ctlRef.current = controller;
  useEffect(() => {
    if (host) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const r = vimKey(INITIAL_VIM_STATE, toVimKey(e), { enabled: false, mode: "insert", queryEmpty: true, viewPushed: false, now: e.timeStamp });
      const c = r.command;
      const ctl = ctlRef.current;
      if (!c) {
        if ((e.metaKey || e.ctrlKey) && ctl.shortcut?.(e)) e.preventDefault();
        return;
      }
      if (c.type === "move" || c.type === "goto" || c.type === "halfPage" || c.type === "section") ctl.nav(c);
      else if (c.type === "activate") ctl.activate(c.mods);
      else if (c.type === "secondary") ctl.secondary();
      else if (c.type === "actions") ctl.toggleActions();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host]);

  const headers = useMemo(() => items.map((it, i) => (it.section && it.section !== items[i - 1]?.section ? it.section : null)), [items]);
  const cls = ["navlist", detail ? "navlist--split" : "", host ? "" : "navlist--standalone", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={cls}>
      {items.length === 0 ? (
        <div className="navlist__empty">{emptyText ?? "No results"}</div>
      ) : (
        <>
          <div className="navlist__items" role="listbox" ref={listRef}>
            {items.map((it, i) => (
              <div key={it.id}>
                {headers[i] && (
                  <div className="section-header" role="presentation">
                    {headers[i]}
                  </div>
                )}
                <div role="option" aria-selected={i === nav.index} id={`nav-${it.id}`} onMouseMove={(e) => pointerReallyMoved(e) && nav.index !== i && nav.select(it.id)} onClick={() => onActivate(it, NO_MODS)}>
                  {renderItem(it, i === nav.index)}
                </div>
              </div>
            ))}
          </div>
          {detail && selected && <div className="navlist__detail">{detail(selected)}</div>}
        </>
      )}
      {panel && selected && (
        <ActionPanel
          title={actionsTitle ?? "Actions"}
          actions={panel}
          onRun={run}
          onClose={() => {
            setPanel(null);
            host?.focusSearch();
          }}
        />
      )}
    </div>
  );
}
