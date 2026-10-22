import type { Snippet } from "@shared/types";
import type { KeyConfig } from "../../native/helper";
import { globalExcludedApps, liveExpansionList } from "../../snippets/live";

export interface KeyboardSettings extends Record<string, unknown> {
  /** Expand snippet keywords as you type (takes effect once Accessibility is granted). */
  expandSnippets: boolean;
  hyperKey: "off" | "capslock";
  /** "Use ⌘Space for Glide": Spotlight's shortcut is off and Glide's hotkey is Command+Space. */
  spotlightTakeover: boolean;
  /** Glide hotkey before the takeover, restored when it is turned off. */
  previousHotkey: string;
}

export const KEYBOARD_DEFAULTS: KeyboardSettings = {
  expandSnippets: true,
  hyperKey: "off",
  spotlightTakeover: false,
  previousHotkey: "",
};

export const SPOTLIGHT_HOTKEY = "Command+Space";
export const FALLBACK_HOTKEY = "Alt+Space";

/**
 * Snippets with a non-empty keyword, longest keyword first (so ";sig2" wins over ";sig").
 * Keyword prefix, case variants, per-app exclusions and placeholders come from src/main/snippets.
 */
export function snippetKeywords(snippets: Snippet[]): KeyConfig["snippets"] {
  return liveExpansionList(snippets);
}

/**
 * The config to send to the helper. Without Accessibility nothing is enabled (the tap would fail).
 * `pasteStack`: the clipboard's Paste Stack has items, so ⌘V pastes the next one (see ./pasteStack.ts).
 */
export function buildKeyConfig(settings: KeyboardSettings, snippets: Snippet[], accessibility: boolean, pasteStack = false): KeyConfig {
  if (!accessibility) return { snippets: [], hyperKey: "off" };
  const list = settings.expandSnippets ? snippetKeywords(snippets) : [];
  const excluded = list.length ? globalExcludedApps() : [];
  return {
    snippets: list,
    hyperKey: settings.hyperKey === "capslock" ? "capslock" : "off",
    ...(excluded.length ? { excludedBundleIds: excluded } : {}),
    pasteStack,
  };
}

/** Hotkey to restore when the ⌘Space takeover is turned off. */
export function hotkeyAfterTakeover(previous: string): string {
  return previous && previous !== SPOTLIGHT_HOTKEY ? previous : FALLBACK_HOTKEY;
}
