/**
 * Live inputs for keyword expansion, shared between the snippets feature (which keeps them fresh)
 * and the keyboard feature (which sends the list to the helper). No Electron imports: the keyboard
 * config stays unit-testable.
 */
import { randomUUID } from "node:crypto";
import type { Snippet } from "@shared/types";
import type { KeyConfigSnippet } from "../native/helper";
import { isDynamic, usesPlaceholder } from "../quicklinks/placeholders";
import { buildExpansionList, SNIPPET_DEFAULTS, type SnippetSettings } from "./expansion";

interface LiveState {
  settings: SnippetSettings;
  clipboard: string;
}

const state: LiveState = { settings: SNIPPET_DEFAULTS, clipboard: "" };
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

/** True when the snippet must be rendered at expansion time (placeholders, {cursor}, rich text). */
export function needsLiveRender(s: Snippet): boolean {
  const src = `${s.text}\n${s.html ?? ""}`;
  return !!s.html?.trim() || isDynamic(src) || usesPlaceholder(src, "cursor");
}

/**
 * What the helper should watch for: prefix and case variants applied, `text` pre-rendered as the fallback.
 * Live entries carry the snippet id (the helper asks main via snippet.matched); exclusions are checked by the tap.
 */
export function liveExpansionList(snippets: Snippet[], now = new Date()): KeyConfigSnippet[] {
  const byId = new Map(snippets.map((s) => [s.id, s]));
  return buildExpansionList({
    snippets,
    settings: state.settings,
    env: { now, clipboard: state.clipboard, uuid: randomUUID },
    frontmostBundleId: null,
  }).map(({ keyword, text, snippetId }) => {
    const s = byId.get(snippetId);
    const excluded = s?.excludedApps?.filter((x) => !!x.trim()) ?? [];
    return { keyword, text, ...(s && needsLiveRender(s) ? { id: snippetId } : {}), ...(excluded.length ? { excludedBundleIds: excluded } : {}) };
  });
}

/** Bundle ids where no snippet expands (Snippet settings → excluded apps). */
export function globalExcludedApps(): string[] {
  return state.settings.excludedApps;
}
