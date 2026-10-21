/**
 * Exchange rates: fetched only when a currency query is typed, cached on disk for RATES_TTL_MS,
 * and served from the last cache when offline. Providers need no API key:
 *  - open.er-api.com (ExchangeRate-API open access, ~160 currencies incl. NGN, daily)
 *  - api.frankfurter.app (ECB reference rates, ~30 currencies) as a fallback
 */
import fs from "node:fs";
import path from "node:path";
import type { RateTable } from "./currency";

export const RATES_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
/** After a failed fetch, wait before hitting the network again (typing must not spam requests). */
const RETRY_AFTER_MS = 60 * 1000;

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RatesProvider {
  name: string;
  url: string;
  parse(body: unknown, now: number): RateTable | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanRates(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (/^[A-Z]{3}$/.test(k) && typeof v === "number" && v > 0 && Number.isFinite(v)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

export const PROVIDERS: RatesProvider[] = [
  {
    name: "ExchangeRate-API",
    url: "https://open.er-api.com/v6/latest/USD",
    parse(body, now) {
      if (!isRecord(body) || body.result !== "success") return undefined;
      const rates = cleanRates(body.rates);
      if (!rates) return undefined;
      const unix = typeof body.time_last_update_unix === "number" ? body.time_last_update_unix * 1000 : now;
      return { base: "USD", rates, date: new Date(unix).toISOString().slice(0, 10), fetchedAt: now, source: "ExchangeRate-API" };
    },
  },
  {
    name: "Frankfurter (ECB)",
    url: "https://api.frankfurter.app/latest?from=USD",
    parse(body, now) {
      if (!isRecord(body)) return undefined;
      const rates = cleanRates(body.rates);
      if (!rates) return undefined;
      return { base: "USD", rates, date: typeof body.date === "string" ? body.date : new Date(now).toISOString().slice(0, 10), fetchedAt: now, source: "ECB via Frankfurter" };
    },
  },
];

export function isRateTable(v: unknown): v is RateTable {
  return isRecord(v) && typeof v.base === "string" && isRecord(v.rates) && typeof v.date === "string" && typeof v.fetchedAt === "number";
}

export interface RatesStoreOptions {
  file: string;
  fetcher: Fetcher;
  now?: () => number;
  providers?: RatesProvider[];
  log?: (...args: unknown[]) => void;
}

export interface RatesStore {
  /** Cached table (possibly stale), loaded from disk lazily. */
  current(): RateTable | undefined;
  isFresh(): boolean;
  /** Fetch when stale (deduplicated, rate-limited after failures). Resolves to the best table available. */
  refresh(force?: boolean): Promise<RateTable | undefined>;
  /** Last error message from a failed fetch, cleared on success. */
  lastError(): string | undefined;
  clear(): void;
}

export function createRatesStore(opts: RatesStoreOptions): RatesStore {
  const now = opts.now ?? Date.now;
  const providers = opts.providers ?? PROVIDERS;
  let table: RateTable | undefined;
  let loaded = false;
  let inflight: Promise<RateTable | undefined> | undefined;
  let failedAt = 0;
  let error: string | undefined;

  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(opts.file, "utf8"));
      if (isRateTable(raw)) table = raw;
    } catch {
      // no cache yet
    }
  };

  const save = (t: RateTable) => {
    try {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(t));
      fs.renameSync(tmp, opts.file);
    } catch (err) {
      opts.log?.("could not save rates", err);
    }
  };

  const fetchOnce = async (): Promise<RateTable | undefined> => {
    const errors: string[] = [];
    for (const p of providers) {
      try {
        const res = await opts.fetcher(p.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = p.parse(await res.json(), now());
        if (!parsed) throw new Error("unexpected response");
        return parsed;
      } catch (err) {
        errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(errors.join("; "));
  };

  const isFresh = () => {
    load();
    return !!table && now() - table.fetchedAt < RATES_TTL_MS;
  };

  return {
    current() {
      load();
      return table;
    },
    isFresh,
    refresh(force = false) {
      load();
      if (!force && isFresh()) return Promise.resolve(table);
      if (!force && failedAt && now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(table);
      inflight ??= fetchOnce()
        .then((t) => {
          table = t;
          error = undefined;
          failedAt = 0;
          if (t) save(t);
          return t;
        })
        .catch((err: unknown) => {
          failedAt = now();
          error = err instanceof Error ? err.message : String(err);
          opts.log?.("rates fetch failed:", error);
          return table;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
    lastError: () => error,
    clear() {
      table = undefined;
      loaded = true;
      try {
        fs.rmSync(opts.file, { force: true });
      } catch {
        // ignore
      }
    },
  };
}
