/**
 * Vim-style keyboard model shared by the root search list, <NavList> and every
 * launcher view. `vimKey` is a pure function: (state, key, context) -> command.
 * Consumers apply the command (move selection, run an action, change mode…).
 *
 * INSERT mode (typing in the search field) always has: ↑/↓, ⌃J/⌃K, ⌃N/⌃P,
 * ⌃D/⌃U, ⌥↑/⌥↓ page, ⌘↑/⌘↓ section, ⏎ / ⌘⏎, ⌘K, Backspace-on-empty pops a view.
 * NORMAL mode (vim on, after Esc): j k gg G ⌃D ⌃U { } l o O h x y p / i a . q Esc + counts.
 */
import { createContext, useContext } from "react";

export type VimMode = "insert" | "normal";

export interface Modifiers {
  cmd: boolean;
  shift: boolean;
  alt: boolean;
}

export type VimCommand =
  | { type: "move"; delta: number }
  /** index into the item rows; "last" = bottom */
  | { type: "goto"; index: number | "last" }
  /** half a page; `count` repetitions in direction `dir` */
  | { type: "halfPage"; dir: 1 | -1; count: number }
  | { type: "section"; dir: 1 | -1; count: number }
  | { type: "activate"; mods: Modifiers }
  | { type: "secondary" }
  | { type: "actions" }
  | { type: "delete" }
  | { type: "copy" }
  | { type: "paste" }
  | { type: "pop" }
  | { type: "clearQuery" }
  | { type: "hide" }
  | { type: "normal" }
  | { type: "insert"; clear: boolean };

/** Commands that only move the selection (applied by the list's keyboard core). */
export type NavCommand = Extract<VimCommand, { type: "move" | "goto" | "halfPage" | "section" }>;

export interface VimKey {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface VimContextInput {
  /** Settings.vimMode */
  enabled: boolean;
  mode: VimMode;
  /** the search field is empty */
  queryEmpty: boolean;
  /** a view is pushed above the root search */
  viewPushed: boolean;
  /** timestamp (ms) of this key press; used for the gg window */
  now: number;
}

export interface VimState {
  /** typed count prefix, e.g. "12" */
  count: string;
  /** time of a pending first "g", or null */
  gAt: number | null;
}

export const INITIAL_VIM_STATE: VimState = { count: "", gAt: null };
/** Max delay between the two presses of "gg". */
export const GG_WINDOW_MS = 500;

export interface VimResult {
  state: VimState;
  command: VimCommand | null;
  /** true when the key must not reach the input (preventDefault) */
  consumed: boolean;
}

const none = (state: VimState, consumed = false): VimResult => ({ state, command: null, consumed });
const cmd = (command: VimCommand): VimResult => ({ state: INITIAL_VIM_STATE, command, consumed: true });

/** Shared by both modes: arrows, ctrl alternates, ⌘K, Enter. Returns null if the key isn't one of them. */
function commonKey(k: VimKey, n: number): VimCommand | null {
  const { key } = k;
  const ctrl = !!k.ctrl && !k.meta && !k.alt;
  if (key === "ArrowDown" || key === "ArrowUp") {
    const dir = key === "ArrowDown" ? 1 : -1;
    if (k.meta) return { type: "section", dir, count: n };
    if (k.alt) return { type: "move", delta: dir * 5 * n };
    if (k.ctrl) return null;
    return { type: "move", delta: dir * n };
  }
  if (ctrl) {
    const lower = key.toLowerCase();
    if (lower === "j" || lower === "n") return { type: "move", delta: n };
    if (lower === "k" || lower === "p") return { type: "move", delta: -n };
    if (lower === "d") return { type: "halfPage", dir: 1, count: n };
    if (lower === "u") return { type: "halfPage", dir: -1, count: n };
  }
  if (k.meta && !k.ctrl && !k.alt && key.toLowerCase() === "k") return { type: "actions" };
  if (key === "Enter") {
    if (k.meta && !k.shift && !k.alt && !k.ctrl) return { type: "secondary" };
    return { type: "activate", mods: { cmd: !!k.meta, shift: !!k.shift, alt: !!k.alt } };
  }
  return null;
}

export function vimKey(state: VimState, k: VimKey, ctx: VimContextInput): VimResult {
  const normal = ctx.enabled && ctx.mode === "normal";
  if (!normal) return insertKey(state, k, ctx);
  return normalKey(state, k, ctx);
}

function insertKey(state: VimState, k: VimKey, ctx: VimContextInput): VimResult {
  if (k.key === "Escape" && !k.meta && !k.ctrl && !k.alt) {
    if (ctx.enabled) return cmd(!ctx.queryEmpty || ctx.viewPushed ? { type: "normal" } : { type: "hide" });
    if (!ctx.queryEmpty) return cmd({ type: "clearQuery" });
    return cmd(ctx.viewPushed ? { type: "pop" } : { type: "hide" });
  }
  if (k.key === "Backspace" && ctx.queryEmpty && ctx.viewPushed && !k.meta && !k.ctrl && !k.alt) return cmd({ type: "pop" });
  const c = commonKey(k, 1);
  return c ? cmd(c) : none(INITIAL_VIM_STATE);
}

function normalKey(state: VimState, k: VimKey, ctx: VimContextInput): VimResult {
  const { key } = k;
  const n = Math.max(1, Number(state.count) || 1);
  const plain = !k.meta && !k.ctrl && !k.alt;

  // Modifier keys alone never reset a pending count or "g".
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return none(state);

  if (key === "Escape" && plain) return cmd({ type: "hide" });
  const common = commonKey(k, n);
  if (common) return cmd(common);
  if (!plain) {
    // ⌘-shortcuts (⌘C, ⇧⌘F …) fall through to the item's action shortcuts.
    return none(INITIAL_VIM_STATE);
  }

  if (/^[0-9]$/.test(key) && (key !== "0" || state.count)) {
    return { state: { count: state.count + key, gAt: null }, command: null, consumed: true };
  }

  if (key === "g") {
    if (state.gAt !== null && ctx.now - state.gAt <= GG_WINDOW_MS) return cmd({ type: "goto", index: state.count ? n - 1 : 0 });
    return { state: { count: state.count, gAt: ctx.now }, command: null, consumed: true };
  }

  switch (key) {
    case "j":
      return cmd({ type: "move", delta: n });
    case "k":
      return cmd({ type: "move", delta: -n });
    case "G":
      return cmd({ type: "goto", index: state.count ? n - 1 : "last" });
    case "}":
      return cmd({ type: "section", dir: 1, count: n });
    case "{":
      return cmd({ type: "section", dir: -1, count: n });
    case "l":
    case "o":
      return cmd({ type: "activate", mods: { cmd: false, shift: false, alt: false } });
    case "O":
      return cmd({ type: "secondary" });
    case "h":
    case "Backspace":
      return cmd(ctx.viewPushed ? { type: "pop" } : { type: "clearQuery" });
    case "x":
      return cmd({ type: "delete" });
    case "y":
      return cmd({ type: "copy" });
    case "p":
      return cmd({ type: "paste" });
    case "i":
    case "a":
      return cmd({ type: "insert", clear: false });
    case "/":
      return cmd({ type: "insert", clear: true });
    case ".":
      return cmd({ type: "actions" });
    case "q":
      return cmd({ type: "hide" });
    case "Tab":
      return none(INITIAL_VIM_STATE);
  }
  // Any other printable key is swallowed so NORMAL mode never types into the field.
  return none(INITIAL_VIM_STATE, key.length === 1);
}

// ---------------------------------------------------------------------------
// Mode transitions (pure; the launcher applies them)
// ---------------------------------------------------------------------------

export type ModeEvent =
  | { type: "command"; command: VimCommand }
  /** a view was pushed / popped, or the launcher was shown */
  | { type: "push" }
  | { type: "pop" }
  | { type: "show" }
  /** the user started typing via a chooser/prompt that needs the field */
  | { type: "needsInput" };

/**
 * The mode after an event. Pushing, popping and showing always land in INSERT so the search
 * field is never left read-only (a pop from NORMAL via h/⌫ used to keep NORMAL).
 */
export function modeAfter(mode: VimMode, ev: ModeEvent): VimMode {
  switch (ev.type) {
    case "push":
    case "pop":
    case "show":
    case "needsInput":
      return "insert";
    case "command":
      if (ev.command.type === "normal") return "normal";
      if (ev.command.type === "insert" || ev.command.type === "pop") return "insert";
      return mode;
  }
}

// ---------------------------------------------------------------------------
// Action panel (⌘K) in NORMAL mode
// ---------------------------------------------------------------------------

export type PanelCommand = { type: "move"; delta: number } | { type: "run" } | { type: "close" } | { type: "filter" };

/** Keys inside the action panel when it was opened in NORMAL mode and is not filtering. */
export function vimPanelKey(k: VimKey): PanelCommand | null {
  const plain = !k.meta && !k.ctrl && !k.alt;
  if (k.key === "ArrowDown" || (plain && k.key === "j") || (k.ctrl && (k.key === "j" || k.key === "n"))) return { type: "move", delta: 1 };
  if (k.key === "ArrowUp" || (plain && k.key === "k") || (k.ctrl && (k.key === "k" || k.key === "p"))) return { type: "move", delta: -1 };
  if (k.key === "Enter" || (plain && k.key === "l")) return { type: "run" };
  if (k.key === "Escape" || (plain && k.key === "h") || (k.meta && k.key.toLowerCase() === "k")) return { type: "close" };
  if (plain && (k.key === "/" || k.key === "i")) return { type: "filter" };
  return null;
}

// ---------------------------------------------------------------------------
// Keyboard core: apply a NavCommand to a list selection
// ---------------------------------------------------------------------------

export interface NavShape {
  /** number of selectable rows */
  length: number;
  /** section key per row (same length) — consecutive equal keys form a section */
  sections?: readonly (string | undefined)[];
  /** rows per half page (default 5) */
  halfPage?: number;
}

/** Returns the next selected index (clamped; -1 when the list is empty). */
export function applyNav(command: NavCommand, index: number, shape: NavShape): number {
  const { length } = shape;
  if (length <= 0) return -1;
  const clamp = (i: number) => Math.min(length - 1, Math.max(0, i));
  const cur = clamp(index < 0 ? 0 : index);
  switch (command.type) {
    case "move":
      return clamp(cur + command.delta);
    case "goto":
      return command.index === "last" ? length - 1 : clamp(command.index);
    case "halfPage":
      return clamp(cur + command.dir * Math.max(1, shape.halfPage ?? 5) * command.count);
    case "section": {
      let i = cur;
      for (let c = 0; c < command.count; c++) i = sectionJump(i, command.dir, shape);
      return i;
    }
  }
}

function sectionJump(index: number, dir: 1 | -1, shape: NavShape): number {
  const secs = shape.sections;
  const last = shape.length - 1;
  if (!secs || secs.length !== shape.length) return dir > 0 ? last : 0;
  const start = (i: number) => {
    while (i > 0 && secs[i - 1] === secs[i]) i--;
    return i;
  };
  if (dir > 0) {
    let i = index;
    while (i <= last && secs[i] === secs[index]) i++;
    return i > last ? last : i;
  }
  const s = start(index);
  // Not at the top of this section: go to its top (like vim's "{"). Otherwise previous section's top.
  if (s < index) return s;
  return s === 0 ? 0 : start(s - 1);
}

// ---------------------------------------------------------------------------
// Helpers to classify actions for x / y / p
// ---------------------------------------------------------------------------

export interface ActionLike {
  title: string;
  destructive?: boolean;
}

export function findActionOfKind<A extends ActionLike>(actions: readonly A[], kind: "delete" | "copy" | "paste"): A | undefined {
  if (kind === "delete") return actions.find((a) => a.destructive) ?? actions.find((a) => /^(delete|remove|clear)\b/i.test(a.title));
  if (kind === "copy") return actions.find((a) => /^copy\b/i.test(a.title));
  return actions.find((a) => /^paste\b/i.test(a.title));
}

export function toVimKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): VimKey {
  return { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey };
}

// ---------------------------------------------------------------------------
// React context: the current mode, readable by any view (e.g. the emoji grid)
// ---------------------------------------------------------------------------

export interface VimInfo {
  /** Settings.vimMode */
  enabled: boolean;
  mode: VimMode;
  setMode(mode: VimMode): void;
}

export const VimContext = createContext<VimInfo>({ enabled: false, mode: "insert", setMode: () => {} });

/** Current vim mode. In NORMAL mode the search field is read-only; views should treat j/k/… as navigation. */
export function useVim(): VimInfo {
  return useContext(VimContext);
}

/** Rows for the cheat sheet in Settings → About. */
export const VIM_CHEATSHEET: Array<[string, string]> = [
  ["Enter NORMAL mode", "⎋"],
  ["Down / up", "j k"],
  ["Top / bottom", "gg G"],
  ["Half page down / up", "⌃D ⌃U"],
  ["Next / previous section", "} {"],
  ["Run primary action", "l o ⏎"],
  ["Run secondary action", "O ⌘⏎"],
  ["Back (pop view / clear query)", "h ⌫"],
  ["Delete (press twice)", "x"],
  ["Copy / paste action", "y p"],
  ["Insert (keep / clear query)", "i /"],
  ["Action panel", ". ⌘K"],
  ["Repeat (e.g. 5j)", "1-9"],
  ["Hide launcher", "q ⎋"],
  ["Move in any mode", "⌃J ⌃K ⌃N ⌃P"],
];
