/**
 * Inline conversions in the root search (units, currency, time zones, dates), shown in the
 * Calculator section like Raycast. Network: only the exchange-rate API, only after a currency
 * query is typed, and only while the "Fetch exchange rates" setting is on.
 */
import path from "node:path";
import type { ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { convertQuery, type Conversion, type CopyOption } from "./engine";
import { copyText, pasteText } from "./output";
import { createRatesStore, RATES_TTL_MS, type Fetcher, type RatesStore } from "./rates";

export interface ConvertSettings {
  enabled: boolean;
  currencyNetwork: boolean;
  defaultCurrency: string;
}
export const DEFAULT_CONVERT_SETTINGS: ConvertSettings = { enabled: true, currencyNetwork: true, defaultCurrency: "USD" };

export interface ConvertState {
  settings: ConvertSettings;
  rates: { date: string; fetchedAt: number; source: string; count: number; fresh: boolean } | null;
  error?: string;
}

/** How long a search waits for a first rates fetch before showing "Fetching…" (host budget is 250 ms). */
const FIRST_FETCH_WAIT_MS = 180;
const SCORE = 1000;

let ctx: FeatureContext | undefined;
let rates: RatesStore | undefined;

function settings(): ConvertSettings {
  const s = ctx?.settings(DEFAULT_CONVERT_SETTINGS as unknown as Record<string, unknown>) ?? {};
  return {
    enabled: s.enabled !== false,
    currencyNetwork: s.currencyNetwork !== false,
    defaultCurrency: typeof s.defaultCurrency === "string" && /^[A-Z]{3}$/.test(s.defaultCurrency) ? s.defaultCurrency : "USD",
  };
}

const fetcher: Fetcher = (url, init) => fetch(url, { signal: init.signal, headers: { Accept: "application/json" } });

function state(): ConvertState {
  const t = rates?.current();
  return {
    settings: settings(),
    rates: t ? { date: t.date, fetchedAt: t.fetchedAt, source: t.source, count: Object.keys(t.rates).length + 1, fresh: Date.now() - t.fetchedAt < RATES_TTL_MS } : null,
    error: rates?.lastError(),
  };
}

function toScored(query: string, c: Conversion, index: number): ScoredItem {
  const item: SearchItem = {
    id: `convert:${c.category}:${index}:${query.trim().toLowerCase()}`,
    kind: "calculator",
    title: c.title,
    subtitle: c.subtitle,
    icon: { kind: "emoji", value: c.icon },
    text: c.copy,
    feature: "convert",
    kindLabel: "Convert",
    data: { copy: c.copy, more: c.more, category: c.category, noUsage: true },
  };
  return { item, score: SCORE - index, matchScore: SCORE, matchKind: "exact", frecency: 0, ranges: [] };
}

function moreOf(item: SearchItem): CopyOption[] {
  const more = item.data?.more;
  return Array.isArray(more) ? more.filter((m): m is CopyOption => !!m && typeof m === "object" && typeof (m as CopyOption).text === "string") : [];
}

async function dynamicItems(query: string): Promise<ScoredItem[]> {
  const s = settings();
  if (!s.enabled || !rates) return [];
  const base = () => ({ now: Date.now(), localZone: Intl.DateTimeFormat().resolvedOptions().timeZone, defaultCurrency: s.defaultCurrency, currencyEnabled: s.currencyNetwork || !!rates?.current() });
  const make = (loading: boolean) => {
    const t = rates?.current();
    return convertQuery(query, { ...base(), rates: t, ratesStale: !!t && !rates?.isFresh(), ratesLoading: loading });
  };
  let out = make(false);
  if (out.wantsRates && s.currencyNetwork && !rates.isFresh()) {
    const pending = rates.refresh();
    if (!rates.current()) {
      await Promise.race([pending, new Promise((r) => setTimeout(r, FIRST_FETCH_WAIT_MS))]);
      out = make(!rates.current());
    }
    void pending.then(() => ctx?.emit("state", state()));
  }
  return out.results.map((c, i) => toScored(query, c, i));
}

export const feature: FeatureModule = {
  id: "convert",
  start(c) {
    ctx = c;
    rates = createRatesStore({ file: path.join(c.dataDir(), "rates.json"), fetcher, log: c.log });
  },
  dynamicItems,
  actions(item): ItemAction[] {
    if (!item.data?.copy) return [];
    return [
      { id: "copy", title: "Copy Result", shortcut: "⏎", icon: "📋" },
      { id: "paste", title: "Paste Result", shortcut: "⌘⏎", icon: "📥" },
      ...moreOf(item).map((m) => ({ id: `more:${m.id}`, title: m.title, icon: "📋" })),
    ];
  },
  async runAction(scored, actionId) {
    const copy = typeof scored.item.data?.copy === "string" ? scored.item.data.copy : "";
    if (!copy) return { ok: false, error: "Nothing to copy yet" };
    if (actionId === "copy") return copyText(copy);
    if (actionId === "paste") return pasteText(ctx, copy);
    if (actionId.startsWith("more:")) {
      const m = moreOf(scored.item).find((x) => `more:${x.id}` === actionId);
      if (m) return copyText(m.text);
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    state: () => state(),
    setSettings: (patch: unknown) => {
      if (!patch || typeof patch !== "object") return state();
      const p = patch as Partial<ConvertSettings>;
      const clean: Partial<ConvertSettings> = {};
      if (typeof p.enabled === "boolean") clean.enabled = p.enabled;
      if (typeof p.currencyNetwork === "boolean") clean.currencyNetwork = p.currencyNetwork;
      if (typeof p.defaultCurrency === "string" && /^[A-Za-z]{3}$/.test(p.defaultCurrency.trim())) clean.defaultCurrency = p.defaultCurrency.trim().toUpperCase();
      ctx?.setSettings(clean as Record<string, unknown>);
      return state();
    },
    /** Explicit "Refresh now" from the settings page (also a user action, so it ignores the TTL). */
    refreshRates: async () => {
      if (!settings().currencyNetwork) return { ...state(), error: "Fetching exchange rates is turned off" };
      await rates?.refresh(true);
      return state();
    },
    clearRates: () => {
      rates?.clear();
      return state();
    },
    /** Test hook: evaluate a query exactly as the root search does. */
    preview: async (query: unknown) => (typeof query === "string" ? (await dynamicItems(query)).map((s) => ({ title: s.item.title, subtitle: s.item.subtitle })) : []),
  },
};
