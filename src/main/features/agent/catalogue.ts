/**
 * Catalogue search for the agent. Uses the host's ctx.search/ctx.findItem when the host provides
 * them (same ranking and frecency as the launcher); otherwise rebuilds the same item list the
 * launcher's catalogue uses (same ids, so ctx.executeItem resolves them) and ranks it with the
 * shared pure engine.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { ScoredItem, SearchItem } from "@shared/types";
import { createEngine } from "@engine/index";
import { quicklinkItemId, snippetItemId, workflowItemId } from "../../catalogue";
import { settingItems, systemItems } from "../../sources/system";
import { expandHome } from "../../util/exec";
import type { FeatureContext, FeatureModule } from "../types";
import type { CatalogueHit } from "./tools";

const CACHE_MS = 30_000;
const APP_CACHE_MS = 5 * 60_000;

export interface CatalogueSource {
  search(query: string, limit: number): Promise<CatalogueHit[]>;
  find(id: string): Promise<CatalogueHit | undefined>;
}

export function toHit(i: SearchItem): CatalogueHit {
  return { id: i.id, title: i.title, subtitle: i.subtitle, kind: i.kindLabel ?? i.kind, acceptsArgument: i.acceptsArgument || undefined };
}

async function scanApps(dirs: string[]): Promise<SearchItem[]> {
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number) => {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (name.endsWith(".app")) {
        if (seen.has(full)) continue;
        seen.add(full);
        out.push({ id: `app:${full}`, kind: "app", title: path.basename(name, ".app"), path: full, source: "apps" });
      } else if (depth < 2 && !name.includes(".")) await walk(full, depth + 1);
    }
  };
  for (const d of dirs) await walk(expandHome(d), 0);
  for (const extra of ["/System/Library/CoreServices/Finder.app", "/System/Applications/System Settings.app"]) {
    if (!seen.has(extra)) out.push({ id: `app:${extra}`, kind: "app", title: path.basename(extra, ".app"), path: extra, source: "apps" });
  }
  return out;
}

/** Hooks newer hosts add to FeatureContext; feature-detected so older hosts keep working. */
interface HostSearch {
  search?: (query: string, opts?: { limit?: number }) => Promise<ScoredItem[]>;
  findItem?: (id: string) => SearchItem | undefined;
}

const usable = (i: SearchItem) => i.kind !== "fallback" && !i.id.startsWith("agent:");

export function createCatalogueSource(ctx: FeatureContext, features: () => Promise<FeatureModule[]>): CatalogueSource {
  const host = ctx as Omit<FeatureContext, "search" | "findItem"> & HostSearch;
  let items: SearchItem[] = [];
  let itemsAt = 0;
  let apps: SearchItem[] = [];
  let appsAt = 0;

  const load = async (): Promise<SearchItem[]> => {
    if (Date.now() - itemsAt < CACHE_MS && items.length) return items;
    const data = ctx.getData();
    if (Date.now() - appsAt > APP_CACHE_MS) {
      apps = await scanApps(data.settings.appDirectories);
      appsAt = Date.now();
    }
    const fromFeatures = (await features())
      .filter((m) => m.id !== ctx.id)
      .flatMap((m) => {
        try {
          return (m.items?.() ?? []).map((i) => ({ ...i, feature: i.feature ?? m.id }));
        } catch {
          return [];
        }
      });
    const raw: SearchItem[] = [
      ...apps,
      ...systemItems(),
      ...settingItems(),
      ...data.workflows.map((w): SearchItem => ({ id: workflowItemId(w.id), kind: "workflow", title: w.name, subtitle: w.description || "Workflow", keywords: w.keywords, workflowId: w.id, acceptsArgument: w.acceptsInput, source: "workflows" })),
      ...data.quicklinks.map((q): SearchItem => ({ id: quicklinkItemId(q.id), kind: "quicklink", title: q.name, subtitle: q.url, keywords: q.keywords, url: q.url, acceptsArgument: q.url.includes("{query}"), source: "quicklinks" })),
      ...data.snippets.map((s): SearchItem => ({ id: snippetItemId(s.id), kind: "snippet", title: s.name, subtitle: "Snippet", keywords: s.keyword ? [s.keyword] : [], source: "snippets" })),
      ...fromFeatures.filter((i) => i.kind !== "fallback"),
    ];
    const disabled = new Set(data.settings.disabledSources);
    items = raw.filter((i) => !i.source || !disabled.has(i.source));
    itemsAt = Date.now();
    return items;
  };

  return {
    async search(query, limit) {
      if (typeof host.search === "function") {
        const res = await host.search(query, { limit: limit + 4 });
        const seen = new Set<string>();
        const hits: CatalogueHit[] = [];
        for (const it of res)
          if (usable(it.item) && !seen.has(it.item.id)) {
            seen.add(it.item.id);
            hits.push(toHit(it.item));
          }
        return hits.slice(0, limit);
      }
      const all = await load();
      const engine = createEngine({ sectionLimit: limit, aliases: ctx.getData().aliases });
      engine.setItems(all);
      const res = engine.search(query);
      const seen = new Set<string>();
      const hits: CatalogueHit[] = [];
      for (const s of res.sections) {
        for (const it of s.items) {
          if (seen.has(it.item.id)) continue;
          seen.add(it.item.id);
          hits.push(toHit(it.item));
        }
      }
      return hits.slice(0, limit);
    },
    async find(id) {
      if (typeof host.findItem === "function") {
        const item = host.findItem(id);
        if (item) return toHit(item);
      }
      const hit = (await load()).find((i) => i.id === id);
      return hit ? toHit(hit) : undefined;
    },
  };
}
