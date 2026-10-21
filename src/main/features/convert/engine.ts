/** Turns a root-search query into conversion results. Pure: time, zone and rates are inputs. */
import { convertCurrency, formatMoney, parseCurrencyQuery, plainMoney, type RateTable } from "./currency";
import { countValue, describeDays, formatDate, isoDate, parseDateQuery } from "./dates";
import { groupedNumber, plainNumber } from "./format";
import { parseTimeZoneQuery } from "./timezones";
import { DIMENSION_LABEL, parseUnitConversion } from "./units";

export type ConversionCategory = "unit" | "currency" | "timezone" | "date";

export interface CopyOption {
  id: string;
  title: string;
  text: string;
}

export interface Conversion {
  category: ConversionCategory;
  title: string;
  subtitle: string;
  icon: string;
  /** Primary text copied/pasted by Enter / ⌘Enter. */
  copy: string;
  /** Extra "Copy …" actions in ⌘K. */
  more: CopyOption[];
}

export interface ConvertContext {
  now: number;
  localZone: string;
  rates?: RateTable;
  /** Rates are older than the cache TTL (shown as "rates from <date>"). */
  ratesStale?: boolean;
  /** A fetch is in flight and there is no cached table yet. */
  ratesLoading?: boolean;
  defaultCurrency: string;
  currencyEnabled: boolean;
}

export interface ConvertOutput {
  results: Conversion[];
  /** The query is a currency query: the caller should make sure rates are loaded. */
  wantsRates: boolean;
}

const UNIT_ICON: Record<string, string> = { length: "📏", mass: "⚖️", volume: "🧪", temperature: "🌡️", area: "📐", speed: "💨", data: "💾", time: "⏱️" };

function unitResult(query: string): Conversion | undefined {
  const c = parseUnitConversion(query);
  if (!c) return undefined;
  const src = c.from.map((t) => `${groupedNumber(t.amount)} ${t.unit.symbol}`).join(" ");
  const plain = plainNumber(c.value);
  return {
    category: "unit",
    title: `${groupedNumber(c.value)} ${c.to.symbol}`,
    subtitle: `${src} = ${groupedNumber(c.value)} ${c.to.name} · ${DIMENSION_LABEL[c.dim]}`,
    icon: UNIT_ICON[c.dim] ?? "🔁",
    copy: `${plain} ${c.to.symbol}`,
    more: [{ id: "number", title: "Copy Number Only", text: plain }],
  };
}

function currencyResult(query: string, ctx: ConvertContext): { result?: Conversion; wants: boolean } {
  const known = ctx.rates ? (code: string) => code === ctx.rates!.base || code in ctx.rates!.rates : undefined;
  const q = parseCurrencyQuery(query, known);
  if (!q) return { wants: false };
  if (!ctx.currencyEnabled) return { wants: false };
  const to = q.to ?? (q.from === ctx.defaultCurrency ? (ctx.defaultCurrency === "EUR" ? "USD" : "EUR") : ctx.defaultCurrency);
  if (!ctx.rates) {
    if (!ctx.ratesLoading) return { wants: true };
    return {
      wants: true,
      result: { category: "currency", title: "Fetching exchange rates…", subtitle: `${formatMoney(q.amount, q.from)} → ${to} · results appear as you keep typing`, icon: "💱", copy: "", more: [] },
    };
  }
  const value = convertCurrency(q.amount, q.from, to, ctx.rates);
  if (value === undefined) return { wants: true };
  const date = ctx.rates.date;
  const rate = convertCurrency(1, q.from, to, ctx.rates)!;
  return {
    wants: true,
    result: {
      category: "currency",
      title: formatMoney(value, to),
      subtitle: `${formatMoney(q.amount, q.from)} = ${formatMoney(value, to)} · 1 ${q.from} = ${plainNumber(rate, 5)} ${to} · ${ctx.ratesStale ? `rates from ${date} (offline)` : `rates ${date}`}`,
      icon: "💱",
      copy: plainMoney(value, to),
      more: [{ id: "formatted", title: "Copy with Currency", text: formatMoney(value, to) }],
    },
  };
}

function timeZoneResult(query: string, ctx: ConvertContext): Conversion | undefined {
  const r = parseTimeZoneQuery(query, ctx.now, ctx.localZone);
  if (!r) return undefined;
  const day = r.dayDelta > 0 ? ` (+${r.dayDelta} day)` : r.dayDelta < 0 ? ` (${r.dayDelta} day)` : "";
  const subtitle = r.from
    ? `${r.fromTime} ${r.from.label} = ${r.time} ${r.to.label}${day} · ${r.date} · ${r.offset}`
    : `Now in ${r.to.label} · ${r.date} · ${r.offset}`;
  return {
    category: "timezone",
    title: r.to.label === "Local" ? `${r.time} local` : `${r.time} ${r.to.label}`,
    subtitle,
    icon: "🌐",
    copy: r.time,
    more: [
      { id: "full", title: "Copy Time and Date", text: `${r.time}, ${r.date} (${r.to.label})` },
      { id: "iso", title: "Copy ISO 8601", text: r.iso },
    ],
  };
}

function dateResult(query: string, ctx: ConvertContext): Conversion | undefined {
  const r = parseDateQuery(query, new Date(ctx.now));
  if (!r) return undefined;
  if (r.kind === "date") {
    const text = formatDate(r.date, r.hasTime);
    const rel = Math.round((r.date.getTime() - ctx.now) / 86_400_000);
    return {
      category: "date",
      title: text,
      subtitle: `${r.expression}${r.hasTime ? "" : rel === 0 ? " · today" : rel > 0 ? ` · in ${describeDays(rel)}` : ` · ${describeDays(rel)} ago`}`,
      icon: "📅",
      copy: text,
      more: [{ id: "iso", title: "Copy ISO Date", text: r.hasTime ? r.date.toISOString() : isoDate(r.date) }],
    };
  }
  const { value, label } = countValue(r);
  const target = r.direction === "between" ? `${formatDate(r.from)} → ${formatDate(r.to)}` : `${r.direction} ${formatDate(r.direction === "since" ? r.from : r.to)}`;
  return {
    category: "date",
    title: label,
    subtitle: `${target}${r.unit === "day" && Math.abs(r.days) >= 7 ? ` · ${describeDays(r.days)}` : r.unit !== "day" ? ` · ${describeDays(r.days)}` : ""}`,
    icon: "📅",
    copy: String(value),
    more: [{ id: "label", title: "Copy with Unit", text: label }],
  };
}

export function convertQuery(query: string, ctx: ConvertContext): ConvertOutput {
  const q = query.trim();
  if (q.length < 3 || !/[a-z€$£¥₹₦₩₽₺₱]/i.test(q)) return { results: [], wantsRates: false };
  const date = dateResult(q, ctx);
  if (date) return { results: [date], wantsRates: false };
  const tz = timeZoneResult(q, ctx);
  if (tz) return { results: [tz], wantsRates: false };
  const unit = unitResult(q);
  if (unit) return { results: [unit], wantsRates: false };
  const cur = currencyResult(q, ctx);
  return { results: cur.result ? [cur.result] : [], wantsRates: cur.wants };
}
