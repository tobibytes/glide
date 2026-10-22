/**
 * Keyboard helpers: Electron accelerators <-> macOS display glyphs, plus
 * matching of action-shortcut glyph strings ("⇧⌘C") against KeyboardEvents.
 */

const MOD_GLYPH: Record<string, string> = { ctrl: "⌃", control: "⌃", alt: "⌥", option: "⌥", shift: "⇧", cmd: "⌘", command: "⌘", cmdorctrl: "⌘", commandorcontrol: "⌘", super: "⌘", meta: "⌘" };
const KEY_GLYPH: Record<string, string> = {
  space: "Space",
  enter: "⏎",
  return: "⏎",
  tab: "⇥",
  esc: "⎋",
  escape: "⎋",
  backspace: "⌫",
  delete: "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  home: "↖",
  end: "↘",
  pageup: "⇞",
  pagedown: "⇟",
};
const MOD_ORDER = ["⌃", "⌥", "⇧", "⌘"];

const SIDE_MODS: Record<string, string> = { cmd: "⌘", command: "⌘", alt: "⌥", option: "⌥", ctrl: "⌃", control: "⌃", shift: "⇧", hyper: "Hyper" };

/** Modifier-only shortcuts: "Double+Cmd" -> "Double ⌘", "Right+Alt" -> "Right ⌥", "Hyper" -> "Hyper". Null for combos. */
export function modifierOnlyDisplay(accel: string): string | null {
  const parts = accel.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const last = parts.at(-1);
  if (!last || !SIDE_MODS[last] || !parts.slice(0, -1).every((p) => p === "double" || p === "left" || p === "right")) return null;
  if (parts.length === 1 && last !== "hyper") return null;
  const words = parts.slice(0, -1).map((p) => p[0]!.toUpperCase() + p.slice(1));
  return [...words, SIDE_MODS[last]].join(" ");
}

/** "Alt+Space" -> "⌥ Space"; "Cmd+Shift+K" -> "⇧⌘K"; "Hyper+K" -> "⌃⌥⇧⌘K". */
export function accelToDisplay(accel: string): string {
  const modOnly = modifierOnlyDisplay(accel);
  if (modOnly) return modOnly;
  const parts = accel
    .split("+")
    .flatMap((p) => (p.trim().toLowerCase() === "hyper" ? ["Ctrl", "Alt", "Shift", "Cmd"] : [p]))
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    const m = MOD_GLYPH[p.toLowerCase()];
    if (m) mods.push(m);
    else keys.push(KEY_GLYPH[p.toLowerCase()] ?? p.toUpperCase());
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const key = keys.join("");
  const wide = key.length > 1 && !/^[⏎⇥⎋⌫⌦↑↓←→↖↘⇞⇟]$/.test(key);
  return mods.join("") + (wide && mods.length ? " " : "") + key;
}

/** Convert a KeyboardEvent into an Electron accelerator, or null if it is only modifiers. */
export function eventToAccelerator(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const key = e.key;
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Dead", "Unidentified"].includes(key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Cmd");
  const named: Record<string, string> = {
    " ": "Space",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Esc",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  let k = named[key];
  if (!k) {
    if (/^F\d{1,2}$/.test(key)) k = key;
    else if (e.code.startsWith("Key")) k = e.code.slice(3).toUpperCase();
    else if (e.code.startsWith("Digit")) k = e.code.slice(5);
    else if (key.length === 1) k = key.toUpperCase();
    else return null;
  }
  // A bare printable key without modifiers is not a usable global hotkey (function keys are).
  if (mods.length === 0 && !/^F\d{1,2}$/.test(k)) return null;
  return [...mods, k].join("+");
}

export interface ParsedShortcut {
  cmd: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  key: string; // lowercase key name
}

/** Parse a glyph shortcut like "⇧⌘C" or "⌘⏎" (as used by ItemAction.shortcut). */
export function parseShortcut(s: string): ParsedShortcut | null {
  const out: ParsedShortcut = { cmd: false, shift: false, alt: false, ctrl: false, key: "" };
  let rest = "";
  for (const ch of s) {
    if (ch === "⌘") out.cmd = true;
    else if (ch === "⇧") out.shift = true;
    else if (ch === "⌥") out.alt = true;
    else if (ch === "⌃") out.ctrl = true;
    else rest += ch;
  }
  const map: Record<string, string> = { "⏎": "enter", "⇥": "tab", "⎋": "escape", "⌫": "backspace", "⌦": "delete", "↑": "arrowup", "↓": "arrowdown", "←": "arrowleft", "→": "arrowright", space: " " };
  const k = map[rest.toLowerCase()] ?? rest.toLowerCase();
  if (!k) return null;
  out.key = k;
  return out;
}

export function eventMatchesShortcut(e: KeyboardEvent | React.KeyboardEvent, shortcut: string): boolean {
  const p = parseShortcut(shortcut);
  if (!p) return false;
  if (p.cmd !== e.metaKey || p.shift !== e.shiftKey || p.alt !== e.altKey || p.ctrl !== e.ctrlKey) return false;
  const key = e.key.toLowerCase();
  if (key === p.key) return true;
  // Letter keys: compare by physical code so Shift/Alt variants still match.
  if (p.key.length === 1 && e.code.toLowerCase() === `key${p.key}`) return true;
  return false;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
