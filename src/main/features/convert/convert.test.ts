import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { convertCurrency, formatMoney, lookupCurrency, parseCurrencyQuery, type RateTable } from "./currency";
import { countValue, daysBetween, parseDate, parseDateQuery } from "./dates";
import { convertQuery } from "./engine";
import { groupedNumber, parseAmount, plainNumber } from "./format";
import { createRatesStore, PROVIDERS, RATES_TTL_MS, type Fetcher } from "./rates";
import { lookupZone, offsetMinutes, parseClock, parseTimeZoneQuery, wallToInstant } from "./timezones";
import { convertValue, lookupUnit, parseUnitConversion } from "./units";

const close = (a: number | undefined, b: number, digits = 4) => expect(a).toBeCloseTo(b, digits);
const conv = (q: string) => parseUnitConversion(q)?.value;

describe("format", () => {
  it("formats numbers without float noise", () => {
    expect(plainNumber(0.1 + 0.2)).toBe("0.3");
    expect(plainNumber(3.106855961)).toBe("3.10686");
    expect(groupedNumber(1234567.891)).toBe("1,234,570");
    expect(groupedNumber(-1234.5)).toBe("-1,234.5");
    expect(plainNumber(1e-9)).toBe("1e-9");
  });
  it("parses amounts", () => {
    expect(parseAmount("1,000.5")).toBe(1000.5);
    expect(parseAmount("1.5k")).toBeUndefined();
    expect(parseAmount("1.5k", true)).toBe(1500);
    expect(parseAmount("abc")).toBeUndefined();
  });
});

describe("units", () => {
  it("converts length, mass, volume", () => {
    close(conv("5 km in miles"), 3.10686);
    close(conv("5km to mi"), 3.10686);
    close(conv("6 ft in cm"), 182.88);
    close(conv("5 ft 10 in to cm"), 177.8);
    close(conv("5 in in cm"), 12.7);
    close(conv("10 kg in lbs"), 22.0462);
    close(conv("1 gallon in liters"), 3.78541);
    close(conv("2 cups to ml"), 473.176, 2);
    close(conv("1 lb to oz"), 16);
  });
  it("converts temperatures (affine)", () => {
    close(conv("100f to c"), 37.7778);
    close(conv("100 °F in °C"), 37.7778);
    close(conv("0 c in f"), 32);
    close(conv("-40 c to f"), -40);
    close(conv("0 k in c"), -273.15);
    close(conv("20 celsius to kelvin"), 293.15);
  });
  it("converts area, speed, data and durations", () => {
    close(conv("1 acre in m2"), 4046.86, 1);
    close(conv("100 sq ft in square meters"), 9.2903);
    close(conv("1 km² in ha"), 100);
    close(conv("60 mph in km/h"), 96.5606);
    close(conv("100 km/h to m/s"), 27.7778);
    close(conv("10 miles per hour in kph"), 16.0934);
    expect(conv("3 gb in mb")).toBe(3000);
    expect(conv("1 GiB in MiB")).toBe(1024);
    close(conv("100 Mb in MB"), 12.5);
    close(conv("90 min in hours"), 1.5);
    close(conv("1h 30min in minutes"), 90);
    close(conv("2 weeks in days"), 14);
    close(conv("1 cubic meter in liters"), 1000);
  });
  it("rejects non-conversions and mismatched dimensions", () => {
    expect(parseUnitConversion("5 km in kg")).toBeUndefined();
    expect(parseUnitConversion("safari")).toBeUndefined();
    expect(parseUnitConversion("100 usd in eur")).toBeUndefined();
    expect(parseUnitConversion("5 km")).toBeUndefined();
    expect(parseUnitConversion("1 in")).toBeUndefined();
  });
  it("looks up units case-sensitively only for bits", () => {
    expect(lookupUnit("Mb")?.id).toBe("data:Mbit");
    expect(lookupUnit("mb")?.id).toBe("data:MB");
    expect(lookupUnit("MB")?.id).toBe("data:MB");
    expect(lookupUnit("Miles")?.id).toBe("length:mi");
    expect(() => convertValue(1, lookupUnit("km")!, lookupUnit("kg")!)).toThrow();
  });
});

const TABLE: RateTable = { base: "USD", rates: { EUR: 0.9, GBP: 0.8, JPY: 150, NGN: 1500 }, date: "2026-10-20", fetchedAt: 0, source: "test" };

describe("currency", () => {
  it("parses queries with codes, symbols and names", () => {
    expect(parseCurrencyQuery("100 usd in eur")).toEqual({ amount: 100, from: "USD", to: "EUR" });
    expect(parseCurrencyQuery("€50 to gbp")).toEqual({ amount: 50, from: "EUR", to: "GBP" });
    expect(parseCurrencyQuery("50€ in $")).toEqual({ amount: 50, from: "EUR", to: "USD" });
    expect(parseCurrencyQuery("1.5k euros in naira")).toEqual({ amount: 1500, from: "EUR", to: "NGN" });
    expect(parseCurrencyQuery("$20")).toEqual({ amount: 20, from: "USD" });
    expect(parseCurrencyQuery("100 abc in eur")).toBeUndefined();
    expect(parseCurrencyQuery("hello")).toBeUndefined();
    expect(lookupCurrency("C$")).toBe("CAD");
  });
  it("converts through the base and formats", () => {
    close(convertCurrency(100, "USD", "EUR", TABLE), 90);
    close(convertCurrency(90, "EUR", "GBP", TABLE), 80);
    expect(convertCurrency(1, "USD", "XYZ", TABLE)).toBeUndefined();
    expect(formatMoney(1234.5, "EUR")).toBe("€1,234.50");
    expect(formatMoney(15000, "JPY")).toBe("¥15,000");
    expect(formatMoney(12, "SEK")).toBe("12.00 SEK");
  });
});

describe("rates store", () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "glide-rates-")), "rates.json");
  const okFetch = (calls: string[]): Fetcher => async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ result: "success", time_last_update_unix: 1_790_000_000, rates: { USD: 1, EUR: 0.9 } }) };
  };

  it("fetches once, caches on disk, and reuses the cache while fresh", async () => {
    const file = tmp();
    const calls: string[] = [];
    let now = 1_000_000;
    const store = createRatesStore({ file, fetcher: okFetch(calls), now: () => now });
    expect(store.current()).toBeUndefined();
    const [a, b] = await Promise.all([store.refresh(), store.refresh()]);
    expect(a?.rates.EUR).toBe(0.9);
    expect(b).toBe(a);
    expect(calls).toHaveLength(1); // deduplicated
    expect(store.isFresh()).toBe(true);
    await store.refresh();
    expect(calls).toHaveLength(1);
    // A new process reads the disk cache.
    const again = createRatesStore({ file, fetcher: okFetch(calls), now: () => now });
    expect(again.current()?.rates.EUR).toBe(0.9);
    now += RATES_TTL_MS + 1;
    expect(again.isFresh()).toBe(false);
    await again.refresh();
    expect(calls).toHaveLength(2);
  });

  it("falls back to the next provider and keeps the stale cache when offline", async () => {
    const file = tmp();
    fs.writeFileSync(file, JSON.stringify({ ...TABLE, fetchedAt: 0 }));
    const calls: string[] = [];
    const offline: Fetcher = async (url) => {
      calls.push(url);
      throw new Error("offline");
    };
    const store = createRatesStore({ file, fetcher: offline, now: () => RATES_TTL_MS * 2 });
    const t = await store.refresh();
    expect(t?.date).toBe("2026-10-20");
    expect(calls).toEqual(PROVIDERS.map((p) => p.url));
    expect(store.lastError()).toMatch(/offline/);
    await store.refresh(); // rate-limited after a failure
    expect(calls).toHaveLength(PROVIDERS.length);
  });

  it("parses the Frankfurter response shape", () => {
    const t = PROVIDERS[1]!.parse({ amount: 1, base: "USD", date: "2026-10-17", rates: { EUR: 0.86, bad: "x" } }, 5);
    expect(t).toEqual({ base: "USD", rates: { EUR: 0.86 }, date: "2026-10-17", fetchedAt: 5, source: "ECB via Frankfurter" });
  });
});

describe("time zones", () => {
  const now = Date.UTC(2026, 9, 20, 12, 0); // Tue Oct 20 2026 12:00 UTC (London on BST)
  it("parses clock times", () => {
    expect(parseClock("5pm")).toEqual({ hour: 17, minute: 0 });
    expect(parseClock("12am")).toEqual({ hour: 0, minute: 0 });
    expect(parseClock("9:30 am")).toEqual({ hour: 9, minute: 30 });
    expect(parseClock("17:45")).toEqual({ hour: 17, minute: 45 });
    expect(parseClock("5")).toBeUndefined();
    expect(parseClock("13pm")).toBeUndefined();
  });
  it("resolves zones from cities, aliases and offsets", () => {
    expect(lookupZone("tokyo", "UTC")?.zone).toBe("Asia/Tokyo");
    expect(lookupZone("NYC", "UTC")?.zone).toBe("America/New_York");
    expect(lookupZone("pst", "UTC")?.zone).toBe("America/Los_Angeles");
    expect(lookupZone("Europe/Paris", "UTC")?.zone).toBe("Europe/Paris");
    expect(lookupZone("utc+3", "UTC")?.zone).toBe("Etc/GMT-3");
    expect(lookupZone("narnia", "UTC")).toBeUndefined();
  });
  it("handles offsets and DST", () => {
    expect(offsetMinutes("Asia/Tokyo", now)).toBe(540);
    expect(offsetMinutes("Europe/London", now)).toBe(60); // BST
    expect(offsetMinutes("Europe/London", Date.UTC(2026, 11, 1))).toBe(0);
    expect(wallToInstant("America/New_York", { year: 2026, month: 10, day: 20, hour: 9, minute: 0 })).toBe(Date.UTC(2026, 9, 20, 13, 0));
  });
  it("converts '5pm london in tokyo'", () => {
    const r = parseTimeZoneQuery("5pm london in tokyo", now, "UTC")!;
    expect(r.time).toBe("1:00 AM");
    expect(r.fromTime).toBe("5:00 PM");
    expect(r.dayDelta).toBe(1);
    expect(r.offset).toBe("GMT+9");
    expect(r.iso).toBe("2026-10-21T01:00:00+09:00");
  });
  it("answers 'time in nyc' and local conversions", () => {
    expect(parseTimeZoneQuery("time in nyc", now, "UTC")?.time).toBe("8:00 AM");
    expect(parseTimeZoneQuery("tokyo time", now, "UTC")?.time).toBe("9:00 PM");
    expect(parseTimeZoneQuery("3pm in sydney", now, "Europe/London")?.time).toBe("1:00 AM");
    expect(parseTimeZoneQuery("9am pst", now, "America/New_York")?.time).toBe("12:00 PM");
    expect(parseTimeZoneQuery("5pm", now, "UTC")).toBeUndefined();
    expect(parseTimeZoneQuery("5 km in miles", now, "UTC")).toBeUndefined();
  });
});

describe("dates", () => {
  const now = new Date(2026, 9, 20, 15, 30); // Tue Oct 20 2026, local time
  it("parses dates", () => {
    expect(parseDate("dec 25", now)?.date).toEqual(new Date(2026, 11, 25));
    expect(parseDate("25th of december 2027", now)?.date).toEqual(new Date(2027, 11, 25));
    expect(parseDate("2026-02-30", now)).toBeUndefined();
    expect(parseDate("12/25", now)?.date).toEqual(new Date(2026, 11, 25));
    expect(parseDate("next friday", now)?.date).toEqual(new Date(2026, 9, 23));
    expect(parseDate("christmas", now)?.date).toEqual(new Date(2026, 11, 25));
    expect(parseDate("marble 3", now)).toBeUndefined();
  });
  it("counts days until / since / between", () => {
    const r = parseDateQuery("days until dec 25", now);
    expect(r?.kind === "count" && r.days).toBe(66);
    const past = parseDateQuery("days until jan 1", now);
    expect(past?.kind === "count" && past.to.getFullYear()).toBe(2027);
    const since = parseDateQuery("days since jan 1", now);
    expect(since?.kind === "count" && since.days).toBe(292);
    const between = parseDateQuery("days between mar 1 and jun 30", now);
    expect(between?.kind === "count" && between.days).toBe(121);
    const weeks = parseDateQuery("weeks until christmas", now);
    expect(weeks?.kind === "count" && countValue(weeks).label).toBe("9.4 weeks");
    expect(daysBetween(new Date(2026, 2, 28), new Date(2026, 2, 30))).toBe(2); // across DST
  });
  it("does date arithmetic", () => {
    const d = (q: string) => {
      const r = parseDateQuery(q, now);
      return r?.kind === "date" ? r.date : undefined;
    };
    expect(d("today + 3 weeks")).toEqual(new Date(2026, 10, 10));
    expect(d("today - 1 month")).toEqual(new Date(2026, 8, 20));
    expect(d("jan 31 2026 + 1 month")).toEqual(new Date(2026, 1, 28));
    expect(d("christmas - 10 days")).toEqual(new Date(2026, 11, 15));
    expect(d("2026-12-25 + 1 week")).toEqual(new Date(2027, 0, 1));
    expect(d("90 days from now")?.getTime()).toBe(new Date(2027, 0, 18, 15, 30).getTime());
    expect(d("2 weeks ago")).toEqual(new Date(2026, 9, 6));
    expect(d("in 3 days")).toEqual(new Date(2026, 9, 23));
    expect(d("now + 90 min")).toEqual(new Date(2026, 9, 20, 17, 0));
    expect(parseDateQuery("hello world", now)).toBeUndefined();
  });
});

describe("convertQuery", () => {
  const base = { now: new Date(2026, 9, 20, 15, 30).getTime(), localZone: "UTC", defaultCurrency: "USD", currencyEnabled: true };
  it("routes to the right converter with copy text", () => {
    const u = convertQuery("5 km in miles", base).results[0]!;
    expect(u.title).toBe("3.10686 mi");
    expect(u.copy).toBe("3.10686 mi");
    expect(u.more[0]!.text).toBe("3.10686");
    expect(convertQuery("days until dec 25", base).results[0]!.title).toBe("66 days");
    expect(convertQuery("time in tokyo", base).results[0]!.category).toBe("timezone");
    expect(convertQuery("1 + 2", base).results).toEqual([]);
    expect(convertQuery("safari", base).results).toEqual([]);
  });
  it("asks for rates only for currency queries and labels stale rates", () => {
    expect(convertQuery("100 usd in eur", base)).toEqual({ results: [], wantsRates: true });
    expect(convertQuery("5 km in miles", base).wantsRates).toBe(false);
    expect(convertQuery("100 usd in eur", { ...base, ratesLoading: true }).results[0]!.title).toMatch(/Fetching/);
    const r = convertQuery("100 usd in eur", { ...base, rates: TABLE, ratesStale: true }).results[0]!;
    expect(r.title).toBe("€90.00");
    expect(r.copy).toBe("90.00");
    expect(r.subtitle).toContain("rates from 2026-10-20");
    expect(convertQuery("50 eur", { ...base, rates: TABLE }).results[0]!.title).toBe("$55.56");
    expect(convertQuery("100 usd in eur", { ...base, currencyEnabled: false }).wantsRates).toBe(false);
  });
});
