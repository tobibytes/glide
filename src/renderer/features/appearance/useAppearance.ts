/**
 * Applies the appearance settings to this window as inline CSS custom properties on <html>
 * (inline beats tokens.css, so the stylesheet values are only the first-paint fallback).
 * Every window calls this from App; settings changes arrive with evt:dataChanged, so a change
 * made anywhere restyles every window live. The Switch Theme view can set a local preview.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Settings } from "@shared/types";
import { tokensFor } from "../../../main/features/appearance/themes";

let preview: string | null = null;
const listeners = new Set<() => void>();

/** Temporarily show a preset in this window only (null restores the saved theme). */
export function setThemePreview(id: string | null): void {
  if (preview === id) return;
  preview = id;
  for (const l of listeners) l();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

function useSystemDark(): boolean {
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(() => query?.matches ?? true);
  useEffect(() => {
    if (!query) return;
    const on = () => setDark(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, [query]);
  return dark;
}

function useReducedMotion(): boolean {
  const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [reduced, setReduced] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const on = () => setReduced(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, [query]);
  return reduced;
}

export function useAppearance(settings: Settings | undefined): void {
  const systemDark = useSystemDark();
  const reducedMotion = useReducedMotion();
  const previewId = useSyncExternalStore(subscribe, () => preview);
  const mode = settings?.theme ?? "system";
  const raw = settings?.features?.appearance;
  const key = JSON.stringify(raw ?? null);

  useEffect(() => {
    if (!settings) return;
    const { preset, tokens } = tokensFor(mode, systemDark, raw, previewId);
    const el = document.documentElement;
    for (const [name, value] of Object.entries(tokens)) el.style.setProperty(name, value);
    el.style.colorScheme = preset.scheme;
    el.dataset.scheme = preset.scheme;
    el.dataset.preset = preset.id;
    const anim = (raw as { animations?: unknown } | undefined)?.animations !== false && !reducedMotion;
    el.dataset.motion = anim ? "on" : "off";
    el.dataset.density = (raw as { density?: unknown } | undefined)?.density === "compact" ? "compact" : "comfortable";
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for `raw`
  }, [settings ? 1 : 0, mode, systemDark, key, previewId, reducedMotion]);
}
