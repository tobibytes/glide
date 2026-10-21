/**
 * Tab on a free-text query: choose where the text goes (Quick AI, Glide Agent or the first
 * fallback). Pure helpers so the choice logic is unit-testable; the last choice is remembered.
 */
export type TabChoiceId = "ai" | "agent" | "fallback";

export interface TabChoice {
  id: TabChoiceId;
  title: string;
  subtitle?: string;
}

const KEY = "glide:tab-choice";

export function loadTabChoice(): TabChoiceId | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "ai" || v === "agent" || v === "fallback" ? v : null;
  } catch {
    return null;
  }
}

export function saveTabChoice(id: TabChoiceId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable */
  }
}

/** Index to preselect: the remembered choice if offered, else the first option. */
export function initialChoiceIndex(options: readonly TabChoice[], remembered: TabChoiceId | null): number {
  const i = remembered ? options.findIndex((o) => o.id === remembered) : -1;
  return i >= 0 ? i : 0;
}
