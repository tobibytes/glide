/** Window-level keyboard model for the tour (pure, unit-tested). */

export type TourKeyCommand = "next" | "back" | "listNext" | "listPrev" | null;

export interface TourKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Focused element kind. */
  target: "text" | "button" | "option" | "other";
}

/**
 * Enter = continue (buttons keep their own Enter, text fields their own), ⌘⏎ / ⌘] = continue anywhere,
 * Esc / ⌘[ = back, j/k or ↓/↑ = move within the step's list (not while typing).
 */
export function tourKey(e: TourKeyInput): TourKeyCommand {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "[") return "back";
  if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "]") return "next";
  if (e.metaKey && e.key === "Enter") return "next";
  if (e.key === "Escape" && plain) return "back";
  if (e.key === "Enter" && plain && !e.shiftKey) return e.target === "button" || e.target === "text" ? null : "next";
  if (e.target === "text") return null;
  if (plain && !e.shiftKey && (e.key === "j" || e.key === "ArrowDown")) return "listNext";
  if (plain && !e.shiftKey && (e.key === "k" || e.key === "ArrowUp")) return "listPrev";
  if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "j" || e.key === "n")) return "listNext";
  if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "k" || e.key === "p")) return "listPrev";
  return null;
}

export function targetKind(el: Element | null): TourKeyInput["target"] {
  if (!el) return "other";
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable) return "text";
  const role = el.getAttribute("role");
  if (role === "radio" || role === "option") return "option";
  if (tag === "BUTTON" || tag === "A" || role === "button" || role === "switch" || role === "tab") return "button";
  return "other";
}
