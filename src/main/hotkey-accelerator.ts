/**
 * Accelerator grammar shared by the Electron fallback and the Swift helper (Hotkeys.swift mirrors this;
 * both are checked against src/native/hotkey-accelerators.json).
 *
 * - Combos: Electron accelerators ("CommandOrControl+Shift+K", "Alt+Space", "F5", "Cmd+Plus") plus "Hyper+K"
 *   (⌃⌥⇧⌘) and glyph forms ("⇧⌘K").
 * - Modifier-only: "[Double+][Left+|Right+]<Cmd|Alt|Ctrl|Shift>" and "[Double+]Hyper" (Caps Lock as Hyper,
 *   tapped alone); glyph forms "Double⌘", "Right⌥" are accepted.
 */

export type HotkeyModifier = "ctrl" | "alt" | "shift" | "cmd";
export type ModifierOnlyKey = HotkeyModifier | "hyper";

export type ParsedAccelerator =
  | { kind: "combo"; mods: HotkeyModifier[]; key: string; canonical: string }
  | { kind: "modifier"; mod: ModifierOnlyKey; side: "left" | "right" | "either"; double: boolean; canonical: string };

export type ParseResult = ParsedAccelerator | { error: string };

const MOD_ORDER: HotkeyModifier[] = ["ctrl", "alt", "shift", "cmd"];
const MOD_NAME: Record<HotkeyModifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Cmd" };

const MODIFIERS: Record<string, HotkeyModifier[]> = {
  command: ["cmd"], cmd: ["cmd"], super: ["cmd"], meta: ["cmd"],
  commandorcontrol: ["cmd"], cmdorctrl: ["cmd"],
  control: ["ctrl"], ctrl: ["ctrl"],
  alt: ["alt"], option: ["alt"], altgr: ["alt"],
  shift: ["shift"],
  hyper: ["ctrl", "alt", "shift", "cmd"],
};

/** Canonical name for every named key (lower-case alias → name). Keycodes live in Hotkeys.swift. */
const NAMED_KEYS: Record<string, string> = {
  space: "Space", tab: "Tab", return: "Return", enter: "Return", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", insert: "Insert", help: "Insert",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", plus: "Plus",
  numdec: "numdec", numadd: "numadd", numsub: "numsub", nummult: "nummult", numdiv: "numdiv",
};
for (let i = 1; i <= 20; i++) NAMED_KEYS[`f${i}`] = `F${i}`;
for (let i = 0; i <= 9; i++) NAMED_KEYS[`num${i}`] = `num${i}`;

const UNSUPPORTED = /^(f2[1-4]|volumeup|volumedown|volumemute|medianexttrack|mediaprevioustrack|mediastop|mediaplaypause|printscreen|numlock|scrolllock|capslock)$/;

const GLYPHS: Record<string, string> = { "⌘": "Cmd", "⌥": "Alt", "⌃": "Ctrl", "⇧": "Shift", "✦": "Hyper" };

function tokenize(input: string): string[] {
  let s = input.trim();
  // Glyphs become separate tokens: "⇧⌘K" → "Shift+Cmd+K", "Double⌘" → "Double+Cmd".
  s = s.replace(/[⌘⌥⌃⇧✦]/g, (g) => `+${GLYPHS[g]}+`);
  return s.split("+").map((t) => t.trim()).filter(Boolean);
}

export function parseAccelerator(input: string): ParseResult {
  const tokens = tokenize(input);
  if (tokens.length === 0) return { error: "Empty shortcut" };
  const last = tokens[tokens.length - 1]!;
  const lastLower = last.toLowerCase();

  // Modifier-only: the final token is a modifier and everything before it is Double/Left/Right.
  if (MODIFIERS[lastLower]) {
    const prefixes = tokens.slice(0, -1).map((t) => t.toLowerCase());
    if (prefixes.some((p) => p !== "double" && p !== "left" && p !== "right")) return { error: "A shortcut needs a key besides modifiers (or use Double/Left/Right with one modifier)" };
    const double = prefixes.includes("double");
    const sides = prefixes.filter((p) => p === "left" || p === "right");
    if (sides.length > 1 || new Set(prefixes).size !== prefixes.length) return { error: "Invalid modifier-only shortcut" };
    const side = (sides[0] as "left" | "right" | undefined) ?? "either";
    const mod: ModifierOnlyKey = lastLower === "hyper" ? "hyper" : MODIFIERS[lastLower]![0]!;
    if (mod === "hyper" && side !== "either") return { error: "Hyper has no left/right side" };
    if (!double && side === "either" && mod !== "hyper") return { error: "A modifier alone needs Left/Right or Double (e.g. Right+Alt, Double+Cmd)" };
    const canonical = [double ? "Double" : "", side === "left" ? "Left" : side === "right" ? "Right" : "", mod === "hyper" ? "Hyper" : MOD_NAME[mod]].filter(Boolean).join("+");
    return { kind: "modifier", mod, side, double, canonical };
  }

  const mods = new Set<HotkeyModifier>();
  for (const t of tokens.slice(0, -1)) {
    const m = MODIFIERS[t.toLowerCase()];
    if (!m) return { error: `Unknown modifier "${t}"` };
    for (const x of m) mods.add(x);
  }
  const key = canonicalKey(last);
  if ("error" in key) return key;
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return { kind: "combo", mods: ordered, key: key.key, canonical: [...ordered.map((m) => MOD_NAME[m]), key.key].join("+") };
}

function canonicalKey(token: string): { key: string } | { error: string } {
  const lower = token.toLowerCase();
  if (UNSUPPORTED.test(lower)) return { error: `"${token}" cannot be used as a global hotkey on macOS` };
  const named = NAMED_KEYS[lower];
  if (named) return { key: named };
  if ([...token].length === 1) return { key: token.toUpperCase() };
  if (lower === "double" || lower === "left" || lower === "right") return { error: `"${token}" must be followed by a modifier` };
  return { error: `Unknown key "${token}"` };
}

/** Canonical form for de-duplication, or null when the string does not parse. */
export function canonicalAccelerator(input: string): string | null {
  const p = parseAccelerator(input);
  return "error" in p ? null : p.canonical;
}

/** Electron's globalShortcut accepts combos only; Hyper is expanded, glyphs are spelled out. */
export function toElectronAccelerator(p: ParsedAccelerator): string | null {
  return p.kind === "combo" ? p.canonical : null;
}
