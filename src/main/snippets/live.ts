/**
 * Live inputs for keyword expansion, shared between the snippets feature (which keeps them fresh)
 * and the keyboard feature (which sends the list to the helper). No Electron imports: the keyboard
 * config stays unit-testable.
 */
import { randomUUID } from "node:crypto";
import type { Snippet } from "@shared/types";
import { buildExpansionList, SNIPPET_DEFAULTS, type SnippetSettings } from "./expansion";

interface LiveState {
  settings: SnippetSettings;
  frontmostBundleId: string | null;
  clipboard: string;
}

const state: LiveState = { settings: SNIPPET_DEFAULTS, frontmostBundleId: null, clipboard: "" };
const listeners = new Set<() => void>();

/** Update inputs; listeners run only when something changed. */
export function setExpansionInputs(patch: Partial<LiveState>): void {
  let changed = false;
  for (const k of Object.keys(patch) as Array<keyof LiveState>) {
    const v = patch[k];
    if (v === undefined) continue;
    if (JSON.stringify(state[k]) !== JSON.stringify(v)) {
      (state as unknown as Record<string, unknown>)[k] = v;
      changed = true;
    }
  }
  if (changed) notifyExpansionChange();
}

/** Ask the keyboard feature to rebuild its config (e.g. a minute passed and {time} changed). */
export function notifyExpansionChange(): void {
  for (const l of listeners) l();
}

export function onExpansionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function expansionSettings(): SnippetSettings {
  return state.settings;
}

/** What the helper should watch for right now: prefix, case variants, exclusions and placeholders applied. */
export function liveExpansionList(snippets: Snippet[], now = new Date()): Array<{ keyword: string; text: string }> {
  return buildExpansionList({
    snippets,
    settings: state.settings,
    env: { now, clipboard: state.clipboard, uuid: randomUUID },
    frontmostBundleId: state.frontmostBundleId,
  }).map(({ keyword, text }) => ({ keyword, text }));
}
