import type { Quicklink, SearchItem, Snippet, UserData, Workflow } from "@shared/types";
import type { SearchEngine } from "@engine/api";
import type { HotkeyBinding } from "./hotkeys";
import type { AppSource } from "./sources/apps";
import { settingItems, systemItems } from "./sources/system";
import type { Store } from "./store";
import { accelToDisplay } from "./util/accel";
import { quicklinkItemExtras } from "./quicklinks/item";

export const WORKFLOW_SOURCE_ID = "workflows";
export const QUICKLINK_SOURCE_ID = "quicklinks";
export const SNIPPET_SOURCE_ID = "snippets";

export interface Catalogue {
  /** Rebuild the item list from every source and push it to the engine. */
  rebuild(): void;
  items(): SearchItem[];
  find(id: string): SearchItem | undefined;
  /** Per-item global hotkeys (user-assigned or workflow.hotkey). */
  hotkeyBindings(): HotkeyBinding[];
}

export interface CatalogueDeps {
  store: Store;
  apps: AppSource;
  engine: SearchEngine;
  onHotkey(item: SearchItem): void;
  /** Items contributed by feature modules (src/main/features). */
  featureItems?(): SearchItem[];
}

export const workflowItemId = (id: string): string => `workflow:${id}`;
export const quicklinkItemId = (id: string): string => `quicklink:${id}`;
export const snippetItemId = (id: string): string => `snippet:${id}`;

function workflowItems(workflows: Workflow[]): SearchItem[] {
  return workflows.map((wf) => ({
    id: workflowItemId(wf.id),
    kind: "workflow",
    title: wf.name,
    subtitle: wf.description || "Workflow",
    icon: wf.icon,
    keywords: wf.keywords,
    alias: wf.alias,
    workflowId: wf.id,
    acceptsArgument: wf.acceptsInput,
    source: WORKFLOW_SOURCE_ID,
  }));
}

function quicklinkItems(quicklinks: Quicklink[]): SearchItem[] {
  return quicklinks.map((q) => ({
    id: quicklinkItemId(q.id),
    kind: "quicklink",
    title: q.name,
    subtitle: q.url,
    icon: q.icon ?? { kind: "emoji", value: "🔗" },
    keywords: q.keywords,
    alias: q.alias,
    url: q.url,
    ...quicklinkItemExtras(q), // acceptsArgument + data.arguments for the launcher's multi-argument entry
    source: QUICKLINK_SOURCE_ID,
  }));
}

function snippetItems(snippets: Snippet[]): SearchItem[] {
  return snippets.map((s) => {
    const firstLine = s.text.split("\n")[0] ?? "";
    return {
      id: snippetItemId(s.id),
      kind: "snippet",
      title: s.name,
      subtitle: firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine,
      icon: { kind: "emoji", value: "✂️" },
      keywords: s.keyword ? [s.keyword] : [],
      alias: s.alias ?? s.keyword,
      text: s.text,
      source: SNIPPET_SOURCE_ID,
    };
  });
}

export function createCatalogue(deps: CatalogueDeps): Catalogue {
  let items: SearchItem[] = [];
  let byId = new Map<string, SearchItem>();
  let accels = new Map<string, string>();

  const decorate = (item: SearchItem, data: UserData): SearchItem => {
    const alias = data.aliases[item.id] ?? item.alias;
    const workflowHotkey = item.kind === "workflow" ? data.workflows.find((w) => w.id === item.workflowId)?.hotkey : undefined;
    const accel = data.hotkeys[item.id] ?? workflowHotkey;
    if (accel) accels.set(item.id, accel);
    return {
      ...item,
      alias: alias || undefined,
      hotkey: accel ? accelToDisplay(accel) : undefined,
      favorite: data.favorites.includes(item.id) || undefined,
    };
  };

  const rebuild = () => {
    const data = deps.store.getData();
    const disabled = new Set(data.settings.disabledSources);
    accels = new Map();
    const raw = [
      ...deps.apps.items(),
      ...systemItems(),
      ...settingItems(),
      ...workflowItems(data.workflows),
      ...quicklinkItems(data.quicklinks),
      ...snippetItems(data.snippets),
      ...(deps.featureItems?.() ?? []),
    ];
    items = raw.filter((i) => !i.source || !disabled.has(i.source)).map((i) => decorate(i, data));
    byId = new Map(items.map((i) => [i.id, i]));
    deps.engine.configure({
      favorites: new Set(data.favorites),
      aliases: data.aliases,
      sectionLimit: data.settings.sectionLimit,
      frecencyHalfLifeDays: data.settings.frecencyHalfLifeDays,
    });
    deps.engine.setItems(items);
  };

  return {
    rebuild,
    items: () => items,
    find: (id) => byId.get(id),
    hotkeyBindings: () =>
      [...accels.entries()].flatMap(([id, accel]) => {
        const item = byId.get(id);
        return item ? [{ accel, handler: () => deps.onHotkey(item) }] : [];
      }),
  };
}
