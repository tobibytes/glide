import { clipboard, shell } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { DEFAULT_SETTINGS, enabledFallbacks, fillQuery, moveId, orderedFallbacks, placeId, validTemplate, type FallbackConfig, type FallbackDef, type FallbackSettings } from "./model";

let ctx: FeatureContext | undefined;

const settings = (): FallbackSettings => {
  const s = ctx?.settings(DEFAULT_SETTINGS) ?? DEFAULT_SETTINGS;
  return {
    order: Array.isArray(s.order) ? s.order.filter((x): x is string => typeof x === "string") : [],
    disabled: Array.isArray(s.disabled) ? s.disabled.filter((x): x is string => typeof x === "string") : [],
    custom: Array.isArray(s.custom) ? s.custom.filter((c) => c && typeof c.id === "string" && typeof c.url === "string" && typeof c.name === "string") : [],
    quicklinks: Array.isArray(s.quicklinks) ? s.quicklinks.filter((x): x is string => typeof x === "string") : [],
  };
};
const quicklinks = () => ctx?.getData().quicklinks ?? [];

function toItem(f: FallbackDef): SearchItem {
  return {
    id: `fallbacks:${f.id}`,
    kind: "fallback",
    title: f.name,
    icon: f.icon,
    url: f.url,
    feature: "fallbacks",
    data: { fallbackId: f.id, action: f.action },
  };
}

function config(): FallbackConfig {
  const s = settings();
  const disabled = new Set(s.disabled);
  return {
    entries: orderedFallbacks(s, quicklinks()).map((f) => ({ ...f, enabled: !disabled.has(f.id) })),
    quicklinks: quicklinks().map((q) => ({ id: q.id, name: q.name, url: q.url, enabled: s.quicklinks.includes(q.id) })),
  };
}

/** Persist the full order so later additions append predictably. */
function save(patch: Partial<FallbackSettings>): FallbackConfig {
  ctx?.setSettings(patch);
  return config();
}

const currentOrder = () => orderedFallbacks(settings(), quicklinks()).map((f) => f.id);

export const feature: FeatureModule = {
  id: "fallbacks",
  start(c) {
    ctx = c;
  },
  items() {
    if (!ctx) return [];
    return [
      ...enabledFallbacks(settings(), quicklinks()).map(toItem),
      {
        id: "fallbacks:manage",
        kind: "command",
        kindLabel: "Settings",
        title: "Manage Fallback Commands",
        subtitle: "Choose what appears when nothing matches",
        icon: { kind: "emoji", value: "🪂" },
        keywords: ["fallback", "search", "web", "default"],
        feature: "fallbacks",
        data: { action: "manage" },
      },
    ];
  },
  actions(item): ItemAction[] {
    if (item.data?.action === "manage") return [{ id: "manage", title: "Open Settings", shortcut: "⏎" }];
    const list: ItemAction[] = [{ id: "open", title: item.title, shortcut: "⏎" }];
    if (item.url) list.push({ id: "copyUrl", title: "Copy URL", shortcut: "⌘⏎" });
    list.push({ id: "manage", title: "Manage Fallback Commands", shortcut: "⌘," });
    return list;
  },
  async runAction(scored: ScoredItem, actionId: string): Promise<ExecuteResult> {
    const { item } = scored;
    const query = scored.argument?.trim() ?? "";
    if (actionId === "manage") return { ok: true, navigate: "settings/fallbacks" };
    const action = item.data?.action;
    if (actionId === "copyUrl" && item.url) {
      clipboard.writeText(fillQuery(item.url, query));
      return { ok: true, hide: true, message: "URL copied" };
    }
    if (actionId !== "open") return { ok: false, error: `Unknown action ${actionId}` };
    if (action === "files") return { ok: true, view: { id: "fileindex.search", props: { query } } };
    if (action === "ai") return { ok: true, view: { id: "ai.chat", props: { prompt: query } } };
    if (!item.url) return { ok: false, error: "Fallback has no URL" };
    await shell.openExternal(fillQuery(item.url, query));
    return { ok: true, hide: true };
  },
  methods: {
    getConfig: () => config(),
    move: (id: unknown, delta: unknown) => (typeof id === "string" && typeof delta === "number" ? save({ order: moveId(currentOrder(), id, delta) }) : config()),
    place: (id: unknown, index: unknown) => (typeof id === "string" && typeof index === "number" ? save({ order: placeId(currentOrder(), id, index) }) : config()),
    setEnabled: (id: unknown, enabled: unknown) => {
      if (typeof id !== "string") return config();
      const disabled = settings().disabled.filter((d) => d !== id);
      if (enabled === false) disabled.push(id);
      return save({ disabled });
    },
    addCustom: (name: unknown, url: unknown) => {
      if (typeof name !== "string" || !name.trim() || typeof url !== "string") throw new Error("Name and URL are required");
      const problem = validTemplate(url);
      if (problem) throw new Error(problem);
      const id = `custom-${Date.now().toString(36)}`;
      return save({ custom: [...settings().custom, { id, name: name.trim(), url: url.trim() }], order: [...currentOrder(), id] });
    },
    removeCustom: (id: unknown) => {
      const s = settings();
      return save({ custom: s.custom.filter((c) => c.id !== id), order: s.order.filter((o) => o !== id), disabled: s.disabled.filter((d) => d !== id) });
    },
    setQuicklink: (quicklinkId: unknown, enabled: unknown) => {
      if (typeof quicklinkId !== "string") return config();
      const list = settings().quicklinks.filter((q) => q !== quicklinkId);
      if (enabled === true) list.push(quicklinkId);
      return save({ quicklinks: list });
    },
  },
};
