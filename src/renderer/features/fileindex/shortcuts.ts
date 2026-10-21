import { useEffect, useRef } from "react";

/** One shortcut: modifiers + KeyboardEvent.code (layout-independent, so ⇧⌘. works). */
export interface Shortcut {
  code: string;
  meta?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

const GLYPH_CODES: Record<string, string> = { ".": "Period", ",": "Comma", "/": "Slash", "⏎": "Enter" };

/** "⇧⌘C" → {meta, shift, code: "KeyC"}. */
export function parseShortcut(glyphs: string): Shortcut | null {
  const s: Shortcut = { code: "" };
  for (const ch of glyphs) {
    if (ch === "⌘") s.meta = true;
    else if (ch === "⇧") s.shift = true;
    else if (ch === "⌃") s.ctrl = true;
    else if (ch === "⌥") s.alt = true;
    else s.code = GLYPH_CODES[ch] ?? (/[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : "");
  }
  return s.code ? s : null;
}

export function matches(e: KeyboardEvent, s: Shortcut): boolean {
  return e.code === s.code && e.metaKey === !!s.meta && e.shiftKey === !!s.shift && e.ctrlKey === !!s.ctrl && e.altKey === !!s.alt;
}

/**
 * View-level shortcuts, handled in the capture phase so a list's own handlers
 * never see (and double-handle) them.
 */
export function useShortcuts(bindings: Array<{ shortcut: string; run: () => void }>): void {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const b of ref.current) {
        const s = parseShortcut(b.shortcut);
        if (s && s.code !== "Enter" && matches(e, s)) {
          e.preventDefault();
          e.stopPropagation();
          b.run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
