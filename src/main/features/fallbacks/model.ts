/** Pure model for fallback commands: built-ins, user-added ones and quicklinks, in a user-chosen order. */
import type { ItemIcon, Quicklink } from "@shared/types";

export type FallbackAction = "url" | "files" | "ai";
export type FallbackSource = "builtin" | "custom" | "quicklink";

export interface FallbackDef {
  id: string;
  name: string;
  /** URL template with {query}; absent for "files" / "ai". */
  url?: string;
  action: FallbackAction;
  icon: ItemIcon;
  source: FallbackSource;
}

export interface CustomFallback {
  id: string;
  name: string;
  url: string;
}

export interface FallbackSettings extends Record<string, unknown> {
  /** Fallback ids in display order; ids missing from it follow in default order. */
  order: string[];
  disabled: string[];
  custom: CustomFallback[];
  /** Quicklink ids (Quicklink.id, not the catalogue id) used as fallbacks. */
  quicklinks: string[];
}

export interface FallbackConfig {
  entries: Array<FallbackDef & { enabled: boolean }>;
  quicklinks: Array<{ id: string; name: string; url: string; enabled: boolean }>;
}

export const DEFAULT_SETTINGS: FallbackSettings = { order: [], disabled: ["duckduckgo", "maps"], custom: [], quicklinks: [] };

const globe: ItemIcon = { kind: "emoji", value: "🌐" };

export const BUILTINS: FallbackDef[] = [
  { id: "google", name: "Search Google", url: "https://www.google.com/search?q={query}", action: "url", icon: { kind: "emoji", value: "🔎" }, source: "builtin" },
  { id: "files", name: "Search Files", action: "files", icon: { kind: "emoji", value: "📂" }, source: "builtin" },
  { id: "ai", name: "Ask AI", action: "ai", icon: { kind: "emoji", value: "✨" }, source: "builtin" },
  { id: "duckduckgo", name: "Search DuckDuckGo", url: "https://duckduckgo.com/?q={query}", action: "url", icon: { kind: "emoji", value: "🦆" }, source: "builtin" },
  { id: "github", name: "Search GitHub", url: "https://github.com/search?q={query}", action: "url", icon: { kind: "emoji", value: "🐙" }, source: "builtin" },
  { id: "youtube", name: "Search YouTube", url: "https://www.youtube.com/results?search_query={query}", action: "url", icon: { kind: "emoji", value: "▶️" }, source: "builtin" },
  { id: "maps", name: "Search Maps", url: "maps://?q={query}", action: "url", icon: { kind: "emoji", value: "🗺️" }, source: "builtin" },
];

export const quicklinkFallbackId = (quicklinkId: string): string => `ql-${quicklinkId}`;

/** Every known fallback (enabled or not) in the user's order. */
export function orderedFallbacks(settings: FallbackSettings, quicklinks: Quicklink[]): FallbackDef[] {
  const pool: FallbackDef[] = [
    ...BUILTINS,
    ...settings.custom.map((c): FallbackDef => ({ id: c.id, name: c.name, url: c.url, action: "url", icon: globe, source: "custom" })),
    ...quicklinks
      .filter((q) => settings.quicklinks.includes(q.id))
      .map((q): FallbackDef => ({ id: quicklinkFallbackId(q.id), name: q.name, url: q.url, action: "url", icon: q.icon ?? { kind: "emoji", value: "🔗" }, source: "quicklink" })),
  ];
  const byId = new Map(pool.map((f) => [f.id, f]));
  const out: FallbackDef[] = [];
  for (const id of settings.order) {
    const f = byId.get(id);
    if (f) {
      out.push(f);
      byId.delete(id);
    }
  }
  return [...out, ...byId.values()];
}

export function enabledFallbacks(settings: FallbackSettings, quicklinks: Quicklink[]): FallbackDef[] {
  const disabled = new Set(settings.disabled);
  return orderedFallbacks(settings, quicklinks).filter((f) => !disabled.has(f.id));
}

/** Move `id` by `delta` positions within `ids` (clamped); returns a new array. */
export function moveId(ids: string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids.slice();
  const to = Math.min(ids.length - 1, Math.max(0, from + delta));
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Move `id` to sit at index `to` (drag and drop). */
export function placeId(ids: string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids.slice();
  return moveId(ids, id, to - from);
}

export function fillQuery(url: string, query: string): string {
  return url.replace(/\{query\}/g, encodeURIComponent(query));
}

export function validTemplate(url: string): string | null {
  const u = url.trim();
  if (!u) return "URL is required";
  if (!u.includes("{query}")) return "URL must contain {query}";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return "URL needs a scheme, e.g. https://";
  return null;
}
