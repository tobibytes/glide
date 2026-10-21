import { useCallback, useState } from "react";
import { applyNav, type NavCommand } from "../lib/vim";

export interface ListNav {
  /** effective selected index (-1 when empty) — derived during render, never lags a frame */
  index: number;
  selectedKey: string | null;
  select(key: string | null): void;
  apply(command: NavCommand): void;
}

/**
 * Keyboard core shared by the root list and <NavList>. If the stored key is not in
 * `keys` (new results, first render) the first row is selected in the same render.
 */
export function useListNav(keys: readonly string[], opts: { sections?: readonly (string | undefined)[]; preserve?: boolean; halfPage?: () => number } = {}): ListNav {
  const [stored, setStored] = useState<string | null>(null);
  const [prevKeys, setPrevKeys] = useState(keys);
  if (keys !== prevKeys) {
    setPrevKeys(keys);
    if (opts.preserve === false && stored !== null) setStored(null);
  }
  const preserve = opts.preserve !== false || keys === prevKeys;
  let index = stored !== null && preserve ? keys.indexOf(stored) : -1;
  if (index < 0) index = keys.length ? 0 : -1;
  const selectedKey = index >= 0 ? keys[index] : null;

  const { sections, halfPage } = opts;
  const apply = useCallback(
    (command: NavCommand) => {
      const next = applyNav(command, index, { length: keys.length, sections, halfPage: halfPage?.() });
      if (next >= 0) setStored(keys[next]);
    },
    [index, keys, sections, halfPage],
  );
  return { index, selectedKey, select: setStored, apply };
}

/** Rows per half page for a scroll container with ~40px rows. */
export function halfPageOf(el: HTMLElement | null, rowHeight = 40): number {
  if (!el) return 5;
  return Math.max(1, Math.floor(el.clientHeight / rowHeight / 2));
}
