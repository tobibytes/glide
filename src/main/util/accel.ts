/** Convert an Electron accelerator ("Alt+Cmd+K") into a macOS display string ("⌥⌘K"). */
const SYMBOLS: Record<string, string> = {
  cmd: "⌘",
  command: "⌘",
  cmdorctrl: "⌘",
  commandorcontrol: "⌘",
  super: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  space: "␣",
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
};

// Modifier order mirrors the macOS convention: ⌃ ⌥ ⇧ ⌘.
const ORDER = ["⌃", "⌥", "⇧", "⌘"];

export function accelToDisplay(accel: string): string {
  const parts = accel.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const sym = SYMBOLS[part.toLowerCase()];
    if (sym && ORDER.includes(sym)) mods.push(sym);
    else keys.push(sym ?? part.toUpperCase());
  }
  mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return [...mods, ...keys].join("");
}

/** Loose validation: at least one key and only known tokens. */
export function isValidAccelerator(accel: string): boolean {
  const parts = accel.split("+").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !p)) return false;
  return parts.every((p) => p.length <= 24);
}
