/**
 * Keyboard-navigable list used by the launcher and every feature view.
 *
 * Inside the launcher the search field owns the keyboard: the launcher maps keys
 * through lib/vim.ts and forwards commands to the NavList via NavHostContext, so
 * every view gets the same ↑/↓, ⌃J/⌃K, ⌃D/⌃U, ⌘K, ⏎/⌘⏎ and, in vim NORMAL mode,
 * j/k/gg/G/{ }/l/o/O/x/y/p/. bindings. Outside the launcher (a settings page or a
 * feature window) it listens on window keydown: arrows/⌃J/⌃K/⏎/⌘K everywhere, and — when
 * Settings.vimMode is on and focus is not in a text field — the NORMAL-mode keys too
 * (j k gg G counts { } l o O x y p .). Pass `vimKeys={false}` to opt out.
 *
 * Programmatic API: pass `ref` (React 19 ref prop) to get a NavListHandle —
 * select(id | index), selected(), selectedIndex(), scrollIntoView(), nav(command), activate().
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { UserData } from "@shared/types";
import { glide } from "../lib/glide";
import type { NavAction, NavItem, NavListProps } from "../features/types";
import { useListNav, halfPageOf } from "../hooks/useListNav";
import { useNavController, useNavHost, type NavController } from "../lib/navHost";
import { findActionOfKind, INITIAL_VIM_STATE, toVimKey, vimKey, type Modifiers, type NavCommand, type VimCommand, type VimState } from "../lib/vim";
import { eventMatchesShortcut } from "../lib/keys";
import { ActionPanel } from "./ActionPanel";
import { pointerReallyMoved } from "../lib/pointer";

export interface NavListHandle<T extends NavItem = NavItem> {
  /** Select by item id or row index; returns false when there is no such row. */
  select(target: string | number): boolean;
  selected(): T | null;
  selectedIndex(): number;
  /** Scroll the selected row (or the given id/index) into view. */
  scrollIntoView(target?: string | number): void;
  nav(command: NavCommand): void;
  /** Run Enter on the selected row. */
  activate(mods?: Partial<Modifiers>): void;
}

export interface NavListExtraProps<T extends NavItem = NavItem> {
  /** Title shown at the top of the ⌘K panel (default: "Actions"). */
  actionsTitle?: string;
  /** Extra class on the root element. */
  className?: string;
  /** Programmatic control (React 19: `ref` is a plain prop on function components). */
  ref?: Ref<NavListHandle<T>>;
  /** Outside the launcher: bind vim NORMAL keys when Settings.vimMode is on (default true). */
  vimKeys?: boolean;
}

const NO_MODS: Modifiers = { cmd: false, shift: false, alt: false };
const DELETE_CONFIRM_MS = 3000;

const isTextTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
};

// Settings.vimMode for standalone lists (settings pages, feature windows); one shared subscription.
let vimSetting: boolean | null = null;
const vimListeners = new Set<(v: boolean) => void>();
let vimSubscribed = false;
function subscribeVimSetting(cb: (v: boolean) => void): () => void {
  vimListeners.add(cb);
  if (!vimSubscribed && typeof window !== "undefined" && window.glide) {
    vimSubscribed = true;
    const set = (d: UserData) => {
      vimSetting = d.settings.vimMode !== false;
      for (const l of vimListeners) l(vimSetting);
    };
    void glide().getData().then(set).catch(() => undefined);
    glide().onDataChanged(set);
  }
  return () => vimListeners.delete(cb);
}
function useVimSetting(active: boolean): boolean {
  const [on, setOn] = useState(vimSetting ?? false);
  useEffect(() => (active ? subscribeVimSetting(setOn) : undefined), [active]);
  return active && on;
}

// With several standalone lists on a page, keys go to the one used last (else the newest).
const standaloneLists: object[] = [];
const isActiveStandalone = (token: object) => standaloneLists[standaloneLists.length - 1] === token;
const touchStandalone = (token: object) => {
  const i = standaloneLists.indexOf(token);
  if (i >= 0) standaloneLists.splice(i, 1);
  standaloneLists.push(token);
};

export function NavList<T extends NavItem>(props: NavListProps<T> & NavListExtraProps<T>) {
  const { items, renderItem, onActivate, detail, onSelectionChange, emptyText, actions, preserveSelection, actionsTitle, className, ref, vimKeys } = props;
  const host = useNavHost();
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const vimOn = useVimSetting(!host && vimKeys !== false);
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

  const indexOf = (target: string | number): number => (typeof target === "number" ? (Number.isInteger(target) && target >= 0 && target < items.length ? target : -1) : keys.indexOf(target));
  useImperativeHandle(
    ref,
    (): NavListHandle<T> => ({
      select: (target) => {
        const i = indexOf(target);
        if (i < 0) return false;
        nav.select(keys[i]);
        return true;
      },
      selected: () => selected,
      selectedIndex: () => nav.index,
      scrollIntoView: (target) => {
        const i = target === undefined ? nav.index : indexOf(target);
        const id = i >= 0 ? keys[i] : undefined;
        if (id !== undefined) document.getElementById(`nav-${id}`)?.scrollIntoView({ block: "nearest" });
      },
      nav: (c) => nav.apply(c),
      activate: (mods) => {
        if (selected) onActivate(selected, { ...NO_MODS, ...mods });
      },
    }),
  );

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

  // Standalone (no launcher host): own the keyboard. INSERT bindings always; NORMAL bindings when vim
  // is on and focus is not in a text field.
  const ctlRef = useRef(controller);
  ctlRef.current = controller;
  const vimOnRef = useRef(vimOn);
  vimOnRef.current = vimOn;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  useEffect(() => {
    if (host) return;
    const token = {};
    touchStandalone(token);
    const root = rootRef.current;
    const touch = () => touchStandalone(token);
    root?.addEventListener("focusin", touch);
    root?.addEventListener("mousedown", touch);
    let vimState: VimState = INITIAL_VIM_STATE;
    let deleteArm: { title: string; at: number } | null = null;

    const apply = (c: VimCommand): boolean => {
      const ctl = ctlRef.current;
      switch (c.type) {
        case "move":
        case "goto":
        case "halfPage":
        case "section":
          ctl.nav(c);
          return true;
        case "activate":
          ctl.activate(c.mods);
          return true;
        case "secondary":
          ctl.secondary();
          return true;
        case "actions":
          ctl.toggleActions();
          return true;
        case "delete":
        case "copy":
        case "paste":
          void ctl.findAction(c.type).then((a) => {
            if (!a) return;
            if (c.type !== "delete") return void a.run();
            if (deleteArm && deleteArm.title === a.title && Date.now() - deleteArm.at < DELETE_CONFIRM_MS) {
              deleteArm = null;
              return void a.run();
            }
            deleteArm = { title: a.title, at: Date.now() };
          });
          return true;
        default:
          return false; // pop / hide / insert …: the page decides
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isActiveStandalone(token) || e.isComposing) return;
      const text = isTextTarget(e.target);
      const tag = (e.target as HTMLElement | null)?.tagName;
      // Multi-line editors and pickers keep every key.
      if (text && tag !== "INPUT") return;
      // NORMAL keys only when focus is on nothing in particular or inside this list — a focused
      // sidebar/button elsewhere keeps its own letter keys.
      const t = e.target instanceof Node ? e.target : null; // window-dispatched events have no node
      const neutral = !t || t === document.body || t === document.documentElement || !!rootRef.current?.contains(t);
      const normal = vimOnRef.current && !text && !panelRef.current && neutral;
      if (!normal) {
        const r = vimKey(INITIAL_VIM_STATE, toVimKey(e), { enabled: false, mode: "insert", queryEmpty: true, viewPushed: false, now: e.timeStamp });
        if (!r.command) {
          if ((e.metaKey || e.ctrlKey) && ctlRef.current.shortcut?.(e)) e.preventDefault();
          return;
        }
        if (r.command.type === "move" || r.command.type === "goto" || r.command.type === "halfPage" || r.command.type === "section" || r.command.type === "activate" || r.command.type === "secondary" || r.command.type === "actions") {
          apply(r.command);
          e.preventDefault();
        }
        return;
      }
      const r = vimKey(vimState, toVimKey(e), { enabled: true, mode: "normal", queryEmpty: true, viewPushed: false, now: e.timeStamp });
      vimState = r.state;
      const c = r.command;
      if (!c) {
        if ((e.metaKey || e.ctrlKey) && ctlRef.current.shortcut?.(e)) e.preventDefault();
        return;
      }
      const plainLetter = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (!plainLetter) {
        if (apply(c)) e.preventDefault();
        return;
      }
      // Letters (j, k, G, x …): let the page's own listeners claim the key first (they run after
      // ours, children register first); act only if nobody prevented it.
      setTimeout(() => {
        if (!e.defaultPrevented) apply(c);
      }, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      root?.removeEventListener("focusin", touch);
      root?.removeEventListener("mousedown", touch);
      const i = standaloneLists.indexOf(token);
      if (i >= 0) standaloneLists.splice(i, 1);
    };
  }, [host]);

  const headers = useMemo(() => items.map((it, i) => (it.section && it.section !== items[i - 1]?.section ? it.section : null)), [items]);
  const cls = ["navlist", detail ? "navlist--split" : "", host ? "" : "navlist--standalone", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={cls} ref={rootRef} data-vim={!host && vimOn ? "normal" : undefined}>
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
