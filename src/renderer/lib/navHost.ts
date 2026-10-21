/**
 * Bridge between the launcher (which owns the search field and the key handler)
 * and the list currently on screen (root results or a view's <NavList>).
 * A custom view that is not a NavList can call useNavController() to receive
 * the same vim/arrow commands.
 */
import { createContext, useContext, useEffect, useRef } from "react";
import type { Modifiers, NavCommand } from "./vim";

export interface FoundAction {
  title: string;
  run(): void | Promise<void>;
}

export interface NavController {
  /** j/k/gg/G/⌃D/⌃U/{ }/arrows */
  nav(command: NavCommand): void;
  /** ⏎ / l / o */
  activate(mods: Modifiers): void;
  /** ⌘⏎ / O */
  secondary(): void;
  /** ⌘K / . */
  toggleActions(): void;
  /** x / y / p: the selected item's delete / copy / paste action, if any */
  findAction(kind: "delete" | "copy" | "paste"): Promise<FoundAction | null>;
  /** Run an action whose shortcut matches this event (⌘C, ⇧⌘F …). Return true if one ran. */
  shortcut?(e: KeyboardEvent | React.KeyboardEvent): boolean | Promise<boolean>;
}

export interface NavFooter {
  /** title of the primary action (shown next to ⏎) */
  primary: string | null;
  hasActions: boolean;
}

export interface NavHost {
  register(controller: NavController): () => void;
  setFooter(footer: NavFooter | null): void;
  focusSearch(): void;
}

export const NavHostContext = createContext<NavHost | null>(null);

export function useNavHost(): NavHost | null {
  return useContext(NavHostContext);
}

/** Register a controller with the launcher for as long as the component is mounted. The latest object is always used. */
export function useNavController(controller: NavController, enabled = true): void {
  const host = useNavHost();
  const ref = useRef(controller);
  ref.current = controller;
  useEffect(() => {
    if (!host || !enabled) return;
    return host.register({
      nav: (c) => ref.current.nav(c),
      activate: (m) => ref.current.activate(m),
      secondary: () => ref.current.secondary(),
      toggleActions: () => ref.current.toggleActions(),
      findAction: (k) => ref.current.findAction(k),
      shortcut: (e) => ref.current.shortcut?.(e) ?? false,
    });
  }, [host, enabled]);
}
